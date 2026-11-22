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
