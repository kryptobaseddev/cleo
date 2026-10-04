#!/usr/bin/env bash
# Set the version of the root and every released workspace manifest (T13181).
#
# Usage: scripts/release-sync-versions.sh <version>
#
# release.yml runs it in Build & Verify (the tag's version, before the build)
# and twice in Publish: first the release candidate `<version>-rc.ci.<n>` that
# goes to the `canary` dist-tag, then `<version>` again for `latest`. pnpm
# publish rewrites each `workspace:*` dependency to the dependency's manifest
# version, so every @cleocode package of one phase pins the others at that
# phase's exact version. The CLI reads its version from its package.json at
# runtime, so the build output itself carries no version.
set -euo pipefail
VERSION="${1:?usage: release-sync-versions.sh <version>}"
if [[ ! "$VERSION" =~ ^[0-9]{4}\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "::error::not a CalVer version: $VERSION" >&2
  exit 1
fi
# The per-platform worktree-napi-* manifest packages were removed (T11398 / E1 ·
# SG-PACKAGE-ARCH); the crate stays in the loop for local napi-rs version sync.
# packages/mcp-adapter was removed (R8 · T11259).
MANIFESTS=(
  package.json
  packages/contracts packages/paths packages/core packages/caamp packages/lafs
  packages/cant packages/nexus packages/brain packages/runtime packages/adapters
  packages/cleo packages/cleo-os packages/agents packages/skills packages/playbooks
  packages/worktree packages/git-shim packages/studio packages/animations
  crates/worktree-napi
)
for entry in "${MANIFESTS[@]}"; do
  manifest="$entry"
  [[ "$manifest" == *.json ]] || manifest="$entry/package.json"
  [[ -f "$manifest" ]] || continue
  jq --arg v "$VERSION" '.version = $v' "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
  echo "$manifest -> $VERSION"
done
