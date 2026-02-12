#!/usr/bin/env bash
###CLEO
# command: claude-migrate
# category: maintenance
# synopsis: Detect and migrate legacy claude-todo installations to CLEO format
# relevance: low
# flags: --format,--verbose,--check,--global,--project,--all
# exits: 0,1,2,3,4
# json-output: true
# note: Run with --check first to detect legacy installations
###END
# CLEO Migration Command - claude-migrate
# Detects and migrates legacy claude-todo installations to CLEO format
#
# Usage:
#   cleo claude-migrate --check         # Detect legacy (no changes)
#   cleo claude-migrate --global        # Migrate ~/.claude-todo → ~/.cleo
#   cleo claude-migrate --project       # Migrate .claude → .cleo
#   cleo claude-migrate --all           # Migrate both
#
# Exit Codes (--check mode):
#   0 = Legacy installation found (migration needed)
#   1 = No legacy installation (already clean)
#   2 = Error during detection
#
# Exit Codes (migration modes):
#   0 = Migration successful
#   1 = No legacy found (nothing to migrate)
#   2 = Backup failed
#   3 = Rename failed
#   4 = Validation failed
#
# Version: 1.0.0 (CLEO v1.0.0)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source required libraries
if [[ -f "$LIB_DIR/core/paths.sh" ]]; then
    # shellcheck source=../lib/core/paths.sh
    source "$LIB_DIR/core/paths.sh"
else
    echo '{"error":"paths.sh not found","code":2}' >&2
    exit 2
fi

if [[ -f "$LIB_DIR/core/output-format.sh" ]]; then
    # shellcheck source=../lib/core/output-format.sh
    source "$LIB_DIR/core/output-format.sh"
fi

if [[ -f "$LIB_DIR/core/logging.sh" ]]; then
    # shellcheck source=../lib/core/logging.sh
    source "$LIB_DIR/core/logging.sh"
fi

# Source centralized flag parsing
source "$LIB_DIR/ui/flags.sh"

# Suppress migration warnings in this script (we're handling migration explicitly)
suppress_migration_warnings

# =============================================================================
# EXIT CODES
# =============================================================================

readonly MIGRATE_SUCCESS=0
readonly MIGRATE_NO_LEGACY=1
readonly MIGRATE_BACKUP_FAILED=2
readonly MIGRATE_RENAME_FAILED=3
readonly MIGRATE_VALIDATION_FAILED=4

# For --check mode (grep-like semantics)
readonly CHECK_LEGACY_FOUND=0
readonly CHECK_NO_LEGACY=1
readonly CHECK_ERROR=2

# =============================================================================
# GLOBALS
# =============================================================================

FORMAT=""
MODE=""
VERBOSE=false
FORCE=false

# =============================================================================
# USAGE
# =============================================================================

usage() {
    cat << 'EOF'
Usage: cleo claude-migrate [OPTIONS]

Detect and migrate legacy claude-todo installations to CLEO format.

Modes:
  --check            Detect legacy installations (read-only)
  --global           Migrate global: ~/.claude-todo → ~/.cleo
  --project          Migrate project: .claude → .cleo
  --all              Migrate both global and project

Options:
  --format FORMAT    Output format: text, json (default: auto-detect)
  --force            Merge into existing target (backs up target first)
  --verbose, -v      Show detailed output
  --help, -h         Show this help message

Exit Codes (--check):
  0 = Legacy found (migration needed)
  1 = No legacy found (already clean)
  2 = Error during detection

Exit Codes (migration):
  0 = Migration successful
  1 = No legacy found (nothing to migrate)
  2 = Backup failed
  3 = Rename failed
  4 = Validation failed

Examples:
  cleo claude-migrate --check
  cleo claude-migrate --check --format json
  cleo claude-migrate --global
  cleo claude-migrate --project
  cleo claude-migrate --project --force   # Merge if .cleo exists
  cleo claude-migrate --all
EOF
}

# =============================================================================
# DETECTION FUNCTIONS
# =============================================================================

# Detect legacy global installation
# Returns: JSON object with detection results
detect_legacy_global() {
    local legacy_path
    legacy_path=$(get_legacy_global_home)

    if [[ -d "$legacy_path" ]]; then
        local file_count=0
        local has_todo=false
        local has_config=false

        if [[ -f "$legacy_path/todo.json" ]]; then
            has_todo=true
        fi
        if [[ -f "$legacy_path/todo-config.json" ]]; then
            has_config=true
        fi
        if command -v find >/dev/null 2>&1; then
            file_count=$(find "$legacy_path" -type f 2>/dev/null | wc -l | tr -d ' ')
        fi

        printf '{"found":true,"path":"%s","fileCount":%d,"hasTodo":%s,"hasConfig":%s}' \
            "$legacy_path" \
            "$file_count" \
            "$has_todo" \
            "$has_config"
    else
        printf '{"found":false,"path":"%s"}' "$legacy_path"
    fi
}

# Detect legacy project directory
# Returns: JSON object with detection results
detect_legacy_project() {
    local legacy_path
    legacy_path=$(get_legacy_project_dir)

    if [[ -d "$legacy_path" ]]; then
        local file_count=0
        local has_todo=false
        local has_config=false
        local has_log=false
        local has_archive=false

        if [[ -f "$legacy_path/todo.json" ]]; then
            has_todo=true
        fi
        if [[ -f "$legacy_path/todo-config.json" ]]; then
            has_config=true
        fi
        if [[ -f "$legacy_path/todo-log.json" ]]; then
            has_log=true
        fi
        if [[ -f "$legacy_path/todo-archive.json" ]]; then
            has_archive=true
        fi
        if command -v find >/dev/null 2>&1; then
            file_count=$(find "$legacy_path" -type f 2>/dev/null | wc -l | tr -d ' ')
        fi

        printf '{"found":true,"path":"%s","fileCount":%d,"hasTodo":%s,"hasConfig":%s,"hasLog":%s,"hasArchive":%s}' \
            "$legacy_path" \
            "$file_count" \
            "$has_todo" \
            "$has_config" \
            "$has_log" \
            "$has_archive"
    else
        printf '{"found":false,"path":"%s"}' "$legacy_path"
    fi
}

# Detect legacy environment variables
# Returns: JSON object with detection results
detect_legacy_env() {
    local vars_found=()
    local json_vars="[]"

    if [[ -n "${CLAUDE_TODO_HOME:-}" ]]; then
        vars_found+=("CLAUDE_TODO_HOME")
    fi
    if [[ -n "${CLAUDE_TODO_DIR:-}" ]]; then
        vars_found+=("CLAUDE_TODO_DIR")
    fi
    if [[ -n "${CLAUDE_TODO_FORMAT:-}" ]]; then
        vars_found+=("CLAUDE_TODO_FORMAT")
    fi
    if [[ -n "${CLAUDE_TODO_DEBUG:-}" ]]; then
        vars_found+=("CLAUDE_TODO_DEBUG")
    fi

    if [[ ${#vars_found[@]} -gt 0 ]]; then
        local first=true
        local json_array="["
        for var in "${vars_found[@]}"; do
            if [[ "$first" == "true" ]]; then
                first=false
            else
                json_array+=","
            fi
            json_array+="\"$var\""
        done
        json_array+="]"
        json_vars="$json_array"
    fi

    if [[ ${#vars_found[@]} -gt 0 ]]; then
        printf '{"found":true,"count":%d,"variables":%s}' \
            "${#vars_found[@]}" \
            "$json_vars"
    else
        printf '{"found":false,"count":0,"variables":[]}'
    fi
}

# =============================================================================
# CHECK MODE
# =============================================================================

run_check_mode() {
    local global_result project_result env_result
    local global_found=false project_found=false env_found=false
    local any_legacy=false

    # Detect all legacy installations
    global_result=$(detect_legacy_global)
    project_result=$(detect_legacy_project)
    env_result=$(detect_legacy_env)

    # Parse results
    if echo "$global_result" | grep -q '"found":true'; then
        global_found=true
        any_legacy=true
    fi
    if echo "$project_result" | grep -q '"found":true'; then
        project_found=true
        any_legacy=true
    fi
    if echo "$env_result" | grep -q '"found":true'; then
        env_found=true
        any_legacy=true
    fi

    # Build JSON output
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    local json_output
    json_output=$(cat <<EOF
{
  "\$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "command": "claude-migrate --check",
    "timestamp": "${timestamp}",
    "version": "1.0.0"
  },
  "success": true,
  "migrationNeeded": ${any_legacy},
  "global": ${global_result},
  "project": ${project_result},
  "environment": ${env_result}
}
EOF
    )

    # Output based on format
    if is_json_output "$FORMAT"; then
        echo "$json_output"
    else
        # Human-readable output
        echo ""
        echo "CLEO Migration Check"
        echo "===================="
        echo ""

        if [[ "$global_found" == "true" ]]; then
            echo "✗ Global: ~/.claude-todo/ found (legacy)"
            if [[ "$VERBOSE" == "true" ]]; then
                echo "  → Run: cleo claude-migrate --global"
            fi
        else
            echo "✓ Global: ~/.cleo (current)"
        fi

        if [[ "$project_found" == "true" ]]; then
            echo "✗ Project: .claude/ found (legacy)"
            if [[ "$VERBOSE" == "true" ]]; then
                echo "  → Run: cleo claude-migrate --project"
            fi
        else
            echo "✓ Project: .cleo (current)"
        fi

        if [[ "$env_found" == "true" ]]; then
            echo "⚠ Environment: Legacy variables detected"
            if [[ "$VERBOSE" == "true" ]]; then
                echo "  Variables: $(echo "$env_result" | grep -o '"variables":\[[^]]*\]' | sed 's/"variables":\[//;s/\]$//' | tr ',' ' ')"
                echo "  → Update to CLEO_* equivalents"
            fi
        else
            echo "✓ Environment: Clean (no legacy vars)"
        fi

        echo ""
        if [[ "$any_legacy" == "true" ]]; then
            echo "Migration needed. Run: cleo claude-migrate --all"
        else
            echo "No migration needed. System is clean."
        fi
        echo ""
    fi

    # Exit codes per spec
    if [[ "$any_legacy" == "true" ]]; then
        return $CHECK_LEGACY_FOUND
    else
        return $CHECK_NO_LEGACY
    fi
}

# =============================================================================
# GLOBAL MIGRATION MODE (T916)
# =============================================================================

# Create backup of global installation
# Args: $1 = source path
# Note: Backup is created in /tmp first, then moved after migration
create_global_backup() {
    local source_path="$1"
    local timestamp
    timestamp=$(date +%Y%m%d_%H%M%S)
    local temp_backup="/tmp/cleo_migration_backup_${timestamp}.tar.gz"

    if [[ "$VERBOSE" == "true" ]]; then
        echo "Creating backup: $temp_backup"
    fi

    # Create backup using tar to temp location
    if tar -czf "$temp_backup" -C "$(dirname "$source_path")" "$(basename "$source_path")" 2>/dev/null; then
        echo "$temp_backup"
        return 0
    else
        return 1
    fi
}

# Move backup to final location after successful migration
finalize_backup() {
    local temp_backup="$1"
    local target_home="$2"
    local final_backup_dir="${target_home}/backups/migration"
    local final_backup="${final_backup_dir}/$(basename "$temp_backup")"

    mkdir -p "$final_backup_dir"
    if mv "$temp_backup" "$final_backup" 2>/dev/null; then
        echo "$final_backup"
        return 0
    else
        # Keep temp backup if move fails
        echo "$temp_backup"
        return 0
    fi
}

# Migrate global installation: ~/.claude-todo → ~/.cleo
run_global_migration() {
    local legacy_path
    local target_path
    local backup_path

    legacy_path=$(get_legacy_global_home)
    target_path=$(get_cleo_home)

    # Check if legacy exists
    if ! has_legacy_global_installation; then
        if is_json_output "$FORMAT"; then
            printf '{"success":false,"error":"No legacy global installation found","code":%d}\n' "$MIGRATE_NO_LEGACY"
        else
            echo "No legacy global installation found at $legacy_path"
            echo "Nothing to migrate."
        fi
        return $MIGRATE_NO_LEGACY
    fi

    # Check if target already exists
    local target_backup_path=""
    if [[ -d "$target_path" ]]; then
        local file_count
        file_count=$(find "$target_path" -type f 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$file_count" -gt 0 ]]; then
            if [[ "$FORCE" != "true" ]]; then
                if is_json_output "$FORMAT"; then
                    printf '{"success":false,"error":"Target path already exists with data","path":"%s","code":%d,"suggestion":"Use --force to merge"}\n' \
                        "$target_path" "$MIGRATE_VALIDATION_FAILED"
                else
                    echo "Error: Target path $target_path already exists with $file_count files."
                    echo "Use --force to backup existing target and merge legacy data."
                fi
                return $MIGRATE_VALIDATION_FAILED
            else
                # Force mode: backup existing target first
                if ! is_json_output "$FORMAT"; then
                    echo "Target exists with $file_count files. Backing up existing target..."
                fi
                target_backup_path="${target_path}.backup.$(date +%Y%m%d_%H%M%S)"
                if ! cp -r "$target_path" "$target_backup_path" 2>/dev/null; then
                    if is_json_output "$FORMAT"; then
                        printf '{"success":false,"error":"Failed to backup existing target","path":"%s","code":%d}\n' \
                            "$target_path" "$MIGRATE_BACKUP_FAILED"
                    else
                        echo "Error: Failed to backup existing target to $target_backup_path"
                    fi
                    return $MIGRATE_BACKUP_FAILED
                fi
                if ! is_json_output "$FORMAT"; then
                    echo "  ✓ Existing target backed up to: $target_backup_path"
                fi
            fi
        fi
    fi

    # Create backup first
    if is_json_output "$FORMAT"; then
        : # JSON output will be at the end
    else
        echo ""
        echo "CLEO Global Migration"
        echo "====================="
        echo ""
        echo "Source: $legacy_path"
        echo "Target: $target_path"
        echo ""
        echo "Step 1/4: Creating backup..."
    fi

    backup_path=$(create_global_backup "$legacy_path")
    if [[ $? -ne 0 ]] || [[ -z "$backup_path" ]]; then
        if is_json_output "$FORMAT"; then
            printf '{"success":false,"error":"Backup creation failed","code":%d}\n' "$MIGRATE_BACKUP_FAILED"
        else
            echo "Error: Failed to create backup of $legacy_path"
        fi
        return $MIGRATE_BACKUP_FAILED
    fi

    if ! is_json_output "$FORMAT"; then
        echo "  ✓ Backup created: $backup_path"
        echo ""
        if [[ -n "$target_backup_path" ]]; then
            echo "Step 2/4: Merging files (force mode)..."
        else
            echo "Step 2/4: Moving files..."
        fi
    fi

    # Move or merge the directory
    if [[ -n "$target_backup_path" ]]; then
        # Force mode: merge legacy files into existing target
        if ! cp -r "$legacy_path"/* "$target_path"/ 2>/dev/null; then
            if is_json_output "$FORMAT"; then
                printf '{"success":false,"error":"Merge operation failed","source":"%s","target":"%s","code":%d}\n' \
                    "$legacy_path" "$target_path" "$MIGRATE_RENAME_FAILED"
            else
                echo "Error: Failed to merge $legacy_path → $target_path"
                echo "Backup available at: $backup_path"
                echo "Target backup at: $target_backup_path"
            fi
            return $MIGRATE_RENAME_FAILED
        fi
        # Remove legacy directory after successful merge
        rm -rf "$legacy_path" 2>/dev/null || true
    else
        # Normal mode: move the directory
        if ! mv "$legacy_path" "$target_path" 2>/dev/null; then
            if is_json_output "$FORMAT"; then
                printf '{"success":false,"error":"Move operation failed","source":"%s","target":"%s","code":%d}\n' \
                    "$legacy_path" "$target_path" "$MIGRATE_RENAME_FAILED"
            else
                echo "Error: Failed to move $legacy_path → $target_path"
                echo "Backup available at: $backup_path"
            fi
            return $MIGRATE_RENAME_FAILED
        fi
    fi

    if ! is_json_output "$FORMAT"; then
        if [[ -n "$target_backup_path" ]]; then
            echo "  ✓ Merged: $legacy_path → $target_path"
        else
            echo "  ✓ Moved: $legacy_path → $target_path"
        fi
        echo ""
        echo "Step 3/4: Renaming config files..."
    fi

    # Rename config files (todo-config.json → config.json, etc.)
    local configs_renamed
    configs_renamed=$(rename_project_configs "$target_path")

    if ! is_json_output "$FORMAT"; then
        echo "  ✓ Renamed $configs_renamed config files"
        echo ""
        echo "Step 4/4: Verifying and finalizing..."
    fi

    # Verify the move
    if [[ ! -d "$target_path" ]]; then
        if is_json_output "$FORMAT"; then
            printf '{"success":false,"error":"Verification failed - target not found","code":%d}\n' "$MIGRATE_VALIDATION_FAILED"
        else
            echo "Error: Verification failed - target directory not found"
            echo "Restore from backup: tar -xzf $backup_path -C $HOME"
        fi
        return $MIGRATE_VALIDATION_FAILED
    fi

    # Move backup from temp to final location
    local final_backup
    final_backup=$(finalize_backup "$backup_path" "$target_path")
    backup_path="$final_backup"

    # Count files in new location
    local migrated_count
    migrated_count=$(find "$target_path" -type f 2>/dev/null | wc -l | tr -d ' ')

    # Build success output
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    if is_json_output "$FORMAT"; then
        cat <<EOF
{
  "\$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "command": "claude-migrate --global",
    "timestamp": "${timestamp}",
    "version": "1.0.0"
  },
  "success": true,
  "migration": {
    "type": "global",
    "source": "${legacy_path}",
    "target": "${target_path}",
    "fileCount": ${migrated_count},
    "backup": "${backup_path}"
  }
}
EOF
    else
        echo "  ✓ Verified: $migrated_count files migrated"
        echo ""
        echo "Migration Complete!"
        echo ""
        echo "Summary:"
        echo "  Source: $legacy_path (removed)"
        echo "  Target: $target_path"
        echo "  Files:  $migrated_count"
        echo "  Backup: $backup_path"
        echo ""
        echo "To restore if needed:"
        echo "  rm -rf $target_path"
        echo "  tar -xzf $backup_path -C $HOME"
        echo ""
    fi

    return $MIGRATE_SUCCESS
}

# =============================================================================
# PROJECT MIGRATION MODE (T917)
# =============================================================================

# Create backup of project directory
# Args: $1 = source path
# Note: Backup is created in /tmp first
create_project_backup() {
    local source_path="$1"
    local timestamp
    timestamp=$(date +%Y%m%d_%H%M%S)
    local temp_backup="/tmp/cleo_project_backup_${timestamp}.tar.gz"

    if [[ "$VERBOSE" == "true" ]]; then
        echo "Creating backup: $temp_backup"
    fi

    # Create backup using tar to temp location
    if tar -czf "$temp_backup" "$source_path" 2>/dev/null; then
        echo "$temp_backup"
        return 0
    else
        return 1
    fi
}

# Rename config files during migration
# Config: todo-config.json → config.json (renamed)
# Log: todo-log.json stays as todo-log.json (unchanged)
# Args: $1 = target directory
# Returns: count of files renamed
rename_project_configs() {
    local target_dir="$1"
    local renamed=0

    # Rename todo-config.json → config.json
    if [[ -f "$target_dir/todo-config.json" ]]; then
        if mv "$target_dir/todo-config.json" "$target_dir/config.json" 2>/dev/null; then
            ((renamed++)) || true  # Prevent set -e exit when renamed is 0
        fi
    fi

    # Log file stays as todo-log.json - no rename needed

    echo "$renamed"
}

# Update .gitignore entries from .claude to .cleo
update_gitignore() {
    local gitignore_file=".gitignore"

    if [[ ! -f "$gitignore_file" ]]; then
        return 0
    fi

    # Check if .claude entries exist
    if grep -q "\.claude" "$gitignore_file" 2>/dev/null; then
        # Create backup
        cp "$gitignore_file" "${gitignore_file}.bak"

        # Update entries
        sed -i.tmp 's/\.claude/\.cleo/g' "$gitignore_file"
        rm -f "${gitignore_file}.tmp"

        return 0
    fi

    return 1
}

# Update CLAUDE-TODO injection markers in CLAUDE.md
update_injection_markers() {
    local claude_md="CLAUDE.md"

    if [[ ! -f "$claude_md" ]]; then
        return 0
    fi

    # Check if old markers exist
    if grep -q "CLAUDE-TODO:" "$claude_md" 2>/dev/null; then
        # Create backup
        cp "$claude_md" "${claude_md}.bak"

        # Update markers
        sed -i.tmp 's/CLAUDE-TODO:/CLEO:/g' "$claude_md"
        rm -f "${claude_md}.tmp"

        return 0
    fi

    return 1
}

# CLEO-specific files to migrate from .claude/
# Other files in .claude/ are left untouched
readonly CLEO_FILES=(
    "todo.json"
    "todo-config.json"
    "todo-log.json"
    "todo-archive.json"
)

# Check if .claude/ contains CLEO files
has_cleo_files_in_legacy() {
    local legacy_path="$1"

    for file in "${CLEO_FILES[@]}"; do
        if [[ -f "$legacy_path/$file" ]]; then
            return 0
        fi
    done
    return 1
}

# Migrate project directory: .claude → .cleo
# IMPORTANT: Only migrates CLEO-specific files.
# The .claude/ directory is preserved for other tools.
run_project_migration() {
    local legacy_path
    local target_path
    local backup_path

    legacy_path=$(get_legacy_project_dir)
    target_path=$(get_cleo_dir)

    # Check if legacy directory exists
    if ! has_legacy_project_dir; then
        if is_json_output "$FORMAT"; then
            printf '{"success":false,"error":"No legacy project directory found","code":%d}\n' "$MIGRATE_NO_LEGACY"
        else
            echo "No legacy project directory found at $legacy_path"
            echo "Nothing to migrate."
        fi
        return $MIGRATE_NO_LEGACY
    fi

    # Check if it actually contains CLEO files
    if ! has_cleo_files_in_legacy "$legacy_path"; then
        if is_json_output "$FORMAT"; then
            printf '{"success":false,"error":"No CLEO files found in .claude/","code":%d}\n' "$MIGRATE_NO_LEGACY"
        else
            echo "No CLEO files found in $legacy_path"
            echo "The .claude/ directory exists but contains no claude-todo data."
            echo "Nothing to migrate."
        fi
        return $MIGRATE_NO_LEGACY
    fi

    # Check if target already exists
    local target_backup_path=""
    if [[ -d "$target_path" ]]; then
        local file_count
        file_count=$(find "$target_path" -type f 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$file_count" -gt 0 ]]; then
            if [[ "$FORCE" != "true" ]]; then
                if is_json_output "$FORMAT"; then
                    printf '{"success":false,"error":"Target path already exists with data","path":"%s","code":%d,"suggestion":"Use --force to merge"}\n' \
                        "$target_path" "$MIGRATE_VALIDATION_FAILED"
                else
                    echo "Error: Target path $target_path already exists with $file_count files."
                    echo "Use --force to backup existing target and merge legacy data."
                fi
                return $MIGRATE_VALIDATION_FAILED
            else
                # Force mode: backup existing target first
                if ! is_json_output "$FORMAT"; then
                    echo "Target exists with $file_count files. Backing up existing target..."
                fi
                target_backup_path="${target_path}.backup.$(date +%Y%m%d_%H%M%S)"
                if ! cp -r "$target_path" "$target_backup_path" 2>/dev/null; then
                    if is_json_output "$FORMAT"; then
                        printf '{"success":false,"error":"Failed to backup existing target","path":"%s","code":%d}\n' \
                            "$target_path" "$MIGRATE_BACKUP_FAILED"
                    else
                        echo "Error: Failed to backup existing target to $target_backup_path"
                    fi
                    return $MIGRATE_BACKUP_FAILED
                fi
                if ! is_json_output "$FORMAT"; then
                    echo "  ✓ Existing target backed up to: $target_backup_path"
                fi
            fi
        fi
    fi

    # Create backup of CLEO files only
    if is_json_output "$FORMAT"; then
        : # JSON output will be at the end
    else
        echo ""
        echo "CLEO Project Migration"
        echo "======================"
        echo ""
        echo "Source: $legacy_path (CLEO files only)"
        echo "Target: $target_path"
        echo ""
        echo "Note: Other files in .claude/ will be preserved."
        echo ""
        echo "Step 1/5: Creating backup of CLEO files..."
    fi

    backup_path=$(create_project_backup "$legacy_path")
    if [[ $? -ne 0 ]] || [[ -z "$backup_path" ]]; then
        if is_json_output "$FORMAT"; then
            printf '{"success":false,"error":"Backup creation failed","code":%d}\n' "$MIGRATE_BACKUP_FAILED"
        else
            echo "Error: Failed to create backup of $legacy_path"
        fi
        return $MIGRATE_BACKUP_FAILED
    fi

    if ! is_json_output "$FORMAT"; then
        echo "  ✓ Backup created: $backup_path"
        echo ""
        echo "Step 2/5: Moving CLEO files..."
    fi

    # Ensure target directory exists
    mkdir -p "$target_path"

    # Move only CLEO-specific files (not the entire directory)
    local files_moved=0
    for file in "${CLEO_FILES[@]}"; do
        if [[ -f "$legacy_path/$file" ]]; then
            if mv "$legacy_path/$file" "$target_path/$file" 2>/dev/null; then
                ((files_moved++)) || true  # Prevent set -e exit when files_moved is 0
                if [[ "$VERBOSE" == "true" ]] && ! is_json_output "$FORMAT"; then
                    echo "    Moved: $file"
                fi
            else
                if is_json_output "$FORMAT"; then
                    printf '{"success":false,"error":"Failed to move file","file":"%s","code":%d}\n' \
                        "$file" "$MIGRATE_RENAME_FAILED"
                else
                    echo "Error: Failed to move $legacy_path/$file → $target_path/$file"
                    echo "Backup available at: $backup_path"
                fi
                return $MIGRATE_RENAME_FAILED
            fi
        fi
    done

    # Also move backups directory if it exists and contains CLEO backups
    if [[ -d "$legacy_path/backups" ]]; then
        mkdir -p "$target_path/backups"
        # Move backup contents, not the directory itself
        if cp -r "$legacy_path/backups/"* "$target_path/backups/" 2>/dev/null; then
            rm -rf "$legacy_path/backups" 2>/dev/null || true
            if [[ "$VERBOSE" == "true" ]] && ! is_json_output "$FORMAT"; then
                echo "    Moved: backups/"
            fi
        fi
    fi

    if ! is_json_output "$FORMAT"; then
        echo "  ✓ Moved $files_moved CLEO files"
        echo ""
        echo "Step 3/5: Renaming config files..."
    fi

    # Rename config files
    local configs_renamed
    configs_renamed=$(rename_project_configs "$target_path")

    if ! is_json_output "$FORMAT"; then
        echo "  ✓ Renamed $configs_renamed config files"
        echo ""
        echo "Step 4/5: Updating .gitignore..."
    fi

    # Update .gitignore
    local gitignore_updated=false
    if update_gitignore; then
        gitignore_updated=true
    fi

    if ! is_json_output "$FORMAT"; then
        if [[ "$gitignore_updated" == "true" ]]; then
            echo "  ✓ Updated .gitignore"
        else
            echo "  - No .gitignore changes needed"
        fi
        echo ""
        echo "Step 5/5: Updating injection markers..."
    fi

    # Update CLAUDE.md markers
    local markers_updated=false
    if update_injection_markers; then
        markers_updated=true
    fi

    if ! is_json_output "$FORMAT"; then
        if [[ "$markers_updated" == "true" ]]; then
            echo "  ✓ Updated CLAUDE.md markers"
        else
            echo "  - No marker changes needed"
        fi
        echo ""
    fi

    # Move backup to final location
    local final_backup
    final_backup=$(finalize_backup "$backup_path" "$target_path")
    backup_path="$final_backup"

    # Count files in new location
    local migrated_count
    migrated_count=$(find "$target_path" -type f 2>/dev/null | wc -l | tr -d ' ')

    # Check what remains in .claude/ (for informational purposes)
    local remaining_in_claude=0
    local claude_dir_preserved=false
    if [[ -d "$legacy_path" ]]; then
        remaining_in_claude=$(find "$legacy_path" -type f 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$remaining_in_claude" -eq 0 ]]; then
            # Remove empty .claude/ directory
            rmdir "$legacy_path" 2>/dev/null || true
        else
            claude_dir_preserved=true
        fi
    fi

    # Build success output
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    if is_json_output "$FORMAT"; then
        cat <<EOF
{
  "\$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "command": "claude-migrate --project",
    "timestamp": "${timestamp}",
    "version": "1.0.0"
  },
  "success": true,
  "migration": {
    "type": "project",
    "source": "${legacy_path}",
    "target": "${target_path}",
    "fileCount": ${migrated_count},
    "configsRenamed": ${configs_renamed},
    "gitignoreUpdated": ${gitignore_updated},
    "markersUpdated": ${markers_updated},
    "backup": "${backup_path}",
    "claudeDirPreserved": true,
    "remainingInClaude": ${remaining_in_claude}
  }
}
EOF
    else
        echo "Migration Complete!"
        echo ""
        echo "Summary:"
        echo "  Source: $legacy_path (CLEO files migrated)"
        echo "  Target: $target_path"
        echo "  Files migrated: $files_moved"
        echo "  Config files renamed: $configs_renamed"
        echo "  .gitignore updated: $gitignore_updated"
        echo "  Markers updated: $markers_updated"
        echo "  Backup: $backup_path"
        if [[ $remaining_in_claude -gt 0 ]]; then
            echo ""
            echo "Note: $remaining_in_claude files remain in .claude/ (other tools' data)"
        fi
        echo ""
        echo "To restore if needed:"
        echo "  tar -xzf $backup_path"
        echo ""
    fi

    return $MIGRATE_SUCCESS
}

# =============================================================================
# ALL MIGRATION MODE (T918)
# =============================================================================

# Run all migrations (global + project)
run_all_migration() {
    local global_result=0
    local project_result=0
    local global_success=false
    local project_success=false
    local global_skipped=false
    local project_skipped=false
    local global_output=""
    local project_output=""

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    if ! is_json_output "$FORMAT"; then
        echo ""
        echo "CLEO Full Migration"
        echo "==================="
        echo ""
        echo "Running all migrations..."
        echo ""
    fi

    # Check what needs migration
    local has_global_legacy=false
    local has_project_legacy=false

    if has_legacy_global_installation; then
        has_global_legacy=true
    fi
    if has_legacy_project_dir; then
        has_project_legacy=true
    fi

    # If nothing to migrate
    if [[ "$has_global_legacy" == "false" ]] && [[ "$has_project_legacy" == "false" ]]; then
        if is_json_output "$FORMAT"; then
            cat <<EOF
{
  "\$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "command": "claude-migrate --all",
    "timestamp": "${timestamp}",
    "version": "1.0.0"
  },
  "success": false,
  "error": "No legacy installations found",
  "code": ${MIGRATE_NO_LEGACY}
}
EOF
        else
            echo "No legacy installations found."
            echo "Nothing to migrate."
        fi
        return $MIGRATE_NO_LEGACY
    fi

    # Run global migration if needed
    if [[ "$has_global_legacy" == "true" ]]; then
        if ! is_json_output "$FORMAT"; then
            echo "=== Global Migration ==="
            echo ""
        fi

        # Capture result
        if run_global_migration; then
            global_success=true
        else
            global_result=$?
            if [[ $global_result -eq $MIGRATE_NO_LEGACY ]]; then
                global_skipped=true
            fi
        fi
    else
        global_skipped=true
        if ! is_json_output "$FORMAT"; then
            echo "Global: No legacy installation found (skipped)"
            echo ""
        fi
    fi

    # Run project migration if needed
    if [[ "$has_project_legacy" == "true" ]]; then
        if ! is_json_output "$FORMAT"; then
            echo ""
            echo "=== Project Migration ==="
            echo ""
        fi

        if run_project_migration; then
            project_success=true
        else
            project_result=$?
            if [[ $project_result -eq $MIGRATE_NO_LEGACY ]]; then
                project_skipped=true
            fi
        fi
    else
        project_skipped=true
        if ! is_json_output "$FORMAT"; then
            echo "Project: No legacy directory found (skipped)"
            echo ""
        fi
    fi

    # Build summary
    local overall_success=false
    if [[ "$global_success" == "true" ]] || [[ "$project_success" == "true" ]]; then
        overall_success=true
    fi
    if [[ "$global_skipped" == "true" ]] && [[ "$project_skipped" == "true" ]]; then
        overall_success=false
    fi

    if is_json_output "$FORMAT"; then
        cat <<EOF
{
  "\$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "command": "claude-migrate --all",
    "timestamp": "${timestamp}",
    "version": "1.0.0"
  },
  "success": ${overall_success},
  "migrations": {
    "global": {
      "success": ${global_success},
      "skipped": ${global_skipped}
    },
    "project": {
      "success": ${project_success},
      "skipped": ${project_skipped}
    }
  }
}
EOF
    else
        echo ""
        echo "=== Migration Summary ==="
        echo ""
        if [[ "$global_success" == "true" ]]; then
            echo "  Global:  ✓ Migrated"
        elif [[ "$global_skipped" == "true" ]]; then
            echo "  Global:  - Skipped (no legacy)"
        else
            echo "  Global:  ✗ Failed"
        fi

        if [[ "$project_success" == "true" ]]; then
            echo "  Project: ✓ Migrated"
        elif [[ "$project_skipped" == "true" ]]; then
            echo "  Project: - Skipped (no legacy)"
        else
            echo "  Project: ✗ Failed"
        fi
        echo ""
    fi

    if [[ "$overall_success" == "true" ]]; then
        return $MIGRATE_SUCCESS
    elif [[ "$global_result" -ne 0 ]] && [[ "$global_result" -ne $MIGRATE_NO_LEGACY ]]; then
        return $global_result
    elif [[ "$project_result" -ne 0 ]] && [[ "$project_result" -ne $MIGRATE_NO_LEGACY ]]; then
        return $project_result
    else
        return $MIGRATE_NO_LEGACY
    fi
}

# =============================================================================
# OUTPUT FORMAT DETECTION
# =============================================================================

# Check if JSON output should be used
is_json_output() {
    local format="${1:-}"

    # Explicit format takes precedence
    if [[ "$format" == "json" ]]; then
        return 0
    fi
    if [[ "$format" == "human" || "$format" == "text" ]]; then
        return 1
    fi

    # Auto-detect: JSON if not a TTY (piped output)
    if [[ ! -t 1 ]]; then
        return 0
    fi

    return 1
}

# =============================================================================
# ARGUMENT PARSING
# =============================================================================

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --check)
                MODE="check"
                shift
                ;;
            --global)
                MODE="global"
                shift
                ;;
            --project)
                MODE="project"
                shift
                ;;
            --all)
                MODE="all"
                shift
                ;;
            --format)
                if [[ -z "${2:-}" ]]; then
                    echo "Error: --format requires a value" >&2
                    exit 2
                fi
                FORMAT="$2"
                shift 2
                ;;
            --verbose|-v)
                VERBOSE=true
                shift
                ;;
            --force|-f)
                FORCE=true
                shift
                ;;
            --help|-h)
                usage
                exit 0
                ;;
            *)
                echo "Error: Unknown option: $1" >&2
                echo "Run 'cleo claude-migrate --help' for usage." >&2
                exit 2
                ;;
        esac
    done

    # Require a mode
    if [[ -z "$MODE" ]]; then
        echo "Error: Must specify --check, --global, --project, or --all" >&2
        echo "Run 'cleo claude-migrate --help' for usage." >&2
        exit 2
    fi
}

# =============================================================================
# MAIN
# =============================================================================

main() {
    parse_args "$@"

    case "$MODE" in
        check)
            run_check_mode
            ;;
        global)
            run_global_migration
            ;;
        project)
            run_project_migration
            ;;
        all)
            run_all_migration
            ;;
        *)
            echo "Error: Invalid mode: $MODE" >&2
            exit 2
            ;;
    esac
}

main "$@"
