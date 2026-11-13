import { describe, expect, it } from "vitest";
import {
  chooseProvisioning,
  decideReconcile,
  regionOfZone,
  subnetworkForZone,
  classifyQuotaErrors,
  isFamilyCpuQuota,
  quotaMetric,
  quotaRegion,
  isEligible,
  isRepoAllowed,
  selectRunnersToDelete,
  selectVmsToDelete,
  taskName,
  vmName,
} from "../src/policy.js";
import { NOW, vm } from "./fakes.js";

const RUNNER = ["self-hosted", "Linux", "X64", "gcp"];

describe("isEligible", () => {
  it.each([
    [["self-hosted", "Linux", "X64"], true],
    [["self-hosted", "linux", "x64"], true], // case-insensitive
    [["self-hosted", "Linux", "X64", "gcp"], true],
    [["self-hosted"], true],
    [["self-hosted", "Linux", "X64", "self-hosted-gpu"], false], // a label only another pool offers
    [["self-hosted", "macOS", "ARM64"], false],
    [["ubuntu-latest"], false], // GitHub-hosted
    [["Linux", "X64"], false], // not self-hosted
    [[], false],
  ])("%j -> %s", (labels, expected) => {
    expect(isEligible(labels, RUNNER)).toBe(expected);
  });
});

it("isRepoAllowed is case-insensitive against a lower-cased allow list", () => {
  expect(isRepoAllowed("acme/app", ["acme/app"])).toBe(true);
  expect(isRepoAllowed("someone/else", ["acme/app"])).toBe(false);
});

describe("chooseProvisioning", () => {
  const globs = ["Nightly*", "*mutation report*"];
  it.each([
    ["dotnet build", "SPOT"],
    ["Nightly e2e", "STANDARD"],
    ["Accounting mutation report", "STANDARD"],
    [null, "SPOT"],
  ] as const)("%s -> %s", (name, expected) => {
    expect(chooseProvisioning(name, globs)).toBe(expected);
  });
});

describe("decideReconcile", () => {
  const base = {
    jobId: 7,
    jobStatus: "queued",
    workflowName: "dotnet build",
    vms: [],
    now: NOW,
    maxRunners: 2,
    bootGraceSeconds: 600,
    standardWorkflows: [],
  };

  it("launches Spot when queued and under capacity", () => {
    expect(decideReconcile(base)).toEqual({ kind: "launch", provisioning: "SPOT" });
  });

  it("is paused when MAX_RUNNERS is 0", () => {
    expect(decideReconcile({ ...base, maxRunners: 0 }).kind).toBe("paused");
  });

  it("skips jobs a local runner already picked up", () => {
    expect(decideReconcile({ ...base, jobStatus: "in_progress" })).toEqual({ kind: "not-queued", status: "in_progress" });
  });

  it("treats a young VM launched for the same job as pending", () => {
    const d = decideReconcile({ ...base, vms: [vm({ labels: { "ci-job": "7" } })] });
    expect(d.kind).toBe("pending");
  });

  it("relaunches once the VM for the job is past the boot grace (it took another job)", () => {
    const old = vm({ labels: { "ci-job": "7" }, createdAt: new Date(NOW.getTime() - 700_000) });
    expect(decideReconcile({ ...base, vms: [old] }).kind).toBe("launch");
  });

  it("is at capacity when live VMs reach the cap, ignoring terminated ones", () => {
    const vms = [vm({ name: "a" }), vm({ name: "b" }), vm({ name: "c", status: "TERMINATED" })];
    expect(decideReconcile({ ...base, vms })).toEqual({ kind: "at-capacity", live: 2, max: 2 });
    expect(decideReconcile({ ...base, vms: vms.slice(1) }).kind).toBe("launch");
  });
});

describe("selectVmsToDelete", () => {
  it("deletes terminated/stopped and over-age VMs only", () => {
    const vms = [
      vm({ name: "running" }),
      vm({ name: "done", status: "TERMINATED" }),
      vm({ name: "stopped", status: "STOPPED" }),
      vm({ name: "stopping", status: "STOPPING", createdAt: new Date(0) }),
      vm({ name: "ancient", createdAt: new Date(NOW.getTime() - 5 * 3600_000) }),
    ];
    expect(selectVmsToDelete(vms, NOW, 4 * 3600).map((v) => v.name)).toEqual(["done", "stopped", "ancient"]);
  });
});

describe("selectRunnersToDelete", () => {
  const r = (name: string, status = "offline", busy = false) => ({ id: name.length, name, status, busy, labels: [] });

  it("removes only offline scaler runners without a live VM", () => {
    const runners = [
      r("spillway-1-aaa"), // live VM -> keep (still booting)
      r("spillway-2-bbb"), // VM gone -> delete
      r("spillway-3-ccc"), // VM terminated -> delete
      r("spillway-4-ddd", "online"),
      r("local-runner-1"), // another pool (e.g. local runners) -> never touched
    ];
    const vms = [vm({ name: "spillway-1-aaa" }), vm({ name: "spillway-3-ccc", status: "TERMINATED" })];
    expect(selectRunnersToDelete(runners, vms, "spillway-").map((x) => x.name)).toEqual(["spillway-2-bbb", "spillway-3-ccc"]);
  });
});

it("vmName produces a valid GCE name", () => {
  const n = vmName("spillway-", 123456789012, "A_b!9zz99");
  expect(n).toBe("spillway-123456789012-ab9zz9");
  expect(n).toMatch(/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/);
});

it("taskName distinguishes webhook and sweep tasks", () => {
  expect(taskName(5)).toBe("job-5");
  expect(taskName(5, 42)).toBe("job-5-sweep-42");
});

describe("multi-region placement", () => {
  it.each([
    ["us-central1-a", "us-central1"],
    ["us-east4-c", "us-east4"],
    ["europe-west4-b", "europe-west4"],
  ])("regionOfZone(%s) = %s", (zone, region) => {
    expect(regionOfZone(zone)).toBe(region);
  });

  it("rejects non-zone names", () => {
    expect(() => regionOfZone("us-central1")).toThrow();
  });

  it("builds the per-region runner subnet path", () => {
    expect(subnetworkForZone("my-ci", "us-west1-b", "ci-runners-")).toBe(
      "projects/my-ci/regions/us-west1/subnetworks/ci-runners-us-west1",
    );
  });
});

describe("isFamilyCpuQuota", () => {
  it.each([
    ["N2D_CPUS", true],
    ["E2_CPUS", true],
    ["N2_CPUS", true],
    ["CPUS_PER_VM_FAMILY", true], // C3D and other newer families (dimension vm_family)
    ["CPUS", false],
    ["CPUS_ALL_REGIONS", false],
    ["PREEMPTIBLE_CPUS", false],
    ["SSD_TOTAL_GB", false],
    ["UNKNOWN", false],
  ])("%s -> %s", (metric, expected) => {
    expect(isFamilyCpuQuota(metric)).toBe(expected);
  });
});

describe("quota error parsing (GCE message format)", () => {
  const regional = "Quota 'SSD_TOTAL_GB' exceeded.  Limit: 1000.0 in region us-central1.";
  const global = "Quota 'CPUS_ALL_REGIONS' exceeded.  Limit: 96.0 globally.";

  it("extracts the metric", () => {
    expect(quotaMetric(regional)).toBe("SSD_TOTAL_GB");
    expect(quotaMetric(global)).toBe("CPUS_ALL_REGIONS");
    expect(quotaMetric("QUOTA_EXCEEDED")).toBe("UNKNOWN");
    expect(quotaMetric("ZONE_RESOURCE_POOL_EXHAUSTED")).toBeUndefined();
  });

  it("extracts the region of a regional quota and nothing for a global one", () => {
    expect(quotaRegion(regional)).toBe("us-central1");
    expect(quotaRegion(`us-central1-a: QUOTA_EXCEEDED: ${regional}`)).toBe("us-central1");
    expect(quotaRegion(global)).toBeUndefined();
    expect(quotaRegion(undefined)).toBeUndefined();
  });
});

describe("classifyQuotaErrors", () => {
  const ssd = { code: "QUOTA_EXCEEDED", message: "Quota 'SSD_TOTAL_GB' exceeded.  Limit: 1000.0 in region us-central1." };
  const cpusAll = { code: "QUOTA_EXCEEDED", message: "Quota 'CPUS_ALL_REGIONS' exceeded.  Limit: 96.0 globally." };
  const stockout = { code: "ZONE_RESOURCE_POOL_EXHAUSTED", message: "The zone does not have enough resources" };

  it("keeps metric and region from the same error", () => {
    expect(classifyQuotaErrors([ssd])).toEqual({ metric: "SSD_TOTAL_GB", region: "us-central1" });
    expect(classifyQuotaErrors([cpusAll])).toEqual({ metric: "CPUS_ALL_REGIONS", region: undefined });
  });

  it("never attaches another error's region to a global quota, and prefers the global one", () => {
    expect(classifyQuotaErrors([cpusAll, ssd])).toEqual({ metric: "CPUS_ALL_REGIONS", region: undefined });
    expect(classifyQuotaErrors([ssd, cpusAll])).toEqual({ metric: "CPUS_ALL_REGIONS", region: undefined });
  });

  it("ignores non-quota errors", () => {
    expect(classifyQuotaErrors([stockout])).toBeUndefined();
    expect(classifyQuotaErrors([stockout, ssd])).toEqual({ metric: "SSD_TOTAL_GB", region: "us-central1" });
    expect(classifyQuotaErrors([])).toBeUndefined();
  });
});
