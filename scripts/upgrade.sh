#!/usr/bin/env bash
###CLEO
# command: upgrade
# category: maintenance
# synopsis: Unified project maintenance (schema migration, structural repair, doc updates)
# relevance: high
# flags: --status,--dry-run,--force,--verbose,--human,--json
# exits: 0,1,2
# json-output: true
# note: Exit 0 = up to date, Exit 2 = updates applied successfully
###END
# ============================================================================
# scripts/upgrade.sh - Unified project upgrade command
# ============================================================================
# Single command to detect and fix all project-level issues:
# - Schema migrations
# - Structural repairs (phases, checksums)
# - Agent docs injection updates (CLAUDE.md, AGENTS.md, GEMINI.md)
# - Validation
#
# Usage:
#   cleo upgrade              # Auto-detect and fix everything
#   cleo upgrade --dry-run    # Preview changes
#   cleo upgrade --force      # Skip confirmation
#   cleo upgrade --status     # Show what needs updating
# ============================================================================

set -euo pipefail

# ============================================================================
# INITIALIZATION
# ============================================================================
UPG_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${UPG_SCRIPT_DIR}/../lib"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Source required libraries (note: some may redefine SCRIPT_DIR)
source "$LIB_DIR/config.sh"
source "$LIB_DIR/output-format.sh" 2>/dev/null || true
source "$LIB_DIR/migrate.sh" 2>/dev/null || true
source "$LIB_DIR/validation.sh" 2>/dev/null || true
source "$LIB_DIR/injection.sh" 2>/dev/null || true
source "$LIB_DIR/agent-registry.sh" 2>/dev/null || true
source "$LIB_DIR/project-registry.sh" 2>/dev/null || true
source "$LIB_DIR/skills-version.sh" 2>/dev/null || true

# Source centralized flag parsing
source "$LIB_DIR/flags.sh"

# is_json_output - Check if output should be JSON
# Uses FORMAT variable set by argument parsing
is_json_output() {
    [[ "$FORMAT" == "json" ]]
}

# ============================================================================
# DEFAULTS
# ============================================================================
VERSION=$(head -n 1 "$CLEO_HOME/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "0.50.2")
DRY_RUN=false
QUIET=false
FORCE=false
STATUS_ONLY=false
VERBOSE=false
FORMAT=""  # Will be resolved after parsing

# ============================================================================
# ARGUMENT PARSING
# ============================================================================
show_help() {
    cat << 'EOF'
CLEO UPGRADE - Unified project maintenance command

USAGE:
    cleo upgrade [OPTIONS]

DESCRIPTION:
    Single command to update your project to the latest schema version,
    fix structural issues, and update documentation. Safe to run anytime.

OPTIONS:
    --dry-run       Preview changes without applying them
    --force         Skip confirmation prompts
    --status        Show what needs updating (no changes)
    --verbose       Show detailed progress
    --human         Human-readable output (default for TTY)
    --json          JSON output (default for non-TTY)
    -f, --format F  Set output format (human, json)
    -h, --help      Show this help

WHAT IT DOES:
    1. Migrates schemas (todo.json, config.json, log, archive)
    2. Repairs structural issues (phases, checksums)
    3. Updates agent docs injections (GLOBAL + PROJECT)
       - Global: ~/.claude/CLAUDE.md, ~/.claude/AGENTS.md, etc.
       - Project: CLAUDE.md, AGENTS.md, GEMINI.md
    4. Syncs templates (AGENT-INJECTION.md) from global to project
    5. Sets up Claude Code statusline for context monitoring
    6. Updates skill versions when manifest changes
    7. Validates the result

EXAMPLES:
    cleo upgrade                # Interactive upgrade
    cleo upgrade --dry-run      # See what would change
    cleo upgrade --force        # Non-interactive upgrade
    cleo upgrade --status       # Check if upgrade needed

NOTES:
    - Creates automatic backup before any changes
    - Idempotent: safe to run multiple times
    - Exit code 0 = up to date, 1 = error, 2 = updates applied
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --status)
            STATUS_ONLY=true
            shift
            ;;
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        -q|--quiet)
            QUIET=true
            shift
            ;;
        --human)
            FORMAT="human"
            shift
            ;;
        --json)
            FORMAT="json"
            shift
            ;;
        -f|--format)
            FORMAT="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Run 'cleo upgrade --help' for usage" >&2
            exit 1
            ;;
    esac
done

# Resolve format with TTY-aware defaults
FORMAT=$(resolve_format "$FORMAT")

# Sync local variables to FLAG_* for get_passthrough_flags()
# Required because this script uses custom argument parsing
FLAG_FORMAT="$FORMAT"
FLAG_QUIET="$QUIET"
FLAG_DRY_RUN="$DRY_RUN"
FLAG_VERBOSE="$VERBOSE"
FLAG_FORCE="$FORCE"

# ============================================================================
# PROJECT DETECTION
# ============================================================================
UPG_TODO_FILE="./.cleo/todo.json"
UPG_CONFIG_FILE="./.cleo/config.json"
UPG_ARCHIVE_FILE="./.cleo/todo-archive.json"
UPG_LOG_FILE="./.cleo/todo-log.json"
# Multi-agent documentation files (managed by injection system)
# Deprecated: UPG_CLAUDE_MD - now handled by lib/injection.sh registry

if [[ ! -f "$UPG_TODO_FILE" ]]; then
    output_error "E_NOT_PROJECT" "Not a cleo project" 3 \
        "No .cleo/todo.json found in current directory" \
        "Run 'cleo init' to initialize a project"
    exit 3
fi

# ============================================================================
# STATUS CHECK FUNCTIONS
# ============================================================================
INSTALLED_VERSION=$(head -n 1 "$CLEO_HOME/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "unknown")

declare -A UPDATES_NEEDED=()
TOTAL_UPDATES=0

check_schema_status() {
    local file="$1"
    local file_type="$2"
    local expected="$3"

    [[ ! -f "$file" ]] && return 0

    local current
    current=$(jq -r '._meta.schemaVersion' "$file" 2>/dev/null)
    local schema_missing=false

    # Check if schemaVersion is missing
    if [[ -z "$current" || "$current" == "null" ]]; then
        schema_missing=true
    fi

    # Check for legacy structure (must run even if schemaVersion is missing)
    if [[ "$file_type" == "todo" ]]; then
        local has_legacy=false

        # Check for top-level phases
        if jq -e 'has("phases")' "$file" >/dev/null 2>&1; then
            has_legacy=true
        fi

        # Check for string project
        if [[ $(jq -r '.project | type' "$file" 2>/dev/null) == "string" ]]; then
            has_legacy=true
        fi

        # Check for top-level checksum
        if jq -e 'has("checksum")' "$file" >/dev/null 2>&1; then
            has_legacy=true
        fi

        if [[ "$has_legacy" == "true" ]]; then
            UPDATES_NEEDED["$file_type"]="legacy → $expected (structural repair needed)"
            TOTAL_UPDATES=$((TOTAL_UPDATES + 1))
            return 1
        fi
    fi

    # If schemaVersion missing but no legacy structure, still needs update
    if [[ "$schema_missing" == "true" ]]; then
        UPDATES_NEEDED["$file_type"]="missing → $expected"
        TOTAL_UPDATES=$((TOTAL_UPDATES + 1))
        return 1
    fi

    if [[ "$current" != "$expected" ]]; then
        UPDATES_NEEDED["$file_type"]="$current → $expected"
        TOTAL_UPDATES=$((TOTAL_UPDATES + 1))
        return 1
    fi

    return 0
}

check_agent_docs_status() {
    # Use injection library to check all agent documentation files
    if ! type injection_check_all &>/dev/null; then
        # Injection library not available - skip check
        return 0
    fi

    local check_result
    check_result=$(injection_check_all)

    # Parse results and add to UPDATES_NEEDED
    local target status current_version installed_version
    while IFS= read -r line; do
        target=$(echo "$line" | jq -r '.target')
        status=$(echo "$line" | jq -r '.status')
        current_version=$(echo "$line" | jq -r '.currentVersion // "none"')
        installed_version=$(echo "$line" | jq -r '.installedVersion')

        case "$status" in
            missing)
                UPDATES_NEEDED["$target"]="missing → $installed_version"
                TOTAL_UPDATES=$((TOTAL_UPDATES + 1))
                ;;
            outdated|legacy)
                UPDATES_NEEDED["$target"]="$current_version → $installed_version"
                TOTAL_UPDATES=$((TOTAL_UPDATES + 1))
                ;;
            none)
                UPDATES_NEEDED["$target"]="none → $installed_version"
                TOTAL_UPDATES=$((TOTAL_UPDATES + 1))
                ;;
            current)
                # Already up to date - no action needed
                ;;
        esac
    done < <(echo "$check_result" | jq -c '.[]')

    # Return 1 if any updates needed, 0 otherwise
    [[ ${TOTAL_UPDATES} -gt 0 ]] && return 1 || return 0
}

check_checksum_status() {
    [[ ! -f "$UPG_TODO_FILE" ]] && return 0

    local stored_checksum computed_checksum
    stored_checksum=$(jq -r '._meta.checksum // "none"' "$UPG_TODO_FILE" 2>/dev/null)
    computed_checksum=$(jq -c '.tasks' "$UPG_TODO_FILE" 2>/dev/null | sha256sum | cut -c1-16)

    if [[ "$stored_checksum" != "$computed_checksum" ]]; then
        UPDATES_NEEDED["checksum"]="mismatch (will recalculate)"
        TOTAL_UPDATES=$((TOTAL_UPDATES + 1))
        return 1
    fi

    return 0
}

check_skills_version_status() {
    # Skip if skills-version library not available
    if ! type check_skill_updates &>/dev/null; then
        return 0
    fi

    local updates_json update_count
    updates_json=$(check_skill_updates)
    update_count=$(echo "$updates_json" | jq 'length' 2>/dev/null || echo "0")

    if [[ "$update_count" -gt 0 ]]; then
        UPDATES_NEEDED["skills"]="$update_count skill(s) need updating"
        SKILL_UPDATES_JSON="$updates_json"
        TOTAL_UPDATES=$((TOTAL_UPDATES + 1))
        return 1
    fi

    return 0
}

# Global variable to store skill updates for later use
SKILL_UPDATES_JSON="[]"

# ============================================================================
# PROJECT REGISTRY UPDATE (HYBRID MODEL)
# ============================================================================
# Update project registration after successful migrations using hybrid architecture:
# - MINIMAL data to global registry (hash, path, name, healthStatus)
# - DETAILED data to per-project .cleo/project-info.json
update_project_registration() {
    # Skip if registry functions not available
    if ! type generate_project_hash &>/dev/null; then
        return 0
    fi

    local project_hash registry project_path project_name timestamp
    local todo_version config_version archive_version log_version

    project_path="$PWD"
    project_name="$(basename "$project_path")"
    project_hash=$(generate_project_hash "$project_path") || return 0
    registry="$(get_cleo_home)/projects-registry.json"
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Extract feature settings from config.json (sync to project-info.json)
    local config_file="${project_path}/.cleo/config.json"
    local feature_multi_session=false
    local feature_verification=false
    local feature_context_alerts=false

    if [[ -f "$config_file" ]]; then
        feature_multi_session=$(jq -r '.multiSession.enabled // false' "$config_file" 2>/dev/null)
        feature_verification=$(jq -r '.verification.enabled // false' "$config_file" 2>/dev/null)
        feature_context_alerts=$(jq -r '.contextAlerts.enabled // false' "$config_file" 2>/dev/null)
        # Normalize "null" to "false"
        [[ "$feature_multi_session" == "null" ]] && feature_multi_session=false
        [[ "$feature_verification" == "null" ]] && feature_verification=false
        [[ "$feature_context_alerts" == "null" ]] && feature_context_alerts=false
    fi

    # Create registry if missing
    if [[ ! -f "$registry" ]]; then
        create_empty_registry "$registry" || return 0
    fi

    # Extract current schema versions
    todo_version=$(get_schema_version_from_file "todo" 2>/dev/null || echo "unknown")
    config_version=$(get_schema_version_from_file "config" 2>/dev/null || echo "unknown")
    archive_version=$(get_schema_version_from_file "archive" 2>/dev/null || echo "unknown")
    log_version=$(get_schema_version_from_file "log" 2>/dev/null || echo "unknown")

    # Get injection status for all agent files
    local injection_status injection_obj
    injection_status=$(injection_check_all 2>/dev/null || echo "[]")
    injection_obj=$(echo "$injection_status" | jq --arg ts "$timestamp" '
        reduce .[] as $item ({};
            .[$item.target] = {
                status: $item.status,
                lastUpdated: (if $item.status == "current" then $ts else null end)
            }
        )
    ')

    # ============================================================================
    # 1. Update/Create per-project info file (DETAILED)
    # ============================================================================
    local project_info_file="${project_path}/.cleo/project-info.json"
    local temp_info
    temp_info=$(mktemp)
    trap 'rm -f "${temp_info:-}"' RETURN

    if [[ -f "$project_info_file" ]]; then
        # Update existing per-project file
        jq --arg last_updated "$timestamp" \
           --arg cleo_version "$VERSION" \
           --arg todo_v "$todo_version" \
           --arg config_v "$config_version" \
           --arg archive_v "$archive_version" \
           --arg log_v "$log_version" \
           --argjson injection "$injection_obj" \
           --argjson feat_multi "$feature_multi_session" \
           --argjson feat_verif "$feature_verification" \
           --argjson feat_ctx "$feature_context_alerts" \
           '.lastUpdated = $last_updated |
            .cleoVersion = $cleo_version |
            .schemas.todo.version = $todo_v |
            .schemas.todo.lastMigrated = $last_updated |
            .schemas.config.version = $config_v |
            .schemas.config.lastMigrated = $last_updated |
            .schemas.archive.version = $archive_v |
            .schemas.archive.lastMigrated = $last_updated |
            .schemas.log.version = $log_v |
            .schemas.log.lastMigrated = $last_updated |
            .injection = $injection |
            .health.status = "healthy" |
            .health.lastCheck = $last_updated |
            .features.multiSession = $feat_multi |
            .features.verification = $feat_verif |
            .features.contextAlerts = $feat_ctx' \
            "$project_info_file" > "$temp_info"

        if save_json "$project_info_file" < "$temp_info"; then
            if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
                echo "  Updated per-project info file"
            fi
        else
            if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
                echo "  Warning: Failed to update per-project info file" >&2
            fi
        fi
    else
        # Create new per-project file for legacy projects
        local registered_at
        # Try to get registration date from global registry, fallback to now
        registered_at=$(jq -r ".projects[\"$project_hash\"].registeredAt // \"$timestamp\"" "$registry" 2>/dev/null || echo "$timestamp")

        jq -nc \
            --arg schema_version "1.0.0" \
            --arg hash "$project_hash" \
            --arg name "$project_name" \
            --arg registered_at "$registered_at" \
            --arg last_updated "$timestamp" \
            --arg cleo_version "$VERSION" \
            --arg todo_v "$todo_version" \
            --arg config_v "$config_version" \
            --arg archive_v "$archive_version" \
            --arg log_v "$log_version" \
            --argjson injection "$injection_obj" \
            --argjson feat_multi "$feature_multi_session" \
            --argjson feat_verif "$feature_verification" \
            --argjson feat_ctx "$feature_context_alerts" \
            '{
                "$schema": "./schemas/project-info.schema.json",
                "schemaVersion": $schema_version,
                "projectHash": $hash,
                "name": $name,
                "registeredAt": $registered_at,
                "lastUpdated": $last_updated,
                "cleoVersion": $cleo_version,
                "schemas": {
                    "todo": { "version": $todo_v, "lastMigrated": $last_updated },
                    "config": { "version": $config_v, "lastMigrated": $last_updated },
                    "archive": { "version": $archive_v, "lastMigrated": $last_updated },
                    "log": { "version": $log_v, "lastMigrated": $last_updated }
                },
                "injection": $injection,
                "health": {
                    "status": "healthy",
                    "lastCheck": $last_updated,
                    "issues": [],
                    "history": []
                },
                "features": {
                    "multiSession": $feat_multi,
                    "verification": $feat_verif,
                    "contextAlerts": $feat_ctx
                }
            }' > "$temp_info"

        if save_json "$project_info_file" < "$temp_info"; then
            if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
                echo "  Created per-project info file (legacy project upgrade)"
            fi
        else
            if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
                echo "  Warning: Failed to create per-project info file" >&2
            fi
        fi
    fi

    # ============================================================================
    # 2. Update global registry (MINIMAL)
    # ============================================================================
    local temp_registry
    temp_registry=$(mktemp)
    trap 'rm -f "${temp_registry:-}" "${temp_info:-}"' RETURN

    # Check if project is already registered
    if is_project_registered "$project_hash"; then
        # Update existing entry with minimal data
        jq --arg hash "$project_hash" \
           --arg timestamp "$timestamp" \
           '.projects[$hash].lastSeen = $timestamp |
            .projects[$hash].healthStatus = "healthy" |
            .projects[$hash].healthLastCheck = $timestamp |
            .lastUpdated = $timestamp' \
            "$registry" > "$temp_registry"
    else
        # Create new minimal entry for unregistered project
        jq --arg hash "$project_hash" \
           --arg path "$project_path" \
           --arg name "$project_name" \
           --arg timestamp "$timestamp" \
           '.projects[$hash] = {
               hash: $hash,
               path: $path,
               name: $name,
               registeredAt: $timestamp,
               lastSeen: $timestamp,
               healthStatus: "healthy",
               healthLastCheck: $timestamp
           } | .lastUpdated = $timestamp' "$registry" > "$temp_registry"

        if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
            echo "  Registered project in global registry"
        fi
    fi

    # Save atomically
    if save_json "$registry" < "$temp_registry"; then
        if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
            echo "  Updated global registry metadata"
        fi
        return 0
    else
        # Non-fatal error - registry update is optional
        if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
            echo "  Warning: Failed to update global registry" >&2
        fi
        return 1
    fi
}

# ============================================================================
# RUN STATUS CHECKS
# ============================================================================
# Get schema versions from schema files (fail loudly if unreadable)
UPG_SCHEMA_VERSION_TODO=$(get_schema_version_from_file "todo") || {
    echo "ERROR: Failed to read schema version for todo.schema.json" >&2
    exit "${EXIT_FILE_READ_ERROR:-3}"
}
UPG_SCHEMA_VERSION_CONFIG=$(get_schema_version_from_file "config") || {
    echo "ERROR: Failed to read schema version for config.schema.json" >&2
    exit "${EXIT_FILE_READ_ERROR:-3}"
}
UPG_SCHEMA_VERSION_ARCHIVE=$(get_schema_version_from_file "archive") || {
    echo "ERROR: Failed to read schema version for archive.schema.json" >&2
    exit "${EXIT_FILE_READ_ERROR:-3}"
}
UPG_SCHEMA_VERSION_LOG=$(get_schema_version_from_file "log") || {
    echo "ERROR: Failed to read schema version for log.schema.json" >&2
    exit "${EXIT_FILE_READ_ERROR:-3}"
}

check_schema_status "$UPG_TODO_FILE" "todo" "$UPG_SCHEMA_VERSION_TODO" || true
check_schema_status "$UPG_CONFIG_FILE" "config" "$UPG_SCHEMA_VERSION_CONFIG" || true
check_schema_status "$UPG_ARCHIVE_FILE" "archive" "$UPG_SCHEMA_VERSION_ARCHIVE" || true
check_schema_status "$UPG_LOG_FILE" "log" "$UPG_SCHEMA_VERSION_LOG" || true
check_agent_docs_status || true
check_checksum_status || true
check_skills_version_status || true

# Check sequence file status (T1544)
_SEQ_FILE="$(dirname "$UPG_TODO_FILE")/.sequence"
if [[ ! -f "$_SEQ_FILE" ]]; then
    UPDATES_NEEDED["sequence"]="missing"
    (( ++TOTAL_UPDATES ))
fi

# Check template sync status (T1595)
# Templates are copied to project .cleo/templates/ and need to stay in sync with global
TEMPLATE_SYNC_NEEDED=false
TODO_DIR="$(dirname "$UPG_TODO_FILE")"
if [[ -d "$TODO_DIR/templates" ]]; then
    # Check if global template is newer or different
    if [[ -f "$CLEO_HOME/templates/AGENT-INJECTION.md" ]] && \
       [[ -f "$TODO_DIR/templates/AGENT-INJECTION.md" ]]; then
        if ! diff -q "$CLEO_HOME/templates/AGENT-INJECTION.md" "$TODO_DIR/templates/AGENT-INJECTION.md" &>/dev/null; then
            TEMPLATE_SYNC_NEEDED=true
            UPDATES_NEEDED["templates"]="sync needed"
            (( ++TOTAL_UPDATES ))
        fi
    elif [[ -f "$CLEO_HOME/templates/AGENT-INJECTION.md" ]]; then
        # Global template exists but project template missing
        TEMPLATE_SYNC_NEEDED=true
        UPDATES_NEEDED["templates"]="missing"
        (( ++TOTAL_UPDATES ))
    fi
elif [[ -f "$CLEO_HOME/templates/AGENT-INJECTION.md" ]]; then
    # Templates directory doesn't exist but global template does
    TEMPLATE_SYNC_NEEDED=true
    UPDATES_NEEDED["templates"]="directory missing"
    (( ++TOTAL_UPDATES ))
fi

# Check agent-outputs directory migration (T2363)
# Part of Cross-Agent Communication Protocol Unification (T2348)
AGENT_OUTPUTS_MIGRATION_NEEDED=false
if type check_agent_outputs_migration_needed &>/dev/null; then
    if check_agent_outputs_migration_needed "."; then
        AGENT_OUTPUTS_MIGRATION_NEEDED=true
        UPDATES_NEEDED["agent-outputs"]="research-outputs/ → agent-outputs/"
        (( ++TOTAL_UPDATES ))
    fi
fi

# ============================================================================
# STATUS OUTPUT
# ============================================================================
if [[ "$STATUS_ONLY" == "true" ]] || [[ "$DRY_RUN" == "true" ]]; then
    if [[ $TOTAL_UPDATES -eq 0 ]]; then
        if is_json_output; then
            jq -nc '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {format: "json", command: "upgrade", subcommand: "status"},
                success: true,
                upToDate: true,
                message: "Project is up to date",
                installedVersion: $ver
            }' --arg ver "$INSTALLED_VERSION"
        else
            echo "✓ Project is up to date (cleo v$INSTALLED_VERSION)"
        fi
        exit 0
    else
        # Check if any agent config updates are needed
        has_agent_updates=false
        has_schema_updates=false
        for key in "${!UPDATES_NEEDED[@]}"; do
            if [[ "$key" == *"CLAUDE.md"* ]] || [[ "$key" == *"AGENTS.md"* ]] || [[ "$key" == *"GEMINI.md"* ]]; then
                has_agent_updates=true
            else
                has_schema_updates=true
            fi
        done

        # Build suggestion based on what needs updating
        suggestion="Run: cleo upgrade"
        if [[ "$has_agent_updates" == "true" ]] && [[ "$has_schema_updates" == "false" ]]; then
            # Only agent configs need updating
            suggestion="Run: cleo setup-agents --update"
        elif [[ "$has_agent_updates" == "true" ]] && [[ "$has_schema_updates" == "true" ]]; then
            # Both need updating - suggest upgrade first, then setup-agents
            suggestion="Run: cleo upgrade && cleo setup-agents --update"
        fi

        if is_json_output; then
            updates_json=$(for key in "${!UPDATES_NEEDED[@]}"; do
                echo "{\"component\": \"$key\", \"update\": \"${UPDATES_NEEDED[$key]}\"}"
            done | jq -s '.')

            jq -nc '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {format: "json", command: "upgrade", subcommand: "status"},
                success: true,
                upToDate: false,
                updatesNeeded: $count,
                updates: $updates,
                suggestion: $suggestion
            }' --argjson count "$TOTAL_UPDATES" --argjson updates "$updates_json" --arg suggestion "$suggestion"
        else
            echo "Project needs updates ($TOTAL_UPDATES):"
            echo ""
            for key in "${!UPDATES_NEEDED[@]}"; do
                echo "  • $key: ${UPDATES_NEEDED[$key]}"
            done
            echo ""
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "$suggestion"
            fi
        fi

        [[ "$STATUS_ONLY" == "true" ]] && exit 0
        [[ "$DRY_RUN" == "true" ]] && exit 0
    fi
fi

# ============================================================================
# CONFIRMATION
# ============================================================================
if [[ $TOTAL_UPDATES -eq 0 ]]; then
    # Even if no schema updates needed, ensure project-info.json exists (legacy project upgrade)
    update_project_registration || true

    if ! is_json_output; then
        echo "✓ Project is up to date (cleo v$INSTALLED_VERSION)"
    fi
    exit 0
fi

if [[ "$FORCE" != "true" ]] && ! is_json_output; then
    echo "Project needs updates ($TOTAL_UPDATES):"
    echo ""
    for key in "${!UPDATES_NEEDED[@]}"; do
        echo "  • $key: ${UPDATES_NEEDED[$key]}"
    done
    echo ""
    read -p "Apply updates? [y/N] " -r
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Upgrade cancelled."
        exit 0
    fi
    echo ""
fi

# ============================================================================
# CREATE BACKUP
# ============================================================================
if ! is_json_output; then
    echo "Creating backup..."
fi

BACKUP_DIR=".cleo/backups/upgrade"
mkdir -p "$BACKUP_DIR"
BACKUP_NAME="pre-upgrade_$(date +%Y%m%d_%H%M%S)"

for file in "$UPG_TODO_FILE" "$UPG_CONFIG_FILE" "$UPG_ARCHIVE_FILE" "$UPG_LOG_FILE"; do
    if [[ -f "$file" ]]; then
        cp "$file" "$BACKUP_DIR/$(basename "$file").$BACKUP_NAME"
    fi
done

if ! is_json_output; then
    echo "✓ Backup created: $BACKUP_DIR/*.$BACKUP_NAME"
fi

# ============================================================================
# APPLY UPDATES
# ============================================================================
UPDATES_APPLIED=0
ERRORS=()

# 1. Fix legacy structure (top-level phases, string project)
LEGACY_TODO_FIXED=false
if [[ -n "${UPDATES_NEEDED[todo]:-}" ]] && [[ "${UPDATES_NEEDED[todo]}" == *"legacy"* ]]; then
    if ! is_json_output; then
        echo "Repairing legacy structure..."
    fi

    # Remove top-level phases if exists
    if jq -e 'has("phases")' "$UPG_TODO_FILE" >/dev/null 2>&1; then
        _upg_content=$(jq 'del(.phases)' "$UPG_TODO_FILE")
        _upg_tmp=$(mktemp "${UPG_TODO_FILE}.XXXXXX")
        echo "$_upg_content" > "$_upg_tmp" && mv "$_upg_tmp" "$UPG_TODO_FILE" || rm -f "$_upg_tmp"
    fi

    # Remove top-level checksum if exists
    if jq -e 'has("checksum")' "$UPG_TODO_FILE" >/dev/null 2>&1; then
        _upg_content2=$(jq 'del(.checksum)' "$UPG_TODO_FILE")
        _upg_tmp2=$(mktemp "${UPG_TODO_FILE}.XXXXXX")
        echo "$_upg_content2" > "$_upg_tmp2" && mv "$_upg_tmp2" "$UPG_TODO_FILE" || rm -f "$_upg_tmp2"
    fi

    LEGACY_TODO_FIXED=true
    (( ++UPDATES_APPLIED ))
fi

# 2. Run schema migrations
if type ensure_compatible_version &>/dev/null; then
    for file_spec in "todo:$UPG_TODO_FILE" "config:$UPG_CONFIG_FILE" "archive:$UPG_ARCHIVE_FILE" "log:$UPG_LOG_FILE"; do
        IFS=':' read -r file_type file_path <<< "$file_spec"
        [[ ! -f "$file_path" ]] && continue

        # Run migration if:
        # 1. Updates are needed for this file type, OR
        # 2. This is todo.json and we just fixed legacy structure (needs schema version field)
        needs_migration=false
        if [[ -n "${UPDATES_NEEDED[$file_type]:-}" ]]; then
            # Has updates needed (could be legacy or schema version)
            needs_migration=true
        fi
        if [[ "$file_type" == "todo" ]] && [[ "$LEGACY_TODO_FIXED" == "true" ]]; then
            # Legacy structure was fixed, need to run migration to add _meta.schemaVersion
            needs_migration=true
        fi

        if [[ "$needs_migration" == "true" ]]; then
            if ! is_json_output; then
                echo "Migrating $file_type..."
            fi
            # Use ensure_compatible_version from migrate.sh for all file types
            if ensure_compatible_version "$file_path" "$file_type"; then
                (( ++UPDATES_APPLIED ))
            else
                ERRORS+=("$file_type migration failed")
            fi
        fi
    done
fi

# 2.5. Bootstrap sequence file (T1544 - ID Integrity System)
# For projects created before v0.51.1 (no .sequence file), create it from existing tasks
CLEO_DIR="$(dirname "$UPG_TODO_FILE")"
SEQUENCE_FILE="$CLEO_DIR/.sequence"
if [[ ! -f "$SEQUENCE_FILE" ]]; then
    if ! is_json_output; then
        echo "Bootstrapping sequence file..."
    fi

    # Source sequence library if available
    if [[ -f "$LIB_DIR/sequence.sh" ]]; then
        source "$LIB_DIR/sequence.sh"

        # recover_sequence scans todo + archive and creates .sequence
        if recover_sequence 2>/dev/null; then
            (( ++UPDATES_APPLIED ))
            if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
                _SEQ_COUNTER=$(jq -r '.counter' "$SEQUENCE_FILE" 2>/dev/null || echo "0")
                echo "  Created .sequence with counter $_SEQ_COUNTER"
            fi
        else
            ERRORS+=("Sequence bootstrap failed")
        fi
    else
        # Fallback: create basic sequence file manually
        _MAX_TODO=$(jq -r '[.tasks[].id // empty | ltrimstr("T") | tonumber] | max // 0' "$UPG_TODO_FILE" 2>/dev/null || echo "0")
        _MAX_ARCHIVE=$(jq -r '[.archivedTasks[].id // empty | ltrimstr("T") | tonumber] | max // 0' "$UPG_ARCHIVE_FILE" 2>/dev/null || echo "0")
        _MAX_ID=$(( _MAX_TODO > _MAX_ARCHIVE ? _MAX_TODO : _MAX_ARCHIVE ))
        _CHECKSUM=$(echo -n "$_MAX_ID" | sha256sum | cut -c1-8)
        _TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

        cat > "$SEQUENCE_FILE" << EOF
{
  "counter": $_MAX_ID,
  "lastId": $([ $_MAX_ID -gt 0 ] && printf '"T%03d"' $_MAX_ID || echo 'null'),
  "checksum": "$_CHECKSUM",
  "updatedAt": "$_TIMESTAMP",
  "recoveredAt": "$_TIMESTAMP"
}
EOF
        (( ++UPDATES_APPLIED ))
        if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
            echo "  Created .sequence with counter $_MAX_ID (fallback)"
        fi
    fi
fi

# 3. Recalculate checksum
if [[ -n "${UPDATES_NEEDED[checksum]:-}" ]] || [[ $UPDATES_APPLIED -gt 0 ]]; then
    if ! is_json_output; then
        echo "Recalculating checksum..."
    fi

    NEW_CHECKSUM=$(jq -c '.tasks' "$UPG_TODO_FILE" | sha256sum | cut -c1-16)
    TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    jq --arg cs "$NEW_CHECKSUM" --arg ts "$TIMESTAMP" '
        ._meta.checksum = $cs |
        .lastUpdated = $ts
    ' "$UPG_TODO_FILE" > "$UPG_TODO_FILE.tmp" && mv "$UPG_TODO_FILE.tmp" "$UPG_TODO_FILE"

    (( ++UPDATES_APPLIED ))
fi

# 4. Update agent documentation injections (GLOBAL + PROJECT)
# Check if any agent docs need updating by iterating over UPDATES_NEEDED
agent_docs_updated=false
for key in "${!UPDATES_NEEDED[@]}"; do
    case "$key" in
        CLAUDE.md|AGENTS.md|GEMINI.md)
            agent_docs_updated=true
            break
            ;;
    esac
done

if [[ "$agent_docs_updated" == true ]]; then
    if ! is_json_output; then
        echo "Updating agent documentation files..."
    fi

    # Track totals across global and project files
    total_updated=0
    total_skipped=0
    total_failed=0

    # 4a. Update PROJECT agent docs (CLAUDE.md, AGENTS.md, GEMINI.md in project root)
    if type injection_update_all &>/dev/null; then
        result=$(injection_update_all ".")
        updated=$(echo "$result" | jq -r '.updated')
        skipped=$(echo "$result" | jq -r '.skipped')
        failed=$(echo "$result" | jq -r '.failed')

        (( total_updated += updated ))
        (( total_skipped += skipped ))
        (( total_failed += failed ))

        if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
            if [[ "$updated" -gt 0 ]]; then
                echo "  Project: Updated $updated file(s)"
            fi
            if [[ "$skipped" -gt 0 ]]; then
                echo "  Project: Skipped $skipped file(s) (already up-to-date)"
            fi
        fi
    else
        ERRORS+=("Injection library not available")
        agent_docs_updated=false  # Prevent global updates if library missing
    fi

    # 4b. Update GLOBAL agent docs (~/.claude/CLAUDE.md, etc.)
    if [[ "$agent_docs_updated" == true ]] && type ar_list_installed &>/dev/null; then
        global_updated=0
        global_skipped=0
        global_failed=0

        # Get list of installed agents
        installed_agents=$(ar_list_installed)

        for agent_id in $installed_agents; do
            global_file=$(ar_get_global_instruction_path "$agent_id" 2>/dev/null)

            if [[ -z "$global_file" ]]; then
                continue
            fi

            # Check if update needed
            needs_update=false
            if [[ ! -f "$global_file" ]]; then
                needs_update=true
            else
                status_json=$(injection_check "$global_file" 2>/dev/null || echo '{"status":"unknown"}')
                status=$(echo "$status_json" | grep -oP '"status":"\K[^"]+' || echo "unknown")

                if [[ "$status" != "current" ]]; then
                    needs_update=true
                fi
            fi

            if [[ "$needs_update" == true ]]; then
                # Update global file
                if update_result=$(injection_update "$global_file" 2>&1); then
                    (( ++global_updated ))
                    if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
                        echo "  Global: Updated $global_file"
                    fi
                else
                    (( ++global_failed ))
                    if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
                        echo "  Global: Failed to update $global_file" >&2
                    fi
                fi
            else
                (( ++global_skipped ))
            fi
        done

        (( total_updated += global_updated ))
        (( total_skipped += global_skipped ))
        (( total_failed += global_failed ))

        if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
            if [[ "$global_updated" -gt 0 ]]; then
                echo "  Global: Updated $global_updated file(s)"
            fi
            if [[ "$global_skipped" -gt 0 ]]; then
                echo "  Global: Skipped $global_skipped file(s) (already up-to-date)"
            fi
        fi
    fi

    # Update totals and report
    if [[ "$total_updated" -gt 0 ]]; then
        (( UPDATES_APPLIED += total_updated ))
        if ! is_json_output && ! [[ "$VERBOSE" == "true" ]]; then
            echo "  Updated $total_updated agent doc file(s)"
        fi
    fi

    if [[ "$total_failed" -gt 0 ]]; then
        ERRORS+=("Agent docs: $total_failed file(s) failed to update")
    fi

    # Only error if we expected updates but got none AND had no skips
    if [[ "$total_updated" -eq 0 ]] && [[ "$total_skipped" -eq 0 ]] && [[ "$total_failed" -eq 0 ]]; then
        ERRORS+=("Agent docs update completed with no files processed")
    fi
fi

# Update project registry with fresh metadata (always run, even if no migrations needed)
# This ensures project-info.json is created for legacy projects
update_project_registration || true

# 5. Sync templates if needed (T1595)
if [[ "$TEMPLATE_SYNC_NEEDED" == "true" ]]; then
    if ! is_json_output; then
        echo "Syncing templates..."
    fi

    # Create templates directory if missing
    if [[ ! -d "$TODO_DIR/templates" ]]; then
        mkdir -p "$TODO_DIR/templates"
        if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
            echo "  Created $TODO_DIR/templates/"
        fi
    fi

    # Copy AGENT-INJECTION.md template
    if [[ -f "$CLEO_HOME/templates/AGENT-INJECTION.md" ]]; then
        if cp "$CLEO_HOME/templates/AGENT-INJECTION.md" "$TODO_DIR/templates/"; then
            (( ++UPDATES_APPLIED ))
            if ! is_json_output; then
                echo "  Synced AGENT-INJECTION.md template"
            fi
        else
            ERRORS+=("Failed to sync AGENT-INJECTION.md template")
        fi
    fi
fi

# 6. Update skill versions (T1729)
if [[ -n "${UPDATES_NEEDED[skills]:-}" ]] && type apply_skill_updates &>/dev/null; then
    if ! is_json_output; then
        echo "Checking skill versions..."
    fi

    _skill_update_count=$(echo "$SKILL_UPDATES_JSON" | jq 'length' 2>/dev/null || echo "0")

    if [[ "$_skill_update_count" -gt 0 ]]; then
        if ! is_json_output; then
            echo "Found $_skill_update_count skill update(s)"
            format_skill_updates "$SKILL_UPDATES_JSON"
        fi

        _applied_count=$(apply_skill_updates "$SKILL_UPDATES_JSON")

        if [[ "$_applied_count" -gt 0 ]]; then
            (( UPDATES_APPLIED += _applied_count ))
            if ! is_json_output; then
                echo "Updated $_applied_count skill(s)"
            fi
        else
            ERRORS+=("Failed to apply skill updates")
        fi
    else
        if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
            echo "All skills up to date"
        fi
    fi
fi

# 7. Migrate agent-outputs directory (T2363)
# Part of Cross-Agent Communication Protocol Unification (T2348)
if [[ "$AGENT_OUTPUTS_MIGRATION_NEEDED" == "true" ]] && type migrate_agent_outputs_dir &>/dev/null; then
    if ! is_json_output; then
        echo "Migrating agent outputs directory..."
    fi

    migration_result=0
    migrate_agent_outputs_dir "." || migration_result=$?

    case $migration_result in
        0)
            (( ++UPDATES_APPLIED ))
            if ! is_json_output; then
                echo "  Migrated research-outputs/ → agent-outputs/"
            fi
            ;;
        100)
            # Already migrated or nothing to do - not an error
            if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
                echo "  Agent outputs directory already migrated"
            fi
            ;;
        *)
            ERRORS+=("Agent outputs migration failed")
            ;;
    esac
fi

# ============================================================================
# STATUSLINE INTEGRATION CHECK
# ============================================================================
if [[ -f "$LIB_DIR/statusline-setup.sh" ]]; then
    source "$LIB_DIR/statusline-setup.sh"

    if ! is_json_output; then
        echo "Checking statusline integration..."
    fi

    if ! check_statusline_integration; then
        if [[ "$DRY_RUN" == "true" ]]; then
            if ! is_json_output; then
                echo "  Would setup statusline integration"
            fi
        elif [[ "$FORCE" == "true" ]]; then
            install_statusline_integration "install" "false" && (( ++UPDATES_APPLIED )) || ERRORS+=("Statusline setup failed")
        else
            install_statusline_integration "install" "true" && (( ++UPDATES_APPLIED )) || true
        fi
    fi
fi

# ============================================================================
# VALIDATION
# ============================================================================
if ! is_json_output; then
    echo "Validating..."
fi

VALID=true
if [[ -x "$UPG_SCRIPT_DIR/validate.sh" ]]; then
    # Run validation with inherited format flags
    # In human mode: show summary output
    # In JSON mode: suppress (we include valid status in our own output)
    if is_json_output; then
        # JSON mode: suppress nested output, just check exit code
        if ! "$UPG_SCRIPT_DIR/validate.sh" $(get_passthrough_flags --quiet) >/dev/null 2>&1; then
            VALID=false
            ERRORS+=("Validation failed after upgrade")
        fi
    else
        # Human mode: show validation output (but use --quiet to reduce verbosity)
        if ! "$UPG_SCRIPT_DIR/validate.sh" $(get_passthrough_flags --quiet) 2>&1; then
            VALID=false
            ERRORS+=("Validation failed after upgrade")
        fi
    fi
fi

# ============================================================================
# OUTPUT RESULT
# ============================================================================
if is_json_output; then
    # Build errors array properly (avoid empty string)
    errors_json="[]"
    if [[ ${#ERRORS[@]} -gt 0 ]]; then
        errors_json=$(printf '%s\n' "${ERRORS[@]}" | jq -R 'select(length > 0)' | jq -s '.')
    fi

    jq -nc '{
        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
        "_meta": {format: "json", command: "upgrade", timestamp: $ts},
        success: ($errors | length == 0),
        updatesApplied: $applied,
        valid: $valid,
        errors: $errors,
        backupPath: $backup
    }' \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson applied "$UPDATES_APPLIED" \
        --argjson valid "$VALID" \
        --argjson errors "$errors_json" \
        --arg backup "$BACKUP_DIR/*.$BACKUP_NAME"
else
    echo ""
    if [[ ${#ERRORS[@]} -eq 0 ]]; then
        echo "✓ Upgrade complete ($UPDATES_APPLIED updates applied)"
        echo "  Backup: $BACKUP_DIR/*.$BACKUP_NAME"
    else
        echo "⚠ Upgrade completed with errors:"
        for err in "${ERRORS[@]}"; do
            echo "  • $err"
        done
        exit 1
    fi
fi

exit 0
