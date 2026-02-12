#!/usr/bin/env bash
###CLEO
# command: sequence
# category: maintenance
# synopsis: Inspect and manage task ID sequence (show/check/repair)
# relevance: high
# flags: --format,--json,--human,--quiet,--verbose
# exits: 0,4,6,20,22
# json-output: true
# subcommands: show,check,repair
# note: Part of ID Integrity System - verify sequence before adding tasks
###END
# CLEO Sequence Command
# Inspect and manage task ID sequence system
#
# Subcommands:
#   show   - Display current sequence state (counter, lastId, checksum)
#   check  - Verify counter >= max(todo + archive), non-destructive
#   repair - Reset counter to max + 1 if behind
#
# Exit codes:
#   0  - Success (check: sequence is valid)
#   4  - Sequence file not found (show/check without --repair)
#   6  - Validation error (checksum mismatch, parse error)
#   20 - Checksum mismatch (check found corruption)
#   22 - ID collision detected (counter behind max ID)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source required libraries
source "$LIB_DIR/core/exit-codes.sh"
source "$LIB_DIR/core/output-format.sh"
source "$LIB_DIR/core/error-json.sh"
source "$LIB_DIR/core/sequence.sh"
source "$LIB_DIR/core/paths.sh"

# Source centralized flag parsing
source "$LIB_DIR/ui/flags.sh"

# Get version
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
if [[ -f "$CLEO_HOME/VERSION" ]]; then
    VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
    VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
    VERSION="0.51.2"
fi

# Defaults
SUBCOMMAND=""
FORMAT=""
QUIET=false
VERBOSE=false
COMMAND_NAME="sequence"

# Colors
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    DIM='\033[2m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' CYAN='' DIM='' NC=''
fi

usage() {
    cat << EOF
Usage: cleo sequence <subcommand> [OPTIONS]

Inspect and manage task ID sequence system.

Subcommands:
  show      Display current sequence state (counter, lastId, checksum)
  check     Verify counter >= max(todo + archive) without modifications
  repair    Reset counter to max + 1 if behind

Options:
  -f, --format FMT   Output format: text, json (default: auto-detect)
  --human            Force human-readable text output
  --json             Force JSON output
  -q, --quiet        Suppress non-essential output
  -v, --verbose      Show detailed output
  -h, --help         Show this help

Exit Codes:
  0   Success (for check: sequence is valid)
  4   Sequence file not found
  6   Validation error (parse error, invalid data)
  20  Checksum mismatch detected
  22  Counter behind max ID (sequence drift detected)

Examples:
  cleo sequence show                # Display current sequence state
  cleo sequence check               # Verify sequence integrity (exit code indicates status)
  cleo sequence check --json        # JSON output for scripting
  cleo sequence repair              # Fix counter if behind max ID
  cleo sequence repair --verbose    # Repair with detailed output

Scripting:
  # Check and repair if needed
  cleo sequence check || cleo sequence repair

  # Exit code checking
  if cleo sequence check --quiet; then
    echo "Sequence OK"
  else
    echo "Sequence needs repair"
    cleo sequence repair
  fi
EOF
    exit "${EXIT_SUCCESS}"
}

log_info()  { [[ "$QUIET" != true && "$FORMAT" != "json" ]] && echo -e "${GREEN}[INFO]${NC} $1" || true; }
log_warn()  { [[ "$FORMAT" != "json" ]] && echo -e "${YELLOW}[WARN]${NC} $1" >&2 || true; }
log_error() { [[ "$FORMAT" != "json" ]] && echo -e "${RED}[ERROR]${NC} $1" >&2 || true; }
log_debug() { [[ "$VERBOSE" == true && "$FORMAT" != "json" ]] && echo -e "${DIM}[DEBUG]${NC} $1" || true; }

# Auto-detect format based on terminal and piping
detect_format() {
    if [[ -n "$FORMAT" ]]; then
        echo "$FORMAT"
    elif [[ ! -t 1 ]]; then
        # Piped output defaults to JSON
        echo "json"
    else
        echo "text"
    fi
}

# Output JSON result
output_json() {
    local success="$1"
    local subcommand="$2"
    shift 2
    local data="$*"

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq -nc \
        --arg schema "https://cleo-dev.com/schemas/v1/output.schema.json" \
        --arg version "$VERSION" \
        --arg command "$COMMAND_NAME" \
        --arg subcommand "$subcommand" \
        --arg timestamp "$timestamp" \
        --argjson success "$success" \
        --argjson data "$data" \
        '{
            "$schema": $schema,
            "_meta": {
                "format": "json",
                "version": $version,
                "command": $command,
                "subcommand": $subcommand,
                "timestamp": $timestamp
            },
            "success": $success
        } + $data'
}

# Get sequence state for display
get_sequence_state() {
    local seq_file
    seq_file=$(_get_sequence_file)

    if [[ ! -f "$seq_file" ]]; then
        echo '{"exists": false}'
        return 0
    fi

    local content
    if ! content=$(cat "$seq_file" 2>/dev/null); then
        echo '{"exists": true, "readable": false}'
        return 0
    fi

    # Validate JSON
    if ! echo "$content" | jq -e '.' >/dev/null 2>&1; then
        echo '{"exists": true, "readable": true, "valid": false}'
        return 0
    fi

    # Extract fields
    local counter lastId checksum updatedAt recoveredAt
    counter=$(echo "$content" | jq -r '.counter // 0')
    lastId=$(echo "$content" | jq -r '.lastId // "none"')
    checksum=$(echo "$content" | jq -r '.checksum // "none"')
    updatedAt=$(echo "$content" | jq -r '.updatedAt // "unknown"')
    recoveredAt=$(echo "$content" | jq -r '.recoveredAt // null')

    # Validate checksum
    local expected_checksum checksum_valid
    expected_checksum=$(_calculate_sequence_checksum "$counter")
    if [[ "$checksum" == "$expected_checksum" ]]; then
        checksum_valid="true"
    else
        checksum_valid="false"
    fi

    # Build JSON
    local json
    json=$(jq -nc \
        --argjson exists true \
        --argjson readable true \
        --argjson valid true \
        --argjson counter "$counter" \
        --arg lastId "$lastId" \
        --arg checksum "$checksum" \
        --arg expectedChecksum "$expected_checksum" \
        --argjson checksumValid "$checksum_valid" \
        --arg updatedAt "$updatedAt" \
        --arg recoveredAt "$recoveredAt" \
        '{
            exists: $exists,
            readable: $readable,
            valid: $valid,
            counter: $counter,
            lastId: $lastId,
            checksum: $checksum,
            expectedChecksum: $expectedChecksum,
            checksumValid: $checksumValid,
            updatedAt: $updatedAt,
            recoveredAt: (if $recoveredAt == "null" then null else $recoveredAt end)
        }')

    echo "$json"
}

# Show subcommand
do_show() {
    local format
    format=$(detect_format)

    local state
    state=$(get_sequence_state)

    local exists readable valid
    exists=$(echo "$state" | jq -r '.exists')
    readable=$(echo "$state" | jq -r '.readable // false')
    valid=$(echo "$state" | jq -r '.valid // false')

    if [[ "$exists" != "true" ]]; then
        if [[ "$format" == "json" ]]; then
            output_json false "show" '{"error": "Sequence file not found", "suggestion": "Run: cleo sequence repair"}'
        else
            log_error "Sequence file not found"
            echo "Run: cleo sequence repair"
        fi
        return "$EXIT_NOT_FOUND"
    fi

    if [[ "$readable" != "true" ]]; then
        if [[ "$format" == "json" ]]; then
            output_json false "show" '{"error": "Sequence file not readable"}'
        else
            log_error "Sequence file not readable"
        fi
        return "$EXIT_FILE_ERROR"
    fi

    if [[ "$valid" != "true" ]]; then
        if [[ "$format" == "json" ]]; then
            output_json false "show" '{"error": "Sequence file has invalid JSON", "suggestion": "Run: cleo sequence repair"}'
        else
            log_error "Sequence file has invalid JSON"
            echo "Run: cleo sequence repair"
        fi
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Extract display values
    local counter lastId checksum checksumValid updatedAt recoveredAt
    counter=$(echo "$state" | jq -r '.counter')
    lastId=$(echo "$state" | jq -r '.lastId')
    checksum=$(echo "$state" | jq -r '.checksum')
    checksumValid=$(echo "$state" | jq -r '.checksumValid')
    updatedAt=$(echo "$state" | jq -r '.updatedAt')
    recoveredAt=$(echo "$state" | jq -r '.recoveredAt')

    if [[ "$format" == "json" ]]; then
        output_json true "show" "$state"
    else
        echo ""
        echo -e "${BLUE}╔══════════════════════════════════════════════════════════╗${NC}"
        echo -e "${BLUE}║${NC}                    ${CYAN}Sequence Status${NC}                       ${BLUE}║${NC}"
        echo -e "${BLUE}╠══════════════════════════════════════════════════════════╣${NC}"
        printf "${BLUE}║${NC}  Counter:       %-40s ${BLUE}║${NC}\n" "$counter"
        printf "${BLUE}║${NC}  Last ID:       %-40s ${BLUE}║${NC}\n" "$lastId"
        printf "${BLUE}║${NC}  Checksum:      %-40s ${BLUE}║${NC}\n" "$checksum"
        if [[ "$checksumValid" == "true" ]]; then
            printf "${BLUE}║${NC}  Checksum OK:   ${GREEN}%-40s${NC} ${BLUE}║${NC}\n" "Yes"
        else
            printf "${BLUE}║${NC}  Checksum OK:   ${RED}%-40s${NC} ${BLUE}║${NC}\n" "No (CORRUPTED)"
        fi
        printf "${BLUE}║${NC}  Updated:       %-40s ${BLUE}║${NC}\n" "$updatedAt"
        if [[ "$recoveredAt" != "null" ]]; then
            printf "${BLUE}║${NC}  Recovered:     %-40s ${BLUE}║${NC}\n" "$recoveredAt"
        fi
        echo -e "${BLUE}╚══════════════════════════════════════════════════════════╝${NC}"
        echo ""
    fi

    if [[ "$checksumValid" != "true" ]]; then
        return "$EXIT_CHECKSUM_MISMATCH"
    fi

    return "$EXIT_SUCCESS"
}

# Check subcommand - verify sequence integrity without modifications
do_check() {
    local format
    format=$(detect_format)

    local seq_file
    seq_file=$(_get_sequence_file)

    # Check file exists
    if [[ ! -f "$seq_file" ]]; then
        if [[ "$format" == "json" ]]; then
            output_json false "check" '{
                "valid": false,
                "issue": "MISSING",
                "message": "Sequence file does not exist",
                "suggestion": "Run: cleo sequence repair"
            }'
        else
            log_error "Sequence file not found"
            echo "Issue: MISSING"
            echo "Fix: cleo sequence repair"
        fi
        return "$EXIT_NOT_FOUND"
    fi

    # Read and validate
    local state
    state=$(get_sequence_state)

    local valid checksumValid
    valid=$(echo "$state" | jq -r '.valid // false')
    checksumValid=$(echo "$state" | jq -r '.checksumValid // false')

    if [[ "$valid" != "true" ]]; then
        if [[ "$format" == "json" ]]; then
            output_json false "check" '{
                "valid": false,
                "issue": "PARSE_ERROR",
                "message": "Sequence file has invalid JSON",
                "suggestion": "Run: cleo sequence repair"
            }'
        else
            log_error "Sequence file has invalid JSON"
            echo "Issue: PARSE_ERROR"
            echo "Fix: cleo sequence repair"
        fi
        return "$EXIT_VALIDATION_ERROR"
    fi

    if [[ "$checksumValid" != "true" ]]; then
        local checksum expectedChecksum
        checksum=$(echo "$state" | jq -r '.checksum')
        expectedChecksum=$(echo "$state" | jq -r '.expectedChecksum')

        if [[ "$format" == "json" ]]; then
            jq -nc \
                --arg checksum "$checksum" \
                --arg expected "$expectedChecksum" \
                '{
                    "valid": false,
                    "issue": "CHECKSUM_MISMATCH",
                    "message": "Checksum does not match counter",
                    "details": {
                        "actual": $checksum,
                        "expected": $expected
                    },
                    "suggestion": "Run: cleo sequence repair"
                }' | xargs -0 -I{} output_json false "check" {}
            output_json false "check" "$(jq -nc \
                --arg checksum "$checksum" \
                --arg expected "$expectedChecksum" \
                '{
                    "valid": false,
                    "issue": "CHECKSUM_MISMATCH",
                    "message": "Checksum does not match counter",
                    "details": {"actual": $checksum, "expected": $expected},
                    "suggestion": "Run: cleo sequence repair"
                }')"
        else
            log_error "Checksum mismatch: got $checksum, expected $expectedChecksum"
            echo "Issue: CHECKSUM_MISMATCH"
            echo "Fix: cleo sequence repair"
        fi
        return "$EXIT_CHECKSUM_MISMATCH"
    fi

    # Check counter vs max ID in todo + archive
    local counter max_id
    counter=$(echo "$state" | jq -r '.counter')
    max_id=$(_scan_max_task_id)

    log_debug "Counter: $counter, Max ID in files: $max_id"

    if (( max_id > counter )); then
        if [[ "$format" == "json" ]]; then
            output_json false "check" "$(jq -nc \
                --argjson counter "$counter" \
                --argjson maxId "$max_id" \
                --argjson drift "$((max_id - counter))" \
                '{
                    "valid": false,
                    "issue": "COUNTER_BEHIND",
                    "message": "Counter is behind max task ID",
                    "details": {
                        "counter": $counter,
                        "maxIdInFiles": $maxId,
                        "drift": $drift
                    },
                    "suggestion": "Run: cleo sequence repair"
                }')"
        else
            log_error "Counter ($counter) is behind max task ID ($max_id)"
            echo "Issue: COUNTER_BEHIND"
            echo "Drift: $((max_id - counter)) IDs"
            echo "Fix: cleo sequence repair"
        fi
        return "$EXIT_ID_COLLISION"
    fi

    # All checks passed
    if [[ "$format" == "json" ]]; then
        output_json true "check" "$(jq -nc \
            --argjson counter "$counter" \
            --argjson maxId "$max_id" \
            --arg lastId "$(echo "$state" | jq -r '.lastId')" \
            '{
                "valid": true,
                "counter": $counter,
                "maxIdInFiles": $maxId,
                "lastId": $lastId,
                "message": "Sequence is valid"
            }')"
    else
        if [[ "$QUIET" != true ]]; then
            echo -e "${GREEN}Sequence is valid${NC}"
            echo "  Counter: $counter"
            echo "  Max ID in files: $max_id"
        fi
    fi

    return "$EXIT_SUCCESS"
}

# Repair subcommand - reset counter to max + 1 if behind
do_repair() {
    local format
    format=$(detect_format)

    # Get current state before repair
    local before_counter before_state
    before_state=$(get_sequence_state)
    before_counter=$(echo "$before_state" | jq -r '.counter // 0')

    local max_id
    max_id=$(_scan_max_task_id)

    log_debug "Before repair: counter=$before_counter, max_id=$max_id"

    # Determine if repair needed
    local repair_needed=false
    local reason=""

    local exists valid checksumValid
    exists=$(echo "$before_state" | jq -r '.exists')
    valid=$(echo "$before_state" | jq -r '.valid // false')
    checksumValid=$(echo "$before_state" | jq -r '.checksumValid // false')

    if [[ "$exists" != "true" ]]; then
        repair_needed=true
        reason="MISSING"
    elif [[ "$valid" != "true" ]]; then
        repair_needed=true
        reason="INVALID_JSON"
    elif [[ "$checksumValid" != "true" ]]; then
        repair_needed=true
        reason="CHECKSUM_MISMATCH"
    elif (( max_id > before_counter )); then
        repair_needed=true
        reason="COUNTER_BEHIND"
    fi

    if [[ "$repair_needed" != true ]]; then
        if [[ "$format" == "json" ]]; then
            output_json true "repair" "$(jq -nc \
                --argjson counter "$before_counter" \
                --argjson maxId "$max_id" \
                '{
                    "repaired": false,
                    "reason": "No repair needed",
                    "counter": $counter,
                    "maxIdInFiles": $maxId
                }')"
        else
            if [[ "$QUIET" != true ]]; then
                echo -e "${GREEN}No repair needed${NC}"
                echo "  Counter: $before_counter"
                echo "  Max ID: $max_id"
            fi
        fi
        return "$EXIT_SUCCESS"
    fi

    # Perform repair
    log_info "Repairing sequence (reason: $reason)..."

    if ! recover_sequence; then
        if [[ "$format" == "json" ]]; then
            output_json false "repair" '{"error": "Recovery failed", "reason": "Could not write sequence file"}'
        else
            log_error "Failed to repair sequence"
        fi
        return "$EXIT_FILE_ERROR"
    fi

    # Get new state
    local after_state after_counter
    after_state=$(get_sequence_state)
    after_counter=$(echo "$after_state" | jq -r '.counter')

    if [[ "$format" == "json" ]]; then
        output_json true "repair" "$(jq -nc \
            --argjson beforeCounter "$before_counter" \
            --argjson afterCounter "$after_counter" \
            --argjson maxId "$max_id" \
            --arg reason "$reason" \
            --arg lastId "$(echo "$after_state" | jq -r '.lastId')" \
            '{
                "repaired": true,
                "reason": $reason,
                "before": {"counter": $beforeCounter},
                "after": {"counter": $afterCounter, "lastId": $lastId},
                "maxIdInFiles": $maxId
            }')"
    else
        echo -e "${GREEN}Sequence repaired${NC}"
        echo "  Reason: $reason"
        echo "  Before: counter=$before_counter"
        echo "  After: counter=$after_counter"
        echo "  Max ID: $max_id"
    fi

    return "$EXIT_SUCCESS"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        show|check|repair)
            SUBCOMMAND="$1"
            shift
            ;;
        -f|--format)
            FORMAT="$2"
            shift 2
            ;;
        --human)
            FORMAT="human"
            shift
            ;;
        --json)
            FORMAT="json"
            shift
            ;;
        -q|--quiet)
            QUIET=true
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            log_error "Unknown option: $1"
            echo "Run: cleo sequence --help"
            exit "$EXIT_INVALID_INPUT"
            ;;
    esac
done

# Require subcommand
if [[ -z "$SUBCOMMAND" ]]; then
    log_error "Missing subcommand"
    echo "Usage: cleo sequence <show|check|repair> [OPTIONS]"
    echo "Run: cleo sequence --help"
    exit "$EXIT_INVALID_INPUT"
fi

# Resolve format with TTY-aware defaults
FORMAT=$(resolve_format "$FORMAT")

# Execute subcommand
case "$SUBCOMMAND" in
    show)
        do_show
        ;;
    check)
        do_check
        ;;
    repair)
        do_repair
        ;;
    *)
        log_error "Unknown subcommand: $SUBCOMMAND"
        exit "$EXIT_INVALID_INPUT"
        ;;
esac
