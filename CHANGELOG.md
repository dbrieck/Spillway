# Changelog

Releases are tagged `vMAJOR.MINOR.PATCH`. Pin the commit SHA, not the tag ([upgrading](docs/upgrading.md)).

## Unreleased

- Docs: an [operations guide](docs/operations.md) (checking the pool, pausing and draining,
  troubleshooting, debugging a VM, canarying a scaler version), [upgrading](docs/upgrading.md), and this
  changelog. Upgrading covers adopting an existing install with `moved` or `import` blocks.
- `scripts/deploy-scaler.sh` refuses to build when `EXPECTED_COMMIT` is set and the checkout is at a
  different commit.
- `scripts/runner-speed.mjs` compares job run times on Spillway runners with your other self-hosted
  runners.
- Examples: `warm-nuget.sh` (NuGet cache warming), `pack-sources.sh` (a source snapshot that includes
  submodules) and `check-pins.sh` (a CI check that the image's toolchain matches the repository).

## v0.1.1 (2026-11-19)

Commit `ea33603aafacdd6a9d200d22d36c40bff3b61a0e`.

- Terraform: the scaler's Cloud Run service no longer shows a `scaling` diff on every plan. The
  service-level block the API returns is now in `ignore_changes`; instance limits still come from
  `template.scaling`.
- Scaler: `engines` is `>=22`, so npm no longer warns on Node 24. The container still runs Node 22.
- Scaler: repository names are lowercase in task bodies and in the `reconcile decision`, `rerun decision`
  and related logs, whichever path queued the job.

Upgrade notes: no Terraform changes beyond the ignored block. Redeploy the scaler for the logging change.

## v0.1.0 (2026-11-17)

Commit `cb32ce301d027b6658dba11918772eb360c7fb1c`. First release: the scaler, the Terraform module, the
Packer image template and the reusable image workflow.
