# A module: the caller configures the google provider (project, region) and the state backend.
# See ../examples/basic.
terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}
