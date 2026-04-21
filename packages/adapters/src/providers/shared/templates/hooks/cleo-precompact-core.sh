#!/usr/bin/env bash
# CLEO PreCompact Core — Shared universal logic (provider-neutral)
#
# This helper performs the provider-agnostic work for a pre-compact hook:
#   1. Locate the CLEO project directory (walks up from $PWD looking for .cleo/)
#   2. Resolve the `cleo` CLI binary
#   3. Invoke `cleo memory precompact-flush` to drain pending observations + checkpoint WAL
#   4. Invoke `cleo safestop --reason precompact-emergency --commit --handoff <file>`
#   5. Emit a human-readable summary to stderr
#
# This script is intentionally INVOKED via the CLEO CLI only — it never
# reaches into core internals. Provider-specific hook shims (Claude Code's
# `precompact-safestop.sh`, Cursor's `precompact.sh`, etc.) source this file
# and then perform any provider-specific banner/exit handling.
#
# INSTALLATION:
#   Provider-specific installers copy this file alongside the provider shim
#   to the target hooks directory. See:
#     - packages/adapters/src/providers/claude-code/templates/hooks/
#     - packages/adapters/src/providers/cursor/templates/hooks/
#     - packages/adapters/src/providers/opencode/templates/hooks/
#
# Exit code: always 0 (hook must never block the provider's compaction path).
#
# Environment overrides:
#   CLEO_PROJECT_DIR  — absolute path to .cleo/ (skips upward search)
#   CLEO_HOME         — CLEO install root (controls default cleo binary lookup)
#
# @task T1013

set -euo pipefail

# ---------------------------------------------------------------------------
# 1. Locate the CLEO project directory
# ---------------------------------------------------------------------------
cleo_core_find_dir() {
    local dir="$PWD"
    while [[ "$dir" != "/" ]]; do
        if [[ -d "$dir/.cleo" ]]; then
            echo "$dir/.cleo"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    echo ""
}

# ---------------------------------------------------------------------------
# 2. Resolve the cleo CLI binary
# ---------------------------------------------------------------------------
cleo_core_find_cli() {
    local candidate="${CLEO_HOME:-$HOME/.cleo}/bin/cleo"
    if [[ -x "$candidate" ]]; then
        echo "$candidate"
        return 0
    fi
    command -v cleo 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# 3. Append a timestamped log line to ${CLEO_DIR}/safestop.log (best-effort)
# ---------------------------------------------------------------------------
cleo_core_log() {
    local message="$1"
    local log_file="$2"
    local timestamp
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "[$timestamp] $message" >> "$log_file" 2>/dev/null || true
    echo "[CLEO] $message" >&2
}

# ---------------------------------------------------------------------------
# 4. Main entrypoint — runs the flush + safestop sequence
#
# Usage: cleo_core_run_precompact "<reason>"
#        Emits a `$CLEO_PRECOMPACT_HANDOFF` env var in the caller's shell
#        pointing at the handoff JSON file (empty string if not produced).
# ---------------------------------------------------------------------------
cleo_core_run_precompact() {
    local reason="${1:-precompact-emergency}"
    local cleo_dir="${CLEO_PROJECT_DIR:-$(cleo_core_find_dir)}"
    local session_file="${cleo_dir:-.cleo}/.current-session"
    local log_file="${cleo_dir:-.cleo}/safestop.log"

    CLEO_PRECOMPACT_HANDOFF=""
    CLEO_PRECOMPACT_SESSION_ID=""

    if [[ -z "$cleo_dir" ]] || [[ ! -f "$session_file" ]]; then
        # No CLEO project here — silent no-op so we never interfere with the host.
        if [[ -n "$cleo_dir" ]]; then
            cleo_core_log "PreCompact triggered but no active CLEO session" "$log_file"
        fi
        return 0
    fi

    local session_id
    session_id=$(cat "$session_file" 2>/dev/null || echo "")
    if [[ -z "$session_id" ]]; then
        cleo_core_log "PreCompact triggered but session file empty" "$log_file"
        return 0
    fi

    CLEO_PRECOMPACT_SESSION_ID="$session_id"
    cleo_core_log "PreCompact triggered — initiating emergency safestop (reason=$reason)" "$log_file"

    local cleo_cmd
    cleo_cmd=$(cleo_core_find_cli)
    if [[ -z "$cleo_cmd" ]] || [[ ! -x "$cleo_cmd" ]]; then
        cleo_core_log "ERROR: cleo command not found — cannot perform safestop" "$log_file"
        return 0
    fi

    # Step 1 — flush in-flight observations + checkpoint WAL before the compaction boundary.
    # Invokes: cleo memory precompact-flush (T1004).
    "$cleo_cmd" memory precompact-flush 2>&1 | tee -a "$log_file" || true

    # Step 2 — run safestop with the emergency reason.
    local handoff_file="${cleo_dir}/handoff-emergency-$(date +%s).json"
    "$cleo_cmd" safestop \
        --reason "$reason" \
        --commit \
        --handoff "$handoff_file" \
        2>&1 | tee -a "$log_file" || true

    cleo_core_log "Emergency safestop completed. Handoff: $handoff_file" "$log_file"
    CLEO_PRECOMPACT_HANDOFF="$handoff_file"
    return 0
}
