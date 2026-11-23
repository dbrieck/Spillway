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

NAT data costs more than the VMs; [Cloud NAT data](#cloud-nat-data) below says where it comes from
and how to cut it.

*Measured,* first week (late September 2026) on `n2` Spot, mostly with public IPs, before any of the tuning above:
413 VM-hours (about $96), $19 of Cloud NAT data and $5 of disks. The knobs above were tuned after that week.

### Cloud NAT data

Runner VMs have no public IP, so everything a job downloads from the internet goes through Cloud NAT,
which bills $0.045 per GiB processed. Google APIs and Cloud Storage don't count: the subnet has Private
Google Access. On the pool above NAT data cost more than the VMs: 282 MB per VM over the two weeks,
almost all of it things every job downloaded again:

| What | Per job | Fix |
| --- | --- | --- |
| `actions/checkout` of the whole tree | ~95 MB | `seed_workspace` (on by default): ~11 MB with a week-old image |
| Actions themselves (checkout, setup-*, upload-artifact...) | ~10 MB | `action_archives` (on by default) |
| `setup-dotnet`'s extra LTS runtime, `setup-java`, `setup-python`, Playwright browsers, servers fetched by URL | 30-350 MB | Install them in the toolchain hook at the versions your workflows ask for |
| Package restores (npm, NuGet, pip) | varies | Warm the caches in the warm-cache hook |
| `fetch-depth: 0` | the whole history | Fetch only the commits the job needs |

The seed and the warm caches age with the image: a job fetches everything that changed since the
build. A daily image build keeps that small; the example in [setup](setup.md#6-build-the-first-image)
runs one.

To find your own per-VM figure:

```sh
node scripts/nat-bytes.mjs --project my-ci-project --start 2026-11-20T00:00:00Z --end 2026-11-22T00:00:00Z
```

It divides the NAT gateways' received bytes by the number of VMs the scaler launched. To see which job
pulls what, group `compute.googleapis.com/instance/network/received_bytes_count` by instance name and
match each instance to the job that ran on it (the Actions API's `runner_name`; the job id in a VM's
name is the job that triggered the launch, which may not be the one it ran).

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
  region, or run `scripts/nat-bytes.mjs` (above) for a per-VM figure.
- **Spot prices** move monthly and differ a lot by family and region (in Nov 2026, Spot `c3d` cost
  about twice as much in `us-east4` as in `us-central1`). Pull them fresh before comparing.
