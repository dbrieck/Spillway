#!/usr/bin/env bash
# Example warm-cache hook: fills ~/.npm from a source snapshot so a VM's first `npm ci` is mostly cache
# hits. Runs as the runner user. Best effort: a failure only costs cache hits, so it never fails the build.
#
#   git archive --format=tar.gz -o .build/src.tar.gz HEAD
#   packer build ... -var upload_dir=.build -var warm_cache_script=examples/image-hooks/warm-npm.sh image
set -uo pipefail
: "${UPLOAD_DIR:?}"

SNAPSHOT="${UPLOAD_DIR}/src.tar.gz"
NODE_BIN="$(find /opt/hostedtoolcache/node -maxdepth 3 -name bin -type d | sort -V | tail -1)"
[ -f "${SNAPSHOT}" ] || { echo "no ${SNAPSHOT}; skipping"; exit 0; }
[ -n "${NODE_BIN}" ] || { echo "no Node in the tool cache; skipping"; exit 0; }
export PATH="${NODE_BIN}:${PATH}"

SRC="$(mktemp -d)"
tar -xzf "${SNAPSHOT}" -C "${SRC}"
find "${SRC}" -name package-lock.json -not -path "*/node_modules/*" | while read -r lock; do
  dir="$(dirname "${lock}")"
  echo "==> npm ci (${dir#"${SRC}"/})"
  (cd "${dir}" && npm ci --ignore-scripts --no-audit --no-fund) || echo "::warning:: npm ci failed in ${dir}"
done
rm -rf "${SRC}"
du -sh ~/.npm 2>/dev/null || true
exit 0
