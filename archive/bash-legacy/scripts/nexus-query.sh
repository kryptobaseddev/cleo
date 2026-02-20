#!/usr/bin/env bash
###CLEO
# command: nexus-query
# category: intelligence
# synopsis: Query tasks across registered projects using project:task_id syntax
# relevance: high
# flags: --format,--json,--human
# exits: 0,70,71,72
# json-output: true
# json-default: true
# note: Part of Nexus Intelligence System - query tasks using project:T#### syntax
###END
# CLEO Nexus Query Command
# Query tasks across registered projects using project:task_id syntax
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source required libraries
for lib in output-format.sh flags.sh exit-codes.sh nexus-registry.sh nexus-query.sh; do
  if [[ -f "$LIB_DIR/$lib" ]]; then
    # shellcheck source=../lib/*.sh
    source "$LIB_DIR/$lib"
  else
    echo "ERROR: Missing required library: $lib" >&2
    exit 1
  fi
done

# Colors (respects NO_COLOR and FORCE_COLOR environment variables)
if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
  BOLD='\033[1m'
  NC='\033[0m'
else
  BOLD='' NC=''
fi

# Options
FORMAT=""
QUERY=""
COMMAND_NAME="nexus-query"

#######################################
# Show usage information
#######################################
usage() {
  cat << EOF
Usage: cleo nexus-query <query> [options]

Query tasks across registered projects using cross-project syntax.

ARGUMENTS:
    <query>                 Task query in format: project:task_id or task_id

OPTIONS:
    --json                  JSON output format
    --human                 Human-readable output (default)
    -h, --help              Show this help message

QUERY SYNTAX:
    <project>:<task_id>     Fully qualified task reference
    .<task_id>              Current project task
    *:<task_id>             Wildcard search across all projects
    <task_id>               Implicit current project

EXAMPLES:
    # Query task from another project
    cleo nexus-query my-api:T001

    # Query task from current project
    cleo nexus-query T042
    cleo nexus-query .:T042

    # Search for task across all registered projects
    cleo nexus-query *:T001

EXIT CODES:
    0   Success
    1   General error
    2   Invalid input
    4   Task not found
    71  Project not found in registry
    73  Invalid query syntax

SEE ALSO:
    cleo nexus          Main Nexus command
    cleo nexus-discover Discover related tasks
    cleo nexus-search   Search tasks by pattern
    cleo find           Fuzzy search within current project
EOF
}

#######################################
# Get version for JSON output
#######################################
get_version() {
  local version
  local cleo_home="${CLEO_HOME:-$HOME/.cleo}"
  if [[ -f "$cleo_home/VERSION" ]]; then
    version=$(head -n 1 "$cleo_home/VERSION" | tr -d '[:space:]')
  elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
    version=$(head -n 1 "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')
  else
    version="0.80.0"
  fi
  echo "$version"
}

#######################################
# Parse command-line arguments
# Sets global variables: FORMAT, QUERY
#######################################
parse_args() {
  QUERY=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      --json)
        FORMAT="json"
        shift
        ;;
      --human)
        FORMAT="human"
        shift
        ;;
      -*)
        echo "Error: Unknown option: $1" >&2
        echo "Try 'cleo nexus-query --help' for more information." >&2
        exit "${EXIT_INVALID_INPUT:-2}"
        ;;
      *)
        if [[ -z "$QUERY" ]]; then
          QUERY="$1"
        else
          echo "Error: Multiple queries not supported" >&2
          exit "${EXIT_INVALID_INPUT:-2}"
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$QUERY" ]]; then
    echo "Error: Query required" >&2
    echo "Usage: cleo nexus-query <query>" >&2
    echo "Try 'cleo nexus-query --help' for more information." >&2
    exit "${EXIT_INVALID_INPUT:-2}"
  fi
}

#######################################
# Main execution
#######################################
main() {
  parse_args "$@"
  local query="$QUERY"

  # Ensure Nexus is initialized
  if ! nexus_init 2>/dev/null; then
    if [[ "$FORMAT" == "json" ]]; then
      jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $ver,
            "command": "nexus-query",
            "timestamp": $ts
          },
          "success": false,
          "error": {
            "code": "E_NEXUS_NOT_INITIALIZED",
            "message": "Nexus not initialized. Run: cleo nexus init"
          }
        }'
    else
      echo "Error: Nexus not initialized. Run: cleo nexus init" >&2
    fi
    exit "${EXIT_NEXUS_NOT_INITIALIZED:-70}"
  fi

  # Execute query
  local result
  local exit_code=0
  result=$(nexus_query "$query" "--json") || exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
             --arg query "$query" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $ver,
            "command": "nexus-query",
            "timestamp": $ts
          },
          "success": false,
          "query": $query,
          "error": {
            "code": "E_QUERY_FAILED",
            "message": "Task not found or query invalid"
          }
        }'
    else
      echo "Error: Task not found or query invalid" >&2
    fi
    exit "$exit_code"
  fi

  # Output results
  if [[ "$FORMAT" == "json" ]]; then
    jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
           --arg query "$query" --argjson result "$result" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $ver,
          "command": "nexus-query",
          "timestamp": $ts
        },
        "success": true,
        "query": $query,
        "task": $result
      }'
  else
    # Human-readable output for single task
    if [[ "$(echo "$result" | jq -r 'type')" == "array" ]]; then
      # Wildcard results
      local count
      count=$(echo "$result" | jq 'length')
      echo -e "${BOLD}Found $count matching tasks:${NC}"
      echo "$result" | jq -r '.[] | "\(.id) [\(._project)] \(.title) - \(.status)"'
    else
      # Single task
      local task_id project_name title status priority description
      task_id=$(echo "$result" | jq -r '.id')
      project_name=$(echo "$result" | jq -r '._project')
      title=$(echo "$result" | jq -r '.title')
      status=$(echo "$result" | jq -r '.status')
      priority=$(echo "$result" | jq -r '.priority // "medium"')
      description=$(echo "$result" | jq -r '.description // ""')

      echo -e "${BOLD}$project_name:$task_id${NC} - $title"
      echo -e "  Status:      $status"
      echo -e "  Priority:    $priority"
      if [[ -n "$description" ]]; then
        echo -e "  Description: $description"
      fi
    fi
  fi
}

main "$@"
