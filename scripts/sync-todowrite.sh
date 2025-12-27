#!/usr/bin/env bash
# =============================================================================
# sync-todowrite.sh - Orchestrate TodoWrite bidirectional sync
# =============================================================================
# Main entry point for cleo ↔ TodoWrite synchronization.
# Coordinates inject (session start) and extract (session end) operations.
#
# Research: T227 (todowrite-sync-research.md)
#
# Usage:
#   cleo sync --inject [OPTIONS]     # Session start: prepare tasks
#   cleo sync --extract [FILE]       # Session end: merge changes
#   cleo sync --status               # Show sync state
#
# This script is registered in the main CLI dispatcher.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"
COMMAND_NAME="sync"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Load VERSION from central location
if [[ -f "${SCRIPT_DIR}/../VERSION" ]]; then
    VERSION=$(cat "${SCRIPT_DIR}/../VERSION")
elif [[ -f "${CLEO_HOME}/VERSION" ]]; then
    VERSION=$(cat "${CLEO_HOME}/VERSION")
else
    VERSION="0.36.0"
fi

# ============================================================================
# LIBRARY LOADING
# ============================================================================

# Source exit codes library (Layer 0 - Foundation)
if [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
    # shellcheck source=../lib/exit-codes.sh
    source "$LIB_DIR/exit-codes.sh"
fi

# Source output formatting library
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
    # shellcheck source=../lib/output-format.sh
    source "$LIB_DIR/output-format.sh"
fi

# Source error JSON library
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
    # shellcheck source=../lib/error-json.sh
    source "$LIB_DIR/error-json.sh"
fi

# Source validation library for input validation
if [[ -f "$LIB_DIR/validation.sh" ]]; then
    # shellcheck source=../lib/validation.sh
    source "$LIB_DIR/validation.sh"
fi

# Fallback exit codes if library not loaded
: "${EXIT_SUCCESS:=0}"
: "${EXIT_GENERAL_ERROR:=1}"
: "${EXIT_INVALID_INPUT:=2}"
: "${EXIT_FILE_ERROR:=3}"
: "${EXIT_NOT_FOUND:=4}"
: "${EXIT_NO_CHANGE:=102}"

# Fallback error codes
: "${E_INPUT_MISSING:=E_INPUT_MISSING}"
: "${E_INPUT_INVALID:=E_INPUT_INVALID}"
: "${E_FILE:=E_FILE}"

# =============================================================================
# Colors and Logging
# =============================================================================
if [[ -z "${NO_COLOR:-}" && -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' NC=''
fi

log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_warn() { [[ "${QUIET:-false}" != "true" ]] && echo -e "${YELLOW}[WARN]${NC} $1" >&2 || true; }
log_info() { [[ "${QUIET:-false}" != "true" ]] && echo -e "${GREEN}[INFO]${NC} $1" >&2 || true; }

# =============================================================================
# Configuration
# =============================================================================
SYNC_DIR=".cleo/sync"
STATE_FILE="${SYNC_DIR}/todowrite-session.json"

# Output options
FORMAT=""
QUIET=false
DRY_RUN=false

# Subcommand
SUBCOMMAND=""

# =============================================================================
# Help
# =============================================================================
show_help() {
    cat << 'EOF'
sync-todowrite.sh - TodoWrite bidirectional synchronization

USAGE
    cleo sync <subcommand> [OPTIONS]

SUBCOMMANDS
    --inject          Prepare tasks for TodoWrite (session start)
    --extract FILE    Merge TodoWrite state back (session end)
    --status          Show current sync state
    --clear           Clear sync state without merging

INJECT OPTIONS
    --max-tasks N     Maximum tasks to inject (default: 8)
    --focused-only    Only inject the focused task
    --output FILE     Write to file instead of stdout
    --quiet, -q       Suppress info messages

EXTRACT OPTIONS
    --default-phase SLUG  Override default phase for new tasks
    --dry-run             Preview changes without applying
    --quiet, -q           Suppress info messages

GLOBAL OPTIONS
    --format, -f      Output format: text (default) or json
    --json            Shorthand for --format json
    --human           Shorthand for --format text
    --quiet, -q       Suppress info messages

WORKFLOW
    1. Session Start:  cleo sync --inject
       → Outputs TodoWrite JSON
       → Saves session state for round-trip

    2. During Session: Claude uses TodoWrite normally

    3. Session End:    cleo sync --extract <state.json>
       → Parses TodoWrite state
       → Marks completed tasks as done
       → Creates new tasks
       → Clears session state

EXAMPLES
    # Start session - inject tasks to TodoWrite format
    cleo sync --inject

    # End session - extract and merge changes
    cleo sync --extract /tmp/todowrite-state.json

    # Check if sync state exists
    cleo sync --status

    # Clear stale sync state
    cleo sync --clear

EOF
    exit "$EXIT_SUCCESS"
}

# =============================================================================
# Subcommand Handlers
# =============================================================================

handle_inject() {
    shift  # Remove --inject
    exec "$SCRIPT_DIR/inject-todowrite.sh" "$@"
}

handle_extract() {
    shift  # Remove --extract
    exec "$SCRIPT_DIR/extract-todowrite.sh" "$@"
}

handle_status() {
    if [[ ! -f "$STATE_FILE" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp version
            timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
            version=$(cat "${SCRIPT_DIR}/../VERSION" 2>/dev/null || echo "0.15.0")
            jq -n \
                --arg version "$version" \
                --arg timestamp "$timestamp" \
                --arg state_file "$STATE_FILE" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "format": "json",
                        "version": $version,
                        "command": "sync",
                        "subcommand": "status",
                        "timestamp": $timestamp
                    },
                    "success": true,
                    "active": false,
                    "state_file": $state_file,
                    "message": "No active sync session"
                }'
        else
            log_info "No active sync session"
            echo ""
            echo "State file: $STATE_FILE (not found)"
        fi
        exit "$EXIT_SUCCESS"
    fi

    local session_id=$(jq -r '.session_id // "unknown"' "$STATE_FILE")
    local injected_at=$(jq -r '.injected_at // "unknown"' "$STATE_FILE")
    local injected_phase=$(jq -r '.injectedPhase // "none"' "$STATE_FILE")
    local task_count=$(jq '.injected_tasks | length' "$STATE_FILE")
    local task_ids_json=$(jq '.injected_tasks' "$STATE_FILE")
    local task_ids=$(jq -r '.injected_tasks | join(", ")' "$STATE_FILE")

    # Get phase distribution if metadata exists
    local phases_json="null"
    if jq -e '.task_metadata' "$STATE_FILE" >/dev/null 2>&1; then
        phases_json=$(jq '[.task_metadata[] | .phase // "unknown"] | group_by(.) | map({phase: .[0], count: length})' "$STATE_FILE")
    fi

    if [[ "$FORMAT" == "json" ]]; then
        local timestamp version
        timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        version=$(cat "${SCRIPT_DIR}/../VERSION" 2>/dev/null || echo "0.15.0")
        jq -n \
            --arg version "$version" \
            --arg timestamp "$timestamp" \
            --arg state_file "$STATE_FILE" \
            --arg session_id "$session_id" \
            --arg injected_at "$injected_at" \
            --arg injected_phase "$injected_phase" \
            --argjson task_count "$task_count" \
            --argjson task_ids "$task_ids_json" \
            --argjson phases "$phases_json" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": "sync",
                    "subcommand": "status",
                    "timestamp": $timestamp
                },
                "success": true,
                "active": true,
                "session_id": $session_id,
                "injected_at": $injected_at,
                "injected_phase": $injected_phase,
                "task_count": $task_count,
                "task_ids": $task_ids,
                "phases": $phases,
                "state_file": $state_file
            }'
    else
        log_info "Active sync session found"
        echo ""

        echo "Session ID:    $session_id"
        echo "Injected at:   $injected_at"
        echo "Injected phase: $injected_phase"
        echo "Task count:    $task_count"
        echo "Task IDs:      $task_ids"

        # Show phase distribution if metadata exists
        if [[ "$phases_json" != "null" ]]; then
            local phases
            phases=$(jq -r '[.task_metadata[] | .phase // "unknown"] | group_by(.) | map("\(.[0]): \(length)") | join(", ")' "$STATE_FILE")
            echo "Phases:        $phases"
        fi

        echo ""
        echo "State file:    $STATE_FILE"
    fi
}

handle_clear() {
    if [[ ! -f "$STATE_FILE" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp version
            timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
            version=$(cat "${SCRIPT_DIR}/../VERSION" 2>/dev/null || echo "0.15.0")
            jq -n \
                --arg version "$version" \
                --arg timestamp "$timestamp" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "format": "json",
                        "version": $version,
                        "command": "sync",
                        "subcommand": "clear",
                        "timestamp": $timestamp
                    },
                    "success": true,
                    "noChange": true,
                    "message": "No sync state to clear"
                }'
        else
            log_info "No sync state to clear"
        fi
        exit "$EXIT_NO_CHANGE"
    fi

    if [[ "$DRY_RUN" == true ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp version
            timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
            version=$(cat "${SCRIPT_DIR}/../VERSION" 2>/dev/null || echo "0.15.0")
            jq -n \
                --arg version "$version" \
                --arg timestamp "$timestamp" \
                --arg state_file "$STATE_FILE" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "format": "json",
                        "version": $version,
                        "command": "sync",
                        "subcommand": "clear",
                        "timestamp": $timestamp
                    },
                    "success": true,
                    "dryRun": true,
                    "wouldDelete": {
                        "stateFile": $state_file,
                        "syncDirectory": ".cleo/sync"
                    },
                    "message": "Would clear sync state"
                }'
        else
            log_info "[DRY-RUN] Would clear sync state: $STATE_FILE"
        fi
        exit "$EXIT_SUCCESS"
    fi

    rm -f "$STATE_FILE"

    if [[ "$FORMAT" == "json" ]]; then
        local timestamp version
        timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        version=$(cat "${SCRIPT_DIR}/../VERSION" 2>/dev/null || echo "0.15.0")
        jq -n \
            --arg version "$version" \
            --arg timestamp "$timestamp" \
            --arg state_file "$STATE_FILE" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": "sync",
                    "subcommand": "clear",
                    "timestamp": $timestamp
                },
                "success": true,
                "cleared": {
                    "stateFile": $state_file
                },
                "message": "Sync state cleared"
            }'
    else
        log_info "Sync state cleared"
    fi

    # Also clean up sync directory if empty
    rmdir "$SYNC_DIR" 2>/dev/null || true

    exit "$EXIT_SUCCESS"
}

# =============================================================================
# Main
# =============================================================================
main() {
    # Need at least one argument
    if [[ $# -eq 0 ]]; then
        show_help
    fi

    # Parse global options first, then subcommand
    local args=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -f|--format)
                FORMAT="$2"
                shift 2
                ;;
            --json)
                FORMAT="json"
                shift
                ;;
            --human)
                FORMAT="text"
                shift
                ;;
            -q|--quiet)
                QUIET=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            *)
                args+=("$1")
                shift
                ;;
        esac
    done

    # Restore positional arguments
    set -- "${args[@]+"${args[@]}"}"

    # Resolve format (TTY-aware auto-detection)
    if declare -f resolve_format >/dev/null 2>&1; then
        FORMAT=$(resolve_format "${FORMAT:-}" true "text,json")
    else
        FORMAT="${FORMAT:-json}"
    fi

    # Need at least one argument after parsing global options
    if [[ $# -eq 0 ]]; then
        show_help
    fi

    # Parse subcommand
    case "$1" in
        --inject|-i)
            # Pass --dry-run to inject subcommand if set
            if [[ "$DRY_RUN" == true ]]; then
                handle_inject "$@" --dry-run
            else
                handle_inject "$@"
            fi
            ;;
        --extract|-e)
            # Pass --dry-run to extract subcommand if set
            if [[ "$DRY_RUN" == true ]]; then
                handle_extract "$@" --dry-run
            else
                handle_extract "$@"
            fi
            ;;
        --status|-s)
            handle_status
            ;;
        --clear|-c)
            handle_clear
            ;;
        --help|-h)
            show_help
            ;;
        *)
            if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                output_error "$E_INPUT_INVALID" "Unknown subcommand '$1'. Valid subcommands: --inject, --extract, --status, --clear" "$EXIT_INVALID_INPUT" true "Use 'cleo sync --help' for usage information"
            else
                log_error "Unknown subcommand: $1"
                echo "" >&2
                echo "Valid subcommands: --inject, --extract, --status, --clear" >&2
                echo "Use 'cleo sync --help' for usage" >&2
            fi
            exit "$EXIT_INVALID_INPUT"
            ;;
    esac
}

main "$@"
