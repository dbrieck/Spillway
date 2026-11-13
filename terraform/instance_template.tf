# The scaler creates every runner VM from this template and overrides name, labels, metadata
# (JIT config) and the scheduling block (Spot vs STANDARD, max_run_duration) per VM.
resource "google_compute_instance_template" "runner" {
  name_prefix  = "ci-runner-"
  description  = "Ephemeral GitHub Actions runner, pool ${var.pool_name} (one job per VM)"
  machine_type = var.machine_type
  tags         = ["ci-runner"]

  labels = {
    ci-runner = var.pool_name
  }

  disk {
    # A family link resolves to the newest image when each VM is created. Until the first runner
    # image is built (runner_image_available = false) the family may not exist and the provider
    # rejects it, so point at stock Ubuntu; scaler.tf forces MAX_RUNNERS=0 meanwhile, so no VM is
    # ever launched from the placeholder.
    source_image = (var.runner_image_available
      ? "projects/${var.project_id}/global/images/family/${var.image_family}"
    : "projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts")
    disk_size_gb = var.disk_size_gb
    disk_type    = "pd-balanced"
    boot         = true
    auto_delete  = true
  }

  network_interface {
    # Home-region subnet; the scaler overrides the NIC with the subnet of whichever region it places
    # each VM in.
    subnetwork = google_compute_subnetwork.ci[var.region].id
    # No access_config: no external IP (CIS 4.9). Egress goes through Cloud NAT.
  }

  service_account {
    email  = google_service_account.runner_vm.email
    scopes = ["cloud-platform"]
  }

  scheduling {
    provisioning_model          = "SPOT"
    preemptible                 = true
    automatic_restart           = false
    on_host_maintenance         = "TERMINATE"
    instance_termination_action = "DELETE"
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  # CIS 4.3 / 4.4. Per-VM metadata on an insert replaces this block, so the scaler merges it back
  # in and re-asserts both keys itself (scaler/src/compute.ts mergeRunnerMetadata).
  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
  }

  lifecycle {
    create_before_destroy = true
  }
}
