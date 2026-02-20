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

_GRAPH_RAG_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source file-ops for atomic updates (Layer 2)
if [[ -f "$_GRAPH_RAG_LIB_DIR/data/file-ops.sh" ]]; then
    # shellcheck source=lib/data/file-ops.sh
    source "$_GRAPH_RAG_LIB_DIR/data/file-ops.sh"
else
    echo "ERROR: Cannot find file-ops.sh in $_GRAPH_RAG_LIB_DIR" >&2
    exit 1
fi

# Source config for settings (Layer 2) - optional
if [[ -f "$_GRAPH_RAG_LIB_DIR/core/config.sh" ]]; then
    # shellcheck source=lib/core/config.sh
    source "$_GRAPH_RAG_LIB_DIR/core/config.sh"
fi

# Source exit codes if not already loaded
if [[ -f "$_GRAPH_RAG_LIB_DIR/core/exit-codes.sh" ]]; then
    # shellcheck source=lib/core/exit-codes.sh
    source "$_GRAPH_RAG_LIB_DIR/core/exit-codes.sh"
fi

# Source Nexus libraries for cross-project discovery (optional)
if [[ -f "$_GRAPH_RAG_LIB_DIR/data/nexus-registry.sh" ]]; then
    # shellcheck source=lib/data/nexus-registry.sh
    source "$_GRAPH_RAG_LIB_DIR/data/nexus-registry.sh" 2>/dev/null || true
fi

if [[ -f "$_GRAPH_RAG_LIB_DIR/data/nexus-query.sh" ]]; then
    # shellcheck source=lib/data/nexus-query.sh
    source "$_GRAPH_RAG_LIB_DIR/data/nexus-query.sh" 2>/dev/null || true
fi

if [[ -f "$_GRAPH_RAG_LIB_DIR/data/nexus-permissions.sh" ]]; then
    # shellcheck source=lib/data/nexus-permissions.sh
    source "$_GRAPH_RAG_LIB_DIR/data/nexus-permissions.sh" 2>/dev/null || true
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
# HIERARCHY DISCOVERY FUNCTIONS (T2190)
# ============================================================================

# Source hierarchy.sh for get_parent_chain (if not already loaded)
if [[ -f "$_GRAPH_RAG_LIB_DIR/tasks/hierarchy.sh" ]]; then
    # shellcheck source=lib/tasks/hierarchy.sh
    source "$_GRAPH_RAG_LIB_DIR/tasks/hierarchy.sh" 2>/dev/null || true
fi

#######################################
# Find the lowest common ancestor of two tasks
# Arguments:
#   $1 - First task ID
#   $2 - Second task ID
# Outputs:
#   LCA task ID to stdout (empty if no common ancestor)
# Returns:
#   0 if LCA found, 1 if no common ancestor
#######################################
_find_lca() {
    local task_a="$1"
    local task_b="$2"
    local todo_file="${GRAPH_RAG_TODO_FILE}"

    # Validate inputs
    if [[ -z "$task_a" || -z "$task_b" ]]; then
        echo ""
        return 1
    fi

    # Edge case: same task (LCA is self)
    if [[ "$task_a" == "$task_b" ]]; then
        if _graph_rag_task_exists "$task_a"; then
            echo "$task_a"
            return 0
        else
            echo ""
            return 1
        fi
    fi

    # Verify both tasks exist
    if ! _graph_rag_task_exists "$task_a" || ! _graph_rag_task_exists "$task_b"; then
        echo ""
        return 1
    fi

    # Build ancestor path for task_a (including self)
    local parent_chain_a=""
    if declare -f get_parent_chain >/dev/null 2>&1; then
        parent_chain_a=$(get_parent_chain "$task_a" "$todo_file")
    else
        # Fallback: inline parent chain construction
        local current="$task_a"
        while [[ -n "$current" ]]; do
            local parent
            parent=$(jq -r --arg id "$current" \
                '.tasks[] | select(.id == $id) | .parentId // empty' \
                "$todo_file" 2>/dev/null)
            [[ -z "$parent" || "$parent" == "null" ]] && break
            parent_chain_a="$parent_chain_a $parent"
            current="$parent"
        done
    fi
    local ancestors_a="$task_a $parent_chain_a"

    # Build ancestor path for task_b
    local parent_chain_b=""
    if declare -f get_parent_chain >/dev/null 2>&1; then
        parent_chain_b=$(get_parent_chain "$task_b" "$todo_file")
    else
        local current="$task_b"
        while [[ -n "$current" ]]; do
            local parent
            parent=$(jq -r --arg id "$current" \
                '.tasks[] | select(.id == $id) | .parentId // empty' \
                "$todo_file" 2>/dev/null)
            [[ -z "$parent" || "$parent" == "null" ]] && break
            parent_chain_b="$parent_chain_b $parent"
            current="$parent"
        done
    fi

    # Check if task_b itself is ancestor of task_a
    if [[ " $ancestors_a " == *" $task_b "* ]]; then
        echo "$task_b"
        return 0
    fi

    # Check each ancestor of B against ancestors_a
    for ancestor in $parent_chain_b; do
        if [[ " $ancestors_a " == *" $ancestor "* ]]; then
            echo "$ancestor"
            return 0
        fi
    done

    # No common ancestor
    echo ""
    return 1
}

#######################################
# Calculate tree distance between two tasks
# Distance = sum of edges from each task to their LCA
# Arguments:
#   $1 - First task ID
#   $2 - Second task ID
# Outputs:
#   Integer distance (0=same, 1=parent/child, 2=siblings, -1=no relation)
# Returns:
#   0 on success, 1 on error
#######################################
_tree_distance() {
    local task_a="$1"
    local task_b="$2"
    local todo_file="${GRAPH_RAG_TODO_FILE}"

    # Same task = distance 0
    if [[ "$task_a" == "$task_b" ]]; then
        echo "0"
        return 0
    fi

    # Find LCA
    local lca
    lca=$(_find_lca "$task_a" "$task_b")

    if [[ -z "$lca" ]]; then
        echo "-1"
        return 1
    fi

    # Calculate depth of task_a to LCA
    local depth_a=0
    local current="$task_a"
    while [[ "$current" != "$lca" && -n "$current" ]]; do
        current=$(jq -r --arg id "$current" \
            '.tasks[] | select(.id == $id) | .parentId // empty' \
            "$todo_file" 2>/dev/null)
        ((depth_a++)) || true
    done

    # Calculate depth of task_b to LCA
    local depth_b=0
    current="$task_b"
    while [[ "$current" != "$lca" && -n "$current" ]]; do
        current=$(jq -r --arg id "$current" \
            '.tasks[] | select(.id == $id) | .parentId // empty' \
            "$todo_file" 2>/dev/null)
        ((depth_b++)) || true
    done

    echo "$((depth_a + depth_b))"
    return 0
}

#######################################
# Get hierarchical context for a task (description + parent context with decay)
# Arguments:
#   $1 - Task ID
#   $2 - Max depth (default: 2)
# Outputs:
#   Augmented text with parent context
# Returns:
#   0 on success, 1 on error
#######################################
_get_hierarchical_context() {
    local task_id="$1"
    local max_depth="${2:-2}"
    local todo_file="${GRAPH_RAG_TODO_FILE}"

    # Get task's own description
    local context
    context=$(jq -r --arg id "$task_id" \
        '.tasks[] | select(.id == $id) | .description // .title // ""' \
        "$todo_file" 2>/dev/null)

    if [[ -z "$context" ]]; then
        echo ""
        return 1
    fi

    # Propagate parent context with decay
    local parent_id
    parent_id=$(jq -r --arg id "$task_id" \
        '.tasks[] | select(.id == $id) | .parentId // empty' \
        "$todo_file" 2>/dev/null)

    local depth=0
    # Decay weights: parent=0.5, grandparent=0.25
    local -a decay_weights=(0.5 0.25)

    while [[ -n "$parent_id" && "$parent_id" != "null" && $depth -lt $max_depth ]]; do
        local parent_desc
        parent_desc=$(jq -r --arg id "$parent_id" \
            '.tasks[] | select(.id == $id) | .description // .title // ""' \
            "$todo_file" 2>/dev/null)

        if [[ -n "$parent_desc" && "$parent_desc" != "null" ]]; then
            # Add parent context with weight marker
            context+=" [PARENT:${decay_weights[$depth]}] $parent_desc"
        fi

        # Move to next ancestor
        parent_id=$(jq -r --arg id "$parent_id" \
            '.tasks[] | select(.id == $id) | .parentId // empty' \
            "$todo_file" 2>/dev/null)
        ((depth++)) || true
    done

    echo "$context"
    return 0
}

#######################################
# Discover related tasks by hierarchical proximity
# Finds siblings (same parent) and cousins (same grandparent)
# Arguments:
#   $1 - Task ID to find relations for
# Outputs:
#   JSON array of {taskId, type, reason, score}
# Returns:
#   0 on success, 1 on error
#######################################
_discover_by_hierarchy() {
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

    # Get boost values from config (with defaults from research)
    local sibling_boost cousin_boost
    if declare -f get_config_value >/dev/null 2>&1; then
        sibling_boost=$(get_config_value "graphRag.hierarchyBoost.sibling" "0.15")
        cousin_boost=$(get_config_value "graphRag.hierarchyBoost.cousin" "0.08")
    else
        sibling_boost="0.15"
        cousin_boost="0.08"
    fi

    # Get source task's parent
    local parent_id
    parent_id=$(jq -r --arg id "$task_id" \
        '.tasks[] | select(.id == $id) | .parentId // empty' \
        "$todo_file" 2>/dev/null)

    local results="[]"

    # Find siblings (same parent, excluding self)
    if [[ -n "$parent_id" && "$parent_id" != "null" ]]; then
        local siblings_json
        siblings_json=$(jq --arg parent "$parent_id" --arg self "$task_id" \
            --arg boost "$sibling_boost" '
            [.tasks[] | select(.parentId == $parent and .id != $self) |
                {
                    taskId: .id,
                    type: "relates-to",
                    reason: "sibling (shared parent \($parent))",
                    score: ($boost | tonumber),
                    _hierarchyBoost: ($boost | tonumber),
                    _relationship: "sibling"
                }
            ]
        ' "$todo_file" 2>/dev/null)

        if [[ -n "$siblings_json" && "$siblings_json" != "[]" ]]; then
            results="$siblings_json"
        fi
    fi

    # Find cousins (same grandparent, different parent)
    local grandparent_id=""
    if [[ -n "$parent_id" && "$parent_id" != "null" ]]; then
        grandparent_id=$(jq -r --arg id "$parent_id" \
            '.tasks[] | select(.id == $id) | .parentId // empty' \
            "$todo_file" 2>/dev/null)
    fi

    if [[ -n "$grandparent_id" && "$grandparent_id" != "null" ]]; then
        # Get aunts/uncles (grandparent's other children, excluding source's parent)
        local cousins_json
        cousins_json=$(jq --arg gp "$grandparent_id" --arg parent "$parent_id" \
            --arg boost "$cousin_boost" '
            # Find aunts/uncles (siblings of source parent)
            [.tasks[] | select(.parentId == $gp and .id != $parent)] as $aunts |
            # Find cousins (children of aunts/uncles)
            [.tasks[] | select(.parentId as $pid | $aunts | map(.id) | index($pid))] |
            map({
                taskId: .id,
                type: "relates-to",
                reason: "cousin (shared grandparent \($gp))",
                score: ($boost | tonumber),
                _hierarchyBoost: ($boost | tonumber),
                _relationship: "cousin"
            })
        ' "$todo_file" 2>/dev/null)

        if [[ -n "$cousins_json" && "$cousins_json" != "[]" ]]; then
            # Merge cousins into results
            results=$(echo "$results" "$cousins_json" | jq -s 'add')
        fi
    fi

    # Sort by score descending
    echo "$results" | jq 'sort_by(-.score)'
}

# ============================================================================
# CROSS-PROJECT DISCOVERY FUNCTIONS (NEXUS - T2963)
# ============================================================================

#######################################
# Load project graph into memory (internal helper)
#
# Loads all tasks from a project's todo.json and adds project metadata.
# Checks read permissions via nexus_can_read() before loading.
#
# Arguments:
#   $1 - Project name or path (required)
#
# Returns:
#   JSON array of tasks with _project field added
#
# Exit Status:
#   0 - Success
#   1 - Invalid project, permission denied, or missing todo.json
#
# Example:
#   graph=$(_load_project_graph "my-api")
#   # Returns: [{"id":"T001","_project":"my-api",...},...]
#######################################
_load_project_graph() {
    local project="${1:-}"

    if [[ -z "$project" ]]; then
        echo "[]"
        return 1
    fi

    # Check if Nexus functions are available
    if ! declare -f nexus_get_project >/dev/null 2>&1; then
        echo "[]"
        return 1
    fi

    # Resolve project name to path
    local project_data
    project_data=$(nexus_get_project "$project")

    if [[ "$project_data" == "{}" ]]; then
        echo "[]"
        return 1
    fi

    local project_path project_name
    project_path=$(echo "$project_data" | jq -r '.path')
    project_name=$(echo "$project_data" | jq -r '.name')

    # Check read permission
    if declare -f nexus_can_read >/dev/null 2>&1; then
        if ! nexus_can_read "$project_name"; then
            echo "[]"
            return 1
        fi
    fi

    # Load todo.json
    local todo_file="${project_path}/.cleo/todo.json"
    if [[ ! -f "$todo_file" ]]; then
        echo "[]"
        return 1
    fi

    # Add _project field to each task
    jq --arg project "$project_name" \
        '.tasks | map(. + {_project: $project})' \
        "$todo_file" 2>/dev/null || echo "[]"
}

#######################################
# Merge graphs from all readable projects (internal helper)
#
# Loads and combines task graphs from all registered projects with read permission.
# Returns unified array suitable for cross-project discovery.
#
# Arguments:
#   None
#
# Returns:
#   JSON array of tasks from all readable projects
#
# Exit Status:
#   0 - Always succeeds (returns empty array if no projects)
#
# Example:
#   merged=$(_merge_project_graphs)
#   # Returns: [{"id":"T001","_project":"api",...},{"id":"T001","_project":"web",...}]
#######################################
_merge_project_graphs() {
    local merged="[]"

    # Check if Nexus functions are available
    if ! declare -f nexus_list >/dev/null 2>&1; then
        echo "[]"
        return 0
    fi

    # Get list of registered projects
    local projects_json
    projects_json=$(nexus_list --json 2>/dev/null)

    if [[ -z "$projects_json" || "$projects_json" == "[]" ]]; then
        echo "[]"
        return 0
    fi

    # Load each project's graph
    local project_names
    readarray -t project_names < <(echo "$projects_json" | jq -r '.[].name')

    for project_name in "${project_names[@]}"; do
        [[ -z "$project_name" ]] && continue

        local graph
        graph=$(_load_project_graph "$project_name")

        if [[ -n "$graph" && "$graph" != "[]" ]]; then
            merged=$(echo "$merged" "$graph" | jq -s 'add')
        fi
    done

    echo "$merged"
}

#######################################
# Core cross-project discovery logic (internal helper)
#
# Runs discovery algorithm across project boundaries using specified method.
# Applies hierarchical boosts for same-project relationships and cross-project bonuses.
#
# Arguments:
#   $1 - Source task JSON (required)
#   $2 - Target graphs JSON array (required)
#   $3 - Discovery method (required): labels, description, files, hierarchy, auto
#
# Returns:
#   JSON array of matches with scores and project context
#
# Exit Status:
#   0 - Success
#   1 - Invalid arguments or method
#
# Example:
#   source_task='{"id":"T001","_project":"api","labels":["auth"]}'
#   results=$(_discover_cross_project "$source_task" "$target_graphs" "labels")
#######################################
_discover_cross_project() {
    local source_task="$1"
    local target_graphs="$2"
    local method="$3"

    if [[ -z "$source_task" || -z "$target_graphs" || -z "$method" ]]; then
        echo "[]"
        return 1
    fi

    local source_id source_project
    source_id=$(echo "$source_task" | jq -r '.id')
    source_project=$(echo "$source_task" | jq -r '._project // ""')

    local results="[]"

    # Process each target task
    local task_count
    task_count=$(echo "$target_graphs" | jq 'length')

    for ((i = 0; i < task_count; i++)); do
        local target_task
        target_task=$(echo "$target_graphs" | jq ".[$i]")

        local target_id target_project
        target_id=$(echo "$target_task" | jq -r '.id')
        target_project=$(echo "$target_task" | jq -r '._project // ""')

        # Skip if same task in same project
        if [[ "$source_id" == "$target_id" && "$source_project" == "$target_project" ]]; then
            continue
        fi

        # Calculate similarity based on method
        local score=0
        local reason=""

        case "$method" in
            labels)
                # Compare labels
                local source_labels target_labels
                source_labels=$(echo "$source_task" | jq -c '.labels // []')
                target_labels=$(echo "$target_task" | jq -c '.labels // []')

                local shared
                shared=$(echo "$source_labels" "$target_labels" | \
                    jq -s '.[0] as $s | .[1] as $t | $s | map(select(. as $l | $t | index($l))) | length')

                if [[ "$shared" -gt 0 ]]; then
                    local total
                    total=$(echo "$source_labels" "$target_labels" | jq -s 'add | unique | length')
                    score=$(awk -v s="$shared" -v t="$total" 'BEGIN { printf "%.2f", (t > 0 ? s/t : 0) }')
                    reason="$shared shared label(s)"
                fi
                ;;
            description)
                # Compare descriptions using tokenization
                local source_text target_text
                source_text=$(echo "$source_task" | jq -r '"\(.title // "") \(.description // "")"')
                target_text=$(echo "$target_task" | jq -r '"\(.title // "") \(.description // "")"')

                local source_tokens target_tokens
                source_tokens=$(_graph_rag_tokenize "$source_text")
                source_tokens=$(_graph_rag_remove_stopwords "$source_tokens")
                target_tokens=$(_graph_rag_tokenize "$target_text")
                target_tokens=$(_graph_rag_remove_stopwords "$target_tokens")

                if [[ -n "$source_tokens" && -n "$target_tokens" ]]; then
                    score=$(_graph_rag_jaccard_similarity "$source_tokens" "$target_tokens")
                    local shared_count
                    shared_count=$(comm -12 <(echo "$source_tokens" | sort -u) <(echo "$target_tokens" | sort -u) | wc -l | tr -d ' ')
                    reason="$shared_count shared keyword(s)"
                fi
                ;;
            files)
                # Compare files
                local source_files target_files
                source_files=$(echo "$source_task" | jq -c '.files // []')
                target_files=$(echo "$target_task" | jq -c '.files // []')

                local shared
                shared=$(echo "$source_files" "$target_files" | \
                    jq -s '.[0] as $s | .[1] as $t | $s | map(select(. as $f | $t | index($f))) | length')

                if [[ "$shared" -gt 0 ]]; then
                    local total
                    total=$(echo "$source_files" "$target_files" | jq -s 'add | unique | length')
                    score=$(awk -v s="$shared" -v t="$total" 'BEGIN { printf "%.2f", (t > 0 ? s/t : 0) }')
                    reason="$shared shared file(s)"
                fi
                ;;
        esac

        # Skip if no match
        if [[ $(awk -v s="$score" 'BEGIN { print (s > 0) ? 1 : 0 }') -eq 0 ]]; then
            continue
        fi

        # Apply project boost
        local boost=0
        if [[ "$source_project" == "$target_project" ]]; then
            # Same project - use existing hierarchy boost if available
            boost=0.15
        else
            # Cross-project - smaller boost
            boost=0.10
        fi

        local boosted_score
        boosted_score=$(awk -v s="$score" -v b="$boost" 'BEGIN { printf "%.2f", (s + b > 1.0 ? 1.0 : s + b) }')

        # Add to results with project context
        local match
        match=$(jq -n \
            --arg taskId "$target_id" \
            --arg project "$target_project" \
            --arg query "${target_project}:${target_id}" \
            --arg reason "$reason" \
            --arg score "$boosted_score" \
            --arg source "$method" \
            '{
                taskId: $taskId,
                project: $project,
                query: $query,
                type: "relates-to",
                reason: $reason,
                score: ($score | tonumber),
                source: $source
            }')

        results=$(echo "$results" | jq --argjson match "$match" '. + [$match]')
    done

    # Sort by score descending
    echo "$results" | jq 'sort_by(-.score)'
}

#######################################
# Format cross-project results with project context (internal helper)
#
# Adds query field (project:taskId) and enriches with project metadata.
# Ensures consistent output format across all cross-project operations.
#
# Arguments:
#   $1 - Results JSON array (required)
#
# Returns:
#   Formatted JSON array
#
# Exit Status:
#   0 - Always succeeds
#
# Example:
#   formatted=$(_format_cross_project_results "$results")
#######################################
_format_cross_project_results() {
    local results="$1"

    if [[ -z "$results" || "$results" == "[]" ]]; then
        echo "[]"
        return 0
    fi

    # Ensure query field exists (project:taskId format)
    echo "$results" | jq 'map(
        if .query then . else
            . + {query: "\(.project):\(.taskId)"}
        end
    )'
}

#######################################
# Discover related tasks across all registered projects
#
# Main cross-project discovery entry point. Extends local discovery to all
# projects in the Nexus registry with read permission. Implements the
# "neural network" that spans project boundaries.
#
# Neural Network Semantics:
#   - Neurons: Tasks across all projects
#   - Synapses: relates entries + discovery links
#   - Weights: Similarity scores + project boost
#   - Activation: Score threshold for inclusion
#   - Propagation: Context flows across project boundaries
#
# Arguments:
#   $1 - Task query (required): T001, project:T001, .:T001
#   $2 - Discovery method (optional): labels, description, files, hierarchy, auto (default: auto)
#   $3 - Result limit (optional): max results to return (default: 10)
#
# Returns:
#   JSON array of matches with project context and scores
#
# Exit Status:
#   0 - Success
#   1 - Invalid arguments or Nexus not available
#
# Example:
#   results=$(discover_across_projects "my-app:T001" "auto" 10)
#   # Returns: [{"taskId":"T042","project":"other-app","query":"other-app:T042","score":0.85,...}]
#######################################
discover_across_projects() {
    local task_query="${1:-}"
    local method="${2:-auto}"
    local limit="${3:-10}"

    if [[ -z "$task_query" ]]; then
        echo '{"error": "Task query required"}' >&2
        return 1
    fi

    # Check if Nexus functions are available
    if ! declare -f nexus_parse_query >/dev/null 2>&1; then
        echo '{"error": "Nexus libraries not loaded"}' >&2
        return 1
    fi

    # Parse task query to get source task
    local parsed
    parsed=$(nexus_parse_query "$task_query" 2>/dev/null) || {
        echo '{"error": "Invalid task query syntax"}' >&2
        return 1
    }

    local project task_id
    project=$(echo "$parsed" | jq -r '.project')
    task_id=$(echo "$parsed" | jq -r '.taskId')

    # Load source task
    local source_task
    if declare -f nexus_resolve_task >/dev/null 2>&1; then
        source_task=$(nexus_resolve_task "$task_query" 2>/dev/null) || {
            echo '{"error": "Source task not found"}' >&2
            return 1
        }
    else
        echo '{"error": "Cannot resolve task query"}' >&2
        return 1
    fi

    # Merge graphs from all readable projects
    local target_graphs
    target_graphs=$(_merge_project_graphs)

    if [[ -z "$target_graphs" || "$target_graphs" == "[]" ]]; then
        echo "[]"
        return 0
    fi

    # Run discovery across combined graph
    local results
    if [[ "$method" == "auto" ]]; then
        # Combine multiple methods
        local labels_result description_result files_result
        labels_result=$(_discover_cross_project "$source_task" "$target_graphs" "labels")
        description_result=$(_discover_cross_project "$source_task" "$target_graphs" "description")
        files_result=$(_discover_cross_project "$source_task" "$target_graphs" "files")

        # Merge and deduplicate
        results=$(echo "$labels_result" "$description_result" "$files_result" | \
            jq -s 'add | group_by(.taskId + .project) | map(max_by(.score)) | sort_by(-.score)')
    else
        results=$(_discover_cross_project "$source_task" "$target_graphs" "$method")
    fi

    # Format with project context
    results=$(_format_cross_project_results "$results")

    # Apply limit
    if [[ "$limit" -gt 0 ]]; then
        results=$(echo "$results" | jq ".[:$limit]")
    fi

    echo "$results"
    return 0
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
        hierarchy)
            _discover_by_hierarchy "$task_id"
            ;;
        auto|all)
            # Combine all discovery methods including hierarchy
            local labels_result description_result files_result hierarchy_result
            labels_result=$(_discover_by_labels "$task_id")
            description_result=$(_discover_by_description "$task_id")
            files_result=$(_discover_by_files "$task_id")
            hierarchy_result=$(_discover_by_hierarchy "$task_id")

            # Merge results with hierarchy boosting applied
            # For tasks found in hierarchy_result, add their boost to the base score
            echo "$labels_result" "$description_result" "$files_result" "$hierarchy_result" | \
                jq -s '
                    # Flatten all arrays
                    add |
                    # Group by taskId to combine scores
                    group_by(.taskId) |
                    map(
                        # For each task group, find max base score and hierarchy boost
                        . as $matches |
                        ($matches | map(select(._relationship == null)) | max_by(.score) // {score: 0}) as $base |
                        ($matches | map(select(._relationship != null)) | .[0] // {_hierarchyBoost: 0}) as $hier |
                        # Combine: apply hierarchy boost to base score, cap at 1.0
                        if $base.taskId then
                            $base + {
                                score: ([($base.score + ($hier._hierarchyBoost // 0)), 1.0] | min),
                                _hierarchyBoost: ($hier._hierarchyBoost // 0),
                                _relationship: ($hier._relationship // null)
                            }
                        else
                            # Task only found via hierarchy (no content match)
                            $hier | del(._hierarchyBoost) | del(._relationship)
                        end
                    ) |
                    # Sort by score descending
                    sort_by(-.score)
                '
            ;;
        *)
            echo '{"error": "Invalid method. Use: labels, description, files, hierarchy, auto"}' >&2
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
  source lib/tasks/graph-rag.sh
  
Functions:
  discover_related_tasks <task_id> [method]
    Find related tasks. Methods: labels, description, files, hierarchy, auto (default)
    
  suggest_relates <task_id> [threshold]
    Get suggestions filtered by similarity threshold (0.0-1.0, default: 0.5)
    
  add_relates_entry <from_task> <to_task> <type> [reason]
    Add a relates entry. Types: relates-to, spawned-from, deferred-to, supersedes, duplicates

CLI:
  ./lib/tasks/graph-rag.sh discover T001 labels
  ./lib/tasks/graph-rag.sh suggest T001 0.6
  ./lib/tasks/graph-rag.sh add T001 T002 relates-to "shared auth context"
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
