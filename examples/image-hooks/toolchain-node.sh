#!/usr/bin/env bash
# Example toolchain hook: Node 22 in the Actions tool cache (actions/setup-node finds it instead of
# downloading it every job) plus Playwright's Chromium system libraries. Runs as root after base.sh.
#
#   packer build ... -var toolchain_script=examples/image-hooks/toolchain-node.sh image
set -euo pipefail
: "${TOOL_CACHE:?}" "${RUNNER_DIR:?}"

echo "==> Node 22 (latest 22.x) into the tool cache"
NODE="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.version | startswith("v22."))][0].version')"
DEST="${TOOL_CACHE}/node/${NODE#v}/x64"
mkdir -p "${DEST}"
curl -fsSL "https://nodejs.org/dist/${NODE}/node-${NODE}-linux-x64.tar.xz" | tar -xJ --strip-components=1 -C "${DEST}"
touch "${DEST}.complete"
"${DEST}/bin/node" --version

echo "==> Playwright Chromium system libraries (the browser itself is installed per run)"
PATH="${DEST}/bin:${PATH}" HOME=/root npx --yes playwright@1.52.0 install-deps chromium

# Jobs that skip setup-node still find node on PATH.
sed -i "1s|^|${DEST}/bin:|" "${RUNNER_DIR}/.path"
