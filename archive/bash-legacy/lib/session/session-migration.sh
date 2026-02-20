#!/usr/bin/env bash
# session-migration.sh - Migrate existing projects to Epic-Bound Session system
#
# LAYER: 2 (Data Layer)
# DEPENDENCIES: file-ops.sh, paths.sh, config.sh, sessions.sh
# PROVIDES: Migration functions for existing projects to Epic-Bound Sessions
#
# Design: Automatically migrates existing single-session projects to the new
# Epic-Bound Session architecture when any session command is run.
#
# Version: 1.0.0 (cleo v0.39.3)
# Spec: docs/specs/EPIC-SESSION-SPEC.md Section 11.4

#=== SOURCE GUARD ================================================
[[ -n "${_SESSION_MIGRATION_SH_LOADED:-}" ]] && return 0
declare -r _SESSION_MIGRATION_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_SM_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source paths for directory resolution
if [[ -f "$_SM_LIB_DIR/core/paths.sh" ]]; then
    source "$_SM_LIB_DIR/core/paths.sh"
fi

# Source file-ops for atomic writes
if [[ -f "$_SM_LIB_DIR/data/file-ops.sh" ]]; then
    source "$_SM_LIB_DIR/data/file-ops.sh"
fi

# Source config for settings access
if [[ -f "$_SM_LIB_DIR/core/config.sh" ]]; then
    source "$_SM_LIB_DIR/core/config.sh"
fi

# ============================================================================
# MIGRATION DETECTION
# ============================================================================

# Check if migration is needed for Epic-Bound Sessions
# Args: $1 - cleo directory path (optional, defaults to .cleo)
# Returns: 0 if migration needed, 1 if already migrated
needs_session_migration() {
    local cleo_dir="${1:-.cleo}"
    local sessions_file="$cleo_dir/sessions.json"
    local config_file="$cleo_dir/config.json"

    # If sessions.json exists and has valid structure, no migration needed
    if [[ -f "$sessions_file" ]]; then
        if jq -e '.version' "$sessions_file" >/dev/null 2>&1; then
            return 1  # Already migrated
        fi
    fi

    # Check if multiSession exists in config but no sessions.json (partial migration)
    if [[ -f "$config_file" ]]; then
        if jq -e '.multiSession.enabled' "$config_file" >/dev/null 2>&1; then
            # Config has multiSession but no sessions.json - partial migration
            return 0
        fi
    fi

    return 0  # Migration needed
}

# ============================================================================
# MIGRATION EXECUTION
# ============================================================================

# Migrate existing single-session to multi-session format
# Args: $1 - cleo directory path (optional, defaults to .cleo)
# Returns: 0 on success, non-zero on error
# Outputs: Migration status messages to stderr
migrate_to_epic_sessions() {
    local cleo_dir="${1:-.cleo}"
    local todo_file="$cleo_dir/todo.json"
    local config_file="$cleo_dir/config.json"
    local sessions_file="$cleo_dir/sessions.json"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    echo "[MIGRATION] Upgrading to Epic-Bound Sessions (v2.0)" >&2

    # Step 1: Check for existing single-session in todo.json
    local old_session=""
    if [[ -f "$todo_file" ]]; then
        old_session=$(jq -r '._meta.activeSession // ""' "$todo_file" 2>/dev/null || echo "")
    fi

    # Step 2: Get project name for sessions.json
    local project_name
    project_name=$(jq -r '.project.name // ""' "$todo_file" 2>/dev/null || echo "")
    if [[ -z "$project_name" ]]; then
        project_name=$(basename "$(pwd)")
    fi

    # Step 3: Build initial sessions array (migrate existing session if any)
    local initial_sessions="[]"
    if [[ -n "$old_session" ]]; then
        # Migrate existing session to new format
        # Create a session with global scope (all tasks) since old sessions weren't scoped
        initial_sessions=$(jq -nc --arg sid "$old_session" --arg ts "$timestamp" '[{
            id: $sid,
            status: "active",
            name: "Migrated Legacy Session",
            agentId: null,
            scope: {
                type: "custom",
                rootTaskId: null,
                computedTaskIds: []
            },
            focus: {
                currentTask: null,
                sessionNote: "Migrated from single-session mode",
                nextAction: null
            },
            startedAt: $ts,
            lastActivity: $ts,
            suspendedAt: null,
            stats: {
                tasksCompleted: 0,
                focusChanges: 0,
                suspendCount: 0,
                resumeCount: 0
            }
        }]')
        echo "[MIGRATION] - Migrated active session: $old_session" >&2
    fi

    # Step 4: Create sessions.json
    # Use --slurpfile with process substitution to avoid ARG_MAX limits
    local sessions_content
    sessions_content=$(jq -nc \
        --arg version "1.0.0" \
        --arg project "$project_name" \
        --arg ts "$timestamp" \
        --slurpfile sessions <(echo "$initial_sessions") \
        '{
            "$schema": "./schemas/sessions.schema.json",
            "version": $version,
            "project": $project,
            "_meta": {
                "checksum": "",
                "lastModified": $ts,
                "totalSessionsCreated": (if ($sessions[0] | length) > 0 then 1 else 0 end)
            },
            "config": {
                "maxConcurrentSessions": 5,
                "maxActiveTasksPerScope": 1,
                "scopeValidation": "strict",
                "allowNestedScopes": true,
                "allowScopeOverlap": false
            },
            "sessions": $sessions[0],
            "sessionHistory": []
        }')

    # Write sessions.json using atomic write if available
    if declare -f save_json >/dev/null 2>&1; then
        if ! save_json "$sessions_file" "$sessions_content"; then
            echo "[MIGRATION] ERROR: Failed to create sessions.json" >&2
            return 1
        fi
    else
        echo "$sessions_content" > "$sessions_file" || {
            echo "[MIGRATION] ERROR: Failed to create sessions.json" >&2
            return 1
        }
    fi
    echo "[MIGRATION] - Created .cleo/sessions.json" >&2

    # Step 5: Update config.json with multiSession section if missing
    if [[ -f "$config_file" ]]; then
        local config_updated=false
        local updated_config
        updated_config=$(cat "$config_file")

        # Add multiSession section if not present
        if ! jq -e '.multiSession' "$config_file" >/dev/null 2>&1; then
            updated_config=$(echo "$updated_config" | jq '. + {
                "multiSession": {
                    "enabled": false,
                    "maxConcurrentSessions": 5,
                    "maxActiveTasksPerScope": 1,
                    "scopeValidation": "strict",
                    "allowNestedScopes": true,
                    "allowScopeOverlap": false
                }
            }')
            config_updated=true
            echo "[MIGRATION] - Added multiSession config section (disabled by default)" >&2
        fi

        # Add session settings if missing new fields
        if ! jq -e '.session.requireSession' "$config_file" >/dev/null 2>&1; then
            updated_config=$(echo "$updated_config" | jq '.session += {
                "requireSession": true,
                "requireNotesOnComplete": true,
                "allowNestedSessions": true,
                "allowParallelAgents": true,
                "autoDiscoveryOnStart": true
            }')
            config_updated=true
        fi

        # Write updated config if changes were made
        if [[ "$config_updated" == "true" ]]; then
            if declare -f save_json >/dev/null 2>&1; then
                if ! save_json "$config_file" "$updated_config"; then
                    echo "[MIGRATION] WARNING: Failed to update config.json" >&2
                fi
            else
                echo "$updated_config" > "$config_file" || {
                    echo "[MIGRATION] WARNING: Failed to update config.json" >&2
                }
            fi
            echo "[MIGRATION] - Updated config with multiSession settings" >&2
        fi
    fi

    echo "[MIGRATION] Session system now requires Epic binding. See docs/specs/EPIC-SESSION-SPEC.md" >&2
    return 0
}

# ============================================================================
# MIGRATION ENTRY POINT
# ============================================================================

# Run migration if needed (call this from session commands)
# Args: $1 - cleo directory path (optional)
# Returns: 0 on success (migration performed or not needed)
# Outputs: Migration messages to stderr if migration is performed
ensure_migrated() {
    local cleo_dir="${1:-.cleo}"

    if needs_session_migration "$cleo_dir"; then
        migrate_to_epic_sessions "$cleo_dir"
    fi
}

# ============================================================================
# VALIDATION HELPERS
# ============================================================================

# Check if sessions.json has valid structure
# Args: $1 - sessions file path
# Returns: 0 if valid, 1 if invalid or missing
validate_sessions_file() {
    local sessions_file="$1"

    if [[ ! -f "$sessions_file" ]]; then
        return 1
    fi

    # Check required fields exist
    if ! jq -e '.version and .sessions and ._meta' "$sessions_file" >/dev/null 2>&1; then
        return 1
    fi

    return 0
}

# Get migration status for display
# Args: $1 - cleo directory path (optional)
# Returns: JSON object with migration status
get_migration_status() {
    local cleo_dir="${1:-.cleo}"
    local sessions_file="$cleo_dir/sessions.json"
    local config_file="$cleo_dir/config.json"

    local sessions_exists="false"
    local sessions_valid="false"
    local multi_session_enabled="false"
    local migration_needed="false"

    if [[ -f "$sessions_file" ]]; then
        sessions_exists="true"
        if validate_sessions_file "$sessions_file"; then
            sessions_valid="true"
        fi
    fi

    if [[ -f "$config_file" ]]; then
        if jq -e '.multiSession.enabled == true' "$config_file" >/dev/null 2>&1; then
            multi_session_enabled="true"
        fi
    fi

    if needs_session_migration "$cleo_dir"; then
        migration_needed="true"
    fi

    jq -nc \
        --argjson sessionsExists "$sessions_exists" \
        --argjson sessionsValid "$sessions_valid" \
        --argjson multiSessionEnabled "$multi_session_enabled" \
        --argjson migrationNeeded "$migration_needed" \
        '{
            sessionsFileExists: $sessionsExists,
            sessionsFileValid: $sessionsValid,
            multiSessionEnabled: $multiSessionEnabled,
            migrationNeeded: $migrationNeeded
        }'
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f needs_session_migration
export -f migrate_to_epic_sessions
export -f ensure_migrated
export -f validate_sessions_file
export -f get_migration_status
