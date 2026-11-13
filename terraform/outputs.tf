output "webhook_url" {
  description = "GitHub App webhook URL."
  value       = "${google_cloud_run_v2_service.scaler.uri}/webhook"
}

output "scaler_image_repository" {
  description = "Artifact Registry path scripts/deploy-scaler.sh pushes scaler images to."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.ci.repository_id}/ci-scaler"
}

output "instance_template" {
  description = "Instance template every runner VM is created from."
  value       = google_compute_instance_template.runner.self_link
}

output "image_builder_service_account" {
  description = "Service account the image build impersonates (build-image workflow input service_account)."
  value       = google_service_account.image_builder.email
}

output "workload_identity_provider" {
  description = "Workload identity provider for the image build (build-image workflow input workload_identity_provider)."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "subnetwork" {
  description = "Subnetwork for the Packer build VM (build-image workflow input subnetwork)."
  value       = google_compute_subnetwork.ci[var.region].self_link
}

output "scaler_service" {
  description = "Cloud Run service name of the scaler."
  value       = google_cloud_run_v2_service.scaler.name
}

output "workload_identity_pool_name" {
  description = "Full name of the GitHub workload identity pool (projects/<number>/locations/global/workloadIdentityPools/github-ci). Use it to let other workflows in github_repositories impersonate service accounts you define outside the module."
  value       = google_iam_workload_identity_pool.github.name
}
