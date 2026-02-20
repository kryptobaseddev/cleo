#!/usr/bin/env bash
###CLEO
# command: nexus-discover
# category: intelligence
# synopsis: Discover related tasks across registered projects using AI-powered semantic search
# relevance: high
# flags: --format,--json,--human,--query,--limit
# exits: 0,70,73
# json-output: true
# json-default: true
# note: Part of Nexus Intelligence System - AI-powered cross-project task discovery
###END
# CLEO Nexus Discover Command
# Discover related tasks across registered projects using AI-powered semantic search
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source required libraries
for lib in output-format.sh flags.sh exit-codes.sh nexus-registry.sh nexus-query.sh graph-rag.sh; do
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
  DIM='\033[2m'
  NC='\033[0m'
else
  BOLD='' DIM='' NC=''
fi

# Options
FORMAT=""
METHOD="auto"
LIMIT="10"
TASK_QUERY=""
COMMAND_NAME="nexus-discover"

#######################################
# Show usage information
#######################################
usage() {
  cat << EOF
Usage: cleo nexus-discover <task_query> [options]

Discover related tasks across registered projects using semantic search.

ARGUMENTS:
    <task_query>            Task query (project:task_id or task_id)

OPTIONS:
    --method METHOD         Discovery method: labels|description|files|auto
    --limit N               Maximum results to return (default: 10)
    --json                  JSON output format
    --human                 Human-readable output (default)
    -h, --help              Show this help message

DISCOVERY METHODS:
    labels                  Match tasks with similar labels
    description             Semantic similarity of descriptions
    files                   Tasks modifying similar files
    auto                    Automatically select best method (default)

EXAMPLES:
    # Discover related tasks (auto method)
    cleo nexus-discover my-api:T001

    # Discover using label matching
    cleo nexus-discover T042 --method labels --limit 5

    # Discover across projects with JSON output
    cleo nexus-discover other-proj:T500 --method description --json

EXIT CODES:
    0   Success
    1   General error or discovery failed
    2   Invalid input
    4   Task not found
    71  Project not found in registry
    73  Invalid query syntax

SEE ALSO:
    cleo nexus          Main Nexus command
    cleo nexus-query    Query specific tasks
    cleo nexus-search   Search tasks by pattern
    cleo discover       Discover within current project
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
# Sets global variables: FORMAT, METHOD, LIMIT, TASK_QUERY
#######################################
parse_args() {
  TASK_QUERY=""

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
      --method)
        METHOD="$2"
        shift 2
        ;;
      --limit)
        LIMIT="$2"
        shift 2
        ;;
      -*)
        echo "Error: Unknown option: $1" >&2
        echo "Try 'cleo nexus-discover --help' for more information." >&2
        exit "${EXIT_INVALID_INPUT:-2}"
        ;;
      *)
        if [[ -z "$TASK_QUERY" ]]; then
          TASK_QUERY="$1"
        else
          echo "Error: Multiple task queries not supported" >&2
          exit "${EXIT_INVALID_INPUT:-2}"
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$TASK_QUERY" ]]; then
    echo "Error: Task query required" >&2
    echo "Usage: cleo nexus-discover <task_query>" >&2
    echo "Try 'cleo nexus-discover --help' for more information." >&2
    exit "${EXIT_INVALID_INPUT:-2}"
  fi

  # Validate method
  case "$METHOD" in
    labels|description|files|auto)
      ;;
    *)
      echo "Error: Invalid method: $METHOD" >&2
      echo "Valid methods: labels, description, files, auto" >&2
      exit "${EXIT_INVALID_INPUT:-2}"
      ;;
  esac

  # Validate limit
  if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [[ "$LIMIT" -lt 1 ]]; then
    echo "Error: Limit must be a positive integer" >&2
    exit "${EXIT_INVALID_INPUT:-2}"
  fi
}

#######################################
# Main execution
#######################################
main() {
  parse_args "$@"
  local task_query="$TASK_QUERY"

  # Ensure Nexus is initialized
  if ! nexus_init 2>/dev/null; then
    if [[ "$FORMAT" == "json" ]]; then
      jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $ver,
            "command": "nexus-discover",
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

  # Execute discovery
  local results
  local exit_code=0
  results=$(discover_across_projects "$task_query" "$METHOD" "$LIMIT") || exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
             --arg query "$task_query" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $ver,
            "command": "nexus-discover",
            "timestamp": $ts
          },
          "success": false,
          "query": $query,
          "error": {
            "code": "E_DISCOVER_FAILED",
            "message": "Discovery failed"
          }
        }'
    else
      echo "Error: Discovery failed for task: $task_query" >&2
    fi
    exit "$exit_code"
  fi

  # Output results
  if [[ "$FORMAT" == "json" ]]; then
    jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
           --arg query "$task_query" --arg method "$METHOD" --argjson results "$results" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $ver,
          "command": "nexus-discover",
          "timestamp": $ts
        },
        "success": true,
        "query": $query,
        "method": $method,
        "results": $results
      }'
  else
    # Human-readable output
    local count
    count=$(echo "$results" | jq 'length')

    if [[ "$count" -eq 0 ]]; then
      echo -e "${BOLD}No related tasks found${NC}"
      exit 0
    fi

    echo -e "${BOLD}Related tasks for:${NC} $task_query ${DIM}(method: $METHOD)${NC}"
    echo -e "${BOLD}Found $count results:${NC}"
    echo ""
    echo "$results" | jq -r '.[] | "  \(.project):\(.taskId) - Score: \(.score)\n    Type: \(.type) | Reason: \(.reason)"'
  fi
}

main "$@"
