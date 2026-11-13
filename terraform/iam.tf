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

resource "google_project_iam_member" "scaler" {
  for_each = toset(["roles/compute.instanceAdmin.v1", "roles/cloudtasks.enqueuer", "roles/logging.logWriter"])
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

resource "google_project_iam_member" "image_builder" {
  for_each = toset([
    "roles/compute.instanceAdmin.v1",   # temporary build VM
    "roles/compute.storageAdmin",       # create images, prune old ones
    "roles/iap.tunnelResourceAccessor", # SSH to the build VM through IAP
    "roles/compute.osAdminLogin",       # OS Login (use_os_login): Packer's key + sudo on the build VM
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.image_builder.email}"
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
