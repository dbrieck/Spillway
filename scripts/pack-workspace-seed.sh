#!/usr/bin/env bash
# Packs the checked-out commit as a depth-1 bare repository: <out>/workspace-seed.tar. The image build
# (image/extras.sh) turns it into the runner's job workspace, /actions-runner/_work/<repo>/<repo>, so a job's
# actions/checkout finds a repository whose origin matches and fetches only the objects added since the image
# was built, as on a persistent runner, instead of the whole tree on every job. Submodules are not seeded.
#
# Run from the root of your checkout (build-image.yml does). Usage: pack-workspace-seed.sh <out dir>
set -euo pipefail

out="${1:?usage: pack-workspace-seed.sh <out dir>}"
mkdir -p "$out"
seed="$(mktemp -d)"
trap 'rm -rf "$seed"' EXIT

# A fresh bare repository, not a copy of this checkout's .git: that one carries the workflow's credentials
# in its config. file:// makes git honour --depth for a local (and possibly shallow) source.
git init -q --bare "$seed"
git -C "$seed" fetch -q --no-tags --depth=1 "file://$PWD" "HEAD:refs/remotes/origin/seed"
tar -cf "$out/workspace-seed.tar" -C "$seed" .
echo "workspace seed: $(git rev-parse HEAD), $(du -h "$out/workspace-seed.tar" | cut -f1)"
