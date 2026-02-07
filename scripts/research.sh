#!/usr/bin/env bash
###CLEO
# command: research
# category: read
# synopsis: Multi-source web research aggregation with MCP servers (Tavily, Context7, Reddit)
# aliases: dig
# relevance: high
# flags: --format,--depth,--output,--topic,--subreddit,--include-reddit,--link-task,--plan-only,--json,--url,--reddit,--library
# exits: 0,2,3,4,5,6,101
# json-output: true
# subcommands: init,list,show,inject,link,pending,archive,archive-list,status,stats,validate
###END
#
# Web research aggregation command for cleo
#
# Aggregates content from multiple sources (Tavily, Context7, Reddit, URLs)
# and produces structured research outputs with citation tracking.
#
# Usage:
#   cleo research "query"                    # Query mode
#   cleo research --url URL [URL...]         # URL extraction
#   cleo research --reddit "topic" -s sub    # Reddit search
#   cleo research --library NAME -t TOPIC    # Library docs
#   cleo research --execute                  # Execute stored plan
#
set -euo pipefail

# ============================================================================
# Setup
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
# Check for lib in source directory (dev mode) or installed location
if [[ -d "${SCRIPT_DIR}/../lib" ]]; then
  LIB_DIR="${SCRIPT_DIR}/../lib"
else
  LIB_DIR="$CLEO_HOME/lib"
fi
VERSION="$(cat "$CLEO_HOME/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "0.0.0")"

# Source libraries
source "$LIB_DIR/logging.sh" 2>/dev/null || true
source "$LIB_DIR/output-format.sh" 2>/dev/null || true
source "$LIB_DIR/exit-codes.sh" 2>/dev/null || true
source "$LIB_DIR/flags.sh" 2>/dev/null || true
source "$LIB_DIR/config.sh" 2>/dev/null || true
source "$LIB_DIR/research-manifest.sh" 2>/dev/null || true

# Command metadata
COMMAND_NAME="research"
COMMAND_VERSION="1.0.0"

# Initialize flag defaults
init_flag_defaults 2>/dev/null || true

# Defaults
MODE=""
QUERY=""
URLS=()
REDDIT_TOPIC=""
SUBREDDIT=""
LIBRARY=""
TOPIC=""
DEPTH="standard"
OUTPUT_DIR=""
INCLUDE_REDDIT="false"
EXECUTE="false"
LINK_TASK=""
PLAN_ONLY="false"

# Show subcommand options
SHOW_ID=""
SHOW_FULL="false"
SHOW_FINDINGS_ONLY="true"

# Link subcommand options
LINK_TASK_ID=""
LINK_RESEARCH_ID=""
LINK_UNLINK="false"
LINK_NOTES=""

# Links subcommand options (show research for a task)
LINKS_TASK_ID=""

# List subcommand options
LIST_STATUS=""
LIST_TOPIC=""
LIST_SINCE=""
LIST_ACTIONABLE="false"
LIST_LIMIT="20"
LIST_TYPE=""

# Inject subcommand options
INJECT_RAW="false"
INJECT_CLIPBOARD="false"

# Get subcommand options
GET_ID=""

# Pending subcommand options
PENDING_BRIEF="false"

# Archive subcommand options
ARCHIVE_THRESHOLD=""
ARCHIVE_PERCENT=""
# Note: --dry-run is handled by common flags (FLAG_DRY_RUN)

# Validate subcommand options
VALIDATE_FIX="false"
VALIDATE_PROTOCOL="false"
VALIDATE_TASK_ID=""

# Archive-list subcommand options
ARCHIVE_LIST_LIMIT="50"
ARCHIVE_LIST_SINCE=""

# Compact subcommand options
# (no options needed)

# Stats subcommand options
# (no options needed)

# Research storage
RESEARCH_DIR=".cleo/research"

# ============================================================================
# Usage
# ============================================================================

usage() {
  cat << 'EOF'
cleo research - Multi-source web research aggregation

USAGE
  cleo research [OPTIONS] "QUERY"
  cleo research --url URL [URL...]
  cleo research --reddit "TOPIC" --subreddit SUB
  cleo research --library NAME [--topic TOPIC]
  cleo research init

SUBCOMMANDS
  init             Initialize research outputs directory with protocol files
  list             List research entries from manifest with filtering
  show <id>        Show details of a research entry from the manifest
  inject           Output the subagent injection template for prompts
  link <task> <research>  Link a research entry to a task (bidirectional)
  links <task>     Show all research linked to a task
  unlink <task> <research>  Remove link between research and task
  pending          Show entries with needs_followup (orchestrator handoffs)
  get <id>         Get single entry by ID (raw JSON object)
  archive          Archive old manifest entries to maintain context efficiency
  archive-list     List entries from the archive file
  status           Show manifest size and archival status
  stats            Show comprehensive manifest statistics
  compact          Remove duplicate/obsolete entries from manifest
  validate         Validate manifest file integrity and entry format

ARCHIVE OPTIONS
  --threshold N    Archive threshold in bytes (default: 200000 = ~50K tokens)
  --percent N      Percentage of oldest entries to archive (default: 50)
  --dry-run        Show what would be archived without making changes

ARCHIVE-LIST OPTIONS
  --limit N        Max entries to return (default: 50)
  --since DATE     Filter entries archived since date (ISO 8601: YYYY-MM-DD)

VALIDATE OPTIONS
  --fix            Remove invalid entries from manifest (destructive)

LIST OPTIONS
  --status STATUS  Filter by status (complete|partial|blocked|archived)
  --type TYPE      Filter by agent type (research|implementation|validation|documentation|analysis)
  --topic TOPIC    Filter by topic tag
  --since DATE     Filter entries since date (ISO 8601: YYYY-MM-DD)
  --limit N        Max entries to return (default: 20)
  --actionable     Only show actionable entries

MODES
  (default)        Free-text query - comprehensive web research
  --url            Extract and synthesize from specific URLs
  --reddit         Reddit discussion search via Tavily
  --library        Library/framework documentation via Context7

OPTIONS
  -d, --depth LEVEL      Search depth: quick, standard, deep (default: standard)
  -o, --output DIR       Output directory (default: .cleo/research/)
  -t, --topic TOPIC      Topic filter for library mode
  -s, --subreddit SUB    Subreddit for Reddit mode
  --include-reddit       Include Reddit in query mode
  --link-task ID         Link research output to a task
  --plan-only            Output research plan without executing
  --execute              Execute a previously stored plan
  -f, --format FMT       Output format: json, text (default: auto)
  --json                 Force JSON output
  -h, --help             Show this help

SHOW OPTIONS
  --full                 Include full file content (WARNING: large context)
  --findings-only        Only key_findings array (default)

LINK OPTIONS
  --notes TEXT           Custom note text instead of default

INJECT OPTIONS
  --raw                  Output template without variable substitution
  --clipboard            Copy to clipboard (pbcopy/xclip)

EXAMPLES
  # Query mode - comprehensive research
  cleo research "TypeScript decorators best practices"

  # With Reddit included
  cleo research "React state management" --include-reddit -d deep

  # URL extraction
  cleo research --url https://example.com/article1 https://example.com/article2

  # Reddit search
  cleo research --reddit "authentication" --subreddit webdev

  # Library documentation
  cleo research --library svelte --topic reactivity

  # Link to task
  cleo research "API design patterns" --link-task T042

  # Plan only (outputs what Claude should do)
  cleo research "microservices" --plan-only

  # Initialize research outputs directory
  cleo research init

  # Show a research entry
  cleo research show topic-2026-01-17
  cleo research show topic-2026-01-17 --full

  # Get injection template for prompts
  cleo research inject
  cleo research inject --raw
  cleo research inject --clipboard

  # Link research to a task
  cleo research link T042 topic-2026-01-17
  cleo research link T042 topic-2026-01-17 --notes "Related to feature design"

OUTPUT
  Creates research files in .cleo/research/:
  - research_[id].json     Structured research plan/results
  - research_[id].md       Human-readable report (after execution)

MCP SERVERS USED
  - tavily (search and extraction)
  - context7 (library documentation)
  - sequential-thinking (synthesis)
  - WebSearch (fallback)

EOF
  exit 0
}

# ============================================================================
# Helpers
# ============================================================================

generate_id() {
  # Generate short unique ID: R + timestamp + random
  echo "R$(date +%s | tail -c 5)$(head /dev/urandom | tr -dc 'a-z0-9' | head -c 3)"
}

sanitize_query() {
  # Sanitize query for filename: lowercase, replace spaces, remove special chars
  echo "$1" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | head -c 40
}

ensure_research_dir() {
  mkdir -p "$RESEARCH_DIR"
}

timestamp_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# ============================================================================
# Parse Arguments
# ============================================================================

# Parse common flags first (if flags.sh was sourced successfully)
if declare -f parse_common_flags &>/dev/null; then
  parse_common_flags "$@"
  set -- "${REMAINING_ARGS[@]}"

  # Bridge to legacy variables
  apply_flags_to_globals
  FORMAT=$(resolve_format "$FORMAT")

  # Handle help flag
  if [[ "$FLAG_HELP" == true ]]; then
    usage
  fi
fi

# Parse command-specific arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    init)
      MODE="init"
      shift
      ;;
    show)
      MODE="show"
      shift
      # Get research ID (required positional argument)
      if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
        SHOW_ID="$1"
        shift
      fi
      # Parse show-specific options
      while [[ $# -gt 0 ]]; do
        case $1 in
          --full)
            SHOW_FULL="true"
            SHOW_FINDINGS_ONLY="false"
            shift
            ;;
          --findings-only)
            SHOW_FINDINGS_ONLY="true"
            SHOW_FULL="false"
            shift
            ;;
          *)
            break
            ;;
        esac
      done
      ;;
    list)
      MODE="list"
      shift
      # Parse list-specific options
      while [[ $# -gt 0 ]]; do
        case $1 in
          --status)
            LIST_STATUS="$2"
            shift 2
            ;;
          --topic)
            LIST_TOPIC="$2"
            shift 2
            ;;
          --since)
            LIST_SINCE="$2"
            shift 2
            ;;
          --limit)
            LIST_LIMIT="$2"
            shift 2
            ;;
          --actionable)
            LIST_ACTIONABLE="true"
            shift
            ;;
          --type)
            LIST_TYPE="$2"
            shift 2
            ;;
          *)
            break
            ;;
        esac
      done
      ;;
    inject)
      MODE="inject"
      shift
      # Parse inject-specific options
      while [[ $# -gt 0 ]]; do
        case $1 in
          --raw)
            INJECT_RAW="true"
            shift
            ;;
          --clipboard)
            INJECT_CLIPBOARD="true"
            shift
            ;;
          *)
            break
            ;;
        esac
      done
      ;;
    pending)
      MODE="pending"
      shift
      # Parse pending-specific options
      while [[ $# -gt 0 ]]; do
        case $1 in
          --brief)
            PENDING_BRIEF="true"
            shift
            ;;
          *)
            break
            ;;
        esac
      done
      ;;
    get)
      MODE="get"
      shift
      # Get research ID (required positional argument)
      if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
        GET_ID="$1"
        shift
      fi
      ;;
    link)
      MODE="link"
      shift
      # Get task-id (required positional argument)
      if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
        LINK_TASK_ID="$1"
        shift
      fi
      # Get research-id (required positional argument)
      if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
        LINK_RESEARCH_ID="$1"
        shift
      fi
      # Parse link-specific options
      while [[ $# -gt 0 ]]; do
        case $1 in
          --unlink)
            LINK_UNLINK="true"
            shift
            ;;
          --notes)
            LINK_NOTES="$2"
            shift 2
            ;;
          *)
            break
            ;;
        esac
      done
      ;;
    links)
      MODE="links"
      shift
      # Get task-id (required positional argument)
      if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
        LINKS_TASK_ID="$1"
        shift
      fi
      ;;
    unlink)
      MODE="unlink"
      shift
      # Get task-id (required positional argument)
      if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
        LINK_TASK_ID="$1"
        shift
      fi
      # Get research-id (required positional argument)
      if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
        LINK_RESEARCH_ID="$1"
        shift
      fi
      ;;
    archive)
      MODE="archive"
      shift
      # Parse archive-specific options
      while [[ $# -gt 0 ]]; do
        case $1 in
          --threshold)
            ARCHIVE_THRESHOLD="$2"
            shift 2
            ;;
          --percent)
            ARCHIVE_PERCENT="$2"
            shift 2
            ;;
          *)
            break
            ;;
        esac
      done
      ;;
    status)
      MODE="status"
      shift
      # Parse status-specific options
      while [[ $# -gt 0 ]]; do
        case $1 in
          --threshold)
            ARCHIVE_THRESHOLD="$2"
            shift 2
            ;;
          *)
            break
            ;;
        esac
      done
      ;;
    validate)
      MODE="validate"
      shift
      # Parse validate-specific options
      while [[ $# -gt 0 ]]; do
        case $1 in
          --fix)
            VALIDATE_FIX="true"
            shift
            ;;
          --protocol)
            VALIDATE_PROTOCOL="true"
            shift
            ;;
          T[0-9]*)
            VALIDATE_TASK_ID="$1"
            shift
            ;;
          *)
            break
            ;;
        esac
      done
      ;;
    archive-list)
      MODE="archive-list"
      shift
      # Parse archive-list-specific options
      while [[ $# -gt 0 ]]; do
        case $1 in
          --limit)
            ARCHIVE_LIST_LIMIT="$2"
            shift 2
            ;;
          --since)
            ARCHIVE_LIST_SINCE="$2"
            shift 2
            ;;
          *)
            break
            ;;
        esac
      done
      ;;
    compact)
      MODE="compact"
      shift
      ;;
    stats)
      MODE="stats"
      shift
      ;;
    --url)
      MODE="url"
      shift
      while [[ $# -gt 0 && ! "$1" =~ ^-- ]]; do
        URLS+=("$1")
        shift
      done
      ;;
    --reddit)
      MODE="reddit"
      if [[ $# -gt 1 && ! "$2" =~ ^-- ]]; then
        REDDIT_TOPIC="$2"
        shift 2
      else
        shift
      fi
      ;;
    --library)
      MODE="library"
      LIBRARY="$2"
      shift 2
      ;;
    -t|--topic)
      TOPIC="$2"
      shift 2
      ;;
    -s|--subreddit)
      SUBREDDIT="$2"
      shift 2
      ;;
    -d|--depth)
      DEPTH="$2"
      shift 2
      ;;
    -o|--output)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --include-reddit)
      INCLUDE_REDDIT="true"
      shift
      ;;
    --link-task)
      LINK_TASK="$2"
      shift 2
      ;;
    --plan-only)
      PLAN_ONLY="true"
      shift
      ;;
    --execute)
      EXECUTE="true"
      shift
      ;;
    -h|--help)
      usage
      ;;
    -*)
      echo "Error: Unknown option: $1" >&2
      echo "Run 'cleo research --help' for usage." >&2
      exit 2
      ;;
    *)
      if [[ -z "$MODE" ]]; then
        MODE="query"
      fi
      QUERY="$1"
      shift
      ;;
  esac
done

# ============================================================================
# Validation
# ============================================================================

validate_inputs() {
  case $MODE in
    init)
      # No validation needed for init
      return 0
      ;;
    inject)
      # No validation needed for inject
      return 0
      ;;
    pending)
      # No validation needed for pending
      return 0
      ;;
    get)
      if [[ -z "$GET_ID" ]]; then
        echo '{"error": "Research ID required", "usage": "cleo research get <id>"}' >&2
        exit 2
      fi
      return 0
      ;;
    link)
      if [[ -z "$LINK_TASK_ID" ]]; then
        echo '{"error": "Task ID required", "usage": "cleo research link <task-id> <research-id>"}' >&2
        exit 2
      fi
      if [[ -z "$LINK_RESEARCH_ID" ]]; then
        echo '{"error": "Research ID required", "usage": "cleo research link <task-id> <research-id>"}' >&2
        exit 2
      fi
      return 0
      ;;
    links)
      if [[ -z "$LINKS_TASK_ID" ]]; then
        echo '{"error": "Task ID required", "usage": "cleo research links <task-id>"}' >&2
        exit 2
      fi
      return 0
      ;;
    unlink)
      if [[ -z "$LINK_TASK_ID" ]]; then
        echo '{"error": "Task ID required", "usage": "cleo research unlink <task-id> <research-id>"}' >&2
        exit 2
      fi
      if [[ -z "$LINK_RESEARCH_ID" ]]; then
        echo '{"error": "Research ID required", "usage": "cleo research unlink <task-id> <research-id>"}' >&2
        exit 2
      fi
      return 0
      ;;
    archive)
      # No validation needed - all options have defaults
      return 0
      ;;
    status)
      # No validation needed
      return 0
      ;;
    validate)
      # No validation needed - --fix is optional
      return 0
      ;;
    archive-list)
      # Validate limit is a positive integer if provided
      if [[ -n "$ARCHIVE_LIST_LIMIT" ]]; then
        if ! [[ "$ARCHIVE_LIST_LIMIT" =~ ^[0-9]+$ ]] || [[ "$ARCHIVE_LIST_LIMIT" -eq 0 ]]; then
          echo '{"error": "Limit must be a positive integer"}' >&2
          exit 2
        fi
      fi
      # Validate since date format if provided
      if [[ -n "$ARCHIVE_LIST_SINCE" ]]; then
        if ! [[ "$ARCHIVE_LIST_SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
          echo '{"error": "Invalid date format. Use ISO 8601: YYYY-MM-DD"}' >&2
          exit 2
        fi
      fi
      return 0
      ;;
    compact)
      # No validation needed
      return 0
      ;;
    stats)
      # No validation needed
      return 0
      ;;
    show)
      if [[ -z "$SHOW_ID" ]]; then
        echo '{"error": "Research ID required", "usage": "cleo research show <id>"}' >&2
        exit 2
      fi
      return 0
      ;;
    list)
      # Validate status if provided
      if [[ -n "$LIST_STATUS" ]]; then
        case "$LIST_STATUS" in
          complete|partial|blocked|archived) ;;
          *)
            echo '{"error": "Invalid status. Use: complete, partial, blocked, or archived"}' >&2
            exit 2
            ;;
        esac
      fi
      # Validate agent_type if provided
      if [[ -n "$LIST_TYPE" ]]; then
        case "$LIST_TYPE" in
          research|implementation|validation|documentation|analysis) ;;
          *)
            echo '{"error": "Invalid type. Use: research, implementation, validation, documentation, or analysis"}' >&2
            exit 2
            ;;
        esac
      fi
      # Validate since date format if provided
      if [[ -n "$LIST_SINCE" ]]; then
        if ! [[ "$LIST_SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
          echo '{"error": "Invalid date format. Use ISO 8601: YYYY-MM-DD"}' >&2
          exit 2
        fi
      fi
      # Validate limit is a positive integer if provided
      if [[ -n "$LIST_LIMIT" ]]; then
        if ! [[ "$LIST_LIMIT" =~ ^[0-9]+$ ]] || [[ "$LIST_LIMIT" -eq 0 ]]; then
          echo '{"error": "Limit must be a positive integer"}' >&2
          exit 2
        fi
      fi
      return 0
      ;;
    query)
      if [[ -z "$QUERY" ]]; then
        echo '{"error": "Query required", "usage": "cleo research \"your query\""}' >&2
        exit 2
      fi
      ;;
    url)
      if [[ ${#URLS[@]} -eq 0 ]]; then
        echo '{"error": "At least one URL required with --url"}' >&2
        exit 2
      fi
      ;;
    reddit)
      if [[ -z "$REDDIT_TOPIC" ]]; then
        echo '{"error": "Reddit topic required", "usage": "cleo research --reddit \"topic\" --subreddit sub"}' >&2
        exit 2
      fi
      ;;
    library)
      if [[ -z "$LIBRARY" ]]; then
        echo '{"error": "Library name required with --library"}' >&2
        exit 2
      fi
      ;;
    "")
      usage
      ;;
  esac

  case $DEPTH in
    quick|standard|deep) ;;
    *)
      echo '{"error": "Invalid depth. Use: quick, standard, or deep"}' >&2
      exit 2
      ;;
  esac
}

# ============================================================================
# Init Subcommand
# ============================================================================

run_init() {
  local output_dir manifest_file manifest_path archive_dir
  local created=()

  # Get output directory from config or default
  output_dir=$(_rm_get_output_dir)
  manifest_file=$(_rm_get_manifest_file)
  manifest_path="${output_dir}/${manifest_file}"
  archive_dir="${output_dir}/archive"

  # Find templates directory
  local templates_dir=""
  if [[ -d "$CLEO_HOME/templates" ]]; then
    templates_dir="$CLEO_HOME/templates"
  elif [[ -d "$SCRIPT_DIR/../templates" ]]; then
    templates_dir="$SCRIPT_DIR/../templates"
  else
    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "init",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": false,
        "error": {
          "code": "E_FILE_NOT_FOUND",
          "message": "Templates directory not found"
        }
      }'
    exit "${EXIT_FILE_ERROR:-4}"
  fi

  local subagent_templates="${templates_dir}/subagent-protocol"

  # Create output directory if not exists
  if [[ ! -d "$output_dir" ]]; then
    mkdir -p "$output_dir"
    created+=("$output_dir/")
  fi

  # Create archive directory if not exists
  if [[ ! -d "$archive_dir" ]]; then
    mkdir -p "$archive_dir"
    created+=("archive/")
  fi

  # Create MANIFEST.jsonl if not exists
  if [[ ! -f "$manifest_path" ]]; then
    touch "$manifest_path"
    created+=("$manifest_file")
  fi

  # Copy SUBAGENT_PROTOCOL.md if not exists
  local protocol_dest="${output_dir}/SUBAGENT_PROTOCOL.md"
  if [[ ! -f "$protocol_dest" ]] && [[ -f "${subagent_templates}/SUBAGENT_PROTOCOL.md" ]]; then
    cp "${subagent_templates}/SUBAGENT_PROTOCOL.md" "$protocol_dest"
    created+=("SUBAGENT_PROTOCOL.md")
  fi

  # Copy INJECT.md if not exists
  local inject_dest="${output_dir}/INJECT.md"
  if [[ ! -f "$inject_dest" ]] && [[ -f "${subagent_templates}/INJECT.md" ]]; then
    cp "${subagent_templates}/INJECT.md" "$inject_dest"
    created+=("INJECT.md")
  fi

  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # Output based on format
  if [[ "$format" == "json" ]]; then
    # Build created array for JSON
    local created_json
    if [[ ${#created[@]} -eq 0 ]]; then
      created_json="[]"
    else
      created_json=$(printf '%s\n' "${created[@]}" | jq -R . | jq -s .)
    fi

    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --arg output_dir "$output_dir" \
      --argjson created "$created_json" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "init",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "result": {
          "outputDir": $output_dir,
          "created": $created
        }
      }'
  else
    echo ""
    echo "Research outputs initialized"
    echo "  Directory: $output_dir"
    echo "  Manifest:  $manifest_file"
    echo "  Archive:   archive/"
    if [[ ${#created[@]} -gt 0 ]]; then
      echo ""
      echo "Created:"
      for item in "${created[@]}"; do
        echo "  - $item"
      done
    else
      echo ""
      echo "All files already exist."
    fi
  fi

  exit 0
}

# ============================================================================
# List Subcommand
# ============================================================================

run_list() {
  # Validate inputs first
  validate_inputs

  # Build filter_entries arguments
  local filter_args=()

  if [[ -n "$LIST_STATUS" ]]; then
    filter_args+=(--status "$LIST_STATUS")
  fi

  if [[ -n "$LIST_TOPIC" ]]; then
    filter_args+=(--topic "$LIST_TOPIC")
  fi

  if [[ -n "$LIST_SINCE" ]]; then
    filter_args+=(--since "$LIST_SINCE")
  fi

  if [[ "$LIST_ACTIONABLE" == "true" ]]; then
    filter_args+=(--actionable)
  fi

  if [[ -n "$LIST_LIMIT" ]]; then
    filter_args+=(--limit "$LIST_LIMIT")
  fi

  if [[ -n "$LIST_TYPE" ]]; then
    filter_args+=(--type "$LIST_TYPE")
  fi

  # Call filter_entries from research-manifest.sh
  local result
  result=$(filter_entries "${filter_args[@]}")

  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # Output based on format
  if [[ "$format" == "json" ]]; then
    # Transform to CLEO envelope format
    local entries total filtered
    entries=$(echo "$result" | jq '.result.entries')
    total=$(echo "$result" | jq '.result.total')
    filtered=$(echo "$result" | jq '.result.filtered')

    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --argjson entries "$entries" \
      --argjson total "$total" \
      --argjson filtered "$filtered" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "list",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "summary": {
          "total": $total,
          "returned": $filtered
        },
        "entries": $entries
      }'
  else
    # Human-readable table format
    local entries total filtered
    entries=$(echo "$result" | jq '.result.entries')
    total=$(echo "$result" | jq -r '.result.total')
    filtered=$(echo "$result" | jq -r '.result.filtered')

    echo ""
    echo "Research Entries"
    echo "================"
    echo ""

    if [[ "$filtered" -eq 0 ]]; then
      echo "No entries found."
      echo ""
      echo "Run 'cleo research init' to initialize research outputs."
    else
      # Print table header
      printf "%-25s %-12s %s\n" "ID" "STATUS" "TITLE"
      printf "%-25s %-12s %s\n" "-------------------------" "------------" "$(printf '%0.s-' {1..40})"

      # Print entries
      echo "$entries" | jq -r '.[] | [.id, .status, .title] | @tsv' | while IFS=$'\t' read -r id status title; do
        # Truncate title if too long
        if [[ ${#title} -gt 40 ]]; then
          title="${title:0:37}..."
        fi
        printf "%-25s %-12s %s\n" "$id" "$status" "$title"
      done

      echo ""
      echo "Showing $filtered of $total entries"

      # Show active filters
      local filters=()
      [[ -n "$LIST_STATUS" ]] && filters+=("status=$LIST_STATUS")
      [[ -n "$LIST_TOPIC" ]] && filters+=("topic=$LIST_TOPIC")
      [[ -n "$LIST_SINCE" ]] && filters+=("since=$LIST_SINCE")
      [[ "$LIST_ACTIONABLE" == "true" ]] && filters+=("actionable=true")
      [[ -n "$LIST_LIMIT" ]] && filters+=("limit=$LIST_LIMIT")

      if [[ ${#filters[@]} -gt 0 ]]; then
        echo "Filters: ${filters[*]}"
      fi
    fi
    echo ""
  fi

  exit 0
}

# ============================================================================
# Show Subcommand
# ============================================================================

run_show() {
  # Use find_entry from research-manifest.sh
  local result
  result=$(find_entry "$SHOW_ID") || true

  # Check if entry was found
  local success
  success=$(echo "$result" | jq -r '.success')

  if [[ "$success" != "true" ]]; then
    # Entry not found - pass through the error
    local format="${FORMAT:-}"
    if [[ -z "$format" ]]; then
      if [[ -t 1 ]]; then
        format="human"
      else
        format="json"
      fi
    fi

    if [[ "$format" == "json" ]]; then
      # Re-wrap with research command metadata
      local error_code error_msg
      error_code=$(echo "$result" | jq -r '.error.code')
      error_msg=$(echo "$result" | jq -r '.error.message')

      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        --arg id "$SHOW_ID" \
        --arg error_code "$error_code" \
        --arg error_msg "$error_msg" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "show",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": false,
          "error": {
            "code": $error_code,
            "message": $error_msg,
            "id": $id
          }
        }'
    else
      echo ""
      echo "Error: Research entry '$SHOW_ID' not found."
      echo ""
      echo "Use 'cleo research list' to see available entries."
      echo ""
    fi
    exit "${EXIT_NOT_FOUND:-4}"
  fi

  # Extract the entry
  local entry
  entry=$(echo "$result" | jq '.result.entry')

  # If --full, also read the file content
  local file_content=""
  if [[ "$SHOW_FULL" == "true" ]]; then
    local output_dir file_name file_path
    output_dir=$(_rm_get_output_dir)
    file_name=$(echo "$entry" | jq -r '.file')
    file_path="${output_dir}/${file_name}"

    if [[ -f "$file_path" ]]; then
      file_content=$(cat "$file_path")
    fi
  fi

  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # Output based on format
  if [[ "$format" == "json" ]]; then
    # Build JSON output
    if [[ "$SHOW_FULL" == "true" && -n "$file_content" ]]; then
      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        --argjson entry "$entry" \
        --arg content "$file_content" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "show",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": true,
          "entry": $entry,
          "content": $content
        }'
    else
      # Default: just entry (context-efficient)
      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        --argjson entry "$entry" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "show",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": true,
          "entry": $entry
        }'
    fi
  else
    # Human-readable format
    local id title status file_name date actionable
    id=$(echo "$entry" | jq -r '.id')
    title=$(echo "$entry" | jq -r '.title')
    status=$(echo "$entry" | jq -r '.status')
    file_name=$(echo "$entry" | jq -r '.file')
    date=$(echo "$entry" | jq -r '.date')
    actionable=$(echo "$entry" | jq -r '.actionable')

    echo ""
    echo "Research: $id"
    printf '%.0s=' {1..50}
    echo ""
    echo "  Title:      $title"
    echo "  Status:     $status"
    echo "  Date:       $date"
    echo "  File:       $file_name"
    echo "  Actionable: $actionable"

    # Show topics if present
    local topics_count
    topics_count=$(echo "$entry" | jq '.topics | length')
    if [[ "$topics_count" -gt 0 ]]; then
      echo ""
      echo "Topics:"
      echo "$entry" | jq -r '.topics[]' | while read -r topic; do
        echo "  - $topic"
      done
    fi

    # Show key findings
    local findings_count
    findings_count=$(echo "$entry" | jq '.key_findings | length')
    if [[ "$findings_count" -gt 0 ]]; then
      echo ""
      echo "Key Findings:"
      # Use jq to format with index numbers to avoid subshell counter issue
      echo "$entry" | jq -r '.key_findings | to_entries[] | "  \(.key + 1). \(.value)"'
    fi

    # Show needs_followup if present and non-empty
    local followup_count
    followup_count=$(echo "$entry" | jq '.needs_followup // [] | length')
    if [[ "$followup_count" -gt 0 ]]; then
      echo ""
      echo "Needs Follow-up:"
      echo "$entry" | jq -r '.needs_followup[]' | while read -r followup; do
        echo "  - $followup"
      done
    fi

    # Show file content if --full
    if [[ "$SHOW_FULL" == "true" && -n "$file_content" ]]; then
      echo ""
      echo "File Content:"
      printf '%.0s-' {1..50}
      echo ""
      echo "$file_content"
    elif [[ "$SHOW_FULL" == "true" ]]; then
      echo ""
      echo "Warning: File not found at expected path."
    fi

    echo ""
  fi

  exit 0
}

# ============================================================================
# Inject Subcommand
# ============================================================================

run_inject() {
  # Find templates directory
  local templates_dir=""
  if [[ -d "$CLEO_HOME/templates" ]]; then
    templates_dir="$CLEO_HOME/templates"
  elif [[ -d "$SCRIPT_DIR/../templates" ]]; then
    templates_dir="$SCRIPT_DIR/../templates"
  else
    echo "Error: Templates directory not found" >&2
    exit "${EXIT_FILE_ERROR:-4}"
  fi

  local inject_template="${templates_dir}/subagent-protocol/INJECT.md"

  # Check template exists
  if [[ ! -f "$inject_template" ]]; then
    echo "Error: INJECT.md template not found at $inject_template" >&2
    exit "${EXIT_FILE_ERROR:-4}"
  fi

  # Read the template
  local template_content
  template_content=$(cat "$inject_template")

  # Get output directory from config
  local output_dir
  output_dir=$(_rm_get_output_dir)

  # Prepare the output
  local output

  if [[ "$INJECT_RAW" == "true" ]]; then
    # Raw mode: no substitution
    output="$template_content"
  else
    # Substitute {output_dir} with actual value
    output="${template_content//\{output_dir\}/$output_dir}"
  fi

  # Extract just the code block content (between the ``` markers)
  # The template has markdown wrapping, we want the injection block itself
  local injection_block
  injection_block=$(echo "$output" | sed -n '/^```$/,/^```$/p' | sed '1d;$d')

  # If extraction failed, use the whole content (fallback)
  if [[ -z "$injection_block" ]]; then
    injection_block="$output"
  fi

  # Output or copy to clipboard
  if [[ "$INJECT_CLIPBOARD" == "true" ]]; then
    # Detect clipboard command
    local clip_cmd=""
    if command -v pbcopy &>/dev/null; then
      clip_cmd="pbcopy"
    elif command -v xclip &>/dev/null; then
      clip_cmd="xclip -selection clipboard"
    elif command -v xsel &>/dev/null; then
      clip_cmd="xsel --clipboard --input"
    elif command -v wl-copy &>/dev/null; then
      clip_cmd="wl-copy"
    fi

    if [[ -z "$clip_cmd" ]]; then
      echo "Error: No clipboard utility found (pbcopy, xclip, xsel, wl-copy)" >&2
      exit "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    echo "$injection_block" | $clip_cmd
    echo "Injection template copied to clipboard."
  else
    # Plain text output (not JSON wrapped for copy-paste ergonomics)
    echo "$injection_block"
  fi

  exit 0
}

# ============================================================================
# Pending Subcommand
# ============================================================================

run_pending() {
  # Use get_pending_followup from research-manifest.sh
  local result
  result=$(get_pending_followup)

  # Extract data
  local entries count
  entries=$(echo "$result" | jq '.result.entries')
  count=$(echo "$result" | jq -r '.result.count')

  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # Output based on format
  if [[ "$format" == "json" ]]; then
    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --argjson entries "$entries" \
      --argjson count "$count" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "pending",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "summary": {
          "count": $count,
          "description": "Entries with pending follow-up tasks"
        },
        "entries": $entries
      }'
  else
    # Human-readable format
    echo ""
    echo "Pending Follow-ups"
    echo "=================="
    echo ""

    if [[ "$count" -eq 0 ]]; then
      echo "No entries with pending follow-up."
      echo ""
      echo "All orchestrator handoffs have been processed."
    else
      # Print entries with their followup tasks
      echo "$entries" | jq -r '.[] | "Entry: \(.id)\n  Title: \(.title)\n  Status: \(.status)\n  Follow-up tasks: \(.needs_followup | join(\", \"))\n"'

      echo ""
      echo "Found $count entries with pending follow-ups."
      echo ""
      echo "To process a follow-up task:"
      echo "  1. Read the task: cleo show <task-id>"
      echo "  2. Spawn a subagent for the task"
    fi
    echo ""
  fi

  exit 0
}

# ============================================================================
# Get Subcommand
# ============================================================================

run_get() {
  # Use get_entry_by_id from research-manifest.sh for direct JSON output
  local entry
  entry=$(get_entry_by_id "$GET_ID") || true

  if [[ "$entry" == "null" || -z "$entry" ]]; then
    # Determine output format for error
    local format="${FORMAT:-}"
    if [[ -z "$format" ]]; then
      if [[ -t 1 ]]; then
        format="human"
      else
        format="json"
      fi
    fi

    if [[ "$format" == "json" ]]; then
      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        --arg id "$GET_ID" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "get",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": false,
          "error": {
            "code": "E_NOT_FOUND",
            "message": ("Research entry \"" + $id + "\" not found"),
            "id": $id
          }
        }'
    else
      echo ""
      echo "Error: Research entry '$GET_ID' not found."
      echo ""
      echo "Use 'cleo research list' to see available entries."
      echo ""
    fi
    exit "${EXIT_NOT_FOUND:-4}"
  fi

  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # Output based on format
  if [[ "$format" == "json" ]]; then
    # Wrap in CLEO envelope
    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --argjson entry "$entry" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "get",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "entry": $entry
      }'
  else
    # Human-readable format (same as show but simpler)
    local id title status date
    id=$(echo "$entry" | jq -r '.id')
    title=$(echo "$entry" | jq -r '.title')
    status=$(echo "$entry" | jq -r '.status')
    date=$(echo "$entry" | jq -r '.date')

    echo ""
    echo "Research: $id"
    printf '%.0s=' {1..50}
    echo ""
    echo "  Title:  $title"
    echo "  Status: $status"
    echo "  Date:   $date"

    # Show needs_followup if present
    local followup_count
    followup_count=$(echo "$entry" | jq '.needs_followup // [] | length')
    if [[ "$followup_count" -gt 0 ]]; then
      echo ""
      echo "Needs Follow-up:"
      echo "$entry" | jq -r '.needs_followup[]' | while read -r followup; do
        echo "  - $followup"
      done
    fi

    # Show key findings summary
    local findings_count
    findings_count=$(echo "$entry" | jq '.key_findings | length')
    if [[ "$findings_count" -gt 0 ]]; then
      echo ""
      echo "Key Findings ($findings_count items):"
      echo "$entry" | jq -r '.key_findings[:3][]' | while read -r finding; do
        if [[ ${#finding} -gt 60 ]]; then
          echo "  - ${finding:0:57}..."
        else
          echo "  - $finding"
        fi
      done
      if [[ "$findings_count" -gt 3 ]]; then
        echo "  ... and $((findings_count - 3)) more"
      fi
    fi
    echo ""
  fi

  exit 0
}

# ============================================================================
# Link Subcommand
# ============================================================================

run_link() {
  local task_id="$LINK_TASK_ID"
  local research_id="$LINK_RESEARCH_ID"

  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # Validate required arguments
  if [[ -z "$task_id" ]]; then
    if [[ "$format" == "json" ]]; then
      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "link",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": false,
          "error": {
            "code": "E_MISSING_ARGUMENT",
            "message": "Task ID required",
            "usage": "cleo research link <task-id> <research-id>"
          }
        }'
    else
      echo ""
      echo "Error: Task ID required."
      echo "Usage: cleo research link <task-id> <research-id>"
      echo ""
    fi
    exit 2
  fi

  if [[ -z "$research_id" ]]; then
    if [[ "$format" == "json" ]]; then
      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "link",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": false,
          "error": {
            "code": "E_MISSING_ARGUMENT",
            "message": "Research ID required",
            "usage": "cleo research link <task-id> <research-id>"
          }
        }'
    else
      echo ""
      echo "Error: Research ID required."
      echo "Usage: cleo research link <task-id> <research-id>"
      echo ""
    fi
    exit 2
  fi

  # Step 1: Validate task exists
  if ! cleo exists "$task_id" --quiet 2>/dev/null; then
    if [[ "$format" == "json" ]]; then
      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        --arg task_id "$task_id" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "link",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": false,
          "error": {
            "code": "E_TASK_NOT_FOUND",
            "message": ("Task " + $task_id + " not found"),
            "taskId": $task_id
          }
        }'
    else
      echo ""
      echo "Error: Task '$task_id' not found."
      echo ""
      echo "Use 'cleo find' or 'cleo list' to verify the task ID."
      echo ""
    fi
    exit "${EXIT_NOT_FOUND:-4}"
  fi

  # Step 2: Validate research entry exists in manifest
  local find_result
  find_result=$(find_entry "$research_id") || true

  local find_success
  find_success=$(echo "$find_result" | jq -r '.success')

  if [[ "$find_success" != "true" ]]; then
    if [[ "$format" == "json" ]]; then
      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        --arg research_id "$research_id" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "link",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": false,
          "error": {
            "code": "E_RESEARCH_NOT_FOUND",
            "message": ("Research entry " + $research_id + " not found"),
            "researchId": $research_id
          }
        }'
    else
      echo ""
      echo "Error: Research entry '$research_id' not found."
      echo ""
      echo "Use 'cleo research list' to see available entries."
      echo ""
    fi
    exit "${EXIT_NOT_FOUND:-4}"
  fi

  # Extract research title for the note
  local research_title
  research_title=$(echo "$find_result" | jq -r '.result.entry.title')

  # Step 3: Build note text
  local note_text
  if [[ -n "$LINK_NOTES" ]]; then
    note_text="Linked research: $research_id ($research_title). $LINK_NOTES"
  else
    note_text="Linked research: $research_id ($research_title)"
  fi

  # Step 4: Update manifest with bidirectional link (adds task to linked_tasks array)
  local manifest_result
  manifest_result=$(link_research_to_task "$task_id" "$research_id" "$note_text")
  local manifest_success manifest_updated
  manifest_success=$(echo "$manifest_result" | jq -r '.success')
  manifest_updated=$(echo "$manifest_result" | jq -r '.result.manifestUpdated // false')

  # Step 5: Add note to task using cleo update
  local update_result
  if ! update_result=$(cleo update "$task_id" --notes "$note_text" 2>&1); then
    if [[ "$format" == "json" ]]; then
      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        --arg task_id "$task_id" \
        --arg research_id "$research_id" \
        --arg update_error "$update_result" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "link",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": false,
          "error": {
            "code": "E_UPDATE_FAILED",
            "message": "Failed to add note to task",
            "taskId": $task_id,
            "researchId": $research_id,
            "details": $update_error
          }
        }'
    else
      echo ""
      echo "Error: Failed to add note to task '$task_id'."
      echo "Details: $update_result"
      echo ""
    fi
    exit "${EXIT_FILE_ERROR:-4}"
  fi

  # Success output
  if [[ "$format" == "json" ]]; then
    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --arg task_id "$task_id" \
      --arg research_id "$research_id" \
      --arg research_title "$research_title" \
      --arg note_text "$note_text" \
      --argjson manifest_updated "$manifest_updated" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "link",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "result": {
          "taskId": $task_id,
          "researchId": $research_id,
          "researchTitle": $research_title,
          "action": "linked",
          "taskNote": $note_text,
          "manifestUpdated": $manifest_updated
        }
      }'
  else
    echo ""
    echo "Linked research to task"
    echo "  Task:     $task_id"
    echo "  Research: $research_id ($research_title)"
    if [[ "$manifest_updated" == "true" ]]; then
      echo "  Manifest: Updated (added task to linked_tasks)"
    else
      echo "  Manifest: Already linked"
    fi
    echo ""
  fi

  exit 0
}

# ============================================================================
# Links Subcommand (show all research for a task)
# ============================================================================

run_links() {
  local task_id="$LINKS_TASK_ID"

  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # Validate required argument
  if [[ -z "$task_id" ]]; then
    if [[ "$format" == "json" ]]; then
      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "links",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": false,
          "error": {
            "code": "E_MISSING_ARGUMENT",
            "message": "Task ID required",
            "usage": "cleo research links <task-id>"
          }
        }'
    else
      echo ""
      echo "Error: Task ID required."
      echo "Usage: cleo research links <task-id>"
      echo ""
    fi
    exit 2
  fi

  # Get all research linked to this task using get_task_research
  local result
  result=$(get_task_research "$task_id")

  local entries count
  entries=$(echo "$result" | jq '.result.entries')
  count=$(echo "$result" | jq -r '.result.count')

  # Output based on format
  if [[ "$format" == "json" ]]; then
    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --arg task_id "$task_id" \
      --argjson entries "$entries" \
      --argjson count "$count" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "links",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "result": {
          "taskId": $task_id,
          "count": $count,
          "entries": $entries
        }
      }'
  else
    echo ""
    echo "Research linked to task $task_id"
    echo "================================"
    echo ""

    if [[ "$count" -eq 0 ]]; then
      echo "No research entries linked to this task."
      echo ""
      echo "Use 'cleo research link $task_id <research-id>' to link research."
    else
      # Print table header
      printf "%-30s %-12s %s\n" "ID" "STATUS" "TITLE"
      printf "%-30s %-12s %s\n" "------------------------------" "------------" "$(printf '%0.s-' {1..35})"

      # Print entries
      echo "$entries" | jq -r '.[] | [.id, .status, .title] | @tsv' | while IFS=$'\t' read -r id status title; do
        # Truncate title if too long
        if [[ ${#title} -gt 35 ]]; then
          title="${title:0:32}..."
        fi
        printf "%-30s %-12s %s\n" "$id" "$status" "$title"
      done

      echo ""
      echo "Found $count linked research entries."
    fi
    echo ""
  fi

  exit 0
}

# ============================================================================
# Unlink Subcommand (remove link between research and task)
# ============================================================================

run_unlink() {
  local task_id="$LINK_TASK_ID"
  local research_id="$LINK_RESEARCH_ID"

  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # Validate required arguments
  if [[ -z "$task_id" ]]; then
    if [[ "$format" == "json" ]]; then
      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "unlink",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": false,
          "error": {
            "code": "E_MISSING_ARGUMENT",
            "message": "Task ID required",
            "usage": "cleo research unlink <task-id> <research-id>"
          }
        }'
    else
      echo ""
      echo "Error: Task ID required."
      echo "Usage: cleo research unlink <task-id> <research-id>"
      echo ""
    fi
    exit 2
  fi

  if [[ -z "$research_id" ]]; then
    if [[ "$format" == "json" ]]; then
      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "unlink",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": false,
          "error": {
            "code": "E_MISSING_ARGUMENT",
            "message": "Research ID required",
            "usage": "cleo research unlink <task-id> <research-id>"
          }
        }'
    else
      echo ""
      echo "Error: Research ID required."
      echo "Usage: cleo research unlink <task-id> <research-id>"
      echo ""
    fi
    exit 2
  fi

  # Use unlink_research_from_task to remove from manifest
  local result
  result=$(unlink_research_from_task "$task_id" "$research_id")

  local success manifest_updated action
  success=$(echo "$result" | jq -r '.success')
  manifest_updated=$(echo "$result" | jq -r '.result.manifestUpdated // false')
  action=$(echo "$result" | jq -r '.result.action // "error"')

  if [[ "$success" != "true" ]]; then
    if [[ "$format" == "json" ]]; then
      echo "$result" | jq --arg cmd_version "$COMMAND_VERSION" --arg timestamp "$(timestamp_iso)" '
        ._meta.command = "research" |
        ._meta.subcommand = "unlink" |
        ._meta.command_version = $cmd_version |
        ._meta.timestamp = $timestamp
      '
    else
      local error_msg
      error_msg=$(echo "$result" | jq -r '.error.message // "Unknown error"')
      echo ""
      echo "Error: $error_msg"
      echo ""
    fi
    exit "${EXIT_NOT_FOUND:-4}"
  fi

  # Success output
  if [[ "$format" == "json" ]]; then
    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --arg task_id "$task_id" \
      --arg research_id "$research_id" \
      --arg action "$action" \
      --argjson manifest_updated "$manifest_updated" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "unlink",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "result": {
          "taskId": $task_id,
          "researchId": $research_id,
          "action": $action,
          "manifestUpdated": $manifest_updated
        }
      }'
  else
    echo ""
    if [[ "$action" == "unlinked" ]]; then
      echo "Unlinked research from task"
      echo "  Task:     $task_id"
      echo "  Research: $research_id"
      echo "  Note: Task notes are not modified. Remove manually if needed."
    else
      echo "Research was not linked to task"
      echo "  Task:     $task_id"
      echo "  Research: $research_id"
    fi
    echo ""
  fi

  exit 0
}

# ============================================================================
# Archive Subcommand
# ============================================================================

run_archive() {
  local threshold_bytes="${ARCHIVE_THRESHOLD:-200000}"
  local archive_pct="${ARCHIVE_PERCENT:-50}"
  local dry_run="${FLAG_DRY_RUN:-false}"

  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # First check current size
  local size_result
  size_result=$(manifest_check_size "$threshold_bytes")
  local current_bytes percent_used needs_archival entry_count
  current_bytes=$(echo "$size_result" | jq -r '.result.currentBytes // 0')
  percent_used=$(echo "$size_result" | jq -r '.result.percentUsed // 0')
  needs_archival=$(echo "$size_result" | jq -r '.result.needsArchival // false')
  entry_count=$(echo "$size_result" | jq -r '.result.entryCount // 0')

  # Dry-run mode: just report what would happen
  if [[ "$dry_run" == "true" ]]; then
    local entries_to_archive=0
    if [[ "$entry_count" -gt 1 ]]; then
      entries_to_archive=$(( (entry_count * archive_pct) / 100 ))
      [[ $entries_to_archive -lt 1 ]] && entries_to_archive=1
    fi

    if [[ "$format" == "json" ]]; then
      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        --argjson current "$current_bytes" \
        --argjson threshold "$threshold_bytes" \
        --argjson percent "$percent_used" \
        --argjson needs_archival "$needs_archival" \
        --argjson entries "$entry_count" \
        --argjson would_archive "$entries_to_archive" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "archive",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": true,
          "result": {
            "dryRun": true,
            "currentBytes": $current,
            "thresholdBytes": $threshold,
            "percentUsed": $percent,
            "needsArchival": $needs_archival,
            "entryCount": $entries,
            "wouldArchive": $would_archive
          }
        }'
    else
      echo ""
      echo "Manifest Archive Preview (dry-run)"
      echo "==================================="
      echo ""
      echo "  Current Size: $current_bytes bytes ($percent_used% of threshold)"
      echo "  Threshold:    $threshold_bytes bytes (~50K tokens)"
      echo "  Entry Count:  $entry_count"
      echo ""
      if [[ "$needs_archival" == "true" ]]; then
        echo "  Status: ARCHIVAL NEEDED"
        echo "  Would archive $entries_to_archive of $entry_count entries ($archive_pct%)"
      else
        echo "  Status: Below threshold, no archival needed"
      fi
      echo ""
    fi
    exit 0
  fi

  # Execute archival
  local archive_result rotate_exit
  archive_result=$(manifest_rotate "$threshold_bytes" "$archive_pct") || rotate_exit=$?
  local action archived kept bytes_before bytes_after

  action=$(echo "$archive_result" | jq -r '.result.action // "none"')
  archived=$(echo "$archive_result" | jq -r '.result.entriesArchived // 0')
  kept=$(echo "$archive_result" | jq -r '.result.entriesKept // 0')
  bytes_before=$(echo "$archive_result" | jq -r '.result.bytesBefore // 0')
  bytes_after=$(echo "$archive_result" | jq -r '.result.bytesAfter // 0')

  if [[ "$format" == "json" ]]; then
    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --arg action "$action" \
      --argjson archived "$archived" \
      --argjson kept "$kept" \
      --argjson bytes_before "$bytes_before" \
      --argjson bytes_after "$bytes_after" \
      --argjson threshold "$threshold_bytes" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "archive",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "result": {
          "action": $action,
          "entriesArchived": $archived,
          "entriesKept": $kept,
          "bytesBefore": $bytes_before,
          "bytesAfter": $bytes_after,
          "thresholdBytes": $threshold
        }
      }'
  else
    echo ""
    echo "Manifest Archival"
    echo "================="
    echo ""
    if [[ "$action" == "archived" ]]; then
      echo "  Action: ARCHIVED"
      echo "  Entries archived: $archived"
      echo "  Entries kept:     $kept"
      echo "  Size before:      $bytes_before bytes"
      echo "  Size after:       $bytes_after bytes"
      echo ""
      echo "  Archived entries moved to MANIFEST-ARCHIVE.jsonl"
    else
      echo "  Action: NONE"
      echo "  Current size: $current_bytes bytes ($percent_used% of threshold)"
      echo "  Below threshold - no archival needed"
    fi
    echo ""
  fi

  exit 0
}

# ============================================================================
# Validate Subcommand
# ============================================================================

run_validate() {
  # Check if --protocol mode
  if [[ "$VALIDATE_PROTOCOL" == "true" ]]; then
    # Protocol validation mode - requires task ID
    if [[ -z "$VALIDATE_TASK_ID" ]]; then
      if [[ "${FORMAT:-json}" == "json" ]]; then
        jq -nc \
          --arg error "Task ID required for protocol validation" \
          --arg usage "cleo research validate T#### --protocol" \
          '{
            "success": false,
            "error": {
              "message": $error,
              "usage": $usage
            }
          }'
      else
        echo "Error: Task ID required for protocol validation" >&2
        echo "Usage: cleo research validate T#### --protocol" >&2
      fi
      exit 2
    fi

    # Source protocol validation library
    source "$LIB_DIR/protocol-validation.sh" 2>/dev/null || {
      echo '{"success": false, "error": {"message": "Failed to load protocol-validation.sh"}}' >&2
      exit 1
    }

    # Find manifest entry for this task
    local manifest_path
    manifest_path="$(_rm_get_output_dir)/MANIFEST.jsonl"

    if [[ ! -f "$manifest_path" ]]; then
      if [[ "${FORMAT:-json}" == "json" ]]; then
        jq -nc \
          --arg error "No research manifest found" \
          '{
            "success": false,
            "error": {
              "message": $error
            }
          }'
      else
        echo "Error: No research manifest found" >&2
      fi
      exit 4
    fi

    # Search for manifest entry linked to this task
    local manifest_entry
    manifest_entry=$(jq -r --arg task_id "$VALIDATE_TASK_ID" \
      'select(.linked_tasks // [] | any(. == $task_id))' \
      "$manifest_path" | head -1)

    if [[ -z "$manifest_entry" ]]; then
      if [[ "${FORMAT:-json}" == "json" ]]; then
        jq -nc \
          --arg task_id "$VALIDATE_TASK_ID" \
          --arg error "No manifest entry found for task" \
          '{
            "success": false,
            "error": {
              "message": $error,
              "taskId": $task_id
            }
          }'
      else
        echo "Error: No manifest entry found for task $VALIDATE_TASK_ID" >&2
      fi
      exit 4
    fi

    # Run protocol validation (strict mode)
    local result
    result=$(validate_research_protocol "$VALIDATE_TASK_ID" "$manifest_entry" "true")
    local exit_code=$?

    # Output result
    if [[ "${FORMAT:-json}" == "json" ]]; then
      echo "$result"
    else
      # Human-readable format
      local valid
      valid=$(echo "$result" | jq -r '.valid')
      local score
      score=$(echo "$result" | jq -r '.score')
      local violations
      violations=$(echo "$result" | jq -r '.violations | length')

      echo ""
      echo "Protocol Validation: Research"
      echo "============================="
      echo ""
      echo "  Task ID: $VALIDATE_TASK_ID"
      echo "  Valid:   $valid"
      echo "  Score:   $score/100"
      echo "  Violations: $violations"
      echo ""

      if [[ "$violations" -gt 0 ]]; then
        echo "Violations:"
        echo "$result" | jq -r '.violations[] | "  - [\(.severity | ascii_upcase)] \(.requirement): \(.message)"'
        echo ""
        echo "Fixes:"
        echo "$result" | jq -r '.violations[] | "  - \(.fix)"'
        echo ""
      fi
    fi

    exit "$exit_code"
  fi

  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # Run validation from library function
  # Note: validate_research_manifest outputs JSON to stdout, errors to stderr
  # The function may return non-zero on validation errors, which is expected
  local result exit_code
  result=$(validate_research_manifest) || exit_code=$?
  exit_code=${exit_code:-0}

  # Parse result
  local valid total_lines valid_entries invalid_entries errors warnings
  valid=$(echo "$result" | jq -r '.valid // false')
  total_lines=$(echo "$result" | jq -r '.result.totalLines // 0')
  valid_entries=$(echo "$result" | jq -r '.result.validEntries // 0')
  invalid_entries=$(echo "$result" | jq -r '.result.invalidEntries // 0')
  errors=$(echo "$result" | jq '.result.errors // []')
  warnings=$(echo "$result" | jq '.result.warnings // []')

  # Handle --fix option
  local fix_result="null"
  local entries_removed=0
  if [[ "$VALIDATE_FIX" == "true" && "$invalid_entries" -gt 0 ]]; then
    # Get manifest path and create backup
    local manifest_path
    manifest_path="$(_rm_get_output_dir)/MANIFEST.jsonl"

    if [[ -f "$manifest_path" ]]; then
      # Create backup before fixing
      local backup_path="${manifest_path}.backup.$(date +%Y%m%d_%H%M%S)"
      cp "$manifest_path" "$backup_path"

      # Read manifest and filter out invalid lines
      local temp_file
      temp_file=$(mktemp)
      local line_num=0
      local kept_lines=0

      while IFS= read -r line || [[ -n "$line" ]]; do
        line_num=$((line_num + 1))

        # Skip empty lines
        [[ -z "${line// }" ]] && continue

        # Validate line - if valid, keep it
        if echo "$line" | jq empty 2>/dev/null; then
          if _rm_validate_entry "$line" 2>/dev/null; then
            echo "$line" >> "$temp_file"
            kept_lines=$((kept_lines + 1))
          else
            entries_removed=$((entries_removed + 1))
          fi
        else
          entries_removed=$((entries_removed + 1))
        fi
      done < "$manifest_path"

      # Replace manifest with fixed version
      mv "$temp_file" "$manifest_path"

      fix_result=$(jq -nc \
        --arg backup "$backup_path" \
        --argjson removed "$entries_removed" \
        --argjson kept "$kept_lines" \
        '{
          "action": "fixed",
          "entriesRemoved": $removed,
          "entriesKept": $kept,
          "backupFile": $backup
        }')

      # Update valid status if all invalid entries were removed
      if [[ "$entries_removed" -eq "$invalid_entries" ]]; then
        valid="true"
        exit_code=0
      fi
    fi
  fi

  if [[ "$format" == "json" ]]; then
    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --argjson valid "$valid" \
      --argjson total_lines "$total_lines" \
      --argjson valid_entries "$valid_entries" \
      --argjson invalid_entries "$invalid_entries" \
      --argjson errors "$errors" \
      --argjson warnings "$warnings" \
      --argjson fix_result "$fix_result" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "validate",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "valid": $valid,
        "result": {
          "totalLines": $total_lines,
          "validEntries": $valid_entries,
          "invalidEntries": $invalid_entries,
          "errors": $errors,
          "warnings": $warnings,
          "fix": $fix_result
        }
      }'
  else
    echo ""
    echo "Manifest Validation"
    echo "==================="
    echo ""

    if [[ "$valid" == "true" ]]; then
      echo "  Status: VALID"
    else
      echo "  Status: INVALID"
    fi
    echo ""
    echo "  Total lines:    $total_lines"
    echo "  Valid entries:  $valid_entries"
    echo "  Invalid entries: $invalid_entries"
    echo ""

    # Show warnings
    local warning_count
    warning_count=$(echo "$warnings" | jq 'length')
    if [[ "$warning_count" -gt 0 ]]; then
      echo "  Warnings:"
      echo "$warnings" | jq -r '.[] | "    - " + .'
      echo ""
    fi

    # Show errors
    local error_count
    error_count=$(echo "$errors" | jq 'length')
    if [[ "$error_count" -gt 0 ]]; then
      echo "  Errors:"
      echo "$errors" | jq -r '.[] | "    - " + .'
      echo ""
    fi

    # Show fix results if applied
    if [[ "$fix_result" != "null" ]]; then
      echo "  Fix applied:"
      echo "    Entries removed: $entries_removed"
      local backup_file
      backup_file=$(echo "$fix_result" | jq -r '.backupFile')
      echo "    Backup saved:    $backup_file"
      echo ""
    elif [[ "$invalid_entries" -gt 0 ]]; then
      echo "  To remove invalid entries, run:"
      echo "    cleo research validate --fix"
      echo ""
    fi
  fi

  exit "$exit_code"
}

# ============================================================================
# Status Subcommand
# ============================================================================

run_status() {
  local threshold_bytes="${ARCHIVE_THRESHOLD:-200000}"

  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # Check current size
  local size_result
  size_result=$(manifest_check_size "$threshold_bytes")
  local file_exists current_bytes percent_used needs_archival entry_count
  file_exists=$(echo "$size_result" | jq -r '.result.fileExists // false')
  current_bytes=$(echo "$size_result" | jq -r '.result.currentBytes // 0')
  percent_used=$(echo "$size_result" | jq -r '.result.percentUsed // 0')
  needs_archival=$(echo "$size_result" | jq -r '.result.needsArchival // false')
  entry_count=$(echo "$size_result" | jq -r '.result.entryCount // 0')

  # Check archive file
  local archive_path archive_size archive_entries
  archive_path="$(_rm_get_output_dir)/MANIFEST-ARCHIVE.jsonl"
  if [[ -f "$archive_path" ]]; then
    archive_size=$(stat -c %s "$archive_path" 2>/dev/null || stat -f %z "$archive_path" 2>/dev/null || echo 0)
    archive_entries=$(wc -l < "$archive_path" | tr -d ' ')
  else
    archive_size=0
    archive_entries=0
  fi

  if [[ "$format" == "json" ]]; then
    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --argjson file_exists "$file_exists" \
      --argjson current_bytes "$current_bytes" \
      --argjson threshold "$threshold_bytes" \
      --argjson percent "$percent_used" \
      --argjson needs_archival "$needs_archival" \
      --argjson entry_count "$entry_count" \
      --argjson archive_size "$archive_size" \
      --argjson archive_entries "$archive_entries" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "status",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "result": {
          "manifest": {
            "exists": $file_exists,
            "bytes": $current_bytes,
            "entries": $entry_count,
            "percentUsed": $percent
          },
          "archive": {
            "bytes": $archive_size,
            "entries": $archive_entries
          },
          "threshold": {
            "bytes": $threshold,
            "needsArchival": $needs_archival
          }
        }
      }'
  else
    echo ""
    echo "Manifest Status"
    echo "==============="
    echo ""
    if [[ "$file_exists" == "true" ]]; then
      echo "  MANIFEST.jsonl:"
      echo "    Size:    $current_bytes bytes"
      echo "    Entries: $entry_count"
      echo "    Usage:   $percent_used% of threshold"
      echo ""
      if [[ "$needs_archival" == "true" ]]; then
        echo "    Status:  ARCHIVAL RECOMMENDED"
      else
        echo "    Status:  OK"
      fi
    else
      echo "  MANIFEST.jsonl: Not found"
      echo "    Run 'cleo research init' to create"
    fi
    echo ""
    echo "  MANIFEST-ARCHIVE.jsonl:"
    if [[ $archive_size -gt 0 ]]; then
      echo "    Size:    $archive_size bytes"
      echo "    Entries: $archive_entries"
    else
      echo "    Status:  Empty or not created yet"
    fi
    echo ""
    echo "  Threshold: $threshold_bytes bytes (~50K tokens)"
    echo ""
  fi

  exit 0
}

# ============================================================================
# Archive-List Subcommand
# ============================================================================

run_archive_list() {
  # Build list_archived_entries arguments
  local filter_args=()

  if [[ -n "$ARCHIVE_LIST_LIMIT" ]]; then
    filter_args+=(--limit "$ARCHIVE_LIST_LIMIT")
  fi

  if [[ -n "$ARCHIVE_LIST_SINCE" ]]; then
    filter_args+=(--since "$ARCHIVE_LIST_SINCE")
  fi

  # Call list_archived_entries from research-manifest.sh
  local result
  result=$(list_archived_entries "${filter_args[@]}")

  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # Output based on format
  if [[ "$format" == "json" ]]; then
    # Transform to CLEO envelope format
    local entries total returned
    entries=$(echo "$result" | jq '.result.entries')
    total=$(echo "$result" | jq '.result.total')
    returned=$(echo "$result" | jq '.result.returned')

    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --argjson entries "$entries" \
      --argjson total "$total" \
      --argjson returned "$returned" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "archive-list",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "summary": {
          "total": $total,
          "returned": $returned
        },
        "entries": $entries
      }'
  else
    # Human-readable table format
    local entries total returned
    entries=$(echo "$result" | jq '.result.entries')
    total=$(echo "$result" | jq -r '.result.total')
    returned=$(echo "$result" | jq -r '.result.returned')

    echo ""
    echo "Archived Research Entries"
    echo "========================="
    echo ""

    if [[ "$returned" -eq 0 ]]; then
      echo "No archived entries found."
      echo ""
      echo "Archive file location: claudedocs/agent-outputs/MANIFEST-ARCHIVE.jsonl"
    else
      # Print table header
      printf "%-30s %-12s %-20s %s\n" "ID" "STATUS" "ARCHIVED AT" "TITLE"
      printf "%-30s %-12s %-20s %s\n" "------------------------------" "------------" "--------------------" "$(printf '%0.s-' {1..30})"

      # Print entries
      echo "$entries" | jq -r '.[] | [.id, .status, (.archivedAt // "N/A"), .title] | @tsv' | while IFS=$'\t' read -r id status archived title; do
        # Truncate title if too long
        if [[ ${#title} -gt 30 ]]; then
          title="${title:0:27}..."
        fi
        # Truncate archived timestamp
        if [[ ${#archived} -gt 20 ]]; then
          archived="${archived:0:16}..."
        fi
        printf "%-30s %-12s %-20s %s\n" "$id" "$status" "$archived" "$title"
      done

      echo ""
      echo "Showing $returned of $total archived entries"

      # Show active filters
      local filters=()
      [[ -n "$ARCHIVE_LIST_SINCE" ]] && filters+=("since=$ARCHIVE_LIST_SINCE")
      [[ -n "$ARCHIVE_LIST_LIMIT" ]] && filters+=("limit=$ARCHIVE_LIST_LIMIT")

      if [[ ${#filters[@]} -gt 0 ]]; then
        echo "Filters: ${filters[*]}"
      fi
    fi
    echo ""
  fi

  exit 0
}

# ============================================================================
# Compact Subcommand
# ============================================================================

run_compact() {
  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # Call compact_manifest from research-manifest.sh
  local result
  result=$(compact_manifest)

  local entries_before entries_after entries_removed
  entries_before=$(echo "$result" | jq -r '.result.entriesBefore // 0')
  entries_after=$(echo "$result" | jq -r '.result.entriesAfter // 0')
  entries_removed=$(echo "$result" | jq -r '.result.entriesRemoved // 0')

  if [[ "$format" == "json" ]]; then
    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --argjson before "$entries_before" \
      --argjson after "$entries_after" \
      --argjson removed "$entries_removed" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "compact",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "result": {
          "entriesBefore": $before,
          "entriesAfter": $after,
          "entriesRemoved": $removed
        }
      }'
  else
    echo ""
    echo "Manifest Compaction"
    echo "==================="
    echo ""
    if [[ "$entries_removed" -gt 0 ]]; then
      echo "  Action: COMPACTED"
      echo "  Entries before: $entries_before"
      echo "  Entries after:  $entries_after"
      echo "  Entries removed: $entries_removed (duplicates/obsolete)"
    else
      echo "  Action: NONE"
      echo "  Entries: $entries_before"
      echo "  No duplicates or obsolete entries found"
    fi
    echo ""
  fi

  exit 0
}

# ============================================================================
# Stats Subcommand
# ============================================================================

run_stats() {
  # Determine output format
  local format="${FORMAT:-}"
  if [[ -z "$format" ]]; then
    if [[ -t 1 ]]; then
      format="human"
    else
      format="json"
    fi
  fi

  # Call get_manifest_stats from research-manifest.sh
  local result
  result=$(get_manifest_stats)

  local success
  success=$(echo "$result" | jq -r '.success')

  if [[ "$success" != "true" ]]; then
    if [[ "$format" == "json" ]]; then
      local error_code error_msg
      error_code=$(echo "$result" | jq -r '.error.code')
      error_msg=$(echo "$result" | jq -r '.error.message')

      jq -nc \
        --arg cmd_version "$COMMAND_VERSION" \
        --arg timestamp "$(timestamp_iso)" \
        --arg error_code "$error_code" \
        --arg error_msg "$error_msg" \
        '{
          "_meta": {
            "format": "json",
            "command": "research",
            "subcommand": "stats",
            "command_version": $cmd_version,
            "timestamp": $timestamp
          },
          "success": false,
          "error": {
            "code": $error_code,
            "message": $error_msg
          }
        }'
    else
      echo ""
      echo "Error: Manifest file not found."
      echo ""
      echo "Run 'cleo research init' to initialize."
      echo ""
    fi
    exit "${EXIT_NOT_FOUND:-4}"
  fi

  if [[ "$format" == "json" ]]; then
    # Transform to CLEO envelope
    local stats_result
    stats_result=$(echo "$result" | jq '.result')

    jq -nc \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --argjson result "$stats_result" \
      '{
        "_meta": {
          "format": "json",
          "command": "research",
          "subcommand": "stats",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "result": $result
      }'
  else
    # Human-readable format
    local manifest_bytes manifest_entries archive_bytes archive_entries
    manifest_bytes=$(echo "$result" | jq -r '.result.manifest.bytes')
    manifest_entries=$(echo "$result" | jq -r '.result.manifest.entries')
    archive_bytes=$(echo "$result" | jq -r '.result.archive.bytes')
    archive_entries=$(echo "$result" | jq -r '.result.archive.entries')

    echo ""
    echo "Manifest Statistics"
    echo "==================="
    echo ""
    echo "  MANIFEST.jsonl:"
    echo "    Size:    $manifest_bytes bytes"
    echo "    Entries: $manifest_entries"
    echo ""
    echo "  MANIFEST-ARCHIVE.jsonl:"
    echo "    Size:    $archive_bytes bytes"
    echo "    Entries: $archive_entries"

    # Status counts
    local status_counts
    status_counts=$(echo "$result" | jq -r '.result.statusCounts | to_entries | map("\(.key): \(.value)") | join(", ")')
    if [[ -n "$status_counts" && "$status_counts" != "" ]]; then
      echo ""
      echo "  Status Distribution:"
      echo "    $status_counts"
    fi

    # Actionable count
    local actionable_count
    actionable_count=$(echo "$result" | jq -r '.result.actionableCount // 0')
    echo "    actionable: $actionable_count"

    # Age stats
    local age_stats oldest newest
    age_stats=$(echo "$result" | jq '.result.ageStats // null')
    if [[ "$age_stats" != "null" ]]; then
      oldest=$(echo "$age_stats" | jq -r '.oldestEntry // "N/A"')
      newest=$(echo "$age_stats" | jq -r '.newestEntry // "N/A"')
      echo ""
      echo "  Age Stats:"
      echo "    Oldest: $oldest"
      echo "    Newest: $newest"

      local today last7 last30 older
      today=$(echo "$age_stats" | jq -r '.distribution.today // 0')
      last7=$(echo "$age_stats" | jq -r '.distribution.last7days // 0')
      last30=$(echo "$age_stats" | jq -r '.distribution.last30days // 0')
      older=$(echo "$age_stats" | jq -r '.distribution.older // 0')
      echo "    Today: $today, Last 7 days: $last7, Last 30 days: $last30, Older: $older"
    fi

    # Topic counts (show top 5)
    local topic_counts
    topic_counts=$(echo "$result" | jq -r '.result.topicCounts | to_entries | sort_by(-.value) | .[0:5] | map("\(.key): \(.value)") | join(", ")')
    if [[ -n "$topic_counts" && "$topic_counts" != "" ]]; then
      echo ""
      echo "  Top Topics:"
      echo "    $topic_counts"
    fi

    echo ""
  fi

  exit 0
}

# ============================================================================
# Research Plan Generation
# ============================================================================

generate_research_plan() {
  local research_id
  local timestamp
  local query_sanitized

  research_id=$(generate_id)
  timestamp=$(timestamp_iso)
  query_sanitized=$(sanitize_query "${QUERY:-$MODE}")

  # Build the research plan JSON
  local plan
  plan=$(jq -nc \
    --arg id "$research_id" \
    --arg mode "$MODE" \
    --arg query "$QUERY" \
    --arg depth "$DEPTH" \
    --arg timestamp "$timestamp" \
    --arg include_reddit "$INCLUDE_REDDIT" \
    --arg subreddit "$SUBREDDIT" \
    --arg reddit_topic "$REDDIT_TOPIC" \
    --arg library "$LIBRARY" \
    --arg topic "$TOPIC" \
    --arg link_task "$LINK_TASK" \
    --argjson urls "$(printf '%s\n' "${URLS[@]:-}" | jq -R . | jq -s .)" \
    '{
      "$schema": "cleo://research/plan/v1",
      "research_id": $id,
      "created_at": $timestamp,
      "status": "pending",
      "mode": $mode,
      "query": $query,
      "depth": $depth,
      "options": {
        "include_reddit": ($include_reddit == "true"),
        "subreddit": (if $subreddit != "" then $subreddit else null end),
        "reddit_topic": (if $reddit_topic != "" then $reddit_topic else null end),
        "library": (if $library != "" then $library else null end),
        "topic": (if $topic != "" then $topic else null end),
        "urls": (if ($urls | length) > 0 and ($urls[0] != "") then $urls else null end),
        "link_task": (if $link_task != "" then $link_task else null end)
      },
      "execution_plan": {
        "stages": []
      }
    }')

  # Add execution stages based on mode
  local max_results
  case $DEPTH in
    quick) max_results=5 ;;
    deep) max_results=20 ;;
    *) max_results=10 ;;
  esac

  case $MODE in
    query)
      if [[ "$INCLUDE_REDDIT" == "true" ]]; then
        plan=$(echo "$plan" | jq --argjson max_results "$max_results" '
          .execution_plan.stages = [
            {"stage": 1, "name": "discovery", "tools": ["tavily_search", "WebSearch"], "description": "Search for relevant sources", "parameters": {"max_results": $max_results, "search_depth": "advanced"}},
            {"stage": 2, "name": "library_check", "tools": ["mcp__context7__resolve-library-id", "mcp__context7__get-library-docs"], "description": "Check for library/framework documentation if keywords detected", "conditional": true},
            {"stage": 3, "name": "reddit_search", "tools": ["tavily_search"], "description": "Search Reddit for community discussions", "parameters": {"include_domains": ["reddit.com"]}},
            {"stage": 4, "name": "extraction", "tools": ["tavily_extract", "WebFetch"], "description": "Extract content from discovered URLs"},
            {"stage": 5, "name": "synthesis", "tools": ["mcp__sequential-thinking__sequentialthinking"], "description": "Synthesize findings, identify themes, detect contradictions"},
            {"stage": 6, "name": "output", "tools": ["Write"], "description": "Generate JSON and Markdown outputs"}
          ]')
      else
        plan=$(echo "$plan" | jq --argjson max_results "$max_results" '
          .execution_plan.stages = [
            {"stage": 1, "name": "discovery", "tools": ["tavily_search", "WebSearch"], "description": "Search for relevant sources", "parameters": {"max_results": $max_results, "search_depth": "advanced"}},
            {"stage": 2, "name": "library_check", "tools": ["mcp__context7__resolve-library-id", "mcp__context7__get-library-docs"], "description": "Check for library/framework documentation if keywords detected", "conditional": true},
            {"stage": 3, "name": "extraction", "tools": ["tavily_extract", "WebFetch"], "description": "Extract content from discovered URLs"},
            {"stage": 4, "name": "synthesis", "tools": ["mcp__sequential-thinking__sequentialthinking"], "description": "Synthesize findings, identify themes, detect contradictions"},
            {"stage": 5, "name": "output", "tools": ["Write"], "description": "Generate JSON and Markdown outputs"}
          ]')
      fi
      ;;
    url)
      plan=$(echo "$plan" | jq '
        .execution_plan.stages = [
          {
            "stage": 1,
            "name": "extraction",
            "tools": ["tavily_extract", "WebFetch"],
            "description": "Extract content from provided URLs"
          },
          {
            "stage": 2,
            "name": "synthesis",
            "tools": ["mcp__sequential-thinking__sequentialthinking"],
            "description": "Synthesize and compare extracted content"
          },
          {
            "stage": 3,
            "name": "output",
            "tools": ["Write"],
            "description": "Generate JSON and Markdown outputs"
          }
        ]')
      ;;
    reddit)
      plan=$(echo "$plan" | jq '
        .execution_plan.stages = [
          {
            "stage": 1,
            "name": "reddit_search",
            "tools": ["tavily_search"],
            "description": "Search Reddit via Tavily with domain filter",
            "parameters": {
              "include_domains": ["reddit.com"]
            }
          },
          {
            "stage": 2,
            "name": "extraction",
            "tools": ["tavily_extract"],
            "description": "Extract content from Reddit results"
          },
          {
            "stage": 3,
            "name": "synthesis",
            "tools": ["mcp__sequential-thinking__sequentialthinking"],
            "description": "Identify consensus, controversial points, actionable advice"
          },
          {
            "stage": 4,
            "name": "output",
            "tools": ["Write"],
            "description": "Generate JSON and Markdown outputs"
          }
        ]')
      ;;
    library)
      plan=$(echo "$plan" | jq '
        .execution_plan.stages = [
          {
            "stage": 1,
            "name": "resolve_library",
            "tools": ["mcp__context7__resolve-library-id"],
            "description": "Resolve library name to Context7 ID"
          },
          {
            "stage": 2,
            "name": "fetch_docs",
            "tools": ["mcp__context7__get-library-docs"],
            "description": "Fetch library documentation"
          },
          {
            "stage": 3,
            "name": "supplementary",
            "tools": ["tavily_search"],
            "description": "Search for additional community resources",
            "conditional": true
          },
          {
            "stage": 4,
            "name": "synthesis",
            "tools": ["mcp__sequential-thinking__sequentialthinking"],
            "description": "Synthesize documentation into actionable insights"
          },
          {
            "stage": 5,
            "name": "output",
            "tools": ["Write"],
            "description": "Generate JSON and Markdown outputs"
          }
        ]')
      ;;
  esac

  # Add output configuration
  local output_file="research_${research_id}_${query_sanitized}"
  plan=$(echo "$plan" | jq \
    --arg output_dir "${OUTPUT_DIR:-$RESEARCH_DIR}" \
    --arg output_file "$output_file" \
    '. + {
      "output": {
        "directory": $output_dir,
        "json_file": ($output_file + ".json"),
        "markdown_file": ($output_file + ".md")
      }
    }')

  # Add agent instructions
  plan=$(echo "$plan" | jq '
    . + {
      "agent_instructions": {
        "pre_execution": [
          "Read and understand the execution plan stages",
          "Execute stages in order, respecting conditional flags",
          "Use fallback tools if primary tools fail",
          "Track all sources for citation"
        ],
        "post_execution": [
          "Save JSON output to specified file",
          "Save Markdown report to specified file",
          "Update research status to completed",
          "If link_task specified, add research reference to task notes"
        ],
        "output_schema": {
          "findings": "Array of key findings with citations",
          "themes": "Common themes across sources",
          "contradictions": "Conflicting claims found",
          "citations": "All sources with credibility scores",
          "confidence_score": "Overall research quality (0-1)"
        }
      }
    }')

  echo "$plan"
}

# ============================================================================
# Main Output
# ============================================================================

main() {
  validate_inputs
  ensure_research_dir

  local plan
  plan=$(generate_research_plan)

  # Determine output format
  if [[ -z "$FORMAT" ]]; then
    if [[ -t 1 ]]; then
      FORMAT="human"
    else
      FORMAT="json"
    fi
  fi

  # Save plan to file
  local research_id
  research_id=$(echo "$plan" | jq -r '.research_id')
  local plan_file="$RESEARCH_DIR/${research_id}_plan.json"

  echo "$plan" > "$plan_file"

  # Output based on format
  if [[ "$FORMAT" == "json" ]]; then
    # Full JSON output with meta envelope
    jq -nc \
      --arg version "$VERSION" \
      --arg cmd_version "$COMMAND_VERSION" \
      --arg timestamp "$(timestamp_iso)" \
      --arg plan_file "$plan_file" \
      --argjson plan "$plan" \
      '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {
          "format": "json",
          "version": $version,
          "command": "research",
          "command_version": $cmd_version,
          "timestamp": $timestamp
        },
        "success": true,
        "result": {
          "research_id": $plan.research_id,
          "status": "plan_created",
          "plan_file": $plan_file,
          "message": "Research plan created. Execute the stages using MCP tools.",
          "plan": $plan
        }
      }'
  else
    # Human-readable output
    echo ""
    echo "Research Plan Created"
    echo "====================="
    echo ""
    echo "  ID:     $research_id"
    echo "  Mode:   $MODE"
    echo "  Query:  ${QUERY:-$LIBRARY}"
    echo "  Depth:  $DEPTH"
    echo "  Plan:   $plan_file"
    echo ""
    echo "Execution Stages:"
    echo "$plan" | jq -r '.execution_plan.stages[] | "  \(.stage). \(.name): \(.description)"'
    echo ""
    echo "To execute this research, Claude should:"
    echo "  1. Read the plan file: $plan_file"
    echo "  2. Execute each stage using the specified MCP tools"
    echo "  3. Save outputs to: $(echo "$plan" | jq -r '.output.directory')"
    echo ""
    if [[ -n "$LINK_TASK" ]]; then
      echo "Linked to task: $LINK_TASK"
      echo ""
    fi
  fi
}

# ============================================================================
# Dispatch
# ============================================================================

case "$MODE" in
  init)
    run_init
    ;;
  list)
    run_list
    ;;
  show)
    run_show
    ;;
  inject)
    run_inject
    ;;
  pending)
    run_pending
    ;;
  get)
    run_get
    ;;
  link)
    run_link
    ;;
  links)
    run_links
    ;;
  unlink)
    run_unlink
    ;;
  archive)
    run_archive
    ;;
  archive-list)
    run_archive_list
    ;;
  compact)
    run_compact
    ;;
  stats)
    run_stats
    ;;
  status)
    run_status
    ;;
  validate)
    run_validate
    ;;
  *)
    main
    ;;
esac
