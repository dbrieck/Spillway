# Spillway

Scale-to-zero GitHub Actions runners on GCP Spot VMs. When a job queues, Spillway launches a VM that
registers as a just-in-time runner, runs that one job, and powers off. When nothing is queued, it runs
nothing.

> **Work in progress.** Extracted from a production setup that runs a real product's CI today. The
> scaler, Terraform module and image template are here; the write-up and decision records are next.

## How it works

```
GitHub App webhook (workflow_job: queued)
  → Cloud Run scaler /webhook     (HMAC-verified)
  → Cloud Tasks                   (short delay; task name = job id, so redeliveries dedupe)
  → scaler /reconcile             (OIDC) still queued? under the cap? from this repo, not a fork?
       → generate-jitconfig → instances.insert (Spot; zones and machine types in order; on-demand fallback)
VM: run one job (or idle timeout) → power off
Cloud Scheduler → scaler /janitor: delete finished VMs, remove orphaned runners, re-check missed jobs
```

What it handles:

- **Spot stockouts and quotas.** Tries each machine type across zones and regions. A quota rules out
  only what it covers (a machine family in a region, a region, or everything), then falls back to on-demand.
- **Preemption.** When a job dies with its preempted VM, Spillway re-runs that run's failed jobs, up to
  a limit. Genuine test failures are never re-run.
- **Passed-over jobs.** A JIT runner can take a different queued job than the one that launched it.
  Spillway notices and launches a replacement.
- **Priorities.** Post-merge branches can wait longer for other runners before bursting; a small tier
  serves jobs that don't need a full-size VM.
- **Fork PRs.** Refused by default (`ALLOW_FORK_PRS=false`): a fork's code would otherwise run on a VM
  inside your project.

Runners are registered per repository. Organization-level runners are not supported yet.

## Security

Runner VMs meet the CIS GCP Foundations controls for compute instances. The scaler builds the whole
VM request itself, so neither the instance template nor its own metadata can weaken them:

| CIS | Control | How |
|---|---|---|
| 4.1 / 4.2 | No default service account | A dedicated runner account that can only write logs and metrics |
| 4.3 / 4.4 | Block project-wide SSH keys, OS Login | Forced on after merging template and scaler metadata (per-VM metadata replaces the template's, so it is never left to the template) |
| 4.8 | Shielded VM | Secure boot, vTPM and integrity monitoring on every VM |
| 4.9 | No public IP | No external IPs at all: egress goes through Cloud NAT, inbound traffic is denied except IAP SSH when enabled |

The Packer build VM meets the same controls and logs in through OS Login over IAP. Each VM runs one
job and is deleted; the `runner` user has passwordless sudo, which is acceptable only because nothing
outlives the job. Jobs that need GCP authenticate with their own workload identity, not the VM's.

## What's here

| Path | What |
|---|---|
| `scaler/` | The Cloud Run service (TypeScript). Decision logic lives in `src/policy.ts`, all of it unit-tested |
| `terraform/` | Module: network (subnet + Cloud NAT per region, IAP-only ingress), service accounts, instance template, secrets, Cloud Run, Cloud Tasks, Scheduler, and workload identity for image builds |
| `image/` | Packer template: a generic base (actions/runner, one-job boot service) plus your toolchain hook |
| `examples/` | A root module using the Terraform module, and example image hooks |
| `.github/workflows/build-image.yml` | Reusable workflow that builds your image from your repository |
| `scripts/deploy-scaler.sh` | Tests, builds and rolls out a scaler version |

Start with [setup](docs/setup.md); [tuning](docs/tuning.md) covers the knobs, machine types, quotas and cost.

## Development

```bash
cd scaler && npm ci && npm test       # scaler unit tests
terraform fmt -check -recursive        # module + examples
packer validate -var project_id=x -var subnetwork=x image
```

## License

[Apache-2.0](LICENSE)
