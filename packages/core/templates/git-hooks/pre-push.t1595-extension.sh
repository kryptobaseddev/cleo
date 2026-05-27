#!/bin/sh
# T1595 — pre-push reconcile gate (extension)
#
# This file is the reconcile-gate extension for the project's pre-push
# hook. T1588 will produce a unified pre-push hook that contains a
# sentinel block:
#
#   # T1595:reconcile-extension-point
#   # Pre-push reconcile gate hooks here (see T1595 worker)
#
# When T1588 lands, the contents of `reconcile_gate()` below MUST be
# inlined at that sentinel. Until then, this file is sourced as-is by
# any pre-push hook that wants the reconcile gate (see installer in
# `packages/core/src/hooks/install-pre-push.ts`, future).
#
# CONTRACT
#   - POSIX shell (`/bin/sh`); no bashisms.
#   - Reads pending tag from `git tag --sort=-v:refname | head -1`
#     (tag-shape agnostic — works for CalVer or SemVer).
#   - Calls `cleo reconcile release --tag <pending> --dry-run --json`
#     and parses the aggregate `reconciled` count.
#   - Drift > 0 → exit 1 with task-ID list.
#   - Drift == 0 → return 0.
#   - Override: env `CLEO_ALLOW_DRIFT_PUSH=1` bypasses the gate AND
#     appends an audit entry to
#     `${XDG_DATA_HOME:-$HOME/.local/share}/cleo/audit/drift-push-bypass.jsonl`.
#   - Project-agnostic: no hardcoded branch name; default branch is
#     resolved via `git symbolic-ref refs/remotes/origin/HEAD` when
#     needed.
#
# EXIT CODES
#   0  — no drift, push allowed
#   1  — drift detected, push refused (or cleo CLI unavailable in
#        strict mode; see CLEO_RECONCILE_STRICT below)
#
# CONFIGURATION (env)
#   CLEO_ALLOW_DRIFT_PUSH=1   bypass the gate (audited)
#   CLEO_RECONCILE_STRICT=1   if `cleo` CLI is missing, refuse push
#                             (default: warn-and-allow so first-time
#                              clones without cleo installed still work)
#   CLEO_RECONCILE_BIN=<path> override the cleo binary path (testing)

set -eu

reconcile_gate() {
  # Locate cleo CLI ------------------------------------------------------
  cleo_bin="${CLEO_RECONCILE_BIN:-cleo}"
  if ! command -v "$cleo_bin" >/dev/null 2>&1; then
    if [ "${CLEO_RECONCILE_STRICT:-0}" = "1" ]; then
      echo "ERROR: cleo CLI not found on PATH (strict mode)" >&2
      echo "       install cleo or unset CLEO_RECONCILE_STRICT" >&2
      return 1
    fi
    # Soft-fail: warn but allow push. Avoids blocking fresh clones.
    echo "warn: cleo CLI not found; skipping reconcile gate" >&2
    return 0
  fi

  # Resolve the pending release tag -------------------------------------
  # We use the most recent tag as the "pending" anchor. Reconcile is
  # project-agnostic — it walks tasks released_in this tag's range
  # regardless of CalVer vs SemVer shape.
  pending_tag="$(git tag --sort=-v:refname 2>/dev/null | head -n 1 || true)"
  if [ -z "$pending_tag" ]; then
    # No tags yet → no release to reconcile.
    return 0
  fi

  # Override path -------------------------------------------------------
  if [ "${CLEO_ALLOW_DRIFT_PUSH:-0}" = "1" ]; then
    audit_dir="${XDG_DATA_HOME:-$HOME/.local/share}/cleo/audit"
    mkdir -p "$audit_dir"
    audit_log="$audit_dir/drift-push-bypass.jsonl"
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    user="${USER:-${LOGNAME:-unknown}}"
    repo="$(git rev-parse --show-toplevel 2>/dev/null || echo unknown)"
    head_sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
    # Write a JSONL line. Stay project-agnostic: no jq dependency.
    printf '{"ts":"%s","user":"%s","repo":"%s","head":"%s","tag":"%s","reason":"CLEO_ALLOW_DRIFT_PUSH=1"}\n' \
      "$ts" "$user" "$repo" "$head_sha" "$pending_tag" >> "$audit_log"
    echo "warn: pre-push reconcile gate bypassed (CLEO_ALLOW_DRIFT_PUSH=1)" >&2
    echo "      audit: $audit_log" >&2
    return 0
  fi

  # Run reconcile in dry-run JSON mode ----------------------------------
  # We swallow non-zero exit codes from the CLI here because reconcile
  # exits 2 when drift exists; we want to read the JSON regardless.
  json_out="$("$cleo_bin" reconcile release --tag "$pending_tag" --dry-run --json 2>/dev/null || true)"
  if [ -z "$json_out" ]; then
    if [ "${CLEO_RECONCILE_STRICT:-0}" = "1" ]; then
      echo "ERROR: cleo reconcile release returned empty output (strict mode)" >&2
      return 1
    fi
    echo "warn: cleo reconcile release returned empty output; skipping gate" >&2
    return 0
  fi

  # Parse the aggregate `reconciled` count without jq.
  # The InvariantReport JSON has a top-level `"reconciled": N` integer.
  # We grep the first such key (top-level always emitted before per-result
  # entries). Per-result entries are nested under `results[*].details`,
  # so the first match is the aggregate.
  drift_count="$(printf '%s' "$json_out" \
    | grep -o '"reconciled"[[:space:]]*:[[:space:]]*[0-9]\+' \
    | head -n 1 \
    | grep -o '[0-9]\+' \
    || true)"
  drift_count="${drift_count:-0}"

  if [ "$drift_count" -gt 0 ] 2>/dev/null; then
    echo "ERROR: pre-push reconcile gate detected drift" >&2
    echo "       tag: $pending_tag" >&2
    echo "       drift count: $drift_count shipped-but-pending task(s)" >&2
    # Best-effort: extract reconciled task IDs from results[*].details.reconciled
    # arrays. Strings look like "T1411" (project-agnostic prefix).
    drifted_ids="$(printf '%s' "$json_out" \
      | tr -d '\n' \
      | grep -o '"reconciled"[[:space:]]*:[[:space:]]*\[[^]]*\]' \
      | grep -o '"[A-Za-z][A-Za-z0-9_-]*"' \
      | sort -u \
      | tr '\n' ' ' \
      || true)"
    if [ -n "$drifted_ids" ]; then
      echo "       drifted tasks: $drifted_ids" >&2
    fi
    echo "" >&2
    echo "Refuse push: run 'cleo reconcile release --tag $pending_tag' to" >&2
    echo "reconcile, or set CLEO_ALLOW_DRIFT_PUSH=1 (audited bypass)." >&2
    return 1
  fi

  return 0
}

# When sourced from the unified pre-push hook the function is invoked
# at the sentinel point. When run standalone (testing), invoke directly.
if [ "${T1595_SOURCED:-0}" != "1" ]; then
  reconcile_gate
fi
