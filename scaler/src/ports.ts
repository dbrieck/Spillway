// Narrow interfaces over GitHub, Compute Engine and Cloud Tasks so handlers are testable with fakes.
import type { GitHubRunner, Provisioning, RunnerVm } from "./policy.js";

export interface RepoRef {
  owner: string;
  repo: string;
}

export function parseRepo(fullName: string): RepoRef {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error(`Invalid repository "${fullName}"`);
  return { owner, repo };
}

export interface JobInfo {
  id: number;
  /** Workflow run the job belongs to. */
  runId: number;
  /** Job name as shown in the UI, e.g. "e2e (3)". */
  name: string;
  /** Branch the run is for: the PR's branch, or "main" for a post-merge push. */
  headBranch: string | null;
  status: string;
  labels: string[];
  workflowName: string | null;
  createdAt: Date;
}

export interface JitConfig {
  runnerId: number;
  encodedJitConfig: string;
}

export interface GitHubPort {
  getJob(repo: RepoRef, jobId: number): Promise<JobInfo>;
  /** Jobs currently in the "queued" state across queued and in-progress workflow runs. */
  listQueuedJobs(repo: RepoRef): Promise<JobInfo[]>;
  createJitConfig(repo: RepoRef, name: string, labels: string[]): Promise<JitConfig>;
  listRunners(repo: RepoRef): Promise<GitHubRunner[]>;
  deleteRunner(repo: RepoRef, runnerId: number): Promise<void>;
  getRun(repo: RepoRef, runId: number): Promise<RunInfo>;
  /**
   * "owner/name" of the repository the run's code comes from: the fork for a fork PR, the repository
   * itself otherwise. Null when GitHub no longer knows it (e.g. the fork was deleted).
   */
  getRunHeadRepository(repo: RepoRef, runId: number): Promise<string | null>;
  /** Re-runs the run's failed jobs and their dependents as a new attempt. */
  rerunFailedJobs(repo: RepoRef, runId: number): Promise<void>;
}

export interface RunInfo {
  id: number;
  status: string;
  /** Set once the run is completed: success, failure, cancelled, ... */
  conclusion: string | null;
  runAttempt: number;
}

export interface CreateVmSpec {
  name: string;
  zone: string;
  /** Overrides the template's machine type when set. */
  machineType?: string;
  provisioning: Provisioning;
  labels: Record<string, string>;
  metadata: Record<string, string>;
  maxRunSeconds: number;
}

/** Thrown by ComputePort.createRunnerVm when the zone has no capacity for the requested VM. */
export class StockoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockoutError";
  }
}

/**
 * Thrown by ComputePort.createRunnerVm when a project quota blocks the VM (e.g. SSD_TOTAL_GB,
 * CPUS_ALL_REGIONS, N2D_CPUS). Unlike a stockout, retrying another zone of the same region can't help.
 * `region` is set for a regional quota ("... in region us-central1") and undefined for a global one
 * (CPUS_ALL_REGIONS) or when GCE doesn't say.
 */
export class QuotaError extends Error {
  constructor(
    readonly metric: string,
    message: string,
    readonly region?: string,
  ) {
    super(message);
    this.name = "QuotaError";
  }
}

export interface ComputePort {
  listRunnerVms(): Promise<RunnerVm[]>;
  createRunnerVm(spec: CreateVmSpec): Promise<void>;
  deleteVm(vm: RunnerVm): Promise<void>;
  /** True if GCE preempted the VM (or killed it on a host error). Works after the VM is deleted. */
  wasPreempted(vmName: string): Promise<boolean>;
}

export interface ReconcileRequest {
  repo: string;
  jobId: number;
}

export interface RerunRequest {
  repo: string;
  runId: number;
  jobId: number;
  /** run_attempt of the failed job. */
  runAttempt: number;
  runnerName: string;
}

export interface TasksPort {
  /** Returns false when a task with this name already exists (duplicate delivery). */
  enqueueReconcile(name: string, body: ReconcileRequest, scheduleAt: Date, baseUrl: string): Promise<boolean>;
  enqueueRerun(name: string, body: RerunRequest, scheduleAt: Date, baseUrl: string): Promise<boolean>;
}
