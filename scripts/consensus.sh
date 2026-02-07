#!/usr/bin/env bash
###CLEO
# command: consensus
# category: validation
# synopsis: Validate consensus protocol compliance for multi-agent decision tasks
# relevance: high
# flags: --format,--json,--human,--file,--task
# exits: 0,60,61
# json-output: true
# note: Part of Protocol Validation System - validates voting matrices and confidence scores
###END
# CLEO Consensus Protocol Validation Command
# Validate consensus protocol compliance for multi-agent decision tasks
#
# @task T2999
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
COMMAND_NAME="consensus"

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << 'EOF'
Usage: cleo consensus <subcommand> [OPTIONS]

Validate consensus protocol compliance for multi-agent decision tasks.

Subcommands:
  validate <TASK_ID>     Validate consensus protocol compliance for task
  check <MANIFEST_FILE>  Validate manifest entry directly

Options:
  --strict               Exit with error code on violations (default: false)
  --voting-matrix FILE   Path to voting matrix JSON file
  --format FORMAT        Output format: json (default) or human
  --json                 Shortcut for --format json
  --human                Shortcut for --format human
  --help                 Show this help message

Validation Checks (CONS-*):
  CONS-001: Voting matrix with ≥2 options (MUST)
  CONS-003: Confidence scores 0.0-1.0 (MUST)
  CONS-004: Threshold met (50% minimum) (MUST)
  CONS-007: agent_type = "analysis" (MUST)

Exit Codes:
  0:  Valid or non-strict mode
  61: Protocol violations (EXIT_PROTOCOL_CONSENSUS) in strict mode

Examples:
  # Validate task's consensus output
  cleo consensus validate T1234

  # Check manifest entry with voting matrix
  cleo consensus check manifest.json --voting-matrix votes.json

  # Strict mode (exit on violations)
  cleo consensus validate T1234 --strict

Output:
  JSON with:
  - valid: true/false
  - violations: Array of violation objects
  - score: 0-100 compliance score
EOF
}

# ============================================================================
# SUBCOMMANDS
# ============================================================================

# validate_task - Validate consensus protocol for a task
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

    # Load voting matrix if provided
    local voting_matrix="{}"
    if [[ -n "${VOTING_MATRIX_FILE:-}" && -f "$VOTING_MATRIX_FILE" ]]; then
        voting_matrix=$(cat "$VOTING_MATRIX_FILE")
    fi

    # Validate consensus protocol
    # Temporarily disable -e to capture both output and exit code
    set +e
    local result
    result=$(validate_consensus_protocol "$task_id" "$manifest_entry" "$voting_matrix" "$STRICT")
    local exit_code=$?
    set -e

    # Output result
    echo "$result"

    # Propagate exit code in strict mode
    exit $exit_code
}

# check_manifest - Validate consensus protocol from manifest file
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

    # Load voting matrix if provided
    local voting_matrix="{}"
    if [[ -n "${VOTING_MATRIX_FILE:-}" && -f "$VOTING_MATRIX_FILE" ]]; then
        voting_matrix=$(cat "$VOTING_MATRIX_FILE")
    fi

    # Validate consensus protocol
    # Temporarily disable -e to capture both output and exit code
    set +e
    local result
    result=$(validate_consensus_protocol "$task_id" "$manifest_entry" "$voting_matrix" "$STRICT")
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
VOTING_MATRIX_FILE=""
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
        --voting-matrix)
            VOTING_MATRIX_FILE="$2"
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
