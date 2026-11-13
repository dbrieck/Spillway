#!/usr/bin/env bash
# Last root step, after the toolchain hook: hand runner-facing trees to the runner user and trim.
# Hooks often run as root with HOME pointing at /home/runner; jobs run as runner, so any root-owned
# file left there is an EACCES waiting to happen.
set -euo pipefail

echo "==> Ownership"
chown -R runner:runner /home/runner /actions-runner /opt/hostedtoolcache
for dir in ${RUNNER_OWNED_DIRS:-}; do
  [ -e "${dir}" ] && chown -R runner:runner "${dir}"
done

echo "==> Trim"
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache
rm -rf /tmp/*
