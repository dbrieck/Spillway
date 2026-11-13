import { GlobalOperationsClient, InstanceTemplatesClient, InstancesClient, ZoneOperationsClient, type protos } from "@google-cloud/compute";
import { MANAGED_LABEL_KEY, classifyQuotaErrors, quotaMetric, quotaRegion, subnetworkForZone, type RunnerVm } from "./policy.js";
import { QuotaError, StockoutError, type ComputePort, type CreateVmSpec } from "./ports.js";

const STOCKOUT_CODES = ["ZONE_RESOURCE_POOL_EXHAUSTED", "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS"];

function isStockout(codeOrMessage: string | null | undefined): boolean {
  if (!codeOrMessage) return false;
  return STOCKOUT_CODES.some((c) => codeOrMessage.includes(c)) || /does not have enough resources/i.test(codeOrMessage);
}

const lastSegment = (url: string | null | undefined): string => (url ?? "").split("/").pop() ?? "";

/**
 * CIS GCP Foundations 4.3 (block project-wide SSH keys) and 4.4 (OS Login). Applied last, so neither
 * the template nor the scaler's own metadata can turn them off.
 */
export const ENFORCED_METADATA: Readonly<Record<string, string>> = {
  "enable-oslogin": "TRUE",
  "block-project-ssh-keys": "TRUE",
};

/** The runner VM identity terraform/iam.tf creates (logWriter + metricWriter only). */
export function defaultRunnerServiceAccount(project: string): string {
  return `ci-runner-vm@${project}.iam.gserviceaccount.com`;
}

type MetadataItem = { key?: string | null; value?: string | null };

/**
 * Per-VM metadata on an insert REPLACES the template's metadata wholesale (GCE does not merge them),
 * which once dropped the template's OS Login keys from every runner. So the request carries the
 * template's items, overlaid by the scaler's, overlaid by ENFORCED_METADATA.
 */
export function mergeRunnerMetadata(
  templateItems: readonly MetadataItem[] | null | undefined,
  scalerMetadata: Readonly<Record<string, string>>,
): Array<{ key: string; value: string }> {
  const merged = new Map<string, string>();
  for (const item of templateItems ?? []) {
    if (item.key) merged.set(item.key, item.value ?? "");
  }
  for (const [key, value] of Object.entries(scalerMetadata)) merged.set(key, value);
  for (const [key, value] of Object.entries(ENFORCED_METADATA)) merged.set(key, value);
  return [...merged].map(([key, value]) => ({ key, value }));
}

export interface RunnerInstanceContext {
  project: string;
  subnetworkPrefix: string;
  serviceAccountEmail: string;
  templateMetadata: readonly MetadataItem[] | null | undefined;
}

/** The instanceResource of the insert request: everything the scaler overrides on the template. */
export function buildRunnerInstance(spec: CreateVmSpec, ctx: RunnerInstanceContext): protos.google.cloud.compute.v1.IInstance {
  const spot = spec.provisioning === "SPOT";
  return {
    name: spec.name,
    ...(spec.machineType ? { machineType: `zones/${spec.zone}/machineTypes/${spec.machineType}` } : {}),
    // The template's NIC is pinned to the home region; place the VM on its own region's subnet.
    // Never accessConfigs: no external IP (CIS 4.9). Egress goes through that region's Cloud NAT.
    networkInterfaces: [{ subnetwork: subnetworkForZone(ctx.project, spec.zone, ctx.subnetworkPrefix) }],
    labels: spec.labels,
    metadata: { items: mergeRunnerMetadata(ctx.templateMetadata, spec.metadata) },
    // Restated from the template so a template change cannot silently drop them (CIS 4.8, 4.1/4.2).
    shieldedInstanceConfig: { enableSecureBoot: true, enableVtpm: true, enableIntegrityMonitoring: true },
    serviceAccounts: [{ email: ctx.serviceAccountEmail, scopes: ["https://www.googleapis.com/auth/cloud-platform"] }],
    // Overrides the template's scheduling block wholesale, so every field is set here.
    scheduling: {
      provisioningModel: spec.provisioning,
      preemptible: spot,
      automaticRestart: false,
      // Spot must TERMINATE; on-demand E2 rejects TERMINATE, and MIGRATE is valid for every
      // on-demand type we use (no GPUs/local SSD).
      onHostMaintenance: spot ? "TERMINATE" : "MIGRATE",
      instanceTerminationAction: "DELETE",
      maxRunDuration: { seconds: spec.maxRunSeconds },
    },
  };
}

export interface ComputeClients {
  instances: Pick<InstancesClient, "insert" | "delete" | "aggregatedListAsync">;
  zoneOps: Pick<ZoneOperationsClient, "wait">;
  globalOps: Pick<GlobalOperationsClient, "aggregatedListAsync">;
  templates: Pick<InstanceTemplatesClient, "get">;
}

export class GceCompute implements ComputePort {
  private readonly instances: ComputeClients["instances"];
  private readonly zoneOps: ComputeClients["zoneOps"];
  private readonly globalOps: ComputeClients["globalOps"];
  private readonly templates: ComputeClients["templates"];
  private templateMetadata: Promise<MetadataItem[]> | undefined;

  constructor(
    private readonly project: string,
    private readonly instanceTemplate: string,
    private readonly subnetworkPrefix: string,
    private readonly poolName: string,
    private readonly runnerServiceAccount: string = defaultRunnerServiceAccount(project),
    clients: Partial<ComputeClients> = {},
  ) {
    this.instances = clients.instances ?? new InstancesClient();
    this.zoneOps = clients.zoneOps ?? new ZoneOperationsClient();
    this.globalOps = clients.globalOps ?? new GlobalOperationsClient();
    this.templates = clients.templates ?? new InstanceTemplatesClient();
  }

  /** The template's metadata items, fetched once per process (a failed fetch is retried next launch). */
  private getTemplateMetadata(): Promise<MetadataItem[]> {
    this.templateMetadata ??= this.templates
      .get({ project: this.project, instanceTemplate: lastSegment(this.instanceTemplate) })
      .then(([t]) => [...(t.properties?.metadata?.items ?? [])])
      .catch((err: unknown) => {
        this.templateMetadata = undefined;
        throw err;
      });
    return this.templateMetadata;
  }

  async listRunnerVms(): Promise<RunnerVm[]> {
    const out: RunnerVm[] = [];
    const iter = this.instances.aggregatedListAsync({
      project: this.project,
      filter: `labels.${MANAGED_LABEL_KEY} = ${this.poolName}`,
    });
    for await (const [, scoped] of iter) {
      for (const i of scoped.instances ?? []) {
        out.push({
          name: i.name ?? "",
          zone: lastSegment(i.zone),
          status: i.status ?? "UNKNOWN",
          createdAt: new Date(i.creationTimestamp ?? 0),
          labels: (i.labels ?? {}) as Record<string, string>,
        });
      }
    }
    return out;
  }

  async createRunnerVm(spec: CreateVmSpec): Promise<void> {
    const templateMetadata = await this.getTemplateMetadata();
    let response;
    try {
      [response] = await this.instances.insert({
        project: this.project,
        zone: spec.zone,
        sourceInstanceTemplate: this.instanceTemplate,
        instanceResource: buildRunnerInstance(spec, {
          project: this.project,
          subnetworkPrefix: this.subnetworkPrefix,
          serviceAccountEmail: this.runnerServiceAccount,
          templateMetadata,
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isStockout(msg)) throw new StockoutError(`${spec.zone}: ${msg}`);
      const metric = quotaMetric(msg);
      if (metric) throw new QuotaError(metric, `${spec.zone}: ${msg}`, quotaRegion(msg));
      throw err;
    }

    let op = response.latestResponse as {
      name?: string | null;
      status?: string | number | null;
      zone?: string | null;
      error?: { errors?: Array<{ code?: string | null; message?: string | null }> | null } | null;
    };
    while (op.status !== "DONE") {
      [op] = await this.zoneOps.wait({ project: this.project, zone: lastSegment(op.zone) || spec.zone, operation: op.name ?? "" });
    }
    const errors = op.error?.errors ?? [];
    if (errors.length > 0) {
      const detail = errors.map((e) => `${e.code}: ${e.message}`).join("; ");
      if (errors.some((e) => isStockout(e.code) || isStockout(e.message))) throw new StockoutError(`${spec.zone}: ${detail}`);
      const quota = classifyQuotaErrors(errors);
      if (quota) throw new QuotaError(quota.metric, `${spec.zone}: ${detail}`, quota.region);
      throw new Error(`Instance insert failed in ${spec.zone}: ${detail}`);
    }
  }

  async deleteVm(vm: RunnerVm): Promise<void> {
    // Fire and forget: the janitor re-lists next pass, so waiting on the operation buys nothing.
    await this.instances.delete({ project: this.project, zone: vm.zone, instance: vm.name });
  }

  async wasPreempted(vmName: string): Promise<boolean> {
    // GCE records a zonal operation when it reclaims a Spot VM (or kills it on a host error). The
    // operation outlives the VM, which our template deletes on preemption.
    const iter = this.globalOps.aggregatedListAsync({
      project: this.project,
      filter: '(operationType = "compute.instances.preempted") OR (operationType = "compute.instances.hostError")',
    });
    for await (const [, scoped] of iter) {
      for (const op of scoped.operations ?? []) {
        if (lastSegment(op.targetLink) === vmName) return true;
      }
    }
    return false;
  }
}
