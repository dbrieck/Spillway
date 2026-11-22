# Operations

Day-to-day running of a Spillway pool: checking it works, pausing it, debugging a runner and rolling
out a new scaler version. The commands use `my-ci-project` and `us-central1` (the module's `region`)
and the default `pool_name` of `spillway`; substitute your own.

The names below are fixed by the Terraform module: the Cloud Run service `ci-scaler`, the Cloud Tasks
queue `ci-reconcile`, the Cloud Scheduler job `ci-scaler-janitor` and the network `ci-runners`. Every VM
the scaler launches carries the label `ci-runner=<pool_name>`, and every runner it registers is named
`<runner_name_prefix><jobId>-<suffix>`.

## Is it working?

- **Webhook deliveries.** In the GitHub App, open *Advanced → Recent Deliveries* and read both the
  status and the body. `202` means `scheduled`, `duplicate` (a redelivery of a job already scheduled)
  or `rerun-check-scheduled`. `200` covers `pong`, `paused` and every `ignored` reason (wrong event,
  labels not eligible, repository not allowed). An accepted delivery doesn't prove a VM launched.
- **Scaler decisions.**

  ```bash
  gcloud logging read 'resource.labels.service_name="ci-scaler"' --project my-ci-project --limit 50 \
    --format='value(timestamp,jsonPayload.message,jsonPayload.decision.kind,jsonPayload.jobId)'
  ```

  `reconcile decision` lines carry one of `launch`, `pending` (the job's VM is still booting),
  `at-capacity`, `not-queued` (another runner took the job, or it was cancelled) or `paused`.
  `launched runner`, `zone stockout`, `quota exceeded` and `launch failed` follow a `launch`.
- **Live VMs.**
  `gcloud compute instances list --project my-ci-project --filter='labels.ci-runner=spillway'`
- **Registered runners.** The repository's *Settings → Actions → Runners*. A runner shows there from the
  moment its VM boots until the janitor removes it.

## Pause, resume, drain

- **Pause launches.** Set `max_runners = 0` and run `terraform apply`. VMs already running finish
  their jobs. The janitor keeps deleting finished VMs and stops re-checking queued jobs.
- **Quick pause without Terraform.**
  `gcloud run services update ci-scaler --project my-ci-project --region us-central1 --update-env-vars MAX_RUNNERS=0`.
  The next `terraform apply` puts the configured value back, which is also how you resume.
- **Drain now.** Pause, then delete the VMs. Any job running on them fails and has to be re-run.

  ```bash
  gcloud compute instances list --project my-ci-project --filter='labels.ci-runner=spillway' \
    --format='value(name,zone)' | while read -r name zone; do
    gcloud compute instances delete "$name" --zone "$zone" --project my-ci-project --quiet
  done
  ```

- **Stop everything.** Pause and drain, then pause the janitor and the queue:
  `gcloud scheduler jobs pause ci-scaler-janitor --project my-ci-project --location us-central1` and
  `gcloud tasks queues pause ci-reconcile --project my-ci-project --location us-central1`.
  Resume both before turning launches back on.

Check one thing before pausing. A job whose `runs-on` asks for a label only Spillway runners have
(`gcp`, `gcp-small`) has nowhere else to go, so it stays queued until launches resume, and every job
that `needs:` it waits too. If a workflow has such a job on its critical path, give it a way to run
elsewhere (a repository variable that switches its `runs-on`, or skips it) before you pause.

## How runners pick up jobs

Two things surprise people the first time:

- **A runner takes any queued job its labels match,** not only the job it was launched for. GitHub
  hands a just-in-time runner whatever matching job is next in line. The scaler accounts for it: when
  the launched-for job is still queued while its VM is busy with another one, the next reconcile
  launches a replacement. Logs that show job A's VM running job B are normal.
- **Preemption looks like a failure first.** When GCE reclaims a Spot VM mid-job, the job fails with
  "The self-hosted runner lost communication with the server", about 9 minutes later, once GitHub
  gives up on the runner. After the run finishes, the scaler checks that the VM was really preempted
  and re-runs the run's failed jobs (`re-ran failed jobs after preemption`), up to
  `preemption_retries` times. Test failures on a VM that wasn't preempted are never re-run. If one
  workflow is hit often, add it to `standard_workflows`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Jobs stay queued | Deliveries return `202 scheduled`. The scaler logs show `reconcile decision` with `launch`, or `reconcile skipped fork` for a fork PR. `MAX_RUNNERS` is above 0. `runner_image_available` is true. The `ci-reconcile` queue isn't paused. No `quota exceeded` lines |
| `quota exceeded` | The line names the metric and the region. See [tuning](tuning.md#quotas) |
| `zone stockout` on every zone | Spot capacity is short for every machine type; the task retries on its own, and on-demand is tried after Spot. Add fallback machine types or regions if it lasts |
| `launch failed` with neither stockout nor quota | Usually no image exists yet in the image family, or an IAM change. Check the scaler account's roles in `terraform/iam.tf` |
| A VM starts but never registers | Read its serial console (below). Look for a missing `runner-jitconfig` key, no route to github.com through Cloud NAT, or a JIT config that expired because the VM took very long to boot |
| Restores time out only on Spillway runners | Cloud NAT port exhaustion. Look for `OUT_OF_RESOURCES` in the `ci-runners` NAT logs |
| A job fails with tool errors only on Spillway runners | The image's toolchain drifted from what the workflow expects. See `examples/image-hooks/check-pins.sh` for a CI check that catches it |
| Offline runners pile up under *Settings → Actions → Runners* | The janitor isn't running. Check the last run of `ci-scaler-janitor` and its `janitor` log lines |
| The scaler crashes with `Missing required env var` | A `gcloud run deploy` created a bare `ci-scaler` service. Delete it and run `terraform apply` |

## Debugging a runner VM

The VM writes its boot and job lifecycle to the serial console with a `ci-runner:` prefix, including
why it powered off:

```bash
gcloud compute instances get-serial-port-output <vm> --zone <zone> --project my-ci-project | grep ci-runner
```

The same lines land in Cloud Logging, so they outlive the VM:
`gcloud logging read 'logName:"serialconsole" AND textPayload:"ci-runner:"' --project my-ci-project`.

With `enable_iap_ssh = true` you can SSH in through IAP and OS Login while the VM is up (until its job
ends, or `idle_timeout_seconds` if none starts):

```bash
gcloud compute ssh <vm> --zone <zone> --project my-ci-project --tunnel-through-iap
```

The runner's own logs are in `/actions-runner/_diag/`.

To check a VM meets the [security controls](../README.md#security):

```bash
gcloud compute instances describe <vm> --zone <zone> --project my-ci-project \
  --format='yaml(metadata.items[].key,networkInterfaces[].accessConfigs,shieldedInstanceConfig,serviceAccounts[].email)'
```

Expect `enable-oslogin` and `block-project-ssh-keys` among the metadata keys, no `accessConfigs`, all
three shielded flags `true`, and the `ci-runner-vm@` service account.

## Rolling out a new scaler version

`scripts/deploy-scaler.sh` replaces the running scaler in one step. To canary it on a single VM first:

1. **Note the rollback point.**
   `gcloud run revisions list --service ci-scaler --project my-ci-project --region us-central1 --limit 3`.
   The one serving traffic is `PREV`.
2. **Cap the pool at one VM** and deploy:

   ```bash
   gcloud run services update ci-scaler --project my-ci-project --region us-central1 --update-env-vars MAX_RUNNERS=1
   scripts/deploy-scaler.sh my-ci-project
   ```

3. **Trigger a job only Spillway can take** (`runs-on` with `gcp` or `gcp-small`) and check that its VM
   registers, passes the `describe` check above and finishes the job. Your own CI may launch the canary
   VM before you get to it, which is fine. If the VM is preempted mid-job, judge the canary on the next
   one.
4. **Restore the cap** with `terraform apply`.

Roll back with
`gcloud run services update-traffic ci-scaler --project my-ci-project --region us-central1 --to-revisions PREV=100`.

Terraform ignores the scaler's image, so `terraform apply` never rolls a deploy back. It does put back
any env you changed by hand, which is what step 4 relies on.

## The runner image

- **Rebuild it weekly** (the setup's example workflow runs every Monday) to pick up the latest
  actions/runner, OS patches and fresh package caches. The reusable workflow keeps the newest few images
  (`keep_images`).
- **Bump the toolchain hook with the project.** When the repository moves to a new SDK or tool version,
  change the hook in the same pull request and rebuild the image after merging.
- **Roll back a bad image** by deprecating it; the image family then resolves to the previous one:
  `gcloud compute images deprecate <image> --project my-ci-project --state DEPRECATED`.
  Runners already running are unaffected.
