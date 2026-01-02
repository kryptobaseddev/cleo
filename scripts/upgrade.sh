#!/usr/bin/env bash
# ============================================================================
# scripts/upgrade.sh - Unified project upgrade command
# ============================================================================
# Single command to detect and fix all project-level issues:
# - Schema migrations
# - Structural repairs (phases, checksums)
# - CLAUDE.md injection updates
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

# Fallback for is_json_output if not available
if ! type is_json_output &>/dev/null; then
    is_json_output() {
        [[ ! -t 1 ]] || [[ "${CLEO_OUTPUT_FORMAT:-}" == "json" ]]
    }
fi

# ============================================================================
# DEFAULTS
# ============================================================================
DRY_RUN=false
FORCE=false
STATUS_ONLY=false
VERBOSE=false

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
    -h, --help      Show this help

WHAT IT DOES:
    1. Migrates schemas (todo.json, config.json, log, archive)
    2. Repairs structural issues (phases, checksums)
    3. Updates CLAUDE.md injection to current version
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

# ============================================================================
# PROJECT DETECTION
# ============================================================================
UPG_TODO_FILE="./.cleo/todo.json"
UPG_CONFIG_FILE="./.cleo/config.json"
UPG_ARCHIVE_FILE="./.cleo/todo-archive.json"
UPG_LOG_FILE="./.cleo/todo-log.json"
UPG_CLAUDE_MD="./CLAUDE.md"

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
    current=$(jq -r '.version // ._meta.schemaVersion // "unknown"' "$file" 2>/dev/null)

    # Check for legacy structure
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

        if [[ "$has_legacy" == "true" ]]; then
            UPDATES_NEEDED["$file_type"]="legacy → $expected (structural repair needed)"
            ((TOTAL_UPDATES++))
            return 1
        fi
    fi

    if [[ "$current" != "$expected" ]]; then
        UPDATES_NEEDED["$file_type"]="$current → $expected"
        ((TOTAL_UPDATES++))
        return 1
    fi

    return 0
}

check_claude_md_status() {
    [[ ! -f "$UPG_CLAUDE_MD" ]] && return 0

    local injection_version
    injection_version=$(grep -oP 'CLEO:START v\K[0-9.]+' "$UPG_CLAUDE_MD" 2>/dev/null || echo "none")

    if [[ "$injection_version" == "none" ]]; then
        # No injection present - might want to add
        return 0
    fi

    if [[ "$injection_version" != "$INSTALLED_VERSION" ]]; then
        UPDATES_NEEDED["CLAUDE.md"]="$injection_version → $INSTALLED_VERSION"
        ((TOTAL_UPDATES++))
        return 1
    fi

    return 0
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
# RUN STATUS CHECKS
# ============================================================================
check_schema_status "$UPG_TODO_FILE" "todo" "${SCHEMA_VERSION_TODO:-2.4.0}" || true
check_schema_status "$UPG_CONFIG_FILE" "config" "${SCHEMA_VERSION_CONFIG:-2.2.0}" || true
check_schema_status "$UPG_ARCHIVE_FILE" "archive" "2.1.0" || true
check_schema_status "$UPG_LOG_FILE" "log" "2.1.0" || true
check_claude_md_status || true
check_checksum_status || true

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
                suggestion: "Run: cleo upgrade"
            }' --argjson count "$TOTAL_UPDATES" --argjson updates "$updates_json"
        else
            echo "Project needs updates ($TOTAL_UPDATES):"
            echo ""
            for key in "${!UPDATES_NEEDED[@]}"; do
                echo "  • $key: ${UPDATES_NEEDED[$key]}"
            done
            echo ""
            if [[ "$DRY_RUN" == "true" ]]; then
                echo "Run 'cleo upgrade' to apply these updates."
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
if type migrate_file &>/dev/null; then
    for file_spec in "todo:$UPG_TODO_FILE" "config:$UPG_CONFIG_FILE" "archive:$UPG_ARCHIVE_FILE" "log:$UPG_LOG_FILE"; do
        IFS=':' read -r file_type file_path <<< "$file_spec"
        [[ ! -f "$file_path" ]] && continue

        if [[ -n "${UPDATES_NEEDED[$file_type]:-}" ]] && [[ "${UPDATES_NEEDED[$file_type]}" != *"legacy"* ]]; then
            if ! is_json_output; then
                echo "Migrating $file_type..."
            fi
            # Use migrate functions if available
            if type migrate_todo_file &>/dev/null && [[ "$file_type" == "todo" ]]; then
                migrate_todo_file "$file_path" 2>/dev/null && ((UPDATES_APPLIED++)) || ERRORS+=("$file_type migration failed")
            fi
        fi
    done
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

# 4. Update CLAUDE.md injection
if [[ -n "${UPDATES_NEEDED[CLAUDE.md]:-}" ]]; then
    if ! is_json_output; then
        echo "Updating CLAUDE.md..."
    fi

    # Use init script's update function if available
    if [[ -x "$UPG_SCRIPT_DIR/init.sh" ]]; then
        "$UPG_SCRIPT_DIR/init.sh" --update-claude-md >/dev/null 2>&1 && ((UPDATES_APPLIED++)) || ERRORS+=("CLAUDE.md update failed")
    fi
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
            install_statusline_integration "install" "false" && ((UPDATES_APPLIED++)) || ERRORS+=("Statusline setup failed")
        else
            install_statusline_integration "install" "true" && ((UPDATES_APPLIED++)) || true
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
