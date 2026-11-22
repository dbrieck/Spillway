# Builds a Spillway runner image into var.image_family (the Terraform module's image_family).
#
#   packer init  image
#   packer build -var project_id=<project> -var subnetwork=<self link> \
#                -var toolchain_script=<your toolchain.sh> image
#
# Layers, in order:
#   base.sh            (root)   packages, runner user, actions/runner, one-job boot service
#   toolchain_script   (root)   your languages/SDKs/browsers; env: RUNNER_DIR, TOOL_CACHE, UPLOAD_DIR
#   finalize.sh        (root)   hands runner-facing trees to the runner user, trims caches
#   warm_cache_script  (runner) optional: pre-fill package caches; env: UPLOAD_DIR
#
# upload_dir is copied to UPLOAD_DIR on the build VM first (e.g. a source snapshot for the warm-cache
# step) and deleted before the image is captured. The build VM has no external IP and no service
# account; Packer reaches it over IAP and logs in with OS Login (CIS 4.3 / 4.4 hold for the build VM
# too): Packer imports a temporary key into the OS Login profile of the identity it runs as (the
# image builder service account, which holds roles/compute.osAdminLogin for sudo) and removes it
# afterwards. No key ever lands in instance or project metadata.

packer {
  required_plugins {
    googlecompute = {
      source  = "github.com/hashicorp/googlecompute"
      version = ">= 1.1.6"
    }
  }
}

variable "project_id" {
  type = string
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

variable "machine_type" {
  type        = string
  description = "Build VM shape only; runner VMs use the Terraform instance template's machine type."
  default     = "n2-standard-8"
}

variable "subnetwork" {
  type        = string
  description = "Self link of a runner subnetwork (Terraform output subnetwork)."
}

variable "image_family" {
  type    = string
  default = "spillway-runner"
}

variable "pool_name" {
  type        = string
  description = "Recorded as the image's ci-runner label."
  default     = "spillway"
}

variable "runner_version" {
  type        = string
  description = "actions/runner release without the leading v."
  default     = "2.337.0"
}

variable "disk_size_gb" {
  type        = number
  description = "Image disk size. Runner VMs' boot disks (Terraform disk_size_gb) must be at least this big."
  default     = 60
}

variable "toolchain_script" {
  type        = string
  description = "Root hook that installs your project's toolchain. Empty: base image only."
  default     = ""
}

variable "warm_cache_script" {
  type        = string
  description = "Hook run as the runner user to pre-fill package caches. Empty: skipped."
  default     = ""
}

variable "upload_dir" {
  type        = string
  description = "Local directory copied to UPLOAD_DIR on the build VM for the hooks. Empty: nothing extra."
  default     = ""
}

variable "extra_dir" {
  type        = string
  description = "Local directory with build-image.yml's per-job download savers (action archives, workspace seed) for image/extras.sh. Empty: none."
  default     = ""
}

variable "workspace_repo" {
  type        = string
  description = "owner/name of the repository whose job workspace the seed in extra_dir becomes. Empty: no seed."
  default     = ""
}

variable "runner_owned_dirs" {
  type        = list(string)
  description = "Extra directories the toolchain hook created that jobs must be able to write (e.g. an SDK root)."
  default     = []
}

variable "git_sha" {
  type    = string
  default = "unknown"
}

locals {
  stamp      = formatdate("YYYYMMDD-hhmmss", timestamp())
  noop       = "${path.root}/hooks/noop.sh"
  toolchain  = var.toolchain_script != "" ? var.toolchain_script : local.noop
  warm_cache = var.warm_cache_script != "" ? var.warm_cache_script : local.noop
  # Trailing slash: the directory's contents land in UPLOAD_DIR. The default uploads the (harmless)
  # hooks directory so the step needs no special case.
  upload_dir = "${trimsuffix(var.upload_dir != "" ? var.upload_dir : "${path.root}/hooks", "/")}/"
  upload_vm  = "/var/tmp/spillway-upload"
  extra_dir  = "${trimsuffix(var.extra_dir != "" ? var.extra_dir : "${path.root}/hooks", "/")}/"
  extra_vm   = "/var/tmp/spillway-extra"
}

source "googlecompute" "runner" {
  project_id              = var.project_id
  zone                    = var.zone
  subnetwork              = var.subnetwork
  source_image_family     = "ubuntu-2204-lts"
  source_image_project_id = ["ubuntu-os-cloud"]
  machine_type            = var.machine_type
  disk_size               = var.disk_size_gb
  disk_type               = "pd-balanced"

  image_name        = "${var.image_family}-${local.stamp}"
  image_family      = var.image_family
  image_description = "Spillway runner (actions/runner ${var.runner_version}, git ${var.git_sha})"
  image_labels = {
    ci-runner      = var.pool_name
    runner-version = replace(var.runner_version, ".", "-")
  }

  omit_external_ip                = true
  use_internal_ip                 = true
  use_iap                         = true
  tags                            = ["ci-image-build"]
  disable_default_service_account = true
  ssh_username                    = "packer" # replaced by the OS Login POSIX username at build time
  use_os_login                    = true
  enable_secure_boot              = true
  enable_vtpm                     = true
  enable_integrity_monitoring     = true

  metadata = {
    block-project-ssh-keys = "TRUE"
  }
}

build {
  sources = ["source.googlecompute.runner"]

  provisioner "shell" {
    inline = ["mkdir -p /tmp/image /tmp/upload /tmp/extra"]
  }

  provisioner "file" {
    sources     = ["${path.root}/startup.sh", "${path.root}/ci-runner.service"]
    destination = "/tmp/image/"
  }

  provisioner "file" {
    source      = local.upload_dir
    destination = "/tmp/upload"
  }

  provisioner "file" {
    source      = local.extra_dir
    destination = "/tmp/extra"
  }

  # finalize.sh clears /tmp, so park the uploads outside it.
  provisioner "shell" {
    inline = [
      "sudo rm -rf ${local.upload_vm} ${local.extra_vm}",
      "sudo mv /tmp/upload ${local.upload_vm}",
      "sudo mv /tmp/extra ${local.extra_vm}",
    ]
  }

  provisioner "shell" {
    execute_command  = "sudo -E env {{ .Vars }} bash '{{ .Path }}'"
    environment_vars = ["RUNNER_VERSION=${var.runner_version}"]
    script           = "${path.root}/base.sh"
  }

  provisioner "shell" {
    execute_command  = "sudo -E env {{ .Vars }} bash '{{ .Path }}'"
    environment_vars = ["RUNNER_DIR=/actions-runner", "TOOL_CACHE=/opt/hostedtoolcache", "UPLOAD_DIR=${local.upload_vm}"]
    script           = local.toolchain
  }

  # Before finalize.sh, which hands the seeded workspace to the runner user.
  provisioner "shell" {
    execute_command  = "sudo -E env {{ .Vars }} bash '{{ .Path }}'"
    environment_vars = ["EXTRA_DIR=${local.extra_vm}", "WORKSPACE_REPO=${var.workspace_repo}"]
    script           = "${path.root}/extras.sh"
  }

  provisioner "shell" {
    execute_command  = "sudo -E env {{ .Vars }} bash '{{ .Path }}'"
    environment_vars = ["RUNNER_OWNED_DIRS=${join(" ", concat(var.runner_owned_dirs, [local.upload_vm]))}"]
    script           = "${path.root}/finalize.sh"
  }

  provisioner "shell" {
    execute_command  = "sudo -u runner -H env {{ .Vars }} bash '{{ .Path }}'"
    environment_vars = ["UPLOAD_DIR=${local.upload_vm}"]
    script           = local.warm_cache
  }

  provisioner "shell" {
    inline = ["sudo rm -rf ${local.upload_vm} ${local.extra_vm}"]
  }
}
