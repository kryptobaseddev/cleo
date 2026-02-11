#!/usr/bin/env bash
###CLEO
# command: find
# category: read
# synopsis: Fuzzy search tasks by title/description. ID prefix matching via --id.
# aliases: search
# relevance: critical
# flags: --format,--quiet,--id,--exact,--status,--field,--include-archive
# exits: 0,2,100
# json-output: true
###END
# CLEO Find Command
# Fuzzy task search for LLM agents with minimal context output
#
# Provides efficient task discovery with:
# - Fuzzy title/description search
# - ID prefix matching
# - Exact title match mode
# - Relevance scoring
# - Minimal JSON output (~500B-2KB vs 355KB for full list)
#
# Part of: LLM-Agent-First Implementation
# See: docs/specs/FIND-COMMAND-SPEC.md
#
# Version: 0.19.0
set -euo pipefail

# ============================================================================
# INITIALIZATION
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Capture start time for execution metrics (nanoseconds)
START_TIME_NS=$(date +%s%N 2>/dev/null || echo "0")

# Source version library for proper version management
LIB_DIR="${SCRIPT_DIR}/../lib"
if [[ -f "$LIB_DIR/version.sh" ]]; then
  # shellcheck source=../lib/version.sh
  source "$LIB_DIR/version.sh"
fi

# File paths
TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
ARCHIVE_FILE="${ARCHIVE_FILE:-.cleo/todo-archive.json}"

# Command name for error reporting
COMMAND_NAME="find"

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

LIB_DIR="${SCRIPT_DIR}/../lib"

# Source exit codes (required)
if [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
    # shellcheck source=../lib/exit-codes.sh
    source "$LIB_DIR/exit-codes.sh"
elif [[ -f "$CLEO_HOME/lib/exit-codes.sh" ]]; then
    source "$CLEO_HOME/lib/exit-codes.sh"
else
    # Fallback exit codes
    EXIT_SUCCESS=0
    EXIT_INVALID_INPUT=2
    EXIT_FILE_ERROR=3
    EXIT_NOT_FOUND=4
    EXIT_NO_DATA=100
fi

# Source error JSON library
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
    # shellcheck source=../lib/error-json.sh
    source "$LIB_DIR/error-json.sh"
elif [[ -f "$CLEO_HOME/lib/error-json.sh" ]]; then
    source "$CLEO_HOME/lib/error-json.sh"
fi

# Source output format library
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
    # shellcheck source=../lib/output-format.sh
    source "$LIB_DIR/output-format.sh"
elif [[ -f "$CLEO_HOME/lib/output-format.sh" ]]; then
    source "$CLEO_HOME/lib/output-format.sh"
fi

# Source logging library for color support
if [[ -f "$LIB_DIR/logging.sh" ]]; then
    # shellcheck source=../lib/logging.sh
    source "$LIB_DIR/logging.sh"
elif [[ -f "$CLEO_HOME/lib/logging.sh" ]]; then
    source "$CLEO_HOME/lib/logging.sh"
fi

# Source centralized flag parsing
if [[ -f "$LIB_DIR/flags.sh" ]]; then
    # shellcheck source=../lib/flags.sh
    source "$LIB_DIR/flags.sh"
elif [[ -f "$CLEO_HOME/lib/flags.sh" ]]; then
    source "$CLEO_HOME/lib/flags.sh"
fi

# Source JSON output library for pagination support
# @task T1446
if [[ -f "$LIB_DIR/json-output.sh" ]]; then
    # shellcheck source=../lib/json-output.sh
    source "$LIB_DIR/json-output.sh"
elif [[ -f "$CLEO_HOME/lib/json-output.sh" ]]; then
    source "$CLEO_HOME/lib/json-output.sh"
fi

# ============================================================================
# DEFAULTS
# ============================================================================

QUERY=""
ID_PATTERN=""
FIELD="title,description"
STATUS_FILTER=""
LIMIT=10
OFFSET=0
THRESHOLD="0.3"
EXACT_MATCH=false
INCLUDE_ARCHIVE=false
FORMAT=""
QUIET=false
VERBOSE=false

# ============================================================================
# COLOR SETUP
# ============================================================================

if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    MAGENTA='\033[0;35m'
    BOLD='\033[1m'
    DIM='\033[2m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' CYAN='' MAGENTA='' BOLD='' DIM='' NC=''
fi

# Unicode support detection
if declare -f detect_unicode_support >/dev/null 2>&1 && detect_unicode_support; then
    UNICODE_ENABLED=true
else
    UNICODE_ENABLED=false
fi

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat << 'EOF'
Usage: cleo find <query> [OPTIONS]
       cleo find --id <id-pattern> [OPTIONS]

Fuzzy search tasks by title, description, or ID pattern.
Returns minimal match objects for efficient LLM context usage.

Arguments:
  <query>             Search query for title/description

Options:
  -i, --id PATTERN    Search by task ID pattern (prefix match)
  --field FIELDS      Fields to search: title,description,labels,notes,all
                      (default: title,description)
  -s, --status STATUS Filter by status: pending|active|blocked|done
  -n, --limit N       Maximum results (default: 10)
  -t, --threshold N   Minimum match score 0-1 (default: 0.3)
  -e, --exact         Exact title match only
  --include-archive   Search archived tasks too
  -f, --format FMT    Output format: text|json (default: auto)
  --json              Shortcut for --format json
  --human             Shortcut for --format text
  -q, --quiet         Suppress non-essential output
  -v, --verbose       Include full task objects in output
  -h, --help          Show this help message

Exit Codes:
  0    Matches found
  2    Invalid input
  100  No matches found (not an error)

Examples:
  ct find "auth"                    # Fuzzy search for "auth"
  ct find "auth" --field title      # Search titles only
  ct find --id 37                   # Find tasks with ID prefix T37
  ct find "login" --exact           # Exact title match
  ct find "bug" --field labels      # Search in labels
  ct find "test" -n 5 --status pending  # Top 5 pending matches

Use Cases:
  - Task discovery before update
  - Dependency resolution
  - Duplicate checking before add
  - ID lookup with partial memory
EOF
    exit 0
}

# ============================================================================
# ARGUMENT PARSING
# ============================================================================

while [[ $# -gt 0 ]]; do
    case $1 in
        -i|--id)
            if [[ $# -lt 2 ]]; then
                if declare -f output_error >/dev/null 2>&1; then
                    output_error "$E_INPUT_MISSING" "--id requires a value" "$EXIT_INVALID_INPUT" true "Example: ct find --id 37"
                else
                    echo "[ERROR] --id requires a value" >&2
                fi
                exit "$EXIT_INVALID_INPUT"
            fi
            ID_PATTERN="$2"
            shift 2
            ;;
        --field)
            if [[ $# -lt 2 ]]; then
                if declare -f output_error >/dev/null 2>&1; then
                    output_error "$E_INPUT_MISSING" "--field requires a value" "$EXIT_INVALID_INPUT" true "Valid: title,description,labels,notes,all"
                else
                    echo "[ERROR] --field requires a value" >&2
                fi
                exit "$EXIT_INVALID_INPUT"
            fi
            FIELD="$2"
            shift 2
            ;;
        -s|--status)
            if [[ $# -lt 2 ]]; then
                if declare -f output_error >/dev/null 2>&1; then
                    output_error "$E_INPUT_MISSING" "--status requires a value" "$EXIT_INVALID_INPUT" true "Valid: pending|active|blocked|done"
                else
                    echo "[ERROR] --status requires a value" >&2
                fi
                exit "$EXIT_INVALID_INPUT"
            fi
            STATUS_FILTER="$2"
            shift 2
            ;;
        -n|--limit)
            if [[ $# -lt 2 ]]; then
                if declare -f output_error >/dev/null 2>&1; then
                    output_error "$E_INPUT_MISSING" "--limit requires a number" "$EXIT_INVALID_INPUT" true "Example: ct find 'test' --limit 5"
                else
                    echo "[ERROR] --limit requires a number" >&2
                fi
                exit "$EXIT_INVALID_INPUT"
            fi
            LIMIT="$2"
            shift 2
            ;;
        --offset)
            if [[ $# -lt 2 ]]; then
                if declare -f output_error >/dev/null 2>&1; then
                    output_error "$E_INPUT_MISSING" "--offset requires a number" "$EXIT_INVALID_INPUT" true "Example: ct find 'test' --offset 10"
                else
                    echo "[ERROR] --offset requires a number" >&2
                fi
                exit "$EXIT_INVALID_INPUT"
            fi
            OFFSET="$2"
            shift 2
            ;;
        -t|--threshold)
            if [[ $# -lt 2 ]]; then
                if declare -f output_error >/dev/null 2>&1; then
                    output_error "$E_INPUT_MISSING" "--threshold requires a value (0-1)" "$EXIT_INVALID_INPUT" true "Example: ct find 'test' --threshold 0.5"
                else
                    echo "[ERROR] --threshold requires a value (0-1)" >&2
                fi
                exit "$EXIT_INVALID_INPUT"
            fi
            THRESHOLD="$2"
            shift 2
            ;;
        -e|--exact)
            EXACT_MATCH=true
            shift
            ;;
        --include-archive)
            INCLUDE_ARCHIVE=true
            shift
            ;;
        -f|--format)
            if [[ $# -lt 2 ]]; then
                if declare -f output_error >/dev/null 2>&1; then
                    output_error "$E_INPUT_MISSING" "--format requires a value" "$EXIT_INVALID_INPUT" true "Valid: text|json"
                else
                    echo "[ERROR] --format requires a value" >&2
                fi
                exit "$EXIT_INVALID_INPUT"
            fi
            FORMAT="$2"
            shift 2
            ;;
        --json)
            FORMAT="json"
            shift
            ;;
        --human)
            FORMAT="human"
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
        -*)
            if declare -f output_error >/dev/null 2>&1; then
                output_error "$E_INPUT_INVALID" "Unknown option: $1" "$EXIT_INVALID_INPUT" true "Run 'ct find --help' for usage"
            else
                echo "[ERROR] Unknown option: $1" >&2
            fi
            exit "$EXIT_INVALID_INPUT"
            ;;
        *)
            # Positional argument is the query
            if [[ -z "$QUERY" ]]; then
                QUERY="$1"
            else
                if declare -f output_error >/dev/null 2>&1; then
                    output_error "$E_INPUT_INVALID" "Multiple queries provided" "$EXIT_INVALID_INPUT" true "Provide only one search query"
                else
                    echo "[ERROR] Multiple queries provided" >&2
                fi
                exit "$EXIT_INVALID_INPUT"
            fi
            shift
            ;;
    esac
done

# ============================================================================
# FORMAT RESOLUTION (TTY-aware)
# ============================================================================

if declare -f resolve_format >/dev/null 2>&1; then
    FORMAT=$(resolve_format "$FORMAT")
else
    # Fallback if output-format.sh not loaded
    if [[ -z "$FORMAT" ]]; then
        if [[ -t 1 ]]; then
            FORMAT="human"
        else
            FORMAT="json"
        fi
    fi
fi

# ============================================================================
# INPUT VALIDATION
# ============================================================================

# Require either query or --id
if [[ -z "$QUERY" && -z "$ID_PATTERN" ]]; then
    if declare -f output_error >/dev/null 2>&1; then
        output_error "$E_INPUT_MISSING" "Search query required" "$EXIT_INVALID_INPUT" true "Use 'ct find <query>' or 'ct find --id <pattern>'"
    else
        echo "[ERROR] Search query required" >&2
    fi
    exit "$EXIT_INVALID_INPUT"
fi

# Validate status filter
if [[ -n "$STATUS_FILTER" ]]; then
    case "$STATUS_FILTER" in
        pending|active|blocked|done) ;;
        *)
            if declare -f output_error >/dev/null 2>&1; then
                output_error "$E_INPUT_INVALID" "Invalid status: $STATUS_FILTER" "$EXIT_INVALID_INPUT" true "Valid: pending|active|blocked|done"
            else
                echo "[ERROR] Invalid status: $STATUS_FILTER" >&2
            fi
            exit "$EXIT_INVALID_INPUT"
            ;;
    esac
fi

# Validate limit is a positive integer
if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [[ "$LIMIT" -lt 1 ]]; then
    if declare -f output_error >/dev/null 2>&1; then
        output_error "$E_INPUT_INVALID" "Limit must be a positive integer: $LIMIT" "$EXIT_INVALID_INPUT" true "Example: ct find 'test' --limit 5"
    else
        echo "[ERROR] Limit must be a positive integer: $LIMIT" >&2
    fi
    exit "$EXIT_INVALID_INPUT"
fi

# Check todo.json exists
if [[ ! -f "$TODO_FILE" ]]; then
    if declare -f output_error >/dev/null 2>&1; then
        output_error "$E_NOT_INITIALIZED" "Todo file not found: $TODO_FILE" "$EXIT_FILE_ERROR" true "Run 'cleo init' to initialize project"
    else
        echo "[ERROR] Todo file not found: $TODO_FILE" >&2
    fi
    exit "$EXIT_FILE_ERROR"
fi

# Check jq is available
if ! command -v jq &>/dev/null; then
    if declare -f output_error >/dev/null 2>&1; then
        output_error "$E_DEPENDENCY_MISSING" "jq is required but not installed" "$EXIT_DEPENDENCY_ERROR" false "Install jq: https://stedolan.github.io/jq/download/"
    else
        echo "[ERROR] jq is required but not installed" >&2
    fi
    exit "${EXIT_DEPENDENCY_ERROR:-5}"
fi

# ============================================================================
# SEARCH MODE DETERMINATION
# ============================================================================

SEARCH_MODE="fuzzy"
if [[ -n "$ID_PATTERN" ]]; then
    SEARCH_MODE="id"
elif [[ "$EXACT_MATCH" == true ]]; then
    SEARCH_MODE="exact"
fi

# Determine which fields to search
SEARCH_TITLE=false
SEARCH_DESCRIPTION=false
SEARCH_LABELS=false
SEARCH_NOTES=false

if [[ "$FIELD" == "all" ]]; then
    SEARCH_TITLE=true
    SEARCH_DESCRIPTION=true
    SEARCH_LABELS=true
    SEARCH_NOTES=true
else
    IFS=',' read -ra FIELD_ARRAY <<< "$FIELD"
    for f in "${FIELD_ARRAY[@]}"; do
        case "$f" in
            title) SEARCH_TITLE=true ;;
            description) SEARCH_DESCRIPTION=true ;;
            labels) SEARCH_LABELS=true ;;
            notes) SEARCH_NOTES=true ;;
        esac
    done
fi

# ============================================================================
# LOAD TASKS
# ============================================================================

# Build base filter for status
STATUS_JQ_FILTER=""
if [[ -n "$STATUS_FILTER" ]]; then
    STATUS_JQ_FILTER="| select(.status == \"$STATUS_FILTER\")"
fi

# Load tasks from todo.json
TASKS=$(jq -c ".tasks[] $STATUS_JQ_FILTER" "$TODO_FILE" 2>/dev/null || echo "")

# Include archive if requested
if [[ "$INCLUDE_ARCHIVE" == true && -f "$ARCHIVE_FILE" ]]; then
    ARCHIVE_TASKS=$(jq -c ".archivedTasks[] $STATUS_JQ_FILTER" "$ARCHIVE_FILE" 2>/dev/null || echo "")
    if [[ -n "$ARCHIVE_TASKS" ]]; then
        if [[ -n "$TASKS" ]]; then
            TASKS="${TASKS}"$'\n'"${ARCHIVE_TASKS}"
        else
            TASKS="$ARCHIVE_TASKS"
        fi
    fi
fi

# Count total tasks searched
if [[ -n "$TASKS" ]]; then
    TOTAL_SEARCHED=$(echo "$TASKS" | wc -l)
else
    TOTAL_SEARCHED=0
fi

# ============================================================================
# SEARCH IMPLEMENTATION
# ============================================================================

perform_search() {
    local tasks="$1"
    local query="$2"
    local search_mode="$3"
    local threshold="$4"
    local verbose="$5"

    if [[ -z "$tasks" ]]; then
        echo "[]"
        return
    fi

    # Convert tasks to array for jq processing
    local tasks_array
    tasks_array=$(echo "$tasks" | jq -s '.')

    # Build jq filter based on search mode
    case "$search_mode" in
        id)
            # ID prefix search
            local id_query
            # Normalize: remove T prefix if present, match as prefix
            id_query=$(echo "$ID_PATTERN" | sed 's/^T//i')

            echo "$tasks_array" | jq --arg pattern "$id_query" --argjson verbose "$verbose" '
                [.[] |
                    # Extract numeric part of ID
                    (.id | ltrimstr("T")) as $task_num |
                    # Check if pattern matches start of ID number
                    if ($task_num | startswith($pattern)) then
                        {
                            id: .id,
                            title: .title,
                            status: .status,
                            priority: (.priority // "medium"),
                            score: 1.0,
                            matched_in: ["id"]
                        } + (if .phase then {phase: .phase} else {} end)
                          + (if $verbose then {task: .} else {} end)
                    else
                        empty
                    end
                ] | sort_by(-.score, .id)'
            ;;

        exact)
            # Exact title match
            echo "$tasks_array" | jq --arg query "$query" --argjson verbose "$verbose" '
                [.[] |
                    if (.title | ascii_downcase) == ($query | ascii_downcase) then
                        {
                            id: .id,
                            title: .title,
                            status: .status,
                            priority: (.priority // "medium"),
                            score: 1.0,
                            matched_in: ["title"]
                        } + (if .phase then {phase: .phase} else {} end)
                          + (if $verbose then {task: .} else {} end)
                    else
                        empty
                    end
                ]'
            ;;

        fuzzy)
            # Fuzzy search with scoring
            echo "$tasks_array" | jq \
                --arg query "$query" \
                --argjson threshold "$threshold" \
                --argjson search_title "$SEARCH_TITLE" \
                --argjson search_desc "$SEARCH_DESCRIPTION" \
                --argjson search_labels "$SEARCH_LABELS" \
                --argjson search_notes "$SEARCH_NOTES" \
                --argjson verbose "$verbose" '
                # Scoring function
                def score_match(text; field_weight):
                    if text == null or text == "" then 0
                    else
                        (text | ascii_downcase) as $lower_text |
                        ($query | ascii_downcase) as $lower_query |
                        if $lower_text == $lower_query then
                            # Exact match
                            1.0 * field_weight
                        elif ($lower_text | startswith($lower_query)) then
                            # Starts with query (word boundary bonus)
                            0.95 * field_weight
                        elif ($lower_text | contains($lower_query)) then
                            # Contains query - give bonus for word boundary match
                            # Use try/catch to handle regex special chars in query
                            (
                                try (
                                    # Escape regex special chars in query
                                    ($lower_query | gsub("(?<c>[.\\[\\]^$|?*+(){}\\\\])"; "\\\(.c)")) as $escaped |
                                    if ($lower_text | test("\\b" + $escaped)) then
                                        0.85 * field_weight
                                    else
                                        0.7 * field_weight
                                    end
                                ) catch 0.7 * field_weight  # Fallback on regex error
                            )
                        else
                            0
                        end
                    end;

                # Score labels array
                def score_labels(labels; field_weight):
                    if labels == null or (labels | length) == 0 then 0
                    else
                        [labels[] | score_match(.; field_weight)] | max
                    end;

                # Score notes array
                def score_notes(notes; field_weight):
                    if notes == null or (notes | length) == 0 then 0
                    else
                        [notes[] | score_match(.; field_weight)] | max
                    end;

                [.[] |
                    . as $task |
                    # Calculate scores for each field
                    (if $search_title then score_match(.title; 1.0) else 0 end) as $title_score |
                    (if $search_desc then score_match(.description; 0.7) else 0 end) as $desc_score |
                    (if $search_labels then score_labels(.labels; 0.9) else 0 end) as $labels_score |
                    (if $search_notes then score_notes(.notes; 0.5) else 0 end) as $notes_score |

                    # Determine which fields matched
                    (
                        (if $title_score > 0 then ["title"] else [] end) +
                        (if $desc_score > 0 then ["description"] else [] end) +
                        (if $labels_score > 0 then ["labels"] else [] end) +
                        (if $notes_score > 0 then ["notes"] else [] end)
                    ) as $matched_in |

                    # Take max score across fields
                    ([$title_score, $desc_score, $labels_score, $notes_score] | max) as $score |

                    # Only include if score meets threshold
                    if $score >= $threshold and ($matched_in | length) > 0 then
                        {
                            id: .id,
                            title: .title,
                            status: .status,
                            priority: (.priority // "medium"),
                            score: ($score | . * 100 | round / 100),
                            matched_in: $matched_in
                        } + (if .phase then {phase: .phase} else {} end)
                          + (if $verbose then {task: $task} else {} end)
                    else
                        empty
                    end
                ] | sort_by(-.score)'
            ;;
    esac
}

# Execute search
VERBOSE_JSON="false"
[[ "$VERBOSE" == true ]] && VERBOSE_JSON="true"

MATCHES=$(perform_search "$TASKS" "$QUERY" "$SEARCH_MODE" "$THRESHOLD" "$VERBOSE_JSON")

# Count total matches before pagination (@task T1446)
TOTAL_MATCHES=$(echo "$MATCHES" | jq 'length')

# Apply offset then limit for pagination
if [[ "$OFFSET" -gt 0 ]]; then
    MATCHES=$(echo "$MATCHES" | jq --argjson offset "$OFFSET" '.[$offset:]')
fi
MATCHES=$(echo "$MATCHES" | jq --argjson limit "$LIMIT" '.[:$limit]')

# Count matches on this page
MATCH_COUNT=$(echo "$MATCHES" | jq 'length')

# Check if results were truncated (more available beyond this page)
TRUNCATED=false
if (( OFFSET + MATCH_COUNT < TOTAL_MATCHES )); then
    TRUNCATED=true
fi

# ============================================================================
# EXECUTION METRICS
# ============================================================================

END_TIME_NS=$(date +%s%N 2>/dev/null || echo "$START_TIME_NS")
if [[ "$START_TIME_NS" != "0" ]] && [[ "$END_TIME_NS" != "0" ]]; then
    EXECUTION_MS=$(( (END_TIME_NS - START_TIME_NS) / 1000000 ))
else
    EXECUTION_MS=0
fi

CURRENT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ============================================================================
# OUTPUT
# ============================================================================

# Determine fields array for query object
FIELDS_ARRAY="[\"title\", \"description\"]"
if [[ "$SEARCH_MODE" == "id" ]]; then
    FIELDS_ARRAY="[\"id\"]"
elif [[ "$FIELD" == "all" ]]; then
    FIELDS_ARRAY='["title", "description", "labels", "notes"]'
else
    FIELDS_ARRAY=$(echo "$FIELD" | jq -R 'split(",")')
fi

case "$FORMAT" in
    json)
        # Build pagination metadata (@task T1446)
        PAGINATION_JSON="null"
        if declare -f get_pagination_meta >/dev/null 2>&1; then
            PAGINATION_JSON=$(get_pagination_meta "$TOTAL_MATCHES" "$LIMIT" "$OFFSET")
        else
            _has_more="false"
            if (( OFFSET + LIMIT < TOTAL_MATCHES )); then
                _has_more="true"
            fi
            PAGINATION_JSON=$(jq -nc \
                --argjson total "$TOTAL_MATCHES" \
                --argjson limit "$LIMIT" \
                --argjson offset "$OFFSET" \
                --argjson has_more "$_has_more" \
                '{total: $total, limit: $limit, offset: $offset, hasMore: $has_more}')
        fi

        # JSON output with LLM-Agent-First envelope
        jq -nc \
            --arg version "${CLEO_VERSION:-$(get_version)}" \
            --arg timestamp "$CURRENT_TIMESTAMP" \
            --argjson execution_ms "$EXECUTION_MS" \
            --arg query "${QUERY:-$ID_PATTERN}" \
            --arg mode "$SEARCH_MODE" \
            --argjson fields "$FIELDS_ARRAY" \
            --argjson threshold "$THRESHOLD" \
            --argjson total_searched "$TOTAL_SEARCHED" \
            --argjson match_count "$MATCH_COUNT" \
            --argjson total_matches "$TOTAL_MATCHES" \
            --argjson truncated "$TRUNCATED" \
            --argjson matches "$MATCHES" \
            --argjson pagination "$PAGINATION_JSON" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": "find",
                    "timestamp": $timestamp,
                    "execution_ms": $execution_ms,
                    "resultsField": "matches"
                },
                "success": true,
                "query": {
                    "text": $query,
                    "mode": $mode,
                    "fields": $fields,
                    "threshold": $threshold
                },
                "summary": {
                    "total_searched": $total_searched,
                    "matches": $match_count,
                    "total_matches": $total_matches,
                    "truncated": $truncated
                },
                "pagination": $pagination,
                "matches": $matches
            } | if .pagination == null then del(.pagination) else . end'

        # Exit with appropriate code
        if [[ "$MATCH_COUNT" -eq 0 ]]; then
            exit "$EXIT_NO_DATA"
        else
            exit "$EXIT_SUCCESS"
        fi
        ;;

    text|*)
        # Human-readable text output
        if [[ "$MATCH_COUNT" -eq 0 ]]; then
            if [[ "$QUIET" != true ]]; then
                echo ""
                echo -e "${YELLOW}No matches found for \"${QUERY:-$ID_PATTERN}\"${NC}"
                echo ""
            fi
            exit "$EXIT_NO_DATA"
        fi

        # Header
        if [[ "$QUIET" != true ]]; then
            echo ""
            if [[ "$UNICODE_ENABLED" == true ]]; then
                echo -e "${BOLD}FIND:${NC} \"${CYAN}${QUERY:-$ID_PATTERN}${NC}\" ${DIM}($MATCH_COUNT matches)${NC}"
                echo -e "${DIM}$(printf '%.0s━' {1..60})${NC}"
            else
                echo -e "${BOLD}FIND:${NC} \"${CYAN}${QUERY:-$ID_PATTERN}${NC}\" ${DIM}($MATCH_COUNT matches)${NC}"
                echo -e "${DIM}$(printf '%.0s-' {1..60})${NC}"
            fi
            echo ""
        fi

        # Display matches
        echo "$MATCHES" | jq -r '.[] | @json' | while IFS= read -r match_json; do
            id=$(echo "$match_json" | jq -r '.id')
            title=$(echo "$match_json" | jq -r '.title')
            status=$(echo "$match_json" | jq -r '.status')
            priority=$(echo "$match_json" | jq -r '.priority')
            score=$(echo "$match_json" | jq -r '.score')
            matched_in=$(echo "$match_json" | jq -r '.matched_in | join(", ")')
            phase=$(echo "$match_json" | jq -r '.phase // empty')

            # Truncate title if too long
            if [[ ${#title} -gt 50 ]]; then
                title="${title:0:47}..."
            fi

            # Status indicator
            status_indicator=""
            case "$status" in
                pending)
                    if [[ "$UNICODE_ENABLED" == true ]]; then
                        status_indicator="${YELLOW}[pending]${NC}"
                    else
                        status_indicator="${YELLOW}[pending]${NC}"
                    fi
                    ;;
                active)
                    if [[ "$UNICODE_ENABLED" == true ]]; then
                        status_indicator="${GREEN}[active]${NC}"
                    else
                        status_indicator="${GREEN}[active]${NC}"
                    fi
                    ;;
                blocked)
                    if [[ "$UNICODE_ENABLED" == true ]]; then
                        status_indicator="${RED}[blocked]${NC}"
                    else
                        status_indicator="${RED}[blocked]${NC}"
                    fi
                    ;;
                done)
                    status_indicator="${DIM}[done]${NC}"
                    ;;
            esac

            # Main line
            printf "  ${BOLD}%-5s${NC}  ${status_indicator}  %-50s ${DIM}(%.2f)${NC}\n" "$id" "$title" "$score"

            # Details line
            details=""
            [[ -n "$priority" && "$priority" != "medium" ]] && details="${priority}"
            [[ -n "$phase" ]] && details="${details:+$details, }phase:$phase"
            [[ "$matched_in" != "title" ]] && details="${details:+$details, }matched in $matched_in"

            if [[ -n "$details" ]]; then
                echo -e "         ${DIM}$details${NC}"
            fi

            echo ""
        done

        # Footer
        if [[ "$QUIET" != true ]]; then
            if [[ "$UNICODE_ENABLED" == true ]]; then
                echo -e "${DIM}$(printf '%.0s━' {1..60})${NC}"
            else
                echo -e "${DIM}$(printf '%.0s-' {1..60})${NC}"
            fi
            echo -e "${DIM}Use 'ct show <id>' to view full details${NC}"
        fi

        exit "$EXIT_SUCCESS"
        ;;
esac
