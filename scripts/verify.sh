#!/usr/bin/env bash
# CLEO Verify Command (T1157)
# Manual verification gate management for tasks
# Allows setting/viewing verification gates and status
set -euo pipefail

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source libraries
if [[ -f "$LIB_DIR/logging.sh" ]]; then
  source "$LIB_DIR/logging.sh"
fi

if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  source "$LIB_DIR/output-format.sh"
fi

if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  source "$LIB_DIR/error-json.sh"
elif [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  source "$LIB_DIR/exit-codes.sh"
fi

if [[ -f "$LIB_DIR/file-ops.sh" ]]; then
  source "$LIB_DIR/file-ops.sh"
fi

if [[ -f "$LIB_DIR/config.sh" ]]; then
  source "$LIB_DIR/config.sh"
fi

if [[ -f "$LIB_DIR/verification.sh" ]]; then
  source "$LIB_DIR/verification.sh"
fi

# Source flags library for standardized flag parsing
if [[ -f "$LIB_DIR/flags.sh" ]]; then
  source "$LIB_DIR/flags.sh"
fi

# Command name for output
COMMAND_NAME="verify"

# Options
TASK_ID=""
GATE=""
VALUE="true"
AGENT=""
SHOW_ONLY=false
SET_ALL=false
RESET=false
FORMAT=""

usage() {
  cat << EOF
Usage: cleo verify <task-id> [OPTIONS]

View or modify verification gates for a task.

Arguments:
  <task-id>           Task ID to verify (e.g., T005)

Options:
  --gate <name>       Set specific gate (implemented, testsPassed, qaPassed,
                      cleanupDone, securityPassed, documented)
  --value <bool>      Value for gate: true (default) or false
  --agent <name>      Agent setting the gate (coder, testing, qa, etc.)
  --all               Mark all required gates as passed
  --reset             Reset verification to initial state
  --format <format>   Output format: text (default) or json
  --json              Shortcut for --format json
  --human             Shortcut for --format text
  --help              Show this help message

Exit Codes:
  0   Success
  4   Task not found
  42  Invalid gate name
  43  Invalid agent name
  44  Max rounds exceeded

Examples:
  # View verification status
  cleo verify T005

  # Set a specific gate
  cleo verify T005 --gate testsPassed

  # Set gate with agent
  cleo verify T005 --gate qaPassed --agent qa

  # Set gate to false (failed)
  cleo verify T005 --gate testsPassed --value false

  # Mark all required gates as passed
  cleo verify T005 --all

  # Reset verification
  cleo verify T005 --reset

  # JSON output
  cleo verify T005 --json
EOF
}

# Validate task ID format
validate_task_id() {
  local id="$1"
  [[ "$id" =~ ^T[0-9]{3,}$ ]]
}

# Get task from file
get_task() {
  local task_id="$1"
  jq --arg id "$task_id" '.tasks[] | select(.id == $id)' "$TODO_FILE" 2>/dev/null
}

# Show verification status
show_verification_status() {
  local task_id="$1"
  local format="$2"

  local task
  task=$(get_task "$task_id")

  if [[ -z "$task" ]]; then
    if [[ "$format" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_NOT_FOUND" "Task $task_id not found" "${EXIT_NOT_FOUND:-4}" true
    else
      log_error "Task $task_id not found"
    fi
    exit "${EXIT_NOT_FOUND:-4}"
  fi

  local title status task_type
  title=$(echo "$task" | jq -r '.title')
  status=$(echo "$task" | jq -r '.status')
  task_type=$(echo "$task" | jq -r '.type // "task"')

  local verification
  verification=$(echo "$task" | jq '.verification // null')

  # Get required gates from config
  local required_gates
  required_gates=$(get_config_value "verification.requiredGates" '["implemented","testsPassed","qaPassed","securityPassed","documented"]')

  # Compute verification status
  local verif_status="pending"
  local passed="false"
  local round=0
  local missing_gates="[]"

  if [[ "$verification" != "null" && -n "$verification" ]]; then
    passed=$(echo "$verification" | jq -r '.passed // false')
    round=$(echo "$verification" | jq -r '.round // 0')
    verif_status=$(get_verification_status "$verification")
    missing_gates=$(get_missing_gates "$verification" "$required_gates")
  fi

  if [[ "$format" == "json" ]]; then
    jq -n \
      --arg taskId "$task_id" \
      --arg title "$title" \
      --arg status "$status" \
      --arg type "$task_type" \
      --argjson verification "$verification" \
      --argjson requiredGates "$required_gates" \
      --argjson missingGates "$missing_gates" \
      --arg verifStatus "$verif_status" \
      --argjson passed "$passed" \
      --argjson round "$round" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "command": "verify",
          "format": "json"
        },
        "success": true,
        "task": $taskId,
        "title": $title,
        "status": $status,
        "type": $type,
        "verification": $verification,
        "verificationStatus": $verifStatus,
        "passed": $passed,
        "round": $round,
        "requiredGates": $requiredGates,
        "missingGates": $missingGates
      }'
  else
    echo ""
    echo "Task: $title"
    echo "ID: $task_id"
    echo "Status: $status"
    echo "Type: $task_type"
    echo ""
    echo "Verification Status: $verif_status"
    echo "Passed: $passed"
    echo "Round: $round"
    echo ""
    echo "Gates:"

    if [[ "$verification" != "null" && -n "$verification" ]]; then
      local gates
      gates=$(echo "$verification" | jq -r '.gates // {}')

      for gate in implemented testsPassed qaPassed cleanupDone securityPassed documented; do
        local gate_value
        gate_value=$(echo "$gates" | jq -r ".$gate // \"null\"")

        # Check if required
        local is_required="false"
        if echo "$required_gates" | jq -e "index(\"$gate\")" >/dev/null 2>&1; then
          is_required="true"
        fi

        local indicator="○"
        if [[ "$gate_value" == "true" ]]; then
          indicator="✓"
        elif [[ "$gate_value" == "false" ]]; then
          indicator="✗"
        fi

        local req_marker=""
        if [[ "$is_required" == "true" ]]; then
          req_marker=" (required)"
        fi

        printf "  %s %-15s: %s%s\n" "$indicator" "$gate" "$gate_value" "$req_marker"
      done
    else
      echo "  (no verification data)"
    fi

    if [[ "$missing_gates" != "[]" ]]; then
      echo ""
      echo "Missing required gates: $(echo "$missing_gates" | jq -r 'join(", ")')"
    fi
    echo ""
  fi
}

# Set a gate value
set_gate_value() {
  local task_id="$1"
  local gate="$2"
  local value="$3"
  local agent="$4"
  local format="$5"

  # Validate gate name
  if ! validate_gate_name "$gate"; then
    if [[ "$format" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_INVALID_GATE" "Invalid gate name: $gate. Valid gates: $(get_gate_order)" "${EXIT_INVALID_GATE:-42}" true
    else
      log_error "Invalid gate name: $gate"
      log_error "Valid gates: $(get_gate_order)"
    fi
    exit "${EXIT_INVALID_GATE:-42}"
  fi

  # Validate agent if provided
  if [[ -n "$agent" ]] && ! validate_agent_name "$agent"; then
    if [[ "$format" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_INVALID_AGENT" "Invalid agent name: $agent" "${EXIT_INVALID_AGENT:-43}" true
    else
      log_error "Invalid agent name: $agent"
    fi
    exit "${EXIT_INVALID_AGENT:-43}"
  fi

  local task
  task=$(get_task "$task_id")

  if [[ -z "$task" ]]; then
    if [[ "$format" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_NOT_FOUND" "Task $task_id not found" "${EXIT_NOT_FOUND:-4}" true
    else
      log_error "Task $task_id not found"
    fi
    exit "${EXIT_NOT_FOUND:-4}"
  fi

  # Get current verification
  local verification
  verification=$(echo "$task" | jq '.verification // null')

  # Initialize if null
  if [[ "$verification" == "null" || -z "$verification" ]]; then
    verification=$(init_verification)
  fi

  # Update the gate
  local updated_verification
  updated_verification=$(update_gate "$verification" "$gate" "$value" "${agent:-null}")

  # If setting to false, reset downstream gates
  if [[ "$value" == "false" ]]; then
    updated_verification=$(reset_downstream_gates "$updated_verification" "$gate")
    # Increment round on failure
    updated_verification=$(increment_round "$updated_verification") || true
    # Log the failure
    updated_verification=$(log_failure "$updated_verification" "$gate" "${agent:-unknown}" "Gate set to false")
  fi

  # Recompute passed status
  local new_passed
  new_passed=$(compute_passed "$updated_verification")
  updated_verification=$(set_verification_passed "$updated_verification" "$new_passed")

  # Update the task in the file
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local updated_json
  updated_json=$(jq --arg id "$task_id" --argjson verification "$updated_verification" --arg now "$now" '
    .tasks |= map(
      if .id == $id then
        .verification = $verification |
        .updatedAt = $now
      else . end
    )
  ' "$TODO_FILE")

  # Recalculate checksum
  local new_checksum
  new_checksum=$(echo "$updated_json" | jq -c '.tasks' | sha256sum | cut -c1-16)
  updated_json=$(echo "$updated_json" | jq --arg cs "$new_checksum" --arg ts "$now" '
    ._meta.checksum = $cs |
    .lastUpdated = $ts
  ')

  # Save
  if save_json "$TODO_FILE" "$updated_json"; then
    if [[ "$format" == "json" ]]; then
      jq -n \
        --arg taskId "$task_id" \
        --arg gate "$gate" \
        --argjson value "$value" \
        --arg agent "${agent:-null}" \
        --argjson verification "$updated_verification" \
        --argjson passed "$new_passed" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {"command": "verify", "format": "json"},
          "success": true,
          "task": $taskId,
          "gate": $gate,
          "value": $value,
          "agent": $agent,
          "verification": $verification,
          "passed": $passed
        }'
    else
      log_info "Gate '$gate' set to $value for task $task_id"
      if [[ "$new_passed" == "true" ]]; then
        log_info "Verification passed - all required gates complete"
      fi
    fi

    # Check for epic lifecycle transition if passed
    if [[ "$new_passed" == "true" ]] && declare -f check_epic_lifecycle_transition >/dev/null 2>&1; then
      check_epic_lifecycle_transition "$task_id" "$TODO_FILE" "$format" || true
    fi
  else
    if [[ "$format" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_FILE_ERROR" "Failed to save changes" "${EXIT_FILE_ERROR:-3}" true
    else
      log_error "Failed to save changes"
    fi
    exit "${EXIT_FILE_ERROR:-3}"
  fi
}

# Set all required gates to true
set_all_gates() {
  local task_id="$1"
  local agent="$2"
  local format="$3"

  local task
  task=$(get_task "$task_id")

  if [[ -z "$task" ]]; then
    if [[ "$format" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_NOT_FOUND" "Task $task_id not found" "${EXIT_NOT_FOUND:-4}" true
    else
      log_error "Task $task_id not found"
    fi
    exit "${EXIT_NOT_FOUND:-4}"
  fi

  # Get current verification
  local verification
  verification=$(echo "$task" | jq '.verification // null')

  # Initialize if null
  if [[ "$verification" == "null" || -z "$verification" ]]; then
    verification=$(init_verification)
  fi

  # Get required gates
  local required_gates
  required_gates=$(get_config_value "verification.requiredGates" '["implemented","testsPassed","qaPassed","securityPassed","documented"]')

  # Set all required gates to true
  while IFS= read -r gate; do
    [[ -z "$gate" ]] && continue
    verification=$(update_gate "$verification" "$gate" "true" "${agent:-null}")
  done < <(echo "$required_gates" | jq -r '.[]')

  # Compute passed (should be true now)
  local new_passed
  new_passed=$(compute_passed "$verification")
  verification=$(set_verification_passed "$verification" "$new_passed")

  # Update the task
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local updated_json
  updated_json=$(jq --arg id "$task_id" --argjson verification "$verification" --arg now "$now" '
    .tasks |= map(
      if .id == $id then
        .verification = $verification |
        .updatedAt = $now
      else . end
    )
  ' "$TODO_FILE")

  # Recalculate checksum
  local new_checksum
  new_checksum=$(echo "$updated_json" | jq -c '.tasks' | sha256sum | cut -c1-16)
  updated_json=$(echo "$updated_json" | jq --arg cs "$new_checksum" --arg ts "$now" '
    ._meta.checksum = $cs |
    .lastUpdated = $ts
  ')

  # Save
  if save_json "$TODO_FILE" "$updated_json"; then
    if [[ "$format" == "json" ]]; then
      jq -n \
        --arg taskId "$task_id" \
        --argjson verification "$verification" \
        --argjson passed "$new_passed" \
        --argjson gates "$(echo "$required_gates" | jq -c '.')" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {"command": "verify", "format": "json"},
          "success": true,
          "task": $taskId,
          "action": "set_all",
          "gatesSet": $gates,
          "verification": $verification,
          "passed": $passed
        }'
    else
      log_info "All required gates set to true for task $task_id"
      log_info "Verification passed"
    fi

    # Check for epic lifecycle transition
    if [[ "$new_passed" == "true" ]] && declare -f check_epic_lifecycle_transition >/dev/null 2>&1; then
      check_epic_lifecycle_transition "$task_id" "$TODO_FILE" "$format" || true
    fi
  else
    if [[ "$format" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_FILE_ERROR" "Failed to save changes" "${EXIT_FILE_ERROR:-3}" true
    else
      log_error "Failed to save changes"
    fi
    exit "${EXIT_FILE_ERROR:-3}"
  fi
}

# Reset verification to initial state
reset_verification() {
  local task_id="$1"
  local format="$2"

  local task
  task=$(get_task "$task_id")

  if [[ -z "$task" ]]; then
    if [[ "$format" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_NOT_FOUND" "Task $task_id not found" "${EXIT_NOT_FOUND:-4}" true
    else
      log_error "Task $task_id not found"
    fi
    exit "${EXIT_NOT_FOUND:-4}"
  fi

  # Create fresh verification object
  local verification
  verification=$(init_verification)

  # Update the task
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local updated_json
  updated_json=$(jq --arg id "$task_id" --argjson verification "$verification" --arg now "$now" '
    .tasks |= map(
      if .id == $id then
        .verification = $verification |
        .updatedAt = $now
      else . end
    )
  ' "$TODO_FILE")

  # Recalculate checksum
  local new_checksum
  new_checksum=$(echo "$updated_json" | jq -c '.tasks' | sha256sum | cut -c1-16)
  updated_json=$(echo "$updated_json" | jq --arg cs "$new_checksum" --arg ts "$now" '
    ._meta.checksum = $cs |
    .lastUpdated = $ts
  ')

  # Save
  if save_json "$TODO_FILE" "$updated_json"; then
    if [[ "$format" == "json" ]]; then
      jq -n \
        --arg taskId "$task_id" \
        --argjson verification "$verification" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {"command": "verify", "format": "json"},
          "success": true,
          "task": $taskId,
          "action": "reset",
          "verification": $verification
        }'
    else
      log_info "Verification reset for task $task_id"
    fi
  else
    if [[ "$format" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_FILE_ERROR" "Failed to save changes" "${EXIT_FILE_ERROR:-3}" true
    else
      log_error "Failed to save changes"
    fi
    exit "${EXIT_FILE_ERROR:-3}"
  fi
}

# Main
main() {
  # Parse common flags first using lib/flags.sh
  init_flag_defaults
  parse_common_flags "$@"
  set -- "${REMAINING_ARGS[@]}"

  # Bridge to legacy variables for compatibility
  apply_flags_to_globals

  # Handle help early if requested
  if [[ "$FLAG_HELP" == "true" ]]; then
    usage
    exit 0
  fi

  # Parse command-specific arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)
        usage
        exit 0
        ;;
      --gate|-g)
        if [[ $# -lt 2 ]]; then
          log_error "--gate requires a value"
          exit "${EXIT_INVALID_INPUT:-2}"
        fi
        GATE="$2"
        shift 2
        ;;
      --value|-v)
        if [[ $# -lt 2 ]]; then
          log_error "--value requires a value"
          exit "${EXIT_INVALID_INPUT:-2}"
        fi
        VALUE="$2"
        shift 2
        ;;
      --agent|-a)
        if [[ $# -lt 2 ]]; then
          log_error "--agent requires a value"
          exit "${EXIT_INVALID_INPUT:-2}"
        fi
        AGENT="$2"
        shift 2
        ;;
      --all)
        SET_ALL=true
        shift
        ;;
      --reset)
        RESET=true
        shift
        ;;
      -*)
        log_error "Unknown option: $1"
        usage
        exit "${EXIT_INVALID_INPUT:-2}"
        ;;
      *)
        if [[ -z "$TASK_ID" ]]; then
          TASK_ID="$1"
        else
          log_error "Unexpected argument: $1"
          exit "${EXIT_INVALID_INPUT:-2}"
        fi
        shift
        ;;
    esac
  done

  # Resolve format with TTY-aware defaults
  FORMAT=$(resolve_format "$FORMAT")

  # Validate task ID
  if [[ -z "$TASK_ID" ]]; then
    log_error "Task ID required"
    usage
    exit "${EXIT_INVALID_INPUT:-2}"
  fi

  if ! validate_task_id "$TASK_ID"; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_INVALID_INPUT" "Invalid task ID format: $TASK_ID" "${EXIT_INVALID_INPUT:-2}" true
    else
      log_error "Invalid task ID format: $TASK_ID"
    fi
    exit "${EXIT_INVALID_INPUT:-2}"
  fi

  # Check file exists
  if [[ ! -f "$TODO_FILE" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
      output_error "E_FILE_ERROR" "Todo file not found: $TODO_FILE" "${EXIT_FILE_ERROR:-3}" true
    else
      log_error "Todo file not found: $TODO_FILE"
    fi
    exit "${EXIT_FILE_ERROR:-3}"
  fi

  # Determine action
  if [[ "$RESET" == "true" ]]; then
    reset_verification "$TASK_ID" "$FORMAT"
  elif [[ "$SET_ALL" == "true" ]]; then
    set_all_gates "$TASK_ID" "$AGENT" "$FORMAT"
  elif [[ -n "$GATE" ]]; then
    set_gate_value "$TASK_ID" "$GATE" "$VALUE" "$AGENT" "$FORMAT"
  else
    show_verification_status "$TASK_ID" "$FORMAT"
  fi
}

main "$@"
