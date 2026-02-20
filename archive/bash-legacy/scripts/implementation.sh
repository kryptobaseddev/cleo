#!/usr/bin/env bash
###CLEO
# command: implementation
# category: validation
# synopsis: Validate implementation protocol compliance for code implementation tasks
# relevance: high
# flags: --format,--json,--human,--file,--task
# exits: 0,64
# json-output: true
# note: Part of Protocol Validation System - validates @task tags on new functions
###END
# CLEO Implementation Protocol Validation Command
# Validate implementation protocol compliance for code execution tasks
#
# @task T3007
# LAYER: CLI Entry Point
# DEPENDS: lib/validation/protocol-validation.sh, lib/core/output-format.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source core libraries
source "$LIB_DIR/core/exit-codes.sh"
[[ -f "$LIB_DIR/core/output-format.sh" ]] && source "$LIB_DIR/core/output-format.sh"
[[ -f "$LIB_DIR/core/error-json.sh" ]] && source "$LIB_DIR/core/error-json.sh"
[[ -f "$LIB_DIR/ui/flags.sh" ]] && source "$LIB_DIR/ui/flags.sh"

# Source protocol validation library
source "$LIB_DIR/validation/protocol-validation.sh"

TODO_DIR="${TODO_DIR:-.cleo}"
COMMAND_NAME="implementation"

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << 'EOF'
Usage: cleo implementation <subcommand> [OPTIONS]

Validate implementation protocol compliance for code execution tasks.

Subcommands:
  validate <TASK_ID>     Validate implementation protocol compliance for task
  check <MANIFEST_FILE>  Validate manifest entry directly

Options:
  --strict               Exit with error code on violations (default: false)
  --format FORMAT        Output format: json (default) or human
  --json                 Shortcut for --format json
  --human                Shortcut for --format human
  --help                 Show this help message

Validation Checks (IMPL-*):
  IMPL-003: Provenance tags @task T#### in new code (MUST)
  IMPL-004: Tests must pass (delegated to CI) (MUST)
  IMPL-006: Style validation (delegated to linters) (SHOULD)
  IMPL-007: agent_type = "implementation" (MUST)

Exit Codes:
  0:  Valid or non-strict mode
  64: Protocol violations (EXIT_PROTOCOL_IMPLEMENTATION) in strict mode

Examples:
  # Validate task's implementation output
  cleo implementation validate T1234

  # Check manifest entry directly
  cleo implementation check manifest.json

  # Strict mode (exit on violations)
  cleo implementation validate T1234 --strict

Output:
  JSON with:
  - valid: true/false
  - violations: Array of violation objects
  - score: 0-100 compliance score

Note:
  Implementation protocol validates code execution work. Requires @task
  provenance tags for traceability and attribution tracking.
EOF
}

# ============================================================================
# SUBCOMMANDS
# ============================================================================

# validate_task - Validate implementation protocol for a task
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

    # Validate implementation protocol
    # Temporarily disable -e to capture both output and exit code
    set +e
    local result
    result=$(validate_implementation_protocol "$task_id" "$manifest_entry" "$STRICT")
    local exit_code=$?
    set -e

    # Output result
    echo "$result"

    # Propagate exit code in strict mode
    exit $exit_code
}

# check_manifest - Validate implementation protocol from manifest file
# Args: $1 = manifest_file
check_manifest() {
    local manifest_file="$1"

    if [[ ! -f "$manifest_file" ]]; then
        output_error "$E_FILE_NOT_FOUND" "Manifest file not found: $manifest_file" "$EXIT_NOT_FOUND" true
        exit "$EXIT_NOT_FOUND"
    fi

    local manifest_entry
    manifest_entry=$(cat "$manifest_file")

    # Extract task ID from manifest
    local task_id
    task_id=$(echo "$manifest_entry" | jq -r '.linked_tasks[0] // "UNKNOWN"')

    # Validate implementation protocol
    # Temporarily disable -e to capture both output and exit code
    set +e
    local result
    result=$(validate_implementation_protocol "$task_id" "$manifest_entry" "$STRICT")
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
