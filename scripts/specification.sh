#!/usr/bin/env bash
###CLEO
# command: specification
# category: validation
# synopsis: Validate specification protocol compliance for specification writing tasks
# relevance: high
# flags: --format,--json,--human,--file,--task
# exits: 0,62
# json-output: true
# note: Part of Protocol Validation System - validates RFC 2119 keywords and version info
###END
# CLEO Specification Protocol Validation Command
# Validate specification protocol compliance for specification tasks
#
# @task T3005
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
COMMAND_NAME="specification"

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << 'EOF'
Usage: cleo specification <subcommand> [OPTIONS]

Validate specification protocol compliance for specification tasks.

Subcommands:
  validate <TASK_ID>     Validate specification protocol compliance for task
  check <MANIFEST_FILE>  Validate manifest entry directly

Options:
  --strict               Exit with error code on violations (default: false)
  --spec-file FILE       Path to specification file (for RFC 2119 check)
  --format FORMAT        Output format: json (default) or human
  --json                 Shortcut for --format json
  --human                Shortcut for --format human
  --help                 Show this help message

Validation Checks (SPEC-*):
  SPEC-001: RFC 2119 keywords present (MUST/SHOULD/MAY) (MUST)
  SPEC-002: Version field present (MUST)
  SPEC-003: Authority/scope section (SHOULD)
  SPEC-004: Conformance criteria documented (SHOULD)
  SPEC-005: Related specs documented (SHOULD)
  SPEC-006: Structured format (tables/code blocks) (SHOULD)
  SPEC-007: agent_type = "specification" (MUST)

Exit Codes:
  0:  Valid or non-strict mode
  62: Protocol violations (EXIT_PROTOCOL_SPECIFICATION) in strict mode

Examples:
  # Validate task's specification output
  cleo specification validate T1234

  # Check manifest entry with spec file
  cleo specification check manifest.json --spec-file docs/specs/SPEC.md

  # Strict mode (exit on violations)
  cleo specification validate T1234 --strict

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

# validate_task - Validate specification protocol for a task
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

    # Extract spec file path from manifest if not provided
    if [[ -z "${SPEC_FILE:-}" ]]; then
        SPEC_FILE=$(echo "$manifest_entry" | jq -r '.file // empty')
    fi

    # Validate specification protocol
    # Temporarily disable -e to capture both output and exit code
    set +e
    local result
    result=$(validate_specification_protocol "$task_id" "$manifest_entry" "$SPEC_FILE" "$STRICT")
    local exit_code=$?
    set -e

    # Output result
    echo "$result"

    # Propagate exit code in strict mode
    exit $exit_code
}

# check_manifest - Validate specification protocol from manifest file
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

    # Extract spec file path from manifest if not provided
    if [[ -z "${SPEC_FILE:-}" ]]; then
        SPEC_FILE=$(echo "$manifest_entry" | jq -r '.file // empty')
    fi

    # Validate specification protocol
    # Temporarily disable -e to capture both output and exit code
    set +e
    local result
    result=$(validate_specification_protocol "$task_id" "$manifest_entry" "$SPEC_FILE" "$STRICT")
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
SPEC_FILE=""
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
        --spec-file)
            SPEC_FILE="$2"
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
