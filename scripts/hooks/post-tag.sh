#!/usr/bin/env bash
# post-tag.sh — invoke `cleo reconcile release --tag <tag>` after a git tag.
#
# Git does NOT have a native `post-tag` hook (the only tag-related hook is
# `pre-push` which fires *before* a push, not after a local `git tag`). This
# script is therefore intended to be invoked in two ways:
#
#   1. Manually:  scripts/hooks/post-tag.sh v2026.4.145
#   2. Wired into a `prepare-commit-msg` / CI runner that detects newly
#      created tags and forwards the tag name to this script.
#
# The script is intentionally minimal and idempotent — running it twice on
# the same tag produces the same audit-log rows for the no-op cases and
# refuses to double-stamp already-reconciled tasks (the invariant treats
# `status='done'` tasks as `noop-already-closed`).
#
# CONTRIBUTING.md documents the recommended installation alongside the
# T1410 commit-msg hook.
#
# Exit codes (forwarded from `cleo reconcile release`):
#   0 — clean reconcile, no follow-ups
#   1 — invariant raised an error
#   2 — unreconciled tasks present (operator follow-up needed)
#
# @task T1411
# @epic T1407
# @adr ADR-056 D5

set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  # Fallback: read from stdin (some hook frameworks pipe the tag name)
  if read -r TAG; then
    :
  fi
fi

if [[ -z "${TAG:-}" ]]; then
  echo "post-tag.sh: missing tag argument" >&2
  echo "usage: post-tag.sh <tag>" >&2
  exit 64
fi

# Resolve the cleo CLI: prefer the locally-built dist (development), fall
# back to the globally installed shim (production / contributor machines).
if [[ -x "${REPO_ROOT:-$(git rev-parse --show-toplevel)}/packages/cleo/dist/cli/index.js" ]]; then
  CLEO=("node" "$(git rev-parse --show-toplevel)/packages/cleo/dist/cli/index.js")
elif command -v cleo >/dev/null 2>&1; then
  CLEO=("cleo")
else
  echo "post-tag.sh: cleo CLI not found (neither dist nor PATH)" >&2
  exit 127
fi

exec "${CLEO[@]}" reconcile release --tag "$TAG"
