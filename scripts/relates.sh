#!/usr/bin/env bash
###CLEO
# command: relates
# category: read
# synopsis: Semantic relationship discovery and management between tasks (suggest, add, remove, list)
# relevance: medium
# flags: --format,--quiet,--json,--threshold
# exits: 0,2,4,100
# json-output: true
###END
# relates.sh - Manage task relationships
#
# CLEO Relates Command - Semantic relationship discovery and management
#
# Subcommands:
#   suggest <task-id>   - Suggest related tasks based on shared attributes
#   add <from> <to> <type> "<reason>" - Add a relates entry to a task
#   discover <task-id>  - Discover related tasks using various methods
#   list <task-id>      - Show existing relates entries for a task
#
# Part of: CLEO Task Management System
#####################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Capture start time for execution metrics
START_TIME_NS=$(date +%s%N 2>/dev/null || echo "0")

# Source version from central location
if [[ -f "$CLEO_HOME/VERSION" ]]; then
    VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
    VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
    VERSION="unknown"
fi

# File paths
CLAUDE_DIR="${CLAUDE_DIR:-.cleo}"
TODO_FILE="${CLAUDE_DIR}/todo.json"
ARCHIVE_FILE="${CLAUDE_DIR}/todo-archive.json"

#####################################################################
# Source Libraries
#####################################################################

# Source file operations
if [[ -f "${LIB_DIR}/file-ops.sh" ]]; then
    source "${LIB_DIR}/file-ops.sh"
elif [[ -f "$CLEO_HOME/lib/file-ops.sh" ]]; then
    source "$CLEO_HOME/lib/file-ops.sh"
fi

# Source logging library
if [[ -f "${LIB_DIR}/logging.sh" ]]; then
    source "${LIB_DIR}/logging.sh"
elif [[ -f "$CLEO_HOME/lib/logging.sh" ]]; then
    source "$CLEO_HOME/lib/logging.sh"
fi

# Source output-format library
if [[ -f "${LIB_DIR}/output-format.sh" ]]; then
    source "${LIB_DIR}/output-format.sh"
elif [[ -f "$CLEO_HOME/lib/output-format.sh" ]]; then
    source "$CLEO_HOME/lib/output-format.sh"
fi

# Source error JSON library (includes exit-codes.sh)
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
    source "$LIB_DIR/error-json.sh"
elif [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
    source "$LIB_DIR/exit-codes.sh"
fi

# Source flags library
if [[ -f "${LIB_DIR}/flags.sh" ]]; then
    source "${LIB_DIR}/flags.sh"
elif [[ -f "$CLEO_HOME/lib/flags.sh" ]]; then
    source "$CLEO_HOME/lib/flags.sh"
fi

# Source crossref-extract library for relates helpers
if [[ -f "${LIB_DIR}/crossref-extract.sh" ]]; then
    source "${LIB_DIR}/crossref-extract.sh"
elif [[ -f "$CLEO_HOME/lib/crossref-extract.sh" ]]; then
    source "$CLEO_HOME/lib/crossref-extract.sh"
fi

#####################################################################
# Configuration
#####################################################################

COMMAND_NAME="relates"
SUBCOMMAND=""
TASK_ID=""
TARGET_ID=""
REL_TYPE=""
REASON=""
THRESHOLD="0.5"
DISCOVER_METHOD="auto"

# Initialize flag defaults if available
if declare -f init_flag_defaults >/dev/null 2>&1; then
    init_flag_defaults
fi

# Valid relationship types (from schema)
VALID_REL_TYPES="relates-to spawned-from deferred-to supersedes duplicates"

#####################################################################
# Color Setup
#####################################################################

setup_colors() {
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
}

#####################################################################
# Usage
#####################################################################

usage() {
    cat << 'EOF'
Usage: cleo relates <subcommand> [options]

Manage task relationships and discover semantic connections.

Subcommands:
    suggest <task-id>     Suggest related tasks based on shared attributes
    add <from> <to> <type> "<reason>"  Add a relates entry
    discover <task-id>    Discover related tasks using various methods
    list <task-id>        Show existing relates entries for a task

Options:
    --threshold N         Similarity threshold for suggest (0.0-1.0, default: 0.5)
    --method METHOD       Discovery method: labels, description, files, auto (default: auto)
    -f, --format FORMAT   Output format: text | json (default: auto-detect)
    --json                Force JSON output
    --human               Force text output
    -q, --quiet           Suppress informational messages
    -h, --help            Show this help message

Relationship Types:
    relates-to            General relationship (default)
    spawned-from          Derived from another task
    deferred-to           Work postponed to another task
    supersedes            Replaces another task
    duplicates            Same as another task

Examples:
    cleo relates suggest T2122                # Find tasks related to T2122
    cleo relates suggest T2122 --threshold 0.7
    cleo relates add T2122 T2100 spawned-from "Derived during analysis"
    cleo relates discover T2122 --method labels
    cleo relates list T2122                   # Show T2122's relationships
    cleo relates list T2122 --json            # JSON output

Discovery Methods:
    labels       Find tasks with overlapping labels
    description  Find tasks with similar text content
    files        Find tasks referencing similar files
    auto         Combine all methods (default)

EOF
    exit "${EXIT_SUCCESS:-0}"
}

#####################################################################
# Validation Helpers
#####################################################################

# Check if task exists
task_exists() {
    local task_id="$1"
    local file="${2:-$TODO_FILE}"
    
    if [[ ! -f "$file" ]]; then
        return 1
    fi
    
    jq -e --arg id "$task_id" '.tasks[] | select(.id == $id)' "$file" >/dev/null 2>&1
}

# Get task by ID
get_task() {
    local task_id="$1"
    local file="${2:-$TODO_FILE}"
    
    jq -c --arg id "$task_id" '.tasks[] | select(.id == $id)' "$file" 2>/dev/null
}

# Validate relationship type
validate_rel_type() {
    local type="$1"
    case "$type" in
        relates-to|spawned-from|deferred-to|supersedes|duplicates)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

#####################################################################
# Suggest Subcommand
#####################################################################

# Calculate similarity score between two tasks
calculate_similarity() {
    local task1="$1"
    local task2="$2"
    
    local score=0
    local factors=0
    
    # Extract task properties
    local labels1 labels2 phase1 phase2 priority1 priority2 type1 type2
    labels1=$(echo "$task1" | jq -r '.labels // [] | sort | @json')
    labels2=$(echo "$task2" | jq -r '.labels // [] | sort | @json')
    phase1=$(echo "$task1" | jq -r '.phase // ""')
    phase2=$(echo "$task2" | jq -r '.phase // ""')
    priority1=$(echo "$task1" | jq -r '.priority // ""')
    priority2=$(echo "$task2" | jq -r '.priority // ""')
    type1=$(echo "$task1" | jq -r '.type // "task"')
    type2=$(echo "$task2" | jq -r '.type // "task"')
    
    # Label overlap (weighted heavily)
    if [[ "$labels1" != "[]" && "$labels2" != "[]" ]]; then
        local common_labels
        common_labels=$(jq -n --argjson l1 "$labels1" --argjson l2 "$labels2" \
            '[$l1[] as $a | $l2[] | select(. == $a)] | length')
        local total_labels
        total_labels=$(jq -n --argjson l1 "$labels1" --argjson l2 "$labels2" \
            '([$l1[], $l2[]] | unique | length)')
        if [[ "$total_labels" -gt 0 ]]; then
            local label_score
            label_score=$(echo "scale=2; $common_labels / $total_labels" | bc)
            score=$(echo "scale=2; $score + ($label_score * 0.4)" | bc)
        fi
        factors=$((factors + 1))
    fi
    
    # Same phase
    if [[ -n "$phase1" && -n "$phase2" && "$phase1" == "$phase2" ]]; then
        score=$(echo "scale=2; $score + 0.2" | bc)
    fi
    factors=$((factors + 1))
    
    # Same priority
    if [[ -n "$priority1" && -n "$priority2" && "$priority1" == "$priority2" ]]; then
        score=$(echo "scale=2; $score + 0.15" | bc)
    fi
    factors=$((factors + 1))
    
    # Same type
    if [[ "$type1" == "$type2" ]]; then
        score=$(echo "scale=2; $score + 0.1" | bc)
    fi
    factors=$((factors + 1))
    
    # Check for parent-child relationship (reduce score - they're already connected)
    local parent1 parent2 id1 id2
    parent1=$(echo "$task1" | jq -r '.parentId // ""')
    parent2=$(echo "$task2" | jq -r '.parentId // ""')
    id1=$(echo "$task1" | jq -r '.id')
    id2=$(echo "$task2" | jq -r '.id')
    
    if [[ "$parent1" == "$id2" || "$parent2" == "$id1" ]]; then
        score=$(echo "scale=2; $score * 0.5" | bc)  # Reduce score for parent-child
    fi
    
    # Check if already related
    local existing_relates
    existing_relates=$(echo "$task1" | jq -r --arg id "$id2" '.relates // [] | map(.taskId) | index($id) != null')
    if [[ "$existing_relates" == "true" ]]; then
        score="0"  # Already related, skip
    fi
    
    echo "$score"
}

cmd_suggest() {
    local task_id="$1"
    local threshold="$2"
    
    # Validate task exists
    if ! task_exists "$task_id"; then
        if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_NOT_FOUND" "Task not found: $task_id" "${EXIT_NOT_FOUND:-4}" true "Verify task ID with: cleo exists $task_id"
        else
            echo -e "${RED}[ERROR]${NC} Task not found: $task_id" >&2
        fi
        exit "${EXIT_NOT_FOUND:-4}"
    fi
    
    # Get the source task
    local source_task
    source_task=$(get_task "$task_id")
    
    # Get all tasks
    local all_tasks
    all_tasks=$(jq -c '.tasks[]' "$TODO_FILE")
    
    # Calculate similarities
    local suggestions="[]"
    while IFS= read -r task; do
        local other_id
        other_id=$(echo "$task" | jq -r '.id')
        
        # Skip self
        [[ "$other_id" == "$task_id" ]] && continue
        
        # Calculate similarity
        local sim_score
        sim_score=$(calculate_similarity "$source_task" "$task")
        
        # Check threshold
        if [[ $(echo "$sim_score >= $threshold" | bc) -eq 1 && "$sim_score" != "0" ]]; then
            local title status
            title=$(echo "$task" | jq -r '.title')
            status=$(echo "$task" | jq -r '.status')
            
            suggestions=$(echo "$suggestions" | jq \
                --arg id "$other_id" \
                --arg title "$title" \
                --arg status "$status" \
                --arg score "$sim_score" \
                '. + [{
                    "taskId": $id,
                    "title": $title,
                    "status": $status,
                    "score": ($score | tonumber)
                }]')
        fi
    done <<< "$all_tasks"
    
    # Sort by score descending
    suggestions=$(echo "$suggestions" | jq 'sort_by(-.score)')
    
    # Output
    if [[ "${FORMAT:-}" == "json" ]]; then
        output_suggest_json "$task_id" "$suggestions" "$threshold"
    else
        output_suggest_text "$task_id" "$suggestions" "$threshold"
    fi
}

output_suggest_json() {
    local task_id="$1"
    local suggestions="$2"
    local threshold="$3"
    
    jq -nc \
        --arg task_id "$task_id" \
        --argjson suggestions "$suggestions" \
        --arg threshold "$threshold" \
        --arg version "$VERSION" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "version": $version,
                "command": "relates suggest",
                "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
            },
            "success": true,
            "taskId": $task_id,
            "threshold": ($threshold | tonumber),
            "count": ($suggestions | length),
            "suggestions": $suggestions
        }'
}

output_suggest_text() {
    local task_id="$1"
    local suggestions="$2"
    local threshold="$3"
    
    setup_colors
    
    local count
    count=$(echo "$suggestions" | jq 'length')
    
    echo ""
    echo -e "${BOLD}Related Task Suggestions for ${CYAN}$task_id${NC}"
    echo -e "${DIM}Threshold: $threshold${NC}"
    echo ""
    
    if [[ "$count" -eq 0 ]]; then
        echo -e "${YELLOW}No suggestions found above threshold${NC}"
        echo ""
        return
    fi
    
    echo "$suggestions" | jq -c '.[]' | while read -r suggestion; do
        local sid title status score
        sid=$(echo "$suggestion" | jq -r '.taskId')
        title=$(echo "$suggestion" | jq -r '.title')
        status=$(echo "$suggestion" | jq -r '.status')
        score=$(echo "$suggestion" | jq -r '.score')
        
        # Score visualization
        local score_bar
        local score_pct
        score_pct=$(echo "scale=0; $score * 100 / 1" | bc)
        score_bar=$(printf '%.0s█' $(seq 1 $((score_pct / 10))))
        
        echo -e "  ${BOLD}[$sid]${NC} $title"
        echo -e "     ${DIM}Status:${NC} $status  ${DIM}Score:${NC} ${GREEN}$score_bar${NC} $score_pct%"
        echo ""
    done
}

#####################################################################
# Add Subcommand
#####################################################################

cmd_add() {
    local from_id="$1"
    local to_id="$2"
    local rel_type="$3"
    local reason="${4:-}"
    
    # Validate from task exists
    if ! task_exists "$from_id"; then
        if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_NOT_FOUND" "Source task not found: $from_id" "${EXIT_NOT_FOUND:-4}" true "Verify task ID with: cleo exists $from_id"
        else
            echo -e "${RED}[ERROR]${NC} Source task not found: $from_id" >&2
        fi
        exit "${EXIT_NOT_FOUND:-4}"
    fi
    
    # Validate to task exists
    if ! task_exists "$to_id"; then
        if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_NOT_FOUND" "Target task not found: $to_id" "${EXIT_NOT_FOUND:-4}" true "Verify task ID with: cleo exists $to_id"
        else
            echo -e "${RED}[ERROR]${NC} Target task not found: $to_id" >&2
        fi
        exit "${EXIT_NOT_FOUND:-4}"
    fi
    
    # Validate relationship type
    if ! validate_rel_type "$rel_type"; then
        if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_INPUT_INVALID" "Invalid relationship type: $rel_type" "${EXIT_INVALID_INPUT:-2}" true "Valid types: $VALID_REL_TYPES"
        else
            echo -e "${RED}[ERROR]${NC} Invalid relationship type: $rel_type" >&2
            echo "Valid types: $VALID_REL_TYPES" >&2
        fi
        exit "${EXIT_INVALID_INPUT:-2}"
    fi
    
    # Check if relationship already exists
    local existing
    existing=$(jq --arg from "$from_id" --arg to "$to_id" \
        '.tasks[] | select(.id == $from) | .relates // [] | map(.taskId) | index($to) != null' \
        "$TODO_FILE" 2>/dev/null || echo "false")
    
    if [[ "$existing" == "true" ]]; then
        if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_ALREADY_EXISTS" "Relationship already exists: $from_id -> $to_id" "${EXIT_ALREADY_EXISTS:-101}" false ""
        else
            echo -e "${YELLOW}[WARN]${NC} Relationship already exists: $from_id -> $to_id" >&2
        fi
        exit "${EXIT_ALREADY_EXISTS:-101}"
    fi
    
    # Build new relates entry
    local new_entry
    if [[ -n "$reason" ]]; then
        new_entry=$(jq -nc --arg to "$to_id" --arg type "$rel_type" --arg reason "$reason" \
            '{taskId: $to, type: $type, reason: $reason}')
    else
        new_entry=$(jq -nc --arg to "$to_id" --arg type "$rel_type" \
            '{taskId: $to, type: $type}')
    fi
    
    # Update task
    local updated_json
    updated_json=$(jq --arg from "$from_id" --argjson entry "$new_entry" \
        '.tasks |= map(if .id == $from then .relates = ((.relates // []) + [$entry]) else . end)' \
        "$TODO_FILE")
    
    # Write atomically
    if declare -f atomic_write >/dev/null 2>&1; then
        echo "$updated_json" | atomic_write "$TODO_FILE"
    else
        echo "$updated_json" > "$TODO_FILE"
    fi
    
    # Output
    if [[ "${FORMAT:-}" == "json" ]]; then
        output_add_json "$from_id" "$to_id" "$rel_type" "$reason"
    else
        output_add_text "$from_id" "$to_id" "$rel_type" "$reason"
    fi
}

output_add_json() {
    local from_id="$1"
    local to_id="$2"
    local rel_type="$3"
    local reason="$4"
    
    jq -nc \
        --arg from "$from_id" \
        --arg to "$to_id" \
        --arg type "$rel_type" \
        --arg reason "$reason" \
        --arg version "$VERSION" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "version": $version,
                "command": "relates add",
                "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
            },
            "success": true,
            "message": "Relationship added successfully",
            "relationship": {
                "from": $from,
                "to": $to,
                "type": $type,
                "reason": (if $reason == "" then null else $reason end)
            }
        }'
}

output_add_text() {
    local from_id="$1"
    local to_id="$2"
    local rel_type="$3"
    local reason="$4"
    
    setup_colors
    
    echo ""
    echo -e "${GREEN}[SUCCESS]${NC} Added relationship: ${BOLD}$from_id${NC} ${CYAN}$rel_type${NC} ${BOLD}$to_id${NC}"
    if [[ -n "$reason" ]]; then
        echo -e "  ${DIM}Reason: $reason${NC}"
    fi
    echo ""
}

#####################################################################
# Discover Subcommand
#####################################################################

discover_by_labels() {
    local task_id="$1"
    local source_task
    source_task=$(get_task "$task_id")
    
    local source_labels
    source_labels=$(echo "$source_task" | jq -r '.labels // []')
    
    if [[ "$source_labels" == "[]" ]]; then
        echo "[]"
        return
    fi
    
    # Find tasks with overlapping labels
    jq --arg id "$task_id" --argjson labels "$source_labels" \
        '[.tasks[] | select(.id != $id) | 
         select((.labels // []) as $tl | ($labels | map(. as $l | $tl | index($l) != null) | any)) |
         {taskId: .id, title: .title, status: .status, method: "labels", 
          matchedLabels: [(.labels // [])[] | select(. as $l | $labels | index($l) != null)]}]' \
        "$TODO_FILE"
}

discover_by_description() {
    local task_id="$1"
    local source_task
    source_task=$(get_task "$task_id")
    
    local source_title source_desc
    source_title=$(echo "$source_task" | jq -r '.title // ""')
    source_desc=$(echo "$source_task" | jq -r '.description // ""')
    
    # Extract significant words (3+ chars, alphanumeric)
    local words
    words=$(echo "$source_title $source_desc" | tr '[:upper:]' '[:lower:]' | \
        grep -oE '[a-z0-9]{3,}' | sort -u | tr '\n' '|' | sed 's/|$//')
    
    if [[ -z "$words" ]]; then
        echo "[]"
        return
    fi
    
    # Find tasks with matching words in title/description
    jq --arg id "$task_id" --arg pattern "$words" \
        '[.tasks[] | select(.id != $id) |
         select(((.title // "") + " " + (.description // "")) | test($pattern; "i")) |
         {taskId: .id, title: .title, status: .status, method: "description"}]' \
        "$TODO_FILE" 2>/dev/null || echo "[]"
}

discover_by_files() {
    local task_id="$1"
    local source_task
    source_task=$(get_task "$task_id")
    
    local source_files
    source_files=$(echo "$source_task" | jq -r '.files // []')
    
    if [[ "$source_files" == "[]" ]]; then
        echo "[]"
        return
    fi
    
    # Find tasks with overlapping files
    jq --arg id "$task_id" --argjson files "$source_files" \
        '[.tasks[] | select(.id != $id) | 
         select((.files // []) as $tf | ($files | map(. as $f | $tf | index($f) != null) | any)) |
         {taskId: .id, title: .title, status: .status, method: "files",
          matchedFiles: [(.files // [])[] | select(. as $f | $files | index($f) != null)]}]' \
        "$TODO_FILE" 2>/dev/null || echo "[]"
}

cmd_discover() {
    local task_id="$1"
    local method="$2"
    
    # Validate task exists
    if ! task_exists "$task_id"; then
        if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_NOT_FOUND" "Task not found: $task_id" "${EXIT_NOT_FOUND:-4}" true "Verify task ID with: cleo exists $task_id"
        else
            echo -e "${RED}[ERROR]${NC} Task not found: $task_id" >&2
        fi
        exit "${EXIT_NOT_FOUND:-4}"
    fi
    
    local results="[]"
    
    case "$method" in
        labels)
            results=$(discover_by_labels "$task_id")
            ;;
        description)
            results=$(discover_by_description "$task_id")
            ;;
        files)
            results=$(discover_by_files "$task_id")
            ;;
        auto)
            # Combine all methods and deduplicate
            local labels_result desc_result files_result
            labels_result=$(discover_by_labels "$task_id")
            desc_result=$(discover_by_description "$task_id")
            files_result=$(discover_by_files "$task_id")
            
            results=$(jq -n \
                --argjson l "$labels_result" \
                --argjson d "$desc_result" \
                --argjson f "$files_result" \
                '($l + $d + $f) | group_by(.taskId) | map(.[0] + {methods: [.[].method] | unique})')
            ;;
        *)
            if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                output_error "E_INPUT_INVALID" "Invalid method: $method" "${EXIT_INVALID_INPUT:-2}" true "Valid methods: labels, description, files, auto"
            else
                echo -e "${RED}[ERROR]${NC} Invalid method: $method" >&2
            fi
            exit "${EXIT_INVALID_INPUT:-2}"
            ;;
    esac
    
    # Filter out already related tasks
    local source_relates
    source_relates=$(get_task "$task_id" | jq '.relates // [] | map(.taskId)')
    results=$(echo "$results" | jq --argjson existing "$source_relates" \
        '[.[] | select(.taskId as $id | $existing | index($id) | not)]')
    
    # Output
    if [[ "${FORMAT:-}" == "json" ]]; then
        output_discover_json "$task_id" "$results" "$method"
    else
        output_discover_text "$task_id" "$results" "$method"
    fi
}

output_discover_json() {
    local task_id="$1"
    local results="$2"
    local method="$3"
    
    jq -nc \
        --arg task_id "$task_id" \
        --argjson results "$results" \
        --arg method "$method" \
        --arg version "$VERSION" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "version": $version,
                "command": "relates discover",
                "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
            },
            "success": true,
            "taskId": $task_id,
            "method": $method,
            "count": ($results | length),
            "discovered": $results
        }'
}

output_discover_text() {
    local task_id="$1"
    local results="$2"
    local method="$3"
    
    setup_colors
    
    local count
    count=$(echo "$results" | jq 'length')
    
    echo ""
    echo -e "${BOLD}Discovered Related Tasks for ${CYAN}$task_id${NC}"
    echo -e "${DIM}Method: $method${NC}"
    echo ""
    
    if [[ "$count" -eq 0 ]]; then
        echo -e "${YELLOW}No related tasks discovered${NC}"
        echo ""
        return
    fi
    
    echo "$results" | jq -c '.[]' | while read -r result; do
        local rid title status method_used
        rid=$(echo "$result" | jq -r '.taskId')
        title=$(echo "$result" | jq -r '.title')
        status=$(echo "$result" | jq -r '.status')
        method_used=$(echo "$result" | jq -r '.method // (.methods | join(", "))')
        
        echo -e "  ${BOLD}[$rid]${NC} $title"
        echo -e "     ${DIM}Status:${NC} $status  ${DIM}Via:${NC} ${MAGENTA}$method_used${NC}"
        
        # Show matched labels/files if available
        local matched_labels matched_files
        matched_labels=$(echo "$result" | jq -r '.matchedLabels // [] | join(", ")')
        matched_files=$(echo "$result" | jq -r '.matchedFiles // [] | join(", ")')
        
        [[ -n "$matched_labels" ]] && echo -e "     ${DIM}Labels:${NC} $matched_labels"
        [[ -n "$matched_files" ]] && echo -e "     ${DIM}Files:${NC} $matched_files"
        echo ""
    done
}

#####################################################################
# List Subcommand
#####################################################################

cmd_list() {
    local task_id="$1"
    
    # Validate task exists
    if ! task_exists "$task_id"; then
        if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_NOT_FOUND" "Task not found: $task_id" "${EXIT_NOT_FOUND:-4}" true "Verify task ID with: cleo exists $task_id"
        else
            echo -e "${RED}[ERROR]${NC} Task not found: $task_id" >&2
        fi
        exit "${EXIT_NOT_FOUND:-4}"
    fi
    
    # Get task's relates array
    local task relates
    task=$(get_task "$task_id")
    relates=$(echo "$task" | jq '.relates // []')
    
    # Enrich with task titles using jq directly (avoid shell loop issues)
    local enriched
    enriched=$(jq -nc --argjson relates "$relates" --slurpfile todo "$TODO_FILE" '
        [$relates[] | . as $entry | {
            taskId: .taskId,
            type: .type,
            reason: (.reason // null),
            title: (($todo[0].tasks[] | select(.id == $entry.taskId) | .title) // "[Task not found]"),
            status: (($todo[0].tasks[] | select(.id == $entry.taskId) | .status) // "unknown")
        }]
    ')
    
    # Output
    if [[ "${FORMAT:-}" == "json" ]]; then
        output_list_json "$task_id" "$enriched"
    else
        output_list_text "$task_id" "$enriched"
    fi
}

output_list_json() {
    local task_id="$1"
    local relates="$2"
    
    jq -nc \
        --arg task_id "$task_id" \
        --argjson relates "$relates" \
        --arg version "$VERSION" \
        '{
            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
            "_meta": {
                "format": "json",
                "version": $version,
                "command": "relates list",
                "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
            },
            "success": true,
            "taskId": $task_id,
            "count": ($relates | length),
            "relates": $relates
        }'
}

output_list_text() {
    local task_id="$1"
    local relates="$2"
    
    setup_colors
    
    local count
    count=$(echo "$relates" | jq 'length')
    
    echo ""
    echo -e "${BOLD}Relationships for ${CYAN}$task_id${NC}"
    echo ""
    
    if [[ "$count" -eq 0 ]]; then
        echo -e "${DIM}No relationships defined${NC}"
        echo ""
        return
    fi
    
    echo "$relates" | jq -c '.[]' | while read -r rel; do
        local rid title status rel_type reason
        rid=$(echo "$rel" | jq -r '.taskId')
        title=$(echo "$rel" | jq -r '.title')
        status=$(echo "$rel" | jq -r '.status')
        rel_type=$(echo "$rel" | jq -r '.type')
        reason=$(echo "$rel" | jq -r '.reason // ""')
        
        # Type icon
        local type_icon
        case "$rel_type" in
            relates-to)     type_icon="~" ;;
            spawned-from)   type_icon="<" ;;
            deferred-to)    type_icon=">" ;;
            supersedes)     type_icon="^" ;;
            duplicates)     type_icon="=" ;;
            *)              type_icon="?" ;;
        esac
        
        echo -e "  ${MAGENTA}$type_icon${NC} ${CYAN}$rel_type${NC} ${BOLD}[$rid]${NC} $title"
        echo -e "     ${DIM}Status: $status${NC}"
        [[ -n "$reason" ]] && echo -e "     ${DIM}Reason: $reason${NC}"
        echo ""
    done
}

#####################################################################
# Argument Parsing
#####################################################################

# Parse common flags first if available
if declare -f parse_common_flags >/dev/null 2>&1; then
    parse_common_flags "$@"
    set -- "${REMAINING_ARGS[@]}"
    
    # Bridge to legacy variables
    if declare -f apply_flags_to_globals >/dev/null 2>&1; then
        apply_flags_to_globals
    fi
fi

# Handle help flag
if [[ "${FLAG_HELP:-false}" == true ]]; then
    usage
fi

# Parse command-specific arguments (common flags already handled by parse_common_flags)
while [[ $# -gt 0 ]]; do
    case $1 in
        suggest|add|discover|list)
            SUBCOMMAND="$1"
            shift
            ;;
        --threshold)
            THRESHOLD="${2:-0.5}"
            shift 2
            ;;
        --method)
            DISCOVER_METHOD="${2:-auto}"
            shift 2
            ;;
        -*)
            if [[ "${FORMAT:-}" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                output_error "E_INPUT_INVALID" "Unknown option: $1" "${EXIT_INVALID_INPUT:-2}" true "Run 'cleo relates --help' for usage"
            else
                echo -e "${RED:-}[ERROR]${NC:-} Unknown option: $1" >&2
            fi
            exit "${EXIT_INVALID_INPUT:-2}"
            ;;
        *)
            # Positional arguments based on subcommand
            if [[ -z "$TASK_ID" ]]; then
                TASK_ID="$1"
            elif [[ -z "$TARGET_ID" ]]; then
                TARGET_ID="$1"
            elif [[ -z "$REL_TYPE" ]]; then
                REL_TYPE="$1"
            elif [[ -z "$REASON" ]]; then
                REASON="$1"
            fi
            shift
            ;;
    esac
done

# Resolve format with TTY-aware detection (uses FLAG_FORMAT from parse_common_flags)
FORMAT=$(resolve_format "${FLAG_FORMAT:-}" "true" "human,text,json")
# Normalize "human" to "text" for backward compatibility
[[ "$FORMAT" == "human" ]] && FORMAT="text"

#####################################################################
# Main Execution
#####################################################################

# Check todo file exists
if [[ ! -f "$TODO_FILE" ]]; then
    if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
        output_error "E_NOT_INITIALIZED" "Todo file not found: $TODO_FILE" "${EXIT_NOT_INITIALIZED:-3}" true "Run 'cleo init' to initialize"
    else
        echo "[ERROR] Todo file not found: $TODO_FILE" >&2
    fi
    exit "${EXIT_NOT_INITIALIZED:-3}"
fi

# Handle help as subcommand
if [[ "$SUBCOMMAND" == "help" || -z "$SUBCOMMAND" ]]; then
    usage
fi

# Execute subcommand
case "$SUBCOMMAND" in
    suggest)
        if [[ -z "$TASK_ID" ]]; then
            if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                output_error "E_INPUT_MISSING" "Task ID required" "${EXIT_INVALID_INPUT:-2}" true "Usage: cleo relates suggest <task-id>"
            else
                echo "[ERROR] Task ID required" >&2
            fi
            exit "${EXIT_INVALID_INPUT:-2}"
        fi
        cmd_suggest "$TASK_ID" "$THRESHOLD"
        ;;
    add)
        if [[ -z "$TASK_ID" || -z "$TARGET_ID" || -z "$REL_TYPE" ]]; then
            if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                output_error "E_INPUT_MISSING" "Required: from-task, to-task, type" "${EXIT_INVALID_INPUT:-2}" true "Usage: cleo relates add <from> <to> <type> [reason]"
            else
                echo "[ERROR] Required: from-task, to-task, type" >&2
            fi
            exit "${EXIT_INVALID_INPUT:-2}"
        fi
        cmd_add "$TASK_ID" "$TARGET_ID" "$REL_TYPE" "$REASON"
        ;;
    discover)
        if [[ -z "$TASK_ID" ]]; then
            if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                output_error "E_INPUT_MISSING" "Task ID required" "${EXIT_INVALID_INPUT:-2}" true "Usage: cleo relates discover <task-id>"
            else
                echo "[ERROR] Task ID required" >&2
            fi
            exit "${EXIT_INVALID_INPUT:-2}"
        fi
        cmd_discover "$TASK_ID" "$DISCOVER_METHOD"
        ;;
    list)
        if [[ -z "$TASK_ID" ]]; then
            if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
                output_error "E_INPUT_MISSING" "Task ID required" "${EXIT_INVALID_INPUT:-2}" true "Usage: cleo relates list <task-id>"
            else
                echo "[ERROR] Task ID required" >&2
            fi
            exit "${EXIT_INVALID_INPUT:-2}"
        fi
        cmd_list "$TASK_ID"
        ;;
    *)
        if [[ "$FORMAT" == "json" ]] && declare -f output_error >/dev/null 2>&1; then
            output_error "E_INPUT_INVALID" "Unknown subcommand: $SUBCOMMAND" "${EXIT_INVALID_INPUT:-2}" true "Valid subcommands: suggest, add, discover, list"
        else
            echo "[ERROR] Unknown subcommand: $SUBCOMMAND" >&2
        fi
        exit "${EXIT_INVALID_INPUT:-2}"
        ;;
esac

exit "${EXIT_SUCCESS:-0}"
