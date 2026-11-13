# Secret containers only: load the values out-of-band so they never touch Terraform state.
#   gcloud secrets versions add ci-github-app-private-key --data-file=app.private-key.pem
#   printf '%s' "$WEBHOOK_SECRET" | gcloud secrets versions add ci-github-webhook-secret --data-file=-
resource "google_secret_manager_secret" "github_app_private_key" {
  secret_id = "ci-github-app-private-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret" "github_webhook_secret" {
  secret_id = "ci-github-webhook-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "scaler" {
  for_each = {
    key     = google_secret_manager_secret.github_app_private_key.id
    webhook = google_secret_manager_secret.github_webhook_secret.id
  }
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.scaler.email}"
}
