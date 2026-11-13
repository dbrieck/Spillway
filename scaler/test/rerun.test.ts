import { describe, expect, it } from "vitest";
import { handleRerun, handleWebhook } from "../src/handlers.js";
import { decideRerun } from "../src/policy.js";
import { NOW, makeDeps, testConfig } from "./fakes.js";

const RUNNER = "spillway-111-abc123";

const completed = (overrides: Record<string, unknown> = {}) => ({
  action: "completed",
  repository: { full_name: "acme/app" },
  workflow_job: {
    id: 555,
    run_id: 77,
    run_attempt: 1,
    labels: ["self-hosted", "Linux", "X64"],
    workflow_name: "dotnet build",
    conclusion: "failure",
    runner_name: RUNNER,
    ...overrides,
  },
});

describe("decideRerun", () => {
  const base = { failedAttempt: 1, runAttempt: 1, runStatus: "completed", runConclusion: "failure", preempted: true, maxRetries: 1 };
  it.each([
    [{}, "rerun"],
    [{ runAttempt: 2 }, "superseded"],
    [{ failedAttempt: 2, runAttempt: 2 }, "retry-limit"],
    [{ preempted: false }, "not-preempted"],
    [{ runStatus: "in_progress" }, "run-in-progress"],
    [{ maxRetries: 0 }, "retry-limit"],
    [{ runConclusion: "cancelled" }, "run-cancelled"],
    [{ runConclusion: "cancelled", preempted: false }, "not-preempted"],
  ])("%j -> %s", (o, kind) => {
    expect(decideRerun({ ...base, ...o }).kind).toBe(kind);
  });
});

describe("webhook: completed jobs", () => {
  it("schedules a rerun check for a failed job on a GCP runner", async () => {
    const { deps, tasks } = makeDeps();
    const r = await handleWebhook(deps, "workflow_job", completed(), "https://s");
    expect(r).toMatchObject({ status: 202, body: { result: "rerun-check-scheduled" } });
    expect(tasks.reruns).toHaveLength(1);
    expect(tasks.reruns[0]).toMatchObject({
      name: "rerun-555-1",
      body: { repo: "acme/app", runId: 77, jobId: 555, runAttempt: 1, runnerName: RUNNER },
    });
    expect(tasks.reruns[0]!.scheduleAt.getTime() - NOW.getTime()).toBe(120_000);
    expect(tasks.tasks).toHaveLength(0); // no reconcile task
  });

  it.each([
    ["success", { conclusion: "success" }],
    ["cancelled", { conclusion: "cancelled" }],
    ["local runner", { runner_name: "local-runner-1" }],
    ["no runner", { runner_name: null }],
  ])("ignores %s", async (_label, o) => {
    const { deps, tasks } = makeDeps();
    expect((await handleWebhook(deps, "workflow_job", completed(o), "https://s")).body.result).toBe("ignored");
    expect(tasks.reruns).toHaveLength(0);
  });

  it("ignores failures when preemption re-runs are disabled", async () => {
    const { deps, tasks } = makeDeps(testConfig({ preemptionRetries: 0 }));
    await handleWebhook(deps, "workflow_job", completed(), "https://s");
    expect(tasks.reruns).toHaveLength(0);
  });
});

describe("handleRerun", () => {
  const body = { repo: "acme/app", runId: 77, jobId: 555, runAttempt: 1, runnerName: RUNNER };

  it("re-runs failed jobs when the VM was preempted and the run is finished", async () => {
    const { deps, github, compute } = makeDeps();
    github.runs.set(77, { id: 77, status: "completed", conclusion: "failure", runAttempt: 1 });
    compute.preempted.add(RUNNER);
    expect(await handleRerun(deps, body)).toMatchObject({ status: 200, body: { result: "rerun" } });
    expect(github.reran).toEqual([77]);
  });

  it("does not resurrect a run that was cancelled after the preemption", async () => {
    const { deps, github, compute } = makeDeps();
    github.runs.set(77, { id: 77, status: "completed", conclusion: "cancelled", runAttempt: 1 });
    compute.preempted.add(RUNNER);
    expect(await handleRerun(deps, body)).toMatchObject({ status: 200, body: { result: "run-cancelled" } });
    expect(github.reran).toHaveLength(0);
  });

  it("leaves genuine failures alone", async () => {
    const { deps, github } = makeDeps();
    github.runs.set(77, { id: 77, status: "completed", conclusion: "failure", runAttempt: 1 });
    expect((await handleRerun(deps, body)).body.result).toBe("not-preempted");
    expect(github.reran).toHaveLength(0);
  });

  it("asks Cloud Tasks to retry while the run's other jobs are still running", async () => {
    const { deps, github, compute } = makeDeps();
    github.runs.set(77, { id: 77, status: "in_progress", conclusion: null, runAttempt: 1 });
    compute.preempted.add(RUNNER);
    expect((await handleRerun(deps, body)).status).toBe(503);
    expect(github.reran).toHaveLength(0);
  });

  it("does nothing, without a preemption lookup, once the run was re-run or past the limit", async () => {
    const { deps, github, compute } = makeDeps();
    compute.preempted.add(RUNNER);
    github.runs.set(77, { id: 77, status: "completed", conclusion: "failure", runAttempt: 2 });
    expect((await handleRerun(deps, body)).body.result).toBe("superseded");
    github.runs.set(77, { id: 77, status: "completed", conclusion: "failure", runAttempt: 2 });
    expect((await handleRerun(deps, { ...body, runAttempt: 2 })).body.result).toBe("retry-limit");
    expect(compute.preemptionLookups).toBe(0);
    expect(github.reran).toHaveLength(0);
  });

  it("rejects malformed bodies", async () => {
    const { deps } = makeDeps();
    expect((await handleRerun(deps, { repo: "acme/app" })).status).toBe(400);
  });
});
