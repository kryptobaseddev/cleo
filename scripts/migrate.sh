#!/usr/bin/env bash
# migrate.sh - Schema migration command for claude-todo
# Handles version upgrades for todo files

set -euo pipefail

# Determine the library directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/../lib"

# Source required libraries
# shellcheck source=lib/migrate.sh
source "$LIB_DIR/migrate.sh"

# ============================================================================
# DEPENDENCY CHECK (T167)
# ============================================================================
# jq is required for all migration operations
if ! command -v jq &>/dev/null; then
    echo "ERROR: jq is required for migration operations but not found." >&2
    echo "" >&2
    echo "Install jq:" >&2
    case "$(uname -s)" in
        Linux*)  echo "  sudo apt install jq  (Debian/Ubuntu)" >&2
                 echo "  sudo yum install jq  (RHEL/CentOS)" >&2 ;;
        Darwin*) echo "  brew install jq" >&2 ;;
        *)       echo "  See: https://stedolan.github.io/jq/download/" >&2 ;;
    esac
    exit 1
fi

# ============================================================================
# USAGE
# ============================================================================

show_usage() {
    cat <<EOF
Usage: claude-todo migrate [COMMAND] [OPTIONS]

Schema version migration for claude-todo files.

Commands:
  status                 Show version status of all files
  check                  Check if migration is needed
  run                    Execute migration for all files
  file <path> <type>     Migrate specific file

Options:
  --dir <path>          Project directory (default: current directory)
  --auto                Auto-migrate without confirmation
  --backup              Create backup before migration (default)
  --no-backup           Skip backup creation
  --force               Force migration even if versions match
  -h, --help            Show this help message

Examples:
  # Check migration status
  claude-todo migrate status

  # Migrate all files in current project
  claude-todo migrate run

  # Migrate specific file
  claude-todo migrate file .claude/todo.json todo

  # Auto-migrate without confirmation
  claude-todo migrate run --auto

Schema Versions:
  todo:    $SCHEMA_VERSION_TODO
  config:  $SCHEMA_VERSION_CONFIG
  archive: $SCHEMA_VERSION_ARCHIVE
  log:     $SCHEMA_VERSION_LOG
EOF
}

# ============================================================================
# COMMAND HANDLERS
# ============================================================================

# Show migration status for all files
cmd_status() {
    local project_dir="${1:-.}"
    local claude_dir="$project_dir/.claude"

    if [[ ! -d "$claude_dir" ]]; then
        echo "ERROR: No .claude directory found in $project_dir" >&2
        echo "Run 'claude-todo init' to initialize the project" >&2
        exit 1
    fi

    show_migration_status "$claude_dir"
}

# Check if migration is needed
cmd_check() {
    local project_dir="${1:-.}"
    local claude_dir="$project_dir/.claude"

    if [[ ! -d "$claude_dir" ]]; then
        echo "ERROR: No .claude directory found" >&2
        exit 1
    fi

    local needs_migration=false
    local files=(
        "$claude_dir/todo.json:todo"
        "$claude_dir/todo-config.json:config"
        "$claude_dir/todo-archive.json:archive"
        "$claude_dir/todo-log.json:log"
    )

    for file_spec in "${files[@]}"; do
        IFS=':' read -r file file_type <<< "$file_spec"

        if [[ ! -f "$file" ]]; then
            continue
        fi

        local status
        check_compatibility "$file" "$file_type" && status=$? || status=$?

        if [[ $status -eq 1 ]]; then
            needs_migration=true
            break
        elif [[ $status -eq 2 ]]; then
            echo "ERROR: Incompatible version found in $file" >&2
            exit 1
        fi
    done

    if [[ "$needs_migration" == "true" ]]; then
        echo "Migration needed"
        exit 1
    else
        echo "All files up to date"
        exit 0
    fi
}

# Run migration for all files
cmd_run() {
    local project_dir="${1:-.}"
    local auto_migrate="${2:-false}"
    local create_backup="${3:-true}"
    local force_migration="${4:-false}"

    local claude_dir="$project_dir/.claude"

    if [[ ! -d "$claude_dir" ]]; then
        echo "ERROR: No .claude directory found" >&2
        exit 1
    fi

    echo "Schema Migration"
    echo "================"
    echo ""
    echo "Project: $project_dir"
    echo "Target versions:"
    echo "  todo:    $SCHEMA_VERSION_TODO"
    echo "  config:  $SCHEMA_VERSION_CONFIG"
    echo "  archive: $SCHEMA_VERSION_ARCHIVE"
    echo "  log:     $SCHEMA_VERSION_LOG"
    echo ""

    # Check status first
    local files=(
        "$claude_dir/todo.json:todo"
        "$claude_dir/todo-config.json:config"
        "$claude_dir/todo-archive.json:archive"
        "$claude_dir/todo-log.json:log"
    )

    local migration_needed=false
    local incompatible_found=false

    for file_spec in "${files[@]}"; do
        IFS=':' read -r file file_type <<< "$file_spec"

        if [[ ! -f "$file" ]]; then
            continue
        fi

        local status
        check_compatibility "$file" "$file_type" && status=$? || status=$?

        if [[ $status -eq 1 ]]; then
            migration_needed=true
        elif [[ $status -eq 2 ]]; then
            incompatible_found=true
        fi
    done

    if [[ "$incompatible_found" == "true" ]]; then
        echo "ERROR: Incompatible versions detected" >&2
        echo "Manual intervention required" >&2
        exit 1
    fi

    if [[ "$migration_needed" == "false" && "$force_migration" == "false" ]]; then
        echo "✓ All files already at current versions"
        exit 0
    fi

    if [[ "$force_migration" == "true" ]]; then
        echo "⚠ Force migration enabled - will re-migrate all files"
    fi

    # Confirm migration
    if [[ "$auto_migrate" != "true" ]]; then
        echo "This will migrate your todo files to the latest schema versions."
        echo ""
        read -p "Continue? (y/N) " -r
        echo ""

        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Migration cancelled"
            exit 0
        fi
    fi

    # Create project backup if requested
    if [[ "$create_backup" == "true" ]]; then
        echo "Creating project backup..."
        local backup_dir="${claude_dir}/.backups/pre-migration-$(date +%Y%m%d-%H%M%S)"
        mkdir -p "$backup_dir"

        for file_spec in "${files[@]}"; do
            IFS=':' read -r file file_type <<< "$file_spec"
            if [[ -f "$file" ]]; then
                cp "$file" "$backup_dir/" || {
                    echo "ERROR: Failed to create backup" >&2
                    exit 1
                }
            fi
        done

        echo "✓ Backup created: $backup_dir"
        echo ""
    fi

    # Perform migration
    local migration_failed=false

    for file_spec in "${files[@]}"; do
        IFS=':' read -r file file_type <<< "$file_spec"

        if [[ ! -f "$file" ]]; then
            continue
        fi

        local status
        check_compatibility "$file" "$file_type" && status=$? || status=$?

        # Force migration if flag is set, otherwise only migrate if needed
        if [[ $status -eq 1 || "$force_migration" == "true" ]]; then
            if [[ "$force_migration" == "true" && $status -eq 0 ]]; then
                echo "Migrating $file_type (forced)..."
            else
                echo "Migrating $file_type..."
            fi

            local current_version expected_version
            current_version=$(detect_file_version "$file")
            expected_version=$(get_expected_version "$file_type")

            if ! migrate_file "$file" "$file_type" "$current_version" "$expected_version"; then
                echo "✗ Migration failed for $file_type" >&2
                migration_failed=true
                break
            fi

            echo ""
        fi
    done

    if [[ "$migration_failed" == "true" ]]; then
        echo "ERROR: Migration failed" >&2
        echo "Backups available in: ${claude_dir}/.backups/" >&2
        exit 1
    fi

    echo "✓ Migration completed successfully"
}

# Migrate specific file
cmd_file() {
    local file="$1"
    local file_type="$2"

    if [[ ! -f "$file" ]]; then
        echo "ERROR: File not found: $file" >&2
        exit 1
    fi

    local status
    check_compatibility "$file" "$file_type" && status=$? || status=$?

    case $status in
        0)
            echo "✓ File already at current version"
            exit 0
            ;;
        1)
            local current_version expected_version
            current_version=$(detect_file_version "$file")
            expected_version=$(get_expected_version "$file_type")

            echo "Migrating: $file"
            echo "  From: v$current_version"
            echo "  To:   v$expected_version"
            echo ""

            if migrate_file "$file" "$file_type" "$current_version" "$expected_version"; then
                echo "✓ Migration successful"
                exit 0
            else
                echo "✗ Migration failed" >&2
                exit 1
            fi
            ;;
        2)
            echo "ERROR: Incompatible version - manual intervention required" >&2
            exit 1
            ;;
    esac
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    # Handle global help flag first
    if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
        show_usage
        exit 0
    fi

    local command="${1:-}"
    shift || true

    # Parse options
    local project_dir="."
    local auto_migrate=false
    local create_backup=true
    local force_migration=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dir)
                project_dir="$2"
                shift 2
                ;;
            --auto)
                auto_migrate=true
                shift
                ;;
            --backup)
                create_backup=true
                shift
                ;;
            --no-backup)
                create_backup=false
                shift
                ;;
            --force)
                force_migration=true
                shift
                ;;
            -h|--help)
                show_usage
                exit 0
                ;;
            *)
                break
                ;;
        esac
    done

    case "$command" in
        "status")
            cmd_status "$project_dir"
            ;;
        "check")
            cmd_check "$project_dir"
            ;;
        "run")
            cmd_run "$project_dir" "$auto_migrate" "$create_backup" "$force_migration"
            ;;
        "file")
            if [[ $# -lt 2 ]]; then
                echo "ERROR: Missing arguments for 'file' command" >&2
                echo "Usage: claude-todo migrate file <path> <type>" >&2
                exit 1
            fi
            cmd_file "$1" "$2"
            ;;
        "")
            show_usage
            exit 1
            ;;
        *)
            echo "ERROR: Unknown command: $command" >&2
            echo "" >&2
            show_usage
            exit 1
            ;;
    esac
}

main "$@"
