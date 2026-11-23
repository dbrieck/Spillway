# ---- Runner VMs: no GCP access beyond shipping their own logs/metrics. Jobs that need GCP use WIF
#      (google-github-actions/auth) with their own identity.
resource "google_service_account" "runner_vm" {
  account_id   = "ci-runner-vm"
  display_name = "CI runner VM (ephemeral GitHub Actions runners)"
  depends_on   = [google_project_service.enabled]
}

resource "google_project_iam_member" "runner_vm" {
  for_each = toset(["roles/logging.logWriter", "roles/monitoring.metricWriter"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.runner_vm.email}"
}

# ---- Scaler (Cloud Run): creates/deletes runner VMs and enqueues reconcile tasks.
resource "google_service_account" "scaler" {
  account_id   = "ci-scaler"
  display_name = "CI burst scaler (Cloud Run)"
  depends_on   = [google_project_service.enabled]
}

# Instance lifecycle only, as a custom role: CIS 1.5 (Security Health Analytics ADMIN_SERVICE_ACCOUNT)
# flags a service account holding owner, editor or any role whose name contains "admin", and
# roles/compute.instanceAdmin.v1 is one. The list is what instances.insert from the template checks
# (the audit log's authorizationInfo), plus the reads the scaler makes.
resource "google_project_iam_custom_role" "scaler" {
  role_id     = "spillwayScaler"
  title       = "Spillway scaler"
  description = "Creates, lists and deletes Spillway runner VMs from the instance template."
  permissions = [
    "compute.disks.create",
    "compute.globalOperations.list", # preemption lookup (aggregated operations list)
    "compute.images.useReadOnly",
    "compute.instanceTemplates.get", # template metadata, merged into each VM's
    "compute.instanceTemplates.useReadOnly",
    "compute.instances.create",
    "compute.instances.delete",
    "compute.instances.get",
    "compute.instances.list",
    "compute.instances.setLabels",
    "compute.instances.setMetadata",
    "compute.instances.setServiceAccount",
    "compute.instances.setTags",
    "compute.subnetworks.use",
    "compute.zoneOperations.get",
  ]
  depends_on = [google_project_service.enabled]
}

# Keyed by role, so the predefined roles keep the state addresses earlier releases gave them. The
# custom role sits under a fixed key because its name is only known after apply.
locals {
  legacy_scaler_roles        = ["roles/compute.instanceAdmin.v1"]
  legacy_image_builder_roles = ["roles/compute.instanceAdmin.v1", "roles/compute.storageAdmin", "roles/compute.osAdminLogin"]

  scaler_roles = merge(
    {
      custom                      = google_project_iam_custom_role.scaler.name
      "roles/cloudtasks.enqueuer" = "roles/cloudtasks.enqueuer"
      "roles/logging.logWriter"   = "roles/logging.logWriter"
    },
    { for r in local.legacy_scaler_roles : r => r if var.keep_legacy_admin_roles },
  )
  image_builder_roles = merge(
    {
      custom                             = google_project_iam_custom_role.image_builder.name
      "roles/iap.tunnelResourceAccessor" = "roles/iap.tunnelResourceAccessor" # SSH to the build VM through IAP
    },
    { for r in local.legacy_image_builder_roles : r => r if var.keep_legacy_admin_roles },
  )
}

resource "google_project_iam_member" "scaler" {
  for_each = local.scaler_roles
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.scaler.email}"
}

# Attaching ci-runner-vm to the VMs it creates.
resource "google_service_account_iam_member" "scaler_uses_runner_vm" {
  service_account_id = google_service_account.runner_vm.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.scaler.email}"
}

# ---- Invoker: the identity whose OIDC token Cloud Tasks and Scheduler present to /reconcile and /janitor.
resource "google_service_account" "invoker" {
  account_id   = "ci-scaler-invoker"
  display_name = "CI scaler internal invoker (Cloud Tasks / Scheduler OIDC)"
  depends_on   = [google_project_service.enabled]
}

# The scaler creates tasks that carry the invoker's OIDC token (actAs).
resource "google_service_account_iam_member" "scaler_acts_as_invoker" {
  service_account_id = google_service_account.invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.scaler.email}"
}

# ---- Image builder: Packer on a GitHub-hosted runner, authenticated keylessly via WIF.
resource "google_service_account" "image_builder" {
  account_id   = "ci-image-builder"
  display_name = "CI runner image builder (Packer via GitHub WIF)"
  depends_on   = [google_project_service.enabled]
}

# Packer's temporary build VM, image capture and old-image pruning, as a custom role instead of
# compute.instanceAdmin.v1 + compute.storageAdmin + compute.osAdminLogin (CIS 1.5, see the scaler's role).
# The build VM has no service account, but instances.insert still checks setServiceAccount.
resource "google_project_iam_custom_role" "image_builder" {
  role_id     = "spillwayImageBuilder"
  title       = "Spillway image builder"
  description = "Runs the Packer build VM, captures the runner image and prunes old images."
  permissions = [
    "compute.disks.create",
    "compute.disks.delete",
    "compute.disks.get",
    "compute.disks.useReadOnly", # image from the build VM's disk
    "compute.globalOperations.get",
    "compute.images.create",
    "compute.images.delete", # Packer's cleanup and pruning old images in the family
    "compute.images.get",
    "compute.images.getFromFamily",
    "compute.images.list",
    "compute.images.setLabels",
    "compute.images.useReadOnly",
    "compute.instances.create",
    "compute.instances.delete",
    "compute.instances.get",
    "compute.instances.getSerialPortOutput",
    "compute.instances.list",
    "compute.instances.osAdminLogin", # OS Login with sudo on the build VM
    "compute.instances.osLogin",
    "compute.instances.setLabels",
    "compute.instances.setMetadata",
    "compute.instances.setServiceAccount",
    "compute.instances.setTags",
    "compute.instances.stop",
    "compute.machineTypes.get",
    "compute.projects.get",
    "compute.subnetworks.get",
    "compute.subnetworks.use",
    "compute.zoneOperations.get",
    "compute.zones.get",
  ]
  depends_on = [google_project_service.enabled]
}

resource "google_project_iam_member" "image_builder" {
  for_each = local.image_builder_roles
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.image_builder.email}"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-ci"
  display_name              = "GitHub Actions (CI runners)"
  depends_on                = [google_project_service.enabled]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  attribute_condition = "assertion.repository in [${join(", ", [for r in var.github_repositories : "'${r}'"])}]"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "image_builder_wif" {
  for_each           = toset(var.github_repositories)
  service_account_id = google_service_account.image_builder.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${each.value}"
}
