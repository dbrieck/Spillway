// The final instances.insert request GceCompute sends, asserted against the CIS GCP Foundations
// controls the burst runners must pass: 4.3 (block project SSH keys), 4.4 (OS Login), 4.8 (Shielded
// VM), 4.9 (no public IP) and 4.1/4.2 (dedicated, non-default service account).
import { describe, expect, it } from "vitest";
import {
  ENFORCED_METADATA,
  GceCompute,
  buildRunnerInstance,
  defaultRunnerServiceAccount,
  mergeRunnerMetadata,
  type ComputeClients,
} from "../src/compute.js";
import { loadConfig } from "../src/config.js";
import type { CreateVmSpec } from "../src/ports.js";

const PROJECT = "my-ci";
const TEMPLATE = `projects/${PROJECT}/global/instanceTemplates/ci-runner-20261102`;
const RUNNER_SA = `ci-runner-vm@${PROJECT}.iam.gserviceaccount.com`;

const spec = (overrides: Partial<CreateVmSpec> = {}): CreateVmSpec => ({
  name: "gcp-runner-101-abcd",
  zone: "us-east4-b",
  machineType: "c3d-standard-8",
  provisioning: "SPOT",
  labels: { "ci-runner": "spillway" },
  metadata: {
    "runner-jitconfig": "jit-config-placeholder",
    "runner-idle-timeout-seconds": "900",
    "serial-port-logging-enable": "TRUE",
  },
  maxRunSeconds: 14400,
  ...overrides,
});

type InsertRequest = { project: string; zone: string; sourceInstanceTemplate: string; instanceResource: Record<string, unknown> };

function fakeClients(templateItems: Array<{ key: string; value: string }>, failTemplateGets = 0) {
  const inserts: InsertRequest[] = [];
  const templateGets: unknown[] = [];
  let failuresLeft = failTemplateGets;
  const clients: ComputeClients = {
    instances: {
      insert: async (req: InsertRequest) => {
        inserts.push(req);
        return [{ latestResponse: { name: "op-1", status: "DONE", zone: req.zone } }];
      },
      delete: async () => [{}],
      aggregatedListAsync: () => (async function* () {})(),
    } as unknown as ComputeClients["instances"],
    zoneOps: { wait: async () => [{ status: "DONE" }] } as unknown as ComputeClients["zoneOps"],
    globalOps: { aggregatedListAsync: () => (async function* () {})() } as unknown as ComputeClients["globalOps"],
    templates: {
      get: async (req: unknown) => {
        templateGets.push(req);
        if (failuresLeft-- > 0) throw new Error("transient");
        return [{ properties: { metadata: { items: templateItems } } }];
      },
    } as unknown as ComputeClients["templates"],
  };
  return { clients, inserts, templateGets };
}

function metadataMap(instance: Record<string, unknown>): Record<string, string> {
  const items = (instance.metadata as { items: Array<{ key: string; value: string }> }).items;
  const keys = items.map((i) => i.key);
  expect(new Set(keys).size).toBe(keys.length); // no duplicate keys
  return Object.fromEntries(items.map((i) => [i.key, i.value]));
}

describe("GceCompute.createRunnerVm: final instance-insert request", () => {
  it("merges the template's metadata, the scaler's and the enforced CIS keys", async () => {
    const { clients, inserts, templateGets } = fakeClients([
      { key: "enable-oslogin", value: "TRUE" },
      { key: "block-project-ssh-keys", value: "TRUE" },
      { key: "startup-script-url", value: "gs://example/startup.sh" },
    ]);
    const compute = new GceCompute(PROJECT, TEMPLATE, "ci-runners-", "spillway", RUNNER_SA, clients);
    await compute.createRunnerVm(spec());

    expect(inserts).toHaveLength(1);
    const req = inserts[0]!;
    expect(req.sourceInstanceTemplate).toBe(TEMPLATE);
    expect(templateGets).toEqual([{ project: PROJECT, instanceTemplate: "ci-runner-20261102" }]);

    const md = metadataMap(req.instanceResource);
    expect(md["enable-oslogin"]).toBe("TRUE");
    expect(md["block-project-ssh-keys"]).toBe("TRUE");
    expect(md["startup-script-url"]).toBe("gs://example/startup.sh"); // template-only key survives
    expect(md["runner-jitconfig"]).toBe("jit-config-placeholder");
    expect(md["serial-port-logging-enable"]).toBe("TRUE");
  });

  it("sets the CIS keys even when the template has no metadata at all", async () => {
    const { clients, inserts } = fakeClients([]);
    await new GceCompute(PROJECT, TEMPLATE, "ci-runners-", "spillway", RUNNER_SA, clients).createRunnerVm(spec());
    const md = metadataMap(inserts[0]!.instanceResource);
    expect(md["enable-oslogin"]).toBe("TRUE");
    expect(md["block-project-ssh-keys"]).toBe("TRUE");
  });

  it("never requests an external IP (no accessConfigs on any NIC)", async () => {
    const { clients, inserts } = fakeClients([]);
    await new GceCompute(PROJECT, TEMPLATE, "ci-runners-", "spillway", RUNNER_SA, clients).createRunnerVm(spec());
    const nics = inserts[0]!.instanceResource.networkInterfaces as Array<Record<string, unknown>>;
    expect(nics).toEqual([{ subnetwork: `projects/${PROJECT}/regions/us-east4/subnetworks/ci-runners-us-east4` }]);
    for (const nic of nics) expect(nic).not.toHaveProperty("accessConfigs");
  });

  it("requests a Shielded VM and the dedicated runner service account", async () => {
    const { clients, inserts } = fakeClients([]);
    await new GceCompute(PROJECT, TEMPLATE, "ci-runners-", "spillway", RUNNER_SA, clients).createRunnerVm(spec({ provisioning: "STANDARD" }));
    const r = inserts[0]!.instanceResource;
    expect(r.shieldedInstanceConfig).toEqual({ enableSecureBoot: true, enableVtpm: true, enableIntegrityMonitoring: true });
    expect(r.serviceAccounts).toEqual([{ email: RUNNER_SA, scopes: ["https://www.googleapis.com/auth/cloud-platform"] }]);
    expect(JSON.stringify(r)).not.toContain("-compute@developer.gserviceaccount.com");
  });

  it("fetches the template once and reuses it for later launches", async () => {
    const { clients, inserts, templateGets } = fakeClients([]);
    const compute = new GceCompute(PROJECT, TEMPLATE, "ci-runners-", "spillway", RUNNER_SA, clients);
    await compute.createRunnerVm(spec());
    await compute.createRunnerVm(spec({ name: "gcp-runner-102-efgh" }));
    expect(inserts).toHaveLength(2);
    expect(templateGets).toHaveLength(1);
  });

  it("retries the template fetch after a failure instead of caching the error", async () => {
    const { clients, inserts } = fakeClients([], 1);
    const compute = new GceCompute(PROJECT, TEMPLATE, "ci-runners-", "spillway", RUNNER_SA, clients);
    await expect(compute.createRunnerVm(spec())).rejects.toThrow("transient");
    await compute.createRunnerVm(spec());
    expect(inserts).toHaveLength(1);
  });
});

describe("mergeRunnerMetadata", () => {
  it("lets the scaler override template values but never the enforced CIS keys", () => {
    const merged = Object.fromEntries(
      mergeRunnerMetadata(
        [
          { key: "enable-oslogin", value: "FALSE" },
          { key: "shared", value: "template" },
        ],
        { shared: "scaler", "block-project-ssh-keys": "FALSE" },
      ).map((i) => [i.key, i.value]),
    );
    expect(merged).toEqual({ "enable-oslogin": "TRUE", shared: "scaler", "block-project-ssh-keys": "TRUE" });
  });

  it("enforces exactly the CIS 4.3 / 4.4 keys", () => {
    expect(ENFORCED_METADATA).toEqual({ "enable-oslogin": "TRUE", "block-project-ssh-keys": "TRUE" });
  });
});

describe("runner service account", () => {
  it("defaults to the Terraform-managed ci-runner-vm account, never the compute default SA", () => {
    expect(defaultRunnerServiceAccount(PROJECT)).toBe(RUNNER_SA);
    const env = {
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      GITHUB_WEBHOOK_SECRET: "s",
      GCP_PROJECT: PROJECT,
      INSTANCE_TEMPLATE: TEMPLATE,
      TASKS_QUEUE: "projects/p/locations/l/queues/q",
      INVOKER_SERVICE_ACCOUNT: "inv@p.iam.gserviceaccount.com",
    };
    expect(loadConfig(env).runnerServiceAccount).toBe(RUNNER_SA);
    expect(loadConfig({ ...env, RUNNER_SERVICE_ACCOUNT: "other@p.iam.gserviceaccount.com" }).runnerServiceAccount).toBe(
      "other@p.iam.gserviceaccount.com",
    );
  });

  it("buildRunnerInstance carries the configured account", () => {
    const r = buildRunnerInstance(spec(), { project: PROJECT, subnetworkPrefix: "ci-runners-", serviceAccountEmail: RUNNER_SA, templateMetadata: [] });
    expect(r.serviceAccounts?.[0]?.email).toBe(RUNNER_SA);
  });
});
