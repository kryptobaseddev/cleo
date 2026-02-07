#!/usr/bin/env bash
###CLEO
# command: migrate
# category: maintenance
# synopsis: Schema version migrations (status check, run migrations)
# relevance: low
# flags: --format,--quiet,--dry-run
# exits: 0,3,6
# json-output: true
# subcommands: status,run
###END
# Schema migration command for cleo
# Handles version upgrades for todo files

set -euo pipefail

# Determine the library directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/../lib"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"

# Load VERSION from central location
if [[ -f "$CLEO_HOME/VERSION" ]]; then
  VERSION="$(cat "$CLEO_HOME/VERSION" | tr -d '[:space:]')"
elif [[ -f "$SCRIPT_DIR/../VERSION" ]]; then
  VERSION="$(cat "$SCRIPT_DIR/../VERSION" | tr -d '[:space:]')"
else
  VERSION="unknown"
fi

# Source required libraries
# shellcheck source=lib/backup.sh
if [[ -f "$LIB_DIR/backup.sh" ]]; then
  source "$LIB_DIR/backup.sh"
fi

# shellcheck source=lib/migrate.sh
source "$LIB_DIR/migrate.sh"

# Source output formatting and error libraries
if [[ -f "$LIB_DIR/output-format.sh" ]]; then
  # shellcheck source=../lib/output-format.sh
  source "$LIB_DIR/output-format.sh"
fi
if [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
  # shellcheck source=../lib/exit-codes.sh
  source "$LIB_DIR/exit-codes.sh"
fi
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
  # shellcheck source=../lib/error-json.sh
  source "$LIB_DIR/error-json.sh"
fi

# Source centralized flag parsing
if [[ -f "$LIB_DIR/flags.sh" ]]; then
  # shellcheck source=../lib/flags.sh
  source "$LIB_DIR/flags.sh"
fi

# Global variables
FORMAT=""
QUIET=false
DRY_RUN=false
COMMAND_NAME="migrate"

# ============================================================================
# DEVELOPER MODE CHECK
# ============================================================================
# Prevent agents from using low-level migrate command
# Redirect to unified upgrade command unless explicitly opted-in
check_developer_mode() {
    # Skip check if:
    # - CLEO_DEVELOPER_MODE is set
    # - Running status/check (read-only operations)
    # - Non-interactive (piped/scripted)
    if [[ -n "${CLEO_DEVELOPER_MODE:-}" ]] || [[ ! -t 0 ]] || [[ ! -t 1 ]]; then
        return 0
    fi

    # Check first argument for read-only subcommands
    local subcmd="${1:-}"
    case "$subcmd" in
        status|check|history)
            return 0
            ;;
    esac

    # Interactive warning for write operations
    echo "⚠️  WARNING: 'cleo migrate' is a low-level developer tool" >&2
    echo "" >&2
    echo "   Most users and LLM agents should use:" >&2
    echo "   → cleo upgrade" >&2
    echo "" >&2
    echo "   The 'upgrade' command handles:" >&2
    echo "   • Schema migrations (same as 'migrate run')" >&2
    echo "   • Structural repairs" >&2
    echo "   • Documentation updates" >&2
    echo "   • Validation" >&2
    echo "" >&2
    echo "   Only use 'migrate' if you need low-level control for:" >&2
    echo "   • Creating migration templates (migrate create)" >&2
    echo "   • Debugging migrations (migrate file)" >&2
    echo "   • Emergency rollback (migrate rollback)" >&2
    echo "" >&2

    read -p "Continue with low-level migrate? (y/N) " -r >&2
    echo "" >&2

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Redirecting to: cleo upgrade" >&2
        exec "$SCRIPT_DIR/upgrade.sh" "$@"
    fi

    # User confirmed - set developer mode for this session
    export CLEO_DEVELOPER_MODE=1
}

# ============================================================================
# DEPENDENCY CHECK (T167)
# ============================================================================
# jq is required for all migration operations
check_jq_dependency() {
    if ! command -v jq &>/dev/null; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_DEPENDENCY_MISSING" "jq is required for migration operations but not found" "${EXIT_DEPENDENCY_ERROR:-5}" false "Install jq: apt install jq (Debian) or brew install jq (macOS)"
        else
            output_error "$E_DEPENDENCY_MISSING" "jq is required for migration operations but not found"
            echo "" >&2
            echo "Install jq:" >&2
            case "$(uname -s)" in
                Linux*)  echo "  sudo apt install jq  (Debian/Ubuntu)" >&2
                         echo "  sudo yum install jq  (RHEL/CentOS)" >&2 ;;
                Darwin*) echo "  brew install jq" >&2 ;;
                *)       echo "  See: https://stedolan.github.io/jq/download/" >&2 ;;
            esac
        fi
        exit "${EXIT_DEPENDENCY_ERROR:-1}"
    fi
}

# ============================================================================
# USAGE
# ============================================================================

show_usage() {
    cat <<EOF
Usage: cleo migrate [COMMAND] [OPTIONS]

Schema version migration for cleo files.

Commands:
  status                 Show version status of all files
  history                Show migration history from journal
  check                  Check if migration is needed
  run                    Execute migration for all files
  file <path> <type>     Migrate specific file
  rollback               Rollback from most recent migration backup
  repair                 Repair schema to canonical structure (fixes phases, _meta, etc.)
  create <description>   Create new timestamped migration

Options:
  --dir <path>          Project directory (default: current directory)
  --auto                Auto-migrate without confirmation
  --backup              Create backup before migration (default)
  --no-backup           Skip backup creation
  --force               Force migration even if versions match
  -f, --format FMT      Output format: text, json (default: auto-detect)
  --human               Force human-readable text output
  --json                Force JSON output
  -q, --quiet           Suppress non-essential output
  -h, --help            Show this help message

Rollback Options:
  --backup-id <id>      Specific backup to restore from (optional)
  --force               Skip confirmation prompt

Repair Options:
  --dry-run             Show what would be repaired without making changes
  --auto                Auto-repair without confirmation

Create Migration Options:
  --type, -t TYPE       File type (todo|config|archive|log) (default: todo)

JSON Output:
  {
    "_meta": {"command": "migrate", "timestamp": "..."},
    "success": true,
    "migrations": [{"from": "1.0", "to": "2.0", "applied": true}]
  }

Examples:
  # Check migration status
  cleo migrate status

  # Migrate all files in current project
  cleo migrate run

  # Migrate specific file
  cleo migrate file .cleo/todo.json todo

  # Auto-migrate without confirmation
  cleo migrate run --auto

  # Rollback from most recent migration backup
  cleo migrate rollback

  # Rollback from specific backup
  cleo migrate rollback --backup-id migration_v2.1.0_20251215_120000

  # Check what repairs are needed (dry-run)
  cleo migrate repair --dry-run

  # Auto-repair schema issues
  cleo migrate repair --auto

  # Create new migration
  cleo migrate create "add user field"
  cleo migrate create "fix config schema" --type config

  # JSON output for scripting
  cleo migrate status --json

Schema Versions:
  todo:    $(get_schema_version_from_file "todo" 2>/dev/null || echo "unknown")
  config:  $(get_schema_version_from_file "config" 2>/dev/null || echo "unknown")
  archive: $(get_schema_version_from_file "archive" 2>/dev/null || echo "unknown")
  log:     $(get_schema_version_from_file "log" 2>/dev/null || echo "unknown")
EOF
}

# ============================================================================
# COMMAND HANDLERS
# ============================================================================

# Create new timestamped migration file
create_migration() {
    local description=""
    local file_type="todo"

    # Parse options and collect description
    local args=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --type|-t)
                file_type="$2"
                shift 2
                ;;
            --json|--human|-f|--format|-q|--quiet|--dry-run)
                # Skip format/output options (already handled by main)
                if [[ "$1" == "-f" || "$1" == "--format" ]]; then
                    shift 2
                else
                    shift
                fi
                ;;
            --)
                shift
                description="$*"
                break
                ;;
            *)
                args+=("$1")
                shift
                ;;
        esac
    done

    # Join remaining args as description
    if [[ -z "$description" && ${#args[@]} -gt 0 ]]; then
        description="${args[*]}"
    fi

    if [[ -z "$description" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_INPUT_MISSING" "Description required" "${EXIT_INVALID_INPUT:-1}" true "Usage: cleo migrate create \"description\""
        else
            output_error "$E_INPUT_MISSING" "Description required"
            echo "Usage: cleo migrate create \"description\"" >&2
        fi
        exit "${EXIT_INVALID_INPUT:-1}"
    fi

    # Validate file type
    if [[ ! "$file_type" =~ ^(todo|config|archive|log)$ ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_INPUT_INVALID" "Invalid file type: $file_type" "${EXIT_INVALID_INPUT:-1}" true "Valid types: todo, config, archive, log"
        else
            output_error "$E_INPUT_INVALID" "Invalid file type: $file_type"
            echo "Valid types: todo, config, archive, log" >&2
        fi
        exit "${EXIT_INVALID_INPUT:-1}"
    fi

    # Generate timestamp: YYYYMMDDHHMMSS
    local timestamp
    timestamp=$(date -u +%Y%m%d%H%M%S)

    # Sanitize description for filename (lowercase, underscores)
    local safe_desc
    safe_desc=$(echo "$description" | tr '[:upper:]' '[:lower:]' | tr ' ' '_' | tr -cd 'a-z0-9_')

    # Define paths
    local migrations_dir="$SCRIPT_DIR/../lib/migrations"
    local filename="${timestamp}_${safe_desc}.sh"
    local filepath="$migrations_dir/$filename"
    local fn_name="migrate_${file_type}_${timestamp}_${safe_desc}"

    # Dry-run mode: show what would be created without creating
    if [[ "${DRY_RUN:-false}" == "true" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            jq -nc \
                --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
                --arg file "$filepath" \
                --arg fn "$fn_name" \
                --arg desc "$description" \
                --arg type "$file_type" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "migrate",
                        "subcommand": "create",
                        "timestamp": $timestamp,
                        "format": "json"
                    },
                    "success": true,
                    "dryRun": true,
                    "wouldCreate": {
                        "file": $file,
                        "functionName": $fn,
                        "description": $desc,
                        "fileType": $type
                    }
                }'
        else
            echo "[dry-run] Would create migration: $filepath"
            echo "[dry-run] Function: $fn_name"
        fi
        return 0
    fi

    # Create migrations directory if needed
    mkdir -p "$migrations_dir"

    # Generate migration template
    cat > "$filepath" << EOF
#!/usr/bin/env bash
# Migration: $description
# Created: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# File Type: $file_type

# Migration function - called by migrate.sh
# Naming: migrate_<file_type>_<timestamp>_<description>
${fn_name}() {
    local file="\$1"
    local current_version="\$2"

    # TODO: Implement migration logic
    # Example: Add new field
    # jq '.newField = "default"' "\$file" > "\$file.tmp" && mv "\$file.tmp" "\$file"

    # Return 0 on success, non-zero on failure
    return 0
}

# Target version for this migration (extracted from function name)
get_migration_target_version() {
    echo "$timestamp"
}
EOF

    chmod +x "$filepath"

    # Output result
    if [[ "$FORMAT" == "json" ]]; then
        jq -nc \
            --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
            --arg file "$filepath" \
            --arg fn "$fn_name" \
            --arg desc "$description" \
            --arg type "$file_type" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "command": "migrate",
                    "subcommand": "create",
                    "timestamp": $timestamp,
                    "format": "json"
                },
                "success": true,
                "file": $file,
                "functionName": $fn,
                "description": $desc,
                "fileType": $type
            }'
    else
        echo "Created migration: $filepath"
        echo "Function: $fn_name"
    fi
}

# Show migration history from journal
cmd_history() {
    local project_dir="${1:-.}"
    local cleo_dir="$project_dir/.cleo"
    local journal_file="$cleo_dir/migrations.json"

    # Check if .cleo directory exists
    if [[ ! -d "$cleo_dir" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_NOT_INITIALIZED" "No .cleo directory found in $project_dir" "${EXIT_NOT_FOUND:-4}" true "Run 'cleo init' to initialize the project"
        else
            output_error "$E_NOT_INITIALIZED" "No .cleo directory found in $project_dir"
            echo "Run 'cleo init' to initialize the project" >&2
        fi
        exit "${EXIT_NOT_FOUND:-1}"
    fi

    # Check if migrations journal exists
    if [[ ! -f "$journal_file" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            jq -nc '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "command": "migrate",
                    "subcommand": "history",
                    "timestamp": (now | todate),
                    "format": "json"
                },
                "success": true,
                "message": "No migration history found",
                "migrations": []
            }'
        else
            echo "No migration history found"
            echo "Migrations will be tracked after the first migration is applied."
        fi
        return 0
    fi

    # Read migrations from journal
    if [[ "$FORMAT" == "json" ]]; then
        jq -n \
            --slurpfile journal "$journal_file" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "command": "migrate",
                    "subcommand": "history",
                    "timestamp": (now | todate),
                    "format": "json"
                },
                "success": true,
                "migrations": $journal[0].appliedMigrations
            }'
    else
        echo "Migration History"
        echo "================="
        echo ""

        local count
        count=$(jq '.appliedMigrations | length' "$journal_file")

        if [[ "$count" == "0" ]]; then
            echo "No migrations have been applied yet."
            return 0
        fi

        # Display table header
        printf "%-20s %-12s %-50s %-10s %-12s\n" "APPLIED AT" "FILE TYPE" "MIGRATION" "STATUS" "DURATION (ms)"
        printf "%-20s %-12s %-50s %-10s %-12s\n" "--------------------" "------------" "---------------------------------------------------" "----------" "------------"

        # Display each migration
        jq -r '.appliedMigrations[] |
            [.appliedAt, .fileType, .functionName // "version-bump", .status, (.executionTimeMs // 0 | tostring)] |
            @tsv' "$journal_file" | while IFS=$'\t' read -r applied_at file_type function_name status duration; do
            # Format timestamp (remove seconds for brevity)
            local short_date
            short_date=$(echo "$applied_at" | cut -d'T' -f1,2 | tr 'T' ' ' | cut -d':' -f1,2)

            # Truncate function name if too long
            if [[ ${#function_name} -gt 48 ]]; then
                function_name="${function_name:0:45}..."
            fi

            printf "%-20s %-12s %-50s %-10s %-12s\n" "$short_date" "$file_type" "$function_name" "$status" "$duration"
        done

        echo ""
        echo "Total migrations: $count"
    fi
}

# Repair schema to canonical structure
cmd_repair() {
    local project_dir="${1:-.}"
    local mode="${2:-interactive}"  # interactive, auto, dry-run

    local cleo_dir="$project_dir/.cleo"
    local todo_file="$cleo_dir/todo.json"

    if [[ ! -d "$cleo_dir" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_NOT_INITIALIZED" "No .cleo directory found in $project_dir" "${EXIT_NOT_FOUND:-4}" true "Run 'cleo init' to initialize the project"
        else
            output_error "$E_NOT_INITIALIZED" "No .cleo directory found in $project_dir"
            echo "Run 'cleo init' to initialize the project" >&2
        fi
        exit "${EXIT_NOT_FOUND:-1}"
    fi

    if [[ ! -f "$todo_file" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_FILE_NOT_FOUND" "No todo.json found in $cleo_dir" "${EXIT_FILE_ERROR:-4}" false ""
        else
            output_error "$E_FILE_NOT_FOUND" "No todo.json found in $cleo_dir"
        fi
        exit "${EXIT_FILE_ERROR:-1}"
    fi

    # For dry-run mode with JSON format, provide structured output
    if [[ "$mode" == "dry-run" && "$FORMAT" == "json" ]]; then
        # Get repair actions from lib/migrate.sh
        local actions
        if declare -f get_repair_actions &>/dev/null; then
            actions=$(get_repair_actions "$todo_file" 2>/dev/null || echo '{"needs_repair":false}')
        else
            actions='{"needs_repair":false}'
        fi

        local needs_repair
        needs_repair=$(echo "$actions" | jq -r '.needs_repair // false')

        jq -nc \
            --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
            --arg projectDir "$project_dir" \
            --arg todoFile "$todo_file" \
            --argjson needsRepair "$needs_repair" \
            --argjson actions "$actions" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "command": "migrate",
                    "subcommand": "repair",
                    "timestamp": $timestamp,
                    "format": "json"
                },
                "success": true,
                "dryRun": true,
                "projectDir": $projectDir,
                "file": $todoFile,
                "needsRepair": $needsRepair,
                "wouldRepair": (if $needsRepair then $actions else null end)
            }'
        exit "$EXIT_SUCCESS"
    fi

    echo "Schema Repair"
    echo "============="
    echo ""
    echo "Project: $project_dir"
    echo "File: $todo_file"
    echo ""

    # Call the repair function from lib/migrate.sh
    if ! repair_todo_schema "$todo_file" "$mode"; then
        exit "$EXIT_GENERAL_ERROR"
    fi
}

# Show migration status for all files
cmd_status() {
    local project_dir="${1:-.}"
    local cleo_dir="$project_dir/.cleo"

    if [[ ! -d "$cleo_dir" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_NOT_INITIALIZED" "No .cleo directory found in $project_dir" "${EXIT_NOT_FOUND:-4}" true "Run 'cleo init' to initialize the project"
        else
            output_error "$E_NOT_INITIALIZED" "No .cleo directory found in $project_dir"
            echo "Run 'cleo init' to initialize the project" >&2
        fi
        exit "${EXIT_NOT_FOUND:-1}"
    fi

    # Validate migration checksums (detect modified migrations)
    if [[ "$FORMAT" != "json" ]]; then
        echo "Checking migration integrity..."
    fi
    if ! validate_applied_checksums "$cleo_dir"; then
        if [[ "$FORMAT" == "json" ]]; then
            # Silent in JSON mode, but add to output later
            :
        else
            echo "⚠ WARNING: Some applied migrations have been modified" >&2
        fi
    fi

    if [[ "$FORMAT" == "json" ]]; then
        # JSON output
        local files_json="[]"
        local files=(
            "$cleo_dir/todo.json:todo"
            "$cleo_dir/config.json:config"
            "$cleo_dir/todo-archive.json:archive"
            "$cleo_dir/todo-log.json:log"
        )

        for file_spec in "${files[@]}"; do
            IFS=':' read -r file file_type <<< "$file_spec"

            if [[ ! -f "$file" ]]; then
                continue
            fi

            local current_version expected_version status_text needs_migration
            current_version=$(detect_file_version "$file")
            expected_version=$(get_expected_version "$file_type")

            local status
            check_compatibility "$file" "$file_type" && status=$? || status=$?

            # check_compatibility returns:
            # 0 = current (no action needed)
            # 1 = patch_only (just bump version)
            # 2 = migration_needed (MINOR change)
            # 3 = major_upgrade (MAJOR version upgrade - can migrate with --force)
            # 4 = data_newer (data is newer than schema - cannot migrate)
            case $status in
                0) status_text="current"; needs_migration=false ;;
                1) status_text="patch_update"; needs_migration=true ;;
                2) status_text="migration_needed"; needs_migration=true ;;
                3) status_text="major_upgrade"; needs_migration=true ;;
                4) status_text="data_newer"; needs_migration=false ;;
                *) status_text="unknown"; needs_migration=true ;;
            esac

            files_json=$(echo "$files_json" | jq \
                --arg type "$file_type" \
                --arg file "$file" \
                --arg current "$current_version" \
                --arg expected "$expected_version" \
                --arg status "$status_text" \
                --argjson needsMigration "$needs_migration" \
                '. + [{
                    "type": $type,
                    "file": $file,
                    "currentVersion": $current,
                    "expectedVersion": $expected,
                    "status": $status,
                    "needsMigration": $needsMigration
                }]')
        done

        # Get schema versions dynamically
        local todo_version config_version archive_version log_version
        todo_version=$(get_schema_version_from_file "todo" 2>/dev/null || echo "unknown")
        config_version=$(get_schema_version_from_file "config" 2>/dev/null || echo "unknown")
        archive_version=$(get_schema_version_from_file "archive" 2>/dev/null || echo "unknown")
        log_version=$(get_schema_version_from_file "log" 2>/dev/null || echo "unknown")

        jq -nc \
            --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
            --arg projectDir "$project_dir" \
            --argjson files "$files_json" \
            --arg todo "$todo_version" \
            --arg config "$config_version" \
            --arg archive "$archive_version" \
            --arg log "$log_version" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "command": "migrate",
                    "subcommand": "status",
                    "timestamp": $timestamp,
                    "format": "json"
                },
                "success": true,
                "projectDir": $projectDir,
                "files": $files,
                "targetVersions": {
                    "todo": $todo,
                    "config": $config,
                    "archive": $archive,
                    "log": $log
                }
            }'
    else
        show_migration_status "$cleo_dir"
    fi
}

# Check if migration is needed
cmd_check() {
    local project_dir="${1:-.}"
    local cleo_dir="$project_dir/.cleo"

    if [[ ! -d "$cleo_dir" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_NOT_INITIALIZED" "No .cleo directory found" "${EXIT_NOT_FOUND:-4}" true "Run 'cleo init' to initialize the project"
        else
            output_error "$E_NOT_INITIALIZED" "No .cleo directory found"
        fi
        exit "${EXIT_NOT_FOUND:-1}"
    fi

    local needs_migration=false
    local files=(
        "$cleo_dir/todo.json:todo"
        "$cleo_dir/config.json:config"
        "$cleo_dir/todo-archive.json:archive"
        "$cleo_dir/todo-log.json:log"
    )

    for file_spec in "${files[@]}"; do
        IFS=':' read -r file file_type <<< "$file_spec"

        if [[ ! -f "$file" ]]; then
            continue
        fi

        # check_compatibility returns:
        # 0 = current (no action needed)
        # 1 = patch_only (just bump version)
        # 2 = migration_needed (MINOR change)
        # 3 = major_upgrade (MAJOR version upgrade - can migrate with --force)
        # 4 = data_newer (data is newer than schema - cannot migrate)
        local status
        check_compatibility "$file" "$file_type" && status=$? || status=$?

        case $status in
            0) ;; # Current, no action needed
            1|2|3)
                needs_migration=true
                break
                ;;
            4)
                # Data is newer than schema - cannot migrate
                if [[ "$FORMAT" == "json" ]]; then
                    local current_version expected_version
                    current_version=$(detect_file_version "$file")
                    expected_version=$(get_expected_version "$file_type")
                    jq -nc \
                        --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
                        --arg file "$file" \
                        --arg current "$current_version" \
                        --arg expected "$expected_version" \
                        '{
                            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                            "_meta": {"command": "migrate", "subcommand": "check", "timestamp": $timestamp, "format": "json"},
                            "success": false,
                            "error": {
                                "code": "E_DATA_NEWER",
                                "message": "Data version newer than schema - upgrade cleo",
                                "file": $file,
                                "dataVersion": $current,
                                "schemaVersion": $expected
                            }
                        }'
                else
                    output_error "$E_INPUT_INVALID" "Data version newer than schema in $file - upgrade cleo"
                fi
                exit "${EXIT_INVALID_INPUT:-1}"
                ;;
        esac
    done

    if [[ "$FORMAT" == "json" ]]; then
        jq -nc \
            --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
            --argjson needed "$needs_migration" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {"command": "migrate", "subcommand": "check", "timestamp": $timestamp, "format": "json"},
                "success": true,
                "migrationNeeded": $needed
            }'
        if [[ "$needs_migration" == "true" ]]; then
            exit "$EXIT_GENERAL_ERROR"
        else
            exit "$EXIT_SUCCESS"
        fi
    else
        if [[ "$needs_migration" == "true" ]]; then
            echo "Migration needed"
            exit "$EXIT_GENERAL_ERROR"
        else
            echo "All files up to date"
            exit "$EXIT_SUCCESS"
        fi
    fi
}

# Run migration for all files
cmd_run() {
    local project_dir="${1:-.}"
    local auto_migrate="${2:-false}"
    local create_backup="${3:-true}"
    local force_migration="${4:-false}"

    local cleo_dir="$project_dir/.cleo"

    if [[ ! -d "$cleo_dir" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_NOT_INITIALIZED" "No .cleo directory found" "${EXIT_NOT_FOUND:-4}" true "Run 'cleo init' to initialize the project"
        else
            output_error "$E_NOT_INITIALIZED" "No .cleo directory found"
        fi
        exit "${EXIT_NOT_FOUND:-1}"
    fi

    echo "Schema Migration"
    echo "================"
    echo ""
    echo "Project: $project_dir"
    echo "Target versions:"
    echo "  todo:    $(get_schema_version_from_file "todo" 2>/dev/null || echo "unknown")"
    echo "  config:  $(get_schema_version_from_file "config" 2>/dev/null || echo "unknown")"
    echo "  archive: $(get_schema_version_from_file "archive" 2>/dev/null || echo "unknown")"
    echo "  log:     $(get_schema_version_from_file "log" 2>/dev/null || echo "unknown")"
    echo ""

    # Validate migration checksums (detect modified migrations)
    echo "Validating migration integrity..."
    if ! validate_applied_checksums "$cleo_dir"; then
        echo "" >&2
        echo "⚠ WARNING: One or more applied migrations have been modified!" >&2
        echo "This may indicate code tampering or version mismatch." >&2
        echo "" >&2
        if [[ "$force_migration" != "true" ]]; then
            echo "Migration aborted. Use --force to proceed anyway." >&2
            exit "${EXIT_VALIDATION_ERROR:-6}"
        fi
        echo "Continuing due to --force flag..." >&2
    else
        echo "✓ Migration integrity verified"
    fi
    echo ""

    # Check status first
    local files=(
        "$cleo_dir/todo.json:todo"
        "$cleo_dir/config.json:config"
        "$cleo_dir/todo-archive.json:archive"
        "$cleo_dir/todo-log.json:log"
    )

    local migration_needed=false
    local major_upgrade_needed=false
    local data_newer_found=false
    local problematic_file=""

    for file_spec in "${files[@]}"; do
        IFS=':' read -r file file_type <<< "$file_spec"

        if [[ ! -f "$file" ]]; then
            continue
        fi

        # check_compatibility returns:
        # 0 = current (no action needed)
        # 1 = patch_only (just bump version)
        # 2 = migration_needed (MINOR change)
        # 3 = major_upgrade (MAJOR version upgrade - can migrate with --force)
        # 4 = data_newer (data is newer than schema - cannot migrate)
        local status
        check_compatibility "$file" "$file_type" && status=$? || status=$?

        case $status in
            1|2) migration_needed=true ;;
            3)   migration_needed=true; major_upgrade_needed=true ;;
            4)   data_newer_found=true; problematic_file="$file" ;;
        esac
    done

    # Data newer than schema - cannot migrate, need to upgrade cleo
    if [[ "$data_newer_found" == "true" ]]; then
        local current_version expected_version
        current_version=$(detect_file_version "$problematic_file")
        expected_version=$(get_expected_version "$(echo "$problematic_file" | sed 's/.*\///' | sed 's/\.json$//' | sed 's/todo-//')")
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_INPUT_INVALID" "Data version ($current_version) newer than schema ($expected_version)" "${EXIT_INVALID_INPUT:-1}" true "Upgrade cleo to a newer version"
        else
            output_error "$E_INPUT_INVALID" "Data version ($current_version) is newer than schema ($expected_version)"
            echo "Your data was created by a newer version of cleo." >&2
            echo "Please upgrade cleo: npm install -g cleo OR update from source" >&2
        fi
        exit "${EXIT_INVALID_INPUT:-1}"
    fi

    # Major version upgrades (e.g., 0.x → 2.x) require --force
    if [[ "$major_upgrade_needed" == "true" && "$force_migration" == "false" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_INPUT_INVALID" "Major version upgrade detected" "${EXIT_INVALID_INPUT:-1}" true "Use --force to upgrade from legacy schema"
        else
            output_error "$E_INPUT_INVALID" "Major version upgrade detected (e.g., 0.x → 2.x)"
            echo "Use: cleo migrate run --force" >&2
        fi
        exit "${EXIT_INVALID_INPUT:-1}"
    fi

    if [[ "$migration_needed" == "false" && "$force_migration" == "false" ]]; then
        echo "✓ All files already at current versions"
        exit "$EXIT_SUCCESS"
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
            exit "$EXIT_SUCCESS"
        fi
    fi

    # Create project backup if requested using unified backup library
    if [[ "$create_backup" == "true" ]]; then
        echo "Creating project backup..."

        # Try using unified backup library first
        if declare -f create_migration_backup >/dev/null 2>&1; then
            local target_version
            target_version=$(get_schema_version_from_file "todo" 2>/dev/null || echo "unknown")
            BACKUP_PATH=$(create_migration_backup "$target_version" 2>&1) || {
                echo "⚠ Backup library failed, using fallback backup method" >&2
                # Fallback to inline backup if library fails
                local backup_dir="${claude_dir}/backups/migration/pre-migration-$(date +%Y%m%d-%H%M%S)"
                mkdir -p "$backup_dir"

                for file_spec in "${files[@]}"; do
                    IFS=':' read -r file file_type <<< "$file_spec"
                    if [[ -f "$file" ]]; then
                        cp "$file" "$backup_dir/" || {
                            output_error "$E_FILE_WRITE_ERROR" "Failed to create backup"
                            exit "${EXIT_FILE_ERROR:-1}"
                        }
                    fi
                done
                BACKUP_PATH="$backup_dir"
            }
            echo "✓ Backup created: $BACKUP_PATH"
        else
            # Fallback if backup library not available
            local backup_dir="${claude_dir}/backups/migration/pre-migration-$(date +%Y%m%d-%H%M%S)"
            mkdir -p "$backup_dir"

            for file_spec in "${files[@]}"; do
                IFS=':' read -r file file_type <<< "$file_spec"
                if [[ -f "$file" ]]; then
                    cp "$file" "$backup_dir/" || {
                        output_error "$E_FILE_WRITE_ERROR" "Failed to create backup"
                        exit "${EXIT_FILE_ERROR:-1}"
                    }
                fi
            done
            echo "✓ Backup created: $backup_dir"
        fi
        echo ""
    fi

    # Perform migration
    local migration_failed=false

    for file_spec in "${files[@]}"; do
        IFS=':' read -r file file_type <<< "$file_spec"

        if [[ ! -f "$file" ]]; then
            continue
        fi

        # check_compatibility returns:
        # 0 = current, 1 = patch, 2 = minor, 3 = major, 4 = data_newer
        local status
        check_compatibility "$file" "$file_type" && status=$? || status=$?

        # Skip status 4 (data_newer) - already handled above
        # Force migration if flag is set, otherwise only migrate if status 1-3
        if [[ ($status -ge 1 && $status -le 3) || "$force_migration" == "true" ]]; then
            local current_version expected_version
            current_version=$(detect_file_version "$file")
            expected_version=$(get_expected_version "$file_type")

            if [[ "$force_migration" == "true" && $status -eq 0 ]]; then
                echo "Migrating $file_type (forced)..."
            elif [[ $status -eq 3 ]]; then
                echo "Migrating $file_type (major upgrade: $current_version → $expected_version)..."
            elif [[ $status -eq 1 ]]; then
                echo "Migrating $file_type (patch: $current_version → $expected_version)..."
            else
                echo "Migrating $file_type ($current_version → $expected_version)..."
            fi

            if ! migrate_file "$file" "$file_type" "$current_version" "$expected_version"; then
                echo "✗ Migration failed for $file_type" >&2
                migration_failed=true
                break
            fi

            echo ""
        fi
    done

    if [[ "$migration_failed" == "true" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_FILE_WRITE_ERROR" "Migration failed" "${EXIT_FILE_ERROR:-4}" true "Backups available in: ${claude_dir}/backups/migration/"
        else
            output_error "$E_FILE_WRITE_ERROR" "Migration failed"
            echo "Backups available in: ${claude_dir}/backups/migration/" >&2
        fi
        exit "${EXIT_FILE_ERROR:-1}"
    fi

    echo "✓ Migration completed successfully"
}

# Migrate specific file
cmd_file() {
    local file="$1"
    local file_type="$2"

    if [[ ! -f "$file" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_FILE_NOT_FOUND" "File not found: $file" "${EXIT_FILE_ERROR:-4}" false ""
        else
            output_error "$E_FILE_NOT_FOUND" "File not found: $file"
        fi
        exit "${EXIT_FILE_ERROR:-1}"
    fi

    local status
    check_compatibility "$file" "$file_type" && status=$? || status=$?

    case $status in
        0)
            echo "✓ File already at current version"
            exit "$EXIT_SUCCESS"
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
                exit "$EXIT_SUCCESS"
            else
                echo "✗ Migration failed" >&2
                exit "$EXIT_GENERAL_ERROR"
            fi
            ;;
        2)
            if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
                output_error "$E_INPUT_INVALID" "Incompatible version - manual intervention required" "${EXIT_INVALID_INPUT:-1}" false ""
            else
                output_error "$E_INPUT_INVALID" "Incompatible version - manual intervention required"
            fi
            exit "${EXIT_INVALID_INPUT:-1}"
            ;;
    esac
}

# Rollback from migration backup
cmd_rollback() {
    local project_dir="${1:-.}"
    local backup_id="${2:-}"
    local force="${3:-false}"

    local cleo_dir="$project_dir/.cleo"
    local backups_dir="$cleo_dir/backups/migration"

    if [[ ! -d "$cleo_dir" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_NOT_INITIALIZED" "No .cleo directory found in $project_dir" "${EXIT_NOT_FOUND:-4}" true "Run 'cleo init' to initialize the project"
        else
            output_error "$E_NOT_INITIALIZED" "No .cleo directory found in $project_dir"
            echo "Run 'cleo init' to initialize the project" >&2
        fi
        exit "${EXIT_NOT_FOUND:-1}"
    fi

    if [[ ! -d "$backups_dir" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_FILE_NOT_FOUND" "No migration backups found" "${EXIT_FILE_ERROR:-4}" true "Migration backups directory does not exist: $backups_dir"
        else
            output_error "$E_FILE_NOT_FOUND" "No migration backups found"
            echo "Migration backups directory does not exist: $backups_dir" >&2
        fi
        exit "${EXIT_FILE_ERROR:-1}"
    fi

    # Find migration backup to use
    local backup_path=""

    if [[ -n "$backup_id" ]]; then
        # Use specific backup ID
        backup_path="$backups_dir/$backup_id"

        if [[ ! -d "$backup_path" ]]; then
            if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
                output_error "$E_FILE_NOT_FOUND" "Backup not found: $backup_id" "${EXIT_FILE_ERROR:-4}" false ""
            else
                output_error "$E_FILE_NOT_FOUND" "Backup not found: $backup_id"
                echo "Available migration backups:" >&2
                find "$backups_dir" -maxdepth 1 -type d -name "migration_*" -exec basename {} \; 2>/dev/null | sort -r | head -5
            fi
            exit "${EXIT_FILE_ERROR:-1}"
        fi
    else
        # Find most recent migration backup
        backup_path=$(find "$backups_dir" -maxdepth 1 -type d -name "migration_*" -print0 2>/dev/null | \
            xargs -0 ls -dt 2>/dev/null | head -1)

        if [[ -z "$backup_path" ]]; then
            if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
                output_error "$E_FILE_NOT_FOUND" "No migration backups found in $backups_dir" "${EXIT_FILE_ERROR:-4}" false ""
            else
                output_error "$E_FILE_NOT_FOUND" "No migration backups found in $backups_dir"
            fi
            exit "${EXIT_FILE_ERROR:-1}"
        fi
    fi

    local backup_name
    backup_name=$(basename "$backup_path")

    echo "Migration Rollback"
    echo "=================="
    echo ""
    echo "Backup: $backup_name"
    echo "Path:   $backup_path"
    echo ""

    # Verify backup integrity
    if [[ ! -f "$backup_path/metadata.json" ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_FILE_NOT_FOUND" "Backup metadata not found" "${EXIT_FILE_ERROR:-4}" true "Backup may be corrupted: $backup_path"
        else
            output_error "$E_FILE_NOT_FOUND" "Backup metadata not found"
            echo "Backup may be corrupted: $backup_path" >&2
        fi
        exit "${EXIT_FILE_ERROR:-1}"
    fi

    # Show backup metadata
    local timestamp
    timestamp=$(jq -r '.timestamp // "unknown"' "$backup_path/metadata.json" 2>/dev/null)
    local files
    files=$(jq -r '.files[].source' "$backup_path/metadata.json" 2>/dev/null)

    echo "Backup Information:"
    echo "  Created: $timestamp"
    echo "  Files:"
    while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        echo "    - $file"
    done <<< "$files"
    echo ""

    # Confirm rollback
    if [[ "$force" != "true" ]]; then
        echo "⚠ WARNING: This will restore all files from the backup."
        echo "  Current files will be backed up before restoration."
        echo ""
        read -p "Continue with rollback? (y/N) " -r
        echo ""

        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Rollback cancelled"
            exit "$EXIT_SUCCESS"
        fi
    fi

    # Create pre-rollback safety backup
    echo "Creating safety backup before rollback..."
    local safety_backup="$cleo_dir/backups/safety/safety_$(date +"%Y%m%d_%H%M%S")_pre_rollback"
    mkdir -p "$safety_backup"

    local files=(
        "$cleo_dir/todo.json"
        "$cleo_dir/config.json"
        "$cleo_dir/todo-archive.json"
        "$cleo_dir/todo-log.json"
    )

    for file in "${files[@]}"; do
        if [[ -f "$file" ]]; then
            cp "$file" "$safety_backup/" || {
                output_error "$E_FILE_WRITE_ERROR" "Failed to create safety backup"
                exit "${EXIT_FILE_ERROR:-1}"
            }
        fi
    done
    echo "✓ Safety backup created: $safety_backup"
    echo ""

    # Restore files from migration backup
    echo "Restoring files from backup..."
    local restore_errors=0
    local restored_files=()

    for file_spec in "${files[@]}"; do
        local filename
        filename=$(basename "$file_spec")
        local source_file="$backup_path/$filename"
        local target_file="$file_spec"

        if [[ ! -f "$source_file" ]]; then
            echo "⚠ Skipping $filename (not in backup)"
            continue
        fi

        # Validate JSON in backup
        if ! jq empty "$source_file" 2>/dev/null; then
            output_error "$E_INPUT_INVALID" "Invalid JSON in backup: $filename"
            ((restore_errors++))
            continue
        fi

        # Restore file
        if cp "$source_file" "$target_file"; then
            echo "✓ Restored $filename"
            restored_files+=("$filename")
        else
            echo "✗ Failed to restore $filename" >&2
            ((restore_errors++))
        fi
    done

    echo ""

    # Check for errors
    if [[ $restore_errors -gt 0 ]]; then
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_FILE_WRITE_ERROR" "Rollback completed with $restore_errors errors" "${EXIT_FILE_ERROR:-4}" true "Safety backup available at: $safety_backup"
        else
            output_error "$E_FILE_WRITE_ERROR" "Rollback completed with $restore_errors errors"
            echo "Safety backup available at: $safety_backup" >&2
        fi
        exit "${EXIT_FILE_ERROR:-1}"
    fi

    # Validate all restored files
    echo "Validating restored files..."
    local validation_errors=0

    for filename in "${restored_files[@]}"; do
        local target_file="$cleo_dir/$filename"

        if [[ -f "$target_file" ]]; then
            if ! jq empty "$target_file" 2>/dev/null; then
                echo "✗ Validation failed: $filename" >&2
                ((validation_errors++))
            fi
        fi
    done

    if [[ $validation_errors -gt 0 ]]; then
        echo ""
        if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
            output_error "$E_INPUT_INVALID" "Validation failed after rollback" "${EXIT_INVALID_INPUT:-1}" true "Safety backup available at: $safety_backup"
        else
            output_error "$E_INPUT_INVALID" "Validation failed after rollback"
            echo "Safety backup available at: $safety_backup" >&2
        fi
        exit "${EXIT_INVALID_INPUT:-1}"
    fi

    echo "✓ All files validated successfully"
    echo ""

    # Show current versions after rollback
    echo "Current Schema Versions:"
    for file_spec in "${files[@]}"; do
        local filename
        filename=$(basename "$file_spec")
        local file_type

        case "$filename" in
            todo.json)
                file_type="todo"
                ;;
            config.json)
                file_type="config"
                ;;
            todo-archive.json)
                file_type="archive"
                ;;
            todo-log.json)
                file_type="log"
                ;;
            *)
                continue
                ;;
        esac

        if [[ -f "$file_spec" ]]; then
            local version
            version=$(detect_file_version "$file_spec")
            echo "  $file_type: v$version"
        fi
    done

    echo ""
    echo "✓ Rollback completed successfully"
    echo ""
    echo "Note: Safety backup of pre-rollback state available at:"
    echo "  $safety_backup"
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    # Handle global help flag first
    if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
        show_usage
        exit "$EXIT_SUCCESS"
    fi

    # Developer mode check (prevents agents from using low-level tool)
    check_developer_mode "$@"

    local command="${1:-}"
    shift || true

    # Parse options based on command
    local project_dir="."
    local auto_migrate=false
    local create_backup=true
    local force_migration=false
    local backup_id=""
    local dry_run=false
    local remaining_args=()

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
            --backup-id)
                backup_id="$2"
                shift 2
                ;;
            --dry-run)
                dry_run=true
                DRY_RUN=true
                shift
                ;;
            -f|--format)
                FORMAT="$2"
                shift 2
                ;;
            --human)
                FORMAT="human"
                shift
                ;;
            --json)
                FORMAT="json"
                shift
                ;;
            -q|--quiet)
                QUIET=true
                shift
                ;;
            -h|--help)
                show_usage
                exit "$EXIT_SUCCESS"
                ;;
            *)
                # Collect non-option args for subcommands like 'create'
                remaining_args+=("$1")
                shift
                ;;
        esac
    done

    # Restore non-option args (only if we have any)
    if [[ ${#remaining_args[@]} -gt 0 ]]; then
        set -- "${remaining_args[@]}"
    else
        set --
    fi

    # Resolve output format (CLI > env > config > TTY-aware default)
    if declare -f resolve_format &>/dev/null; then
        FORMAT=$(resolve_format "$FORMAT")
    else
        FORMAT="${FORMAT:-text}"
    fi

    # Check jq dependency after format is resolved
    check_jq_dependency

    # Special handling for create command after format is resolved
    if [[ "$command" == "create" || "$command" == "new" ]]; then
        create_migration "$@"
        exit $?
    fi

    case "$command" in
        "status")
            cmd_status "$project_dir"
            ;;
        "history")
            cmd_history "$project_dir"
            ;;
        "check")
            cmd_check "$project_dir"
            ;;
        "run")
            cmd_run "$project_dir" "$auto_migrate" "$create_backup" "$force_migration"
            ;;
        "file")
            if [[ $# -lt 2 ]]; then
                if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
                    output_error "$E_INPUT_MISSING" "Missing arguments for 'file' command" "${EXIT_INVALID_INPUT:-1}" true "Usage: cleo migrate file <path> <type>"
                else
                    output_error "$E_INPUT_MISSING" "Missing arguments for 'file' command"
                    echo "Usage: cleo migrate file <path> <type>" >&2
                fi
                exit "${EXIT_INVALID_INPUT:-1}"
            fi
            cmd_file "$1" "$2"
            ;;
        "rollback")
            cmd_rollback "$project_dir" "$backup_id" "$force_migration"
            ;;
        "repair")
            # Determine repair mode from flags
            local repair_mode="interactive"
            if [[ "$dry_run" == "true" ]]; then
                repair_mode="dry-run"
            elif [[ "$auto_migrate" == "true" ]]; then
                repair_mode="auto"
            fi
            cmd_repair "$project_dir" "$repair_mode"
            ;;
        "")
            show_usage
            exit "$EXIT_INVALID_INPUT"
            ;;
        *)
            if [[ "$FORMAT" == "json" ]] && declare -f output_error &>/dev/null; then
                output_error "$E_INPUT_INVALID" "Unknown command: $command" "${EXIT_INVALID_INPUT:-1}" true "Run 'cleo migrate --help' for usage"
            else
                output_error "$E_INPUT_INVALID" "Unknown command: $command"
                echo "" >&2
                show_usage
            fi
            exit "${EXIT_INVALID_INPUT:-1}"
            ;;
    esac
}

main "$@"
