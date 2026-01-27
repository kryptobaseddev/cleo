#!/usr/bin/env bash
# contribution-protocol.sh - Multi-Agent Contribution Protocol Library
#
# LAYER: 3 (Application Services)
# DEPENDENCIES: exit-codes.sh, validation.sh, platform-compat.sh
# PROVIDES: contribution_protocol_instantiate, contribution_validate_task,
#           contribution_get_injection, contribution_generate_id,
#           contribution_create_manifest_entry, contribution_compare_decisions,
#           contribution_detect_conflicts, contribution_aggregate_conflicts,
#           contribution_weighted_vote, contribution_compute_consensus,
#           contribution_generate_synthesis
#
# Implements the contribution protocol for multi-agent research coordination.
# Provides template instantiation, task validation, and injection block generation.
#
# USAGE:
#   source lib/contribution-protocol.sh
#
#   # Instantiate a protocol from template
#   protocol=$(contribution_protocol_instantiate "T2204" "session_xxx" "$decisions_json")
#
#   # Validate a contribution task
#   result=$(contribution_validate_task "T2210")
#
#   # Get injection block for subagent
#   injection=$(contribution_get_injection "T2204" "path/to/protocol.md")

#=== SOURCE GUARD ================================================
[[ -n "${_CONTRIBUTION_PROTOCOL_LOADED:-}" ]] && return 0
declare -r _CONTRIBUTION_PROTOCOL_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

# Determine library directory
_CP_LIB_DIR="${BASH_SOURCE[0]%/*}"
[[ "$_CP_LIB_DIR" == "${BASH_SOURCE[0]}" ]] && _CP_LIB_DIR="."

# Determine project root
_CP_PROJECT_ROOT="${_CP_LIB_DIR}/.."
[[ -d "${_CP_PROJECT_ROOT}/templates" ]] || _CP_PROJECT_ROOT="."

# Source dependencies
if [[ -f "$_CP_LIB_DIR/exit-codes.sh" ]]; then
    # shellcheck source=lib/exit-codes.sh
    source "$_CP_LIB_DIR/exit-codes.sh"
fi

if [[ -f "$_CP_LIB_DIR/platform-compat.sh" ]]; then
    # shellcheck source=lib/platform-compat.sh
    source "$_CP_LIB_DIR/platform-compat.sh"
fi

# ============================================================================
# CONSTANTS
# ============================================================================

# Template paths
readonly CP_TEMPLATE_PATH="${_CP_PROJECT_ROOT}/templates/CONTRIBUTION-PROTOCOL.template.md"
readonly CP_INJECTION_PATH="${_CP_PROJECT_ROOT}/templates/CONTRIBUTION-INJECTION.md"
readonly CP_SCHEMA_PATH="${_CP_PROJECT_ROOT}/schemas/contribution.schema.json"

# Default values
readonly CP_DEFAULT_OUTPUT_DIR="claudedocs/agent-outputs"
readonly CP_DEFAULT_PHASE="core"
readonly CP_DEFAULT_VERSION="1.0.0"

# ============================================================================
# INTERNAL HELPERS
# ============================================================================

# Log error message to stderr
# Args: $1 = message
_cp_error() {
    echo "[contribution-protocol] ERROR: $1" >&2
}

# Log warning message to stderr
# Args: $1 = message
_cp_warn() {
    echo "[contribution-protocol] WARNING: $1" >&2
}

# Generate unique contribution ID
# Format: contrib_{8 hex chars}
# Returns: contribution ID string
contribution_generate_id() {
    local hex_chars
    if command -v openssl &>/dev/null; then
        hex_chars=$(openssl rand -hex 4)
    elif [[ -r /dev/urandom ]]; then
        hex_chars=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
    else
        # Fallback: use date + PID
        hex_chars=$(printf '%08x' $(($(date +%s) ^ $$)))
        hex_chars="${hex_chars:0:8}"
    fi
    echo "contrib_${hex_chars}"
}

# Get current date in YYYY-MM-DD format
_cp_get_date() {
    date +%Y-%m-%d
}

# Get current ISO timestamp
_cp_get_timestamp() {
    if declare -f get_iso_timestamp &>/dev/null; then
        get_iso_timestamp
    else
        date -u +%Y-%m-%dT%H:%M:%SZ
    fi
}

# Replace simple token in text
# Args: $1 = text, $2 = token name (without braces), $3 = value
# Returns: text with token replaced
_cp_replace_token() {
    local text="$1"
    local token="$2"
    local value="$3"

    # Use sed with different delimiter to handle paths
    echo "$text" | sed "s|{{${token}}}|${value}|g"
}

# Process {{#each ARRAY}}...{{/each}} blocks
# Args: $1 = text, $2 = array name, $3 = JSON array
# Returns: text with array blocks expanded
_cp_process_each_block() {
    local text="$1"
    local array_name="$2"
    local array_json="$3"

    # Find the each block pattern
    local start_pattern="{{#each ${array_name}}}"
    local end_pattern="{{/each}}"

    # Check if array block exists
    if [[ "$text" != *"$start_pattern"* ]]; then
        echo "$text"
        return 0
    fi

    # Verify jq is available
    if ! command -v jq &>/dev/null; then
        _cp_warn "jq not available, cannot process array block: $array_name"
        echo "$text"
        return 0
    fi

    # Extract block content
    local before_block after_block block_content
    before_block="${text%%${start_pattern}*}"
    local temp="${text#*${start_pattern}}"
    block_content="${temp%%${end_pattern}*}"
    after_block="${temp#*${end_pattern}}"

    # Get array length
    local array_len
    array_len=$(echo "$array_json" | jq 'length' 2>/dev/null || echo "0")

    if [[ "$array_len" == "0" || "$array_len" == "null" ]]; then
        # Empty array - remove the block entirely
        echo "${before_block}${after_block}"
        return 0
    fi

    # Process each item
    local expanded=""
    local i=0
    while [[ $i -lt $array_len ]]; do
        local item_content="$block_content"

        # Get item fields and replace {{this.FIELD}}
        local fields
        fields=$(echo "$array_json" | jq -r ".[$i] | keys[]" 2>/dev/null || echo "")

        for field in $fields; do
            local field_value
            field_value=$(echo "$array_json" | jq -r ".[$i].${field} // \"\"" 2>/dev/null)
            item_content=$(echo "$item_content" | sed "s|{{this\.${field}}}|${field_value}|g")
        done

        # Also replace {{this}} for simple arrays
        local item_value
        item_value=$(echo "$array_json" | jq -r ".[$i]" 2>/dev/null)
        if [[ "$item_value" != "{"* ]]; then
            # Simple value, not object
            item_content=$(echo "$item_content" | sed "s|{{this}}|${item_value}|g")
        fi

        expanded+="$item_content"
        ((i++))
    done

    echo "${before_block}${expanded}${after_block}"
}

# ============================================================================
# PUBLIC API
# ============================================================================

# contribution_protocol_instantiate - Instantiate protocol from template
#
# Creates a complete contribution protocol document by replacing tokens
# in the template with provided values.
#
# Args:
#   $1 = epic_id (required) - Parent epic task ID (e.g., "T2204")
#   $2 = baseline_session_id (required) - Baseline session for comparison
#   $3 = decision_questions_json (required) - JSON array of decision questions
#   $4 = baseline_decisions_json (optional) - JSON array of baseline decisions
#   $5 = options_json (optional) - Additional options as JSON object
#
# Options JSON fields:
#   epicTitle: string - Epic title (defaults to epic_id)
#   markerLabel: string - Label for task discovery (defaults to "consensus-source")
#   outputDir: path - Research output directory (defaults to claudedocs/agent-outputs)
#   phase: string - Project phase (defaults to "core")
#   version: semver - Protocol version (defaults to "1.0.0")
#   synthesisTaskId: string - Final synthesis task ID
#   baselineFiles: array - List of baseline research file paths
#
# Returns: 0 on success, EXIT_FILE_ERROR if template not found
# Output: Instantiated protocol markdown to stdout
#
# Example:
#   decisions='[{"id": 1, "question": "Architecture?"}]'
#   baseline='[{"question": "Architecture", "position": "Single file"}]'
#   protocol=$(contribution_protocol_instantiate "T2204" "Session A" "$decisions" "$baseline")
contribution_protocol_instantiate() {
    local epic_id="${1:-}"
    local baseline_session="${2:-}"
    local questions_json="${3:-[]}"
    local baseline_decisions_json="${4:-[]}"
    # Note: Use quoted default to avoid Bash 5.3+ brace expansion bug
    local options_json="${5:-'{}'}"

    # Validate required arguments
    if [[ -z "$epic_id" ]]; then
        _cp_error "epic_id is required"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    if [[ -z "$baseline_session" ]]; then
        _cp_error "baseline_session is required"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # Check template exists
    if [[ ! -f "$CP_TEMPLATE_PATH" ]]; then
        _cp_error "Template not found: $CP_TEMPLATE_PATH"
        return "${EXIT_FILE_ERROR:-3}"
    fi

    # Read template
    local template
    template=$(cat "$CP_TEMPLATE_PATH")

    # Extract options with defaults
    local epic_title=""
    local marker_label=""
    local output_dir=""
    local phase=""
    local version=""
    local synthesis_task=""
    local baseline_files_json=""

    if command -v jq &>/dev/null && [[ -n "$options_json" && "$options_json" != "{}" ]]; then
        epic_title=$(echo "$options_json" | jq -r '.epicTitle // ""' 2>/dev/null) || epic_title=""
        marker_label=$(echo "$options_json" | jq -r '.markerLabel // ""' 2>/dev/null) || marker_label=""
        output_dir=$(echo "$options_json" | jq -r '.outputDir // ""' 2>/dev/null) || output_dir=""
        phase=$(echo "$options_json" | jq -r '.phase // ""' 2>/dev/null) || phase=""
        version=$(echo "$options_json" | jq -r '.version // ""' 2>/dev/null) || version=""
        synthesis_task=$(echo "$options_json" | jq -r '.synthesisTaskId // ""' 2>/dev/null) || synthesis_task=""
        baseline_files_json=$(echo "$options_json" | jq -c '.baselineFiles // []' 2>/dev/null) || baseline_files_json=""
    fi

    # Apply defaults
    [[ -z "$epic_title" || "$epic_title" == "null" ]] && epic_title="$epic_id"
    [[ -z "$marker_label" || "$marker_label" == "null" ]] && marker_label="consensus-source"
    [[ -z "$output_dir" || "$output_dir" == "null" ]] && output_dir="$CP_DEFAULT_OUTPUT_DIR"
    [[ -z "$phase" || "$phase" == "null" ]] && phase="$CP_DEFAULT_PHASE"
    [[ -z "$version" || "$version" == "null" ]] && version="$CP_DEFAULT_VERSION"
    [[ -z "$synthesis_task" || "$synthesis_task" == "null" ]] && synthesis_task="TXXXX"
    [[ -z "$baseline_files_json" || "$baseline_files_json" == "null" ]] && baseline_files_json="[]"

    local current_date
    current_date=$(_cp_get_date)

    # Replace simple tokens
    template=$(_cp_replace_token "$template" "EPIC_ID" "$epic_id")
    template=$(_cp_replace_token "$template" "EPIC_TITLE" "$epic_title")
    template=$(_cp_replace_token "$template" "MARKER_LABEL" "$marker_label")
    template=$(_cp_replace_token "$template" "OUTPUT_DIR" "$output_dir")
    template=$(_cp_replace_token "$template" "PHASE" "$phase")
    template=$(_cp_replace_token "$template" "VERSION" "$version")
    template=$(_cp_replace_token "$template" "DATE" "$current_date")
    template=$(_cp_replace_token "$template" "BASELINE_SESSION" "$baseline_session")
    template=$(_cp_replace_token "$template" "SYNTHESIS_TASK_ID" "$synthesis_task")

    # Process array tokens
    if command -v jq &>/dev/null; then
        template=$(_cp_process_each_block "$template" "DECISION_QUESTIONS" "$questions_json")
        template=$(_cp_process_each_block "$template" "BASELINE_DECISIONS" "$baseline_decisions_json")
        template=$(_cp_process_each_block "$template" "BASELINE_FILES" "$baseline_files_json")
    fi

    echo "$template"
    return 0
}

# contribution_validate_task - Validate task against contribution schema
#
# Validates that a task follows the contribution protocol requirements.
# Checks structural requirements (parentId, labels, type) and content
# requirements (research outputs, decisions).
#
# Args:
#   $1 = task_id (required) - Task ID to validate
#   $2 = epic_id (optional) - Expected parent epic ID
#   $3 = marker_label (optional) - Expected marker label
#
# Returns: 0 on success, EXIT_NOT_FOUND if task not found
# Output: JSON validation result to stdout
#   {
#     "valid": boolean,
#     "taskId": string,
#     "errors": [{"code": string, "message": string, "field": string}],
#     "warnings": [{"code": string, "message": string, "field": string}],
#     "checkedAt": ISO timestamp
#   }
#
# Example:
#   result=$(contribution_validate_task "T2210" "T2204" "consensus-source")
#   valid=$(echo "$result" | jq -r '.valid')
contribution_validate_task() {
    local task_id="${1:-}"
    local expected_epic="${2:-}"
    local expected_label="${3:-consensus-source}"

    # Validate required argument
    if [[ -z "$task_id" ]]; then
        _cp_error "task_id is required"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # Verify jq is available
    if ! command -v jq &>/dev/null; then
        _cp_error "jq is required for validation"
        return "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    # Verify cleo is available
    if ! command -v cleo &>/dev/null; then
        _cp_error "cleo is required for validation"
        return "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    local errors=()
    local warnings=()
    local checked_at
    checked_at=$(_cp_get_timestamp)

    # Get task data
    local task_json
    task_json=$(cleo show "$task_id" --format json 2>/dev/null)

    if [[ -z "$task_json" || "$task_json" == "null" ]]; then
        # Output JSON error result
        jq -n --arg id "$task_id" --arg ts "$checked_at" '{
            valid: false,
            taskId: $id,
            errors: [{code: "E_TASK_NOT_FOUND", message: "Task not found", field: "taskId"}],
            warnings: [],
            checkedAt: $ts
        }'
        return "${EXIT_NOT_FOUND:-4}"
    fi

    # Extract task fields
    local parent_id task_type labels_json description notes_json
    parent_id=$(echo "$task_json" | jq -r '.task.parentId // ""')
    task_type=$(echo "$task_json" | jq -r '.task.type // "task"')
    labels_json=$(echo "$task_json" | jq -c '.task.labels // []')
    description=$(echo "$task_json" | jq -r '.task.description // ""')
    notes_json=$(echo "$task_json" | jq -c '.task.notes // []')

    # CONTRIB-001: Check parent epic
    if [[ -n "$expected_epic" && "$parent_id" != "$expected_epic" ]]; then
        errors+=("{\"code\":\"CONTRIB-001\",\"message\":\"Task must be child of epic $expected_epic\",\"field\":\"parentId\"}")
    fi

    # CONTRIB-002: Check marker label
    local has_label
    has_label=$(echo "$labels_json" | jq --arg lbl "$expected_label" 'index($lbl) != null')
    if [[ "$has_label" != "true" ]]; then
        errors+=("{\"code\":\"CONTRIB-002\",\"message\":\"Task must have label '$expected_label'\",\"field\":\"labels\"}")
    fi

    # Task type check (should be "task", not epic or subtask)
    if [[ "$task_type" != "task" ]]; then
        warnings+=("{\"code\":\"W_TASK_TYPE\",\"message\":\"Task type should be 'task', got '$task_type'\",\"field\":\"type\"}")
    fi

    # CONTRIB-003: Check for research outputs section in description
    if [[ "$description" != *"## Research Outputs"* && "$description" != *"Research Outputs"* ]]; then
        errors+=("{\"code\":\"CONTRIB-003\",\"message\":\"Description must include 'Research Outputs' section\",\"field\":\"description\"}")
    fi

    # CONTRIB-004: Check for file paths in notes
    local has_file_paths
    has_file_paths=$(echo "$notes_json" | jq '[.[] | select(. | test("claudedocs/|agent-outputs/|research-outputs/|\\.md$"))] | length > 0')
    if [[ "$has_file_paths" != "true" ]]; then
        warnings+=("{\"code\":\"CONTRIB-004\",\"message\":\"Notes should contain file paths for auto-linking\",\"field\":\"notes\"}")
    fi

    # CONTRIB-005: Check for key decisions in description
    if [[ "$description" != *"Decision"* && "$description" != *"decision"* ]]; then
        warnings+=("{\"code\":\"CONTRIB-005\",\"message\":\"Description should document key decisions\",\"field\":\"description\"}")
    fi

    # Build result JSON
    local errors_arr="[]"
    local warnings_arr="[]"

    if [[ ${#errors[@]} -gt 0 ]]; then
        errors_arr=$(printf '%s\n' "${errors[@]}" | jq -s '.')
    fi

    if [[ ${#warnings[@]} -gt 0 ]]; then
        warnings_arr=$(printf '%s\n' "${warnings[@]}" | jq -s '.')
    fi

    local is_valid="true"
    if [[ ${#errors[@]} -gt 0 ]]; then
        is_valid="false"
    fi

    jq -n \
        --argjson valid "$is_valid" \
        --arg id "$task_id" \
        --argjson errors "$errors_arr" \
        --argjson warnings "$warnings_arr" \
        --arg ts "$checked_at" \
        '{
            valid: $valid,
            taskId: $id,
            errors: $errors,
            warnings: $warnings,
            checkedAt: $ts
        }'

    return 0
}

# contribution_get_injection - Get injection block for subagent prompts
#
# Returns a compact (<200 tokens) injection block that can be included
# in subagent prompts to enforce the contribution protocol.
#
# Args:
#   $1 = epic_id (required) - Parent epic task ID
#   $2 = protocol_path (optional) - Path to full protocol document
#   $3 = options_json (optional) - Additional options as JSON
#
# Options JSON fields:
#   markerLabel: string - Label for task discovery
#   outputDir: path - Research output directory
#   baselineSessionId: string - Baseline session identifier
#   taskId: string - Assigned task ID for this contribution
#
# Returns: 0 on success, EXIT_FILE_ERROR if template not found
# Output: Injection block text to stdout (<200 tokens)
#
# Example:
#   injection=$(contribution_get_injection "T2204" "claudedocs/protocol.md")
#   # Include in subagent prompt via Task tool
contribution_get_injection() {
    local epic_id="${1:-}"
    local protocol_path="${2:-}"
    # Note: Use quoted default to avoid Bash 5.3+ brace expansion bug
    local options_json="${3:-'{}'}"

    # Validate required argument
    if [[ -z "$epic_id" ]]; then
        _cp_error "epic_id is required"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # Check injection template exists
    if [[ ! -f "$CP_INJECTION_PATH" ]]; then
        _cp_error "Injection template not found: $CP_INJECTION_PATH"
        return "${EXIT_FILE_ERROR:-3}"
    fi

    # Read injection template
    local injection
    injection=$(cat "$CP_INJECTION_PATH")

    # Extract options with defaults
    local marker_label=""
    local output_dir=""
    local baseline_session=""
    local task_id=""

    if command -v jq &>/dev/null && [[ -n "$options_json" && "$options_json" != "{}" ]]; then
        marker_label=$(echo "$options_json" | jq -r '.markerLabel // ""' 2>/dev/null) || marker_label=""
        output_dir=$(echo "$options_json" | jq -r '.outputDir // ""' 2>/dev/null) || output_dir=""
        baseline_session=$(echo "$options_json" | jq -r '.baselineSessionId // ""' 2>/dev/null) || baseline_session=""
        task_id=$(echo "$options_json" | jq -r '.taskId // ""' 2>/dev/null) || task_id=""
    fi

    # Apply defaults
    [[ -z "$marker_label" || "$marker_label" == "null" ]] && marker_label="consensus-source"
    [[ -z "$output_dir" || "$output_dir" == "null" ]] && output_dir="$CP_DEFAULT_OUTPUT_DIR"
    [[ -z "$baseline_session" || "$baseline_session" == "null" ]] && baseline_session="Session A"
    [[ -z "$task_id" || "$task_id" == "null" ]] && task_id="TXXXX"
    [[ -z "$protocol_path" ]] && protocol_path="claudedocs/contribution-protocol.md"

    # Replace tokens
    injection=$(_cp_replace_token "$injection" "EPIC_ID" "$epic_id")
    injection=$(_cp_replace_token "$injection" "MARKER_LABEL" "$marker_label")
    injection=$(_cp_replace_token "$injection" "OUTPUT_DIR" "$output_dir")
    injection=$(_cp_replace_token "$injection" "BASELINE_SESSION_ID" "$baseline_session")
    injection=$(_cp_replace_token "$injection" "TASK_ID" "$task_id")
    injection=$(_cp_replace_token "$injection" "PROTOCOL_PATH" "$protocol_path")

    echo "$injection"
    return 0
}

# contribution_create_manifest_entry - Create a contribution manifest entry
#
# Creates a JSON entry suitable for appending to a contribution manifest.
#
# Args:
#   $1 = session_id (required) - CLEO session ID
#   $2 = epic_id (required) - Parent epic task ID
#   $3 = task_id (required) - Contribution task ID
#   $4 = agent_id (optional) - Agent identifier (defaults to "unknown")
#
# Returns: 0 on success
# Output: JSON manifest entry to stdout
contribution_create_manifest_entry() {
    local session_id="${1:-}"
    local epic_id="${2:-}"
    local task_id="${3:-}"
    local agent_id="${4:-unknown}"

    # Validate required arguments
    if [[ -z "$session_id" || -z "$epic_id" || -z "$task_id" ]]; then
        _cp_error "session_id, epic_id, and task_id are required"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    if ! command -v jq &>/dev/null; then
        _cp_error "jq is required"
        return "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    local contrib_id created_at
    contrib_id=$(contribution_generate_id)
    created_at=$(_cp_get_timestamp)

    jq -n \
        --arg schema "https://cleo-dev.com/schemas/v1/contribution.schema.json" \
        --arg contrib_id "$contrib_id" \
        --arg created_at "$created_at" \
        --arg agent_id "$agent_id" \
        --arg session_id "$session_id" \
        --arg epic_id "$epic_id" \
        --arg task_id "$task_id" \
        '{
            "$schema": $schema,
            "_meta": {
                "contributionId": $contrib_id,
                "protocolVersion": "1.0.0",
                "createdAt": $created_at,
                "completedAt": null,
                "agentId": $agent_id,
                "checksum": null
            },
            "sessionId": $session_id,
            "epicId": $epic_id,
            "taskId": $task_id,
            "markerLabel": "consensus-source",
            "researchOutputs": [],
            "decisions": [],
            "conflicts": [],
            "status": "draft"
        }'

    return 0
}

# ============================================================================
# CONFLICT DETECTION FUNCTIONS
# ============================================================================

# Generate unique conflict ID
# Format: conflict_{8 hex chars}
# Returns: conflict ID string
_cp_generate_conflict_id() {
    local hex_chars
    if command -v openssl &>/dev/null; then
        hex_chars=$(openssl rand -hex 4)
    elif [[ -r /dev/urandom ]]; then
        hex_chars=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
    else
        # Fallback: use date + PID + random
        hex_chars=$(printf '%08x' $(($(date +%s) ^ $$ ^ RANDOM)))
        hex_chars="${hex_chars:0:8}"
    fi
    echo "conflict_${hex_chars}"
}

# Classify conflict severity based on confidence scores and conflict type
# Args: $1 = confidence1, $2 = confidence2, $3 = conflict_type
# Returns: severity string (critical|high|medium|low)
_cp_classify_severity() {
    local conf1="${1:-0}"
    local conf2="${2:-0}"
    local conflict_type="${3:-contradiction}"

    # Use awk for floating point comparison
    local both_high both_confident confidence_delta

    both_high=$(awk -v c1="$conf1" -v c2="$conf2" 'BEGIN { print (c1 > 0.8 && c2 > 0.8) ? 1 : 0 }')
    both_confident=$(awk -v c1="$conf1" -v c2="$conf2" 'BEGIN { print (c1 > 0.6 && c2 > 0.6) ? 1 : 0 }')
    confidence_delta=$(awk -v c1="$conf1" -v c2="$conf2" 'BEGIN { d = c1 - c2; print (d < 0 ? -d : d) }')
    delta_warn=$(awk -v d="$confidence_delta" 'BEGIN { print (d > 0.3) ? 1 : 0 }')
    low_confidence=$(awk -v c1="$conf1" -v c2="$conf2" 'BEGIN { print (c1 < 0.5 && c2 < 0.5) ? 1 : 0 }')

    # Critical: Evidence conflict OR high-confidence disagreement (both > 0.8)
    if [[ "$conflict_type" == "evidence-conflict" ]] || [[ "$both_high" == "1" ]]; then
        echo "critical"
        return 0
    fi

    # High: Different answers, both confident (> 0.6)
    if [[ "$both_confident" == "1" ]]; then
        echo "high"
        return 0
    fi

    # Low: Minor differences, low confidence
    if [[ "$low_confidence" == "1" ]]; then
        echo "low"
        return 0
    fi

    # Medium: Different answers, mixed confidence (default)
    echo "medium"
    return 0
}

# Detect conflict type based on answer comparison
# Args: $1 = answer1, $2 = answer2
# Returns: conflict type string
_cp_detect_conflict_type() {
    local answer1="$1"
    local answer2="$2"

    # Normalize for comparison
    local norm1 norm2
    norm1=$(echo "$answer1" | tr '[:upper:]' '[:lower:]' | tr -s ' ')
    norm2=$(echo "$answer2" | tr '[:upper:]' '[:lower:]' | tr -s ' ')

    # Exact match - no conflict (should not reach here)
    if [[ "$norm1" == "$norm2" ]]; then
        echo "none"
        return 0
    fi

    # Check for partial overlap (one contains part of the other)
    if [[ "$norm1" == *"$norm2"* ]] || [[ "$norm2" == *"$norm1"* ]]; then
        echo "partial-overlap"
        return 0
    fi

    # Check for scope difference (similar beginning, different conclusion)
    local prefix1 prefix2
    prefix1="${norm1:0:50}"
    prefix2="${norm2:0:50}"
    if [[ "$prefix1" == "$prefix2" ]]; then
        echo "scope-difference"
        return 0
    fi

    # Default: contradiction (mutually exclusive answers)
    echo "contradiction"
    return 0
}

# contribution_compare_decisions - Compare two decisions for conflicts
#
# Compares a decision from the current contribution against a baseline
# decision to detect conflicts.
#
# Args:
#   $1 = decision1 (required) - JSON string of first decision
#   $2 = decision2 (required) - JSON string of second decision (baseline)
#
# Returns: 0 on success, non-zero on error
# Output: JSON object to stdout
#   {
#     "match": boolean,      // true if decisions agree
#     "conflict": {...}      // null if match, conflict object otherwise
#   }
#
# Example:
#   result=$(contribution_compare_decisions "$decision_json" "$baseline_decision_json")
#   has_conflict=$(echo "$result" | jq -r '.match == false')
contribution_compare_decisions() {
    local decision1="${1:-}"
    local decision2="${2:-}"

    # Validate inputs
    if [[ -z "$decision1" || -z "$decision2" ]]; then
        _cp_error "Both decisions are required"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # Verify jq is available
    if ! command -v jq &>/dev/null; then
        _cp_error "jq is required for decision comparison"
        return "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    # Extract fields from both decisions
    local q1 q2 a1 a2 c1 c2 qid1 qid2
    qid1=$(echo "$decision1" | jq -r '.questionId // ""')
    qid2=$(echo "$decision2" | jq -r '.questionId // ""')
    q1=$(echo "$decision1" | jq -r '.question // ""')
    q2=$(echo "$decision2" | jq -r '.question // ""')
    a1=$(echo "$decision1" | jq -r '.answer // ""')
    a2=$(echo "$decision2" | jq -r '.answer // ""')
    c1=$(echo "$decision1" | jq -r '.confidence // 0')
    c2=$(echo "$decision2" | jq -r '.confidence // 0')

    # Verify question IDs match (comparing same question)
    if [[ "$qid1" != "$qid2" ]]; then
        _cp_error "Question IDs do not match: $qid1 vs $qid2"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # Normalize answers for comparison
    local norm_a1 norm_a2
    norm_a1=$(echo "$a1" | tr '[:upper:]' '[:lower:]' | tr -s ' ' | sed 's/^ *//;s/ *$//')
    norm_a2=$(echo "$a2" | tr '[:upper:]' '[:lower:]' | tr -s ' ' | sed 's/^ *//;s/ *$//')

    # Check for match (exact or semantic equivalence)
    if [[ "$norm_a1" == "$norm_a2" ]]; then
        jq -n '{match: true, conflict: null}'
        return 0
    fi

    # Answers differ - generate conflict
    local conflict_type severity conflict_id
    conflict_type=$(_cp_detect_conflict_type "$a1" "$a2")
    severity=$(_cp_classify_severity "$c1" "$c2" "$conflict_type")
    conflict_id=$(_cp_generate_conflict_id)

    # Extract evidence from both decisions
    local evidence1 evidence2
    evidence1=$(echo "$decision1" | jq -c '.evidence // []')
    evidence2=$(echo "$decision2" | jq -c '.evidence // []')

    # Build conflict object
    jq -n \
        --arg qid "$qid1" \
        --arg cid "$conflict_id" \
        --arg severity "$severity" \
        --arg ctype "$conflict_type" \
        --arg pos1 "$a1" \
        --argjson conf1 "$c1" \
        --argjson ev1 "$evidence1" \
        --arg pos2 "$a2" \
        --argjson conf2 "$c2" \
        --argjson ev2 "$evidence2" \
        '{
            match: false,
            conflict: {
                questionId: $qid,
                conflictId: $cid,
                severity: $severity,
                conflictType: $ctype,
                thisSession: {
                    position: $pos1,
                    confidence: $conf1,
                    evidence: $ev1
                },
                otherSession: {
                    position: $pos2,
                    confidence: $conf2,
                    evidence: $ev2
                },
                rationale: null,
                requiresConsensus: ($severity == "critical" or $severity == "high"),
                escalatedToHITL: false
            }
        }'

    return 0
}

# contribution_detect_conflicts - Detect conflicts between two contributions
#
# Compares all decisions in a contribution against a baseline contribution
# to identify conflicts that require resolution.
#
# Args:
#   $1 = contribution_json (required) - JSON string of current contribution
#   $2 = baseline_json (required) - JSON string of baseline contribution
#
# Returns: 0 on success, non-zero on error
# Output: JSON object to stdout with conflicts array and summary
#   {
#     "conflicts": [...],
#     "summary": {
#       "total": N,
#       "critical": N,
#       "high": N,
#       "medium": N,
#       "low": N
#     }
#   }
#
# Algorithm (from CONTRIBUTION-FORMAT-SPEC.md 1.11.1):
#   1. Group decisions by questionId
#   2. Compare answers - exact match = no conflict
#   3. Different answers = potential conflict
#   4. Classify conflict type based on answer structure
#   5. Calculate severity based on confidence differential
#   6. Generate conflict object with both positions and evidence
contribution_detect_conflicts() {
    local contribution_json="${1:-}"
    local baseline_json="${2:-}"

    # Validate inputs
    if [[ -z "$contribution_json" || -z "$baseline_json" ]]; then
        _cp_error "Both contribution and baseline JSON are required"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # Verify jq is available
    if ! command -v jq &>/dev/null; then
        _cp_error "jq is required for conflict detection"
        return "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    # Extract session info for conflict context
    local this_session_id this_task_id baseline_session_id baseline_task_id baseline_contrib_id
    this_session_id=$(echo "$contribution_json" | jq -r '.sessionId // ""')
    this_task_id=$(echo "$contribution_json" | jq -r '.taskId // ""')
    baseline_session_id=$(echo "$baseline_json" | jq -r '.sessionId // ""')
    baseline_task_id=$(echo "$baseline_json" | jq -r '.taskId // ""')
    baseline_contrib_id=$(echo "$baseline_json" | jq -r '._meta.contributionId // ""')
    baseline_session_label=$(echo "$baseline_json" | jq -r '.sessionLabel // "Baseline"')

    # Extract decisions arrays
    local this_decisions baseline_decisions
    this_decisions=$(echo "$contribution_json" | jq -c '.decisions // []')
    baseline_decisions=$(echo "$baseline_json" | jq -c '.decisions // []')

    # Get count of decisions in each
    local this_count baseline_count
    this_count=$(echo "$this_decisions" | jq 'length')
    baseline_count=$(echo "$baseline_decisions" | jq 'length')

    # Initialize conflict tracking
    local conflicts_json="[]"
    local critical_count=0 high_count=0 medium_count=0 low_count=0

    # Process each decision in current contribution
    local i=0
    while [[ $i -lt $this_count ]]; do
        local this_decision this_qid
        this_decision=$(echo "$this_decisions" | jq -c ".[$i]")
        this_qid=$(echo "$this_decision" | jq -r '.questionId')

        # Find matching decision in baseline by questionId
        local baseline_decision
        baseline_decision=$(echo "$baseline_decisions" | jq -c --arg qid "$this_qid" '.[] | select(.questionId == $qid)' 2>/dev/null)

        if [[ -n "$baseline_decision" && "$baseline_decision" != "null" && "$baseline_decision" != "" ]]; then
            # Found matching question - compare decisions
            local comparison
            comparison=$(contribution_compare_decisions "$this_decision" "$baseline_decision")

            local is_match
            is_match=$(echo "$comparison" | jq -r '.match')

            if [[ "$is_match" == "false" ]]; then
                # Extract conflict and augment with session info
                local conflict
                conflict=$(echo "$comparison" | jq -c --arg sid "$baseline_session_id" \
                    --arg slbl "$baseline_session_label" \
                    --arg cid "$baseline_contrib_id" \
                    '.conflict | .otherSession += {sessionId: $sid, sessionLabel: $slbl, contributionId: $cid}')

                # Increment severity counters
                local severity
                severity=$(echo "$conflict" | jq -r '.severity')
                case "$severity" in
                    critical) ((critical_count++)) ;;
                    high) ((high_count++)) ;;
                    medium) ((medium_count++)) ;;
                    low) ((low_count++)) ;;
                esac

                # Append to conflicts array
                conflicts_json=$(echo "$conflicts_json" | jq --argjson c "$conflict" '. + [$c]')
            fi
        fi
        # Note: Missing decision in baseline = INCOMPLETE (not detected here as conflict)
        # That's a different validation concern handled by CONTRIB-005

        ((i++))
    done

    # Calculate total
    local total_count=$((critical_count + high_count + medium_count + low_count))

    # Build final result
    jq -n \
        --argjson conflicts "$conflicts_json" \
        --argjson total "$total_count" \
        --argjson critical "$critical_count" \
        --argjson high "$high_count" \
        --argjson medium "$medium_count" \
        --argjson low "$low_count" \
        '{
            conflicts: $conflicts,
            summary: {
                total: $total,
                critical: $critical,
                high: $high,
                medium: $medium,
                low: $low
            }
        }'

    return 0
}

# contribution_aggregate_conflicts - Aggregate conflicts across all contributions for an epic
#
# Collects all contributions for an epic from the manifest and builds
# a conflict matrix showing disagreements across sessions.
#
# Args:
#   $1 = epic_id (required) - Epic task ID to aggregate conflicts for
#   $2 = manifest_path (optional) - Path to contributions manifest
#                                   Defaults to .cleo/contributions/CONTRIBUTIONS.jsonl
#
# Returns: 0 on success, non-zero on error
# Output: JSON conflict matrix to stdout
#   {
#     "epicId": "T2308",
#     "contributionCount": N,
#     "questionIds": ["Q001", "Q002", ...],
#     "conflictMatrix": [
#       {
#         "questionId": "Q001",
#         "positions": [
#           {"sessionId": "...", "answer": "X", "confidence": 0.85},
#           {"sessionId": "...", "answer": "Y", "confidence": 0.78}
#         ],
#         "hasConflict": true,
#         "conflictSeverity": "high"
#       }
#     ],
#     "aggregateSummary": {
#       "totalQuestions": N,
#       "questionsWithConflict": N,
#       "consensusReached": N,
#       "bySevertity": {"critical": N, "high": N, "medium": N, "low": N}
#     }
#   }
contribution_aggregate_conflicts() {
    local epic_id="${1:-}"
    local manifest_path="${2:-.cleo/contributions/CONTRIBUTIONS.jsonl}"

    # Validate required argument
    if [[ -z "$epic_id" ]]; then
        _cp_error "epic_id is required"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # Verify jq is available
    if ! command -v jq &>/dev/null; then
        _cp_error "jq is required for conflict aggregation"
        return "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    # Check manifest exists
    if [[ ! -f "$manifest_path" ]]; then
        _cp_warn "Manifest not found: $manifest_path"
        # Return empty result
        jq -n --arg eid "$epic_id" '{
            epicId: $eid,
            contributionCount: 0,
            questionIds: [],
            conflictMatrix: [],
            aggregateSummary: {
                totalQuestions: 0,
                questionsWithConflict: 0,
                consensusReached: 0,
                bySeverity: {critical: 0, high: 0, medium: 0, low: 0}
            }
        }'
        return 0
    fi

    # Find all complete contributions for this epic
    local contrib_entries
    contrib_entries=$(jq -sc --arg eid "$epic_id" '[.[] | select(.epicId == $eid and .status == "complete")]' "$manifest_path" 2>/dev/null)

    local contrib_count
    contrib_count=$(echo "$contrib_entries" | jq 'length')

    if [[ "$contrib_count" == "0" || "$contrib_count" == "null" ]]; then
        jq -n --arg eid "$epic_id" '{
            epicId: $eid,
            contributionCount: 0,
            questionIds: [],
            conflictMatrix: [],
            aggregateSummary: {
                totalQuestions: 0,
                questionsWithConflict: 0,
                consensusReached: 0,
                bySeverity: {critical: 0, high: 0, medium: 0, low: 0}
            }
        }'
        return 0
    fi

    # Load all contribution files and extract decisions
    local all_decisions="[]"
    local question_ids="[]"
    local i=0

    while [[ $i -lt $contrib_count ]]; do
        local entry file_path session_id
        entry=$(echo "$contrib_entries" | jq -c ".[$i]")
        file_path=$(echo "$entry" | jq -r '.filePath')
        session_id=$(echo "$entry" | jq -r '.sessionId')

        if [[ -f "$file_path" ]]; then
            local contrib_data decisions
            contrib_data=$(cat "$file_path")
            decisions=$(echo "$contrib_data" | jq -c --arg sid "$session_id" \
                '.decisions[] | {questionId, answer, confidence, sessionId: $sid}')

            # Append decisions with session context
            while IFS= read -r dec; do
                all_decisions=$(echo "$all_decisions" | jq --argjson d "$dec" '. + [$d]')

                # Track unique question IDs
                local qid
                qid=$(echo "$dec" | jq -r '.questionId')
                question_ids=$(echo "$question_ids" | jq --arg q "$qid" 'if index($q) then . else . + [$q] end')
            done < <(echo "$decisions")
        fi

        ((i++))
    done

    # Build conflict matrix by grouping decisions per question
    local conflict_matrix="[]"
    local questions_with_conflict=0
    local consensus_reached=0
    local critical_count=0 high_count=0 medium_count=0 low_count=0

    local q_count
    q_count=$(echo "$question_ids" | jq 'length')
    local q=0

    while [[ $q -lt $q_count ]]; do
        local qid positions
        qid=$(echo "$question_ids" | jq -r ".[$q]")

        # Get all positions for this question
        positions=$(echo "$all_decisions" | jq -c --arg qid "$qid" \
            '[.[] | select(.questionId == $qid) | {sessionId, answer, confidence}]')

        local position_count
        position_count=$(echo "$positions" | jq 'length')

        # Check for conflict (different answers)
        local unique_answers has_conflict conflict_severity
        unique_answers=$(echo "$positions" | jq '[.[].answer] | unique | length')

        if [[ "$unique_answers" -gt 1 ]]; then
            has_conflict=true
            ((questions_with_conflict++))

            # Calculate severity based on confidence scores
            local max_conf1 max_conf2
            max_conf1=$(echo "$positions" | jq '[.[].confidence] | sort | reverse | .[0] // 0')
            max_conf2=$(echo "$positions" | jq '[.[].confidence] | sort | reverse | .[1] // 0')

            conflict_severity=$(_cp_classify_severity "$max_conf1" "$max_conf2" "contradiction")

            case "$conflict_severity" in
                critical) ((critical_count++)) ;;
                high) ((high_count++)) ;;
                medium) ((medium_count++)) ;;
                low) ((low_count++)) ;;
            esac
        else
            has_conflict=false
            conflict_severity="none"
            ((consensus_reached++))
        fi

        # Add to matrix
        conflict_matrix=$(echo "$conflict_matrix" | jq \
            --arg qid "$qid" \
            --argjson positions "$positions" \
            --argjson hasConflict "$has_conflict" \
            --arg severity "$conflict_severity" \
            '. + [{
                questionId: $qid,
                positions: $positions,
                hasConflict: $hasConflict,
                conflictSeverity: $severity
            }]')

        ((q++))
    done

    # Build final aggregation result
    jq -n \
        --arg eid "$epic_id" \
        --argjson count "$contrib_count" \
        --argjson qids "$question_ids" \
        --argjson matrix "$conflict_matrix" \
        --argjson totalQ "$q_count" \
        --argjson conflictQ "$questions_with_conflict" \
        --argjson consensusQ "$consensus_reached" \
        --argjson crit "$critical_count" \
        --argjson high "$high_count" \
        --argjson med "$medium_count" \
        --argjson low "$low_count" \
        '{
            epicId: $eid,
            contributionCount: $count,
            questionIds: $qids,
            conflictMatrix: $matrix,
            aggregateSummary: {
                totalQuestions: $totalQ,
                questionsWithConflict: $conflictQ,
                consensusReached: $consensusQ,
                bySeverity: {
                    critical: $crit,
                    high: $high,
                    medium: $med,
                    low: $low
                }
            }
        }'

    return 0
}

# ============================================================================
# CONSENSUS AGGREGATION FUNCTIONS
# ============================================================================

# contribution_weighted_vote - Compute weighted vote for a single question
#
# Performs confidence-weighted voting across multiple session decisions
# for a single question to determine consensus.
#
# Args:
#   $1 = decisions_json (required) - JSON array of decision objects
#        Each object must have: {sessionId, answer, confidence}
#
# Returns: 0 on success, non-zero on error
# Output: JSON vote result to stdout
#   {
#     "questionId": "Q001",
#     "winner": "chosen answer",
#     "confidence": 0.85,
#     "votingResult": "unanimous|majority|split",
#     "totalWeight": 2.5,
#     "votes": [
#       {"sessionId": "...", "answer": "X", "confidence": 0.85, "weight": 0.85},
#       ...
#     ],
#     "answerBreakdown": [
#       {"answer": "X", "totalWeight": 1.7, "percentage": 0.68, "sessions": ["...", "..."]},
#       ...
#     ]
#   }
#
# Algorithm (from CONTRIBUTION-FORMAT-SPEC.md 1.11.2):
#   1. Group votes by normalized answer
#   2. Sum confidence weights for each answer
#   3. Calculate percentage: support[answer] / total_support
#   4. Classify result:
#      - Unanimous: All sessions agree (100%)
#      - Majority: >50% agreement (weighted)
#      - Split: No majority (<= 50%)
contribution_weighted_vote() {
    local decisions_json="${1:-}"
    local question_id="${2:-}"

    # Validate inputs
    if [[ -z "$decisions_json" ]]; then
        _cp_error "decisions_json is required"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # Verify jq is available
    if ! command -v jq &>/dev/null; then
        _cp_error "jq is required for weighted voting"
        return "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    # Validate JSON array
    local vote_count
    vote_count=$(echo "$decisions_json" | jq 'length' 2>/dev/null)
    if [[ -z "$vote_count" || "$vote_count" == "null" ]]; then
        _cp_error "Invalid decisions JSON array"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # Handle empty array
    if [[ "$vote_count" == "0" ]]; then
        jq -n --arg qid "$question_id" '{
            questionId: $qid,
            winner: null,
            confidence: 0,
            votingResult: "no-votes",
            totalWeight: 0,
            votes: [],
            answerBreakdown: []
        }'
        return 0
    fi

    # Handle single vote (automatic unanimous)
    if [[ "$vote_count" == "1" ]]; then
        local single_answer single_conf single_sid
        single_answer=$(echo "$decisions_json" | jq -r '.[0].answer')
        single_conf=$(echo "$decisions_json" | jq -r '.[0].confidence // 0.5')
        single_sid=$(echo "$decisions_json" | jq -r '.[0].sessionId // "unknown"')

        jq -n \
            --arg qid "$question_id" \
            --arg winner "$single_answer" \
            --argjson conf "$single_conf" \
            --arg sid "$single_sid" \
            '{
                questionId: $qid,
                winner: $winner,
                confidence: $conf,
                votingResult: "unanimous",
                totalWeight: $conf,
                votes: [{sessionId: $sid, answer: $winner, confidence: $conf, weight: $conf}],
                answerBreakdown: [{answer: $winner, totalWeight: $conf, percentage: 1.0, sessions: [$sid]}]
            }'
        return 0
    fi

    # Process votes: normalize answers and calculate weights
    # Use jq to do all the heavy lifting
    echo "$decisions_json" | jq --arg qid "$question_id" '
        # Normalize answer for grouping (lowercase, trimmed)
        def normalize: . | ascii_downcase | gsub("^\\s+|\\s+$"; "") | gsub("\\s+"; " ");

        # Build votes with weights
        [.[] | {
            sessionId: (.sessionId // "unknown"),
            answer: .answer,
            normalizedAnswer: (.answer | normalize),
            confidence: (.confidence // 0.5),
            weight: (.confidence // 0.5)
        }] as $votes |

        # Calculate total weight
        ($votes | map(.weight) | add) as $totalWeight |

        # Group by normalized answer and calculate breakdown
        ($votes | group_by(.normalizedAnswer) | map({
            answer: .[0].answer,
            normalizedAnswer: .[0].normalizedAnswer,
            totalWeight: (map(.weight) | add),
            sessionCount: length,
            sessions: [.[].sessionId]
        }) | map(. + {percentage: (.totalWeight / $totalWeight)})) as $breakdown |

        # Sort breakdown by weight descending
        ($breakdown | sort_by(-.totalWeight)) as $sortedBreakdown |

        # Determine winner
        $sortedBreakdown[0] as $topAnswer |

        # Determine voting result
        (if ($sortedBreakdown | length) == 1 then
            "unanimous"
        elif $topAnswer.percentage > 0.5 then
            "majority"
        else
            "split"
        end) as $votingResult |

        # Calculate result confidence
        # For unanimous/majority: use weighted average confidence of winning votes
        # For split: use top answer percentage as confidence indicator
        (if $votingResult == "split" then
            $topAnswer.percentage
        else
            ($votes | map(select(.normalizedAnswer == $topAnswer.normalizedAnswer)) |
             (map(.confidence * .weight) | add) / (map(.weight) | add))
        end) as $resultConfidence |

        # Build output
        {
            questionId: $qid,
            winner: $topAnswer.answer,
            confidence: $resultConfidence,
            votingResult: $votingResult,
            totalWeight: $totalWeight,
            votes: ($votes | map({sessionId, answer, confidence, weight})),
            answerBreakdown: ($sortedBreakdown | map({
                answer,
                totalWeight,
                percentage,
                sessions
            }))
        }
    '

    return 0
}

# contribution_compute_consensus - Compute consensus from all contributions for an epic
#
# Aggregates all complete contributions for an epic and computes
# consensus decisions using weighted voting.
#
# Args:
#   $1 = epic_id (required) - Epic task ID to compute consensus for
#   $2 = manifest_path (optional) - Path to contributions manifest
#                                   Defaults to .cleo/contributions/CONTRIBUTIONS.jsonl
#
# Returns: 0 on success, non-zero on error
# Output: JSON consensus object to stdout
#   {
#     "consensus": {
#       "epicId": "T2204",
#       "computedAt": "ISO-timestamp",
#       "contributionCount": 3,
#       "decisions": [
#         {
#           "questionId": "Q001",
#           "answer": "chosen answer",
#           "confidence": 0.92,
#           "votingResult": "unanimous|majority|split",
#           "supportingSessions": ["session-a", "session-b"],
#           "dissenting": []
#         }
#       ],
#       "unresolved": [
#         {
#           "questionId": "Q002",
#           "reason": "split vote - no majority",
#           "positions": [...]
#         }
#       ],
#       "hitlRequired": true,
#       "summary": {
#         "totalQuestions": 10,
#         "resolved": 8,
#         "unresolved": 2,
#         "averageConfidence": 0.85
#       }
#     }
#   }
#
# Algorithm:
#   1. Load all complete contributions for the epic
#   2. Group decisions by questionId across all contributions
#   3. For each question, run weighted voting
#   4. Classify results: unanimous/majority = resolved, split = unresolved
#   5. Flag unresolved questions for HITL review
contribution_compute_consensus() {
    local epic_id="${1:-}"
    local manifest_path="${2:-.cleo/contributions/CONTRIBUTIONS.jsonl}"

    # Validate required argument
    if [[ -z "$epic_id" ]]; then
        _cp_error "epic_id is required"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # Verify jq is available
    if ! command -v jq &>/dev/null; then
        _cp_error "jq is required for consensus computation"
        return "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    local computed_at
    computed_at=$(_cp_get_timestamp)

    # Check manifest exists
    if [[ ! -f "$manifest_path" ]]; then
        _cp_warn "Manifest not found: $manifest_path"
        # Return empty consensus
        jq -n --arg eid "$epic_id" --arg ts "$computed_at" '{
            consensus: {
                epicId: $eid,
                computedAt: $ts,
                contributionCount: 0,
                decisions: [],
                unresolved: [],
                hitlRequired: false,
                summary: {
                    totalQuestions: 0,
                    resolved: 0,
                    unresolved: 0,
                    averageConfidence: 0
                }
            }
        }'
        return 0
    fi

    # Find all complete contributions for this epic
    local contrib_entries
    contrib_entries=$(jq -sc --arg eid "$epic_id" '[.[] | select(.epicId == $eid and .status == "complete")]' "$manifest_path" 2>/dev/null)

    local contrib_count
    contrib_count=$(echo "$contrib_entries" | jq 'length')

    if [[ "$contrib_count" == "0" || "$contrib_count" == "null" ]]; then
        jq -n --arg eid "$epic_id" --arg ts "$computed_at" '{
            consensus: {
                epicId: $eid,
                computedAt: $ts,
                contributionCount: 0,
                decisions: [],
                unresolved: [],
                hitlRequired: false,
                summary: {
                    totalQuestions: 0,
                    resolved: 0,
                    unresolved: 0,
                    averageConfidence: 0
                }
            }
        }'
        return 0
    fi

    # Load all contribution files and collect decisions
    local all_decisions="[]"
    local question_ids="[]"
    local i=0

    while [[ $i -lt $contrib_count ]]; do
        local entry file_path session_id
        entry=$(echo "$contrib_entries" | jq -c ".[$i]")
        file_path=$(echo "$entry" | jq -r '.filePath')
        session_id=$(echo "$entry" | jq -r '.sessionId')

        if [[ -f "$file_path" ]]; then
            local contrib_data
            contrib_data=$(cat "$file_path")

            # Extract decisions with session context
            local decisions
            decisions=$(echo "$contrib_data" | jq -c --arg sid "$session_id" \
                '[.decisions[] | {
                    questionId,
                    question,
                    answer,
                    confidence,
                    rationale,
                    evidence,
                    sessionId: $sid
                }]')

            # Merge decisions
            all_decisions=$(echo "$all_decisions" "$decisions" | jq -s 'add')

            # Track unique question IDs
            local file_qids
            file_qids=$(echo "$decisions" | jq -c '[.[].questionId] | unique')
            question_ids=$(echo "$question_ids" "$file_qids" | jq -s 'add | unique')
        fi

        ((i++))
    done

    # Compute consensus for each question
    local consensus_decisions="[]"
    local unresolved="[]"
    local resolved_count=0
    local unresolved_count=0
    local total_confidence=0

    local q_count
    q_count=$(echo "$question_ids" | jq 'length')
    local q=0

    while [[ $q -lt $q_count ]]; do
        local qid
        qid=$(echo "$question_ids" | jq -r ".[$q]")

        # Get all decisions for this question
        local question_decisions
        question_decisions=$(echo "$all_decisions" | jq -c --arg qid "$qid" \
            '[.[] | select(.questionId == $qid)]')

        # Get question text from first decision
        local question_text
        question_text=$(echo "$question_decisions" | jq -r '.[0].question // ""')

        # Run weighted vote
        local vote_result
        vote_result=$(contribution_weighted_vote "$question_decisions" "$qid")

        local voting_result winner confidence
        voting_result=$(echo "$vote_result" | jq -r '.votingResult')
        winner=$(echo "$vote_result" | jq -r '.winner')
        confidence=$(echo "$vote_result" | jq -r '.confidence')

        if [[ "$voting_result" == "unanimous" || "$voting_result" == "majority" ]]; then
            # Resolved - add to consensus decisions
            local supporting dissenting
            supporting=$(echo "$vote_result" | jq -c '.answerBreakdown[0].sessions')
            dissenting=$(echo "$vote_result" | jq -c '[.answerBreakdown[1:]? | .[]? | .sessions[]?] // []')

            local decision_entry
            decision_entry=$(jq -n \
                --arg qid "$qid" \
                --arg q "$question_text" \
                --arg answer "$winner" \
                --argjson conf "$confidence" \
                --arg result "$voting_result" \
                --argjson supporting "$supporting" \
                --argjson dissenting "$dissenting" \
                '{
                    questionId: $qid,
                    question: $q,
                    answer: $answer,
                    confidence: $conf,
                    votingResult: $result,
                    supportingSessions: $supporting,
                    dissenting: $dissenting
                }')

            consensus_decisions=$(echo "$consensus_decisions" | jq --argjson d "$decision_entry" '. + [$d]')
            ((resolved_count++))
            total_confidence=$(awk -v tc="$total_confidence" -v c="$confidence" 'BEGIN { print tc + c }')
        else
            # Unresolved (split vote) - add to unresolved list
            local positions
            positions=$(echo "$vote_result" | jq -c '.answerBreakdown')

            local unresolved_entry
            unresolved_entry=$(jq -n \
                --arg qid "$qid" \
                --arg q "$question_text" \
                --arg reason "split vote - no majority" \
                --argjson positions "$positions" \
                --argjson voteDetails "$vote_result" \
                '{
                    questionId: $qid,
                    question: $q,
                    reason: $reason,
                    positions: $positions,
                    voteDetails: $voteDetails
                }')

            unresolved=$(echo "$unresolved" | jq --argjson u "$unresolved_entry" '. + [$u]')
            ((unresolved_count++))
        fi

        ((q++))
    done

    # Calculate average confidence for resolved questions
    local avg_confidence=0
    if [[ $resolved_count -gt 0 ]]; then
        avg_confidence=$(awk -v tc="$total_confidence" -v rc="$resolved_count" 'BEGIN { printf "%.4f", tc / rc }')
    fi

    # Determine if HITL is required
    local hitl_required="false"
    if [[ $unresolved_count -gt 0 ]]; then
        hitl_required="true"
    fi

    # Build final consensus result
    jq -n \
        --arg eid "$epic_id" \
        --arg ts "$computed_at" \
        --argjson count "$contrib_count" \
        --argjson decisions "$consensus_decisions" \
        --argjson unresolved "$unresolved" \
        --argjson hitl "$hitl_required" \
        --argjson totalQ "$q_count" \
        --argjson resolvedQ "$resolved_count" \
        --argjson unresolvedQ "$unresolved_count" \
        --argjson avgConf "$avg_confidence" \
        '{
            consensus: {
                epicId: $eid,
                computedAt: $ts,
                contributionCount: $count,
                decisions: $decisions,
                unresolved: $unresolved,
                hitlRequired: $hitl,
                summary: {
                    totalQuestions: $totalQ,
                    resolved: $resolvedQ,
                    unresolved: $unresolvedQ,
                    averageConfidence: $avgConf
                }
            }
        }'

    return 0
}

# contribution_generate_synthesis - Generate unified synthesis document from consensus
#
# Creates a Markdown synthesis document from computed consensus,
# documenting resolved decisions, unresolved questions, and
# recommendations for human review.
#
# Args:
#   $1 = epic_id (required) - Epic task ID
#   $2 = consensus_json (optional) - Pre-computed consensus JSON
#        If not provided, will call contribution_compute_consensus
#   $3 = options_json (optional) - Generation options
#        {
#          "includeEvidence": boolean (default true),
#          "includeVotingDetails": boolean (default false),
#          "outputFormat": "markdown|json" (default "markdown")
#        }
#
# Returns: 0 on success, non-zero on error
# Output: Markdown synthesis document to stdout
contribution_generate_synthesis() {
    local epic_id="${1:-}"
    local consensus_json="${2:-}"
    # Note: Use quoted default to avoid Bash 5.3+ brace expansion bug
    local options_json="${3:-'{}'}"

    # Validate required argument
    if [[ -z "$epic_id" ]]; then
        _cp_error "epic_id is required"
        return "${EXIT_INVALID_INPUT:-2}"
    fi

    # Verify jq is available
    if ! command -v jq &>/dev/null; then
        _cp_error "jq is required for synthesis generation"
        return "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    # Compute consensus if not provided
    if [[ -z "$consensus_json" || "$consensus_json" == "{}" ]]; then
        consensus_json=$(contribution_compute_consensus "$epic_id")
    fi

    # Extract options with defaults
    local include_evidence include_voting output_format
    include_evidence=$(echo "$options_json" | jq -r '.includeEvidence // true')
    include_voting=$(echo "$options_json" | jq -r '.includeVotingDetails // false')
    output_format=$(echo "$options_json" | jq -r '.outputFormat // "markdown"')

    # Extract consensus data
    local computed_at contrib_count
    local total_q resolved_q unresolved_q avg_conf hitl_required
    computed_at=$(echo "$consensus_json" | jq -r '.consensus.computedAt')
    contrib_count=$(echo "$consensus_json" | jq -r '.consensus.contributionCount')
    total_q=$(echo "$consensus_json" | jq -r '.consensus.summary.totalQuestions')
    resolved_q=$(echo "$consensus_json" | jq -r '.consensus.summary.resolved')
    unresolved_q=$(echo "$consensus_json" | jq -r '.consensus.summary.unresolved')
    avg_conf=$(echo "$consensus_json" | jq -r '.consensus.summary.averageConfidence')
    hitl_required=$(echo "$consensus_json" | jq -r '.consensus.hitlRequired')

    # Format average confidence as percentage
    local avg_conf_pct
    avg_conf_pct=$(awk -v ac="$avg_conf" 'BEGIN { printf "%.1f", ac * 100 }')

    # Generate Markdown document
    local synthesis=""

    synthesis+="# Consensus Synthesis: ${epic_id}

**Generated**: ${computed_at}
**Contributions**: ${contrib_count} complete sessions
**Questions Analyzed**: ${total_q}

## Summary

| Metric | Value |
|--------|-------|
| Resolved Decisions | ${resolved_q} |
| Unresolved (Split) | ${unresolved_q} |
| Average Confidence | ${avg_conf_pct}% |
| HITL Required | ${hitl_required} |

---

## Resolved Decisions

"

    # Add resolved decisions
    local decisions_count
    decisions_count=$(echo "$consensus_json" | jq '.consensus.decisions | length')

    if [[ "$decisions_count" == "0" ]]; then
        synthesis+="_No resolved decisions._

"
    else
        local d=0
        while [[ $d -lt $decisions_count ]]; do
            local decision qid question answer confidence voting_result supporting
            decision=$(echo "$consensus_json" | jq -c ".consensus.decisions[$d]")
            qid=$(echo "$decision" | jq -r '.questionId')
            question=$(echo "$decision" | jq -r '.question')
            answer=$(echo "$decision" | jq -r '.answer')
            confidence=$(echo "$decision" | jq -r '.confidence')
            voting_result=$(echo "$decision" | jq -r '.votingResult')
            supporting=$(echo "$decision" | jq -r '.supportingSessions | join(", ")')

            local conf_pct
            conf_pct=$(awk -v c="$confidence" 'BEGIN { printf "%.0f", c * 100 }')

            synthesis+="### ${qid}: ${question}

**Answer**: ${answer}

- **Voting Result**: ${voting_result}
- **Confidence**: ${conf_pct}%
- **Supporting Sessions**: ${supporting}

"
            ((d++))
        done
    fi

    synthesis+="---

## Unresolved Questions (Requires HITL)

"

    # Add unresolved questions
    local unresolved_count
    unresolved_count=$(echo "$consensus_json" | jq '.consensus.unresolved | length')

    if [[ "$unresolved_count" == "0" ]]; then
        synthesis+="_All questions resolved through consensus._

"
    else
        local u=0
        while [[ $u -lt $unresolved_count ]]; do
            local unresolved_item qid question reason positions
            unresolved_item=$(echo "$consensus_json" | jq -c ".consensus.unresolved[$u]")
            qid=$(echo "$unresolved_item" | jq -r '.questionId')
            question=$(echo "$unresolved_item" | jq -r '.question')
            reason=$(echo "$unresolved_item" | jq -r '.reason')
            positions=$(echo "$unresolved_item" | jq -c '.positions')

            synthesis+="### ${qid}: ${question}

**Status**: UNRESOLVED - ${reason}

**Competing Positions**:

"
            # List positions
            local pos_count
            pos_count=$(echo "$positions" | jq 'length')
            local p=0
            while [[ $p -lt $pos_count ]]; do
                local pos_answer pos_weight pos_pct pos_sessions
                pos_answer=$(echo "$positions" | jq -r ".[$p].answer")
                pos_weight=$(echo "$positions" | jq -r ".[$p].totalWeight")
                pos_pct=$(echo "$positions" | jq -r ".[$p].percentage")
                pos_sessions=$(echo "$positions" | jq -r ".[$p].sessions | join(\", \")")

                local pct_fmt
                pct_fmt=$(awk -v pp="$pos_pct" 'BEGIN { printf "%.0f", pp * 100 }')

                synthesis+="- **${pos_answer}** (${pct_fmt}% weighted support)
  - Sessions: ${pos_sessions}

"
                ((p++))
            done

            ((u++))
        done

        synthesis+="---

## Recommended Actions

1. Review unresolved questions above
2. Provide human decision for split votes
3. Document rationale for HITL decisions
4. Re-run synthesis after resolution

"
    fi

    synthesis+="---

_Generated by CLEO Contribution Protocol v2.0_
"

    echo "$synthesis"
    return 0
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f contribution_protocol_instantiate
export -f contribution_validate_task
export -f contribution_get_injection
export -f contribution_generate_id
export -f contribution_create_manifest_entry
export -f contribution_compare_decisions
export -f contribution_detect_conflicts
export -f contribution_aggregate_conflicts
export -f contribution_weighted_vote
export -f contribution_compute_consensus
export -f contribution_generate_synthesis
