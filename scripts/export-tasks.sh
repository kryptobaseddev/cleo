#!/usr/bin/env bash
###CLEO
# command: export-tasks
# category: sync
# synopsis: Export tasks to portable JSON package for cross-project transfer
# relevance: medium
# flags: --format,--output,--subtree,--filter,--include-deps,--dry-run,--interactive
# exits: 0,2,3,4
# json-output: true
###END
# =============================================================================
# export-tasks.sh - Export task selection to portable package format
# =============================================================================
# Export specific tasks, subtrees, or filtered task sets to .cleo-export.json
# format for cross-project import with relationship preservation.
#
# Implements Cross-Project Task Import/Export System (v1.0.0)
# See: claudedocs/IMPORT-EXPORT-SPEC.md
# See: claudedocs/IMPORT-EXPORT-ALGORITHMS.md
# Schema: schemas/export-package.schema.json
#
# Usage:
#   cleo export-tasks T001 --output auth.cleo-export.json
#   cleo export-tasks T001 --subtree --output auth-epic.cleo-export.json
#   cleo export-tasks --filter status=pending --output pending.cleo-export.json
#   cleo export-tasks T001,T005 --include-deps --dry-run
#   cleo export-tasks --interactive
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Script directory and library paths
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source paths.sh for path resolution functions
if [[ -f "$LIB_DIR/paths.sh" ]]; then
    source "$LIB_DIR/paths.sh"
fi

# Default file paths
TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"
LOG_FILE="${LOG_FILE:-.cleo/todo-log.json}"

# Source required libraries
if [[ -f "$LIB_DIR/version.sh" ]]; then
    # shellcheck source=../lib/version.sh
    source "$LIB_DIR/version.sh"
fi

if [[ -f "$LIB_DIR/logging.sh" ]]; then
    # shellcheck source=../lib/logging.sh
    source "$LIB_DIR/logging.sh"
fi

if [[ -f "$LIB_DIR/validation.sh" ]]; then
    # shellcheck source=../lib/validation.sh
    source "$LIB_DIR/validation.sh"
fi

if [[ -f "$LIB_DIR/file-ops.sh" ]]; then
    # shellcheck source=../lib/file-ops.sh
    source "$LIB_DIR/file-ops.sh"
fi

if [[ -f "$LIB_DIR/output-format.sh" ]]; then
    # shellcheck source=../lib/output-format.sh
    source "$LIB_DIR/output-format.sh"
fi

# Source exit codes first
if [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
    # shellcheck source=../lib/exit-codes.sh
    source "$LIB_DIR/exit-codes.sh"
fi

# Source error JSON library for structured error output
if [[ -f "$LIB_DIR/error-json.sh" ]]; then
    # shellcheck source=../lib/error-json.sh
    source "$LIB_DIR/error-json.sh"
fi

if [[ -f "$LIB_DIR/export.sh" ]]; then
    # shellcheck source=../lib/export.sh
    source "$LIB_DIR/export.sh"
fi

# Source centralized flag parsing
if [[ -f "$LIB_DIR/flags.sh" ]]; then
    # shellcheck source=../lib/flags.sh
    source "$LIB_DIR/flags.sh"
fi

# Colors (respects NO_COLOR and FORCE_COLOR environment variables)
if declare -f should_use_color >/dev/null 2>&1 && should_use_color; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

# -----------------------------------------------------------------------------
# Default values
# -----------------------------------------------------------------------------
TASK_IDS=""                  # Comma or space-separated task IDs
OUTPUT_FILE=""               # Output file path (default: stdout)
SUBTREE_MODE=false           # Include all descendants
INCLUDE_DEPS=false           # Auto-include dependencies
DRY_RUN=false               # Preview without writing
FORMAT="json"                # Output format (json|human)
INTERACTIVE_MODE=false           # Interactive task selection UI
QUIET=false                  # Suppress messages

# Filter options (repeatable --filter key=value)
declare -a FILTERS=()

# Export mode (inferred from arguments)
EXPORT_MODE=""               # single|subtree|filter|full

# -----------------------------------------------------------------------------
# Help text
# -----------------------------------------------------------------------------
usage() {
    cat << 'EOF'
Usage: cleo export-tasks [TASK_IDS] [OPTIONS]

Export tasks to portable .cleo-export.json format for cross-project import.

Arguments:
  TASK_IDS              Comma or space-separated task IDs (e.g., T001,T002)
                        Omit to export by filter or full project

Options:
  -o, --output FILE     Output file path (default: stdout)
                        Use .cleo-export.json extension by convention

  --subtree             Include all descendants of specified task(s)
                        Task + children + grandchildren, etc.

  --filter KEY=VALUE    Filter tasks by criteria (repeatable)
                        Supported: status=X, phase=X, labels=X, priority=X, type=X
                        Example: --filter status=pending --filter phase=core

  --include-deps        Auto-include task dependencies
  --interactive         Interactive task selection UI
                        Uses fzf if available, fallback to numbered list
                        Ensures dependency graph is complete in export

  --dry-run             Preview selection without creating export file
                        Shows what would be exported with task count

Output Options:
  -f, --format FORMAT   Output format: json|human (default: json)
  --json                Shortcut for --format json
  --human               Shortcut for --format human
  -q, --quiet           Suppress informational messages
  -h, --help            Show this help

Export Modes:
  single      Export specific task IDs only (no children)
  subtree     Export task(s) and all descendants
  filter      Export tasks matching filter criteria
  full        Export entire project (use with caution)

Examples:
  # Export single task
  cleo export-tasks T001 --output auth-task.cleo-export.json

  # Export task and all children
  cleo export-tasks T001 --subtree --output auth-epic.cleo-export.json

  # Export multiple specific tasks
  cleo export-tasks T001,T005,T010 --output selected.cleo-export.json

  # Export by filter
  cleo export-tasks --filter status=pending --filter phase=core --output core.cleo-export.json

  # Export with dependencies auto-included
  cleo export-tasks T003 --include-deps --output task-with-deps.cleo-export.json
  --interactive         Interactive task selection UI
                        Uses fzf if available, fallback to numbered list

  # Preview what would be exported
  cleo export-tasks T001 --subtree --dry-run

  # Export to stdout (for piping)
  cleo export-tasks T001 --subtree

Package Format:
  Exports create .cleo-export.json packages containing:
  - Full task objects with all fields
  - ID mapping for relationship tracking
  - Relationship graph (hierarchy + dependencies)
  - Source project metadata and checksum

  Use 'cleo import-tasks' to import packages into target project.

Exit Codes:
  0  = Success (EXIT_SUCCESS)
  2  = Invalid input or arguments (EXIT_INVALID_INPUT)
  3  = File operation failure (EXIT_FILE_ERROR)
  4  = Resource not found (EXIT_NOT_FOUND)
  6  = Validation error (EXIT_VALIDATION_ERROR)

See Also:
  cleo import-tasks     Import tasks from .cleo-export.json package

Documentation:
  claudedocs/IMPORT-EXPORT-SPEC.md - Full specification
  schemas/export-package.schema.json - Package schema
EOF
    exit "${EXIT_SUCCESS:-0}"
}

# -----------------------------------------------------------------------------
# Logging functions
# -----------------------------------------------------------------------------
log_error() {
    local error_code="${2:-$E_UNKNOWN}"
    if declare -f output_error >/dev/null 2>&1; then
        output_error "$error_code" "$1"
    else
        echo -e "${RED}[ERROR]${NC} $1" >&2
    fi
}

log_warn() {
    if [[ "$QUIET" != "true" ]] && [[ "${FORMAT:-json}" != "json" ]]; then
        echo -e "${YELLOW}[WARN]${NC} $1" >&2
    fi
}

log_info() {
    if [[ "$QUIET" != "true" ]] && [[ "${FORMAT:-json}" != "json" ]]; then
        echo -e "${GREEN}[INFO]${NC} $1" >&2
    fi
}

# -----------------------------------------------------------------------------
# Dependency checks
# -----------------------------------------------------------------------------
check_deps() {
    if ! command -v jq &> /dev/null; then
        log_error "jq is required but not installed" "$E_DEPENDENCY_MISSING"
        echo "Install: sudo apt-get install jq  # Debian/Ubuntu" >&2
        echo "         brew install jq          # macOS" >&2
        exit "${EXIT_DEPENDENCY_ERROR:-5}"
    fi
}

# -----------------------------------------------------------------------------
# Stub functions (to be implemented by other tasks)
# -----------------------------------------------------------------------------

# collect_task_selection - Gather tasks based on mode and filters
#
# Args:
#   None (uses global variables: TASK_IDS, SUBTREE_MODE, FILTERS, EXPORT_MODE)
#
# Returns:
#   JSON array of tasks matching selection criteria
#
# Implementation: T1274, T1276 (task selection with filter support)
collect_task_selection() {
    local all_tasks
    all_tasks=$(jq -c '.tasks' "$TODO_FILE")

    # Mode: filter-based export
    if [[ "$EXPORT_MODE" == "filter" ]]; then
        log_info "Applying filters to task list..."

        # Parse filters into associative array
        declare -A filter_map
        for filter in "${FILTERS[@]}"; do
            # Parse KEY=VALUE format
            if [[ "$filter" =~ ^([a-zA-Z]+)=(.+)$ ]]; then
                local key="${BASH_REMATCH[1]}"
                local value="${BASH_REMATCH[2]}"
                filter_map[$key]="$value"
            else
                log_warn "Invalid filter format (expected KEY=VALUE): $filter"
            fi
        done

        # Build jq filter expression
        local filter_parts=()

        # Status filter (OR logic within status values)
        if [[ -n "${filter_map[status]:-}" ]]; then
            local status_filter="${filter_map[status]}"
            IFS=',' read -ra status_array <<< "$status_filter"
            local status_conditions=()
            for s in "${status_array[@]}"; do
                s=$(echo "$s" | xargs)  # Trim whitespace
                status_conditions+=(".status == \"$s\"")
            done
            if [[ ${#status_conditions[@]} -eq 1 ]]; then
                filter_parts+=("${status_conditions[0]}")
            else
                local status_expr="(${status_conditions[0]}"
                for ((i=1; i<${#status_conditions[@]}; i++)); do
                    status_expr="$status_expr or ${status_conditions[i]}"
                done
                status_expr="$status_expr)"
                filter_parts+=("$status_expr")
            fi
        fi

        # Phase filter
        if [[ -n "${filter_map[phase]:-}" ]]; then
            filter_parts+=("(.phase == \"${filter_map[phase]}\")")
        fi

        # Priority filter (OR logic)
        if [[ -n "${filter_map[priority]:-}" ]]; then
            local priority_filter="${filter_map[priority]}"
            IFS=',' read -ra priority_array <<< "$priority_filter"
            local priority_conditions=()
            for p in "${priority_array[@]}"; do
                p=$(echo "$p" | xargs)
                priority_conditions+=(".priority == \"$p\"")
            done
            if [[ ${#priority_conditions[@]} -eq 1 ]]; then
                filter_parts+=("${priority_conditions[0]}")
            else
                local priority_expr="(${priority_conditions[0]}"
                for ((i=1; i<${#priority_conditions[@]}; i++)); do
                    priority_expr="$priority_expr or ${priority_conditions[i]}"
                done
                priority_expr="$priority_expr)"
                filter_parts+=("$priority_expr")
            fi
        fi

        # Labels filter (OR logic - task must have at least one)
        if [[ -n "${filter_map[labels]:-}" ]]; then
            local label_filter="${filter_map[labels]}"
            IFS=',' read -ra label_array <<< "$label_filter"
            local label_conditions=()
            for l in "${label_array[@]}"; do
                l=$(echo "$l" | xargs)
                label_conditions+=("(.labels // [] | contains([\"$l\"]))")
            done
            if [[ ${#label_conditions[@]} -eq 1 ]]; then
                filter_parts+=("${label_conditions[0]}")
            else
                local label_expr="(${label_conditions[0]}"
                for ((i=1; i<${#label_conditions[@]}; i++)); do
                    label_expr="$label_expr or ${label_conditions[i]}"
                done
                label_expr="$label_expr)"
                filter_parts+=("$label_expr")
            fi
        fi

        # Type filter (OR logic)
        if [[ -n "${filter_map[type]:-}" ]]; then
            local type_filter="${filter_map[type]}"
            IFS=',' read -ra type_array <<< "$type_filter"
            local type_conditions=()
            for t in "${type_array[@]}"; do
                t=$(echo "$t" | xargs)
                type_conditions+=("(.type // \"task\") == \"$t\"")
            done
            if [[ ${#type_conditions[@]} -eq 1 ]]; then
                filter_parts+=("${type_conditions[0]}")
            else
                local type_expr="(${type_conditions[0]}"
                for ((i=1; i<${#type_conditions[@]}; i++)); do
                    type_expr="$type_expr or ${type_conditions[i]}"
                done
                type_expr="$type_expr)"
                filter_parts+=("$type_expr")
            fi
        fi

        # Combine all filters with AND logic
        local combined_filter="true"
        if [[ ${#filter_parts[@]} -gt 0 ]]; then
            combined_filter="${filter_parts[0]}"
            for ((i=1; i<${#filter_parts[@]}; i++)); do
                combined_filter="$combined_filter and ${filter_parts[i]}"
            done
        fi

        # Apply filter
        local filtered_tasks
        filtered_tasks=$(echo "$all_tasks" | jq "[.[] | select($combined_filter)]")

        # If --subtree is set, include all descendants of matching tasks
        if [[ "$SUBTREE_MODE" == true ]]; then
            log_info "Including descendants (--subtree mode)..."

            # Get all task IDs from filtered results
            local root_ids
            root_ids=$(echo "$filtered_tasks" | jq -r '[.[].id] | join(" ")')

            # For each root, get descendants and merge
            local all_descendants="[]"
            for root_id in $root_ids; do
                local descendants
                descendants=$(echo "$all_tasks" | jq --arg id "$root_id" '
                    . as $tasks |
                    def get_children($parent_id):
                        [$tasks[] | select(.parentId == $parent_id)];
                    def build_subtree($task_id):
                        ($tasks[] | select(.id == $task_id)) as $task |
                        [$task] + ([get_children($task_id)[] | build_subtree(.id)] | flatten);
                    build_subtree($id) | unique_by(.id)
                ')
                all_descendants=$(echo "$all_descendants" | jq --argjson desc "$descendants" '. + $desc | unique_by(.id)')
            done

            echo "$all_descendants"
        else
            echo "$filtered_tasks"
        fi

        return 0
    fi

    # Mode: task ID-based export (single or subtree)
    if [[ -n "$TASK_IDS" ]]; then
        # Parse task IDs (comma or space-separated)
        local ids=$(echo "$TASK_IDS" | tr ',' ' ' | tr -s ' ')
        local selected_tasks="[]"

        for task_id in $ids; do
            # Validate task exists
            local task_exists
            task_exists=$(echo "$all_tasks" | jq --arg id "$task_id" '[.[] | select(.id == $id)] | length')

            if [[ "$task_exists" -eq 0 ]]; then
                log_error "Task not found: $task_id" "$E_NOT_FOUND"
                exit "${EXIT_NOT_FOUND:-4}"
            fi

            if [[ "$SUBTREE_MODE" == true ]]; then
                # Get task + all descendants
                local subtree
                subtree=$(echo "$all_tasks" | jq --arg id "$task_id" '
                    . as $tasks |
                    def get_children($parent_id):
                        [$tasks[] | select(.parentId == $parent_id)];
                    def build_subtree($task_id):
                        ($tasks[] | select(.id == $task_id)) as $task |
                        [$task] + ([get_children($task_id)[] | build_subtree(.id)] | flatten);
                    build_subtree($id) | unique_by(.id)
                ')
                selected_tasks=$(echo "$selected_tasks" | jq --argjson subtree "$subtree" '. + $subtree | unique_by(.id)')
            else
                # Get single task
                local task
                task=$(echo "$all_tasks" | jq --arg id "$task_id" '[.[] | select(.id == $id)]')
                selected_tasks=$(echo "$selected_tasks" | jq --argjson task "$task" '. + $task | unique_by(.id)')
            fi
        done

        echo "$selected_tasks"
        return 0
    fi

    # Mode: full export (export all tasks)
    if [[ "$EXPORT_MODE" == "full" ]]; then
        echo "$all_tasks"
        return 0
    fi

    # No selection criteria
    echo '[]'
}

# -----------------------------------------------------------------------------
# Export package building wrappers
# -----------------------------------------------------------------------------
# These functions wrap the lib/export.sh implementations to match the script's
# calling conventions. The lib functions require specific parameters while the
# script has already determined export mode, filters, etc.

# build_export_package_wrapper - Build export package from task selection
#
# Args:
#   $1 - JSON array of selected tasks
#
# Returns:
#   Complete export package JSON conforming to schema
#
# Calls lib/export.sh build_export_package() with proper parameters
build_export_package_wrapper() {
    local tasks_json="$1"

    # Extract root task IDs from selection
    local root_ids
    root_ids=$(echo "$tasks_json" | jq '[.[].id]')

    # Determine include_children flag
    local include_children="false"
    [[ "$SUBTREE_MODE" == true ]] && include_children="true"

    # Convert filter array to JSON (or null if none)
    local filters="null"
    if [[ ${#FILTERS[@]} -gt 0 ]]; then
        filters=$(printf '%s\n' "${FILTERS[@]}" | jq -R . | jq -s .)
    fi

    # Call lib function with all required parameters
    build_export_package "$EXPORT_MODE" "$root_ids" "$tasks_json" "$TODO_FILE" "$include_children" "$filters"
}

# validate_export_package_wrapper - Validate export package JSON string
#
# Args:
#   $1 - Export package JSON string
#
# Returns:
#   0 if valid, 1 if invalid
#
# Note: lib/export.sh validate_export_package() expects a file path,
# so we write to temp file first
validate_export_package_wrapper() {
    local package="$1"

    # Create temp file for validation
    local temp_file
    temp_file=$(mktemp "${TMPDIR:-/tmp}/export-validate.XXXXXX.json")
    trap 'rm -f "$temp_file"' RETURN

    # Write package to temp file
    echo "$package" > "$temp_file"

    # Validate using lib function (expects file path)
    validate_export_package "$temp_file"
}

# write_export_package - Write package to file or stdout
#
# Args:
#   $1 - Export package JSON
#   $2 - Output file path (empty for stdout)
#
# Returns:
#   0 on success, non-zero on failure
write_export_package() {
    local package="$1"
    local output_path="$2"

    if [[ -z "$output_path" ]]; then
        # Write to stdout with pretty formatting
        echo "$package" | jq '.'
    else
        # Write to file with atomic operation
        local temp_file="${output_path}.tmp.$$"

        # Write to temp file
        if ! echo "$package" | jq '.' > "$temp_file"; then
            rm -f "$temp_file"
            echo "ERROR: Failed to write export package to temp file" >&2
            return 1
        fi

        # Atomic rename
        if ! mv "$temp_file" "$output_path"; then
            rm -f "$temp_file"
            echo "ERROR: Failed to move temp file to final location" >&2
            return 1
        fi

        log_info "Exported to: $output_path"
    fi
}

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case $1 in
        -o|--output)
            OUTPUT_FILE="$2"
            shift 2
            ;;
        --subtree)
            SUBTREE_MODE=true
            shift
            ;;
        --filter)
            FILTERS+=("$2")
            shift 2
            ;;
        --include-deps)
            INCLUDE_DEPS=true
            shift
            ;;
        --interactive)
            INTERACTIVE_MODE=true
            shift
            ;;

        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -f|--format)
            FORMAT="$2"
            shift 2
            ;;
        --json)
            FORMAT="json"
            shift
            ;;
        --human)
            FORMAT="human"
            shift
            ;;
        -q|--quiet)
            QUIET=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        -*)
            log_error "Unknown option: $1" "$E_INPUT_INVALID"
            echo "Use --help for usage information" >&2
            exit "${EXIT_INVALID_INPUT:-2}"
            ;;
        *)
            # Positional argument - task IDs
            if [[ -z "$TASK_IDS" ]]; then
                TASK_IDS="$1"
            else
                # Append additional IDs (space-separated)
                TASK_IDS="$TASK_IDS $1"
            fi
            shift
            ;;
    esac
done

# -----------------------------------------------------------------------------
# Main execution
# -----------------------------------------------------------------------------
main() {
    check_deps

    # Resolve output format (TTY-aware)
    FORMAT=$(resolve_format "$FORMAT")
    COMMAND_NAME="export-tasks"

    # Check if todo.json exists
    if [[ ! -f "$TODO_FILE" ]]; then
        log_error "Todo file not found: $TODO_FILE" "$E_FILE_NOT_FOUND"
        echo "Run 'cleo init' first to initialize the todo system" >&2
        exit "${EXIT_NOT_FOUND:-4}"
    fi

    # INTERACTIVE MODE: Let user select tasks interactively
    if [[ "$INTERACTIVE_MODE" == true ]]; then
        log_info "Launching interactive task selection..."
        
        # Call interactive_select_tasks from lib/export.sh

    # INCLUDE-DEPS MODE: Expand dependencies (T1298)
    if [[ "$INCLUDE_DEPS" == true && "$task_count" -gt 0 ]]; then
        log_info "Expanding dependencies (--include-deps)..."
        
        # Extract task IDs from selection
        local selected_ids
        selected_ids=$(echo "$task_selection" | jq -r '[.[].id] | join(" ")')
        
        # Call expand_dependencies from lib/export.sh
        if declare -f expand_dependencies >/dev/null 2>&1; then
            local expanded_ids
            expanded_ids=$(expand_dependencies "$selected_ids" "$TODO_FILE")
            
            if [[ -n "$expanded_ids" ]]; then
                # Rebuild task_selection with expanded IDs
                local expanded_tasks="[]"
                for tid in $expanded_ids; do
                    local task
                    task=$(echo "$all_tasks" | jq --arg id "$tid" '.[] | select(.id == $id)')
                    if [[ -n "$task" ]]; then
                        expanded_tasks=$(echo "$expanded_tasks" | jq --argjson t "$task" '. + [$t] | unique_by(.id)')
                    fi
                done
                
                task_selection="$expanded_tasks"
                task_count=$(echo "$task_selection" | jq 'length')
                log_info "Expanded to $task_count task(s) (including dependencies)"
            fi
        else
            log_warn "expand_dependencies function not available, skipping dependency expansion"
        fi
    fi
        if declare -f interactive_select_tasks >/dev/null 2>&1; then
            TASK_IDS=$(interactive_select_tasks "$TODO_FILE")
            
            if [[ -z "$TASK_IDS" ]]; then
                log_info "No tasks selected. Exiting."
                exit "${EXIT_SUCCESS:-0}"
            fi
            
            # Override mode to "single" (interactive selections are treated as explicit IDs)
            EXPORT_MODE="single"
            log_info "Selected tasks: $TASK_IDS"
        else
            log_error "interactive_select_tasks function not available" "$E_DEPENDENCY_MISSING"
            exit "${EXIT_DEPENDENCY_ERROR:-5}"
        fi
    fi

    # Infer export mode
    if [[ -n "$TASK_IDS" ]]; then
        if [[ "$SUBTREE_MODE" == true ]]; then
            EXPORT_MODE="subtree"
        else
            EXPORT_MODE="single"
        fi
    elif [[ ${#FILTERS[@]} -gt 0 ]]; then
        EXPORT_MODE="filter"
    else
        # No task IDs and no filters = full export (warn user)
        EXPORT_MODE="full"
        log_warn "No task IDs or filters specified - would export entire project"
    fi

    log_info "Export mode: $EXPORT_MODE"

    # Step 1: Collect task selection
    task_selection=$(collect_task_selection)
    task_count=$(echo "$task_selection" | jq 'length')

    log_info "Selected $task_count task(s) for export"

    # Validate selection is not empty
    if [[ "$task_count" -eq 0 ]]; then
        log_error "No tasks match selection criteria" "$E_VALIDATION_REQUIRED"
        exit "${EXIT_VALIDATION_ERROR:-6}"
    fi

    # DRY-RUN: Show preview and exit
    if [[ "$DRY_RUN" == true ]]; then
        log_info "Dry run - no files will be created"

        # Extract task IDs for display
        local task_ids
        task_ids=$(echo "$task_selection" | jq '[.[].id]')

        if [[ "$FORMAT" == "json" ]]; then
            jq -nc \
                --arg version "${CLEO_VERSION:-$(get_version 2>/dev/null || echo '0.48.0')}" \
                --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                --arg mode "$EXPORT_MODE" \
                --argjson count "$task_count" \
                --argjson ids "$task_ids" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "format": "json",
                        "version": $version,
                        "command": "export-tasks",
                        "timestamp": $timestamp
                    },
                    "success": true,
                    "dryRun": true,
                    "exportMode": $mode,
                    "taskCount": $count,
                    "taskIds": $ids
                }'
        else
            echo -e "${YELLOW}[DRY-RUN]${NC} Would export $task_count task(s)"
            echo "Mode: $EXPORT_MODE"
            echo "Task IDs: $(echo "$task_ids" | jq -r 'join(", ")')"
            [[ -n "$OUTPUT_FILE" ]] && echo "Output: $OUTPUT_FILE"
        fi

        exit "${EXIT_SUCCESS:-0}"
    fi

    # Step 2: Build export package
    export_package=$(build_export_package_wrapper "$task_selection")

    # Step 3: Validate package
    if ! validate_export_package_wrapper "$export_package"; then
        log_error "Export package validation failed" "$E_VALIDATION_SCHEMA"
        exit "${EXIT_VALIDATION_ERROR:-6}"
    fi

    # Step 4: Write package
    if ! write_export_package "$export_package" "$OUTPUT_FILE"; then
        log_error "Failed to write export package" "$E_FILE_WRITE_ERROR"
        exit "${EXIT_FILE_ERROR:-3}"
    fi

    # Success output
    if [[ "$FORMAT" == "json" ]]; then
        jq -nc \
            --arg version "${CLEO_VERSION:-$(get_version 2>/dev/null || echo '0.48.0')}" \
            --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --arg mode "$EXPORT_MODE" \
            --argjson count "$task_count" \
            --arg output "${OUTPUT_FILE:-stdout}" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": "export-tasks",
                    "timestamp": $timestamp
                },
                "success": true,
                "exportMode": $mode,
                "taskCount": $count,
                "outputPath": $output
            }'
    else
        log_info "Export completed successfully"
        echo "Tasks exported: $task_count"
        echo "Mode: $EXPORT_MODE"
        [[ -n "$OUTPUT_FILE" ]] && echo "Output: $OUTPUT_FILE"
    fi

    exit "${EXIT_SUCCESS:-0}"
}

# Run main function
main
