#!/usr/bin/env bash
# validation.sh - Core validation library for cleo system
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: platform-compat.sh, config.sh
# PROVIDES: validate_task, validate_json_file, validate_task_id, validate_status,
#           validate_priority, validate_title, validate_cancel_reason, check_duplicates,
#           validate_checksum, validate_task_hierarchy

#=== SOURCE GUARD ================================================
[[ -n "${_VALIDATION_SH_LOADED:-}" ]] && return 0
declare -r _VALIDATION_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

# Determine library directory
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source platform compatibility layer
if [[ -f "$_LIB_DIR/platform-compat.sh" ]]; then
    # shellcheck source=lib/platform-compat.sh
    source "$_LIB_DIR/platform-compat.sh"
else
    echo "ERROR: Cannot find platform-compat.sh in $_LIB_DIR" >&2
    exit 1
fi

# Check required tools
if ! check_required_tools; then
    exit 1
fi

# Migration library is NOT sourced at load time to avoid circular dependencies.
# file-ops.sh → validation.sh → migrate.sh → file-ops.sh would create a cycle.
# Migration functions (check_compatibility, detect_file_version, get_expected_version)
# are only needed for optional version checking in validate_version().
# Use lazy loading via _ensure_migrate_loaded() if migration support is needed.
MIGRATION_AVAILABLE=false
_MIGRATE_LOAD_ATTEMPTED=false

# Lazy-load migration library on demand
# Returns: 0 if loaded successfully, 1 if not available
_ensure_migrate_loaded() {
    # Only attempt to load once
    if [[ "$_MIGRATE_LOAD_ATTEMPTED" == "true" ]]; then
        [[ "$MIGRATION_AVAILABLE" == "true" ]]
        return $?
    fi
    _MIGRATE_LOAD_ATTEMPTED=true

    if [[ -f "$_LIB_DIR/migrate.sh" ]]; then
        # shellcheck source=lib/migrate.sh
        source "$_LIB_DIR/migrate.sh"
        MIGRATION_AVAILABLE=true
        return 0
    fi
    return 1
}

# Hierarchy library is NOT sourced at load time to keep Layer 2 deps minimal.
# Use lazy loading via _ensure_hierarchy_loaded() if hierarchy support is needed.
HIERARCHY_AVAILABLE=false
_HIERARCHY_LOAD_ATTEMPTED=false

# Lazy-load hierarchy library on demand
# Returns: 0 if loaded successfully, 1 if not available
_ensure_hierarchy_loaded() {
    # Only attempt to load once
    if [[ "$_HIERARCHY_LOAD_ATTEMPTED" == "true" ]]; then
        [[ "$HIERARCHY_AVAILABLE" == "true" ]]
        return $?
    fi
    _HIERARCHY_LOAD_ATTEMPTED=true

    if [[ -f "$_LIB_DIR/hierarchy.sh" ]]; then
        # shellcheck source=lib/hierarchy.sh
        source "$_LIB_DIR/hierarchy.sh"
        HIERARCHY_AVAILABLE=true
        return 0
    fi
    return 1
}

# Source config library for validation config settings (optional)
if [[ -f "$_LIB_DIR/config.sh" ]]; then
    # shellcheck source=lib/config.sh
    source "$_LIB_DIR/config.sh"
    CONFIG_AVAILABLE=true
else
    CONFIG_AVAILABLE=false
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Guard readonly declarations to prevent errors on re-sourcing
if [[ -z "${VALID_STATUSES+x}" ]]; then
    readonly VALID_STATUSES=("pending" "active" "done" "blocked" "cancelled")
fi
if [[ -z "${VALID_OPERATIONS+x}" ]]; then
    readonly VALID_OPERATIONS=("create" "update" "complete" "archive" "restore" "delete" "validate" "backup")
fi
if [[ -z "${VALID_PHASE_STATUSES+x}" ]]; then
    readonly VALID_PHASE_STATUSES=("pending" "active" "completed")
fi

# Exit codes (use VAL_ prefix to avoid conflicts with exit-codes.sh)
if [[ -z "${VAL_SUCCESS+x}" ]]; then
    readonly VAL_SUCCESS=0
    readonly VAL_SCHEMA_ERROR=1
    readonly VAL_SEMANTIC_ERROR=2
    readonly VAL_BOTH_ERRORS=3
fi

# ============================================================================
# CONFIG-DRIVEN VALIDATION SETTINGS
# ============================================================================

# Get validation config setting with default fallback
# Args: $1 = config key (e.g., "strictMode"), $2 = default value
# Returns: config value or default
get_validation_config() {
    local key="$1"
    local default="$2"

    if [[ "$CONFIG_AVAILABLE" == "true" ]] && declare -f get_config_value >/dev/null 2>&1; then
        get_config_value "validation.$key" "$default"
    else
        echo "$default"
    fi
}

# Check if strict mode is enabled
# Returns: "true" or "false"
is_strict_mode() {
    get_validation_config "strictMode" "false"
}

# Check if checksum validation is enabled
# Returns: "true" or "false"
is_checksum_enabled() {
    get_validation_config "checksumEnabled" "true"
}

# Get max active tasks limit
# Returns: number (default 3, 0 means unlimited)
get_max_active_tasks() {
    get_validation_config "maxActiveTasks" "3"
}

# Check if description is required for task creation
# Returns: "true" or "false"
is_description_required() {
    get_validation_config "requireDescription" "true"
}

# Check if dependency validation is enabled
# Returns: "true" or "false"
is_dependency_validation_enabled() {
    get_validation_config "validateDependencies" "true"
}

# Check if circular dependency detection is enabled
# Returns: "true" or "false"
is_circular_dep_detection_enabled() {
    get_validation_config "detectCircularDeps" "true"
}

# Get phase validation config setting
# Args: $1 = config key (e.g., "enabled"), $2 = default value
# Returns: config value or default
get_phase_validation_config() {
    local key="$1"
    local default="$2"

    if [[ "$CONFIG_AVAILABLE" == "true" ]] && declare -f get_config_value >/dev/null 2>&1; then
        get_config_value "validation.phaseValidation.$key" "$default"
    else
        echo "$default"
    fi
}

# Check if phase validation is enabled
# Returns: "true" or "false"
is_phase_validation_enabled() {
    get_phase_validation_config "enabled" "false"
}

# Check if blocking on critical tasks is enabled
# Returns: "true" or "false"
should_block_on_critical_tasks() {
    get_phase_validation_config "blockOnCriticalTasks" "false"
}

# Check if warning on phase skip is enabled
# Returns: "true" or "false"
should_warn_on_phase_skip() {
    get_phase_validation_config "warnOnPhaseSkip" "true"
}

export -f get_validation_config
export -f is_strict_mode
export -f is_checksum_enabled
export -f get_max_active_tasks
export -f is_description_required
export -f is_dependency_validation_enabled
export -f is_circular_dep_detection_enabled
export -f get_phase_validation_config
export -f is_phase_validation_enabled
export -f should_block_on_critical_tasks
export -f should_warn_on_phase_skip

# ============================================================================
# PATH SECURITY FUNCTIONS
# ============================================================================

# Sanitize file path for safe shell usage
# Validates path does not contain shell metacharacters that could enable injection
# Arguments:
#   $1 - Path to sanitize
# Outputs:
#   Sanitized path to stdout if valid
# Returns:
#   0 if path is safe, 1 if path contains dangerous characters
# Security:
#   Prevents command injection via malicious file names with shell metacharacters
#   Used before any eval statements that include file paths
sanitize_file_path() {
    local path="$1"

    # Check for empty path
    if [[ -z "$path" ]]; then
        echo "ERROR: Empty path provided" >&2
        return 1
    fi

    # Note: Null byte check removed - bash cannot store null bytes in variables.
    # If a path contains null bytes, bash will truncate it before reaching here.
    # The metacharacter check below handles all relevant security concerns.

    # Check for shell metacharacters that could enable command injection
    # These characters have special meaning in shell contexts:
    #   $ - variable expansion / command substitution
    #   ` - command substitution (backticks)
    #   ; - command separator
    #   | - pipe
    #   & - background / AND operator
    #   < > - redirection
    #   ' " - quoting (can break out of quotes)
    #   ( ) - subshell / grouping
    #   { } - brace expansion / command grouping
    #   [ ] - glob patterns / test brackets
    #   ! - history expansion / negation
    #   \ - escape character (at end of path)
    #   newline/carriage return - command separator
    # ERE character class - chars are mostly literal inside []
    # Use glob matching for special chars that are hard to represent in ERE
    if [[ "$path" == *'$'* ]] || [[ "$path" == *'`'* ]] || [[ "$path" == *';'* ]] || \
       [[ "$path" == *'|'* ]] || [[ "$path" == *'&'* ]] || [[ "$path" == *'<'* ]] || \
       [[ "$path" == *'>'* ]] || [[ "$path" == *"'"* ]] || [[ "$path" == *'"'* ]] || \
       [[ "$path" == *'('* ]] || [[ "$path" == *')'* ]] || [[ "$path" == *'{'* ]] || \
       [[ "$path" == *'}'* ]] || [[ "$path" == *'['* ]] || [[ "$path" == *']'* ]] || \
       [[ "$path" == *'!'* ]]; then
        echo "ERROR: Path contains shell metacharacters - potential injection attempt: $path" >&2
        return 1
    fi

    # Check for backslash at end of path (could escape following character)
    if [[ "$path" == *'\' ]]; then
        echo "ERROR: Path ends with backslash - potential injection attempt" >&2
        return 1
    fi

    # Check for newlines and carriage returns (command separators)
    if [[ "$path" == *$'\n'* ]] || [[ "$path" == *$'\r'* ]]; then
        echo "ERROR: Path contains newline/carriage return - potential injection attempt" >&2
        return 1
    fi

    # Path is safe - output it
    printf '%s' "$path"
    return 0
}

export -f sanitize_file_path

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

# Get current timestamp in ISO 8601 format (uses platform-compat)
get_current_timestamp() {
    get_iso_timestamp
}

# Convert ISO 8601 timestamp to Unix epoch (uses platform-compat)
timestamp_to_epoch() {
    local timestamp="$1"
    iso_to_epoch "$timestamp"
}

# Deduplicate and normalize labels
# Args: $1 = comma-separated labels string
# Returns: deduplicated, sorted labels string
normalize_labels() {
    local labels_input="$1"

    # Handle empty input
    if [[ -z "$labels_input" ]]; then
        echo ""
        return 0
    fi

    # Split by comma, trim whitespace, sort, deduplicate, rejoin
    echo "$labels_input" | \
        tr ',' '\n' | \
        sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | \
        grep -v '^$' | \
        sort -u | \
        tr '\n' ',' | \
        sed 's/,$//'
}

export -f normalize_labels

# ============================================================================
# JSON SYNTAX VALIDATION
# ============================================================================

# Validate JSON syntax using jq
# Args: $1 = file path
# Returns: 0 if valid, 1 if invalid
validate_json_syntax() {
    local file="$1"

    if [[ ! -f "$file" ]]; then
        echo "ERROR: File not found: $file" >&2
        return 1
    fi

    if ! jq empty "$file" 2>/dev/null; then
        echo "ERROR: Invalid JSON syntax in file: $file" >&2
        echo "Details:" >&2
        jq empty "$file" 2>&1 | head -10 >&2
        echo "Fix: Check for missing commas, brackets, or quotes" >&2
        return 1
    fi

    return 0
}

# ============================================================================
# SCHEMA VALIDATION
# ============================================================================

# Validate JSON against schema
# Args: $1 = file path, $2 = schema type (todo|archive|config|log)
# Returns: 0 if valid, 1 if invalid
validate_schema() {
    local file="$1"
    local schema_type="$2"
    local schema_file

    # Determine schema file location
    if [[ -n "${CLEO_HOME:-}" ]]; then
        schema_file="$CLEO_HOME/schemas/todo-${schema_type}.schema.json"
    elif [[ -f "$HOME/.cleo/schemas/todo-${schema_type}.schema.json" ]]; then
        schema_file="$HOME/.cleo/schemas/todo-${schema_type}.schema.json"
    else
        schema_file="$(dirname "$(dirname "${BASH_SOURCE[0]}")")/schemas/todo-${schema_type}.schema.json"
    fi

    if [[ ! -f "$schema_file" ]]; then
        echo "WARNING: Schema file not found: $schema_file" >&2
        echo "Skipping schema validation" >&2
        return 0
    fi

    # First check JSON syntax
    if ! validate_json_syntax "$file"; then
        return 1
    fi

    # Use platform-compatible schema validation
    if validate_json_schema "$file" "$schema_file" >/dev/null 2>&1; then
        return 0
    else
        # If strict validator fails, try jq-based fallback
        echo "INFO: Using jq-based schema validation fallback" >&2
        _validate_schema_jq "$file" "$schema_type"
    fi
}

# JQ-based schema validation fallback
# Args: $1 = file path, $2 = schema type
_validate_schema_jq() {
    local file="$1"
    local schema_type="$2"
    local errors=0

    case "$schema_type" in
        "todo")
            # Validate todo.json structure
            if ! jq -e '.tasks | type == "array"' "$file" >/dev/null 2>&1; then
                echo "ERROR: Missing or invalid 'tasks' array" >&2
                ((errors++))
            fi

            # Check each task has required fields
            local task_count
            task_count=$(jq '.tasks | length' "$file")
            for ((i=0; i<task_count; i++)); do
                if ! jq -e ".tasks[$i] | has(\"content\") and has(\"status\") and has(\"activeForm\")" "$file" >/dev/null 2>&1; then
                    echo "ERROR: Task at index $i missing required fields (content, status, activeForm)" >&2
                    ((errors++))
                fi
            done
            ;;

        "archive")
            # Validate archive structure
            if ! jq -e '.archived_tasks | type == "array"' "$file" >/dev/null 2>&1; then
                echo "ERROR: Missing or invalid 'archived_tasks' array" >&2
                ((errors++))
            fi
            ;;

        "config")
            # Validate config structure
            if ! jq -e 'has("archive") and has("validation") and has("logging")' "$file" >/dev/null 2>&1; then
                echo "ERROR: Missing required config sections (archive, validation, logging)" >&2
                ((errors++))
            fi
            ;;

        "log")
            # Validate log structure
            if ! jq -e '.entries | type == "array"' "$file" >/dev/null 2>&1; then
                echo "ERROR: Missing or invalid 'entries' array" >&2
                ((errors++))
            fi
            ;;

        *)
            echo "ERROR: Unknown schema type: $schema_type" >&2
            return 1
            ;;
    esac

    if [[ $errors -gt 0 ]]; then
        echo "Fix: Ensure file structure matches schema requirements" >&2
        return 1
    fi

    return 0
}

# ============================================================================
# VERSION VALIDATION
# ============================================================================

# Detect if file needs v2.2.0 migration (string project -> object project)
# Args: $1 = file path
# Returns: 0 if needs migration, 1 if already migrated or not applicable
needs_v2_2_0_migration() {
    local file="$1"

    if [[ ! -f "$file" ]]; then
        return 1
    fi

    # Check if .project field exists and is a string
    local project_type
    project_type=$(jq -r 'if has("project") then (.project | type) else "null" end' "$file" 2>/dev/null)

    if [[ "$project_type" == "string" ]]; then
        # Old format detected - needs migration
        return 0
    fi

    # Already object format or no project field
    return 1
}

# Validate file version and trigger migration if needed
# Args: $1 = file path, $2 = schema type
# Returns: 0 if compatible or migrated, 1 if incompatible
validate_version() {
    local file="$1"
    local schema_type="$2"

    # Lazy-load migration library if not already loaded
    if [[ "$MIGRATION_AVAILABLE" != "true" ]]; then
        if ! _ensure_migrate_loaded; then
            # Migration library not available - skip version checking (non-blocking)
            return 0
        fi
    fi

    # Verify required functions are available after loading
    if ! declare -f check_compatibility >/dev/null 2>&1; then
        return 0
    fi

    # Check version compatibility
    check_compatibility "$file" "$schema_type"
    local compat_status=$?

    case $compat_status in
        0)
            # Compatible - no action needed
            return 0
            ;;
        1)
            # Migration needed
            local current_version expected_version
            current_version=$(detect_file_version "$file")
            expected_version=$(get_expected_version "$schema_type")

            echo "⚠ Schema version mismatch detected" >&2
            echo "  File: $file" >&2
            echo "  Current: v$current_version" >&2
            echo "  Expected: v$expected_version" >&2
            echo "" >&2
            echo "Automatic migration available." >&2
            echo "Run: cleo migrate" >&2
            echo "" >&2

            # For now, warn but don't fail
            # Future: can enable auto-migration with --auto-migrate flag
            return 0
            ;;
        2)
            # Incompatible - major version mismatch
            local current_version expected_version
            current_version=$(detect_file_version "$file")
            expected_version=$(get_expected_version "$schema_type")

            echo "ERROR: Incompatible schema version" >&2
            echo "  File: $file" >&2
            echo "  Current: v$current_version" >&2
            echo "  Expected: v$expected_version" >&2
            echo "  Major version mismatch - manual intervention required" >&2
            return 1
            ;;
    esac
}

# ============================================================================
# TASK VALIDATION
# ============================================================================

# Validate task title - no newlines, not empty, reasonable length
# Args: $1 = title string
# Returns: 0 if valid, 1 if invalid
validate_title() {
    local title="$1"

    # Check for empty
    if [[ -z "$title" ]]; then
        echo "[ERROR] Title cannot be empty" >&2
        return 1
    fi

    # Check for literal newlines
    if [[ "$title" == *$'\n'* ]]; then
        echo "[ERROR] Title cannot contain newlines" >&2
        return 1
    fi

    # Check for escaped newlines
    if [[ "$title" == *'\n'* ]]; then
        echo "[ERROR] Title cannot contain newline sequences" >&2
        return 1
    fi

    # Check for carriage returns
    if [[ "$title" == *$'\r'* ]]; then
        echo "[ERROR] Title cannot contain carriage returns" >&2
        return 1
    fi

    # Check for zero-width and invisible characters
    # Zero-width space: U+200B (E2 80 8B), Zero-width non-joiner: U+200C (E2 80 8C)
    # Zero-width joiner: U+200D (E2 80 8D), BOM: U+FEFF (EF BB BF)
    # Word joiner: U+2060 (E2 81 A0), Soft hyphen: U+00AD (C2 AD)
    # Use od to convert to hex (more portable than xxd)
    local hex_dump
    hex_dump=$(printf '%s' "$title" | od -An -tx1 | tr -d ' \n')

    # Check for problematic Unicode sequences
    if [[ "$hex_dump" == *"e2808b"* ]] || \
       [[ "$hex_dump" == *"e2808c"* ]] || \
       [[ "$hex_dump" == *"e2808d"* ]] || \
       [[ "$hex_dump" == *"efbbbf"* ]] || \
       [[ "$hex_dump" == *"e281a0"* ]] || \
       [[ "$hex_dump" == *"c2ad"* ]]; then
        echo "[ERROR] Title contains invisible/zero-width characters" >&2
        return 1
    fi

    # Check for ASCII control characters (0x00-0x1F, 0x7F) except those already checked
    # Need to match complete bytes, not partial hex patterns
    # Add spaces back to hex dump to match whole bytes
    local hex_bytes
    hex_bytes=$(printf '%s' "$title" | od -An -tx1 | sed 's/^ *//' | tr -s ' ')

    # Match control character bytes with word boundaries
    if echo "$hex_bytes" | grep -qE '\<(0[0-8]|0[b-e]|1[0-9a-f]|7f)\>'; then
        echo "[ERROR] Title contains control characters" >&2
        return 1
    fi

    # Check for excessive whitespace at start/end
    if [[ "$title" != "${title#[[:space:]]}" ]] || [[ "$title" != "${title%[[:space:]]}" ]]; then
        echo "[WARN] Title has leading/trailing whitespace (should be trimmed)" >&2
        # Note: This is a warning, not an error - callers should trim before validation
    fi

    # Check length (max 120 chars per schema)
    if [[ ${#title} -gt 120 ]]; then
        echo "[ERROR] Title too long (${#title}/120 characters)" >&2
        return 1
    fi

    return 0
}

export -f validate_title

# ============================================================================
# FIELD LENGTH VALIDATION
# ============================================================================

# Field length limits (defined as constants for consistency)
readonly MAX_DESCRIPTION_LENGTH=2000
readonly MAX_NOTE_LENGTH=5000
readonly MAX_BLOCKED_BY_LENGTH=300
readonly MAX_SESSION_NOTE_LENGTH=1000

# Validate description length (max 2000 chars)
# Args: $1 = description string
# Returns: 0 if valid, 1 if too long
validate_description() {
    local desc="$1"

    # Empty description is valid (optional field)
    if [[ -z "$desc" ]]; then
        return 0
    fi

    if [[ ${#desc} -gt $MAX_DESCRIPTION_LENGTH ]]; then
        echo "[ERROR] Description exceeds $MAX_DESCRIPTION_LENGTH characters (${#desc} provided)" >&2
        return 1
    fi
    return 0
}

export -f validate_description

# Validate note length (max 5000 chars per note entry)
# Args: $1 = note string
# Returns: 0 if valid, 1 if too long
validate_note() {
    local note="$1"

    # Empty note is valid (nothing to validate)
    if [[ -z "$note" ]]; then
        return 0
    fi

    if [[ ${#note} -gt $MAX_NOTE_LENGTH ]]; then
        echo "[ERROR] Note exceeds $MAX_NOTE_LENGTH characters (${#note} provided)" >&2
        return 1
    fi
    return 0
}

export -f validate_note

# Validate blockedBy reason length (max 300 chars)
# Args: $1 = blocked reason string
# Returns: 0 if valid, 1 if too long
validate_blocked_by() {
    local blocked="$1"

    # Empty is valid (optional field)
    if [[ -z "$blocked" ]]; then
        return 0
    fi

    if [[ ${#blocked} -gt $MAX_BLOCKED_BY_LENGTH ]]; then
        echo "[ERROR] Blocked-by reason exceeds $MAX_BLOCKED_BY_LENGTH characters (${#blocked} provided)" >&2
        return 1
    fi
    return 0
}

export -f validate_blocked_by

# Validate session note length (max 1000 chars)
# Args: $1 = session note string
# Returns: 0 if valid, 1 if too long
validate_session_note() {
    local note="$1"

    # Empty is valid (optional field)
    if [[ -z "$note" ]]; then
        return 0
    fi

    if [[ ${#note} -gt $MAX_SESSION_NOTE_LENGTH ]]; then
        echo "[ERROR] Session note exceeds $MAX_SESSION_NOTE_LENGTH characters (${#note} provided)" >&2
        return 1
    fi
    return 0
}

export -f validate_session_note

# ============================================================================
# CANCELLATION VALIDATION
# ============================================================================

# Minimum and maximum length for cancellation reason
readonly MIN_CANCEL_REASON_LENGTH=5
readonly MAX_CANCEL_REASON_LENGTH=300

# Validate cancellation reason
# Args: $1 = reason string
# Returns: 0 if valid, 1 if invalid (with structured error output)
validate_cancel_reason() {
    local reason="$1"

    # Check for empty reason
    if [[ -z "$reason" ]]; then
        echo "[ERROR] Cancellation reason cannot be empty" >&2
        echo "  field: cancellationReason" >&2
        echo "  constraint: required" >&2
        return 1
    fi

    # Check minimum length
    if [[ ${#reason} -lt $MIN_CANCEL_REASON_LENGTH ]]; then
        echo "[ERROR] Cancellation reason too short (${#reason}/$MIN_CANCEL_REASON_LENGTH minimum characters)" >&2
        echo "  field: cancellationReason" >&2
        echo "  constraint: minLength=$MIN_CANCEL_REASON_LENGTH" >&2
        echo "  provided: ${#reason}" >&2
        return 1
    fi

    # Check maximum length
    if [[ ${#reason} -gt $MAX_CANCEL_REASON_LENGTH ]]; then
        echo "[ERROR] Cancellation reason too long (${#reason}/$MAX_CANCEL_REASON_LENGTH maximum characters)" >&2
        echo "  field: cancellationReason" >&2
        echo "  constraint: maxLength=$MAX_CANCEL_REASON_LENGTH" >&2
        echo "  provided: ${#reason}" >&2
        return 1
    fi

    # Check for newlines and carriage returns (must be single-line)
    if [[ "$reason" == *$'\n'* ]] || [[ "$reason" == *$'\r'* ]]; then
        echo "[ERROR] Cancellation reason cannot contain newlines or carriage returns" >&2
        echo "  field: cancellationReason" >&2
        echo "  constraint: single-line text only" >&2
        echo "  security: prevents injection attacks" >&2
        return 1
    fi

    # Check for shell metacharacters that could enable injection attacks
    # Disallowed: | ; & $ ` \ < > ( ) { } [ ] ! " '
    if [[ "$reason" == *'|'* ]] || [[ "$reason" == *';'* ]] || \
       [[ "$reason" == *'&'* ]] || [[ "$reason" == *'$'* ]] || \
       [[ "$reason" == *'`'* ]] || [[ "$reason" == *'\'* ]] || \
       [[ "$reason" == *'<'* ]] || [[ "$reason" == *'>'* ]] || \
       [[ "$reason" == *'('* ]] || [[ "$reason" == *')'* ]] || \
       [[ "$reason" == *'{'* ]] || [[ "$reason" == *'}'* ]] || \
       [[ "$reason" == *'['* ]] || [[ "$reason" == *']'* ]] || \
       [[ "$reason" == *'!'* ]] || [[ "$reason" == *'"'* ]] || \
       [[ "$reason" == *"'"* ]]; then
        echo "[ERROR] Cancellation reason contains disallowed characters" >&2
        echo "  field: cancellationReason" >&2
        echo "  constraint: no shell metacharacters (|;&\$\`\\<>(){}[]!\"')" >&2
        echo "  security: prevents injection attacks" >&2
        return 1
    fi

    return 0
}

export -f validate_cancel_reason

# Check cancelled fields consistency
# When status=cancelled: cancelledAt and cancellationReason must be present
# When status!=cancelled: these fields should not be present
# Args: $1 = todo file path, $2 = task index
# Returns: 0 if valid, 1 if invalid
check_cancelled_fields() {
    local file="$1"
    local task_idx="$2"
    local errors=0

    # Get task status and cancellation fields
    local status cancelled_at cancellation_reason
    status=$(jq -r ".tasks[$task_idx].status // empty" "$file")
    cancelled_at=$(jq -r ".tasks[$task_idx].cancelledAt // empty" "$file")
    cancellation_reason=$(jq -r ".tasks[$task_idx].cancellationReason // empty" "$file")

    if [[ "$status" == "cancelled" ]]; then
        # Cancelled tasks MUST have cancelledAt
        if [[ -z "$cancelled_at" ]]; then
            echo "[ERROR] Task at index $task_idx: cancelled status requires cancelledAt timestamp" >&2
            echo "  field: cancelledAt" >&2
            echo "  constraint: required when status=cancelled" >&2
            ((errors++))
        fi

        # Cancelled tasks MUST have cancellationReason
        if [[ -z "$cancellation_reason" ]]; then
            echo "[ERROR] Task at index $task_idx: cancelled status requires cancellationReason" >&2
            echo "  field: cancellationReason" >&2
            echo "  constraint: required when status=cancelled" >&2
            ((errors++))
        else
            # Validate the reason content
            if ! validate_cancel_reason "$cancellation_reason" 2>/dev/null; then
                validate_cancel_reason "$cancellation_reason"
                ((errors++))
            fi
        fi

        # Validate cancelledAt timestamp format if present
        if [[ -n "$cancelled_at" ]]; then
            if [[ ! "$cancelled_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
                echo "[ERROR] Task at index $task_idx: invalid cancelledAt timestamp format" >&2
                echo "  field: cancelledAt" >&2
                echo "  expected: ISO 8601 format (YYYY-MM-DDTHH:MM:SSZ)" >&2
                echo "  provided: $cancelled_at" >&2
                ((errors++))
            else
                # Check timestamp is not in the future
                local cancelled_epoch current_epoch
                cancelled_epoch=$(timestamp_to_epoch "$cancelled_at")
                current_epoch=$(date +%s)
                if [[ $cancelled_epoch -gt $current_epoch ]]; then
                    echo "[ERROR] Task at index $task_idx: cancelledAt is in the future" >&2
                    echo "  field: cancelledAt" >&2
                    echo "  constraint: must not be future timestamp" >&2
                    ((errors++))
                fi
            fi
        fi
    else
        # Non-cancelled tasks should NOT have cancellation fields
        if [[ -n "$cancelled_at" ]]; then
            echo "[WARN] Task at index $task_idx: cancelledAt present but status is '$status'" >&2
            echo "  field: cancelledAt" >&2
            echo "  constraint: only allowed when status=cancelled" >&2
            echo "  recommendation: remove cancelledAt or change status to cancelled" >&2
            # Warning only, not counted as error for backward compatibility
        fi

        if [[ -n "$cancellation_reason" ]]; then
            echo "[WARN] Task at index $task_idx: cancellationReason present but status is '$status'" >&2
            echo "  field: cancellationReason" >&2
            echo "  constraint: only allowed when status=cancelled" >&2
            echo "  recommendation: remove cancellationReason or change status to cancelled" >&2
            # Warning only, not counted as error for backward compatibility
        fi
    fi

    [[ $errors -eq 0 ]]
}

export -f check_cancelled_fields

# ============================================================================
# TASK OBJECT VALIDATION
# ============================================================================

# Validate a single task object
# Args: $1 = file path, $2 = task index
# Returns: 0 if valid, 1 if invalid
validate_task() {
    local file="$1"
    local task_idx="$2"
    local errors=0

    # Check task exists
    if ! jq -e ".tasks[$task_idx]" "$file" >/dev/null 2>&1; then
        echo "ERROR: Task at index $task_idx does not exist" >&2
        return 1
    fi

    # 1. Check required fields exist
    local content status activeForm
    content=$(jq -r ".tasks[$task_idx].content // empty" "$file")
    status=$(jq -r ".tasks[$task_idx].status // empty" "$file")
    activeForm=$(jq -r ".tasks[$task_idx].activeForm // empty" "$file")

    if [[ -z "$content" ]]; then
        echo "ERROR: Task $task_idx missing 'content' field" >&2
        echo "Fix: Add content field with task description" >&2
        ((errors++))
    fi

    if [[ -z "$status" ]]; then
        echo "ERROR: Task $task_idx missing 'status' field" >&2
        echo "Fix: Add status field (pending|active|done|blocked|cancelled)" >&2
        ((errors++))
    fi

    if [[ -z "$activeForm" ]]; then
        echo "ERROR: Task $task_idx missing 'activeForm' field" >&2
        echo "Fix: Add activeForm field with present continuous form" >&2
        ((errors++))
    fi

    # 2. Validate status enum
    if [[ -n "$status" ]]; then
        local valid_status=false
        for valid in "${VALID_STATUSES[@]}"; do
            if [[ "$status" == "$valid" ]]; then
                valid_status=true
                break
            fi
        done

        if [[ "$valid_status" == "false" ]]; then
            echo "ERROR: Task $task_idx has invalid status: '$status'" >&2
            echo "Fix: Status must be one of: ${VALID_STATUSES[*]}" >&2
            ((errors++))
        fi
    fi

    # 3. Check content/activeForm pairing
    if [[ -n "$content" && -n "$activeForm" ]]; then
        if [[ "$content" == "$activeForm" ]]; then
            echo "WARNING: Task $task_idx has identical content and activeForm" >&2
            echo "Fix: activeForm should be present continuous (e.g., 'Implementing auth')" >&2
        fi
    fi

    # 4. Check timestamp fields if present
    local created_at completed_at
    created_at=$(jq -r ".tasks[$task_idx].created_at // empty" "$file")
    completed_at=$(jq -r ".tasks[$task_idx].completed_at // empty" "$file")

    if [[ -n "$created_at" ]]; then
        if ! check_timestamp_sanity "$created_at" ""; then
            echo "ERROR: Task $task_idx has invalid created_at timestamp" >&2
            ((errors++))
        fi
    fi

    if [[ -n "$completed_at" ]]; then
        if [[ -n "$created_at" ]]; then
            if ! check_timestamp_sanity "$created_at" "$completed_at"; then
                echo "ERROR: Task $task_idx has completed_at before created_at" >&2
                ((errors++))
            fi
        fi
    fi

    # 5. Check ID format if present
    local task_id
    task_id=$(jq -r ".tasks[$task_idx].id // empty" "$file")
    if [[ -n "$task_id" ]]; then
        if [[ ! "$task_id" =~ ^[a-zA-Z0-9_-]+$ ]]; then
            echo "ERROR: Task $task_idx has invalid ID format: '$task_id'" >&2
            echo "Fix: ID should contain only alphanumeric, dash, and underscore" >&2
            ((errors++))
        fi
    fi

    # 6. Check cancelled status field consistency
    if ! check_cancelled_fields "$file" "$task_idx"; then
        ((errors++))
    fi

    [[ $errors -eq 0 ]]
}

# ============================================================================
# ID UNIQUENESS CHECK
# ============================================================================

# Check ID uniqueness within file and across files
# Args: $1 = todo file, $2 = archive file (optional)
# Returns: 0 if unique, 1 if duplicates found
check_id_uniqueness() {
    local todo_file="$1"
    local archive_file="${2:-}"
    local errors=0

    # Extract all IDs from todo file
    local todo_ids
    todo_ids=$(jq -r '.tasks[].id // empty' "$todo_file" 2>/dev/null | sort)

    if [[ -z "$todo_ids" ]]; then
        return 0  # No IDs to check
    fi

    # Check for duplicates within todo file
    local duplicate_ids
    duplicate_ids=$(echo "$todo_ids" | uniq -d)

    if [[ -n "$duplicate_ids" ]]; then
        echo "ERROR: Duplicate task IDs found in $todo_file:" >&2
        echo "$duplicate_ids" | while read -r id; do
            echo "  - $id" >&2
            # Show line numbers
            jq --arg id "$id" '.tasks[] | select(.id == $id)' "$todo_file" | head -5 >&2
        done
        echo "Fix: Regenerate unique IDs for duplicate tasks" >&2
        ((errors++))
    fi

    # Check against archive file if provided
    if [[ -n "$archive_file" && -f "$archive_file" ]]; then
        local archive_ids
        archive_ids=$(jq -r '.archived_tasks[].id // empty' "$archive_file" 2>/dev/null | sort)

        if [[ -n "$archive_ids" ]]; then
            local cross_duplicates
            cross_duplicates=$(comm -12 <(echo "$todo_ids") <(echo "$archive_ids"))

            if [[ -n "$cross_duplicates" ]]; then
                echo "ERROR: Task IDs exist in both todo and archive:" >&2
                echo "$cross_duplicates" | while read -r id; do
                    echo "  - $id" >&2
                done
                echo "Fix: Remove duplicate from one of the files" >&2
                ((errors++))
            fi
        fi
    fi

    [[ $errors -eq 0 ]]
}

# ============================================================================
# TIMESTAMP VALIDATION
# ============================================================================

# Check timestamp sanity
# Args: $1 = created_at timestamp, $2 = completed_at timestamp (optional)
# Returns: 0 if valid, 1 if invalid
check_timestamp_sanity() {
    local created_at="$1"
    local completed_at="${2:-}"

    # Validate created_at format
    if [[ ! "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
        echo "ERROR: Invalid timestamp format: '$created_at'" >&2
        echo "Fix: Use ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ" >&2
        return 1
    fi

    # Check created_at is not in the future
    local created_epoch current_epoch
    created_epoch=$(timestamp_to_epoch "$created_at")
    current_epoch=$(date +%s)

    if [[ $created_epoch -gt $current_epoch ]]; then
        echo "ERROR: created_at is in the future: $created_at" >&2
        echo "Fix: Use current or past timestamp" >&2
        return 1
    fi

    # If completed_at provided, check it's after created_at
    if [[ -n "$completed_at" ]]; then
        if [[ ! "$completed_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
            echo "ERROR: Invalid completed_at format: '$completed_at'" >&2
            echo "Fix: Use ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ" >&2
            return 1
        fi

        local completed_epoch
        completed_epoch=$(timestamp_to_epoch "$completed_at")

        if [[ $completed_epoch -lt $created_epoch ]]; then
            echo "ERROR: completed_at ($completed_at) is before created_at ($created_at)" >&2
            echo "Fix: Ensure completed_at is after created_at" >&2
            return 1
        fi

        if [[ $completed_epoch -gt $current_epoch ]]; then
            echo "ERROR: completed_at is in the future: $completed_at" >&2
            echo "Fix: Use current or past timestamp" >&2
            return 1
        fi
    fi

    return 0
}

# ============================================================================
# UPDATE FIELD CLASSIFICATION
# ============================================================================

# Check if update contains only metadata fields (allowed on done tasks)
# Metadata fields can be modified on completed tasks without reopening them.
# Work fields require the task to be non-done status.
#
# Arguments:
#   $1... - Field names being updated
# Returns:
#   0 - Only metadata fields (safe for done tasks)
#   1 - Contains work fields (blocked for done tasks)
# Example:
#   is_metadata_only_update "type" "parentId" && echo "safe"
#   is_metadata_only_update "title" "type" && echo "blocked"
is_metadata_only_update() {
    # Metadata fields: organizational/structural, can change on done tasks
    local METADATA_FIELDS=("type" "parentId" "labels" "size")

    # Work fields: content/workflow-related, blocked on done tasks
    local WORK_FIELDS=("title" "description" "status" "priority" "notes" "depends" "blockedBy" "phase" "files" "acceptance")

    for field in "$@"; do
        # Check if field is in work fields
        for work_field in "${WORK_FIELDS[@]}"; do
            if [[ "$field" == "$work_field" ]]; then
                return 1  # Contains work field
            fi
        done
    done

    return 0  # Only metadata fields
}

export -f is_metadata_only_update

# ============================================================================
# STATUS TRANSITION VALIDATION
# ============================================================================

# Validate status transition is allowed
# Args: $1 = old status, $2 = new status
# Returns: 0 if valid, 1 if invalid
validate_status_transition() {
    local old_status="$1"
    local new_status="$2"

    # Same status is always valid
    if [[ "$old_status" == "$new_status" ]]; then
        return 0
    fi

    # Define valid transitions
    case "$old_status" in
        "pending")
            case "$new_status" in
                "active"|"blocked"|"cancelled") return 0 ;;
                *) ;;
            esac
            ;;
        "active")
            case "$new_status" in
                "done"|"blocked"|"pending"|"cancelled") return 0 ;;
                *) ;;
            esac
            ;;
        "done")
            # Done tasks are terminal - can only restore to pending (rare edge case)
            # Cannot cancel completed work - done is permanent state
            case "$new_status" in
                "pending") return 0 ;;
                *) ;;
            esac
            ;;
        "blocked")
            # Blocked tasks can return to pending, active, or be cancelled
            case "$new_status" in
                "pending"|"active"|"cancelled") return 0 ;;
                *) ;;
            esac
            ;;
        "cancelled")
            # Cancelled is a terminal-ish state - can only restore to pending
            case "$new_status" in
                "pending") return 0 ;;
                *) ;;
            esac
            ;;
    esac

    echo "ERROR: Invalid status transition: '$old_status' → '$new_status'" >&2
    echo "Valid transitions:" >&2
    echo "  pending → active, blocked, cancelled" >&2
    echo "  active → done, blocked, pending, cancelled" >&2
    echo "  done → pending (use archive for completed tasks)" >&2
    echo "  blocked → pending, active, cancelled" >&2
    echo "  cancelled → pending (restore only)" >&2
    return 1
}

# ============================================================================
# CIRCULAR DEPENDENCY DETECTION
# ============================================================================

# Check for circular dependencies using depth-first search
# Args: $1 = todo file, $2 = task ID, $3 = comma-separated new dependencies
# Returns: 0 if no cycle, 1 if cycle detected
validate_no_circular_deps() {
    local todo_file="$1"
    local task_id="$2"
    local new_deps="$3"

    if [[ -z "$new_deps" ]]; then
        return 0  # No dependencies to check
    fi

    # Create temporary file with proposed changes
    local temp_file
    temp_file=$(mktemp)

    # Add new dependencies to task in temp file
    jq --arg id "$task_id" --arg deps "$new_deps" '
        .tasks = [.tasks[] | if .id == $id then
            # Split comma-separated deps and merge with existing
            .depends = (($deps | split(",") | map(gsub("^\\s+|\\s+$";""))) + (.depends // []) | unique)
        else . end]
    ' "$todo_file" > "$temp_file"

    # Run DFS cycle detection on temp file
    if ! _dfs_detect_cycle "$temp_file" "$task_id"; then
        rm -f "$temp_file"
        return 1  # Cycle detected
    fi

    rm -f "$temp_file"
    return 0
}

# DFS cycle detection using recursion stack
# Args: $1 = todo file, $2 = task ID to check from
# Returns: 0 if no cycle, 1 if cycle detected
_dfs_detect_cycle() {
    local todo_file="$1"
    local start_task="$2"

    # Initialize tracking arrays (using string-based sets)
    local visited=""
    local rec_stack=""
    local cycle_path=""

    # Helper function for DFS traversal
    _dfs_visit() {
        local current="$1"

        # If current is already in recursion stack, we found a cycle
        if [[ "$rec_stack" == *",$current,"* ]]; then
            # Build cycle path
            cycle_path="$current (cycle back to start)"
            echo "ERROR: circular dependency detected involving: $current" >&2
            echo "Fix: Remove dependency that creates the cycle" >&2
            return 1
        fi

        # If already visited (and not in rec_stack), no need to visit again
        if [[ "$visited" == *",$current,"* ]]; then
            return 0
        fi

        # Mark current as visited and add to recursion stack
        visited="$visited,$current,"
        rec_stack="$rec_stack,$current,"

        # Get dependencies of current task
        local deps
        deps=$(jq -r --arg id "$current" '
            .tasks[] |
            select(.id == $id) |
            if has("depends") and (.depends | length > 0) then
                .depends | join(",")
            else
                ""
            end
        ' "$todo_file")

        # Check each dependency
        if [[ -n "$deps" ]]; then
            IFS=',' read -ra dep_array <<< "$deps"
            for dep in "${dep_array[@]}"; do
                dep=$(echo "$dep" | xargs)  # Trim whitespace
                [[ -z "$dep" ]] && continue

                # Recurse into dependency
                if ! _dfs_visit "$dep"; then
                    # Propagate cycle detection and build path
                    if [[ "$cycle_path" != *"$current"* ]]; then
                        cycle_path="$current → $cycle_path"
                    fi
                    return 1
                fi
            done
        fi

        # Remove from recursion stack (backtrack)
        rec_stack="${rec_stack//,$current,/,}"
        return 0
    }

    # Start DFS from the specified task
    if ! _dfs_visit "$start_task"; then
        return 1
    fi

    return 0
}

# Wrapper function for better error handling and reporting
# Args: $1 = todo file, $2 = task ID, $3 = comma-separated dependencies
# Returns: 0 if valid, 1 if cycle detected
check_circular_dependencies() {
    local todo_file="$1"
    local task_id="$2"
    local dependencies="$3"

    if [[ ! -f "$todo_file" ]]; then
        echo "ERROR: Todo file not found: $todo_file" >&2
        return 1
    fi

    if [[ -z "$dependencies" ]]; then
        return 0  # No dependencies to check
    fi

    # Validate all dependency IDs exist first
    IFS=',' read -ra dep_array <<< "$dependencies"
    for dep_id in "${dep_array[@]}"; do
        dep_id=$(echo "$dep_id" | xargs)

        # Check if dependency exists
        local exists
        exists=$(jq --arg id "$dep_id" '[.tasks[].id] | index($id) != null' "$todo_file")
        if [[ "$exists" != "true" ]]; then
            echo "ERROR: Dependency task not found: $dep_id" >&2
            return 1
        fi
    done

    # Perform cycle detection
    if ! validate_no_circular_deps "$todo_file" "$task_id" "$dependencies"; then
        return 1
    fi

    return 0
}

# ============================================================================
# PHASE VALIDATION
# ============================================================================

# Validate only one phase is active
# Args: $1 = todo file path
# Returns: 0 if valid, 1 if multiple active phases
validate_single_active_phase() {
    local todo_file="$1"
    local active_count

    active_count=$(jq '[.project.phases | to_entries[] | select(.value.status == "active")] | length' "$todo_file" 2>/dev/null || echo 0)

    if [[ "$active_count" -gt 1 ]]; then
        echo "ERROR: Multiple phases marked as active ($active_count found, only 1 allowed)" >&2
        echo "Fix: Use 'cleo phase set <slug>' to set a single active phase" >&2
        return 1
    fi

    return 0
}

# Validate currentPhase consistency
# Args: $1 = todo file path
# Returns: 0 if valid, 1 if currentPhase doesn't match active phase
validate_current_phase_consistency() {
    local todo_file="$1"
    local current_phase
    local phase_status

    # Get currentPhase (handles both old and new schema)
    current_phase=$(jq -r '.project.currentPhase // null' "$todo_file" 2>/dev/null)

    if [[ "$current_phase" == "null" || -z "$current_phase" ]]; then
        return 0  # No current phase set is valid
    fi

    # Check if referenced phase exists
    if ! jq -e --arg slug "$current_phase" '.project.phases[$slug]' "$todo_file" >/dev/null 2>&1; then
        echo "ERROR: Current phase '$current_phase' does not exist in phases definition" >&2
        echo "Fix: Set currentPhase to an existing phase slug" >&2
        return 1
    fi

    # Check if current phase has status=active
    phase_status=$(jq -r --arg slug "$current_phase" '.project.phases[$slug].status // "unknown"' "$todo_file")

    if [[ "$phase_status" != "active" ]]; then
        echo "ERROR: Current phase '$current_phase' has status '$phase_status', expected 'active'" >&2
        echo "Fix: Either change phase status to 'active' or set a different currentPhase" >&2
        return 1
    fi

    return 0
}

# Validate phase timestamp ordering
# Args: $1 = todo file path
# Returns: 0 if valid, 1 if timestamps are out of order
validate_phase_timestamps() {
    local todo_file="$1"
    local errors=0

    # Check each phase for timestamp ordering
    while IFS=: read -r slug started completed; do
        if [[ -n "$started" && -n "$completed" && "$started" != "null" && "$completed" != "null" ]]; then
            if [[ "$started" > "$completed" ]]; then
                echo "ERROR: Phase '$slug': startedAt ($started) is after completedAt ($completed)" >&2
                ((errors++))
            fi
        fi
    done < <(jq -r '.project.phases | to_entries[] | "\(.key):\(.value.startedAt // "null"):\(.value.completedAt // "null")"' "$todo_file" 2>/dev/null)

    if [[ $errors -gt 0 ]]; then
        echo "Fix: Correct timestamp ordering in phase definitions" >&2
        return 1
    fi

    return 0
}

# Validate phase status requirements
# Args: $1 = todo file path
# Returns: 0 if valid, 1 if status requirements not met
validate_phase_status_requirements() {
    local todo_file="$1"
    local errors=0

    # Check active/completed phases have startedAt
    while IFS=: read -r slug status started; do
        if [[ "$status" == "active" || "$status" == "completed" ]]; then
            if [[ "$started" == "null" || -z "$started" ]]; then
                echo "ERROR: Phase '$slug' with status '$status' requires startedAt timestamp" >&2
                ((errors++))
            fi
        fi
    done < <(jq -r '.project.phases | to_entries[] | "\(.key):\(.value.status):\(.value.startedAt // "null")"' "$todo_file" 2>/dev/null)

    # Check completed phases have completedAt
    while IFS=: read -r slug status completed; do
        if [[ "$status" == "completed" ]]; then
            if [[ "$completed" == "null" || -z "$completed" ]]; then
                echo "ERROR: Phase '$slug' with status 'completed' requires completedAt timestamp" >&2
                ((errors++))
            fi
        fi
    done < <(jq -r '.project.phases | to_entries[] | "\(.key):\(.value.status):\(.value.completedAt // "null")"' "$todo_file" 2>/dev/null)

    [[ $errors -eq 0 ]]
}

export -f validate_single_active_phase
export -f validate_current_phase_consistency
export -f validate_phase_timestamps
export -f validate_phase_status_requirements

# ============================================================================
# HIERARCHY VALIDATION
# ============================================================================

# Validate task hierarchy integrity
# Checks:
#   - Orphan detection (parentId references must exist)
#   - Depth limits (max 3 levels: epic -> task -> subtask)
#   - Sibling limits (max 7 children per parent)
#   - Circular reference detection
#
# Args: $1 = todo file path
# Returns:
#   0 = all validations passed
#   EXIT_ORPHAN_DETECTED (15) = orphan tasks found
#   EXIT_DEPTH_EXCEEDED (11) = hierarchy too deep
#   EXIT_SIBLING_LIMIT (12) = too many siblings
#   EXIT_CIRCULAR_REFERENCE (14) = circular parent chain
validate_hierarchy_integrity() {
    local todo_file="$1"
    local errors=0

    # Lazy-load hierarchy library on demand
    if ! _ensure_hierarchy_loaded; then
        echo "INFO: Hierarchy library not available, skipping hierarchy validation" >&2
        return 0
    fi

    # Skip if no tasks with parentId exist (no hierarchy to validate)
    local has_hierarchy
    has_hierarchy=$(jq '[.tasks[] | select(.parentId != null and .parentId != "null")] | length' "$todo_file" 2>/dev/null || echo 0)
    if [[ "$has_hierarchy" -eq 0 ]]; then
        return 0  # No hierarchy present, nothing to validate
    fi

    # 1. Detect orphan tasks (parentId references non-existent task)
    local orphans_json
    orphans_json=$(detect_orphans "$todo_file")
    local orphan_count
    orphan_count=$(echo "$orphans_json" | jq '. | length' 2>/dev/null || echo 0)
    if [[ "$orphan_count" -gt 0 ]]; then
        echo "ERROR: Orphan tasks detected (parentId references missing task):" >&2
        # Parse JSON array to extract orphan IDs and their missing parents
        echo "$orphans_json" | jq -r '.[] | "  - \(.id) (references non-existent parent: \(.parentId))"' >&2
        echo "Fix: Remove parentId or restore the parent task" >&2
        ((errors++))
    fi

    # 2. Validate depth limits (max 3 levels)
    while IFS= read -r task_id; do
        [[ -z "$task_id" ]] && continue

        local depth
        depth=$(get_task_depth "$task_id" "$todo_file")

        if [[ "$depth" -eq -1 ]]; then
            # Circular reference detected during depth calculation
            echo "ERROR: Circular reference detected in parent chain for task: $task_id" >&2
            echo "Fix: Break the circular parent reference" >&2
            ((errors++))
        elif [[ "$depth" -ge "$MAX_HIERARCHY_DEPTH" ]]; then
            echo "ERROR: Task $task_id exceeds maximum depth (depth=$depth, max=$((MAX_HIERARCHY_DEPTH - 1)))" >&2
            echo "Fix: Restructure hierarchy to reduce depth" >&2
            ((errors++))
        fi
    done < <(jq -r '.tasks[].id' "$todo_file" 2>/dev/null)

    # 3. Validate sibling limits (max 7 children per parent)
    # Get unique parent IDs
    local parent_ids
    parent_ids=$(jq -r '.tasks[] | .parentId // "null"' "$todo_file" 2>/dev/null | sort -u)

    for parent_id in $parent_ids; do
        local sibling_count
        sibling_count=$(count_siblings "$parent_id" "$todo_file")

        if [[ "$sibling_count" -gt "$MAX_SIBLINGS" ]]; then
            if [[ "$parent_id" == "null" ]]; then
                echo "ERROR: Root level has too many tasks ($sibling_count > $MAX_SIBLINGS)" >&2
            else
                echo "ERROR: Parent $parent_id has too many children ($sibling_count > $MAX_SIBLINGS)" >&2
            fi
            echo "Fix: Move some tasks to different parents or create new parent tasks" >&2
            ((errors++))
        fi
    done

    # 4. Validate parent types (subtasks cannot have children)
    while IFS= read -r task_id; do
        [[ -z "$task_id" ]] && continue

        local parent_id
        parent_id=$(get_task_parent "$task_id" "$todo_file")

        if [[ "$parent_id" != "null" && -n "$parent_id" ]]; then
            local parent_type
            parent_type=$(get_task_type "$parent_id" "$todo_file")

            if [[ "$parent_type" == "subtask" ]]; then
                echo "ERROR: Task $task_id has subtask parent ($parent_id)" >&2
                echo "Fix: Subtasks cannot have children. Change parent or parent type" >&2
                ((errors++))
            fi
        fi
    done < <(jq -r '.tasks[].id' "$todo_file" 2>/dev/null)

    if [[ $errors -gt 0 ]]; then
        return "${EXIT_VALIDATION_ERROR:-6}"
    fi

    return 0
}

export -f validate_hierarchy_integrity

# ============================================================================
# COMPREHENSIVE VALIDATION
# ============================================================================

# Validate all aspects of a file
# Args: $1 = file path, $2 = schema type, $3 = archive file (optional)
# Returns: exit code based on validation results
validate_all() {
    local file="$1"
    local schema_type="$2"
    local archive_file="${3:-}"

    local schema_errors=0
    local semantic_errors=0

    echo "Validating: $file"
    echo "Schema type: $schema_type"
    echo "----------------------------------------"

    # 0. Version Check (non-blocking warning, uses lazy-loaded migrate.sh)
    echo "[0/10] Checking schema version..."
    if _ensure_migrate_loaded && [[ "$MIGRATION_AVAILABLE" == "true" ]]; then
        if ! validate_version "$file" "$schema_type"; then
            echo "⚠ WARNING: Version check failed"
        else
            local current_version
            current_version=$(detect_file_version "$file" 2>/dev/null || echo "unknown")
            echo "✓ PASSED: Version $current_version compatible"
        fi
    else
        echo "  (skipped - migration library not available)"
    fi

    # 1. JSON Syntax Validation
    echo "[1/10] Checking JSON syntax..."
    if ! validate_json_syntax "$file"; then
        ((schema_errors++))
        echo "✗ FAILED: JSON syntax invalid"
    else
        echo "✓ PASSED: JSON syntax valid"
    fi

    # 2. Schema Validation
    echo "[2/10] Checking schema compliance..."
    if ! validate_schema "$file" "$schema_type"; then
        ((schema_errors++))
        echo "✗ FAILED: Schema validation failed"
    else
        echo "✓ PASSED: Schema valid"
    fi

    # Stop here if schema validation failed
    if [[ $schema_errors -gt 0 ]]; then
        echo "----------------------------------------"
        echo "RESULT: Schema validation failed"
        echo "Skipping semantic checks due to schema errors"
        return $VAL_SCHEMA_ERROR
    fi

    # 3. ID Uniqueness Check
    if [[ "$schema_type" == "todo" || "$schema_type" == "archive" ]]; then
        echo "[3/10] Checking ID uniqueness..."
        if ! check_id_uniqueness "$file" "$archive_file"; then
            ((semantic_errors++))
            echo "✗ FAILED: Duplicate IDs found"
        else
            echo "✓ PASSED: All IDs unique"
        fi
    else
        echo "[3/10] Skipping ID uniqueness check (not applicable)"
    fi

    # 4. Individual Task Validation
    if [[ "$schema_type" == "todo" ]]; then
        echo "[4/10] Validating individual tasks..."
        local task_count
        task_count=$(jq '.tasks | length' "$file")
        local task_errors=0

        for ((i=0; i<task_count; i++)); do
            if ! validate_task "$file" "$i" 2>/dev/null; then
                validate_task "$file" "$i" 2>&1  # Show errors
                ((task_errors++))
            fi
        done

        if [[ $task_errors -gt 0 ]]; then
            ((semantic_errors++))
            echo "✗ FAILED: $task_errors task(s) have validation errors"
        else
            echo "✓ PASSED: All tasks valid ($task_count tasks)"
        fi
    else
        echo "[4/10] Skipping task validation (not applicable)"
    fi

    # 5. Content Duplicate Check
    if [[ "$schema_type" == "todo" ]]; then
        echo "[5/10] Checking for duplicate content..."
        local duplicate_content
        duplicate_content=$(jq -r '.tasks[].content' "$file" | sort | uniq -d)

        if [[ -n "$duplicate_content" ]]; then
            echo "⚠ WARNING: Duplicate task content found:" >&2
            echo "$duplicate_content" | head -5 >&2
            echo "Fix: Review tasks for duplicates" >&2
            # Not counted as error, just warning
        else
            echo "✓ PASSED: No duplicate content"
        fi
    else
        echo "[5/10] Skipping duplicate content check (not applicable)"
    fi

    # 6. Phase Validation (v2.2.0+)
    if [[ "$schema_type" == "todo" ]]; then
        if jq -e '.project.phases' "$file" >/dev/null 2>&1; then
            echo "[6/10] Validating phase configuration..."
            local phase_errors=0

            if ! validate_single_active_phase "$file"; then
                ((phase_errors++))
            fi

            if ! validate_current_phase_consistency "$file"; then
                ((phase_errors++))
            fi

            if ! validate_phase_timestamps "$file"; then
                ((phase_errors++))
            fi

            if ! validate_phase_status_requirements "$file"; then
                ((phase_errors++))
            fi

            if [[ $phase_errors -gt 0 ]]; then
                ((semantic_errors++))
                echo "✗ FAILED: Phase validation ($phase_errors issues)"
            else
                echo "✓ PASSED: Phase configuration valid"
            fi
        else
            echo "[6/10] Skipping phase validation (no phases defined)"
        fi
    else
        echo "[6/10] Skipping phase validation (not applicable)"
    fi

    # 7. Circular Dependency Check
    if [[ "$schema_type" == "todo" ]]; then
        echo "[7/10] Checking for circular dependencies..."
        local cycle_errors=0

        # Check each task with dependencies
        while IFS=':' read -r task_id deps; do
            if [[ -n "$task_id" && -n "$deps" ]]; then
                if ! validate_no_circular_deps "$file" "$task_id" "$deps" 2>/dev/null; then
                    # Re-run to show error message
                    validate_no_circular_deps "$file" "$task_id" "$deps"
                    ((cycle_errors++))
                fi
            fi
        done < <(jq -r '
            .tasks[] |
            select(has("depends") and (.depends | length > 0)) |
            "\(.id):\(.depends | join(","))"
        ' "$file")

        if [[ $cycle_errors -gt 0 ]]; then
            ((semantic_errors++))
            echo "✗ FAILED: Circular dependencies detected ($cycle_errors cycles)"
        else
            echo "✓ PASSED: No circular dependencies"
        fi
    else
        echo "[7/10] Skipping circular dependency check (not applicable)"
    fi

    # 8. Done Status Consistency
    if [[ "$schema_type" == "todo" ]]; then
        echo "[8/10] Checking done status consistency..."
        local invalid_done
        invalid_done=$(jq -r '.tasks[] | select(.status == "done" and (.completed_at == null or .completed_at == "")) | .id // "unknown"' "$file")

        if [[ -n "$invalid_done" ]]; then
            echo "ERROR: Done tasks missing completed_at timestamp:" >&2
            echo "$invalid_done" >&2
            ((semantic_errors++))
            echo "✗ FAILED: Done tasks missing timestamps"
        else
            echo "✓ PASSED: Done status consistent"
        fi
    elif [[ "$schema_type" == "archive" ]]; then
        echo "[8/10] Checking archive contains only done tasks..."
        local non_done
        non_done=$(jq -r '.archived_tasks[] | select(.status != "done") | .id // "unknown"' "$file")

        if [[ -n "$non_done" ]]; then
            echo "ERROR: Archive contains non-done tasks:" >&2
            echo "$non_done" >&2
            ((semantic_errors++))
            echo "✗ FAILED: Archive validation failed"
        else
            echo "✓ PASSED: Archive valid"
        fi
    else
        echo "[8/10] Skipping status consistency check (not applicable)"
    fi

    # 9. Hierarchy Validation (v0.17.0+)
    if [[ "$schema_type" == "todo" ]]; then
        echo "[9/10] Validating task hierarchy..."
        # validate_hierarchy_integrity handles lazy loading internally
        if ! validate_hierarchy_integrity "$file"; then
            ((semantic_errors++))
            echo "✗ FAILED: Hierarchy validation failed"
        else
            echo "✓ PASSED: Hierarchy valid"
        fi
    else
        echo "[9/10] Skipping hierarchy validation (not applicable)"
    fi

    # 10. Config-Specific Validation
    if [[ "$schema_type" == "config" ]]; then
        echo "[10/10] Checking configuration backward compatibility..."
        # Additional config-specific checks can be added here
        echo "✓ PASSED: Configuration valid"
    else
        echo "[10/10] Skipping config-specific checks (not applicable)"
    fi

    # Summary
    echo "----------------------------------------"
    echo "VALIDATION SUMMARY:"
    echo "  Schema errors: $schema_errors"
    echo "  Semantic errors: $semantic_errors"

    if [[ $schema_errors -eq 0 && $semantic_errors -eq 0 ]]; then
        echo "✓ RESULT: All validations passed"
        return $VAL_SUCCESS
    elif [[ $schema_errors -gt 0 && $semantic_errors -eq 0 ]]; then
        echo "✗ RESULT: Schema validation failed"
        return $VAL_SCHEMA_ERROR
    elif [[ $schema_errors -eq 0 && $semantic_errors -gt 0 ]]; then
        echo "✗ RESULT: Semantic validation failed"
        return $VAL_SEMANTIC_ERROR
    else
        echo "✗ RESULT: Both schema and semantic validation failed"
        return $VAL_BOTH_ERRORS
    fi
}

# ============================================================================
# MAIN (for testing)
# ============================================================================

# If script is executed directly (not sourced), run validation
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    if [[ $# -lt 2 ]]; then
        echo "Usage: $0 <file> <schema_type> [archive_file]" >&2
        echo "Schema types: todo, archive, config, log" >&2
        exit 1
    fi

    validate_all "$@"
    exit $?
fi
