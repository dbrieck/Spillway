// Request handlers, written against ports so tests drive them with in-memory fakes.
import type { Config } from "./config.js";
import {
  JOB_LABEL_KEY,
  MANAGED_LABEL_KEY,
  burstDelayFor,
  isJobEligible,
  runnerTierFor,
  decideReconcile,
  isFamilyCpuQuota,
  regionOfZone,
  decideRerun,
  isLive,
  isRepoAllowed,
  selectRunnersToDelete,
  selectVmsToDelete,
  rerunTaskName,
  taskName,
  vmName,
  type Provisioning,
} from "./policy.js";
import {
  QuotaError,
  StockoutError,
  parseRepo,
  type ComputePort,
  type CreateVmSpec,
  type GitHubPort,
  type ReconcileRequest,
  type RepoRef,
  type RerunRequest,
  type TasksPort,
} from "./ports.js";

export interface Deps {
  config: Config;
  github: GitHubPort;
  compute: ComputePort;
  tasks: TasksPort;
  now: () => Date;
  random: () => string;
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

const ok = (body: Record<string, unknown>, status = 200): HandlerResult => ({ status, body });

/** Sweep re-enqueue window: a still-queued job gets a fresh reconcile task at most once per bucket. */
const SWEEP_BUCKET_SECONDS = 600;
/** GCE deletes VMs at max_run_duration itself; the janitor age limit is only a backstop past that. */
const JANITOR_AGE_SLACK_SECONDS = 900;
/**
 * Delay before checking a failed job for preemption. Spot gives ~30s notice, the runner cancels the
 * job ("The operation was canceled") and GitHub reports it failed before GCE has recorded the
 * compute.instances.preempted operation; checking too early would wrongly conclude "not preempted".
 */
const RERUN_DELAY_SECONDS = 120;

interface WorkflowJobPayload {
  action?: string;
  repository?: { full_name?: string };
  workflow_job?: {
    id?: number;
    run_id?: number;
    run_attempt?: number;
    labels?: string[];
    workflow_name?: string | null;
    head_branch?: string | null;
    conclusion?: string | null;
    runner_name?: string | null;
  };
}

export async function handleWebhook(deps: Deps, event: string | undefined, payload: unknown, baseUrl: string): Promise<HandlerResult> {
  const { config } = deps;
  if (event === "ping") return ok({ result: "pong" });
  if (event !== "workflow_job") return ok({ result: "ignored", reason: `event ${event}` });

  const p = payload as WorkflowJobPayload;
  const repo = p.repository?.full_name;
  const job = p.workflow_job;
  if (p.action === "completed" && repo && job?.id) return handleCompletedJob(deps, repo, job, baseUrl);
  if (p.action !== "queued" || !repo || !job?.id) return ok({ result: "ignored", reason: `action ${p.action}` });
  if (!isRepoAllowed(repo, config.allowedRepos)) return ok({ result: "ignored", reason: "repository not allowed" });
  if (!isJobEligible(job.labels ?? [], config)) return ok({ result: "ignored", reason: "labels not eligible" });
  if (config.maxRunners <= 0) return ok({ result: "paused" });

  const delaySeconds = burstDelayFor(job.head_branch, config, job.labels ?? []);
  const scheduleAt = new Date(deps.now().getTime() + delaySeconds * 1000);
  const created = await deps.tasks.enqueueReconcile(taskName(job.id), { repo, jobId: job.id }, scheduleAt, baseUrl);
  deps.log("webhook queued job", { repo, jobId: job.id, workflow: job.workflow_name, branch: job.head_branch, delaySeconds, created });
  return ok({ result: created ? "scheduled" : "duplicate", jobId: job.id }, 202);
}

/**
 * A job that failed on one of our runners may have died with a preempted Spot VM ("The self-hosted
 * runner lost communication with the server"; GitHub doesn't requeue it). Schedule a check; the
 * /rerun task decides, since the preemption lookup and "is the run finished" are slow or not yet true.
 */
async function handleCompletedJob(
  deps: Deps,
  repo: string,
  job: NonNullable<WorkflowJobPayload["workflow_job"]>,
  baseUrl: string,
): Promise<HandlerResult> {
  const { config } = deps;
  const runner = job.runner_name ?? "";
  if (job.conclusion !== "failure" || !runner.startsWith(config.runnerNamePrefix)) {
    return ok({ result: "ignored", reason: "completed job not a failure on a GCP runner" });
  }
  if (!isRepoAllowed(repo, config.allowedRepos)) return ok({ result: "ignored", reason: "repository not allowed" });
  if (config.preemptionRetries <= 0) return ok({ result: "ignored", reason: "preemption re-runs disabled" });
  if (!job.run_id || !job.run_attempt) return ok({ result: "ignored", reason: "no run id/attempt" });

  const body: RerunRequest = { repo, runId: job.run_id, jobId: job.id!, runAttempt: job.run_attempt, runnerName: runner };
  const scheduleAt = new Date(deps.now().getTime() + RERUN_DELAY_SECONDS * 1000);
  const created = await deps.tasks.enqueueRerun(rerunTaskName(job.id!, job.run_attempt), body, scheduleAt, baseUrl);
  deps.log("webhook failed job on gcp runner", { ...body, created });
  return ok({ result: created ? "rerun-check-scheduled" : "duplicate", jobId: job.id }, 202);
}

function isRerunRequest(b: unknown): b is RerunRequest {
  const r = b as RerunRequest;
  return (
    typeof r?.repo === "string" &&
    Number.isInteger(r?.runId) &&
    Number.isInteger(r?.jobId) &&
    Number.isInteger(r?.runAttempt) &&
    typeof r?.runnerName === "string"
  );
}

/** Like /reconcile: 503 asks Cloud Tasks to retry (run still in progress), 200 is terminal. */
export async function handleRerun(deps: Deps, body: unknown): Promise<HandlerResult> {
  const { config } = deps;
  if (!isRerunRequest(body)) return ok({ result: "bad-request" }, 400);
  if (!isRepoAllowed(body.repo, config.allowedRepos)) return ok({ result: "ignored", reason: "repository not allowed" });

  const repo = parseRepo(body.repo);
  const run = await deps.github.getRun(repo, body.runId);
  // Cheap checks first; the preemption lookup lists operations across every zone.
  const base = {
    failedAttempt: body.runAttempt,
    runAttempt: run.runAttempt,
    runStatus: run.status,
    runConclusion: run.conclusion,
    maxRetries: config.preemptionRetries,
  };
  let decision = decideRerun({ ...base, preempted: true });
  if (decision.kind === "run-in-progress" || decision.kind === "rerun") {
    decision = decideRerun({ ...base, preempted: await deps.compute.wasPreempted(body.runnerName) });
  }
  deps.log("rerun decision", { ...body, decision });

  switch (decision.kind) {
    case "run-in-progress":
      return ok({ result: decision.kind }, 503);
    case "rerun":
      await deps.github.rerunFailedJobs(repo, body.runId);
      deps.log("re-ran failed jobs after preemption", { repo: body.repo, runId: body.runId, runner: body.runnerName });
      return ok({ result: "rerun", runId: body.runId });
    default:
      return ok({ result: decision.kind });
  }
}

function isReconcileRequest(b: unknown): b is ReconcileRequest {
  const r = b as ReconcileRequest;
  return typeof r?.repo === "string" && Number.isInteger(r?.jobId) && r.jobId > 0;
}

/**
 * Cloud Tasks retries non-2xx responses with backoff, so "at capacity" and transient launch failures
 * answer 503/500 to be retried later, while terminal outcomes (job picked up, paused) answer 200.
 */
export async function handleReconcile(deps: Deps, body: unknown): Promise<HandlerResult> {
  const { config } = deps;
  if (!isReconcileRequest(body)) return ok({ result: "bad-request" }, 400);
  if (!isRepoAllowed(body.repo, config.allowedRepos)) return ok({ result: "ignored", reason: "repository not allowed" });

  const repo = parseRepo(body.repo);
  const job = await deps.github.getJob(repo, body.jobId);
  if (!isJobEligible(job.labels, config)) return ok({ result: "ignored", reason: "labels not eligible" });

  const vms = await deps.compute.listRunnerVms();
  const input = {
    jobId: job.id,
    jobStatus: job.status,
    workflowName: job.workflowName,
    vms,
    now: deps.now(),
    maxRunners: config.maxRunners,
    bootGraceSeconds: config.bootGraceSeconds,
    standardWorkflows: config.standardWorkflows,
  };
  let decision = decideReconcile(input);
  if (decision.kind === "pending") {
    // The VM launched for this job may have taken a different job (JIT runners take whatever GitHub
    // hands them). Only then is the runner list worth a call: a busy runner frees this job to relaunch.
    const busy = new Set((await deps.github.listRunners(repo)).filter((r) => r.busy).map((r) => r.name));
    // Re-read the job AFTER the runner list: its own VM may have picked it up since the first read,
    // which also shows as a busy runner. Only a job that is still queued was passed over.
    const fresh = await deps.github.getJob(repo, body.jobId);
    decision = decideReconcile({ ...input, jobStatus: fresh.status, busyRunnerNames: busy });
  }
  deps.log("reconcile decision", { repo: body.repo, jobId: job.id, decision });

  switch (decision.kind) {
    case "paused":
    case "not-queued":
      return ok({ result: decision.kind });
    case "pending":
      // Not terminal: the VM is still booting. Cloud Tasks retries in 30-120 s, by which time the job
      // has started (200 not-queued) or its VM went to another job (relaunch). Leaving this to the
      // 5-minute sweep is what stranded jobs.
      return ok({ result: "pending", vm: decision.vm }, 503);
    case "at-capacity":
      return ok({ result: "at-capacity", live: decision.live, max: decision.max }, 503);
    case "launch":
      if (!config.allowForkPrs) {
        // Checked only now, so the extra API call is paid once per launch, not on every retry. Fails
        // closed: a run whose head repository is unknown (deleted fork) doesn't get a runner either.
        const head = await deps.github.getRunHeadRepository(repo, job.runId);
        if (head?.toLowerCase() !== body.repo.toLowerCase()) {
          deps.log("reconcile skipped fork", { repo: body.repo, jobId: job.id, head });
          return ok({ result: "ignored", reason: "fork pull request" });
        }
      }
      try {
        const vm = await launchRunner(deps, repo, job.id, decision.provisioning, runnerTierFor(job.labels, config));
        return ok({ result: "launched", ...vm }, 201);
      } catch (err) {
        const stockout = err instanceof StockoutError;
        const quota = err instanceof QuotaError;
        deps.log("launch failed", { jobId: job.id, stockout, quota, metric: quota ? err.metric : undefined, error: String(err) });
        const result = stockout ? "stockout" : quota ? "quota" : "launch-failed";
        return ok({ result, error: String(err) }, stockout || quota ? 503 : 500);
      }
  }
}

type Placement = { zone: string; machineType: string | undefined };

/**
 * Placements a quota has ruled out for the rest of one launch (shared by the Spot sweep and the
 * STANDARD fallback, since both provisioning models count against the same quotas).
 */
interface Blocked {
  regions: Set<string>; // regional quota other than a family CPU quota (SSD_TOTAL_GB, CPUS, ...)
  typeRegions: Set<string>; // `${machineType}|${region}`: family CPU quota (N2D_CPUS, ...) in that region
}

/**
 * Tries each machine type across every zone (type-major: a type's capacity is usually short across a
 * whole region, so switching types beats walking the same type through more zones). Stockouts fall
 * through to the next zone. Quotas are scoped: a family CPU quota rules out that machine type in that
 * region; another regional quota rules out that region; a global quota (CPUS_ALL_REGIONS) rules out
 * everything, so the launch stops. Any other error aborts.
 */
async function tryCapacity(
  deps: Deps,
  machineTypes: readonly string[],
  spec: (machineType: string | undefined) => Omit<CreateVmSpec, "zone">,
  blocked: Blocked,
): Promise<Placement> {
  const types = machineTypes.length > 0 ? machineTypes : [undefined];
  let stockout: StockoutError | undefined;
  let quota: QuotaError | undefined;
  for (const machineType of types) {
    for (let z = 0; z < deps.config.zones.length; z++) {
      const zone = deps.config.zones[z]!;
      const region = regionOfZone(zone);
      if (blocked.regions.has(region) || blocked.typeRegions.has(`${machineType ?? ""}|${region}`)) continue;
      const s = spec(machineType);
      try {
        await deps.compute.createRunnerVm({ ...s, zone });
        return { zone, machineType };
      } catch (err) {
        if (err instanceof QuotaError) {
          const quotaRegion = err.region;
          deps.log("quota exceeded", { zone, machineType, provisioning: s.provisioning, metric: err.metric, region: quotaRegion ?? "global" });
          if (isFamilyCpuQuota(err.metric)) {
            blocked.typeRegions.add(`${machineType ?? ""}|${quotaRegion ?? region}`);
          } else if (quotaRegion) {
            blocked.regions.add(quotaRegion);
          } else {
            throw err; // global (or unscoped) quota: no zone, type or region can get around it
          }
          quota = err;
          continue;
        }
        if (!(err instanceof StockoutError)) throw err;
        deps.log("zone stockout", { zone, machineType, provisioning: s.provisioning });
        stockout = err;
      }
    }
  }
  // Prefer reporting a stockout: that's what the Spot -> STANDARD fallback can still get around.
  throw stockout ?? quota ?? new StockoutError("no zones configured");
}

export async function launchRunner(
  deps: Deps,
  repo: RepoRef,
  jobId: number,
  provisioning: Provisioning,
  tier: { labels: readonly string[]; machineTypes: readonly string[] } = {
    labels: deps.config.runnerLabels,
    machineTypes: deps.config.machineTypes,
  },
): Promise<{ name: string; zone: string; machineType: string | undefined; provisioning: Provisioning }> {
  const { config } = deps;
  const { machineTypes } = tier;
  const name = vmName(config.runnerNamePrefix, jobId, deps.random());
  const jit = await deps.github.createJitConfig(repo, name, [...tier.labels]);

  const spec = (p: Provisioning) => (machineType: string | undefined): Omit<CreateVmSpec, "zone"> => ({
    name,
    machineType,
    provisioning: p,
    labels: {
      [MANAGED_LABEL_KEY]: config.poolName,
      [JOB_LABEL_KEY]: String(jobId),
      "ci-provisioning": p.toLowerCase(),
      ...(machineType ? { "ci-machine-type": machineType } : {}),
    },
    metadata: {
      "runner-jitconfig": jit.encodedJitConfig,
      "runner-idle-timeout-seconds": String(config.idleTimeoutSeconds),
      // Serial console (boot + ci-runner lines, incl. the job's peak memory) to Cloud Logging, so it
      // can be read after the VM is deleted.
      "serial-port-logging-enable": "TRUE",
    },
    maxRunSeconds: config.maxRunSeconds,
  });

  const blocked: Blocked = { regions: new Set(), typeRegions: new Set() };
  try {
    // Spot of any machine type is preferred over on-demand of any type (cost), so the full type x zone
    // sweep runs as Spot before falling back to STANDARD.
    try {
      const placed = await tryCapacity(deps, machineTypes, spec(provisioning), blocked);
      deps.log("launched runner", { name, ...placed, provisioning, jobId });
      return { name, ...placed, provisioning };
    } catch (err) {
      if (!(err instanceof StockoutError) || provisioning !== "SPOT" || !config.spotFallbackToStandard) throw err;
      const placed = await tryCapacity(deps, machineTypes, spec("STANDARD"), blocked);
      deps.log("launched runner (spot exhausted, standard fallback)", { name, ...placed, jobId });
      return { name, ...placed, provisioning: "STANDARD" };
    }
  } catch (err) {
    // No VM will ever claim this registration; remove it rather than leave an offline runner.
    await deps.github.deleteRunner(repo, jit.runnerId).catch((e) => deps.log("jit cleanup failed", { error: String(e) }));
    throw err;
  }
}

export async function handleJanitor(deps: Deps, baseUrl: string): Promise<HandlerResult> {
  const { config } = deps;
  const now = deps.now();
  const summary = { vmsDeleted: 0, runnersDeleted: 0, jobsSwept: 0, errors: [] as string[] };

  const vms = await deps.compute.listRunnerVms();
  const doomed = selectVmsToDelete(vms, now, config.maxRunSeconds + JANITOR_AGE_SLACK_SECONDS);
  for (const vm of doomed) {
    try {
      await deps.compute.deleteVm(vm);
      summary.vmsDeleted++;
    } catch (err) {
      summary.errors.push(`delete vm ${vm.name}: ${String(err)}`);
    }
  }
  const doomedNames = new Set(doomed.map((v) => v.name));
  const surviving = vms.filter((v) => !doomedNames.has(v.name));

  for (const fullName of config.allowedRepos) {
    const repo = parseRepo(fullName);
    try {
      for (const r of selectRunnersToDelete(await deps.github.listRunners(repo), surviving, config.runnerNamePrefix)) {
        await deps.github.deleteRunner(repo, r.id);
        summary.runnersDeleted++;
      }
    } catch (err) {
      summary.errors.push(`runners ${fullName}: ${String(err)}`);
    }

    // Backstop for missed/failed webhook deliveries and jobs whose VM got taken by another job.
    if (config.maxRunners <= 0) continue;
    try {
      const bucket = Math.floor(now.getTime() / 1000 / SWEEP_BUCKET_SECONDS);
      for (const job of await deps.github.listQueuedJobs(repo)) {
        const ageSeconds = (now.getTime() - job.createdAt.getTime()) / 1000;
        if (ageSeconds < burstDelayFor(job.headBranch, config, job.labels) || !isJobEligible(job.labels, config)) continue;
        if (await deps.tasks.enqueueReconcile(taskName(job.id, bucket), { repo: fullName, jobId: job.id }, now, baseUrl)) {
          summary.jobsSwept++;
        }
      }
    } catch (err) {
      summary.errors.push(`sweep ${fullName}: ${String(err)}`);
    }
  }

  deps.log("janitor", { ...summary, live: surviving.filter(isLive).length });
  return ok(summary);
}
