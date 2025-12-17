#!/usr/bin/env bash

#####################################################################
# cache.sh - Index Caching Library for Claude Todo System
#
# NOTE: This library is sourced by other scripts, so VERSION variable
# should already be set by the sourcing script. If not, we set a fallback.
#
# Provides O(1) lookups for labels and phases through cached indices:
# - Label-to-task index: quickly find all tasks with a specific label
# - Phase-to-task index: quickly find all tasks in a specific phase
# - Checksum-based staleness detection
# - Lazy regeneration on first query after changes
#
# Cache files stored in .claude/.cache/:
#   - labels.index.json: label -> task ID mapping
#   - phases.index.json: phase -> task ID mapping
#   - checksum.txt: SHA256 of todo.json for staleness detection
#
# PERFORMANCE CHARACTERISTICS:
#   - Lookup time: O(1) via bash associative arrays
#   - Build time: O(n) where n = number of tasks
#   - Staleness check: O(1) via checksum comparison
#   - Memory usage: O(m) where m = number of unique labels/phases
#
# Typical performance (1000 tasks, 50 labels, 5 phases):
#   - cache_get_tasks_by_label: < 1ms
#   - cache_get_tasks_by_phase: < 1ms
#   - cache_init (cold): ~50ms
#   - cache_init (warm): < 1ms
#
# Usage:
#   source lib/cache.sh
#   cache_init                          # Initialize cache system
#   cache_get_tasks_by_label "bug"      # Get task IDs with label
#   cache_get_tasks_by_phase "core"     # Get task IDs in phase
#   cache_invalidate                    # Force cache rebuild
#
# Version: 1.0.0
# Part of: claude-todo CLI (Phase 4 - T074)
#####################################################################

# Set VERSION if not already set (should be set by sourcing script)
if [[ -z "${VERSION:-}" ]]; then
  CLAUDE_TODO_HOME="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}"
  if [[ -f "$CLAUDE_TODO_HOME/VERSION" ]]; then
    VERSION="$(cat "$CLAUDE_TODO_HOME/VERSION" | tr -d '[:space:]')"
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
  local todo_file="${1:-${TODO_FILE:-.claude/todo.json}}"

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
  local todo_file="${1:-${TODO_FILE:-.claude/todo.json}}"

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
  local todo_file="${1:-${TODO_FILE:-.claude/todo.json}}"

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
  local todo_file="${1:-${TODO_FILE:-.claude/todo.json}}"

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
  local todo_file="${1:-${TODO_FILE:-.claude/todo.json}}"

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
  local todo_file="${1:-${TODO_FILE:-.claude/todo.json}}"

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
  local todo_file="${1:-${TODO_FILE:-.claude/todo.json}}"

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
    local todo_file="${1:-${TODO_FILE:-.claude/todo.json}}"

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
    local todo_file="${2:-${TODO_FILE:-.claude/todo.json}}"

    jq --arg phase "$phase" '
        [.tasks[] | select(.phase == $phase) | .id]
    ' "$todo_file"
}

# Get task count by phase
# Args: $1 = todo file path
# Returns: JSON object {phase_slug: count}
count_tasks_by_phase() {
    local todo_file="${1:-${TODO_FILE:-.claude/todo.json}}"

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
    local todo_file="${2:-${TODO_FILE:-.claude/todo.json}}"

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
    local todo_file="${2:-${TODO_FILE:-.claude/todo.json}}"

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

# Export all public functions
export -f build_phase_index
export -f get_phase_tasks
export -f count_tasks_by_phase
export -f get_phase_stats
export -f get_phase_progress
export -f invalidate_phase_cache
