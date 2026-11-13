import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { GitHubRunner } from "./policy.js";
import type { GitHubPort, JitConfig, JobInfo, RepoRef, RunInfo } from "./ports.js";

interface ApiJob {
  id: number;
  run_id: number;
  name: string;
  head_branch?: string | null;
  status: string;
  labels: string[];
  workflow_name?: string | null;
  created_at: string;
}

function toJob(j: ApiJob): JobInfo {
  return {
    id: j.id,
    runId: j.run_id,
    name: j.name,
    headBranch: j.head_branch ?? null,
    status: j.status,
    labels: j.labels,
    workflowName: j.workflow_name ?? null,
    createdAt: new Date(j.created_at),
  };
}

/** GitHub App client: one installation-scoped Octokit per repository, created lazily. */
export class GitHubAppClient implements GitHubPort {
  private readonly appOctokit: Octokit;
  private readonly installs = new Map<string, Promise<Octokit>>();

  constructor(
    private readonly appId: string,
    private readonly privateKey: string,
  ) {
    this.appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
  }

  private forRepo(r: RepoRef): Promise<Octokit> {
    const key = `${r.owner}/${r.repo}`.toLowerCase();
    let p = this.installs.get(key);
    if (!p) {
      p = this.appOctokit.rest.apps.getRepoInstallation({ owner: r.owner, repo: r.repo }).then(
        ({ data }) =>
          new Octokit({
            authStrategy: createAppAuth,
            auth: { appId: this.appId, privateKey: this.privateKey, installationId: data.id },
          }),
      );
      // Don't cache a failed lookup (e.g. app not yet installed); the next call retries.
      p.catch(() => this.installs.delete(key));
      this.installs.set(key, p);
    }
    return p;
  }

  async getJob(r: RepoRef, jobId: number): Promise<JobInfo> {
    const o = await this.forRepo(r);
    const { data } = await o.rest.actions.getJobForWorkflowRun({ owner: r.owner, repo: r.repo, job_id: jobId });
    return toJob(data as ApiJob);
  }

  async listQueuedJobs(r: RepoRef): Promise<JobInfo[]> {
    const o = await this.forRepo(r);
    const jobs: JobInfo[] = [];
    // Matrix jobs can sit queued inside an in_progress run, so scan both run states.
    for (const status of ["queued", "in_progress"] as const) {
      const { data } = await o.rest.actions.listWorkflowRunsForRepo({ owner: r.owner, repo: r.repo, status, per_page: 50 });
      for (const run of data.workflow_runs) {
        const runJobs = await o.paginate(o.rest.actions.listJobsForWorkflowRun, {
          owner: r.owner,
          repo: r.repo,
          run_id: run.id,
          filter: "latest",
          per_page: 100,
        });
        for (const j of runJobs) if (j.status === "queued") jobs.push(toJob(j as ApiJob));
      }
    }
    return jobs;
  }

  async createJitConfig(r: RepoRef, name: string, labels: string[]): Promise<JitConfig> {
    const o = await this.forRepo(r);
    const { data } = await o.rest.actions.generateRunnerJitconfigForRepo({
      owner: r.owner,
      repo: r.repo,
      name,
      runner_group_id: 1, // "Default" — the only group on user-owned repositories
      labels,
      work_folder: "_work",
    });
    return { runnerId: data.runner.id, encodedJitConfig: data.encoded_jit_config };
  }

  async listRunners(r: RepoRef): Promise<GitHubRunner[]> {
    const o = await this.forRepo(r);
    const runners = await o.paginate(o.rest.actions.listSelfHostedRunnersForRepo, {
      owner: r.owner,
      repo: r.repo,
      per_page: 100,
    });
    return runners.map((x) => ({
      id: x.id,
      name: x.name,
      status: x.status,
      busy: x.busy,
      labels: x.labels.map((l) => l.name),
    }));
  }

  async deleteRunner(r: RepoRef, runnerId: number): Promise<void> {
    const o = await this.forRepo(r);
    await o.rest.actions.deleteSelfHostedRunnerFromRepo({ owner: r.owner, repo: r.repo, runner_id: runnerId });
  }

  async getRun(r: RepoRef, runId: number): Promise<RunInfo> {
    const o = await this.forRepo(r);
    const { data } = await o.rest.actions.getWorkflowRun({ owner: r.owner, repo: r.repo, run_id: runId });
    return { id: data.id, status: data.status ?? "unknown", conclusion: data.conclusion ?? null, runAttempt: data.run_attempt ?? 1 };
  }

  async getRunHeadRepository(r: RepoRef, runId: number): Promise<string | null> {
    const o = await this.forRepo(r);
    const { data } = await o.rest.actions.getWorkflowRun({ owner: r.owner, repo: r.repo, run_id: runId });
    return data.head_repository?.full_name ?? null;
  }

  async rerunFailedJobs(r: RepoRef, runId: number): Promise<void> {
    const o = await this.forRepo(r);
    await o.rest.actions.reRunWorkflowFailedJobs({ owner: r.owner, repo: r.repo, run_id: runId });
  }
}
