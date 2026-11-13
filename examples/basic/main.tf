# Minimal root module: one Spillway pool in a dedicated project.
#
#   terraform init -backend-config="bucket=<state bucket>"
#   terraform apply
#
# See docs/setup.md for the one-time steps around it (GitHub App, secrets, first image).
terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  backend "gcs" {
    prefix = "spillway"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

module "spillway" {
  # In your own repository: "git::https://github.com/dbrieck/spillway.git//terraform?ref=<release tag>"
  source = "../../terraform"

  project_id             = var.project_id
  region                 = var.region
  github_app_id          = var.github_app_id
  github_repositories    = var.github_repositories
  runner_image_available = var.runner_image_available

  # Everything else has a default; docs/tuning.md explains each knob. For example:
  # max_runners         = 6
  # small_machine_types = ["c3d-standard-4", "n2d-standard-4"]
  # standard_workflows  = ["Nightly*"]
}

variable "project_id" {
  description = "Dedicated GCP project for the runners."
  type        = string
}

variable "region" {
  description = "Home region (network, Cloud Run, Cloud Tasks, Scheduler)."
  type        = string
  default     = "us-central1"
}

variable "github_app_id" {
  description = "Id of the GitHub App the scaler authenticates as."
  type        = string
}

variable "github_repositories" {
  description = "Repositories (owner/name) whose jobs may use these runners."
  type        = list(string)
}

variable "runner_image_available" {
  description = "Flip to true after the first image build."
  type        = bool
  default     = false
}

output "webhook_url" {
  description = "Paste into the GitHub App's webhook URL."
  value       = module.spillway.webhook_url
}

output "scaler_image_repository" {
  value = module.spillway.scaler_image_repository
}

output "scaler_service" {
  value = module.spillway.scaler_service
}

output "image_build" {
  description = "Inputs for the build-image workflow."
  value = {
    project_id                 = var.project_id
    workload_identity_provider = module.spillway.workload_identity_provider
    service_account            = module.spillway.image_builder_service_account
    subnetwork                 = module.spillway.subnetwork
  }
}
