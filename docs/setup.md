# Setup

One-time setup for a Spillway pool. You need `gcloud` (authenticated as a project owner),
Terraform ≥ 1.6, Docker and Node 22. Allow about an hour, most of it the first image build.

## 1. A dedicated project and a state bucket

A project of its own keeps CI's blast radius and billing away from production.

```bash
gcloud projects create my-ci-project
gcloud billing projects link my-ci-project --billing-account=<ACCOUNT_ID>
gcloud storage buckets create gs://my-ci-project-tfstate --project my-ci-project \
  --location us-central1 --uniform-bucket-level-access
gcloud storage buckets update gs://my-ci-project-tfstate --versioning
```

## 2. A GitHub App

Settings → Developer settings → GitHub Apps → New GitHub App:

- **Repository permissions:** *Actions: Read & write* (re-runs jobs killed by Spot preemption) and
  *Administration: Read & write* (registers and removes the runners).
- **Subscribe to events:** *Workflow job*.
- **Webhook:** leave a placeholder URL for now (step 5) and set a random secret.
- Generate a private key, then install the app on the repositories that will use the runners.

## 3. Terraform

Copy `examples/basic` into your own infrastructure repository and point its `source` at a release:
`git::https://github.com/dbrieck/spillway.git//terraform?ref=<tag>`. Then create the secrets first,
because the Cloud Run service reads both at startup:

```bash
cp terraform.tfvars.example terraform.tfvars        # project_id, github_app_id, github_repositories
terraform init -backend-config="bucket=my-ci-project-tfstate"
terraform apply -target=module.spillway.google_secret_manager_secret.github_app_private_key \
                -target=module.spillway.google_secret_manager_secret.github_webhook_secret
gcloud secrets versions add ci-github-app-private-key --project my-ci-project --data-file=app.private-key.pem
printf '%s' '<webhook secret>' | gcloud secrets versions add ci-github-webhook-secret --project my-ci-project --data-file=-
terraform apply
```

Secret values never pass through Terraform, so they never land in its state.

## 4. Deploy the scaler

From a Spillway checkout at the same release:

```bash
scripts/deploy-scaler.sh my-ci-project
```

Terraform created the Cloud Run service with a placeholder image; this builds, tests and rolls out the
real one. Run it again to ship a new scaler version.

## 5. Point the app's webhook at the scaler

Set the app's webhook URL to `terraform output -raw webhook_url`. Under *Advanced → Recent
Deliveries*, the ping should show `200`.

## 6. Build the first image

Write a toolchain hook for what your jobs need (see `examples/image-hooks/`), then call the reusable
workflow from your repository with the values from `terraform output image_build`:

```yaml
name: runner image
on:
  schedule: [{ cron: "17 7 * * 1" }] # weekly: fresh actions/runner and apt packages
  workflow_dispatch:
jobs:
  image:
    uses: dbrieck/spillway/.github/workflows/build-image.yml@<tag>
    permissions: { contents: read, id-token: write }
    with:
      spillway_ref: <tag>
      project_id: my-ci-project
      workload_identity_provider: ${{ vars.SPILLWAY_WIF_PROVIDER }}
      service_account: ${{ vars.SPILLWAY_IMAGE_SA }}
      subnetwork: ${{ vars.SPILLWAY_SUBNETWORK }}
      toolchain_script: ci/runner-toolchain.sh
```

The build takes 10–40 minutes depending on the toolchain. Only repositories in
`github_repositories` can authenticate to build images.

## 7. Turn launches on

Until an image exists, the instance template points at stock Ubuntu and the scaler launches nothing.
Set `runner_image_available = true` and run `terraform apply`.

## 8. Use the runners

Any job whose `runs-on` labels are all among the runners' labels is eligible:

```yaml
runs-on: [self-hosted, Linux, X64, gcp]
```

With the default labels, `runs-on: [self-hosted, Linux, X64]` is eligible too, so if you already have
self-hosted runners with those labels, they get first pick and Spillway takes the overflow after
`burst_delay_seconds`. Ask for `gcp` to run only on Spillway.

Pull requests from forks never get a runner unless you set `allow_fork_prs = true`.

## If something is off

[Operations](operations.md) has the full troubleshooting table, pausing and draining, and how to debug a
runner VM. The two most common first-day problems:

- **The scaler crashes with `Missing required env var`:** a `gcloud run deploy` created a bare
  `ci-scaler` service. Delete it (`gcloud run services delete ci-scaler`) and run `terraform apply`.
- **Jobs stay queued:** check the scaler's logs in Cloud Run for `reconcile decision` and
  `launch failed`. A `quota exceeded` line names the quota to raise; see [tuning](tuning.md#quotas).
