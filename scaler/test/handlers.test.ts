import { describe, expect, it } from "vitest";
import { handleJanitor, handleReconcile, handleWebhook } from "../src/handlers.js";
import { NOW, job, makeDeps, testConfig, vm } from "./fakes.js";

const BASE = "https://ci-scaler.example";

const queued = (labels = ["self-hosted", "Linux", "X64"], repo = "acme/app") => ({
  action: "queued",
  repository: { full_name: repo },
  workflow_job: { id: 101, labels, workflow_name: "dotnet build" },
});

describe("handleWebhook", () => {
  it("schedules a delayed reconcile for an eligible queued job", async () => {
    const { deps, tasks } = makeDeps();
    const r = await handleWebhook(deps, "workflow_job", queued(), BASE);
    expect(r.status).toBe(202);
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.tasks[0]).toMatchObject({ name: "job-101", body: { repo: "acme/app", jobId: 101 }, baseUrl: BASE });
    expect(tasks.tasks[0]!.scheduleAt.getTime() - NOW.getTime()).toBe(45_000);
  });

  it("dedupes redeliveries of the same job", async () => {
    const { deps, tasks } = makeDeps();
    await handleWebhook(deps, "workflow_job", queued(), BASE);
    const r = await handleWebhook(deps, "workflow_job", queued(), BASE);
    expect(r.body.result).toBe("duplicate");
    expect(tasks.tasks).toHaveLength(1);
  });

  it.each([
    ["ping", queued(), "pong"],
    ["push", queued(), "ignored"],
    ["workflow_job", { ...queued(), action: "completed" }, "ignored"],
    ["workflow_job", queued(["self-hosted", "Linux", "X64", "self-hosted-gpu"]), "ignored"],
    ["workflow_job", queued(["ubuntu-latest"]), "ignored"],
    ["workflow_job", queued(undefined, "someone/fork"), "ignored"],
  ])("%s -> %s without scheduling", async (event, payload, result) => {
    const { deps, tasks } = makeDeps();
    const r = await handleWebhook(deps, event, payload, BASE);
    expect(r.body.result).toBe(result);
    expect(tasks.tasks).toHaveLength(0);
  });

  it("does not schedule when paused", async () => {
    const { deps, tasks } = makeDeps(testConfig({ maxRunners: 0 }));
    expect((await handleWebhook(deps, "workflow_job", queued(), BASE)).body.result).toBe("paused");
    expect(tasks.tasks).toHaveLength(0);
  });
});

describe("handleReconcile", () => {
  const body = { repo: "acme/app", jobId: 101 };

  it("launches a Spot VM with JIT config, job label and idle timeout", async () => {
    const { deps, github, compute } = makeDeps();
    github.jobs.set(101, job());
    const r = await handleReconcile(deps, body);
    expect(r.status).toBe(201);
    expect(github.jitCalls).toEqual([{ name: "spillway-101-abc123", labels: ["self-hosted", "Linux", "X64", "gcp"] }]);
    expect(compute.created).toHaveLength(1);
    expect(compute.created[0]).toMatchObject({
      name: "spillway-101-abc123",
      zone: "us-central1-a",
      provisioning: "SPOT",
      labels: { "ci-runner": "spillway", "ci-job": "101", "ci-provisioning": "spot" },
      metadata: { "runner-jitconfig": "jit-spillway-101-abc123", "runner-idle-timeout-seconds": "900" },
      maxRunSeconds: 14400,
    });
  });

  describe("fork pull requests", () => {
    it.each([
      ["a fork", "someone/app"],
      ["a deleted fork", null],
    ])("does not launch for a run from %s", async (_what, head) => {
      const { deps, github, compute } = makeDeps();
      github.jobs.set(101, job());
      github.headRepos.set(77, head);
      const r = await handleReconcile(deps, body);
      expect(r).toMatchObject({ status: 200, body: { result: "ignored", reason: "fork pull request" } });
      expect(github.jitCalls).toHaveLength(0);
      expect(compute.created).toHaveLength(0);
    });

    it("compares the head repository case-insensitively", async () => {
      const { deps, github, compute } = makeDeps();
      github.jobs.set(101, job());
      github.headRepos.set(77, "Acme/App");
      expect((await handleReconcile(deps, body)).status).toBe(201);
      expect(compute.created).toHaveLength(1);
    });

    it("launches for a fork when ALLOW_FORK_PRS is on", async () => {
      const { deps, github, compute } = makeDeps(testConfig({ allowForkPrs: true }));
      github.jobs.set(101, job());
      github.headRepos.set(77, "someone/app");
      expect((await handleReconcile(deps, body)).status).toBe(201);
      expect(compute.created).toHaveLength(1);
    });
  });

  it("returns 200 without launching when a local runner took the job", async () => {
    const { deps, github, compute } = makeDeps();
    github.jobs.set(101, job({ status: "in_progress" }));
    const r = await handleReconcile(deps, body);
    expect(r).toMatchObject({ status: 200, body: { result: "not-queued" } });
    expect(compute.created).toHaveLength(0);
    expect(github.jitCalls).toHaveLength(0);
  });

  it("returns 503 (Cloud Tasks retries) at capacity", async () => {
    const { deps, github, compute } = makeDeps(testConfig({ maxRunners: 1 }));
    github.jobs.set(101, job());
    compute.vms = [vm()];
    expect((await handleReconcile(deps, body)).status).toBe(503);
    expect(github.jitCalls).toHaveLength(0);
  });

  it("uses STANDARD for configured long-running workflows", async () => {
    const { deps, github, compute } = makeDeps();
    github.jobs.set(101, job({ workflowName: "Nightly e2e (nightly)" }));
    await handleReconcile(deps, body);
    expect(compute.created[0]!.provisioning).toBe("STANDARD");
  });

  it("spills into another region when every zone of the first is stocked out", async () => {
    const { deps, github, compute } = makeDeps(
      testConfig({ zones: ["us-central1-a", "us-central1-b", "us-east4-a", "us-west1-a"], spotFallbackToStandard: false }),
    );
    github.jobs.set(101, job());
    compute.stockouts = new Set(["us-central1-a/SPOT", "us-central1-b/SPOT"]);
    const r = await handleReconcile(deps, body);
    expect(r.status).toBe(201);
    expect(compute.created[0]).toMatchObject({ zone: "us-east4-a", provisioning: "SPOT" });
  });

  it("walks zones on stockout, then falls back to STANDARD", async () => {
    const { deps, github, compute } = makeDeps();
    github.jobs.set(101, job());
    compute.stockouts = new Set(["us-central1-a/SPOT", "us-central1-b/SPOT", "us-central1-a/STANDARD"]);
    const r = await handleReconcile(deps, body);
    expect(r.status).toBe(201);
    expect(compute.created[0]).toMatchObject({ zone: "us-central1-b", provisioning: "STANDARD" });
  });

  it("stays on Spot-only when fallback is disabled, cleans up the JIT runner, and asks for a retry", async () => {
    const { deps, github, compute } = makeDeps(testConfig({ spotFallbackToStandard: false }));
    github.jobs.set(101, job());
    compute.stockouts = new Set(["us-central1-a/SPOT", "us-central1-b/SPOT"]);
    const r = await handleReconcile(deps, body);
    expect(r).toMatchObject({ status: 503, body: { result: "stockout" } });
    expect(github.deletedRunners).toEqual([900]);
  });

  describe("machine-type fallback", () => {
    const types = ["n2-standard-8", "n2d-standard-8", "e2-standard-8"];
    const all = (p: string, mt: string) => ["us-central1-a", "us-central1-b"].map((z) => `${z}/${p}/${mt}`);

    it("uses the first machine type when it has capacity, and labels the VM with it", async () => {
      const { deps, github, compute } = makeDeps(testConfig({ machineTypes: types }));
      github.jobs.set(101, job());
      const r = await handleReconcile(deps, body);
      expect(r).toMatchObject({ status: 201, body: { machineType: "n2-standard-8", provisioning: "SPOT" } });
      expect(compute.created[0]).toMatchObject({
        zone: "us-central1-a",
        machineType: "n2-standard-8",
        labels: { "ci-machine-type": "n2-standard-8" },
      });
    });

    it("switches machine type before walking to on-demand when a type is stocked out region-wide", async () => {
      const { deps, github, compute } = makeDeps(testConfig({ machineTypes: types }));
      github.jobs.set(101, job());
      compute.stockouts = new Set([...all("SPOT", "n2-standard-8"), "us-central1-a/SPOT/n2d-standard-8"]);
      const r = await handleReconcile(deps, body);
      expect(r.status).toBe(201);
      expect(compute.created[0]).toMatchObject({ zone: "us-central1-b", machineType: "n2d-standard-8", provisioning: "SPOT" });
    });

    it("tries every type as Spot, then every type on-demand", async () => {
      const { deps, github, compute } = makeDeps(testConfig({ machineTypes: types }));
      github.jobs.set(101, job());
      compute.stockouts = new Set([...types.flatMap((mt) => all("SPOT", mt)), ...all("STANDARD", "n2-standard-8")]);
      const r = await handleReconcile(deps, body);
      expect(r.status).toBe(201);
      expect(compute.created[0]).toMatchObject({ zone: "us-central1-a", machineType: "n2d-standard-8", provisioning: "STANDARD" });
    });

    it("returns 503 and cleans up when every type, zone and model is exhausted", async () => {
      const { deps, github, compute } = makeDeps(testConfig({ machineTypes: types }));
      github.jobs.set(101, job());
      compute.stockouts = new Set(types.flatMap((mt) => [...all("SPOT", mt), ...all("STANDARD", mt)]));
      const r = await handleReconcile(deps, body);
      expect(r).toMatchObject({ status: 503, body: { result: "stockout" } });
      expect(compute.created).toHaveLength(0);
      expect(github.deletedRunners).toEqual([900]);
    });

    it("stops the sweep at once on a global quota and asks for a retry", async () => {
      const { deps, github, compute } = makeDeps(testConfig({ machineTypes: types }));
      github.jobs.set(101, job());
      compute.quotas.set("*", "CPUS_ALL_REGIONS");
      const logs: string[] = [];
      deps.log = (m) => logs.push(m);
      const r = await handleReconcile(deps, body);
      expect(r).toMatchObject({ status: 503, body: { result: "quota" } });
      expect(logs.filter((m) => m === "quota exceeded")).toHaveLength(1); // no zone/type walk
      expect(github.deletedRunners).toEqual([900]);
    });

    it("skips a machine type whose family CPU quota is used up and tries the next", async () => {
      const { deps, github, compute } = makeDeps(testConfig({ machineTypes: types }));
      github.jobs.set(101, job());
      compute.stockouts = new Set(all("SPOT", "n2-standard-8"));
      compute.quotas.set("SPOT/n2d-standard-8", "N2D_CPUS");
      const r = await handleReconcile(deps, body);
      expect(r.status).toBe(201);
      expect(compute.created[0]).toMatchObject({ zone: "us-central1-a", machineType: "e2-standard-8", provisioning: "SPOT" });
    });

    it("reports quota (not stockout) when only family quotas blocked every type, so no on-demand retry", async () => {
      const { deps, github, compute } = makeDeps(testConfig({ machineTypes: ["n2d-standard-8", "e2-standard-8"] }));
      github.jobs.set(101, job());
      compute.quotas.set("SPOT/n2d-standard-8", "N2D_CPUS");
      compute.quotas.set("SPOT/e2-standard-8", "E2_CPUS");
      const r = await handleReconcile(deps, body);
      expect(r).toMatchObject({ status: 503, body: { result: "quota" } });
      expect(compute.created).toHaveLength(0);
    });

    describe("regional quotas across regions", () => {
      const zones = ["us-central1-a", "us-central1-b", "us-east4-a", "us-east4-b"];

      it("skips a region whose regional quota is used up and places the VM in the next region", async () => {
        const { deps, github, compute } = makeDeps(testConfig({ machineTypes: types, zones }));
        github.jobs.set(101, job());
        compute.quotas.set("region:us-central1", "SSD_TOTAL_GB");
        const r = await handleReconcile(deps, body);
        expect(r.status).toBe(201);
        expect(compute.created[0]).toMatchObject({ zone: "us-east4-a", machineType: "n2-standard-8", provisioning: "SPOT" });
        // One probe per blocked region, not one per zone.
        expect(compute.attempts.filter((a) => a.startsWith("us-central1"))).toEqual(["us-central1-a/SPOT/n2-standard-8"]);
      });

      it("rules out a family quota only in its region", async () => {
        const { deps, github, compute } = makeDeps(testConfig({ machineTypes: types, zones }));
        github.jobs.set(101, job());
        compute.stockouts = new Set(zones.map((z) => `${z}/SPOT/n2-standard-8`));
        compute.quotas.set("SPOT/n2d-standard-8@us-central1", "N2D_CPUS");
        const r = await handleReconcile(deps, body);
        expect(r.status).toBe(201);
        // n2d is out in us-central1 only: it's still tried (and used) in us-east4 before falling to e2.
        expect(compute.created[0]).toMatchObject({ zone: "us-east4-a", machineType: "n2d-standard-8" });
        expect(compute.attempts).not.toContain("us-central1-b/SPOT/n2d-standard-8");
      });

      it("keeps a quota-blocked region out of the STANDARD fallback too", async () => {
        const { deps, github, compute } = makeDeps(testConfig({ machineTypes: ["n2-standard-8"], zones }));
        github.jobs.set(101, job());
        compute.quotas.set("region:us-central1", "SSD_TOTAL_GB");
        compute.stockouts = new Set(["us-east4-a/SPOT/n2-standard-8", "us-east4-b/SPOT/n2-standard-8"]);
        const r = await handleReconcile(deps, body);
        expect(r.status).toBe(201);
        expect(compute.created[0]).toMatchObject({ zone: "us-east4-a", provisioning: "STANDARD" });
        expect(compute.attempts.filter((a) => a.startsWith("us-central1"))).toHaveLength(1);
      });

      it("reports quota when every region is quota-blocked", async () => {
        const { deps, github, compute } = makeDeps(testConfig({ machineTypes: types, zones }));
        github.jobs.set(101, job());
        compute.quotas.set("region:us-central1", "SSD_TOTAL_GB");
        compute.quotas.set("region:us-east4", "SSD_TOTAL_GB");
        const r = await handleReconcile(deps, body);
        expect(r).toMatchObject({ status: 503, body: { result: "quota" } });
        expect(compute.attempts).toHaveLength(2);
      });
    });

    it("leaves the machine type to the template when none are configured", async () => {
      const { deps, github, compute } = makeDeps();
      github.jobs.set(101, job());
      await handleReconcile(deps, body);
      expect(compute.created[0]!.machineType).toBeUndefined();
      expect(compute.created[0]!.labels).not.toHaveProperty("ci-machine-type");
    });
  });

  it("returns 500 and removes the JIT runner on a non-stockout insert failure", async () => {
    const { deps, github, compute } = makeDeps();
    github.jobs.set(101, job());
    compute.failWith = new Error("permission denied");
    const r = await handleReconcile(deps, body);
    expect(r.status).toBe(500);
    expect(github.deletedRunners).toEqual([900]);
  });

  it("rejects malformed bodies and foreign repos", async () => {
    const { deps } = makeDeps();
    expect((await handleReconcile(deps, { repo: "x" })).status).toBe(400);
    expect((await handleReconcile(deps, { repo: "a/b", jobId: 1 })).body.result).toBe("ignored");
  });
});

describe("handleJanitor", () => {
  it("deletes dead VMs, stale runner registrations, and sweeps still-queued jobs", async () => {
    const { deps, github, compute, tasks } = makeDeps();
    compute.vms = [vm({ name: "spillway-1-live" }), vm({ name: "spillway-2-done", status: "TERMINATED" })];
    github.runners = [
      { id: 1, name: "spillway-1-live", status: "offline", busy: false, labels: [] },
      { id: 2, name: "spillway-2-done", status: "offline", busy: false, labels: [] },
      { id: 3, name: "local-runner-1", status: "offline", busy: false, labels: [] },
    ];
    github.jobs.set(101, job());
    github.jobs.set(102, job({ id: 102, createdAt: new Date(NOW.getTime() - 10_000) })); // too young
    github.jobs.set(103, job({ id: 103, labels: ["self-hosted", "macOS", "ARM64"] }));

    const r = await handleJanitor(deps, BASE);
    expect(r.body).toMatchObject({ vmsDeleted: 1, runnersDeleted: 1, jobsSwept: 1, errors: [] });
    expect(compute.deleted).toEqual(["spillway-2-done"]);
    expect(github.deletedRunners).toEqual([2]);
    expect(tasks.tasks.map((t) => t.name)).toEqual([`job-101-sweep-${Math.floor(NOW.getTime() / 600_000)}`]);
  });

  it("still cleans up but does not sweep when paused", async () => {
    const { deps, github, compute, tasks } = makeDeps(testConfig({ maxRunners: 0 }));
    compute.vms = [vm({ status: "TERMINATED" })];
    github.jobs.set(101, job());
    const r = await handleJanitor(deps, BASE);
    expect(r.body).toMatchObject({ vmsDeleted: 1, jobsSwept: 0 });
    expect(tasks.tasks).toHaveLength(0);
  });
});
