variable "project_id" {
  description = "GCP project that hosts the runners. Use a dedicated project: it keeps CI's blast radius and billing away from production."
  type        = string
}

variable "region" {
  description = "Region for the network, Cloud Run, Cloud Tasks and Scheduler."
  type        = string
  default     = "us-central1"
}

variable "runner_regions" {
  description = "Regions runner VMs may be placed in, each with a non-overlapping subnet CIDR. Spreading across regions gets around single-region Spot stockouts. Each region has its own per-region quotas (N2_CPUS, SSD_TOTAL_GB, ...); CPUS_ALL_REGIONS is shared."
  type        = map(string)
  default = {
    "us-central1" = "10.60.0.0/20"
    "us-east1"    = "10.60.16.0/20"
    "us-east4"    = "10.60.32.0/20"
    "us-west1"    = "10.60.48.0/20"
  }

  validation {
    condition     = contains(keys(var.runner_regions), var.region)
    error_message = "runner_regions must include the home region (var.region)."
  }
}

variable "zones" {
  description = "Zones the scaler tries, in order, for each machine type. Every zone's region must be a key of runner_regions."
  type        = list(string)
  default = [
    # us-central1-b last of its region: c3d Spot there was preempted about twice as often (5%) as in -a/-c.
    "us-central1-a", "us-central1-c", "us-central1-f", "us-central1-b",
    "us-east4-a", "us-east4-b", "us-east4-c",
    "us-east1-b", "us-east1-c", "us-east1-d",
    "us-west1-a", "us-west1-b", "us-west1-c",
  ]
}

variable "github_repositories" {
  description = "Repositories (owner/name) whose jobs may run on these runners; also the only repositories allowed to build the runner image through workload identity federation."
  type        = list(string)

  validation {
    condition     = length(var.github_repositories) > 0 && alltrue([for r in var.github_repositories : can(regex("^[^/]+/[^/]+$", r))])
    error_message = "github_repositories must list at least one repository as owner/name."
  }
}

variable "pool_name" {
  description = "Names this install: the ci-runner label on every runner VM. The scaler only manages (and cleans up) VMs carrying it."
  type        = string
  default     = "spillway"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,39}$", var.pool_name))
    error_message = "pool_name must be lowercase letters, digits and hyphens, start with a letter, and be at most 40 characters."
  }
}

variable "runner_name_prefix" {
  description = "Name prefix for runner VMs and their GitHub runner registrations. Empty means \"<pool_name>-\". Runners without it are never touched, so other pools sharing the repository stay safe."
  type        = string
  default     = ""

  validation {
    condition     = var.runner_name_prefix == "" || can(regex("^[a-z][a-z0-9-]{0,39}$", var.runner_name_prefix))
    error_message = "runner_name_prefix must be empty or lowercase letters, digits and hyphens starting with a letter."
  }
}

variable "allow_fork_prs" {
  description = "Launch runners for pull requests from forks. Leave false unless you understand the risk: a fork's code would run on a VM with passwordless sudo inside your project's network."
  type        = bool
  default     = false
}

variable "github_app_id" {
  description = "GitHub App id used by the scaler (the private key goes in Secret Manager, not here)."
  type        = string
}

variable "runner_labels" {
  description = "Labels every GCP runner registers with. Jobs whose runs-on labels are a subset are eligible."
  type        = list(string)
  default     = ["self-hosted", "Linux", "X64", "gcp"]
}

variable "machine_type" {
  description = "First-choice runner VM machine type (8 vCPU / 32 GB). Chosen by Spot price: on 2026-10-03 in us-central1, c3d-standard-8 was $0.0975/h against $0.233/h for n2-standard-8, which was also preempted ~11% of the time. Spot prices move monthly; re-check with the Cloud Billing catalog and reorder machine_type / fallback_machine_types."
  type        = string
  default     = "c3d-standard-8"
}

variable "fallback_machine_types" {
  description = "Tried in order after machine_type on a stockout or family quota (separate capacity pools). Ordered by Spot price as of 2026-10-03 (n2d $0.181, t2d $0.203, c2d $0.205, n2 $0.233 per hour), except e2 ($0.161), which is LAST: from 2026-10-05 to 10-09, e2 Spot VMs in us-central1-a were preempted 62 times in 130 launches (48%, against 1-5% for c3d), and each preemption adds about 20 minutes to a run. Keep them x86-64 with the same vCPU/RAM so jobs behave the same; n4/n4d/c4d are out (Hyperdisk only)."
  type        = list(string)
  default     = ["n2d-standard-8", "t2d-standard-8", "c2d-standard-8", "n2-standard-8", "e2-standard-8"]
}

variable "disk_size_gb" {
  description = "Boot disk size (pd-balanced, which counts against the regional SSD_TOTAL_GB quota: 500 GB by default, i.e. 6 runners at 80 GB). Must be >= the image's 60 GB; a runner used ~13 GB after the smoke test, so 80 leaves room for full builds."
  type        = number
  default     = 80
}

variable "image_family" {
  description = "Compute image family produced by ../image (Packer). VMs always boot the newest image in the family."
  type        = string
  default     = "spillway-runner"
}

variable "runner_image_available" {
  description = "Set true once the first image exists in image_family (after the first image build). While false, the scaler launches nothing and the template points at a stock Ubuntu placeholder."
  type        = bool
  default     = false
}

variable "max_runners" {
  description = "Cap on concurrent runner VMs. 0 pauses launches (cleanup keeps running). Project quotas usually cap the pool first: see docs/tuning.md."
  type        = number
  default     = 6
}

variable "burst_delay_seconds" {
  description = "How long a job must sit queued before a VM is launched for it. If other self-hosted runners (e.g. a local pool) serve the same labels, this is their head start. Keep it short: it adds to every launched job's wait, on top of ~1.5 min of VM boot. Jobs asking for a label only these runners have skip it."
  type        = number
  default     = 10
}

variable "idle_timeout_seconds" {
  description = "A VM that has not started a job within this long shuts itself down. A VM boots and registers in under 2 minutes; in production, idle VMs were ~2% of VM-hours at 15 minutes, so 5 is ample."
  type        = number
  default     = 300
}

variable "max_run_seconds" {
  description = "GCE max_run_duration: hard cap on a VM's lifetime. Set it above your longest job timeout."
  type        = number
  default     = 14400
}

variable "standard_workflows" {
  description = "Workflow-name globs (e.g. \"Nightly*\") that get on-demand VMs instead of Spot: long runs where a preemption costs the most."
  type        = list(string)
  default     = []
}

variable "low_priority_branches" {
  description = "Branches whose jobs nobody waits on, e.g. [\"main\"] for post-merge runs (34% of VM time in production). Their jobs wait low_priority_burst_delay_seconds for another runner before a VM is launched. Only useful alongside another pool; empty means every job uses burst_delay_seconds."
  type        = list(string)
  default     = []
}

variable "low_priority_burst_delay_seconds" {
  description = "How long a low-priority job waits for another runner before a VM is launched for it."
  type        = number
  default     = 60
}

variable "small_runner_labels" {
  description = "Labels a SMALL runner registers with. A job opts into the small tier by asking only for labels in this list, e.g. runs-on: [self-hosted, Linux]. Must NOT contain every label of a full-size job (the default leaves out X64), so a small VM can never be handed one."
  type        = list(string)
  default     = ["self-hosted", "Linux", "gcp-small"]
}

variable "small_machine_types" {
  description = "Machine types for the small tier, e.g. [\"c3d-standard-4\", \"n2d-standard-4\"]; the regular types stay as fallback. Empty disables the tier: small-tier jobs then run on regular runners. Avoid e2 here too (see fallback_machine_types). Check the jobs' peak memory first (ci-runner 'memory peak_used_mb' lines in the serial console logs)."
  type        = list(string)
  default     = []
}

variable "preemption_retries" {
  description = "Automatic re-runs (rerun-failed-jobs) of a run whose job died with its preempted Spot VM. 0 disables. Needs the GitHub App's Actions permission at read & write."
  type        = number
  default     = 1
}

variable "scaler_image" {
  description = "Initial container image for the scaler Cloud Run service. Later deploys go through ../scripts/deploy-scaler.sh; Terraform ignores image drift."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "enable_iap_ssh" {
  description = "Allow SSH to runner VMs through IAP (debugging only)."
  type        = bool
  default     = false
}
