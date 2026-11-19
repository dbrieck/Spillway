locals {
  oidc_audience = "ci-scaler"
  env = {
    GITHUB_APP_ID                    = var.github_app_id
    ALLOWED_REPOS                    = join(",", var.github_repositories)
    RUNNER_LABELS                    = join(",", var.runner_labels)
    POOL_NAME                        = var.pool_name
    RUNNER_NAME_PREFIX               = var.runner_name_prefix
    ALLOW_FORK_PRS                   = tostring(var.allow_fork_prs)
    GCP_PROJECT                      = var.project_id
    GCP_ZONES                        = join(",", var.zones)
    SUBNETWORK_PREFIX                = "ci-runners-"
    INSTANCE_TEMPLATE                = google_compute_instance_template.runner.self_link
    MACHINE_TYPES                    = join(",", concat([var.machine_type], var.fallback_machine_types))
    MAX_RUNNERS                      = tostring(var.runner_image_available ? var.max_runners : 0)
    BURST_DELAY_SECONDS              = tostring(var.burst_delay_seconds)
    LOW_PRIORITY_BRANCHES            = join(",", var.low_priority_branches)
    LOW_PRIORITY_BURST_DELAY_SECONDS = tostring(var.low_priority_burst_delay_seconds)
    SMALL_RUNNER_LABELS              = join(",", var.small_runner_labels)
    SMALL_MACHINE_TYPES              = join(",", var.small_machine_types)
    RUNNER_SERVICE_ACCOUNT           = google_service_account.runner_vm.email
    IDLE_TIMEOUT_SECONDS             = tostring(var.idle_timeout_seconds)
    MAX_RUN_SECONDS                  = tostring(var.max_run_seconds)
    STANDARD_WORKFLOWS               = join(",", var.standard_workflows)
    SPOT_FALLBACK_TO_STANDARD        = "true"
    PREEMPTION_RETRIES               = tostring(var.preemption_retries)
    TASKS_QUEUE                      = google_cloud_tasks_queue.reconcile.id
    INVOKER_SERVICE_ACCOUNT          = google_service_account.invoker.email
    OIDC_AUDIENCE                    = local.oidc_audience
  }
}

resource "google_artifact_registry_repository" "ci" {
  location      = var.region
  repository_id = "ci-runners"
  format        = "DOCKER"
  description   = "Spillway scaler images"

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s" # 30 days
    }
  }
  depends_on = [google_project_service.enabled]
}

# A launch takes ~10 s (it waits for the insert to succeed or report a stockout), so one dispatch at a
# time made the 17th job of a 17-job run wait ~3 min, and one slow multi-region stockout sweep stalled
# every launch behind it. Four at a time keeps a full run's launches under a minute. The capacity
# check is no longer serialized, so max_runners can be overshot by up to 3 VMs; the regional quotas
# are the hard cap. Non-2xx (pending, at capacity, stockout, quota) is retried with backoff for up
# to an hour; "pending" retries are what re-check a job whose VM is still booting.
resource "google_cloud_tasks_queue" "reconcile" {
  name     = "ci-reconcile"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 4
    max_dispatches_per_second = 5
  }

  retry_config {
    max_attempts       = -1
    max_retry_duration = "3600s"
    min_backoff        = "20s"
    max_backoff        = "120s"
    max_doublings      = 2
  }
  depends_on = [google_project_service.enabled]
}

resource "google_cloud_run_v2_service" "scaler" {
  name                = "ci-scaler"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL" # GitHub must reach /webhook; internal routes check OIDC in-app
  deletion_protection = false

  template {
    service_account = google_service_account.scaler.email
    # A full stockout sweep (every machine type x zone across all regions, Spot then STANDARD) can
    # take several minutes; tasks.ts sets the same Cloud Tasks dispatch deadline.
    timeout                          = "900s"
    max_instance_request_concurrency = 20

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = var.scaler_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      dynamic "env" {
        for_each = local.env
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "GITHUB_APP_PRIVATE_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.github_app_private_key.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GITHUB_WEBHOOK_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.github_webhook_secret.secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }

  lifecycle {
    # New scaler versions roll out with ../scripts/deploy-scaler.sh; Terraform owns everything else.
    # The API also returns a service-level scaling block (min 0, manual 0) that is not declared here,
    # which shows as a diff on every plan. Instance limits live in template.scaling above.
    ignore_changes = [template[0].containers[0].image, client, client_version, scaling]

    precondition {
      condition     = alltrue([for z in var.zones : can(regex("^(.+)-[a-z]$", z)) && contains(keys(var.runner_regions), try(regex("^(.+)-[a-z]$", z)[0], ""))])
      error_message = "Every entry in zones must be a zone name (region-letter, e.g. us-east4-b) in a region listed in runner_regions (it needs that region's subnet and NAT)."
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.scaler]
}

# Public: the GitHub webhook can't present Google credentials. /webhook is HMAC-verified and
# /reconcile + /janitor verify a Google OIDC token for the invoker SA (see scaler/src/oidc.ts).
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.scaler.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_scheduler_job" "janitor" {
  name   = "ci-scaler-janitor"
  region = var.region
  # Every 2 minutes: a finished VM's 80 GB disk counts against SSD_TOTAL_GB until the janitor deletes it,
  # and at 5 minutes that quota (not the runner cap) was what refused launches at peak.
  schedule         = "*/2 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "300s"

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.scaler.uri}/janitor"

    oidc_token {
      service_account_email = google_service_account.invoker.email
      audience              = local.oidc_audience
    }
  }
  depends_on = [google_project_service.enabled]
}
