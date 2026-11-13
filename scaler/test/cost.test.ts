import { describe, expect, it } from "vitest";
import { handleJanitor, handleReconcile, handleWebhook } from "../src/handlers.js";
import { burstDelayFor, isJobEligible, isSmallJob, runnerTierFor } from "../src/policy.js";
import { NOW, job, makeDeps, testConfig } from "./fakes.js";

const BASE = "https://ci-scaler.example";
const body = { repo: "acme/app", jobId: 101 };
const queued = (head_branch: string) => ({
  action: "queued",
  repository: { full_name: "acme/app" },
  workflow_job: { id: 101, labels: ["self-hosted", "Linux", "X64"], workflow_name: "dotnet build", head_branch },
});

describe("low-priority branches (post-merge runs on main)", () => {
  const cfg = { burstDelaySeconds: 10, lowPriorityBranches: ["main", "master"], lowPriorityBurstDelaySeconds: 600 };

  it.each([
    ["feature/x", 10],
    ["main", 600],
    ["Main", 600],
    ["maintenance", 10], // not a prefix match
    [null, 10],
  ])("burstDelayFor(%s) = %s", (branch, expected) => {
    expect(burstDelayFor(branch, cfg)).toBe(expected);
  });

  it("does not wait for a local runner when the job asks for a GCP-only label", () => {
    const labelled = { ...cfg, runnerLabels: ["self-hosted", "Linux", "X64", "gcp"], smallRunnerLabels: ["self-hosted", "Linux", "gcp-small"] };
    expect(burstDelayFor("main", labelled, ["self-hosted", "Linux", "X64", "GCP"])).toBe(0);
    expect(burstDelayFor("feature/x", labelled, ["self-hosted", "linux", "gcp-small"])).toBe(0);
    // Jobs a local runner could take keep their delay.
    expect(burstDelayFor("main", labelled, ["self-hosted", "Linux", "X64"])).toBe(600);
    expect(burstDelayFor("feature/x", labelled, ["self-hosted", "Linux"])).toBe(10);
    expect(burstDelayFor("feature/x", labelled)).toBe(10);
  });

  it("never shortens the normal delay", () => {
    expect(burstDelayFor("main", { ...cfg, burstDelaySeconds: 900 })).toBe(900);
  });

  it("schedules a main job's reconcile after the long delay and a PR job's after the short one", async () => {
    const config = testConfig({ ...cfg });
    const a = makeDeps(config);
    await handleWebhook(a.deps, "workflow_job", queued("main"), BASE);
    expect(a.tasks.tasks[0]!.scheduleAt.getTime() - NOW.getTime()).toBe(600_000);
    const b = makeDeps(config);
    await handleWebhook(b.deps, "workflow_job", queued("feature/x"), BASE);
    expect(b.tasks.tasks[0]!.scheduleAt.getTime() - NOW.getTime()).toBe(10_000);
  });

  it("the janitor sweep leaves a young main job alone but sweeps an equally old PR job", async () => {
    const { deps, github, tasks } = makeDeps(testConfig({ ...cfg }));
    const twoMinutesAgo = new Date(NOW.getTime() - 120_000);
    github.jobs.set(101, job({ id: 101, headBranch: "main", createdAt: twoMinutesAgo }));
    github.jobs.set(102, job({ id: 102, headBranch: "feature/x", createdAt: twoMinutesAgo }));
    github.jobs.set(103, job({ id: 103, headBranch: "main", createdAt: new Date(NOW.getTime() - 700_000) }));
    await handleJanitor(deps, BASE);
    expect(tasks.tasks.map((t) => t.body.jobId).sort()).toEqual([102, 103]);
  });
});

describe("small runner tier", () => {
  const cfg = {
    runnerLabels: ["self-hosted", "Linux", "X64", "gcp"],
    machineTypes: ["c3d-standard-8", "e2-standard-8"],
    smallRunnerLabels: ["self-hosted", "Linux", "gcp-small"],
    smallMachineTypes: ["c3d-standard-4", "e2-standard-4"],
  };
  const small = ["self-hosted", "Linux"];
  const regular = ["self-hosted", "Linux", "X64"];

  it.each([
    [small, true],
    [["self-hosted", "linux", "GCP-SMALL"], true],
    [regular, false],
    [["self-hosted", "Linux", "X64", "gcp"], false],
    [["Linux"], false], // not self-hosted
  ])("%j is a small job: %s", (labels, expected) => {
    expect(isSmallJob(labels, cfg)).toBe(expected);
  });

  it("gives a small job the small labels and small types, with the regular types as fallback", () => {
    expect(runnerTierFor(small, cfg)).toEqual({
      labels: ["self-hosted", "Linux", "gcp-small"],
      machineTypes: ["c3d-standard-4", "e2-standard-4", "c3d-standard-8", "e2-standard-8"],
    });
  });

  it("gives a regular job the regular labels and types", () => {
    expect(runnerTierFor(regular, cfg)).toEqual({ labels: cfg.runnerLabels, machineTypes: cfg.machineTypes });
  });

  it("is off when no small types are configured: the job runs on a regular runner", () => {
    const off = { ...cfg, smallMachineTypes: [] };
    expect(isSmallJob(small, off)).toBe(false);
    expect(isJobEligible(small, off)).toBe(true);
    expect(runnerTierFor(small, off)).toEqual({ labels: cfg.runnerLabels, machineTypes: cfg.machineTypes });
  });

  it("a job that asks for the small label is only eligible while the tier is on", () => {
    const explicit = ["self-hosted", "Linux", "gcp-small"];
    expect(isJobEligible(explicit, cfg)).toBe(true);
    expect(isJobEligible(explicit, { ...cfg, smallMachineTypes: [] })).toBe(false);
  });

  it("registers a small job's runner WITHOUT the full-size labels, on a small VM", async () => {
    const { deps, github, compute } = makeDeps(testConfig({ ...cfg }));
    github.jobs.set(101, job({ name: "e2e (2)", labels: small }));
    await handleReconcile(deps, body);
    expect(compute.created[0]).toMatchObject({ machineType: "c3d-standard-4" });
    expect(github.jitCalls[0]!.labels).toEqual(["self-hosted", "Linux", "gcp-small"]);
    expect(github.jitCalls[0]!.labels).not.toContain("X64");
  });

  it("falls back to a regular VM on a small-type stockout, still with the small labels", async () => {
    const b = makeDeps(testConfig({ ...cfg, spotFallbackToStandard: false }));
    b.github.jobs.set(101, job({ name: "e2e (2)", labels: small }));
    b.compute.stockouts = new Set(
      ["c3d-standard-4", "e2-standard-4"].flatMap((t) => ["us-central1-a", "us-central1-b"].map((z) => `${z}/SPOT/${t}`)),
    );
    await handleReconcile(b.deps, body);
    expect(b.compute.created[0]).toMatchObject({ machineType: "c3d-standard-8" });
    expect(b.github.jitCalls[0]!.labels).toEqual(["self-hosted", "Linux", "gcp-small"]);
  });

  it("never sizes by job name: a full-size job named like a test leg gets a regular runner", async () => {
    const { deps, github, compute } = makeDeps(testConfig({ ...cfg }));
    github.jobs.set(101, job({ name: "e2e (2)", labels: regular }));
    await handleReconcile(deps, body);
    expect(compute.created[0]).toMatchObject({ machineType: "c3d-standard-8" });
    expect(github.jitCalls[0]!.labels).toEqual(cfg.runnerLabels);
  });
});

describe("runner VM placement (no external IP, CIS 4.9)", () => {
  it("never passes an external-IP option to compute: every VM egresses through Cloud NAT", async () => {
    const { deps, github, compute } = makeDeps();
    github.jobs.set(101, job());
    await handleReconcile(deps, body);
    expect(compute.created).toHaveLength(1);
    expect(compute.created[0]).not.toHaveProperty("externalIp");
  });

  it("requests serial console logging so peak memory can be read after the VM is gone", async () => {
    const { deps, github, compute } = makeDeps();
    github.jobs.set(101, job());
    await handleReconcile(deps, body);
    expect(compute.created[0]!.metadata["serial-port-logging-enable"]).toBe("TRUE");
  });
});

describe("C3D family quota (CPUS_PER_VM_FAMILY, 24 vCPUs per region by default)", () => {
  it("falls back to the next machine type in the same region instead of blocking the region", async () => {
    const { deps, github, compute } = makeDeps(
      testConfig({ machineTypes: ["c3d-standard-8", "e2-standard-8"], zones: ["us-central1-a", "us-central1-b", "us-east4-a"] }),
    );
    github.jobs.set(101, job());
    compute.quotas.set("SPOT/c3d-standard-8@us-central1", "CPUS_PER_VM_FAMILY");
    const r = await handleReconcile(deps, body);
    expect(r.status).toBe(201);
    // c3d is still tried (and wins) in the next region before any pricier type is used.
    expect(compute.created[0]).toMatchObject({ zone: "us-east4-a", machineType: "c3d-standard-8" });
    expect(compute.attempts).toEqual(["us-central1-a/SPOT/c3d-standard-8", "us-east4-a/SPOT/c3d-standard-8"]);
  });

  it("uses the next machine type once every region is out of C3D quota", async () => {
    const { deps, github, compute } = makeDeps(
      testConfig({ machineTypes: ["c3d-standard-8", "e2-standard-8"], zones: ["us-central1-a", "us-east4-a"] }),
    );
    github.jobs.set(101, job());
    compute.quotas.set("SPOT/c3d-standard-8", "CPUS_PER_VM_FAMILY");
    const r = await handleReconcile(deps, body);
    expect(r.status).toBe(201);
    expect(compute.created[0]).toMatchObject({ zone: "us-central1-a", machineType: "e2-standard-8", provisioning: "SPOT" });
  });
});
