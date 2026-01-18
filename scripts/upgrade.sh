#!/usr/bin/env bash
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
source "$LIB_DIR/project-registry.sh" 2>/dev/null || true

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
VERSION=$(cat "$CLEO_HOME/VERSION" 2>/dev/null || echo "0.50.2")
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
    3. Updates agent docs injections (CLAUDE.md, AGENTS.md, GEMINI.md)
    4. Sets up Claude Code statusline for context monitoring
    5. Validates the result

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
INSTALLED_VERSION=$(cat "$CLEO_HOME/VERSION" 2>/dev/null || echo "unknown")

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
            ((TOTAL_UPDATES++))
            return 1
        fi
    fi

    # If schemaVersion missing but no legacy structure, still needs update
    if [[ "$schema_missing" == "true" ]]; then
        UPDATES_NEEDED["$file_type"]="missing → $expected"
        ((TOTAL_UPDATES++))
        return 1
    fi

    if [[ "$current" != "$expected" ]]; then
        UPDATES_NEEDED["$file_type"]="$current → $expected"
        ((TOTAL_UPDATES++))
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
                ((TOTAL_UPDATES++))
                ;;
            outdated|legacy)
                UPDATES_NEEDED["$target"]="$current_version → $installed_version"
                ((TOTAL_UPDATES++))
                ;;
            none)
                UPDATES_NEEDED["$target"]="none → $installed_version"
                ((TOTAL_UPDATES++))
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
        ((TOTAL_UPDATES++))
        return 1
    fi

    return 0
}

# ============================================================================
# PROJECT REGISTRY UPDATE
# ============================================================================
# Update project registration after successful migrations
# Refreshes metadata: lastSeen, schema versions, injection status, health
update_project_registration() {
    # Skip if registry functions not available
    if ! type generate_project_hash &>/dev/null; then
        return 0
    fi

    local project_hash registry

    project_hash=$(generate_project_hash "$PWD") || return 0
    registry="$(get_cleo_home)/projects-registry.json"

    # Create registry if missing
    if [[ ! -f "$registry" ]]; then
        create_empty_registry "$registry" || return 0
    fi

    # If project not registered, perform initial registration (fixes existing projects)
    if ! is_project_registered "$project_hash"; then
        local project_path project_name timestamp
        local todo_version config_version archive_version log_version

        project_path="$PWD"
        project_name="$(basename "$project_path")"
        timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

        # Get schema versions
        todo_version=$(get_schema_version_from_file "todo" 2>/dev/null || echo "unknown")
        config_version=$(get_schema_version_from_file "config" 2>/dev/null || echo "unknown")
        archive_version=$(get_schema_version_from_file "archive" 2>/dev/null || echo "unknown")
        log_version=$(get_schema_version_from_file "log" 2>/dev/null || echo "unknown")

        # Get injection status
        local injection_status injection_obj
        injection_status=$(injection_check_all 2>/dev/null || echo "[]")
        injection_obj=$(echo "$injection_status" | jq 'reduce .[] as $item ({}; .[$item.target] = {version: $item.currentVersion, status: $item.status})')

        # Register project with atomic write
        local reg_temp
        reg_temp=$(mktemp)
        trap "rm -f $reg_temp" RETURN

        jq --arg hash "$project_hash" \
           --arg path "$project_path" \
           --arg name "$project_name" \
           --arg version "$VERSION" \
           --arg timestamp "$timestamp" \
           --arg todo_v "$todo_version" \
           --arg config_v "$config_version" \
           --arg archive_v "$archive_version" \
           --arg log_v "$log_version" \
           --argjson injection "$injection_obj" \
           '.projects[$hash] = {
               hash: $hash,
               path: $path,
               name: $name,
               registeredAt: $timestamp,
               lastSeen: $timestamp,
               cleoVersion: $version,
               schemas: {
                   todo: $todo_v,
                   config: $config_v,
                   archive: $archive_v,
                   log: $log_v
               },
               injection: $injection,
               health: {
                   status: "healthy",
                   lastCheck: $timestamp,
                   issues: []
               }
           } | .lastUpdated = $timestamp' "$registry" > "$reg_temp"

        if ! save_json "$registry" < "$reg_temp"; then
            # Non-fatal - continue to update attempt
            if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
                echo "  Warning: Failed to register project in registry" >&2
            fi
        else
            if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
                echo "  Registered project in global registry"
            fi
        fi

        # Continue to update section below
    fi

    # Extract current schema versions
    local todo_version config_version archive_version log_version
    todo_version=$(get_schema_version_from_file "todo" 2>/dev/null || echo "unknown")
    config_version=$(get_schema_version_from_file "config" 2>/dev/null || echo "unknown")
    archive_version=$(get_schema_version_from_file "archive" 2>/dev/null || echo "unknown")
    log_version=$(get_schema_version_from_file "log" 2>/dev/null || echo "unknown")

    # Extract injection versions for all three agent files
    local claude_version agents_version gemini_version
    claude_version=$(injection_extract_version "CLAUDE.md" 2>/dev/null || echo "none")
    agents_version=$(injection_extract_version "AGENTS.md" 2>/dev/null || echo "none")
    gemini_version=$(injection_extract_version "GEMINI.md" 2>/dev/null || echo "none")

    # Update registry with fresh metadata
    local upd_temp
    upd_temp=$(mktemp)
    trap "rm -f $upd_temp" RETURN

    jq --arg hash "$project_hash" \
       --arg todo_ver "$todo_version" \
       --arg config_ver "$config_version" \
       --arg archive_ver "$archive_version" \
       --arg log_ver "$log_version" \
       --arg claude_ver "$claude_version" \
       --arg agents_ver "$agents_version" \
       --arg gemini_ver "$gemini_version" \
       '.projects[$hash].lastSeen = (now | todate) |
        .projects[$hash].schemas = {
            todo: $todo_ver,
            config: $config_ver,
            archive: $archive_ver,
            log: $log_ver
        } |
        .projects[$hash].injection = {
            "CLAUDE.md": $claude_ver,
            "AGENTS.md": $agents_ver,
            "GEMINI.md": $gemini_ver
        } |
        .projects[$hash].health.status = "healthy" |
        .projects[$hash].health.lastCheck = (now | todate)' \
        "$registry" > "$upd_temp"

    # Save atomically
    if save_json "$registry" < "$upd_temp"; then
        if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
            echo "  Updated project registry metadata"
        fi
        return 0
    else
        # Non-fatal error - registry update is optional
        if ! is_json_output && [[ "$VERBOSE" == "true" ]]; then
            echo "  Warning: Failed to update project registry" >&2
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

# Check sequence file status (T1544)
_SEQ_FILE="$(dirname "$UPG_TODO_FILE")/.sequence"
if [[ ! -f "$_SEQ_FILE" ]]; then
    UPDATES_NEEDED["sequence"]="missing"
    (( ++TOTAL_UPDATES ))
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
if [[ -n "${UPDATES_NEEDED[todo]:-}" ]] && [[ "${UPDATES_NEEDED[todo]}" == *"legacy"* ]]; then
    if ! is_json_output; then
        echo "Repairing legacy structure..."
    fi

    # Remove top-level phases if exists
    if jq -e 'has("phases")' "$UPG_TODO_FILE" >/dev/null 2>&1; then
        jq 'del(.phases)' "$UPG_TODO_FILE" > "$UPG_TODO_FILE.tmp" && mv "$UPG_TODO_FILE.tmp" "$UPG_TODO_FILE"
    fi

    # Remove top-level checksum if exists
    if jq -e 'has("checksum")' "$UPG_TODO_FILE" >/dev/null 2>&1; then
        jq 'del(.checksum)' "$UPG_TODO_FILE" > "$UPG_TODO_FILE.tmp" && mv "$UPG_TODO_FILE.tmp" "$UPG_TODO_FILE"
    fi

    (( ++UPDATES_APPLIED ))
fi

# 2. Run schema migrations
if type ensure_compatible_version &>/dev/null; then
    for file_spec in "todo:$UPG_TODO_FILE" "config:$UPG_CONFIG_FILE" "archive:$UPG_ARCHIVE_FILE" "log:$UPG_LOG_FILE"; do
        IFS=':' read -r file_type file_path <<< "$file_spec"
        [[ ! -f "$file_path" ]] && continue

        if [[ -n "${UPDATES_NEEDED[$file_type]:-}" ]] && [[ "${UPDATES_NEEDED[$file_type]}" != *"legacy"* ]]; then
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

# 4. Update agent documentation injections
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

    # Use injection library to update all agent docs
    if type injection_update_all &>/dev/null; then
        result=$(injection_update_all ".")
        updated=$(echo "$result" | jq -r '.updated')

        if [[ "$updated" -gt 0 ]]; then
            (( UPDATES_APPLIED += updated ))
        else
            ERRORS+=("Agent docs update completed with 0 updates")
        fi
    else
        ERRORS+=("Injection library not available")
    fi

    # Update project registry with fresh metadata
    update_project_registration || true
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
    if ! "$UPG_SCRIPT_DIR/validate.sh" --quiet 2>/dev/null; then
        VALID=false
        ERRORS+=("Validation failed after upgrade")
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
