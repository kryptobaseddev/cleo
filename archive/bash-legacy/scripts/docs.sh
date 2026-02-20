#!/usr/bin/env bash
###CLEO
# command: docs
# category: maintenance
# synopsis: Documentation management: drift detection and gap validation for knowledge transfer
# relevance: medium
# flags: --quick,--full,--strict,--json,--human,--epic,--task,--all-review
# exits: 0,1,2
# json-output: true
# subcommands: sync,gap-check
# note: Part of documentation lifecycle - ensures knowledge transfer from research outputs to canonical docs
###END
# CLEO Documentation Management
# Detect and fix documentation drift
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Command name for error handling
COMMAND_NAME="docs"

# Source libraries
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source error-json library for standardized output
if [[ -f "$LIB_DIR/core/error-json.sh" ]]; then
    # shellcheck source=../lib/core/error-json.sh
    source "$LIB_DIR/core/error-json.sh"
fi

# Source flags library for standardized flag parsing
if [[ -f "$LIB_DIR/ui/flags.sh" ]]; then
    # shellcheck source=../lib/ui/flags.sh
    source "$LIB_DIR/ui/flags.sh"
fi

# Source docs-sync library
if [[ -f "$LIB_DIR/validation/docs-sync.sh" ]]; then
    # shellcheck source=../lib/validation/docs-sync.sh
    source "$LIB_DIR/validation/docs-sync.sh"
fi

# Source gap-check library
if [[ -f "$LIB_DIR/validation/gap-check.sh" ]]; then
    # shellcheck source=../lib/validation/gap-check.sh
    source "$LIB_DIR/validation/gap-check.sh"
fi

# Source output-format library for JSON output
if [[ -f "$LIB_DIR/core/output-format.sh" ]]; then
    # shellcheck source=../lib/core/output-format.sh
    source "$LIB_DIR/core/output-format.sh"
fi

# ============================================================================
# USAGE
# ============================================================================

show_usage() {
    cat << EOF
Usage: cleo docs <subcommand> [options]

Subcommands:
  sync            Run drift detection (checks scripts vs docs)
  gap-check       Validate knowledge transfer from review docs to canonical docs

Sync Options:
  --quick         Quick check (commands only)
  --full          Full check (default)
  --strict        Exit with error on any drift
  --json          JSON output

Gap-Check Options:
  --epic <id>     Filter by epic ID
  --task <id>     Filter by task ID
  --all-review    Check all review docs (default)
  --json          JSON output (default)
  --human         Human-readable output

Examples:
  cleo docs sync              # Full drift detection
  cleo docs sync --quick      # Quick check
  cleo docs sync --strict     # Fail on warnings
  cleo docs gap-check         # Check all review docs
  cleo docs gap-check --epic T2526 --human  # Epic-specific check

Description:
  The docs command maintains documentation synchronization:
  - Detects drift between scripts/ and COMMANDS-INDEX.json
  - Validates wrapper template completeness
  - Checks critical commands in README
  - (Future) Knowledge transfer validation

See also: cleo upgrade (updates documentation)
EOF
}

# ============================================================================
# DRIFT DETECTION (sync subcommand)
# ============================================================================

run_sync() {
    local mode="full"
    local strict=false
    local json_output=false

    # Parse flags
    while [[ $# -gt 0 ]]; do
        case $1 in
            --quick) mode="quick"; shift ;;
            --full) mode="full"; shift ;;
            --strict) strict=true; shift ;;
            --json) json_output=true; shift ;;
            -h|--help) show_usage; exit 0 ;;
            *) echo "Unknown option: $1" >&2; show_usage; exit 1 ;;
        esac
    done

    # Detect drift using library function
    local drift_code=0
    if ! detect_drift "$mode" "$PROJECT_ROOT" 2>/dev/null; then
        drift_code=$?
    fi

    # Output results
    if [[ "$json_output" == "true" ]]; then
        # JSON output
        local status="clean"
        local message="No drift detected"

        if [[ $drift_code -eq 2 ]]; then
            status="error"
            message="Critical drift detected"
        elif [[ $drift_code -eq 1 ]]; then
            status="warning"
            message="Drift warnings detected"
        fi

        cat << EOF
{
  "\$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "command": "docs sync",
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "version": "$(cat "$PROJECT_ROOT/VERSION" 2>/dev/null || echo "unknown")"
  },
  "success": $([ $drift_code -eq 0 ] && echo "true" || echo "false"),
  "status": "$status",
  "message": "$message",
  "driftCode": $drift_code
}
EOF
    else
        # Human-readable output
        if [[ $drift_code -eq 0 ]]; then
            echo "✓ Documentation is in sync"
        elif [[ $drift_code -eq 1 ]]; then
            echo "⚠ Documentation drift detected (warnings)"
            echo "Run: ./dev/skills/ct-docs-sync/scripts/detect-drift.sh --full --recommend"
        elif [[ $drift_code -eq 2 ]]; then
            echo "✗ Critical documentation drift detected"
            echo "Run: ./dev/skills/ct-docs-sync/scripts/detect-drift.sh --full --recommend"
        fi
    fi

    # Exit with appropriate code
    if [[ "$strict" == "true" && $drift_code -gt 0 ]]; then
        exit $drift_code
    fi

    exit 0
}

# ============================================================================
# GAP-CHECK (implementation from T2530)
# ============================================================================

run_gap_check() {
    local filter_id=""
    local format="json"

    # Parse flags
    while [[ $# -gt 0 ]]; do
        case $1 in
            --epic)
                filter_id="$2"
                shift 2
                ;;
            --task)
                filter_id="$2"
                shift 2
                ;;
            --all-review)
                filter_id=""
                shift
                ;;
            --json)
                format="json"
                shift
                ;;
            --human)
                format="human"
                shift
                ;;
            -h|--help)
                show_usage
                exit 0
                ;;
            *)
                echo "Unknown option: $1" >&2
                show_usage
                exit 1
                ;;
        esac
    done

    # Run gap validation
    # Use PWD to support test environments with different project roots
    gap_check_validate "$filter_id" "$format" "${CLEO_PROJECT_ROOT:-$(pwd)}"
    exit $?
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    if [[ $# -eq 0 ]]; then
        show_usage
        exit 1
    fi

    local subcommand="$1"
    shift

    case "$subcommand" in
        sync)
            run_sync "$@"
            ;;
        gap-check)
            run_gap_check "$@"
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            echo "Unknown subcommand: $subcommand" >&2
            show_usage
            exit 1
            ;;
    esac
}

main "$@"
