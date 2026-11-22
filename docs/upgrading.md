# Upgrading

A Spillway release is used in three places, and all three should point at the same commit:

| Where | What to change |
|---|---|
| Your root module | `?ref=` in the module `source`: `git::https://github.com/dbrieck/spillway.git//terraform?ref=<sha>` |
| Your image workflow | `uses: dbrieck/spillway/.github/workflows/build-image.yml@<sha>` and its `spillway_ref: <sha>` input |
| The scaler deploy | The Spillway checkout you run `scripts/deploy-scaler.sh` from |

## Pin the commit, not the tag

Tags can be moved; commits can't. Pin the release's full commit SHA and keep the tag in a comment,
the same way you would pin a third-party action:

```hcl
# v0.1.1
source = "git::https://github.com/dbrieck/spillway.git//terraform?ref=ea33603aafacdd6a9d200d22d36c40bff3b61a0e"
```

Look the SHA up with `git ls-remote https://github.com/dbrieck/spillway.git refs/tags/<tag>`, and
check it against the [release page](https://github.com/dbrieck/spillway/releases). When you deploy the
scaler, pass the same SHA so the script refuses to build anything else:

```bash
git clone --branch <tag> https://github.com/dbrieck/spillway.git && cd spillway
EXPECTED_COMMIT=<sha> scripts/deploy-scaler.sh my-ci-project
```

## Steps

Bump all three pins in one pull request in your infrastructure repository, then:

1. Read [CHANGELOG.md](../CHANGELOG.md) for the release, especially anything under *Upgrade notes*.
2. `terraform init -upgrade`, then `terraform plan -out=plan.tfplan`. Read the plan. A release with no
   Terraform changes should show none; anything that replaces the network, the service accounts or the
   Cloud Run service deserves a second look.
3. `terraform apply plan.tfplan`.
4. Deploy the scaler from the pinned checkout. To try it on one VM first, follow the canary in
   [operations](operations.md#rolling-out-a-new-scaler-version).
5. If the release changed anything under `image/`, run your image workflow once instead of waiting for
   the weekly build.

## Rolling back

Put the three pins back and apply. Roll the scaler back to its previous Cloud Run revision with
`gcloud run services update-traffic ci-scaler --to-revisions <revision>=100` rather than redeploying,
and deprecate a bad image so its family resolves to the previous one (see
[operations](operations.md#the-runner-image)).

## Adopting an existing install

If you already run your own version of this stack (a scaler, runner VMs, Terraform for them) and want
to move onto the module without a gap in CI, adopt the live resources instead of recreating them.

**Keep the pool's identity.** Set `pool_name` to the value of the label your VMs already carry under
`ci-runner`, and `runner_name_prefix` to the prefix your runners are already named with. The janitor
only touches VMs and runners that match both, so a different value would leave every live VM and runner
registration orphaned.

**Same Terraform state, resources at root addresses:** add a `moved` block per resource in your root
module, next to the module call. One block moves a resource with all its `for_each` instances:

```hcl
moved {
  from = google_cloud_run_v2_service.scaler
  to   = module.spillway.google_cloud_run_v2_service.scaler
}

moved {
  from = google_compute_subnetwork.ci
  to   = module.spillway.google_compute_subnetwork.ci
}
```

`terraform state list` shows your current addresses; the module's are the `resource` blocks under
`terraform/`. Your own resource names won't always match the module's, so map each one.

**Created by hand, or in another state:** use `import` blocks instead, one per instance. Import IDs are
in each resource's page of the Google provider docs:

```hcl
import {
  to = module.spillway.google_cloud_run_v2_service.scaler
  id = "projects/my-ci-project/locations/us-central1/services/ci-scaler"
}
```

The module's resource names are fixed (the service `ci-scaler`, the queue `ci-reconcile`, the network
`ci-runners`, the service accounts `ci-scaler`, `ci-runner-vm`, `ci-scaler-invoker` and
`ci-image-builder`, and so on). Anything of yours with a different name is created fresh next to the
old one, which is fine for most resources but not for the GitHub App's webhook URL: the scaler's URL
changes if the service is new, so update the app afterwards.

Then:

1. `terraform plan -out=plan.tfplan` and read it. It should list moves or imports and in-place updates,
   and no destroy of the network, the Cloud Run service, the queue or the secrets. A destroy there means
   a missing `moved` or `import` block or an address that doesn't match.
2. Apply the plan, then deploy the scaler from the pinned release.
3. Canary it as in [operations](operations.md#rolling-out-a-new-scaler-version) before restoring
   `max_runners`.
4. Once applied, the `moved` and `import` blocks can be deleted.
