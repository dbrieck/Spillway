#!/usr/bin/env bash
# Installs what build-image.yml prepared on the GitHub-hosted side to cut what each job downloads (run by
# Packer as root, after the toolchain hook and before finalize.sh):
#   actions/            the action archive cache (scripts/collect-action-archives.sh), wired up through
#                       ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE in the runner's .env;
#   workspace-seed.tar  a depth-1 repository (scripts/pack-workspace-seed.sh) that becomes the job workspace.
# Runner VMs reach the internet through Cloud NAT, which bills every byte processed, so both pay for
# themselves on every job. Either may be absent; then this does nothing for it.
set -euo pipefail

EXTRA="${EXTRA_DIR:?}"
RUNNER_DIR=/actions-runner
ARCHIVE_CACHE=/opt/actions-archive-cache
log() { echo "==> $*"; }

if [ -d "${EXTRA}/actions" ] && [ -n "$(ls -A "${EXTRA}/actions")" ]; then
  log "Action archive cache (${ARCHIVE_CACHE})"
  rm -rf "${ARCHIVE_CACHE}"
  mv "${EXTRA}/actions" "${ARCHIVE_CACHE}"
  chmod -R a+rX "${ARCHIVE_CACHE}"
  echo "ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE=${ARCHIVE_CACHE}" >> "${RUNNER_DIR}/.env"
  find "${ARCHIVE_CACHE}" -name '*.tar.gz' | wc -l
fi

# The workspace path the runner uses for a repository: _work/<name>/<name>. finalize.sh hands /actions-runner
# to the runner user afterwards. actions/checkout keeps a repository whose origin URL is exactly
# https://github.com/<owner>/<repo>; anything else it deletes and clones as usual. Best effort: a failed seed
# only costs a full checkout per job, so it warns instead of failing the image build.
seed_workspace() {
  local ws="$1" seed="$2"
  # The tar comes from the GitHub-hosted runner's user; as root, keep root ownership so git trusts it.
  tar -xf "${EXTRA}/workspace-seed.tar" --no-same-owner -C "${seed}" || return 1
  rm -rf "${ws}"
  mkdir -p "${ws}" || return 1
  git -C "${ws}" init -q &&
    git -C "${ws}" remote add origin "https://github.com/${WORKSPACE_REPO}" &&
    git -C "${ws}" config gc.auto 0 &&
    git -C "${ws}" -c safe.directory='*' fetch -q --no-tags --depth=1 "file://${seed}"       refs/remotes/origin/seed:refs/remotes/origin/seed &&
    git -C "${ws}" checkout -q --detach refs/remotes/origin/seed
}

if [ -f "${EXTRA}/workspace-seed.tar" ] && [ -n "${WORKSPACE_REPO:-}" ]; then
  name="${WORKSPACE_REPO#*/}"
  ws="${RUNNER_DIR}/_work/${name}/${name}"
  log "Workspace seed (${ws})"
  seed="$(mktemp -d)"
  if seed_workspace "${ws}" "${seed}"; then
    git -C "${ws}" log -1 --format='seeded at %H (%ci)'
  else
    echo "WARNING: workspace seed failed; jobs will check out the full tree"
    rm -rf "${ws}"
  fi
  rm -rf "${seed}"
fi
