import type { Config } from "../src/config.js";
import type { Deps } from "../src/handlers.js";
import { regionOfZone, type GitHubRunner, type RunnerVm } from "../src/policy.js";
import {
  QuotaError,
  StockoutError,
  type ComputePort,
  type CreateVmSpec,
  type GitHubPort,
  type JitConfig,
  type JobInfo,
  type ReconcileRequest,
  type RepoRef,
  type RerunRequest,
  type RunInfo,
  type TasksPort,
} from "../src/ports.js";

export const NOW = new Date("2026-09-25T12:00:00Z");

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    githubAppId: "1",
    githubAppPrivateKey: "key",
    githubWebhookSecret: "secret",
    allowedRepos: ["acme/app"],
    runnerLabels: ["self-hosted", "Linux", "X64", "gcp"],
    poolName: "spillway",
    runnerNamePrefix: "spillway-",
    allowForkPrs: false,
    gcpProject: "my-ci",
    zones: ["us-central1-a", "us-central1-b"],
    instanceTemplate: "projects/my-ci/global/instanceTemplates/t",
    subnetworkPrefix: "ci-runners-",
    machineTypes: [],
    maxRunners: 3,
    burstDelaySeconds: 45,
    lowPriorityBranches: [],
    lowPriorityBurstDelaySeconds: 600,
    smallRunnerLabels: ["self-hosted", "Linux", "gcp-small"],
    smallMachineTypes: [],
    runnerServiceAccount: "ci-runner-vm@my-ci.iam.gserviceaccount.com",
    bootGraceSeconds: 600,
    idleTimeoutSeconds: 900,
    maxRunSeconds: 14400,
    standardWorkflows: ["Nightly*"],
    spotFallbackToStandard: true,
    preemptionRetries: 1,
    tasksQueue: "projects/p/locations/us-central1/queues/q",
    invokerServiceAccount: "invoker@p.iam.gserviceaccount.com",
    oidcAudience: "ci-scaler",
    serviceUrl: undefined,
    ...overrides,
  };
}

export function job(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: 101,
    runId: 77,
    name: "tests (dotnet)",
    headBranch: "feature/x",
    status: "queued",
    labels: ["self-hosted", "Linux", "X64"],
    workflowName: "dotnet build",
    createdAt: new Date(NOW.getTime() - 120_000),
    ...overrides,
  };
}

export function vm(overrides: Partial<RunnerVm> = {}): RunnerVm {
  return {
    name: "spillway-1-aaa",
    zone: "us-central1-a",
    status: "RUNNING",
    createdAt: new Date(NOW.getTime() - 60_000),
    labels: { "ci-runner": "spillway", "ci-job": "1" },
    ...overrides,
  };
}

export class FakeGitHub implements GitHubPort {
  jobs = new Map<number, JobInfo>();
  runners: GitHubRunner[] = [];
  jitCalls: Array<{ name: string; labels: string[] }> = [];
  deletedRunners: number[] = [];
  runs = new Map<number, RunInfo>();
  /** Head repository per run id; a run not listed comes from the repository itself (not a fork). */
  headRepos = new Map<number, string | null>();
  reran: number[] = [];
  private nextRunnerId = 900;

  async getJob(_r: RepoRef, id: number): Promise<JobInfo> {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`no job ${id}`);
    return j;
  }
  async listQueuedJobs(): Promise<JobInfo[]> {
    return [...this.jobs.values()].filter((j) => j.status === "queued");
  }
  async createJitConfig(_r: RepoRef, name: string, labels: string[]): Promise<JitConfig> {
    this.jitCalls.push({ name, labels });
    return { runnerId: this.nextRunnerId++, encodedJitConfig: `jit-${name}` };
  }
  async listRunners(): Promise<GitHubRunner[]> {
    return this.runners;
  }
  async deleteRunner(_r: RepoRef, id: number): Promise<void> {
    this.deletedRunners.push(id);
  }
  async getRun(_r: RepoRef, id: number): Promise<RunInfo> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`no run ${id}`);
    return run;
  }
  async getRunHeadRepository(r: RepoRef, id: number): Promise<string | null> {
    return this.headRepos.has(id) ? this.headRepos.get(id)! : `${r.owner}/${r.repo}`;
  }
  async rerunFailedJobs(_r: RepoRef, id: number): Promise<void> {
    this.reran.push(id);
  }
}

export class FakeCompute implements ComputePort {
  vms: RunnerVm[] = [];
  created: CreateVmSpec[] = [];
  deleted: string[] = [];
  /** "zone/PROVISIONING" (template machine type) or "zone/PROVISIONING/machine-type" keys that stock out. */
  stockouts = new Set<string>();
  failWith: Error | undefined;
  /**
   * Quota metric thrown for a placement, by key (most specific first):
   *   "PROVISIONING/machine-type@region" family quota in one region
   *   "PROVISIONING/machine-type"        family quota in every region (scoped to the zone's region)
   *   "region:<region>"                  regional quota (SSD_TOTAL_GB, ...) for any type
   *   "*"                                global quota (CPUS_ALL_REGIONS): no region
   */
  quotas = new Map<string, string>();
  /** Every createRunnerVm call, as "zone/PROVISIONING/machine-type". */
  attempts: string[] = [];

  async listRunnerVms(): Promise<RunnerVm[]> {
    return this.vms;
  }
  async createRunnerVm(spec: CreateVmSpec): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.attempts.push(`${spec.zone}/${spec.provisioning}/${spec.machineType ?? ""}`);
    const region = regionOfZone(spec.zone);
    const family = `${spec.provisioning}/${spec.machineType ?? ""}`;
    const scoped: Array<[string | undefined, string | undefined]> = [
      [this.quotas.get(`${family}@${region}`), region],
      [this.quotas.get(family), region],
      [this.quotas.get(`region:${region}`), region],
      [this.quotas.get("*"), undefined],
    ];
    const hit = scoped.find(([metric]) => metric !== undefined);
    if (hit) {
      const [metric, quotaRegion] = hit;
      throw new QuotaError(metric!, `${spec.zone}: Quota '${metric}' exceeded`, quotaRegion);
    }
    const key = `${spec.zone}/${spec.provisioning}` + (spec.machineType ? `/${spec.machineType}` : "");
    if (this.stockouts.has(key)) throw new StockoutError(spec.zone);
    this.created.push(spec);
  }
  async deleteVm(v: RunnerVm): Promise<void> {
    this.deleted.push(v.name);
  }
  preempted = new Set<string>();
  preemptionLookups = 0;
  async wasPreempted(name: string): Promise<boolean> {
    this.preemptionLookups++;
    return this.preempted.has(name);
  }
}

export class FakeTasks implements TasksPort {
  tasks: Array<{ name: string; body: ReconcileRequest; scheduleAt: Date; baseUrl: string }> = [];
  reruns: Array<{ name: string; body: RerunRequest; scheduleAt: Date }> = [];
  async enqueueRerun(name: string, body: RerunRequest, scheduleAt: Date): Promise<boolean> {
    if (this.reruns.some((t) => t.name === name)) return false;
    this.reruns.push({ name, body, scheduleAt });
    return true;
  }
  async enqueueReconcile(name: string, body: ReconcileRequest, scheduleAt: Date, baseUrl: string): Promise<boolean> {
    if (this.tasks.some((t) => t.name === name)) return false;
    this.tasks.push({ name, body, scheduleAt, baseUrl });
    return true;
  }
}

export function makeDeps(config: Config = testConfig()) {
  const github = new FakeGitHub();
  const compute = new FakeCompute();
  const tasks = new FakeTasks();
  const deps: Deps = { config, github, compute, tasks, now: () => NOW, random: () => "abc123", log: () => {} };
  return { deps, github, compute, tasks };
}
