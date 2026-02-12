#!/usr/bin/env bash
###CLEO
# command: import-tasks
# category: sync
# synopsis: Import tasks from export package with ID remapping and conflict resolution
# relevance: medium
# flags: --format,--dry-run,--parent,--on-duplicate,--on-missing-dep,--on-phase-mismatch,--add-label
# exits: 0,2,3,4,6
# json-output: true
###END
# =============================================================================
# import-tasks.sh - Import tasks from portable export package format
# =============================================================================
# Import .cleo-export.json packages into current project with automatic ID
# remapping, conflict detection, and relationship preservation.
#
# Implements Cross-Project Task Import/Export System (v1.0.0)
# See: claudedocs/IMPORT-EXPORT-SPEC.md (Section 3.3, 3.4)
# Schema: schemas/export-package.schema.json
#
# Usage:
#   cleo import-tasks auth.cleo-export.json
#   cleo import-tasks tasks.json --dry-run
#   cleo import-tasks pkg.json --parent T015 --phase core
#   cleo import-tasks pkg.json --on-conflict skip --add-label imported
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Script directory and library paths
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source paths.sh for path resolution functions
if [[ -f "$LIB_DIR/core/paths.sh" ]]; then
    source "$LIB_DIR/core/paths.sh"
fi

# Default file paths
TODO_FILE="${TODO_FILE:-.cleo/todo.json}"
CONFIG_FILE="${CONFIG_FILE:-.cleo/config.json}"
LOG_FILE="${LOG_FILE:-.cleo/todo-log.json}"

# Source required libraries
if [[ -f "$LIB_DIR/core/version.sh" ]]; then
    # shellcheck source=../lib/core/version.sh
    source "$LIB_DIR/core/version.sh"
fi

if [[ -f "$LIB_DIR/core/logging.sh" ]]; then
    # shellcheck source=../lib/core/logging.sh
    source "$LIB_DIR/core/logging.sh"
fi

if [[ -f "$LIB_DIR/validation/validation.sh" ]]; then
    # shellcheck source=../lib/validation/validation.sh
    source "$LIB_DIR/validation/validation.sh"
fi

if [[ -f "$LIB_DIR/data/file-ops.sh" ]]; then
    # shellcheck source=../lib/data/file-ops.sh
    source "$LIB_DIR/data/file-ops.sh"
fi

if [[ -f "$LIB_DIR/core/output-format.sh" ]]; then
    # shellcheck source=../lib/core/output-format.sh
    source "$LIB_DIR/core/output-format.sh"
fi

# Source exit codes first
if [[ -f "$LIB_DIR/core/exit-codes.sh" ]]; then
    # shellcheck source=../lib/core/exit-codes.sh
    source "$LIB_DIR/core/exit-codes.sh"
fi

# Source error JSON library for structured error output
if [[ -f "$LIB_DIR/core/error-json.sh" ]]; then
    # shellcheck source=../lib/core/error-json.sh
    source "$LIB_DIR/core/error-json.sh"
fi

# Source centralized flag parsing
if [[ -f "$LIB_DIR/ui/flags.sh" ]]; then
    # shellcheck source=../lib/ui/flags.sh
    source "$LIB_DIR/ui/flags.sh"
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
EXPORT_FILE=""               # Required: path to .cleo-export.json
DRY_RUN=false               # Preview without writing
PARENT_ID=""                # Attach imported tasks under existing parent
PHASE_OVERRIDE=""           # Override phase for all imported tasks
ADD_LABEL=""                # Add label to all imported tasks
NO_PROVENANCE=false          # Skip provenance note injection
RESET_STATUS=""             # Reset all task statuses (pending|active|blocked)
ON_CONFLICT="fail"          # duplicate|rename|skip|fail
ON_MISSING_DEP="strip"      # strip|placeholder|fail
FORCE=false                 # Skip conflict detection
FORMAT=""                   # json|text (auto-detect TTY)
QUIET=false                 # Suppress messages

# -----------------------------------------------------------------------------
# Help text
# -----------------------------------------------------------------------------
usage() {
    cat << 'EOF'
Usage: cleo import-tasks <export-file> [OPTIONS]

Import tasks from .cleo-export.json package into current project.

Arguments:
  EXPORT_FILE               Path to .cleo-export.json package file (required)

Options:
  --dry-run                 Preview import without writing to todo.json
                            Shows ID remap table, conflicts, and what would be created

  --parent TASK_ID          Attach all imported tasks under existing parent
                            Parent must exist in current project
                            Example: --parent T015

  --phase PHASE_SLUG        Override phase for all imported tasks
                            Phase must exist (or use --add-phase in cleo add)
                            Example: --phase core

  --add-label LABEL         Add label to all imported tasks
  --no-provenance           Skip adding provenance notes to imported tasks
                            By default, adds note tracking source project and original ID
                            Label must match pattern ^[a-z][a-z0-9.-]*$
                            Example: --add-label imported-2026-01

  --reset-status STATUS     Reset all task statuses on import
                            Valid: pending|active|blocked
                            Example: --reset-status pending

  --on-conflict MODE        How to handle duplicate titles (default: fail)
                            duplicate  - Allow duplicate titles
                            rename     - Append numeric suffix to duplicates
                            skip       - Skip tasks with duplicate titles
                            fail       - Abort import on first duplicate

  --on-missing-dep MODE     How to handle missing dependencies (default: strip)
                            strip       - Remove dependency references not in export
                            placeholder - Create stub tasks for missing dependencies
                            fail        - Abort import if dependencies missing

  --force                   Skip conflict detection (use with caution)
                            Bypasses duplicate title and dependency checks

Output Options:
  -f, --format FORMAT       Output format: json|text (default: auto-detect)
  --json                    Force JSON output (for LLM agents)
  --human                   Force human-readable text output
  -q, --quiet               Suppress informational messages
  -h, --help                Show this help

Conflict Resolution:
  Conflict Types:
    - Duplicate Title: Same title exists in target project
    - Missing Dependency: Referenced task not in export or target
    - Missing Parent: parentId not in export or target
    - Phase Mismatch: Phase doesn't exist in target

  Resolution Strategies:
    --on-conflict fail     Abort on any conflict (safest, default)
    --on-conflict rename   Auto-rename duplicates with numeric suffix
    --on-conflict skip     Skip conflicting tasks, import rest
    --on-conflict duplicate Allow duplicates (not recommended)

Examples:
  # Basic import (preview first)
  cleo import-tasks auth-epic.cleo-export.json --dry-run
  cleo import-tasks auth-epic.cleo-export.json

  # Import with parent assignment
  cleo import-tasks feature.cleo-export.json --parent T015

  # Import with phase override and label
  cleo import-tasks tasks.cleo-export.json --phase core --add-label imported-2026-01

  # Import with status reset (all tasks start pending)
  cleo import-tasks tasks.cleo-export.json --reset-status pending

  # Auto-rename duplicates
  cleo import-tasks tasks.cleo-export.json --on-conflict rename

  # Strip missing dependencies
  cleo import-tasks tasks.cleo-export.json --on-missing-dep strip

  # JSON output for scripting
  cleo import-tasks tasks.cleo-export.json --format json

Exit Codes:
  0   = Success (EXIT_SUCCESS)
  2   = Invalid input or arguments (EXIT_INVALID_INPUT)
  3   = File operation failure (EXIT_FILE_ERROR)
  4   = Resource not found (EXIT_NOT_FOUND)
  6   = Validation error (EXIT_VALIDATION_ERROR)
  103 = Conflicts detected (E_CONFLICT_DETECTED)
  104 = Import aborted by user (E_IMPORT_ABORTED)

See Also:
  cleo export-tasks     Export tasks to .cleo-export.json package

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
# Input validation functions
# -----------------------------------------------------------------------------

# Validate export file exists and is readable
validate_export_file() {
    local file="$1"

    # File must exist
    if [[ ! -f "$file" ]]; then
        output_error "$E_FILE_NOT_FOUND" "Export file not found: $file" "${EXIT_NOT_FOUND:-4}" "false" "Verify file path is correct"
        exit "${EXIT_NOT_FOUND:-4}"
    fi

    # File must be readable
    if [[ ! -r "$file" ]]; then
        output_error "$E_FILE_READ_ERROR" "Cannot read export file: $file" "${EXIT_FILE_ERROR:-3}" "false" "Check file permissions"
        exit "${EXIT_FILE_ERROR:-3}"
    fi

    # File must be valid JSON
    if ! jq empty "$file" 2>/dev/null; then
        output_error "$E_VALIDATION_SCHEMA" "Export file is not valid JSON: $file" "${EXIT_VALIDATION_ERROR:-6}" "false" "Verify file was exported correctly"
        exit "${EXIT_VALIDATION_ERROR:-6}"
    fi

    # File must have correct format identifier
    local format
    format=$(jq -r '._meta.format // empty' "$file" 2>/dev/null)
    if [[ "$format" != "cleo-export" ]]; then
        output_error "$E_VALIDATION_SCHEMA" "Invalid export format (expected 'cleo-export', got '$format')" "${EXIT_VALIDATION_ERROR:-6}" "false" "Use a valid .cleo-export.json file"
        exit "${EXIT_VALIDATION_ERROR:-6}"
    fi
}

# Validate parent task exists in target
validate_parent_task() {
    local parent_id="$1"

    if [[ -z "$parent_id" ]]; then
        return 0
    fi

    # Validate ID format
    if ! [[ "$parent_id" =~ ^T[0-9]{3,}$ ]]; then
        output_error "$E_INPUT_INVALID" "Invalid parent ID format: $parent_id (must be T### format)" "${EXIT_INVALID_INPUT:-2}" "false" "Use format T001, T002, etc."
        exit "${EXIT_INVALID_INPUT:-2}"
    fi

    # Check parent exists in target
    if [[ ! -f "$TODO_FILE" ]]; then
        output_error "$E_NOT_INITIALIZED" "Target project not initialized: $TODO_FILE not found" "${EXIT_NOT_FOUND:-4}" "false" "Run 'cleo init' first"
        exit "${EXIT_NOT_FOUND:-4}"
    fi

    local exists
    exists=$(jq --arg id "$parent_id" '[.tasks[] | select(.id == $id)] | length' "$TODO_FILE")
    if [[ "$exists" -eq 0 ]]; then
        output_error "$E_PARENT_NOT_FOUND" "Parent task not found in target: $parent_id" "${EXIT_PARENT_NOT_FOUND:-10}" "false" "Verify parent task ID exists"
        exit "${EXIT_PARENT_NOT_FOUND:-10}"
    fi
}

# Validate phase exists in target
validate_phase_exists() {
    local phase="$1"

    if [[ -z "$phase" ]]; then
        return 0
    fi

    # Validate phase format
    if ! [[ "$phase" =~ ^[a-z][a-z0-9-]*$ ]]; then
        output_error "$E_INPUT_INVALID" "Invalid phase format: $phase (must be lowercase alphanumeric with hyphens)" "${EXIT_INVALID_INPUT:-2}" "false" "Use format: core, testing, polish, etc."
        exit "${EXIT_INVALID_INPUT:-2}"
    fi

    # Check phase exists in target
    if [[ -f "$TODO_FILE" ]]; then
        local phase_exists
        phase_exists=$(jq --arg phase "$phase" '((if (.project | type) == "object" then .project.phases else null end) // {}) | has($phase)' "$TODO_FILE")
        if [[ "$phase_exists" != "true" ]]; then
            local valid_phases
            valid_phases=$(jq -r '((if (.project | type) == "object" then .project.phases else null end) // {}) | keys | join(", ")' "$TODO_FILE")
            output_error "$E_VALIDATION_REQUIRED" "Phase '$phase' not found in target. Valid phases: $valid_phases" "${EXIT_VALIDATION_ERROR:-6}" "false" "Use existing phase or create with 'cleo phase add $phase'"
            exit "${EXIT_VALIDATION_ERROR:-6}"
        fi
    fi
}

# Validate label format
validate_label_format() {
    local label="$1"

    if [[ -z "$label" ]]; then
        return 0
    fi

    if ! [[ "$label" =~ ^[a-z][a-z0-9.-]*$ ]]; then
        output_error "$E_INPUT_INVALID" "Invalid label format: $label (must be lowercase alphanumeric with hyphens/periods)" "${EXIT_INVALID_INPUT:-2}" "false" "Use format: bug, feature, v0.5.0, etc."
        exit "${EXIT_INVALID_INPUT:-2}"
    fi
}

# Validate status enum
validate_status_enum() {
    local status="$1"

    if [[ -z "$status" ]]; then
        return 0
    fi

    case "$status" in
        pending|active|blocked)
            return 0
            ;;
        *)
            output_error "$E_INPUT_INVALID" "Invalid status: $status (must be pending|active|blocked)" "${EXIT_INVALID_INPUT:-2}" "false" "Use: pending, active, or blocked"
            exit "${EXIT_INVALID_INPUT:-2}"
            ;;
    esac
}

# Validate on-conflict mode
validate_on_conflict() {
    local mode="$1"

    case "$mode" in
        duplicate|rename|skip|fail)
            return 0
            ;;
        *)
            output_error "$E_INPUT_INVALID" "Invalid --on-conflict mode: $mode (must be duplicate|rename|skip|fail)" "${EXIT_INVALID_INPUT:-2}" "false" "Use: duplicate, rename, skip, or fail"
            exit "${EXIT_INVALID_INPUT:-2}"
            ;;
    esac
}

# Validate on-missing-dep mode
validate_on_missing_dep() {
    local mode="$1"

    case "$mode" in
        strip|placeholder|fail)
            return 0
            ;;
        *)
            output_error "$E_INPUT_INVALID" "Invalid --on-missing-dep mode: $mode (must be strip|placeholder|fail)" "${EXIT_INVALID_INPUT:-2}" "false" "Use: strip, placeholder, or fail"
            exit "${EXIT_INVALID_INPUT:-2}"
            ;;
    esac
}

# -----------------------------------------------------------------------------
# Import library integration
# -----------------------------------------------------------------------------

# Source import-remap library
if [[ -f "$LIB_DIR/data/import-remap.sh" ]]; then
    # shellcheck source=../lib/data/import-remap.sh
    source "$LIB_DIR/data/import-remap.sh"
fi

# Source import-sort library
if [[ -f "$LIB_DIR/data/import-sort.sh" ]]; then
    # shellcheck source=../lib/data/import-sort.sh
    source "$LIB_DIR/data/import-sort.sh"
fi

# -----------------------------------------------------------------------------
# Integration stubs (to be implemented by other tasks)
# -----------------------------------------------------------------------------

# generate_import_remap_table - Generate ID remap table for import
#
# Args:
#   $1 - Export package file path
#   $2 - Target todo.json path
#
# Returns:
#   JSON object mapping source IDs to new IDs: {"T001": "T031", "T002": "T032"}
#
# Implementation: lib/data/import-remap.sh (T1280)
generate_import_remap_table() {
    local export_file="$1"
    local target_file="$2"

    # Use lib/data/import-remap.sh functions
    if declare -f generate_remap_table >/dev/null 2>&1; then
        # Generate global ID_REMAP and REVERSE_REMAP arrays
        generate_remap_table "$export_file" "$target_file" || return $?

        # Convert bash associative array to JSON
        local json_remap="{}"
        for source_id in "${!ID_REMAP[@]}"; do
            local new_id="${ID_REMAP[$source_id]}"
            json_remap=$(echo "$json_remap" | jq \
                --arg source "$source_id" \
                --arg new "$new_id" \
                '. + {($source): $new}')
        done

        echo "$json_remap"
    else
        log_warn "import-remap.sh not loaded, using stub"
        echo '{}'
    fi
}

# calculate_import_order - Sort tasks by topological order
#
# Args:
#   $1 - Export package JSON
#   $2 - ID remap table JSON (unused, kept for interface compatibility)
#
# Returns:
#   JSON array of task objects in import-safe order (parents before children)
#
# Implementation: lib/data/import-sort.sh (T1282)
calculate_import_order() {
    local export_package="$1"
    # $2 is remap_table, not needed for sort (operates on source IDs)

    # Use lib/data/import-sort.sh functions
    if declare -f topological_sort_tasks >/dev/null 2>&1; then
        # Extract tasks array
        local tasks_json
        tasks_json=$(echo "$export_package" | jq '.tasks')

        # Get topologically sorted task IDs
        local sorted_ids
        sorted_ids=$(topological_sort_tasks "$tasks_json") || return $?

        # Rebuild tasks array in sorted order
        local sorted_tasks="[]"
        for task_id in $sorted_ids; do
            local task
            task=$(echo "$tasks_json" | jq --arg id "$task_id" '.[] | select(.id == $id)')
            sorted_tasks=$(echo "$sorted_tasks" | jq --argjson task "$task" '. + [$task]')
        done

        echo "$sorted_tasks"
    else
        log_warn "import-sort.sh not loaded, using tasks as-is"
        echo "$export_package" | jq '.tasks'
    fi
}

# detect_conflicts - Detect import conflicts
#
# Args:
#   $1 - Export package JSON
#   $2 - Target todo.json path
#   $3 - Import options JSON
#
# Returns:
#   JSON array of conflict objects: [{"type": "duplicate_title", "taskId": "T001", ...}]
#
# Implementation: T1281 (conflict detection)
detect_conflicts() {
    local export_package="$1"
    local target_file="$2"
    local import_options="$3"

    log_info "STUB: Detecting conflicts (T1281)..."

    # TODO: Implement conflict detection
    # - Check duplicate titles
    # - Check missing dependencies
    # - Check missing parents
    # - Check phase mismatches

    echo '[]'  # Placeholder: no conflicts
}

# apply_import_transformations - Apply import transformations to tasks
#
# Args:
#   $1 - Tasks array JSON
#   $2 - ID remap table JSON
#   $3 - Import options JSON
#   $4 - Export package JSON (for provenance)
#
# Returns:
#   Transformed tasks array JSON
#
# Implementation: T1283 (this script), T1297 (provenance)
apply_import_transformations() {
    local tasks="$1"
    local remap_table="$2"
    local import_options="$3"
    local export_package="${4:-"{}"}"

    log_info "Applying import transformations..."

    # Extract provenance info from export package
    local source_project import_date
    source_project=$(echo "$export_package" | jq -r '._meta.source.project // "unknown"')
    import_date=$(date -u +%Y-%m-%d)
    
    # Check if provenance should be added
    local add_provenance
    add_provenance=$(echo "$import_options" | jq -r '.addProvenance // true')

    # Apply ID remapping
    local transformed
    transformed=$(echo "$tasks" | jq --argjson remap "$remap_table" '
        map(
            .id = $remap[.id] |
            if .parentId then .parentId = $remap[.parentId] else . end |
            if .depends then .depends = [.depends[] | $remap[.]] else . end
        )
    ')

    # Apply provenance notes (T1297)
    if [[ "$add_provenance" == "true" ]]; then
        transformed=$(echo "$transformed" | jq \
            --arg proj "$source_project" \
            --arg date "$import_date" \
            --argjson remap "$remap_table" \
            '
            # Build reverse remap (newId -> originalId)
            ($remap | to_entries | map({key: .value, value: .key}) | from_entries) as $reverse |
            
            map(
                . as $task |
                ($reverse[$task.id] // $task.id) as $original_id |
                .notes = (
                    (.notes // []) + 
                    ["[Imported from \($proj) as \($original_id) on \($date)]"]
                )
            )
        ')
        log_info "Added provenance notes to imported tasks"
    fi

    # Apply parent override if specified
    local parent_override
    parent_override=$(echo "$import_options" | jq -r '.parentId // empty')
    if [[ -n "$parent_override" ]]; then
        transformed=$(echo "$transformed" | jq --arg pid "$parent_override" '
            map(.parentId = $pid)
        ')
    fi

    # Apply phase override if specified
    local phase_override
    phase_override=$(echo "$import_options" | jq -r '.phaseOverride // empty')
    if [[ -n "$phase_override" ]]; then
        transformed=$(echo "$transformed" | jq --arg phase "$phase_override" '
            map(.phase = $phase)
        ')
    fi

    # Apply label addition if specified
    local add_label
    add_label=$(echo "$import_options" | jq -r '.addLabel // empty')
    if [[ -n "$add_label" ]]; then
        transformed=$(echo "$transformed" | jq --arg label "$add_label" '
            map(.labels = ((.labels // []) + [$label] | unique))
        ')
    fi

    # Apply status reset if specified
    local reset_status
    reset_status=$(echo "$import_options" | jq -r '.resetStatus // empty')
    if [[ -n "$reset_status" ]]; then
        transformed=$(echo "$transformed" | jq --arg status "$reset_status" '
            map(.status = $status)
        ')
    fi

    echo "$transformed"
}

# -----------------------------------------------------------------------------
# Dry-Run Preview Display
# -----------------------------------------------------------------------------

# dry_run_preview - Display import preview for dry-run mode
#
# Shows what would be imported without writing to disk. Displays:
# - ID remap table (source → new mappings)
# - Import order (topologically sorted)
# - Task summaries with parent/dependency info
# - Conflict warnings
#
# Outputs both human-readable text (TTY) and JSON (piped/scripted)
#
# Args:
#   $1 - remap_table: JSON object of ID mappings
#   $2 - transformed_tasks: JSON array of tasks after transformations
#   $3 - conflicts: JSON array of conflict objects
#   $4 - task_count: Number of tasks to import
# Returns:
#   0 always (preview only, no writes)
# Exit:
#   Exits with EXIT_SUCCESS after displaying preview
dry_run_preview() {
    local remap_table="$1"
    local transformed_tasks="$2"
    local conflicts="$3"
    local task_count="$4"

    local conflict_count
    conflict_count=$(echo "$conflicts" | jq 'length')

    # ========================================================================
    # JSON Output (for scripting and LLM agents)
    # ========================================================================
    if [[ "$FORMAT" == "json" ]]; then
        jq -nc \
            --arg version "${CLEO_VERSION:-$(get_version 2>/dev/null || echo '0.48.0')}" \
            --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --argjson remap "$remap_table" \
            --argjson tasks "$transformed_tasks" \
            --argjson conflicts "$conflicts" \
            --argjson count "$task_count" \
            --argjson conflict_count "$conflict_count" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": "import-tasks",
                    "timestamp": $timestamp
                },
                "success": true,
                "dryRun": true,
                "summary": {
                    "tasksToImport": $count,
                    "conflicts": $conflict_count,
                    "wouldWrite": false
                },
                "preview": {
                    "idRemap": $remap,
                    "tasks": $tasks,
                    "conflicts": $conflicts
                }
            }'
        exit "${EXIT_SUCCESS:-0}"
    fi

    # ========================================================================
    # Human-Readable Text Output (for TTY)
    # ========================================================================

    echo ""
    echo -e "${YELLOW}========================================${NC}"
    echo -e "${YELLOW}DRY RUN - No changes will be made${NC}"
    echo -e "${YELLOW}========================================${NC}"
    echo ""

    # Verify package checksum integrity (T1296)
    log_info "Verifying export package checksum..."
    if ! verify_export_checksum "$EXPORT_FILE" 2>/dev/null; then
        # Extract checksums for detailed error
        local stored_checksum calculated_checksum
        stored_checksum=$(jq -r '._meta.checksum // "unknown"' "$EXPORT_FILE")
        calculated_checksum=$(jq -c '.tasks' "$EXPORT_FILE" | calculate_export_checksum 2>/dev/null || echo "calculation-failed")
        
        output_error "$E_CHECKSUM_MISMATCH" \
            "Export package checksum verification failed. Package may be corrupted or tampered with." \
            "${EXIT_VALIDATION_ERROR:-6}" \
            "false" \
            "Use a valid, unmodified export package" \
            "$(jq -nc \
                --arg file "$EXPORT_FILE" \
                --arg stored "$stored_checksum" \
                --arg calculated "$calculated_checksum" \
                '{
                    file: $file,
                    storedChecksum: $stored,
                    calculatedChecksum: $calculated,
                    status: "CORRUPTED"
                }')"
        exit "${EXIT_VALIDATION_ERROR:-6}"
    fi
    log_info "Checksum verified successfully"

    # -----------------------------------------------------------------------
    # ID Remap Table
    # -----------------------------------------------------------------------
    echo -e "${BLUE}ID REMAP TABLE:${NC}"

    # Sort by source ID for readability
    local remap_display
    remap_display=$(echo "$remap_table" | jq -r 'to_entries | sort_by(.key) | .[] |
        "  \(.key) → \(.value)"')

    if [[ -n "$remap_display" ]]; then
        echo "$remap_display"
    else
        echo "  (no ID remapping needed)"
    fi

    echo ""

    # -----------------------------------------------------------------------
    # Conflict Warnings
    # -----------------------------------------------------------------------
    if [[ "$conflict_count" -gt 0 ]]; then
        echo -e "${YELLOW}⚠ CONFLICTS DETECTED: $conflict_count${NC}"
        echo ""

        # Group conflicts by type
        local duplicate_titles
        duplicate_titles=$(echo "$conflicts" | jq -r '.[] | select(.type == "duplicate_title") |
            "  • Duplicate title: \"\(.title)\" (exists as \(.existingId))"' 2>/dev/null || true)

        if [[ -n "$duplicate_titles" ]]; then
            echo -e "${YELLOW}Duplicate Titles:${NC}"
            echo "$duplicate_titles"
            echo ""
        fi

        local missing_deps
        missing_deps=$(echo "$conflicts" | jq -r '.[] | select(.type == "missing_dependency") |
            "  • Missing dependency: \(.taskId) depends on \(.missingDep)"' 2>/dev/null || true)

        if [[ -n "$missing_deps" ]]; then
            echo -e "${YELLOW}Missing Dependencies:${NC}"
            echo "$missing_deps"
            echo ""
        fi
    fi

    # -----------------------------------------------------------------------
    # Import Order Preview
    # -----------------------------------------------------------------------
    echo -e "${BLUE}IMPORT ORDER:${NC}"
    echo ""

    local i=1
    while IFS= read -r task; do
        local id title type parent_id depends

        id=$(echo "$task" | jq -r '.id')
        title=$(echo "$task" | jq -r '.title')
        type=$(echo "$task" | jq -r '.type // "task"')
        parent_id=$(echo "$task" | jq -r '.parentId // empty')
        depends=$(echo "$task" | jq -r '.depends // [] | join(", ")')

        # Format task line
        local task_line
        task_line=$(printf "  %2d. %s (%s: %s)" "$i" "$id" "$type" "$title")

        # Add parent info if present
        if [[ -n "$parent_id" && "$parent_id" != "null" ]]; then
            task_line+=" [parent: $parent_id]"
        fi

        # Add dependency info if present
        if [[ -n "$depends" ]]; then
            task_line+=" [depends: $depends]"
        fi

        echo "$task_line"
        ((i++))
    done < <(echo "$transformed_tasks" | jq -c '.[]')

    echo ""

    # -----------------------------------------------------------------------
    # Summary
    # -----------------------------------------------------------------------
    echo -e "${BLUE}SUMMARY:${NC}"
    echo "  Tasks to import: $task_count"
    echo "  Conflicts: $conflict_count"
    echo ""

    echo -e "${GREEN}✓ Preview complete${NC}"
    echo -e "${YELLOW}Run without --dry-run to perform actual import${NC}"
    echo ""

    exit "${EXIT_SUCCESS:-0}"
}

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --parent)
            PARENT_ID="$2"
            shift 2
            ;;
        --phase)
            PHASE_OVERRIDE="$2"
            shift 2
            ;;
        --add-label)
            ADD_LABEL="$2"
            shift 2
            ;;
        --reset-status)
            RESET_STATUS="$2"
            shift 2
            ;;
        --on-conflict)
            ON_CONFLICT="$2"
            shift 2
            ;;
        --on-missing-dep)
            ON_MISSING_DEP="$2"
            shift 2
            ;;
        --force)
            FORCE=true
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
            # Positional argument - export file
            if [[ -z "$EXPORT_FILE" ]]; then
                EXPORT_FILE="$1"
            else
                log_error "Multiple export files specified. Only one file allowed."
                exit "${EXIT_INVALID_INPUT:-2}"
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
    COMMAND_NAME="import-tasks"

    # Validate required arguments
    if [[ -z "$EXPORT_FILE" ]]; then
        log_error "Export file is required" "$E_INPUT_MISSING"
        echo "Usage: cleo import-tasks <export-file> [OPTIONS]" >&2
        echo "Use --help for more information" >&2
        exit "${EXIT_INVALID_INPUT:-2}"
    fi

    # Validate export file
    validate_export_file "$EXPORT_FILE"

    # Validate optional parameters
    validate_parent_task "$PARENT_ID"
    validate_phase_exists "$PHASE_OVERRIDE"
    validate_label_format "$ADD_LABEL"
    validate_status_enum "$RESET_STATUS"
    validate_on_conflict "$ON_CONFLICT"
    validate_on_missing_dep "$ON_MISSING_DEP"

    # Check if todo.json exists
    if [[ ! -f "$TODO_FILE" ]]; then
        log_error "Todo file not found: $TODO_FILE" "$E_FILE_NOT_FOUND"
        echo "Run 'cleo init' first to initialize the todo system" >&2
        exit "${EXIT_NOT_FOUND:-4}"
    fi

    # Load export package
    local export_package
    export_package=$(cat "$EXPORT_FILE")

    # Validate package schema (basic checks)
    local task_count
    task_count=$(echo "$export_package" | jq '.tasks | length')
    log_info "Export package contains $task_count task(s)"

    if [[ "$task_count" -eq 0 ]]; then
        log_error "Export package contains no tasks" "$E_VALIDATION_REQUIRED"
        exit "${EXIT_VALIDATION_ERROR:-6}"
    fi

    # Step 1: Generate ID remap table
    local remap_table
    remap_table=$(generate_import_remap_table "$EXPORT_FILE" "$TODO_FILE")

    # Step 2: Build import options JSON
    local import_options
    import_options=$(jq -nc \
        --arg parent "$PARENT_ID" \
        --arg phase "$PHASE_OVERRIDE" \
        --arg label "$ADD_LABEL" \
        --arg status "$RESET_STATUS" \
        --arg conflict "$ON_CONFLICT" \
        --arg missing_dep "$ON_MISSING_DEP" \
        --argjson force "$FORCE" \
        --arg no_prov "$NO_PROVENANCE" \
        '{
            parentId: (if $parent != "" then $parent else null end),
            phaseOverride: (if $phase != "" then $phase else null end),
            addLabel: (if $label != "" then $label else null end),
            resetStatus: (if $status != "" then $status else null end),
            onConflict: $conflict,
            onMissingDep: $missing_dep,
            force: $force
        }')

    # Step 3: Detect conflicts (unless --force)
    local conflicts='[]'
    if [[ "$FORCE" != true ]]; then
        conflicts=$(detect_conflicts "$export_package" "$TODO_FILE" "$import_options")
        local conflict_count
        conflict_count=$(echo "$conflicts" | jq 'length')

        if [[ "$conflict_count" -gt 0 && "$ON_CONFLICT" == "fail" ]]; then
            log_error "Conflicts detected (use --on-conflict to resolve)" "$E_VALIDATION_REQUIRED"

            if [[ "$FORMAT" == "json" ]]; then
                jq -nc \
                    --arg version "${CLEO_VERSION:-$(get_version 2>/dev/null || echo '0.48.0')}" \
                    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                    --argjson conflicts "$conflicts" \
                    '{
                        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                        "_meta": {
                            "format": "json",
                            "version": $version,
                            "command": "import-tasks",
                            "timestamp": $timestamp
                        },
                        "success": false,
                        "error": "Conflicts detected",
                        "conflicts": $conflicts
                    }'
            else
                echo "Conflicts detected:" >&2
                echo "$conflicts" | jq -r '.[] | "  - \(.type): \(.taskId // .title)"' >&2
            fi
            exit "${EXIT_VALIDATION_ERROR:-6}"
        fi
    fi

    # Step 4: Calculate import order (topological sort)
    local sorted_tasks
    sorted_tasks=$(calculate_import_order "$export_package" "$remap_table")

    # Step 5: Apply transformations (ID remap, parent, phase, etc.)
    local transformed_tasks
    transformed_tasks=$(apply_import_transformations "$sorted_tasks" "$remap_table" "$import_options" "$export_package")

    # DRY-RUN: Show preview and exit
    if [[ "$DRY_RUN" == true ]]; then
        log_info "Dry run - no files will be modified"
        dry_run_preview "$remap_table" "$transformed_tasks" "$conflicts" "$task_count"
        # dry_run_preview exits, never returns
    fi

    # Step 6: Write to todo.json (atomic operation with validation)
    log_info "Writing $task_count task(s) to $TODO_FILE..."

    # Read current todo.json
    local todo_data
    if ! todo_data=$(cat "$TODO_FILE" 2>/dev/null); then
        log_error "Failed to read target file: $TODO_FILE" "$E_IO"
        exit "${EXIT_IO_ERROR:-3}"
    fi

    # Append imported tasks to existing tasks array
    local updated_data
    updated_data=$(echo "$todo_data" | jq \
        --argjson new_tasks "$transformed_tasks" \
        '.tasks += $new_tasks')

    # Validate the updated data
    if ! echo "$updated_data" | jq empty 2>/dev/null; then
        log_error "Updated todo.json has invalid JSON" "$E_VALIDATION_REQUIRED"
        exit "${EXIT_VALIDATION_ERROR:-6}"
    fi

    # Write atomically using file-ops.sh (content via stdin, no second arg)
    if ! echo "$updated_data" | atomic_write "$TODO_FILE"; then
        log_error "Failed to write imported tasks to $TODO_FILE"
        exit "${EXIT_FILE_ERROR:-3}"
    fi

    log_info "Successfully imported $task_count task(s)"

    # Success output
    if [[ "$FORMAT" == "json" ]]; then
        jq -nc \
            --arg version "${CLEO_VERSION:-$(get_version 2>/dev/null || echo '0.48.0')}" \
            --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --argjson remap "$remap_table" \
            --argjson count "$task_count" \
            --argjson conflicts "$conflicts" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "format": "json",
                    "version": $version,
                    "command": "import-tasks",
                    "timestamp": $timestamp
                },
                "success": true,
                "dryRun": false,
                "summary": {
                    "imported": $count,
                    "skipped": 0,
                    "conflicts": ($conflicts | length),
                    "errors": 0
                },
                "idRemap": $remap,
                "tasks": [],
                "conflicts": $conflicts,
                "provenance": {
                    "sourceProject": "unknown",
                    "importedAt": $timestamp
                }
            }'
    else
        log_info "Import completed successfully"
        echo ""
        echo "Tasks imported: $task_count"
        echo "ID remapping:"
        echo "$remap_table" | jq -r 'to_entries[] | "  \(.key) → \(.value)"'
        echo ""
    fi

    exit "${EXIT_SUCCESS:-0}"
}

# Run main function
main
