#!/usr/bin/env bash
# Base layer of every Spillway runner image (run by Packer as root; see spillway-runner.pkr.hcl):
# the packages actions/runner and actions/checkout need, the runner user, actions/runner itself and
# the one-job boot service. Project toolchains (languages, SDKs, browsers) go in a toolchain hook,
# which runs right after this script with RUNNER_DIR and TOOL_CACHE in its environment.
set -euo pipefail

RUNNER_VERSION="${RUNNER_VERSION:?RUNNER_VERSION must be set (actions/runner release, no leading v)}"
RUNNER_DIR=/actions-runner
TOOL_CACHE=/opt/hostedtoolcache

export DEBIAN_FRONTEND=noninteractive
log() { echo "==> $*"; }

log "Base packages"
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl wget git git-lfs unzip zip jq apt-transport-https gnupg lsb-release \
  build-essential python3 sudo util-linux procps

log "runner user (jobs run as runner; passwordless sudo is safe on a VM that lives for one job)"
id runner >/dev/null 2>&1 || useradd --create-home --shell /bin/bash runner
echo "runner ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runner
chmod 0440 /etc/sudoers.d/runner

log "actions/runner ${RUNNER_VERSION}"
mkdir -p "${RUNNER_DIR}" "${TOOL_CACHE}"
curl -fsSL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
  | tar -xz -C "${RUNNER_DIR}"
"${RUNNER_DIR}/bin/installdependencies.sh"

# The runner loads .env into every job and .path as the job's PATH. Toolchain hooks append to .env
# and prepend to .path. Tools in the tool cache are found by setup-* actions (setup-node, ...).
cat > "${RUNNER_DIR}/.env" <<ENV
LANG=C.UTF-8
RUNNER_TOOL_CACHE=${TOOL_CACHE}
AGENT_TOOLSDIRECTORY=${TOOL_CACHE}
ENV
echo "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" > "${RUNNER_DIR}/.path"

log "Boot-time runner service"
install -m 0755 /tmp/image/startup.sh /usr/local/bin/ci-runner-startup.sh
install -m 0644 /tmp/image/ci-runner.service /etc/systemd/system/ci-runner.service
systemctl enable ci-runner.service
