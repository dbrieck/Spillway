# Egress (GitHub, package registries, ...): runner VMs and the Packer build VM never get an external IP
# (CIS 4.9; the scaler sends no accessConfigs), so all of it goes through the regional Cloud NAT below,
# which covers every subnet in its region. Google APIs (Artifact Registry, Cloud Logging, GCS) go over
# Private Google Access instead and are not billed as NAT data.
# A VPC is global, so each runner region only adds a subnet plus a Cloud Router + NAT (both regional).
# Firewall rules are global and apply by network tag, so they need nothing per region.

resource "google_compute_network" "ci" {
  name                    = "ci-runners"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.enabled]
}

resource "google_compute_subnetwork" "ci" {
  for_each = var.runner_regions

  # The scaler derives this name from each VM's zone (SUBNETWORK_PREFIX + region); keep them in sync.
  name                     = "ci-runners-${each.key}"
  region                   = each.key
  network                  = google_compute_network.ci.id
  ip_cidr_range            = each.value
  private_ip_google_access = true

  # CIS 3.8. Runner traffic is heavy (package restores, checkouts) and flow logs bill by volume, so the
  # defaults sample 10% of flows over 5-minute windows without metadata. See docs/tuning.md.
  dynamic "log_config" {
    for_each = var.enable_flow_logs ? [1] : []
    content {
      aggregation_interval = var.flow_log_aggregation_interval
      flow_sampling        = var.flow_log_sampling
      metadata             = "EXCLUDE_ALL_METADATA"
    }
  }
}

# CIS 2.12: log the runner network's DNS queries. Logged queries are billed as Cloud Logging ingestion.
resource "google_dns_policy" "ci" {
  count          = var.enable_dns_logging ? 1 : 0
  name           = "ci-runners-dns-logging"
  enable_logging = true

  networks {
    network_url = google_compute_network.ci.id
  }

  depends_on = [google_project_service.enabled]
}

resource "google_compute_router" "ci" {
  for_each = var.runner_regions

  name    = "ci-runners"
  region  = each.key
  network = google_compute_network.ci.id
}

resource "google_compute_router_nat" "ci" {
  for_each = var.runner_regions

  name                               = "ci-runners"
  router                             = google_compute_router.ci[each.key].name
  region                             = each.key
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
  # Package restores (npm, NuGet, ...) open many parallel connections; the 64-port default starves quickly.
  min_ports_per_vm = 1024

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# No ingress rule other than IAP: the implied deny-all covers everything else.
resource "google_compute_firewall" "iap_ssh_runners" {
  count         = var.enable_iap_ssh ? 1 : 0
  name          = "ci-runners-allow-iap-ssh"
  network       = google_compute_network.ci.id
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["ci-runner"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# Packer reaches its temporary build VM over IAP (the builder runs on a GitHub-hosted runner).
resource "google_compute_firewall" "iap_ssh_image_build" {
  name          = "ci-runners-allow-iap-ssh-image-build"
  network       = google_compute_network.ci.id
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["ci-image-build"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
