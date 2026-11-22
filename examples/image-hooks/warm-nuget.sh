#!/usr/bin/env bash
# Example warm-cache hook: fills ~/.nuget/packages from a source snapshot so a VM's first restore is
# mostly cache hits. Runs as the runner user after the toolchain hook, which must have put the .NET SDK
# in the tool cache. Best effort: a failure only costs cache hits, so it never fails the build.
#
#   examples/image-hooks/pack-sources.sh .build/src.tar.gz
#   packer build ... -var upload_dir=.build -var warm_cache_script=examples/image-hooks/warm-nuget.sh image
#
# It restores every solution in the snapshot (.sln or .slnx, up to two levels deep). If your CI restores
# only some projects, list those instead so the cache holds what jobs actually ask for.
set -uo pipefail
: "${UPLOAD_DIR:?}"

SNAPSHOT="${UPLOAD_DIR}/src.tar.gz"
export DOTNET_ROOT=/opt/hostedtoolcache/dotnet
export PATH="${DOTNET_ROOT}:${PATH}"
export DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1
[ -f "${SNAPSHOT}" ] || { echo "no ${SNAPSHOT}; skipping"; exit 0; }
command -v dotnet >/dev/null || { echo "no .NET SDK in ${DOTNET_ROOT}; skipping"; exit 0; }

SRC="$(mktemp -d)"
tar -xzf "${SNAPSHOT}" -C "${SRC}"
find "${SRC}" -maxdepth 2 \( -name '*.sln' -o -name '*.slnx' \) | while read -r sln; do
  echo "==> dotnet restore ${sln#"${SRC}"/}"
  dotnet restore "${sln}" || echo "::warning:: restore failed: ${sln#"${SRC}"/}"
done
rm -rf "${SRC}"
du -sh ~/.nuget/packages 2>/dev/null || true
exit 0
