#!/usr/bin/env bash
###CLEO
# command: nexus
# category: write
# synopsis: Global intelligence system for cross-project task discovery and dependency analysis
# relevance: critical
# flags: --format,--json,--human,--permissions,--name,--method,--limit,--reverse
# exits: 0,2,70,71,72,73,74,75,76,77,78
# json-output: true
# json-default: true
# subcommands: init,register,unregister,list,query,discover,deps,sync
###END
# CLEO Nexus Command
# Global intelligence system for cross-project task coordination
# Provides discovery, querying, and dependency analysis across registered projects
set -euo pipefail

TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source libraries
LIB_DIR="${SCRIPT_DIR}/../lib"

# Core dependencies
for lib in logging.sh output-format.sh flags.sh error-json.sh exit-codes.sh \
           nexus-registry.sh nexus-query.sh nexus-deps.sh nexus-permissions.sh \
           graph-rag.sh; do
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
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  DIM='\033[2m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  GREEN='' YELLOW='' BLUE='' DIM='' BOLD='' NC=''
fi

# Options
FORMAT=""
COMMAND_NAME="nexus"

#######################################
# Show usage information
#######################################
usage() {
  cat << EOF
Usage: cleo nexus <command> [options]

CLEO Nexus - Global Intelligence System

Cross-project task coordination with automatic discovery, dependency analysis,
and intelligent query routing across all registered projects.

COMMANDS:
    init                  Initialize Nexus (~/.cleo/nexus/)
    register <path>       Register a project in global registry
    unregister <name>     Remove a project from registry
    list                  List all registered projects
    query <project:task>  Query cross-project task
    discover <task>       Find related tasks across projects
    deps <task>           Show cross-project dependencies
    sync [project]        Sync project metadata (task count, labels)

SUBCOMMAND OPTIONS:
    register:
        --name NAME             Custom project name (default: directory name)
        --permissions PERMS     Permissions: read|write|execute (default: read)

    discover:
        --method METHOD         Discovery method: labels|description|files|auto
        --limit N               Max results (default: 10)

    deps:
        --reverse               Show reverse dependencies (what depends on this)

    sync:
        (no arguments)          Sync all registered projects
        <project>               Sync specific project by name or hash

GLOBAL OPTIONS:
    --json                  JSON output format
    --human                 Human-readable output (default)
    -h, --help              Show this help message

EXAMPLES:
    # Initialize Nexus
    cleo nexus init

    # Register a project
    cleo nexus register /path/to/project --name my-api --permissions read

    # List registered projects
    cleo nexus list
    cleo nexus list --json

    # Query a task from another project
    cleo nexus query my-api:T001

    # Discover related tasks
    cleo nexus discover my-api:T001 --method labels --limit 5

    # Show cross-project dependencies
    cleo nexus deps my-api:T015
    cleo nexus deps my-api:T015 --reverse

    # Sync metadata
    cleo nexus sync              # Sync all
    cleo nexus sync my-api       # Sync one project

QUERY SYNTAX:
    <project>:<task_id>         Fully qualified task reference
    <task_id>                   Current project task

    Examples:
        my-api:T001             Task T001 from my-api project
        T042                    Task T042 from current project
        other-proj:T500         Task T500 from other-proj

EXIT CODES:
    0   Success
    1   General error
    4   Not found (project or task)
    6   Validation failed
    76  Project already registered
    77  Permission denied
    78  Project not registered

SEE ALSO:
    cleo find               Fuzzy search within current project
    cleo show               Show task details
    cleo deps               Show local task dependencies
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
    version="0.79.1"
  fi
  echo "$version"
}

#######################################
# Initialize Nexus
#######################################
nexus_cmd_init() {
  if ! nexus_init; then
    if [[ "$FORMAT" == "json" ]]; then
      jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $ver,
            "command": "nexus init",
            "timestamp": $ts
          },
          "success": false,
          "error": {
            "code": "E_NEXUS_INIT_FAILED",
            "message": "Failed to initialize Nexus directory"
          }
        }'
    else
      echo -e "${RED}Error: Failed to initialize Nexus${NC}" >&2
    fi
    exit 1
  fi

  if [[ "$FORMAT" == "json" ]]; then
    jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $ver,
          "command": "nexus init",
          "timestamp": $ts
        },
        "success": true,
        "message": "Nexus initialized at ~/.cleo/nexus/"
      }'
  else
    echo -e "${GREEN}✓${NC} Nexus initialized at ${BLUE}~/.cleo/nexus/${NC}"
  fi
}

#######################################
# Register a project
#######################################
nexus_cmd_register() {
  local path="${1:-}"
  local name=""
  local permissions="read"

  shift || true

  # Parse register-specific options
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name)
        name="$2"
        shift 2
        ;;
      --permissions)
        permissions="$2"
        shift 2
        ;;
      *)
        echo "Error: Unknown option: $1" >&2
        exit "${EXIT_INVALID_INPUT:-2}"
        ;;
    esac
  done

  if [[ -z "$path" ]]; then
    echo "Error: Project path required" >&2
    echo "Usage: cleo nexus register <path> [--name NAME] [--permissions PERMS]" >&2
    exit "${EXIT_INVALID_INPUT:-2}"
  fi

  local hash
  hash=$(nexus_register "$path" "$name" "$permissions")
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    if [[ "$FORMAT" == "json" ]]; then
      local error_msg="Failed to register project"
      case $exit_code in
        "$EXIT_NOT_FOUND") error_msg="Path missing .cleo/todo.json: $path" ;;
        "$EXIT_VALIDATION_ERROR") error_msg="Project name already exists" ;;
        "$EXIT_NEXUS_PROJECT_EXISTS") error_msg="Project already registered" ;;
      esac
      jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg msg "$error_msg" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $ver,
            "command": "nexus register",
            "timestamp": $ts
          },
          "success": false,
          "error": {
            "code": "E_REGISTER_FAILED",
            "message": $msg
          }
        }'
    fi
    exit "$exit_code"
  fi

  # Get project details for output
  local project
  project=$(nexus_get_project "$hash")
  local project_name
  project_name=$(echo "$project" | jq -r '.name')

  if [[ "$FORMAT" == "json" ]]; then
    jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
           --arg hash "$hash" --arg name "$project_name" --arg path "$path" --arg perms "$permissions" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $ver,
          "command": "nexus register",
          "timestamp": $ts
        },
        "success": true,
        "project": {
          "hash": $hash,
          "name": $name,
          "path": $path,
          "permissions": $perms
        }
      }'
  else
    echo -e "${GREEN}✓${NC} Registered project ${BOLD}$project_name${NC}"
    echo -e "  Hash:        $hash"
    echo -e "  Path:        $path"
    echo -e "  Permissions: $permissions"
  fi
}

#######################################
# Unregister a project
#######################################
nexus_cmd_unregister() {
  local name_or_hash="${1:-}"

  if [[ -z "$name_or_hash" ]]; then
    echo "Error: Project name or hash required" >&2
    echo "Usage: cleo nexus unregister <name>" >&2
    exit "${EXIT_INVALID_INPUT:-2}"
  fi

  if ! nexus_unregister "$name_or_hash"; then
    local exit_code=$?
    if [[ "$FORMAT" == "json" ]]; then
      jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $ver,
            "command": "nexus unregister",
            "timestamp": $ts
          },
          "success": false,
          "error": {
            "code": "E_UNREGISTER_FAILED",
            "message": "Project not found in registry"
          }
        }'
    fi
    exit "$exit_code"
  fi

  if [[ "$FORMAT" == "json" ]]; then
    jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg id "$name_or_hash" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $ver,
          "command": "nexus unregister",
          "timestamp": $ts
        },
        "success": true,
        "message": "Project unregistered",
        "project": $id
      }'
  else
    echo -e "${GREEN}✓${NC} Unregistered project ${BOLD}$name_or_hash${NC}"
  fi
}

#######################################
# List registered projects
#######################################
nexus_cmd_list() {
  if [[ "$FORMAT" == "json" ]]; then
    local projects
    projects=$(nexus_list --json)
    jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson projects "$projects" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $ver,
          "command": "nexus list",
          "timestamp": $ts
        },
        "success": true,
        "projects": $projects
      }'
  else
    nexus_list
  fi
}

#######################################
# Query a cross-project task
#######################################
nexus_cmd_query() {
  local query="${1:-}"

  if [[ -z "$query" ]]; then
    echo "Error: Query required (format: project:task_id or task_id)" >&2
    echo "Usage: cleo nexus query <project:task_id>" >&2
    exit "${EXIT_INVALID_INPUT:-2}"
  fi

  local result
  # Always get JSON from nexus_query, CLI handles formatting
  if ! result=$(nexus_query "$query" "--json"); then
    local exit_code=$?
    if [[ "$FORMAT" == "json" ]]; then
      jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg query "$query" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $ver,
            "command": "nexus query",
            "timestamp": $ts
          },
          "success": false,
          "query": $query,
          "error": {
            "code": "E_QUERY_FAILED",
            "message": "Task not found or query invalid"
          }
        }'
    fi
    exit "$exit_code"
  fi

  if [[ "$FORMAT" == "json" ]]; then
    jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
           --arg query "$query" --argjson result "$result" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $ver,
          "command": "nexus query",
          "timestamp": $ts
        },
        "success": true,
        "query": $query,
        "task": $result
      }'
  else
    # Human-readable output
    local task_id project_name title status priority
    task_id=$(echo "$result" | jq -r '.id')
    project_name=$(echo "$result" | jq -r '.project')
    title=$(echo "$result" | jq -r '.title')
    status=$(echo "$result" | jq -r '.status')
    priority=$(echo "$result" | jq -r '.priority // "medium"')

    echo -e "${BOLD}$project_name:$task_id${NC} - $title"
    echo -e "  Status:   $status"
    echo -e "  Priority: $priority"
  fi
}

#######################################
# Discover related tasks
#######################################
nexus_cmd_discover() {
  local task_query="${1:-}"
  local method="auto"
  local limit="10"

  shift || true

  # Parse discover-specific options
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --method)
        method="$2"
        shift 2
        ;;
      --limit)
        limit="$2"
        shift 2
        ;;
      *)
        echo "Error: Unknown option: $1" >&2
        exit "${EXIT_INVALID_INPUT:-2}"
        ;;
    esac
  done

  if [[ -z "$task_query" ]]; then
    echo "Error: Task query required" >&2
    echo "Usage: cleo nexus discover <task_query> [--method METHOD] [--limit N]" >&2
    exit "${EXIT_INVALID_INPUT:-2}"
  fi

  local results
  if ! results=$(discover_across_projects "$task_query" "$method" "$limit"); then
    if [[ "$FORMAT" == "json" ]]; then
      jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $ver,
            "command": "nexus discover",
            "timestamp": $ts
          },
          "success": false,
          "error": {
            "code": "E_DISCOVER_FAILED",
            "message": "Discovery failed"
          }
        }'
    fi
    exit 1
  fi

  if [[ "$FORMAT" == "json" ]]; then
    jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
           --arg query "$task_query" --argjson results "$results" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $ver,
          "command": "nexus discover",
          "timestamp": $ts
        },
        "success": true,
        "query": $query,
        "results": $results
      }'
  else
    # Human-readable output
    echo -e "${BOLD}Related tasks for:${NC} $task_query"
    echo "$results" | jq -r '.[] | "\(.project):\(.id) - \(.title) [\(.similarity)]"'
  fi
}

#######################################
# Show cross-project dependencies
#######################################
nexus_cmd_deps() {
  local task_query="${1:-}"
  local reverse=false

  shift || true

  # Parse deps-specific options
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --reverse)
        reverse=true
        shift
        ;;
      *)
        echo "Error: Unknown option: $1" >&2
        exit "${EXIT_INVALID_INPUT:-2}"
        ;;
    esac
  done

  if [[ -z "$task_query" ]]; then
    echo "Error: Task query required" >&2
    echo "Usage: cleo nexus deps <task_query> [--reverse]" >&2
    exit "${EXIT_INVALID_INPUT:-2}"
  fi

  local deps
  if ! deps=$(nexus_deps "$task_query" "$reverse"); then
    if [[ "$FORMAT" == "json" ]]; then
      jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $ver,
            "command": "nexus deps",
            "timestamp": $ts
          },
          "success": false,
          "error": {
            "code": "E_DEPS_FAILED",
            "message": "Failed to analyze dependencies"
          }
        }'
    fi
    exit 1
  fi

  if [[ "$FORMAT" == "json" ]]; then
    jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
           --arg query "$task_query" --argjson deps "$deps" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $ver,
          "command": "nexus deps",
          "timestamp": $ts
        },
        "success": true,
        "query": $query,
        "dependencies": $deps
      }'
  else
    # Human-readable output
    local direction="Dependencies of"
    [[ "$reverse" == true ]] && direction="Reverse dependencies of"
    echo -e "${BOLD}$direction:${NC} $task_query"
    echo "$deps" | jq -r '.[] | "  \(.project):\(.id) - \(.title)"'
  fi
}

#######################################
# Sync project metadata
#######################################
nexus_cmd_sync() {
  local project="${1:-all}"

  if [[ "$project" == "all" ]]; then
    # Sync all registered projects
    local registry_path
    registry_path=$(nexus_get_registry_path)

    if [[ ! -f "$registry_path" ]]; then
      echo "Error: Nexus registry not initialized" >&2
      exit 1
    fi

    local project_names
    project_names=$(jq -r '.projects[].name' "$registry_path")

    local synced=0
    local failed=0
    while IFS= read -r name; do
      if nexus_sync "$name" 2>/dev/null; then
        ((synced++))
      else
        ((failed++))
      fi
    done <<< "$project_names"

    if [[ "$FORMAT" == "json" ]]; then
      jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
             --argjson synced "$synced" --argjson failed "$failed" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $ver,
            "command": "nexus sync",
            "timestamp": $ts
          },
          "success": true,
          "synced": $synced,
          "failed": $failed
        }'
    else
      echo -e "${GREEN}✓${NC} Synced $synced projects"
      [[ "$failed" -gt 0 ]] && echo -e "${YELLOW}!${NC} Failed to sync $failed projects"
    fi
  else
    # Sync specific project
    if ! nexus_sync "$project"; then
      if [[ "$FORMAT" == "json" ]]; then
        jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
              "format": "json",
              "version": $ver,
              "command": "nexus sync",
              "timestamp": $ts
            },
            "success": false,
            "error": {
              "code": "E_SYNC_FAILED",
              "message": "Failed to sync project"
            }
          }'
      fi
      exit "$EXIT_NOT_FOUND"
    fi

    if [[ "$FORMAT" == "json" ]]; then
      jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg proj "$project" \
        '{
          "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
          "_meta": {
            "format": "json",
            "version": $ver,
            "command": "nexus sync",
            "timestamp": $ts
          },
          "success": true,
          "project": $proj
        }'
    else
      echo -e "${GREEN}✓${NC} Synced project ${BOLD}$project${NC}"
    fi
  fi
}

#######################################
# Main command router
#######################################
main() {
  local subcommand="${1:-help}"
  shift || true

  # Parse common flags
  parse_common_flags "$@"
  set -- "${REMAINING_ARGS[@]}"

  # Apply flags to globals
  apply_flags_to_globals
  FORMAT="${FORMAT:-}"

  # Resolve format (TTY-aware)
  FORMAT=$(resolve_format "$FORMAT")

  # Handle help
  if [[ "$FLAG_HELP" == true || "$subcommand" == "help" || "$subcommand" == "--help" || "$subcommand" == "-h" ]]; then
    usage
    exit 0
  fi

  # Route to subcommand
  case "$subcommand" in
    init)
      nexus_cmd_init "$@"
      ;;
    register)
      nexus_cmd_register "$@"
      ;;
    unregister)
      nexus_cmd_unregister "$@"
      ;;
    list)
      nexus_cmd_list "$@"
      ;;
    query)
      nexus_cmd_query "$@"
      ;;
    discover)
      nexus_cmd_discover "$@"
      ;;
    deps)
      nexus_cmd_deps "$@"
      ;;
    sync)
      nexus_cmd_sync "$@"
      ;;
    *)
      if [[ "$FORMAT" == "json" ]]; then
        jq -nc --arg ver "$(get_version)" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg cmd "$subcommand" \
          '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
              "format": "json",
              "version": $ver,
              "command": "nexus",
              "timestamp": $ts
            },
            "success": false,
            "error": {
              "code": "E_UNKNOWN_COMMAND",
              "message": ("Unknown subcommand: " + $cmd),
              "fix": "Run '\''cleo nexus --help'\'' for usage"
            }
          }'
      else
        echo "Error: Unknown subcommand: $subcommand" >&2
        echo "Run 'cleo nexus --help' for usage" >&2
      fi
      exit 1
      ;;
  esac
}

main "$@"
