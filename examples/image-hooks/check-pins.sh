#!/usr/bin/env bash
# Example CI check: fails when the versions baked into the runner image drift from what the repository
# expects, so a job doesn't break only on Spillway runners after someone bumps an SDK. Run it from your
# repository root in a cheap CI job on pull requests that touch either side.
#
#   examples/image-hooks/check-pins.sh path/to/your-toolchain.sh
#
# It reads NAME="value" pins from the top of the toolchain hook and compares the ones it knows:
#   DOTNET_VERSION      == global.json sdk.version
#   NODE_MAJOR          == major version in .nvmrc
#   PLAYWRIGHT_VERSION  ~= @playwright/test in package.json (major.minor; system deps rarely change within one)
# A pin or file that isn't there is skipped. Add your own checks the same way.
set -euo pipefail

hook="${1:?usage: check-pins.sh <toolchain hook>}"
pin() { sed -nE "s/^$1=\"([^\"]+)\".*/\1/p" "${hook}" | head -1; }
fail=0
check() { # name, image value, repo value, ok?
  if [ "$4" = yes ]; then echo "ok   $1: $2"; else echo "FAIL $1: image has $2, repository expects $3"; fail=1; fi
}

img="$(pin DOTNET_VERSION)"
if [ -n "${img}" ] && [ -f global.json ]; then
  repo="$(node -p "require('./global.json').sdk.version")"
  check ".NET SDK vs global.json" "${img}" "${repo}" "$([ "${img}" = "${repo}" ] && echo yes || echo no)"
fi

img="$(pin NODE_MAJOR)"
if [ -n "${img}" ] && [ -f .nvmrc ]; then
  repo="$(sed -E 's/^v?([0-9]+).*/\1/' .nvmrc)"
  check "Node vs .nvmrc" "${img}" "${repo}" "$([ "${img}" = "${repo}" ] && echo yes || echo no)"
fi

img="$(pin PLAYWRIGHT_VERSION)"
if [ -n "${img}" ] && [ -f package.json ]; then
  repo="$(node -p "const p = require('./package.json'); (p.devDependencies || {})['@playwright/test'] || (p.dependencies || {})['@playwright/test'] || ''" | sed -E 's/^[^0-9]*//')"
  if [ -n "${repo}" ]; then
    check "Playwright vs package.json" "${img}" "${repo}" "$([ "${img%.*}" = "${repo%.*}" ] && echo yes || echo no)"
  fi
fi

exit "${fail}"
