#!/usr/bin/env bash
###CLEO
# command: exists
# category: read
# synopsis: Validate task ID exists (scripting/CI). Exit 0=exists, 1=not found.
# relevance: critical
# flags: --format,--quiet,--include-archive,--verbose
# exits: 0,1,2,3
# json-output: true
###END
# CLEO Exists Command
# Check if a task ID exists without listing all tasks
# Provides clean exit codes for scripting and CI/CD integration
set -euo pipefail

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
ARCHIVE_FILE="${ARCHIVE_FILE:-.cleo/todo-archive.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source libraries
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/core/logging.sh" ]]; then
  # shellcheck source=../lib/core/logging.sh
  source "$LIB_DIR/core/logging.sh"
fi

# Source output formatting library
if [[ -f "$LIB_DIR/core/output-format.sh" ]]; then
  # shellcheck source=../lib/core/output-format.sh
  source "$LIB_DIR/core/output-format.sh"
fi

# shellcheck source=../lib/ui/flags.sh
source "$LIB_DIR/ui/flags.sh"

# Source error JSON library (includes exit-codes.sh)
if [[ -f "$LIB_DIR/core/error-json.sh" ]]; then
  # shellcheck source=../lib/core/error-json.sh
  source "$LIB_DIR/core/error-json.sh"
elif [[ -f "$LIB_DIR/core/exit-codes.sh" ]]; then
  # Fallback: source exit codes directly if error-json.sh not available
  # shellcheck source=../lib/core/exit-codes.sh
  source "$LIB_DIR/core/exit-codes.sh"
fi

# Colors (respects NO_COLOR and FORCE_COLOR environment variables)
if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' NC=''
fi

# Map local exit codes to standard library codes for backward compatibility
# Note: EXIT_FILE_ERROR is already defined as readonly by exit-codes.sh
EXIT_EXISTS="${EXIT_SUCCESS:-0}"
EXIT_INVALID_ID="${EXIT_INVALID_INPUT:-2}"
# EXIT_FILE_ERROR is already defined by exit-codes.sh, use it directly

# Options
VERBOSE=false
INCLUDE_ARCHIVE=false
COMMAND_NAME="exists"

# Initialize flag defaults
init_flag_defaults

usage() {
  cat << EOF
Usage: cleo exists <task-id> [OPTIONS]

Check if a task ID exists without listing all tasks.

Arguments:
  <task-id>           Task ID to check (e.g., T001)

Options:
  --quiet             No output, exit code only
  --verbose           Show which file contains the task
  --include-archive   Search archive file too
  --format <format>   Output format: text (default) or json
  --json              Shortcut for --format json
  --human             Shortcut for --format text
  --help              Show this help message

Exit Codes:
  0  Task exists
  1  Task not found
  2  Invalid task ID format
  3  File read error

Examples:
  # Basic check
  cleo exists T001

  # Silent check for scripting
  if cleo exists T001 --quiet; then
    echo "Task exists"
  fi

  # Check with archive
  cleo exists T050 --include-archive

  # JSON output
  cleo exists T001 --format json
EOF
}

# Validate task ID format (T followed by 3+ digits)
validate_task_id() {
  local id="$1"
  [[ "$id" =~ ^T[0-9]{3,}$ ]]
}

# Check if task exists in a file
task_exists_in_file() {
  local task_id="$1"
  local file="$2"

  if [[ ! -f "$file" ]]; then
    return 1
  fi

  if ! jq -e --arg id "$task_id" '.tasks[] | select(.id == $id)' "$file" > /dev/null 2>&1; then
    return 1
  fi

  return 0
}

# Main function
main() {
  local task_id=""

  # Parse common flags first
  parse_common_flags "$@"
  set -- "${REMAINING_ARGS[@]}"

  # Bridge to legacy variables
  apply_flags_to_globals
  local FORMAT="${FORMAT:-}"
  local QUIET="${QUIET:-false}"
  VERBOSE="${FLAG_VERBOSE:-false}"

  # Handle help flag
  if [[ "$FLAG_HELP" == true ]]; then
    usage
    exit "$EXIT_SUCCESS"
  fi

  # Parse command-specific arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --verbose)
        VERBOSE=true
        ;;
      --include-archive)
        INCLUDE_ARCHIVE=true
        ;;
      -*)
        if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
          output_error "E_INPUT_INVALID" "Unknown option: $1" "${EXIT_INVALID_INPUT:-2}" true "Run 'cleo exists --help' for usage"
        else
          log_error "Unknown option: $1"
          usage >&2
        fi
        exit "${EXIT_INVALID_INPUT:-2}"
        ;;
      *)
        if [[ -z "$task_id" ]]; then
          task_id="$1"
        else
          if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_INPUT_INVALID" "Multiple task IDs provided" "${EXIT_INVALID_INPUT:-2}" true "Provide only one task ID"
          else
            log_error "Multiple task IDs provided"
          fi
          exit "${EXIT_INVALID_INPUT:-2}"
        fi
        ;;
    esac
    shift
  done

  # Resolve format (TTY-aware auto-detection)
  FORMAT=$(resolve_format "${FORMAT:-}")

  # Require task ID
  if [[ -z "$task_id" ]]; then
    if [[ "$QUIET" == false ]]; then
      if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_INPUT_MISSING" "Task ID required" "${EXIT_INVALID_INPUT:-2}" true "Usage: cleo exists <task-id>"
      else
        log_error "Task ID required"
        usage >&2
      fi
    fi
    exit "${EXIT_INVALID_INPUT:-2}"
  fi

  # Validate task ID format
  if ! validate_task_id "$task_id"; then
    if [[ "$QUIET" == false ]]; then
      if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_TASK_INVALID_ID" "Invalid task ID format: $task_id (expected: T001, T002, etc.)" "${EXIT_INVALID_INPUT:-2}" true "Task IDs start with T followed by 3+ digits"
      else
        log_error "Invalid task ID format: $task_id (expected: T001, T002, etc.)"
      fi
    fi
    exit "${EXIT_INVALID_INPUT:-2}"
  fi

  # Check todo.json exists
  if [[ ! -f "$TODO_FILE" ]]; then
    if [[ "$QUIET" == false ]]; then
      if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_NOT_INITIALIZED" "Todo file not found: $TODO_FILE" "${EXIT_FILE_ERROR:-3}" true "Run 'cleo init' to initialize project"
      else
        log_error "Todo file not found: $TODO_FILE"
      fi
    fi
    exit "${EXIT_FILE_ERROR:-3}"
  fi

  local found=false
  local location=""

  # Check todo.json
  if task_exists_in_file "$task_id" "$TODO_FILE"; then
    found=true
    location="todo.json"
  fi

  # Check archive if requested and not found yet
  if [[ "$INCLUDE_ARCHIVE" == true && "$found" == false ]]; then
    if [[ -f "$ARCHIVE_FILE" ]]; then
      if task_exists_in_file "$task_id" "$ARCHIVE_FILE"; then
        found=true
        location="todo-archive.json"
      fi
    fi
  fi

  # Get VERSION for JSON output
  local version
  CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
  if [[ -f "$CLEO_HOME/VERSION" ]]; then
    version=$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')
  elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
    version=$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')
  else
    version="0.16.0"
  fi

  # Output handling
  if [[ "$found" == true ]]; then
    if [[ "$QUIET" == false ]]; then
      if [[ "$FORMAT" == "json" ]]; then
        jq -nc --arg id "$task_id" --arg loc "$location" --arg ver "$version" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
              "format": "json",
              "version": $ver,
              "command": "exists",
              "timestamp": $ts
            },
            "success": true,
            exists: true,
            taskId: $id,
            location: $loc
          }'
      elif [[ "$VERBOSE" == true ]]; then
        echo -e "${GREEN}[EXISTS]${NC} Task $task_id found in $location"
      else
        echo -e "${GREEN}[EXISTS]${NC} Task $task_id exists"
      fi
    fi
    exit $EXIT_EXISTS
  else
    if [[ "$QUIET" == false ]]; then
      if [[ "$FORMAT" == "json" ]]; then
        jq -nc --arg id "$task_id" --argjson archive "$INCLUDE_ARCHIVE" --arg ver "$version" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
              "format": "json",
              "version": $ver,
              "command": "exists",
              "timestamp": $ts
            },
            "success": true,
            exists: false,
            taskId: $id,
            searchedArchive: $archive
          }'
      else
        local msg="Task $task_id not found"
        [[ "$INCLUDE_ARCHIVE" == true ]] && msg="$msg (searched archive too)"
        echo -e "${YELLOW}[NOT FOUND]${NC} $msg"
      fi
    fi
    exit $EXIT_NOT_FOUND
  fi
}

main "$@"
