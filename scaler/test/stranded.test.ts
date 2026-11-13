import { describe, expect, it } from "vitest";
import { handleReconcile } from "../src/handlers.js";
import { decideReconcile } from "../src/policy.js";
import { NOW, job, makeDeps, vm } from "./fakes.js";

const body = { repo: "acme/app", jobId: 101 };
const VM = "spillway-101-old111";
const jobVm = (overrides = {}) => vm({ name: VM, labels: { "ci-runner": "spillway", "ci-job": "101" }, ...overrides });
const runner = (busy: boolean) => ({ id: 5, name: VM, status: "online", busy, labels: [] });

describe("decideReconcile: a VM launched for the job that another job took", () => {
  const base = {
    jobId: 101,
    jobStatus: "queued",
    workflowName: "dotnet build",
    vms: [jobVm()],
    now: NOW,
    maxRunners: 5,
    bootGraceSeconds: 600,
    standardWorkflows: [],
  };

  it("is pending while that VM is booting or idle", () => {
    expect(decideReconcile(base).kind).toBe("pending");
    expect(decideReconcile({ ...base, busyRunnerNames: new Set(["spillway-999-other"]) }).kind).toBe("pending");
  });

  it("launches a replacement once that VM's runner is busy (it is running a different job)", () => {
    expect(decideReconcile({ ...base, busyRunnerNames: new Set([VM]) }).kind).toBe("launch");
  });

  it("still respects the runner cap", () => {
    const d = decideReconcile({ ...base, maxRunners: 1, busyRunnerNames: new Set([VM]) });
    expect(d.kind).toBe("at-capacity");
  });
});

describe("handleReconcile: stranded jobs", () => {
  it("asks Cloud Tasks to retry (503) while the job's VM is still booting", async () => {
    const { deps, github, compute } = makeDeps();
    github.jobs.set(101, job());
    compute.vms = [jobVm()];
    github.runners = [runner(false)];
    const r = await handleReconcile(deps, body);
    expect(r).toMatchObject({ status: 503, body: { result: "pending", vm: VM } });
    expect(compute.created).toHaveLength(0);
  });

  it("launches a new VM when the job's VM is busy with another job", async () => {
    const { deps, github, compute } = makeDeps();
    github.jobs.set(101, job());
    compute.vms = [jobVm()];
    github.runners = [runner(true)];
    const r = await handleReconcile(deps, body);
    expect(r.status).toBe(201);
    expect(compute.created).toHaveLength(1);
    expect(compute.created[0]!.labels["ci-job"]).toBe("101");
  });

  it("does not launch a spare when the job's own VM picked it up between the two reads", async () => {
    const { deps, github, compute } = makeDeps();
    compute.vms = [jobVm()];
    github.runners = [runner(true)]; // busy... with THIS job
    let reads = 0;
    github.getJob = async () => job({ status: ++reads === 1 ? "queued" : "in_progress" });
    const r = await handleReconcile(deps, body);
    expect(r).toMatchObject({ status: 200, body: { result: "not-queued" } });
    expect(reads).toBe(2);
    expect(compute.created).toHaveLength(0);
  });

  it("does not list runners when there is no VM for the job (the common first launch)", async () => {
    const { deps, github, compute } = makeDeps();
    github.jobs.set(101, job());
    let listed = 0;
    const original = github.listRunners.bind(github);
    github.listRunners = async () => {
      listed++;
      return original();
    };
    await handleReconcile(deps, body);
    expect(compute.created).toHaveLength(1);
    expect(listed).toBe(0);
  });
});
