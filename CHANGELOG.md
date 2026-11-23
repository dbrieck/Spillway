# Changelog

Releases are tagged `vMAJOR.MINOR.PATCH`. Pin the commit SHA, not the tag ([upgrading](docs/upgrading.md)).

## Unreleased

- CIS GCP 1.5: the scaler and the image builder get custom roles (`spillwayScaler`,
  `spillwayImageBuilder`) instead of `compute.instanceAdmin.v1`, `compute.storageAdmin` and
  `compute.osAdminLogin`. Security Health Analytics reports ADMIN_SERVICE_ACCOUNT for any service
  account holding a role with "admin" in its name. The permission lists come from 30 days of audit logs
  (`authorizationInfo`) for both accounts plus the reads in the code.
- CIS GCP 3.8: VPC Flow Logs on the runner subnets. New variables `enable_flow_logs` (true),
  `flow_log_sampling` (0.1) and `flow_log_aggregation_interval` (`INTERVAL_5_MIN`), set low because flow
  logs bill by volume.
- CIS GCP 2.12: a Cloud DNS server policy with query logging on the runner network
  (`ci-runners-dns-logging`), and `dns.googleapis.com` in the enabled services. `enable_dns_logging`
  (true) turns it off if you manage the network's server policy yourself.
- `keep_legacy_admin_roles` (false): an upgrade aid that keeps the old predefined roles next to the
  custom ones for one apply.
- Docs: an [operations guide](docs/operations.md) (checking the pool, pausing and draining,
  troubleshooting, debugging a VM, canarying a scaler version), [upgrading](docs/upgrading.md), and this
  changelog. Upgrading covers adopting an existing install with `moved` or `import` blocks.
- `scripts/deploy-scaler.sh` refuses to build when `EXPECTED_COMMIT` is set and the checkout is at a
  different commit.
- Tuning: measured cost of two weeks on the tuned pool, where Cloud NAT data outweighs VM time, and
  how to measure your own pool without a billing export.
- `scripts/runner-speed.mjs` compares job run times on Spillway runners with your other self-hosted
  runners.
- Examples: `warm-nuget.sh` (NuGet cache warming), `pack-sources.sh` (a source snapshot that includes
  submodules) and `check-pins.sh` (a CI check that the image's toolchain matches the repository).

## v0.2.1 (2026-11-22)

Commit `4f03e460c28e3a2d5f03f3346474f335c30d6231`.

- Image: the workspace seed is extracted with root ownership, so git no longer refuses to fetch from it
  (`detected dubious ownership`) and the v0.2.0 image build passes. A failed seed now warns instead of
  failing the build.

Upgrade notes: move the image workflow pins to v0.2.1 and run an image build. No Terraform or scaler
changes.

## v0.2.0 (2026-11-22)

Commit `f561c81b0701b7cd7b58f2ede7b4427165d67b25`.

- Image: `build-image.yml` has two new inputs, both on by default. `seed_workspace` puts a depth-1
  clone of the built commit in the runner's job workspace, so `actions/checkout` fetches only what
  changed since the image. `action_archives` bakes the actions your workflows use into the runner's
  action archive cache.
- Scripts: `scripts/nat-bytes.mjs` reports NAT bytes per launched VM for a time window.
- Docs: a Cloud NAT section in `docs/tuning.md`; the setup example builds the image daily.

Upgrade notes: move the image workflow pins to v0.2.0 and run an image build. No Terraform or scaler
changes. Set `seed_workspace: false` and `action_archives: false` to keep the old behaviour.

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
