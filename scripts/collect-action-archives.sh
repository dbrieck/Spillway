#!/usr/bin/env bash
# Downloads every action your workflows use into an actions/runner archive cache: <out>/<owner>_<repo>/<sha>.tar.gz,
# the layout the runner checks when ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE points at it. A runner VM then copies
# each action from its image instead of downloading it at the start of every job.
#
# Run from the root of your checkout (build-image.yml does), with GH_TOKEN set. Usage: collect-action-archives.sh <out>
#
# Scans .github/workflows and .github/actions, then the actions found there (composite actions use others,
# e.g. a setup step), two levels deep. Local (./) and docker:// actions and reusable workflows are skipped.
# Best effort: an action that can't be resolved or downloaded (a private repository the token can't read)
# is skipped with a warning, and the job downloads it as usual. A tag that moves after the image is built
# (actions/checkout@v7 on its next release) misses the same way until the next image build.
set -euo pipefail

out="${1:?usage: collect-action-archives.sh <out dir>}"
: "${GH_TOKEN:?GH_TOKEN must be set}"
mkdir -p "$out"
scan="$(mktemp -d)"
trap 'rm -rf "$scan"' EXIT

# `uses: owner/repo[/path]@ref` lines, one ref per line.
uses_in() {
  grep -rhoE "^[[:space:]-]*uses:[[:space:]]*['\"]?[^'\"[:space:]#]+" "$@" 2>/dev/null \
    | sed -E "s/^[[:space:]-]*uses:[[:space:]]*['\"]?//" \
    | grep -vE '^(\./|docker://)' \
    | grep -vE '/\.github/workflows/' \
    | grep '@' || true
}

declare -A seen=()
mapfile -t pending < <(uses_in .github --include='*.yml' --include='*.yaml' | sort -u)
fetched=0
for level in 1 2; do
  next=()
  for ref in "${pending[@]}"; do
    [ -n "${seen[$ref]:-}" ] && continue
    seen[$ref]=1
    spec="${ref%@*}"
    version="${ref##*@}"
    owner="${spec%%/*}"
    rest="${spec#*/}"
    repo="${rest%%/*}"
    if ! full="$(gh api "repos/$owner/$repo" --jq .full_name 2>/dev/null)" \
      || ! sha="$(gh api "repos/$owner/$repo/commits/$version" --jq .sha 2>/dev/null)"; then
      echo "::warning::action archives: cannot resolve $ref; jobs will download it"
      continue
    fi
    dir="$out/${full//\//_}"
    archive="$dir/$sha.tar.gz"
    if [ ! -f "$archive" ]; then
      mkdir -p "$dir"
      if ! gh api "repos/$full/tarball/$sha" > "$archive.part"; then
        rm -f "$archive.part"
        echo "::warning::action archives: cannot download $ref; jobs will download it"
        continue
      fi
      mv "$archive.part" "$archive"
      fetched=$((fetched + 1))
      echo "$ref -> $full@$sha"
    fi
    # Actions this one uses (composite steps), for the next level.
    if [ "$level" -lt 2 ]; then
      mkdir -p "$scan/$level"
      tar -xzf "$archive" -C "$scan/$level" --wildcards '*/action.yml' '*/action.yaml' 2>/dev/null || true
      mapfile -t -O "${#next[@]}" next < <(uses_in "$scan/$level" | sort -u)
      rm -rf "${scan:?}/$level"
    fi
  done
  [ "${#next[@]}" -eq 0 ] && break
  pending=("${next[@]}")
done

echo "action archives: $fetched downloaded, $(du -sh "$out" | cut -f1) in $out"
