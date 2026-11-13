// Runtime configuration, read once from the environment (set by terraform/scaler.tf).

export interface Config {
  /** GitHub App id; the private key and webhook secret arrive as secret env vars. */
  githubAppId: string;
  githubAppPrivateKey: string;
  githubWebhookSecret: string;
  /** Repositories ("owner/name", case-insensitive) whose jobs may burst onto GCP. */
  allowedRepos: string[];
  /** Labels every GCP runner registers with; a job is eligible only if its labels are a subset. */
  runnerLabels: string[];
  /**
   * Names this install: the value of every VM's `ci-runner` label. The janitor and capacity checks only
   * see VMs carrying it, so two installs in one project leave each other alone.
   */
  poolName: string;
  /** Name prefix shared by this pool's VMs and their GitHub runner registrations (default `${poolName}-`). */
  runnerNamePrefix: string;
  /**
   * Launch runners for pull requests from forks. Off by default: a fork PR would run untrusted code on
   * a VM with passwordless sudo inside your project's network.
   */
  allowForkPrs: boolean;

  gcpProject: string;
  /** Zones tried in order when creating a VM (stockout falls through to the next). */
  zones: string[];
  /** Instance template self link (global). */
  instanceTemplate: string;
  /** Each VM's subnet is `${subnetworkPrefix}${region of its zone}` (terraform/network.tf). */
  subnetworkPrefix: string;
  /**
   * Machine types tried in order when a zone is stocked out (each draws on a separate capacity pool).
   * Empty means the template's machine type only.
   */
  machineTypes: string[];
  /** Hard cap on live GCP runner VMs. 0 pauses bursting entirely. */
  maxRunners: number;
  /** Seconds a queued job must wait before GCP capacity is added (local runners get first pick). */
  burstDelaySeconds: number;
  /**
   * Branches whose jobs nobody is waiting on (post-merge runs on main). Their jobs wait
   * lowPriorityBurstDelaySeconds for a free local runner before GCP capacity is added.
   */
  lowPriorityBranches: string[];
  lowPriorityBurstDelaySeconds: number;
  /**
   * Small tier for jobs that don't need the full-size VM (mostly single-threaded test legs). A job
   * opts in by asking only for labels in smallRunnerLabels (by default: no X64); its runner registers
   * with exactly those labels on a smallMachineTypes VM, so it cannot take a full-size job. No
   * smallMachineTypes disables the tier: those jobs then run on regular runners.
   */
  smallRunnerLabels: string[];
  smallMachineTypes: string[];
  /**
   * Service account attached to every runner VM (terraform/iam.tf ci-runner-vm). Runner VMs never get
   * an external IP (CIS 4.9): egress goes through each region's Cloud NAT.
   */
  runnerServiceAccount: string;
  /** A VM created for a job counts as "pending" for this long, suppressing a duplicate launch. */
  bootGraceSeconds: number;
  /** Seconds a VM waits for a job before shutting itself down. */
  idleTimeoutSeconds: number;
  /** GCE max_run_duration; the VM is deleted by GCE after this long regardless. */
  maxRunSeconds: number;
  /** Workflow-name globs that get on-demand (STANDARD) VMs instead of Spot. */
  standardWorkflows: string[];
  /** When Spot is exhausted in every zone, retry the launch as STANDARD. */
  spotFallbackToStandard: boolean;
  /** Automatic re-runs of a run whose job died with its preempted VM. 0 disables. */
  preemptionRetries: number;

  /** Full Cloud Tasks queue path: projects/P/locations/L/queues/Q. */
  tasksQueue: string;
  /** Service account whose OIDC token Cloud Tasks/Scheduler attach to internal calls. */
  invokerServiceAccount: string;
  /** OIDC audience expected on /reconcile and /janitor. */
  oidcAudience: string;
  /** Public base URL of this service; falls back to the request Host header when unset. */
  serviceUrl: string | undefined;
}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function list(v: string | undefined, fallback: string[]): string[] {
  if (v === undefined || v.trim() === "") return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function int(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid non-negative integer: ${v}`);
  return n;
}

/** GCE label values and the start of instance names: lowercase letter first, then [a-z0-9-]. */
const POOL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const poolName = env.POOL_NAME || "spillway";
  if (!POOL_NAME_PATTERN.test(poolName)) throw new Error(`Invalid POOL_NAME "${poolName}" (want ${POOL_NAME_PATTERN})`);
  const runnerNamePrefix = env.RUNNER_NAME_PREFIX || `${poolName}-`;
  if (!POOL_NAME_PATTERN.test(runnerNamePrefix)) {
    throw new Error(`Invalid RUNNER_NAME_PREFIX "${runnerNamePrefix}" (want ${POOL_NAME_PATTERN})`);
  }
  return {
    githubAppId: req(env, "GITHUB_APP_ID"),
    githubAppPrivateKey: req(env, "GITHUB_APP_PRIVATE_KEY"),
    githubWebhookSecret: req(env, "GITHUB_WEBHOOK_SECRET"),
    allowedRepos: list(env.ALLOWED_REPOS, []).map((r) => r.toLowerCase()),
    runnerLabels: list(env.RUNNER_LABELS, ["self-hosted", "Linux", "X64", "gcp"]),
    poolName,
    runnerNamePrefix,
    allowForkPrs: (env.ALLOW_FORK_PRS ?? "false").toLowerCase() === "true",

    gcpProject: req(env, "GCP_PROJECT"),
    zones: list(env.GCP_ZONES, ["us-central1-a", "us-central1-b", "us-central1-c", "us-central1-f"]),
    instanceTemplate: req(env, "INSTANCE_TEMPLATE"),
    subnetworkPrefix: env.SUBNETWORK_PREFIX || "ci-runners-",
    machineTypes: list(env.MACHINE_TYPES, []),
    maxRunners: int(env.MAX_RUNNERS, 6),
    burstDelaySeconds: int(env.BURST_DELAY_SECONDS, 10),
    lowPriorityBranches: list(env.LOW_PRIORITY_BRANCHES, []),
    lowPriorityBurstDelaySeconds: int(env.LOW_PRIORITY_BURST_DELAY_SECONDS, 60),
    smallRunnerLabels: list(env.SMALL_RUNNER_LABELS, ["self-hosted", "Linux", "gcp-small"]),
    smallMachineTypes: list(env.SMALL_MACHINE_TYPES, []),
    runnerServiceAccount: env.RUNNER_SERVICE_ACCOUNT || `ci-runner-vm@${req(env, "GCP_PROJECT")}.iam.gserviceaccount.com`,
    bootGraceSeconds: int(env.BOOT_GRACE_SECONDS, 600),
    idleTimeoutSeconds: int(env.IDLE_TIMEOUT_SECONDS, 900),
    maxRunSeconds: int(env.MAX_RUN_SECONDS, 4 * 3600),
    standardWorkflows: list(env.STANDARD_WORKFLOWS, []),
    spotFallbackToStandard: (env.SPOT_FALLBACK_TO_STANDARD ?? "true").toLowerCase() === "true",
    preemptionRetries: int(env.PREEMPTION_RETRIES, 1),

    tasksQueue: req(env, "TASKS_QUEUE"),
    invokerServiceAccount: req(env, "INVOKER_SERVICE_ACCOUNT"),
    oidcAudience: env.OIDC_AUDIENCE || "ci-scaler",
    serviceUrl: env.SERVICE_URL || undefined,
  };
}
