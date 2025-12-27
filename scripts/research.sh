#!/usr/bin/env bash
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
LIB_DIR="$CLEO_HOME/lib"
VERSION="$(cat "$CLEO_HOME/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "0.0.0")"

# Source libraries
source "$LIB_DIR/logging.sh" 2>/dev/null || true
source "$LIB_DIR/output-format.sh" 2>/dev/null || true
source "$LIB_DIR/exit-codes.sh" 2>/dev/null || true

# Command metadata
COMMAND_NAME="research"
COMMAND_VERSION="1.0.0"

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
FORMAT=""
INCLUDE_REDDIT="false"
EXECUTE="false"
LINK_TASK=""
PLAN_ONLY="false"

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

while [[ $# -gt 0 ]]; do
  case $1 in
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
    -f|--format)
      FORMAT="$2"
      shift 2
      ;;
    --json)
      FORMAT="json"
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
  plan=$(jq -n \
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
      "$schema": "claude-todo://research/plan/v1",
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
      FORMAT="text"
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
    jq -n \
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

main
