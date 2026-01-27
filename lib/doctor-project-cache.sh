#!/usr/bin/env bash
# lib/doctor-project-cache.sh - Project validation caching for performance optimization
# LAYER: 2 (Services)
# DEPENDENCIES: file-ops.sh, paths.sh
#
# PURPOSE:
#   Provides caching mechanisms to avoid redundant project validations in doctor command.
#   Caches validation results, schema versions, and project health status.
#
# DESIGN PRINCIPLES:
#   - Cache invalidation based on file modification times
#   - Per-project cache entries with TTL
#   - Atomic cache operations
#   - Graceful degradation if cache is corrupted

#=== SOURCE GUARD ================================================
[[ -n "${_DOCTOR_PROJECT_CACHE_LOADED:-}" ]] && return 0
readonly _DOCTOR_PROJECT_CACHE_LOADED=1

set -euo pipefail

#=== DEPENDENCIES ================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source required libraries
if [[ -f "$_LIB_DIR/file-ops.sh" ]]; then
    source "$_LIB_DIR/file-ops.sh"
fi

if [[ -f "$_LIB_DIR/paths.sh" ]]; then
    source "$_LIB_DIR/paths.sh"
fi

#=== CONSTANTS ==================================================

readonly CACHE_VERSION="1.0.0"
readonly CACHE_TTL_SECONDS=300  # 5 minutes default TTL
readonly CACHE_FILE="doctor-project-cache.json"

#=== CACHE STRUCTURE ============================================
# {
#   "version": "1.0.0",
#   "lastUpdated": "2024-01-01T00:00:00Z",
#   "projects": {
#     "project_hash": {
#       "path": "/absolute/path",
#       "lastValidated": "2024-01-01T00:00:00Z",
#       "validationStatus": "passed|failed|warning",
#       "schemaVersions": {
#         "todo": "1.2.3",
#         "config": "2.4.0",
#         "archive": "1.1.0",
#         "log": "1.0.0"
#       },
#       "fileHashes": {
#         "todo.json": "sha256_hash",
#         "config.json": "sha256_hash"
#       },
#       "issues": [],
#       "ttl": 300
#     }
#   }
# }

#=== FUNCTIONS ==================================================

#######################################
# Get cache file path
# Returns: Absolute path to cache file
#######################################
get_cache_file_path() {
    local cleo_home
    cleo_home="$(get_cleo_home)"
    echo "$cleo_home/$CACHE_FILE"
}

#######################################
# Initialize empty cache file
# Arguments:
#   $1 - Cache file path
# Returns: 0 on success, 1 on failure
#######################################
init_cache_file() {
    local cache_file="${1:-}"
    
    if [[ -z "$cache_file" ]]; then
        return 1
    fi
    
    local temp_file
    temp_file=$(mktemp)
    trap 'rm -f "$temp_file"' RETURN
    
    jq -n \
        --arg version "$CACHE_VERSION" \
        --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
        '{
            version: $version,
            lastUpdated: $timestamp,
            projects: {}
        }' > "$temp_file"
    
    save_json "$cache_file" < "$temp_file"
}

#######################################
# Get file hash for cache invalidation
# Arguments:
#   $1 - File path
# Returns: SHA256 hash or empty string if file doesn't exist
#######################################
get_file_hash() {
    local file_path="${1:-}"
    
    if [[ -z "$file_path" ]] || [[ ! -f "$file_path" ]]; then
        echo ""
        return 0
    fi
    
    sha256sum "$file_path" 2>/dev/null | cut -d' ' -f1 || echo ""
}

#######################################
# Check if project validation is cached and valid
# Arguments:
#   $1 - Project hash
#   $2 - Project path
# Returns: JSON cache entry or empty object
#######################################
get_cached_validation() {
    local project_hash="${1:-}"
    local project_path="${2:-}"
    
    if [[ -z "$project_hash" ]] || [[ -z "$project_path" ]]; then
        echo "{}"
        return 0
    fi
    
    local cache_file
    cache_file="$(get_cache_file_path)"
    
    if [[ ! -f "$cache_file" ]]; then
        echo "{}"
        return 0
    fi
    
    # Check if cache entry exists and is valid
    local cached_entry
    cached_entry=$(jq -r ".projects[\"$project_hash\"] // {}" "$cache_file" 2>/dev/null || echo "{}")
    
    if [[ "$cached_entry" == "{}" ]] || [[ "$cached_entry" == "null" ]] || [[ "$cached_entry" == "" ]]; then
        echo "{}"
        return 0
    fi
    
    # Check if project path matches (safety check)
    local cached_path
    cached_path=$(echo "$cached_entry" | jq -r '.path // ""' 2>/dev/null || echo "")
    
    if [[ "$cached_path" != "$project_path" ]]; then
        echo "{}"
        return 0
    fi
    
    # Check if cache is expired
    local last_validated
    last_validated=$(echo "$cached_entry" | jq -r '.lastValidated // ""' 2>/dev/null || echo "")
    
    if [[ -z "$last_validated" ]]; then
        echo "{}"
        return 0
    fi
    
    local ttl
    ttl=$(echo "$cached_entry" | jq -r '.ttl // $CACHE_TTL_SECONDS' 2>/dev/null || echo "$CACHE_TTL_SECONDS")
    
    # Calculate age in seconds
    local now_epoch last_epoch age_seconds
    now_epoch=$(date +%s)
    last_epoch=$(date -d "$last_validated" +%s 2>/dev/null || echo "0")
    age_seconds=$((now_epoch - last_epoch))
    
    if [[ $age_seconds -gt $ttl ]]; then
        echo "{}"
        return 0
    fi
    
    # Check if key files have changed (cache invalidation)
    local todo_hash config_hash
    todo_hash=$(get_file_hash "$project_path/.cleo/todo.json")
    config_hash=$(get_file_hash "$project_path/.cleo/config.json")
    
    local cached_todo_hash cached_config_hash
    cached_todo_hash=$(echo "$cached_entry" | jq -r '.fileHashes["todo.json"] // ""' 2>/dev/null || echo "")
    cached_config_hash=$(echo "$cached_entry" | jq -r '.fileHashes["config.json"] // ""' 2>/dev/null || echo "")
    
    if [[ "$todo_hash" != "$cached_todo_hash" ]] || [[ "$config_hash" != "$cached_config_hash" ]]; then
        echo "{}"
        return 0
    fi
    
    echo "$cached_entry"
}

#######################################
# Cache project validation results
# Arguments:
#   $1 - Project hash
#   $2 - Project path
#   $3 - Validation status (passed|failed|warning)
#   $4 - JSON array of issues
#   $5 - JSON object of schema versions
# Returns: 0 on success, 1 on failure
#######################################
cache_validation_result() {
    local project_hash="${1:-}"
    local project_path="${2:-}"
    local validation_status="${3:-}"
    local issues="${4:-[]}"
    # Note: Use quoted default to avoid Bash 5.3+ brace expansion bug
    local schema_versions="${5:-'{}'}"

    if [[ -z "$project_hash" ]] || [[ -z "$project_path" ]]; then
        return 1
    fi
    
    local cache_file
    cache_file="$(get_cache_file_path)"
    
    # Initialize cache if it doesn't exist
    if [[ ! -f "$cache_file" ]]; then
        init_cache_file "$cache_file" || return 1
    fi
    
    # Get file hashes for cache invalidation
    local todo_hash config_hash archive_hash log_hash
    todo_hash=$(get_file_hash "$project_path/.cleo/todo.json")
    config_hash=$(get_file_hash "$project_path/.cleo/config.json")
    archive_hash=$(get_file_hash "$project_path/.cleo/todo-archive.json")
    log_hash=$(get_file_hash "$project_path/.cleo/todo-log.json")
    
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    local temp_file
    temp_file=$(mktemp)
    trap 'rm -f "$temp_file"' RETURN
    
    # Validate JSON inputs
    if ! echo "$issues" | jq . >/dev/null 2>&1; then
        echo "ERROR: Invalid issues JSON for project $project_hash" >&2
        issues="[]"
    fi
    if ! echo "$schema_versions" | jq . >/dev/null 2>&1; then
        echo "ERROR: Invalid schema_versions JSON for project $project_hash" >&2
        schema_versions="{}"
    fi
    
    # Update cache atomically
    if jq --arg hash "$project_hash" \
       --arg path "$project_path" \
       --arg status "$validation_status" \
       --arg timestamp "$timestamp" \
       --argjson issues "$issues" \
       --argjson schemas "$schema_versions" \
       --arg todo_hash "$todo_hash" \
       --arg config_hash "$config_hash" \
       --arg archive_hash "$archive_hash" \
       --arg log_hash "$log_hash" \
       '.projects[$hash] = {
           path: $path,
           lastValidated: $timestamp,
           validationStatus: $status,
           schemaVersions: $schemas,
           fileHashes: {
               "todo.json": $todo_hash,
               "config.json": $config_hash,
               "todo-archive.json": $archive_hash,
               "todo-log.json": $log_hash
           },
           issues: $issues,
           ttl: '"$CACHE_TTL_SECONDS"'
       } | .lastUpdated = $timestamp' "$cache_file" > "$temp_file" 2>/dev/null; then
        
        if [[ -s "$temp_file" ]]; then
            save_json "$cache_file" < "$temp_file"
        else
            echo "ERROR: Failed to create cache update for project $project_hash" >&2
            return 1
        fi
    else
        echo "ERROR: Failed to update cache for project $project_hash" >&2
        return 1
    fi
}

#######################################
# Clear cache for specific project
# Arguments:
#   $1 - Project hash
# Returns: 0 on success, 1 on failure
#######################################
clear_project_cache() {
    local project_hash="${1:-}"
    
    if [[ -z "$project_hash" ]]; then
        return 1
    fi
    
    local cache_file
    cache_file="$(get_cache_file_path)"
    
    if [[ ! -f "$cache_file" ]]; then
        return 0
    fi
    
    local temp_file
    temp_file=$(mktemp)
    trap 'rm -f "$temp_file"' RETURN
    
    jq --arg hash "$project_hash" \
       'del(.projects[$hash])' "$cache_file" > "$temp_file"
    
    save_json "$cache_file" < "$temp_file"
}

#######################################
# Clear entire cache
# Returns: 0 on success, 1 on failure
#######################################
clear_entire_cache() {
    local cache_file
    cache_file="$(get_cache_file_path)"
    
    if [[ -f "$cache_file" ]]; then
        rm -f "$cache_file"
    fi
    
    init_cache_file "$cache_file"
}