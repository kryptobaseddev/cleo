#!/usr/bin/env bash
###CLEO
# command: decomposition
# category: validation
# synopsis: Validate decomposition protocol compliance for epic breakdown tasks
# relevance: high
# flags: --format,--json,--human,--file,--task
# exits: 0,63
# json-output: true
# note: Part of Protocol Validation System - validates sibling limits and clear descriptions
###END
# CLEO Decomposition Protocol Validation Command
# Validate decomposition protocol compliance for epic breakdown tasks
#
# @task T3006
# LAYER: CLI Entry Point
# DEPENDS: lib/protocol-validation.sh, lib/output-format.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source core libraries
source "$LIB_DIR/exit-codes.sh"
[[ -f "$LIB_DIR/output-format.sh" ]] && source "$LIB_DIR/output-format.sh"
[[ -f "$LIB_DIR/error-json.sh" ]] && source "$LIB_DIR/error-json.sh"
[[ -f "$LIB_DIR/flags.sh" ]] && source "$LIB_DIR/flags.sh"

# Source protocol validation library
source "$LIB_DIR/protocol-validation.sh"

TODO_DIR="${TODO_DIR:-.cleo}"
COMMAND_NAME="decomposition"

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << 'EOF'
Usage: cleo decomposition <subcommand> [OPTIONS]

Validate decomposition protocol compliance for epic breakdown tasks.

Subcommands:
  validate <TASK_ID>     Validate decomposition protocol compliance for task
  check <MANIFEST_FILE>  Validate manifest entry directly

Options:
  --strict               Exit with error code on violations (default: false)
  --epic ID              Specify parent epic ID
  --format FORMAT        Output format: json (default) or human
  --json                 Shortcut for --format json
  --human                Shortcut for --format human
  --help                 Show this help message

Validation Checks (DCMP-*):
  DCMP-001: MECE validation (Mutually Exclusive, Collectively Exhaustive) (SHOULD)
  DCMP-002: Valid dependency graph (no cycles) (MUST)
  DCMP-003: Max depth 3 (epic→task→subtask) (MUST)
  DCMP-004: Atomicity test (6 criteria) (SHOULD)
  DCMP-005: No time estimates (MUST NOT)
  DCMP-006: Max 7 siblings per parent (MUST)
  DCMP-007: agent_type = "specification" (MUST)

Exit Codes:
  0:  Valid or non-strict mode
  63: Protocol violations (EXIT_PROTOCOL_DECOMPOSITION) in strict mode

Examples:
  # Validate task's decomposition output
  cleo decomposition validate T1234

  # Check manifest entry with epic context
  cleo decomposition check manifest.json --epic T1000

  # Strict mode (exit on violations)
  cleo decomposition validate T1234 --strict

Output:
  JSON with:
  - valid: true/false
  - violations: Array of violation objects
  - score: 0-100 compliance score

Note:
  Decomposition protocol validates epic breakdowns for MECE compliance,
  atomicity, and hierarchy constraints. Enforces max 7 siblings rule.
EOF
}

# ============================================================================
# SUBCOMMANDS
# ============================================================================

# validate_task - Validate decomposition protocol for a task
# Args: $1 = task_id
validate_task() {
    local task_id="$1"
    local manifest_path="claudedocs/agent-outputs/MANIFEST.jsonl"

    # Find manifest entry for task
    if [[ ! -f "$manifest_path" ]]; then
        output_error "$E_FILE_NOT_FOUND" "Manifest not found: $manifest_path" "$EXIT_NOT_FOUND" true
        exit "$EXIT_NOT_FOUND"
    fi

    local manifest_entry
    manifest_entry=$(grep "\"linked_tasks\".*\"$task_id\"" "$manifest_path" | tail -1 || true)

    if [[ -z "$manifest_entry" ]]; then
        output_error "$E_TASK_NOT_FOUND" "No manifest entry found for task $task_id" "$EXIT_NOT_FOUND" true
        exit "$EXIT_NOT_FOUND"
    fi

    # Get epic ID (from flag or extract from manifest)
    local epic_id="${EPIC_ID:-}"
    if [[ -z "$epic_id" ]]; then
        epic_id=$(echo "$manifest_entry" | jq -r '.linked_tasks[0] // "UNKNOWN"')
    fi

    # Load child tasks from todo.json if available
    local child_tasks="[]"
    if [[ -f "$TODO_DIR/todo.json" ]]; then
        # Extract tasks that have this task as parent
        child_tasks=$(jq --arg parent "$epic_id" '[.tasks[] | select(.parent == $parent)]' "$TODO_DIR/todo.json" 2>/dev/null || echo "[]")
    fi

    # Validate decomposition protocol
    # Temporarily disable -e to capture both output and exit code
    set +e
    local result
    result=$(validate_decomposition_protocol "$task_id" "$epic_id" "$child_tasks" "$STRICT")
    local exit_code=$?
    set -e

    # Output result
    echo "$result"

    # Propagate exit code in strict mode
    exit $exit_code
}

# check_manifest - Validate decomposition protocol from manifest file
# Args: $1 = manifest_file
check_manifest() {
    local manifest_file="$1"

    if [[ ! -f "$manifest_file" ]]; then
        error_exit $EXIT_NOT_FOUND "Manifest file not found: $manifest_file"
    fi

    local manifest_entry
    manifest_entry=$(cat "$manifest_file")

    # Extract task ID and epic ID from manifest
    local task_id epic_id
    task_id=$(echo "$manifest_entry" | jq -r '.linked_tasks[0] // "UNKNOWN"')

    # Use provided epic ID or extract from manifest
    epic_id="${EPIC_ID:-}"
    if [[ -z "$epic_id" ]]; then
        epic_id=$(echo "$manifest_entry" | jq -r '.linked_tasks[0] // "UNKNOWN"')
    fi

    # Load child tasks from todo.json if available
    local child_tasks="[]"
    if [[ -f "$TODO_DIR/todo.json" ]]; then
        child_tasks=$(jq --arg parent "$epic_id" '[.tasks[] | select(.parent == $parent)]' "$TODO_DIR/todo.json" 2>/dev/null || echo "[]")
    fi

    # Validate decomposition protocol
    # Temporarily disable -e to capture both output and exit code
    set +e
    local result
    result=$(validate_decomposition_protocol "$task_id" "$epic_id" "$child_tasks" "$STRICT")
    local exit_code=$?
    set -e

    # Output result
    echo "$result"

    # Propagate exit code in strict mode
    exit $exit_code
}

# ============================================================================
# MAIN
# ============================================================================

# Parse flags
STRICT="false"
EPIC_ID=""
OUTPUT_FORMAT="json"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            usage
            exit 0
            ;;
        --strict)
            STRICT="true"
            shift
            ;;
        --epic)
            EPIC_ID="$2"
            shift 2
            ;;
        --format)
            OUTPUT_FORMAT="$2"
            shift 2
            ;;
        --json)
            OUTPUT_FORMAT="json"
            shift
            ;;
        --human)
            OUTPUT_FORMAT="human"
            shift
            ;;
        validate|check)
            SUBCOMMAND="$1"
            shift
            break
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage
            exit 1
            ;;
    esac
done

# Execute subcommand
case "${SUBCOMMAND:-}" in
    validate)
        if [[ $# -lt 1 ]]; then
            echo "Error: validate requires TASK_ID" >&2
            usage
            exit 1
        fi
        validate_task "$1"
        ;;
    check)
        if [[ $# -lt 1 ]]; then
            echo "Error: check requires MANIFEST_FILE" >&2
            usage
            exit 1
        fi
        check_manifest "$1"
        ;;
    "")
        echo "Error: subcommand required" >&2
        usage
        exit 1
        ;;
    *)
        echo "Unknown subcommand: $SUBCOMMAND" >&2
        usage
        exit 1
        ;;
esac
