#!/usr/bin/env bash
# Conventional-commit based semver.
#   semver          unique per build (used for image tags, helm, artifacts)
#   releaseVersion  what the Release stage tags / publishes
set -euo pipefail

last_tag="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"
if [[ -z "$last_tag" ]]; then
  base="0.0.0"; range="HEAD"
else
  base="${last_tag#v}"; range="${last_tag}..HEAD"
fi
base="${base%%-*}"
IFS=. read -r major minor patch <<<"$base"

log="$(git log --format='%s%n%b' "$range" 2>/dev/null || true)"
bump=patch
if grep -qE '^[a-z]+(\([^)]+\))?!:|^BREAKING[ -]CHANGE' <<<"$log"; then bump=major
elif grep -qE '^feat(\([^)]+\))?:' <<<"$log"; then bump=minor
fi
case "$bump" in
  major) major=$((major + 1)); minor=0; patch=0 ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  patch) patch=$((patch + 1)) ;;
esac
core="${major}.${minor}.${patch}"

branch="${BUILD_SOURCEBRANCH:-refs/heads/local}"
build_id="${BUILD_BUILDID:-0}"

if [[ "$branch" == refs/tags/v* ]]; then
  semver="${branch#refs/tags/v}"; release="$semver"
elif [[ "$branch" == refs/heads/main ]]; then
  semver="${core}-main.${build_id}"; release="$core"
elif [[ "$branch" == refs/heads/release/* || "$branch" == refs/heads/hotfix/* ]]; then
  semver="${core}-rc.${build_id}"; release="$core"
else
  slug="$(echo "${branch#refs/heads/}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | cut -c1-20 | sed 's/-*$//')"
  if [[ -n "${SYSTEM_PULLREQUEST_PULLREQUESTNUMBER:-}" ]]; then slug="pr${SYSTEM_PULLREQUEST_PULLREQUESTNUMBER}"; fi
  semver="${core}-${slug:-dev}.${build_id}"; release="$semver"
fi

echo "last tag: ${last_tag:-<none>} | bump: $bump | semver: $semver | release: $release"
echo "##vso[task.setvariable variable=semver;isOutput=true]$semver"
echo "##vso[task.setvariable variable=releaseVersion;isOutput=true]$release"
echo "##vso[task.setvariable variable=bump;isOutput=true]$bump"
echo "##vso[build.updatebuildnumber]$semver"
