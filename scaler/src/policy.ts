// Pure decision logic. Everything here is side-effect free so it can be tested exhaustively.

/** GCE label every scaler-managed VM carries (value: the pool name); the janitor and capacity checks key off it. */
export const MANAGED_LABEL_KEY = "ci-runner";
/** GCE label recording the job id that triggered the VM (the VM may end up running another job). */
export const JOB_LABEL_KEY = "ci-job";

export type Provisioning = "SPOT" | "STANDARD";

export interface RunnerVm {
  name: string;
  zone: string;
  /** GCE status: PROVISIONING, STAGING, RUNNING, STOPPING, STOPPED, SUSPENDED, TERMINATED, ... */
  status: string;
  createdAt: Date;
  labels: Record<string, string>;
}

export interface GitHubRunner {
  id: number;
  name: string;
  status: string; // "online" | "offline"
  busy: boolean;
  labels: string[];
}

/**
 * A job may burst onto GCP only if it targets self-hosted runners and every label it asks for is one
 * the GCP runner provides. Jobs asking for a label it lacks (macOS, ARM64, a GPU label, ...) never match.
 */
export function isEligible(jobLabels: readonly string[], runnerLabels: readonly string[]): boolean {
  if (jobLabels.length === 0) return false;
  const offered = new Set(runnerLabels.map((l) => l.toLowerCase()));
  const wanted = jobLabels.map((l) => l.toLowerCase());
  if (!wanted.includes("self-hosted")) return false;
  return wanted.every((l) => offered.has(l));
}

export function isRepoAllowed(fullName: string, allowed: readonly string[]): boolean {
  return allowed.includes(fullName.toLowerCase());
}

/** VMs that are alive or on their way up; STOPPING/TERMINATED ones no longer hold capacity. */
export function isLive(vm: RunnerVm): boolean {
  return !["STOPPING", "STOPPED", "SUSPENDING", "SUSPENDED", "TERMINATED"].includes(vm.status);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** Long-running workflows listed in STANDARD_WORKFLOWS get on-demand VMs so preemption can't kill them. */
export function chooseProvisioning(workflowName: string | null | undefined, standardGlobs: readonly string[]): Provisioning {
  if (!workflowName) return "SPOT";
  return standardGlobs.some((g) => globToRegExp(g).test(workflowName)) ? "STANDARD" : "SPOT";
}

export type ReconcileDecision =
  | { kind: "paused" }
  | { kind: "not-queued"; status: string }
  | { kind: "pending"; vm: string }
  | { kind: "at-capacity"; live: number; max: number }
  | { kind: "launch"; provisioning: Provisioning };

export interface ReconcileInput {
  jobId: number;
  jobStatus: string;
  workflowName: string | null | undefined;
  vms: readonly RunnerVm[];
  now: Date;
  maxRunners: number;
  bootGraceSeconds: number;
  standardWorkflows: readonly string[];
  /**
   * Names of GitHub runners currently running a job. A VM launched for this job whose runner is busy
   * was taken by ANOTHER job (this one is still queued), so it no longer counts as this job's VM.
   */
  busyRunnerNames?: ReadonlySet<string>;
}

export function decideReconcile(i: ReconcileInput): ReconcileDecision {
  if (i.maxRunners <= 0) return { kind: "paused" };
  if (i.jobStatus !== "queued") return { kind: "not-queued", status: i.jobStatus };

  const live = i.vms.filter(isLive);
  // "Pending" = a VM launched for this job that is still booting or idle, so it will take this job (or
  // free another runner for it). Without the busy check, a job whose VM was taken by a different job
  // sat queued for the whole boot grace: 9-11 min waits once runs grew to 17 jobs.
  const pending = live.find(
    (vm) =>
      vm.labels[JOB_LABEL_KEY] === String(i.jobId) &&
      (i.now.getTime() - vm.createdAt.getTime()) / 1000 < i.bootGraceSeconds &&
      !i.busyRunnerNames?.has(vm.name),
  );
  if (pending) return { kind: "pending", vm: pending.name };

  if (live.length >= i.maxRunners) return { kind: "at-capacity", live: live.length, max: i.maxRunners };
  return { kind: "launch", provisioning: chooseProvisioning(i.workflowName, i.standardWorkflows) };
}

/** VMs the janitor should delete: shut down (job done / idle) or older than the hard age limit. */
export function selectVmsToDelete(vms: readonly RunnerVm[], now: Date, maxAgeSeconds: number): RunnerVm[] {
  return vms.filter((vm) => {
    if (vm.status === "TERMINATED" || vm.status === "STOPPED") return true;
    if (vm.status === "STOPPING") return false; // let it finish; next pass catches TERMINATED
    return (now.getTime() - vm.createdAt.getTime()) / 1000 > maxAgeSeconds;
  });
}

/**
 * GitHub runner registrations to remove: offline scaler-created runners whose VM is gone or dead. A
 * JIT runner shows "offline" from the moment it is registered until its VM boots, so a live VM
 * protects it. Runners without the pool's name prefix (e.g. a local pool) are never touched.
 */
export function selectRunnersToDelete(
  runners: readonly GitHubRunner[],
  vms: readonly RunnerVm[],
  namePrefix: string,
): GitHubRunner[] {
  const liveNames = new Set(vms.filter(isLive).map((vm) => vm.name));
  return runners.filter(
    (r) => r.status === "offline" && !r.busy && r.name.startsWith(namePrefix) && !liveNames.has(r.name),
  );
}

/** GCE names: lowercase, start with a letter, [-a-z0-9], <= 63 chars. */
export function vmName(namePrefix: string, jobId: number, suffix: string): string {
  const clean = suffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "x";
  return `${namePrefix}${jobId}-${clean}`.slice(0, 63);
}

/**
 * Cloud Tasks names are unique for about an hour after a task finishes. Webhook tasks use the bare job
 * id (dedupes GitHub redeliveries); the janitor sweep adds a time bucket so a job that stays queued can
 * be reconsidered every bucket instead of once an hour.
 */
export function taskName(jobId: number, bucket?: number): string {
  return bucket === undefined ? `job-${jobId}` : `job-${jobId}-sweep-${bucket}`;
}

/** "us-east4-b" -> "us-east4". */
export function regionOfZone(zone: string): string {
  const m = /^(.+)-[a-z]$/.exec(zone);
  if (!m) throw new Error(`Not a zone name: ${zone}`);
  return m[1]!;
}

/** Partial resource path of the runner subnet for a zone, as accepted by instances.insert. */
export function subnetworkForZone(project: string, zone: string, prefix: string): string {
  const region = regionOfZone(zone);
  return `projects/${project}/regions/${region}/subnetworks/${prefix}${region}`;
}

/**
 * Per-machine-family CPU quotas only block that family, so the scaler moves on to the next machine
 * type. They come in two spellings: one metric per family for the older families (N2D_CPUS,
 * E2_CPUS, ...), and the shared CPUS_PER_VM_FAMILY (dimension vm_family) for the newer ones such as
 * C3D, whose default is 24 vCPUs per region. Everything else (SSD_TOTAL_GB, CPUS, CPUS_ALL_REGIONS)
 * is not tied to a machine type.
 */
export function isFamilyCpuQuota(metric: string): boolean {
  if (metric === "CPUS_PER_VM_FAMILY") return true;
  return /^[A-Z0-9]+_CPUS$/.test(metric) && !["CPUS", "CPUS_ALL_REGIONS", "PREEMPTIBLE_CPUS"].includes(metric);
}

export type RerunDecision =
  | { kind: "superseded"; currentAttempt: number } // someone (or we) already re-ran it
  | { kind: "retry-limit" }
  | { kind: "not-preempted" } // a genuine failure: leave it for a human
  | { kind: "run-cancelled" } // someone (or a concurrency group) cancelled the run: respect it
  | { kind: "run-in-progress" } // rerun-failed-jobs needs a finished run; retry later
  | { kind: "rerun" };

export interface RerunInput {
  /** run_attempt of the failed job, from the webhook. */
  failedAttempt: number;
  runAttempt: number;
  runStatus: string;
  runConclusion: string | null;
  preempted: boolean;
  maxRetries: number;
}

/**
 * Re-run a failed job only when GCE preempted (or host-errored) the Spot VM under it, the run hasn't
 * been re-run since, and it's within the retry budget. rerun-failed-jobs also re-runs dependents
 * (e.g. dotnet-build's `ci` gate), so one call covers the whole run.
 */
export function decideRerun(i: RerunInput): RerunDecision {
  if (i.runAttempt !== i.failedAttempt) return { kind: "superseded", currentAttempt: i.runAttempt };
  if (i.failedAttempt > i.maxRetries) return { kind: "retry-limit" };
  if (!i.preempted) return { kind: "not-preempted" };
  if (i.runStatus !== "completed") return { kind: "run-in-progress" };
  if (i.runConclusion === "cancelled") return { kind: "run-cancelled" };
  return { kind: "rerun" };
}

export function rerunTaskName(jobId: number, attempt: number): string {
  return `rerun-${jobId}-${attempt}`;
}

/** "Quota 'SSD_TOTAL_GB' exceeded.  Limit: 500.0 in region us-central1." -> us-central1 (undefined if global). */
export function quotaRegion(message: string | null | undefined): string | undefined {
  return message ? /\bin region ([a-z0-9-]+)/.exec(message)?.[1] : undefined;
}

/** "Quota 'SSD_TOTAL_GB' exceeded.  Limit: 500.0 in region us-central1." -> SSD_TOTAL_GB */
export function quotaMetric(codeOrMessage: string | null | undefined): string | undefined {
  if (!codeOrMessage) return undefined;
  const m = /Quota '([A-Z0-9_]+)' exceeded/.exec(codeOrMessage);
  if (m) return m[1];
  return codeOrMessage.includes("QUOTA_EXCEEDED") ? "UNKNOWN" : undefined;
}

/**
 * The quota behind a failed insert's error list, with its metric and region taken from the SAME
 * entry (a region from one error must never be attached to another error's metric). When one insert
 * fails several quotas at once, a global one wins: it's the strictest, and it stops the launch.
 */
export function classifyQuotaErrors(
  errors: ReadonlyArray<{ code?: string | null; message?: string | null }>,
): { metric: string; region: string | undefined } | undefined {
  const quotas = errors
    .map((e) => ({ metric: quotaMetric(e.message) ?? quotaMetric(e.code), region: quotaRegion(e.message) }))
    .filter((q): q is { metric: string; region: string | undefined } => q.metric !== undefined);
  return quotas.find((q) => q.region === undefined) ?? quotas[0];
}

/** Labels any self-hosted runner may carry; anything else on our runners marks a job as GCP-only. */
const GENERIC_RUNNER_LABELS = new Set(["self-hosted", "linux", "x64"]);

export function asksForGcpOnlyLabel(
  jobLabels: readonly string[],
  c: { runnerLabels?: readonly string[]; smallRunnerLabels?: readonly string[] },
): boolean {
  const ours = new Set(
    [...(c.runnerLabels ?? []), ...(c.smallRunnerLabels ?? [])].map((l) => l.toLowerCase()).filter((l) => !GENERIC_RUNNER_LABELS.has(l)),
  );
  return jobLabels.some((l) => ours.has(l.toLowerCase()));
}

/**
 * How long a queued job waits for a free local runner before GCP capacity is added. Jobs on a
 * low-priority branch (post-merge runs on main: nobody is blocked on them) wait much longer, so they
 * mostly run on the local runners for free and only burst when the local pool stays busy.
 */
export function burstDelayFor(
  headBranch: string | null | undefined,
  c: {
    burstDelaySeconds: number;
    lowPriorityBranches: readonly string[];
    lowPriorityBurstDelaySeconds: number;
    runnerLabels?: readonly string[];
    smallRunnerLabels?: readonly string[];
  },
  jobLabels: readonly string[] = [],
): number {
  // A job that asks for a label only our runners carry (e.g. `gcp`) can never be taken by a local
  // runner, so waiting for one only delays it (and everything that `needs` it).
  if (asksForGcpOnlyLabel(jobLabels, c)) return 0;
  const low = !!headBranch && c.lowPriorityBranches.some((b) => b.toLowerCase() === headBranch.toLowerCase());
  return low ? Math.max(c.burstDelaySeconds, c.lowPriorityBurstDelaySeconds) : c.burstDelaySeconds;
}

export interface TierConfig {
  runnerLabels: readonly string[];
  machineTypes: readonly string[];
  smallRunnerLabels: readonly string[];
  smallMachineTypes: readonly string[];
}

/**
 * The small tier is on when it has machine types, and a job belongs to it when every label it asks
 * for is one the SMALL runner provides. Small runners register with fewer labels than regular ones
 * (by default without X64), so GitHub only hands them jobs that opted in by asking for less: a small
 * VM can never pick up a job that needs the full-size machine. (Choosing the size by job name did not
 * work: a runner takes whichever matching job GitHub hands it, and a 16 GB VM took a 32 GB job.)
 */
export function isSmallJob(jobLabels: readonly string[], c: Pick<TierConfig, "smallRunnerLabels" | "smallMachineTypes">): boolean {
  return c.smallMachineTypes.length > 0 && isEligible(jobLabels, c.smallRunnerLabels);
}

/** Eligible for either tier. */
export function isJobEligible(jobLabels: readonly string[], c: TierConfig): boolean {
  return isEligible(jobLabels, c.runnerLabels) || isSmallJob(jobLabels, c);
}

/**
 * Labels the runner registers with and the machine types to try, in order. A small job gets the small
 * labels and the small types first, with the regular types as fallback so a stocked-out small type
 * never blocks it (a small-labelled runner on a full-size VM is merely oversized).
 */
export function runnerTierFor(jobLabels: readonly string[], c: TierConfig): { labels: string[]; machineTypes: string[] } {
  if (!isSmallJob(jobLabels, c)) return { labels: [...c.runnerLabels], machineTypes: [...c.machineTypes] };
  return {
    labels: [...c.smallRunnerLabels],
    machineTypes: [...c.smallMachineTypes, ...c.machineTypes.filter((t) => !c.smallMachineTypes.includes(t))],
  };
}
