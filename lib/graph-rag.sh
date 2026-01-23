#!/usr/bin/env bash
# graph-rag.sh - Semantic relationship discovery for CLEO
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: file-ops.sh, config.sh
# PROVIDES: discover_related_tasks, suggest_relates, add_relates_entry,
#           _discover_by_labels, _discover_by_description, _discover_by_files
#
# Enables RAG-like task connections via the 'relates' field through
# semantic similarity discovery based on shared attributes.

#=== SOURCE GUARD ================================================
[[ -n "${_GRAPH_RAG_LOADED:-}" ]] && return 0
declare -r _GRAPH_RAG_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_GRAPH_RAG_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source file-ops for atomic updates (Layer 2)
if [[ -f "$_GRAPH_RAG_LIB_DIR/file-ops.sh" ]]; then
    # shellcheck source=lib/file-ops.sh
    source "$_GRAPH_RAG_LIB_DIR/file-ops.sh"
else
    echo "ERROR: Cannot find file-ops.sh in $_GRAPH_RAG_LIB_DIR" >&2
    exit 1
fi

# Source config for settings (Layer 2) - optional
if [[ -f "$_GRAPH_RAG_LIB_DIR/config.sh" ]]; then
    # shellcheck source=lib/config.sh
    source "$_GRAPH_RAG_LIB_DIR/config.sh"
fi

# Source exit codes if not already loaded
if [[ -f "$_GRAPH_RAG_LIB_DIR/exit-codes.sh" ]]; then
    # shellcheck source=lib/exit-codes.sh
    source "$_GRAPH_RAG_LIB_DIR/exit-codes.sh"
fi

# ============================================================================
# CONFIGURATION
# ============================================================================

# Default todo file location
GRAPH_RAG_TODO_FILE="${TODO_FILE:-.cleo/todo.json}"

# Valid relationship types per schema
declare -a VALID_RELATES_TYPES=(
    "relates-to"
    "spawned-from"
    "deferred-to"
    "supersedes"
    "duplicates"
)

# Common stopwords for description similarity
declare -a STOPWORDS=(
    "a" "an" "the" "and" "or" "but" "in" "on" "at" "to" "for"
    "of" "with" "by" "from" "as" "is" "was" "are" "were" "be"
    "been" "being" "have" "has" "had" "do" "does" "did" "will"
    "would" "could" "should" "may" "might" "must" "shall" "can"
    "this" "that" "these" "those" "i" "you" "he" "she" "it" "we"
    "they" "what" "which" "who" "when" "where" "why" "how" "all"
    "each" "every" "both" "few" "more" "most" "other" "some" "such"
    "no" "nor" "not" "only" "own" "same" "so" "than" "too" "very"
    "just" "also" "now" "then" "here" "there" "if" "else" "any"
)

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

#######################################
# Check if a value is in an array
# Arguments:
#   $1 - Value to search for
#   $@ - Array elements (remaining arguments)
# Returns:
#   0 if found, 1 if not found
#######################################
_graph_rag_in_array() {
    local needle="$1"
    shift
    local item
    for item in "$@"; do
        [[ "$item" == "$needle" ]] && return 0
    done
    return 1
}

#######################################
# Validate task ID format
# Arguments:
#   $1 - Task ID to validate
# Returns:
#   0 if valid, 1 if invalid
#######################################
_graph_rag_valid_task_id() {
    local task_id="$1"
    [[ "$task_id" =~ ^T[0-9]{3,}$ ]]
}

#######################################
# Check if task exists in todo.json
# Arguments:
#   $1 - Task ID
# Returns:
#   0 if exists, 1 if not
#######################################
_graph_rag_task_exists() {
    local task_id="$1"
    local todo_file="${GRAPH_RAG_TODO_FILE}"
    
    if [[ ! -f "$todo_file" ]]; then
        return 1
    fi
    
    local count
    count=$(jq --arg id "$task_id" '[.tasks[] | select(.id == $id)] | length' "$todo_file" 2>/dev/null)
    [[ "$count" -gt 0 ]]
}

#######################################
# Get task by ID
# Arguments:
#   $1 - Task ID
# Outputs:
#   Task JSON object to stdout
# Returns:
#   0 on success, 1 if not found
#######################################
_graph_rag_get_task() {
    local task_id="$1"
    local todo_file="${GRAPH_RAG_TODO_FILE}"
    
    if [[ ! -f "$todo_file" ]]; then
        echo "null"
        return 1
    fi
    
    local task
    task=$(jq --arg id "$task_id" '.tasks[] | select(.id == $id)' "$todo_file" 2>/dev/null)
    
    if [[ -z "$task" || "$task" == "null" ]]; then
        echo "null"
        return 1
    fi
    
    echo "$task"
    return 0
}

#######################################
# Tokenize text for similarity comparison
# Converts to lowercase, removes punctuation, splits on whitespace
# Arguments:
#   $1 - Text to tokenize
# Outputs:
#   Space-separated list of tokens (one per line, sorted unique)
#######################################
_graph_rag_tokenize() {
    local text="$1"
    
    # Convert to lowercase, remove punctuation, split on whitespace
    echo "$text" | \
        tr '[:upper:]' '[:lower:]' | \
        tr -cs '[:alnum:]' ' ' | \
        tr ' ' '\n' | \
        grep -v '^$' | \
        sort -u
}

#######################################
# Remove stopwords from token list
# Arguments:
#   $1 - Newline-separated tokens
# Outputs:
#   Filtered tokens without stopwords
#######################################
_graph_rag_remove_stopwords() {
    local tokens="$1"
    local token
    local result=""
    
    while IFS= read -r token; do
        [[ -z "$token" ]] && continue
        if ! _graph_rag_in_array "$token" "${STOPWORDS[@]}"; then
            result+="$token"$'\n'
        fi
    done <<< "$tokens"
    
    echo -n "$result"
}

#######################################
# Calculate Jaccard similarity between two sets
# Arguments:
#   $1 - First set (newline-separated)
#   $2 - Second set (newline-separated)
# Outputs:
#   Similarity score (0.0 to 1.0)
#######################################
_graph_rag_jaccard_similarity() {
    local set1="$1"
    local set2="$2"
    
    # Handle empty sets
    if [[ -z "$set1" && -z "$set2" ]]; then
        echo "0.00"
        return
    fi
    
    # Get unique items from each set
    local items1 items2
    items1=$(echo "$set1" | sort -u | grep -v '^$' || true)
    items2=$(echo "$set2" | sort -u | grep -v '^$' || true)
    
    # Handle single empty set
    if [[ -z "$items1" || -z "$items2" ]]; then
        echo "0.00"
        return
    fi
    
    # Calculate intersection
    local intersection
    intersection=$(comm -12 <(echo "$items1") <(echo "$items2") | wc -l | tr -d ' ')
    
    # Calculate union
    local union
    union=$(echo -e "${items1}\n${items2}" | sort -u | grep -v '^$' | wc -l | tr -d ' ')
    
    # Calculate Jaccard similarity
    if [[ "$union" -eq 0 ]]; then
        echo "0.00"
    else
        # Use awk for floating point division
        awk -v i="$intersection" -v u="$union" 'BEGIN { printf "%.2f", i/u }'
    fi
}

# ============================================================================
# DISCOVERY FUNCTIONS
# ============================================================================

#######################################
# Discover related tasks by shared labels
# Arguments:
#   $1 - Task ID to find relations for
# Outputs:
#   JSON array of {taskId, type, reason, score}
# Returns:
#   0 on success, 1 on error
#######################################
_discover_by_labels() {
    local task_id="$1"
    local todo_file="${GRAPH_RAG_TODO_FILE}"
    
    if ! _graph_rag_valid_task_id "$task_id"; then
        echo '{"error": "Invalid task ID format"}' >&2
        return 1
    fi
    
    if [[ ! -f "$todo_file" ]]; then
        echo '[]'
        return 0
    fi
    
    # Get the source task's labels
    local source_labels
    source_labels=$(jq -r --arg id "$task_id" '
        .tasks[] | select(.id == $id) | 
        if (.labels | type) == "array" then .labels[] else empty end
    ' "$todo_file" 2>/dev/null)
    
    if [[ -z "$source_labels" ]]; then
        echo '[]'
        return 0
    fi
    
    # Convert to JSON array
    local source_labels_json
    source_labels_json=$(jq -R -s -c 'split("\n") | map(select(length > 0))' <<< "$source_labels")
    
    # Find tasks with overlapping labels and calculate scores
    # Note: Check that labels is an array type to handle labels: false
    jq --arg id "$task_id" --argjson source_labels "$source_labels_json" '
        .tasks 
        | map(select(.id != $id and ((.labels | type) == "array") and (.labels | length > 0)))
        | map(
            . as $task |
            ($task.labels) as $task_labels |
            ($source_labels | map(select(. as $l | $task_labels | index($l))) | length) as $shared |
            (($source_labels + $task_labels) | unique | length) as $total |
            select($shared > 0) |
            {
                taskId: $task.id,
                type: "relates-to",
                reason: "\($shared) shared label(s): \([$source_labels[] | select(. as $l | $task_labels | index($l))] | join(", "))",
                score: (if $total > 0 then ($shared / $total) else 0 end)
            }
        )
        | sort_by(-.score)
    ' "$todo_file" 2>/dev/null || echo '[]'
}

#######################################
# Discover related tasks by description similarity
# Uses keyword-based Jaccard similarity (no ML)
# Arguments:
#   $1 - Task ID to find relations for
# Outputs:
#   JSON array of {taskId, type, reason, score}
# Returns:
#   0 on success, 1 on error
#######################################
_discover_by_description() {
    local task_id="$1"
    local todo_file="${GRAPH_RAG_TODO_FILE}"
    
    if ! _graph_rag_valid_task_id "$task_id"; then
        echo '{"error": "Invalid task ID format"}' >&2
        return 1
    fi
    
    if [[ ! -f "$todo_file" ]]; then
        echo '[]'
        return 0
    fi
    
    # Get source task's title and description
    local source_text
    source_text=$(jq -r --arg id "$task_id" '
        .tasks[] | select(.id == $id) | 
        "\(.title // "") \(.description // "")"
    ' "$todo_file" 2>/dev/null)
    
    if [[ -z "$source_text" ]]; then
        echo '[]'
        return 0
    fi
    
    # Tokenize and remove stopwords from source
    local source_tokens
    source_tokens=$(_graph_rag_tokenize "$source_text")
    source_tokens=$(_graph_rag_remove_stopwords "$source_tokens")
    
    if [[ -z "$source_tokens" ]]; then
        echo '[]'
        return 0
    fi
    
    # Get all other tasks
    local other_tasks
    other_tasks=$(jq -c --arg id "$task_id" '
        .tasks[] | select(.id != $id) | {id: .id, text: "\(.title // "") \(.description // "")"}
    ' "$todo_file" 2>/dev/null)
    
    if [[ -z "$other_tasks" ]]; then
        echo '[]'
        return 0
    fi
    
    # Calculate similarity for each task
    local results="[]"
    while IFS= read -r task_json; do
        [[ -z "$task_json" ]] && continue
        
        local other_id other_text
        other_id=$(echo "$task_json" | jq -r '.id')
        other_text=$(echo "$task_json" | jq -r '.text')
        
        # Tokenize and remove stopwords
        local other_tokens
        other_tokens=$(_graph_rag_tokenize "$other_text")
        other_tokens=$(_graph_rag_remove_stopwords "$other_tokens")
        
        [[ -z "$other_tokens" ]] && continue
        
        # Calculate Jaccard similarity
        local score
        score=$(_graph_rag_jaccard_similarity "$source_tokens" "$other_tokens")
        
        # Only include if score > 0
        if [[ $(awk -v s="$score" 'BEGIN { print (s > 0) ? 1 : 0 }') -eq 1 ]]; then
            # Count shared words for reason
            local shared_count
            shared_count=$(comm -12 <(echo "$source_tokens" | sort -u) <(echo "$other_tokens" | sort -u) | wc -l | tr -d ' ')
            
            results=$(echo "$results" | jq --arg tid "$other_id" --arg score "$score" --arg shared "$shared_count" '
                . + [{
                    taskId: $tid,
                    type: "relates-to",
                    reason: "\($shared) shared keyword(s)",
                    score: ($score | tonumber)
                }]
            ')
        fi
    done <<< "$other_tasks"
    
    # Sort by score descending
    echo "$results" | jq 'sort_by(-.score)'
}

#######################################
# Discover related tasks by shared files
# Arguments:
#   $1 - Task ID to find relations for
# Outputs:
#   JSON array of {taskId, type, reason, score}
# Returns:
#   0 on success, 1 on error
#######################################
_discover_by_files() {
    local task_id="$1"
    local todo_file="${GRAPH_RAG_TODO_FILE}"
    
    if ! _graph_rag_valid_task_id "$task_id"; then
        echo '{"error": "Invalid task ID format"}' >&2
        return 1
    fi
    
    if [[ ! -f "$todo_file" ]]; then
        echo '[]'
        return 0
    fi
    
    # Get the source task's files
    local source_files
    source_files=$(jq -r --arg id "$task_id" '
        .tasks[] | select(.id == $id) | 
        if (.files | type) == "array" then .files[] else empty end
    ' "$todo_file" 2>/dev/null)
    
    if [[ -z "$source_files" ]]; then
        echo '[]'
        return 0
    fi
    
    # Convert to JSON array
    local source_files_json
    source_files_json=$(jq -R -s -c 'split("\n") | map(select(length > 0))' <<< "$source_files")
    
    # Find tasks with overlapping files and calculate scores
    # Note: Check that files is an array type to handle files: false or null
    jq --arg id "$task_id" --argjson source_files "$source_files_json" '
        .tasks 
        | map(select(.id != $id and ((.files | type) == "array") and (.files | length > 0)))
        | map(
            . as $task |
            ($task.files) as $task_files |
            ($source_files | map(select(. as $f | $task_files | index($f))) | length) as $shared |
            (($source_files + $task_files) | unique | length) as $total |
            select($shared > 0) |
            {
                taskId: $task.id,
                type: "relates-to",
                reason: "\($shared) shared file(s): \([$source_files[] | select(. as $f | $task_files | index($f))] | .[0:3] | join(", "))\(if $shared > 3 then "..." else "" end)",
                score: (if $total > 0 then ($shared / $total) else 0 end)
            }
        )
        | sort_by(-.score)
    ' "$todo_file" 2>/dev/null || echo '[]'
}

# ============================================================================
# PUBLIC API FUNCTIONS
# ============================================================================

#######################################
# Discover related tasks based on shared attributes
# Arguments:
#   $1 - Task ID to find relations for
#   $2 - Discovery method: labels, description, files, auto (default: auto)
# Outputs:
#   JSON array of {taskId, type, reason, score}
# Returns:
#   0 on success, 1 on error
#######################################
discover_related_tasks() {
    local task_id="${1:-}"
    local method="${2:-auto}"
    
    if [[ -z "$task_id" ]]; then
        echo '{"error": "Task ID required"}' >&2
        return 1
    fi
    
    if ! _graph_rag_valid_task_id "$task_id"; then
        echo '{"error": "Invalid task ID format"}' >&2
        return 1
    fi
    
    if ! _graph_rag_task_exists "$task_id"; then
        echo '{"error": "Task not found"}' >&2
        return 1
    fi
    
    case "$method" in
        labels)
            _discover_by_labels "$task_id"
            ;;
        description)
            _discover_by_description "$task_id"
            ;;
        files)
            _discover_by_files "$task_id"
            ;;
        auto|all)
            # Combine all discovery methods and deduplicate
            local labels_result description_result files_result
            labels_result=$(_discover_by_labels "$task_id")
            description_result=$(_discover_by_description "$task_id")
            files_result=$(_discover_by_files "$task_id")
            
            # Merge results, keeping highest score per task
            echo "$labels_result" "$description_result" "$files_result" | \
                jq -s 'add | group_by(.taskId) | map(max_by(.score)) | sort_by(-.score)'
            ;;
        *)
            echo '{"error": "Invalid method. Use: labels, description, files, auto"}' >&2
            return 1
            ;;
    esac
}

#######################################
# Suggest relates entries for a task
# Arguments:
#   $1 - Task ID to get suggestions for
#   $2 - Minimum similarity threshold (0.0-1.0, default: 0.5)
# Outputs:
#   JSON array of suggestions filtered by threshold
# Returns:
#   0 on success, 1 on error
#######################################
suggest_relates() {
    local task_id="${1:-}"
    local threshold="${2:-0.5}"
    
    if [[ -z "$task_id" ]]; then
        echo '{"error": "Task ID required"}' >&2
        return 1
    fi
    
    if ! _graph_rag_valid_task_id "$task_id"; then
        echo '{"error": "Invalid task ID format"}' >&2
        return 1
    fi
    
    # Validate threshold is a number between 0 and 1
    if ! awk -v t="$threshold" 'BEGIN { exit (t >= 0 && t <= 1) ? 0 : 1 }' 2>/dev/null; then
        echo '{"error": "Threshold must be between 0.0 and 1.0"}' >&2
        return 1
    fi
    
    # Get all related tasks using auto method
    local all_related
    all_related=$(discover_related_tasks "$task_id" "auto")
    
    if [[ "$all_related" == "[]" || -z "$all_related" ]]; then
        echo '[]'
        return 0
    fi
    
    # Filter by threshold and exclude already-related tasks
    local todo_file="${GRAPH_RAG_TODO_FILE}"
    local existing_relates
    existing_relates=$(jq -r --arg id "$task_id" '
        .tasks[] | select(.id == $id) | .relates // [] | .[].taskId
    ' "$todo_file" 2>/dev/null)
    
    # Build exclusion list
    local exclusion_json
    if [[ -n "$existing_relates" ]]; then
        exclusion_json=$(echo "$existing_relates" | jq -R -s -c 'split("\n") | map(select(length > 0))')
    else
        exclusion_json='[]'
    fi
    
    # Filter results
    echo "$all_related" | jq --arg threshold "$threshold" --argjson exclude "$exclusion_json" '
        map(select(
            .score >= ($threshold | tonumber) and
            (.taskId as $tid | $exclude | index($tid) | not)
        ))
    '
}

#######################################
# Add a relates entry to a task
# Arguments:
#   $1 - Source task ID (from)
#   $2 - Target task ID (to)
#   $3 - Relationship type
#   $4 - Reason/description (optional)
# Returns:
#   0 on success, 1 on error
# Outputs:
#   JSON result object
#######################################
add_relates_entry() {
    local from_task="${1:-}"
    local to_task="${2:-}"
    local rel_type="${3:-}"
    local reason="${4:-}"
    local todo_file="${GRAPH_RAG_TODO_FILE}"
    
    # Validate arguments
    if [[ -z "$from_task" || -z "$to_task" || -z "$rel_type" ]]; then
        echo '{"success": false, "error": "Required: from_task, to_task, type"}' >&2
        return 1
    fi
    
    if ! _graph_rag_valid_task_id "$from_task"; then
        echo '{"success": false, "error": "Invalid from_task ID format"}' >&2
        return 1
    fi
    
    if ! _graph_rag_valid_task_id "$to_task"; then
        echo '{"success": false, "error": "Invalid to_task ID format"}' >&2
        return 1
    fi
    
    if [[ "$from_task" == "$to_task" ]]; then
        echo '{"success": false, "error": "Cannot relate task to itself"}' >&2
        return 1
    fi
    
    # Validate relationship type
    if ! _graph_rag_in_array "$rel_type" "${VALID_RELATES_TYPES[@]}"; then
        echo "{\"success\": false, \"error\": \"Invalid type. Use: ${VALID_RELATES_TYPES[*]}\"}" >&2
        return 1
    fi
    
    # Validate both tasks exist
    if ! _graph_rag_task_exists "$from_task"; then
        echo '{"success": false, "error": "Source task not found"}' >&2
        return 1
    fi
    
    if ! _graph_rag_task_exists "$to_task"; then
        echo '{"success": false, "error": "Target task not found"}' >&2
        return 1
    fi
    
    # Check if relationship already exists
    local existing
    existing=$(jq --arg from "$from_task" --arg to "$to_task" '
        .tasks[] | select(.id == $from) | .relates // [] | 
        map(select(.taskId == $to)) | length
    ' "$todo_file" 2>/dev/null)
    
    if [[ "$existing" -gt 0 ]]; then
        echo '{"success": false, "error": "Relationship already exists"}' >&2
        return 1
    fi
    
    # Build the new relates entry
    local new_entry
    if [[ -n "$reason" ]]; then
        new_entry=$(jq -n --arg tid "$to_task" --arg type "$rel_type" --arg reason "$reason" '
            {taskId: $tid, type: $type, reason: $reason}
        ')
    else
        new_entry=$(jq -n --arg tid "$to_task" --arg type "$rel_type" '
            {taskId: $tid, type: $type}
        ')
    fi
    
    # Update the todo.json atomically
    local updated_json
    updated_json=$(jq --arg from "$from_task" --argjson entry "$new_entry" '
        .tasks = [.tasks[] | 
            if .id == $from then
                .relates = ((.relates // []) + [$entry])
            else
                .
            end
        ]
    ' "$todo_file")
    
    if [[ -z "$updated_json" ]]; then
        echo '{"success": false, "error": "Failed to update JSON"}' >&2
        return 1
    fi
    
    # Write atomically using save_json if available, otherwise fallback
    if declare -f save_json >/dev/null 2>&1; then
        if ! save_json "$todo_file" "$updated_json"; then
            echo '{"success": false, "error": "Failed to save changes"}' >&2
            return 1
        fi
    else
        # Fallback: write directly (not recommended)
        if ! echo "$updated_json" > "$todo_file"; then
            echo '{"success": false, "error": "Failed to write file"}' >&2
            return 1
        fi
    fi
    
    echo "{\"success\": true, \"from\": \"$from_task\", \"to\": \"$to_task\", \"type\": \"$rel_type\"}"
    return 0
}

# ============================================================================
# CLI INTERFACE (when run directly)
# ============================================================================

_graph_rag_main() {
    local cmd="${1:-}"
    shift || true
    
    case "$cmd" in
        discover)
            local task_id="${1:-}"
            local method="${2:-auto}"
            discover_related_tasks "$task_id" "$method"
            ;;
        suggest)
            local task_id="${1:-}"
            local threshold="${2:-0.5}"
            suggest_relates "$task_id" "$threshold"
            ;;
        add)
            local from="${1:-}"
            local to="${2:-}"
            local type="${3:-}"
            local reason="${4:-}"
            add_relates_entry "$from" "$to" "$type" "$reason"
            ;;
        help|--help|-h)
            cat <<HELP
graph-rag.sh - Semantic relationship discovery for CLEO

Usage:
  source lib/graph-rag.sh
  
Functions:
  discover_related_tasks <task_id> [method]
    Find related tasks. Methods: labels, description, files, auto (default)
    
  suggest_relates <task_id> [threshold]
    Get suggestions filtered by similarity threshold (0.0-1.0, default: 0.5)
    
  add_relates_entry <from_task> <to_task> <type> [reason]
    Add a relates entry. Types: relates-to, spawned-from, deferred-to, supersedes, duplicates

CLI:
  ./lib/graph-rag.sh discover T001 labels
  ./lib/graph-rag.sh suggest T001 0.6
  ./lib/graph-rag.sh add T001 T002 relates-to "shared auth context"
HELP
            ;;
        *)
            echo "Unknown command: $cmd" >&2
            echo "Run with 'help' for usage" >&2
            return 1
            ;;
    esac
}

# Run main if executed directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    _graph_rag_main "$@"
fi
