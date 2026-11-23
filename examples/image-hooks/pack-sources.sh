#!/usr/bin/env bash
# Writes the source snapshot the warm-cache hooks restore from: the tracked files at HEAD plus every
# submodule at its checked-out commit (plain `git archive` leaves submodules out, and a project that
# references one then fails to restore). Run from your repository root before the image build and pass
# the output's directory as upload_dir.
#
#   examples/image-hooks/pack-sources.sh .build/src.tar.gz
set -euo pipefail

out="${1:-.build/src.tar.gz}"
mkdir -p "$(dirname "${out}")"
stage="$(mktemp -d)"
trap 'rm -rf "${stage}"' EXIT

git archive --format=tar HEAD | tar -x -C "${stage}"
export STAGE="${stage}"
# Single quotes on purpose: git expands $displaypath per submodule; $STAGE comes from the environment.
# shellcheck disable=SC2016
git submodule foreach --quiet --recursive \
  'mkdir -p "$STAGE/$displaypath" && git archive --format=tar HEAD | tar -x -C "$STAGE/$displaypath"'

tar -czf "${out}" -C "${stage}" .
echo "wrote ${out} ($(du -h "${out}" | cut -f1))"
