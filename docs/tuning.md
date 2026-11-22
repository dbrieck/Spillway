# Tuning

Every knob is a variable of the Terraform module, applied to the scaler as Cloud Run env by
`terraform apply`. Numbers below marked *measured* come from a production pool running a busy
monorepo's CI from September to November 2026; re-check prices and quotas for your own project before relying on them.

## Knobs

| Variable | Default | Meaning |
|---|---|---|
| `github_repositories` | (required) | Repositories whose jobs may use the runners |
| `pool_name` / `runner_name_prefix` | `spillway` / `<pool_name>-` | Label value and name prefix this install manages. Runners and VMs without them are never touched |
| `runner_labels` | `self-hosted`, `Linux`, `X64`, `gcp` | Labels each runner registers with. A job is eligible when all its `runs-on` labels are in this list |
| `allow_fork_prs` | false | Launch runners for fork PRs. Leave off unless you understand the risk |
| `runner_image_available` | false | Set true after the first image build. While false, nothing launches |
| `max_runners` | 6 | Cap on concurrent VMs. `0` pauses launches; cleanup keeps running |
| `burst_delay_seconds` | 10 | How long a job waits before a VM is launched: other self-hosted runners' head start. Jobs asking for a label only Spillway has (e.g. `gcp`) skip it |
| `low_priority_branches` / `low_priority_burst_delay_seconds` | none / 60 | Branches (e.g. `main`) whose jobs wait longer for another runner first. Only useful alongside another pool |
| `idle_timeout_seconds` | 300 | A VM that hasn't started a job in this long powers off |
| `max_run_seconds` | 14400 | GCE `max_run_duration`: GCE deletes the VM when it expires, whatever it's doing |
| `preemption_retries` | 1 | Automatic re-runs of a run whose job died with its preempted VM. `0` disables |
| `standard_workflows` | none | Workflow-name globs that get on-demand VMs instead of Spot |
| `machine_type` / `disk_size_gb` | `c3d-standard-8` / 80 | First-choice shape. Disks count against the regional `SSD_TOTAL_GB` quota |
| `fallback_machine_types` | `n2d`, `t2d`, `c2d`, `n2`, `e2` (`-standard-8`) | Tried after `machine_type` on a stockout or family quota. Every type is tried as Spot before any on-demand |
| `small_machine_types` / `small_runner_labels` | off / `self-hosted`, `Linux`, `gcp-small` | Small tier (below) |
| `runner_regions` / `zones` | 4 US regions / 13 zones | Where VMs may land. Each region gets a subnet and Cloud NAT |
| `enable_iap_ssh` | false | Allow SSH to runner VMs through IAP, for debugging |

## Choosing machine types

Order `machine_type` and `fallback_machine_types` by **preemption rate first, Spot price second**.
A preemption costs little VM time (only the failed job re-runs) but a lot of wall-clock: GitHub takes
about 9 minutes to notice the runner is gone, the run has to finish, then the job runs again.

*Measured:* PR runs that needed a re-run took a median 40 minutes against 18 without. `e2-standard-8`
was the cheapest family after `c3d` but was preempted on 62 of 130 launches in one zone over five
days, against 1–5% for `c3d`, so it is tried last. Keep fallbacks x86-64 with the same vCPU and
memory so jobs behave the same on any of them.

Spot prices move monthly and differ a lot by family; check the Cloud Billing catalog before reordering.

## The small tier

Jobs that don't need 8 vCPU / 32 GB can run on smaller VMs. A job opts in by asking only for labels
in `small_runner_labels`, e.g. `runs-on: [self-hosted, Linux]` (no `X64`). Its runner registers with
exactly those labels, so a small VM can never be handed a full-size job. With `small_machine_types`
empty, those jobs run on regular runners.

Size it from data: every VM logs its job's peak memory when the job ends.

```bash
gcloud logging read 'logName:"serialconsole" AND textPayload:"ci-runner: memory"' --project my-ci-project
```

## Quotas

Quotas usually cap the pool before `max_runners` does. A new project gets roughly:
`CPUS_ALL_REGIONS` = 32 (4 runners of 8 vCPU in total), `SSD_TOTAL_GB` = 500 per region (6 runners at
80 GB), and per-family CPU quotas around 16–24 per region. Raise them under *IAM & Admin → Quotas*.

When a quota blocks a launch, the scaler logs `quota exceeded` with the metric and scopes it:

- a family CPU quota (`N2D_CPUS`, ...) rules out that machine type in that region;
- any other regional quota (`SSD_TOTAL_GB`, `CPUS`, ...) rules out that region, and the launch moves on;
- a global quota (`CPUS_ALL_REGIONS`) stops the launch, which is retried later.

A finished VM's disk counts against `SSD_TOTAL_GB` until the janitor deletes it, which is why the
janitor runs every 2 minutes.

## Cost

*Measured,* two weeks in November 2026 (Nov 8 to 21) on the tuned pool: `c3d` Spot first, the small tier
on, no public IPs, everything going out through Cloud NAT. 11,900 VMs ran about 1,480 VM-hours, 80% of them
on `c3d-standard-4`, most of the rest on `c3d-standard-8`, 3% outside `us-central1`. From the Cloud
Billing report for the project:

| Item | Usage | Cost |
|---|---|---|
| Cloud NAT data processing | 2,921 GiB | $131 |
| Spot `c3d` vCPU and memory | 7,856 vCPU-hours | $86 |
| Persistent disks (80 GB `pd-balanced` each) | 205 GiB-months | $21 |
| Cloud Run (the scaler) | | $9 |
| Internet egress | 40 GiB | $5 |
| Cloud NAT gateway and everything else | | $6 |
| **Total** | | **$257, about $18 a day** |

The two weeks before, mostly before runners moved behind Cloud NAT, cost $97. Cloud Tasks and Cloud
Scheduler stayed within the free tier; Cloud Run did not at this volume.

**NAT data costs more than the VMs.** Each VM pulled about 250 MB through NAT: actions, checkouts,
artifacts, package restores and browser downloads. With no public IP, every byte from outside Google
pays NAT data processing, and at Spot prices that adds up faster than VM time. To bring it down:

- warm the package caches in the image (`examples/image-hooks/warm-*.sh`) and rebuild it weekly, so
  restores are mostly cache hits;
- bake large, slow-changing downloads (browsers, SDKs) into the toolchain hook instead of fetching them
  per job;
- keep artifacts passed between jobs small, or keep them in Cloud Storage: Google APIs go through
  Private Google Access, which NAT doesn't bill.

*Measured,* first week (late September 2026) on `n2` Spot, mostly with public IPs, before any of the tuning above:
413 VM-hours (about $96), $19 of Cloud NAT data and $5 of disks.

### Measuring your own pool

The Cloud Billing report, grouped by SKU and filtered to the project, is the source of truth. To see where
the usage comes from, or without access to billing, Cloud Monitoring has the usage and the Cloud Billing
catalog API has the prices (Compute Engine is service `6F81-5844-456A`; NAT is under Networking,
`E505-1604-58F8`). Priced that way, the two weeks above came within about 15% of the bill on each line.

- **VM-hours:** sum `compute.googleapis.com/instance/uptime` per instance, filtered to
  `metric.labels.instance_name=starts_with("<runner_name_prefix>")`, and join each instance to its
  `launched runner` log line for machine type, zone and provisioning model. Don't group the metric by
  `metadata.system_labels` or `metadata.user_labels`: for short-lived runner VMs many samples come
  without that metadata, and a grouped query silently drops them (half the hours or more, here).
- **NAT data:** sum `router.googleapis.com/nat/sent_bytes_count` and `nat/received_bytes_count` by
  region.
- **Spot prices** move monthly and differ a lot by family and region (in Nov 2026, Spot `c3d` cost
  about twice as much in `us-east4` as in `us-central1`). Pull them fresh before comparing.
