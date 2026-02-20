#!/usr/bin/env bash
# cache.sh - Index Caching Library for Claude Todo System
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: platform-compat.sh
# PROVIDES: cache_init, cache_invalidate, cache_get_tasks_by_label,
#           cache_get_tasks_by_phase, cache_is_stale, cache_rebuild
#
# O(1) lookups for labels and phases through cached indices with
# checksum-based staleness detection and lazy regeneration

#=== SOURCE GUARD ================================================
[[ -n "${_CACHE_LOADED:-}" ]] && return 0
declare -r _CACHE_LOADED=1

# Set VERSION if not already set (should be set by sourcing script)
if [[ -z "${VERSION:-}" ]]; then
  CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
  if [[ -f "$CLEO_HOME/VERSION" ]]; then
    VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
  else
    VERSION="unknown"
  fi
fi

# Cache directory and files
CACHE_DIR="${CLAUDE_DIR:-.claude}/.cache"
CACHE_LABELS_INDEX="$CACHE_DIR/labels.index.json"
CACHE_PHASES_INDEX="$CACHE_DIR/phases.index.json"
CACHE_CHECKSUM_FILE="$CACHE_DIR/checksum.txt"
CACHE_METADATA_FILE="$CACHE_DIR/metadata.json"

# In-memory cache (associative arrays)
declare -A _LABEL_CACHE
declare -A _PHASE_CACHE
_CACHE_INITIALIZED=false
_CACHE_VALID=false

#####################################################################
# Internal Functions
#####################################################################

# Calculate checksum of todo.json
_cache_calculate_checksum() {
  local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

  if [[ ! -f "$todo_file" ]]; then
    echo ""
    return
  fi

  # Use sha256sum or shasum depending on platform
  if command -v sha256sum &>/dev/null; then
    sha256sum "$todo_file" | cut -d' ' -f1
  elif command -v shasum &>/dev/null; then
    shasum -a 256 "$todo_file" | cut -d' ' -f1
  else
    # Fallback: use modification time and size
    stat -c "%Y%s" "$todo_file" 2>/dev/null || stat -f "%m%z" "$todo_file" 2>/dev/null
  fi
}

# Check if cache is stale
_cache_is_stale() {
  local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

  # No cache directory means stale
  if [[ ! -d "$CACHE_DIR" ]]; then
    return 0  # true = stale
  fi

  # No checksum file means stale
  if [[ ! -f "$CACHE_CHECKSUM_FILE" ]]; then
    return 0
  fi

  # No index files means stale
  if [[ ! -f "$CACHE_LABELS_INDEX" || ! -f "$CACHE_PHASES_INDEX" ]]; then
    return 0
  fi

  # Compare checksums
  local stored_checksum current_checksum
  stored_checksum=$(cat "$CACHE_CHECKSUM_FILE" 2>/dev/null)
  current_checksum=$(_cache_calculate_checksum "$todo_file")

  if [[ "$stored_checksum" != "$current_checksum" ]]; then
    return 0  # stale
  fi

  return 1  # not stale
}

# Build label index from todo.json
_cache_build_label_index() {
  local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

  jq -c '
    reduce .tasks[] as $task ({};
      if $task.labels then
        reduce $task.labels[] as $label (.;
          .[$label] = ((.[$label] // []) + [$task.id])
        )
      else
        .
      end
    )
  ' "$todo_file"
}

# Build phase index from todo.json
_cache_build_phase_index() {
  local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

  jq -c '
    reduce .tasks[] as $task ({};
      if $task.phase then
        .[$task.phase] = ((.[$task.phase] // []) + [$task.id])
      else
        .
      end
    )
  ' "$todo_file"
}

# Write cache files
_cache_write_files() {
  local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

  # Create cache directory
  mkdir -p "$CACHE_DIR"

  # Build and write indices
  _cache_build_label_index "$todo_file" > "$CACHE_LABELS_INDEX"
  _cache_build_phase_index "$todo_file" > "$CACHE_PHASES_INDEX"

  # Write checksum
  _cache_calculate_checksum "$todo_file" > "$CACHE_CHECKSUM_FILE"

  # Write metadata
  cat > "$CACHE_METADATA_FILE" << EOF
{
  "version": "$VERSION",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "todoFile": "$todo_file",
  "labelCount": $(jq 'length' "$CACHE_LABELS_INDEX"),
  "phaseCount": $(jq 'length' "$CACHE_PHASES_INDEX")
}
EOF
}

# Load cache into memory
_cache_load_memory() {
  # Clear existing cache
  _LABEL_CACHE=()
  _PHASE_CACHE=()

  if [[ -f "$CACHE_LABELS_INDEX" ]]; then
    # Load labels into associative array
    while IFS='=' read -r key value; do
      _LABEL_CACHE["$key"]="$value"
    done < <(jq -r 'to_entries[] | "\(.key)=\(.value | join(","))"' "$CACHE_LABELS_INDEX" 2>/dev/null)
  fi

  if [[ -f "$CACHE_PHASES_INDEX" ]]; then
    # Load phases into associative array
    while IFS='=' read -r key value; do
      _PHASE_CACHE["$key"]="$value"
    done < <(jq -r 'to_entries[] | "\(.key)=\(.value | join(","))"' "$CACHE_PHASES_INDEX" 2>/dev/null)
  fi

  _CACHE_VALID=true
}

#####################################################################
# Public API
#####################################################################

# Initialize cache system (call at script start)
# Returns: 0 if cache was valid, 1 if cache was rebuilt
cache_init() {
  local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

  if [[ "$_CACHE_INITIALIZED" == "true" && "$_CACHE_VALID" == "true" ]]; then
    return 0
  fi

  if _cache_is_stale "$todo_file"; then
    _cache_write_files "$todo_file"
    _cache_load_memory
    _CACHE_INITIALIZED=true
    return 1  # cache was rebuilt
  else
    _cache_load_memory
    _CACHE_INITIALIZED=true
    return 0  # cache was valid
  fi
}

# Get task IDs by label (O(1) lookup)
# Args: $1 = label name
# Returns: comma-separated task IDs or empty string
cache_get_tasks_by_label() {
  local label="$1"

  cache_init >/dev/null 2>&1

  echo "${_LABEL_CACHE[$label]:-}"
}

# Get task IDs by phase (O(1) lookup)
# Args: $1 = phase slug
# Returns: comma-separated task IDs or empty string
cache_get_tasks_by_phase() {
  local phase="$1"

  cache_init >/dev/null 2>&1

  echo "${_PHASE_CACHE[$phase]:-}"
}

# Get all cached labels
# Returns: newline-separated label names
cache_get_all_labels() {
  cache_init >/dev/null 2>&1

  printf '%s\n' "${!_LABEL_CACHE[@]}"
}

# Get all cached phases
# Returns: newline-separated phase slugs
cache_get_all_phases() {
  cache_init >/dev/null 2>&1

  printf '%s\n' "${!_PHASE_CACHE[@]}"
}

# Get label count for a specific label
# Args: $1 = label name
# Returns: count of tasks with label
cache_get_label_count() {
  local label="$1"
  local ids

  ids=$(cache_get_tasks_by_label "$label")
  if [[ -z "$ids" ]]; then
    echo "0"
  else
    echo "$ids" | tr ',' '\n' | wc -l | tr -d ' '
  fi
}

# Get phase task count
# Args: $1 = phase slug
# Returns: count of tasks in phase
cache_get_phase_count() {
  local phase="$1"
  local ids

  ids=$(cache_get_tasks_by_phase "$phase")
  if [[ -z "$ids" ]]; then
    echo "0"
  else
    echo "$ids" | tr ',' '\n' | wc -l | tr -d ' '
  fi
}

# Force cache invalidation and rebuild
cache_invalidate() {
  local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

  _CACHE_VALID=false
  _CACHE_INITIALIZED=false

  rm -f "$CACHE_LABELS_INDEX" "$CACHE_PHASES_INDEX" "$CACHE_CHECKSUM_FILE" "$CACHE_METADATA_FILE" 2>/dev/null

  cache_init "$todo_file"
}

# Get cache statistics
cache_stats() {
  cache_init >/dev/null 2>&1

  local label_count phase_count
  label_count="${#_LABEL_CACHE[@]}"
  phase_count="${#_PHASE_CACHE[@]}"

  cat << EOF
{
  "initialized": $_CACHE_INITIALIZED,
  "valid": $_CACHE_VALID,
  "labelCount": $label_count,
  "phaseCount": $phase_count,
  "cacheDir": "$CACHE_DIR",
  "stale": $(_cache_is_stale && echo "true" || echo "false")
}
EOF
}

# Check if cache exists and is valid
cache_is_valid() {
  [[ -d "$CACHE_DIR" ]] && ! _cache_is_stale
}

# Get cache metadata
cache_get_metadata() {
  if [[ -f "$CACHE_METADATA_FILE" ]]; then
    cat "$CACHE_METADATA_FILE"
  else
    echo '{"error": "No cache metadata found"}'
  fi
}

#####################################################################
# Phase Indexing & Statistics
#####################################################################

# Build phase task index (tasks grouped by phase)
# Args: $1 = todo file path
# Returns: JSON object {phase_slug: [task_ids]}
build_phase_index() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

    jq '
        .tasks |
        group_by(.phase // "no-phase") |
        map({
            key: (.[0].phase // "no-phase"),
            value: [.[] | .id]
        }) |
        from_entries
    ' "$todo_file"
}

# Get tasks for specific phase from cache or build
# Args: $1 = phase slug, $2 = todo file path
# Returns: JSON array of task IDs
get_phase_tasks() {
    local phase="$1"
    local todo_file="${2:-${TODO_FILE:-.cleo/todo.json}}"

    jq --arg phase "$phase" '
        [.tasks[] | select(.phase == $phase) | .id]
    ' "$todo_file"
}

# Get task count by phase
# Args: $1 = todo file path
# Returns: JSON object {phase_slug: count}
count_tasks_by_phase() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

    jq '
        .tasks |
        group_by(.phase // "no-phase") |
        map({
            key: (.[0].phase // "no-phase"),
            value: length
        }) |
        from_entries
    ' "$todo_file"
}

# Get phase statistics (tasks by status within phase)
# Args: $1 = phase slug, $2 = todo file path
# Returns: JSON object {pending: n, active: n, blocked: n, done: n}
get_phase_stats() {
    local phase="$1"
    local todo_file="${2:-${TODO_FILE:-.cleo/todo.json}}"

    jq --arg phase "$phase" '
        .tasks |
        map(select(.phase == $phase)) |
        {
            pending: [.[] | select(.status == "pending")] | length,
            active: [.[] | select(.status == "active")] | length,
            blocked: [.[] | select(.status == "blocked")] | length,
            done: [.[] | select(.status == "done")] | length,
            total: length
        }
    ' "$todo_file"
}

# Get current phase progress percentage
# Args: $1 = phase slug, $2 = todo file path
# Returns: percentage (0-100)
get_phase_progress() {
    local phase="$1"
    local todo_file="${2:-${TODO_FILE:-.cleo/todo.json}}"

    jq -r --arg phase "$phase" '
        .tasks |
        map(select(.phase == $phase)) |
        if length == 0 then 0
        else
            ([.[] | select(.status == "done")] | length) * 100 / length | floor
        end
    ' "$todo_file"
}

# Invalidate phase cache (called when tasks change)
# Args: $1 = cache file path
invalidate_phase_cache() {
    local cache_file="${1:-$CACHE_PHASES_INDEX}"

    if [[ -f "$cache_file" ]]; then
        # Force cache rebuild by invalidating all caches
        cache_invalidate
    fi
}

#####################################################################
# Hierarchy Indexing & Caching (T348)
#####################################################################

# Hierarchy cache files
CACHE_HIERARCHY_INDEX="$CACHE_DIR/hierarchy.index.json"
CACHE_CHILDREN_INDEX="$CACHE_DIR/children.index.json"
CACHE_DEPTH_INDEX="$CACHE_DIR/depth.index.json"

# In-memory hierarchy caches
declare -A _PARENT_CACHE      # task_id -> parent_id
declare -A _CHILDREN_CACHE    # parent_id -> comma-separated child IDs
declare -A _DEPTH_CACHE       # task_id -> depth
declare -A _CHILD_COUNT_CACHE # task_id -> number of children
_HIERARCHY_CACHE_VALID=false

# Build hierarchy index from todo.json
_cache_build_hierarchy_index() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

    jq -c '
        reduce .tasks[] as $task ({};
            .[$task.id] = {
                parentId: ($task.parentId // null),
                type: ($task.type // "task")
            }
        )
    ' "$todo_file"
}

# Build children index (parent -> list of children)
_cache_build_children_index() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

    jq -c '
        reduce .tasks[] as $task ({};
            if $task.parentId then
                .[$task.parentId] = ((.[$task.parentId] // []) + [$task.id])
            else . end
        )
    ' "$todo_file"
}

# Build depth index (task -> depth in hierarchy)
_cache_build_depth_index() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

    jq -c '
        # Build parent lookup
        (reduce .tasks[] as $task ({};
            .[$task.id] = ($task.parentId // null)
        )) as $parents |

        # Calculate depth for each task
        def get_depth($id):
            if $id == null then 0
            elif $parents[$id] == null then 0
            else 1 + get_depth($parents[$id])
            end;

        reduce .tasks[] as $task ({};
            .[$task.id] = get_depth($task.id)
        )
    ' "$todo_file"
}

# Write hierarchy cache files
_cache_write_hierarchy_files() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

    # Create cache directory
    mkdir -p "$CACHE_DIR"

    # Build and write indices
    _cache_build_hierarchy_index "$todo_file" > "$CACHE_HIERARCHY_INDEX"
    _cache_build_children_index "$todo_file" > "$CACHE_CHILDREN_INDEX"
    _cache_build_depth_index "$todo_file" > "$CACHE_DEPTH_INDEX"
}

# Load hierarchy cache into memory
_cache_load_hierarchy_memory() {
    # Clear existing cache
    _PARENT_CACHE=()
    _CHILDREN_CACHE=()
    _DEPTH_CACHE=()
    _CHILD_COUNT_CACHE=()

    if [[ -f "$CACHE_HIERARCHY_INDEX" ]]; then
        # Load parent relationships
        while IFS='=' read -r key value; do
            _PARENT_CACHE["$key"]="$value"
        done < <(jq -r 'to_entries[] | "\(.key)=\(.value.parentId // "")"' "$CACHE_HIERARCHY_INDEX" 2>/dev/null)
    fi

    if [[ -f "$CACHE_CHILDREN_INDEX" ]]; then
        # Load children relationships
        while IFS='=' read -r key value; do
            _CHILDREN_CACHE["$key"]="$value"
            # Count children
            if [[ -n "$value" ]]; then
                _CHILD_COUNT_CACHE["$key"]=$(echo "$value" | tr ',' '\n' | wc -l | tr -d ' ')
            else
                _CHILD_COUNT_CACHE["$key"]=0
            fi
        done < <(jq -r 'to_entries[] | "\(.key)=\(.value | join(","))"' "$CACHE_CHILDREN_INDEX" 2>/dev/null)
    fi

    if [[ -f "$CACHE_DEPTH_INDEX" ]]; then
        # Load depth values
        while IFS='=' read -r key value; do
            _DEPTH_CACHE["$key"]="$value"
        done < <(jq -r 'to_entries[] | "\(.key)=\(.value)"' "$CACHE_DEPTH_INDEX" 2>/dev/null)
    fi

    _HIERARCHY_CACHE_VALID=true
}

# Initialize hierarchy cache system
cache_init_hierarchy() {
    local todo_file="${1:-${TODO_FILE:-.cleo/todo.json}}"

    if [[ "$_HIERARCHY_CACHE_VALID" == "true" ]]; then
        return 0
    fi

    if _cache_is_stale "$todo_file" || \
       [[ ! -f "$CACHE_HIERARCHY_INDEX" ]] || \
       [[ ! -f "$CACHE_CHILDREN_INDEX" ]] || \
       [[ ! -f "$CACHE_DEPTH_INDEX" ]]; then
        _cache_write_hierarchy_files "$todo_file"
        _cache_load_hierarchy_memory
        return 1  # cache was rebuilt
    else
        _cache_load_hierarchy_memory
        return 0  # cache was valid
    fi
}

# Get parent ID for a task (O(1) lookup)
# Args: $1 = task ID
# Returns: parent ID or empty string
cache_get_parent() {
    local task_id="$1"

    cache_init_hierarchy >/dev/null 2>&1

    echo "${_PARENT_CACHE[$task_id]:-}"
}

# Get children IDs for a task (O(1) lookup)
# Args: $1 = task ID
# Returns: comma-separated child IDs or empty string
cache_get_children() {
    local task_id="$1"

    cache_init_hierarchy >/dev/null 2>&1

    echo "${_CHILDREN_CACHE[$task_id]:-}"
}

# Get depth for a task (O(1) lookup)
# Args: $1 = task ID
# Returns: depth (0 for root tasks)
cache_get_depth() {
    local task_id="$1"

    cache_init_hierarchy >/dev/null 2>&1

    echo "${_DEPTH_CACHE[$task_id]:-0}"
}

# Get child count for a task (O(1) lookup)
# Args: $1 = task ID
# Returns: number of children
cache_get_child_count() {
    local task_id="$1"

    cache_init_hierarchy >/dev/null 2>&1

    echo "${_CHILD_COUNT_CACHE[$task_id]:-0}"
}

# Get all root tasks (tasks with no parent)
# Returns: comma-separated task IDs
cache_get_root_tasks() {
    cache_init_hierarchy >/dev/null 2>&1

    local root_tasks=""
    for task_id in "${!_PARENT_CACHE[@]}"; do
        if [[ -z "${_PARENT_CACHE[$task_id]}" ]]; then
            if [[ -n "$root_tasks" ]]; then
                root_tasks="$root_tasks,$task_id"
            else
                root_tasks="$task_id"
            fi
        fi
    done
    echo "$root_tasks"
}

# Get all tasks at a specific depth
# Args: $1 = depth level
# Returns: comma-separated task IDs
cache_get_tasks_at_depth() {
    local target_depth="$1"

    cache_init_hierarchy >/dev/null 2>&1

    local tasks=""
    for task_id in "${!_DEPTH_CACHE[@]}"; do
        if [[ "${_DEPTH_CACHE[$task_id]}" == "$target_depth" ]]; then
            if [[ -n "$tasks" ]]; then
                tasks="$tasks,$task_id"
            else
                tasks="$task_id"
            fi
        fi
    done
    echo "$tasks"
}

# Get all leaf tasks (tasks with no children)
# Returns: comma-separated task IDs
cache_get_leaf_tasks() {
    cache_init_hierarchy >/dev/null 2>&1

    local leaf_tasks=""
    for task_id in "${!_PARENT_CACHE[@]}"; do
        local child_count="${_CHILD_COUNT_CACHE[$task_id]:-0}"
        if [[ "$child_count" -eq 0 ]]; then
            if [[ -n "$leaf_tasks" ]]; then
                leaf_tasks="$leaf_tasks,$task_id"
            else
                leaf_tasks="$task_id"
            fi
        fi
    done
    echo "$leaf_tasks"
}

# Invalidate hierarchy cache
cache_invalidate_hierarchy() {
    _HIERARCHY_CACHE_VALID=false
    rm -f "$CACHE_HIERARCHY_INDEX" "$CACHE_CHILDREN_INDEX" "$CACHE_DEPTH_INDEX" 2>/dev/null
}

# Get hierarchy cache statistics
cache_hierarchy_stats() {
    cache_init_hierarchy >/dev/null 2>&1

    local parent_count="${#_PARENT_CACHE[@]}"
    local children_count="${#_CHILDREN_CACHE[@]}"
    local depth_count="${#_DEPTH_CACHE[@]}"
    local max_depth=0

    for depth in "${_DEPTH_CACHE[@]}"; do
        if [[ "$depth" -gt "$max_depth" ]]; then
            max_depth="$depth"
        fi
    done

    cat << EOF
{
  "hierarchyInitialized": $_HIERARCHY_CACHE_VALID,
  "taskCount": $parent_count,
  "parentsWithChildren": $children_count,
  "maxDepth": $max_depth,
  "cacheFiles": {
    "hierarchy": "$CACHE_HIERARCHY_INDEX",
    "children": "$CACHE_CHILDREN_INDEX",
    "depth": "$CACHE_DEPTH_INDEX"
  }
}
EOF
}

# Export all public functions
export -f build_phase_index
export -f get_phase_tasks
export -f count_tasks_by_phase
export -f get_phase_stats
export -f get_phase_progress
export -f invalidate_phase_cache
export -f cache_init_hierarchy
export -f cache_get_parent
export -f cache_get_children
export -f cache_get_depth
export -f cache_get_child_count
export -f cache_get_root_tasks
export -f cache_get_tasks_at_depth
export -f cache_get_leaf_tasks
export -f cache_invalidate_hierarchy
export -f cache_hierarchy_stats
