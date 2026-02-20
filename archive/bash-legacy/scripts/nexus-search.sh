#!/usr/bin/env bash
###CLEO
# command: nexus-search
# category: intelligence
# synopsis: Search tasks across registered projects using pattern matching
# relevance: high
# flags: --format,--json,--human,--pattern,--limit
# exits: 0,70,72
# json-output: true
# json-default: true
# note: Part of Nexus Intelligence System - pattern-based cross-project search
###END
# CLEO Nexus Search Command
# Search tasks across registered projects using pattern matching
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
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  DIM='\033[2m'
  NC='\033[0m'
else
  BOLD='' GREEN='' YELLOW='' DIM='' NC=''
fi

# Options
FORMAT=""
LIMIT="20"
PROJECT_FILTER=""
PATTERN=""
COMMAND_NAME="nexus-search"

#######################################
# Show usage information
#######################################
usage() {
  cat << EOF
Usage: cleo nexus-search <pattern> [options]

Search tasks across registered projects using pattern matching.

ARGUMENTS:
    <pattern>               Search pattern (supports wildcards with *)

OPTIONS:
    --project NAME          Limit search to specific project
    --limit N               Maximum results to return (default: 20)
    --json                  JSON output format
    --human                 Human-readable output (default)
    -h, --help              Show this help message

SEARCH PATTERNS:
    *:T001                  Task ID T001 in any project (wildcard)
    T*                      All tasks starting with T (within scope)
    my-api:*                All tasks in my-api project
    *auth*                  Tasks with "auth" in title or description

EXAMPLES:
    # Search for task T001 across all projects
    cleo nexus-search "*:T001"

    # Search for authentication-related tasks
    cleo nexus-search "*auth*" --limit 10

    # Search within specific project
    cleo nexus-search "api" --project my-backend

    # Get JSON output for programmatic use
    cleo nexus-search "*bug*" --json

EXIT CODES:
    0   Success
    1   General error
    2   Invalid input
    71  Project not found in registry

SEE ALSO:
    cleo nexus          Main Nexus command
    cleo nexus-query    Query specific tasks
    cleo nexus-discover Discover related tasks
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
# Search tasks in a single project
#######################################
search_project() {
  local project_name="$1"
  local pattern="$2"
  local project_data

  project_data=$(nexus_get_project "$project_name")
  if [[ "$project_data" == "{}" ]]; then
    return 1
  fi

  local project_path
  project_path=$(echo "$project_data" | jq -r '.path')
  local todo_file="${project_path}/.cleo/todo.json"

  if [[ ! -f "$todo_file" ]]; then
    return 1
  fi

  # Convert shell pattern to jq regex (basic support)
  local regex_pattern="${pattern//\*/.*}"

  # Search in tasks - match ID, title, or description
  jq --arg pattern "$regex_pattern" --arg project "$project_name" '
    [.tasks[] |
    select(
      (.id | test($pattern; "i")) or
      (.title | test($pattern; "i")) or
      (.description // "" | test($pattern; "i"))
    ) |
    . + {_project: $project}]
  ' "$todo_file" 2>/dev/null || echo "[]"
}

#######################################
# Search across all projects
#######################################
search_all_projects() {
  local pattern="$1"
  local limit="$2"
  local registry_path

  registry_path=$(nexus_get_registry_path)

  if [[ ! -f "$registry_path" ]]; then
    echo "[]"
    return 0
  fi

  local results="[]"
  local project_names
  readarray -t project_names < <(jq -r '.projects[].name' "$registry_path" 2>/dev/null)

  for project in "${project_names[@]}"; do
    local project_results
    project_results=$(search_project "$project" "$pattern")

    if [[ -n "$project_results" && "$project_results" != "[]" ]]; then
      results=$(echo "$results" | jq --argjson new "$project_results" '. + $new')
    fi
  done

  # Apply limit
  echo "$results" | jq --argjson limit "$limit" '.[:$limit]'
}

#######################################
# Parse command-line arguments
# Sets global variables: FORMAT, PATTERN, LIMIT, PROJECT_FILTER
#######################################
parse_args() {
  PATTERN=""

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
      --limit)
        LIMIT="$2"
        shift 2
        ;;
      --project)
        PROJECT_FILTER="$2"
        shift 2
        ;;
      -*)
        echo "Error: Unknown option: $1" >&2
        echo "Try 'cleo nexus-search --help' for more information." >&2
        exit "${EXIT_INVALID_INPUT:-2}"
        ;;
      *)
        if [[ -z "$PATTERN" ]]; then
          PATTERN="$1"
        else
          echo "Error: Multiple patterns not supported" >&2
          exit "${EXIT_INVALID_INPUT:-2}"
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$PATTERN" ]]; then
    echo "Error: Search pattern required" >&2
    echo "Usage: cleo nexus-search <pattern>" >&2
    echo "Try 'cleo nexus-search --help' for more information." >&2
    exit "${EXIT_INVALID_INPUT:-2}"
  fi

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
  local pattern="$PATTERN"

  # Ensure Nexus is initialized
  if ! nexus_init 2>/dev/null; then
    if [[ "$FORMAT" == "json" ]]; then
      jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $ver,
            "command": "nexus-search",
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

  # Handle wildcard query syntax (*:T001)
  if [[ "$pattern" =~ ^\*:(.+)$ ]]; then
    # Use nexus_query for wildcard task ID search
    local task_id="${BASH_REMATCH[1]}"
    local result
    local query_exit=0
    result=$(nexus_query "*:$task_id" "--json" 2>/dev/null) || query_exit=$?
    if [[ $query_exit -eq 0 ]]; then
      if [[ "$FORMAT" == "json" ]]; then
        jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
               --arg pattern "$pattern" --argjson result "$result" \
          '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
              "format": "json",
              "version": $ver,
              "command": "nexus-search",
              "timestamp": $ts
            },
            "success": true,
            "pattern": $pattern,
            "results": (if ($result | type) == "array" then $result else [$result] end)
          }'
      else
        # Human-readable output
        if [[ "$(echo "$result" | jq -r 'type')" == "array" ]]; then
          local count
          count=$(echo "$result" | jq 'length')
          echo -e "${BOLD}Found $count matching tasks:${NC}"
          echo "$result" | jq -r '.[] | "  \(.id) [\(._project)] \(.title) - \(.status)"'
        else
          echo -e "${BOLD}Found 1 matching task:${NC}"
          echo "$result" | jq -r '"  \(.id) [\(._project)] \(.title) - \(.status)"'
        fi
      fi
      exit 0
    fi
  fi

  # Execute pattern search
  local results
  if [[ -n "$PROJECT_FILTER" ]]; then
    if ! results=$(search_project "$PROJECT_FILTER" "$pattern"); then
      if [[ "$FORMAT" == "json" ]]; then
        jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
               --arg project "$PROJECT_FILTER" \
          '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
              "format": "json",
              "version": $ver,
              "command": "nexus-search",
              "timestamp": $ts
            },
            "success": false,
            "error": {
              "code": "E_PROJECT_NOT_FOUND",
              "message": ("Project not found: " + $project)
            }
          }'
      else
        echo "Error: Project not found: $PROJECT_FILTER" >&2
      fi
      exit "${EXIT_NEXUS_PROJECT_NOT_FOUND:-71}"
    fi
  else
    results=$(search_all_projects "$pattern" "$LIMIT")
  fi

  # Output results
  if [[ "$FORMAT" == "json" ]]; then
    jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
           --arg pattern "$pattern" --argjson results "$results" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $ver,
          "command": "nexus-search",
          "timestamp": $ts
        },
        "success": true,
        "pattern": $pattern,
        "resultCount": ($results | length),
        "results": $results
      }'
  else
    # Human-readable output
    local count
    count=$(echo "$results" | jq 'length')

    if [[ "$count" -eq 0 ]]; then
      echo -e "${YELLOW}No tasks found matching pattern:${NC} $pattern"
      exit 0
    fi

    echo -e "${BOLD}Search results for:${NC} $pattern"
    echo -e "${GREEN}Found $count tasks:${NC}"
    echo ""
    echo "$results" | jq -r '.[] | "  \(.id) [\(._project)] \(.title)\n    Status: \(.status) | Priority: \(.priority // "medium")"'
  fi
}

main "$@"
