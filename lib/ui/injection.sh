#!/usr/bin/env bash
# lib/ui/injection.sh - Injection operations (Layer 2)

[[ -n "${_INJECTION_LOADED:-}" ]] && return 0
readonly _INJECTION_LOADED=1

# Dependencies
source "${CLEO_LIB_DIR:-$CLEO_HOME/lib}/injection-registry.sh"
source "${CLEO_LIB_DIR:-$CLEO_HOME/lib}/injection-config.sh"
source "${CLEO_LIB_DIR:-$CLEO_HOME/lib}/exit-codes.sh"

# ==============================================================================
# INJECTION OPERATIONS
# ==============================================================================

# Update or add injection to target file
# Args: target_file [--dry-run]
# Returns: 0 on success, exit code on failure
# Output: JSON with action taken
injection_update() {
    local target="$1"
    local dry_run="${2:-}"

    # Validate target
    if ! injection_is_valid_target "$target"; then
        echo "{\"error\":\"Invalid target\",\"target\":\"$target\",\"validTargets\":\"$INJECTION_TARGETS\"}" >&2
        return "$EXIT_INVALID_INPUT"
    fi

    local template_path header_path action
    template_path=$(injection_get_template_path)
    header_path=$(injection_get_header_path "$target")

    # Build injection content
    local content=""
    if [[ -n "$header_path" ]] && [[ -f "$header_path" ]]; then
        content=$(cat "$header_path")
        content+=$'\n'
    fi
    content+=$(cat "$template_path")

    # Determine action
    if [[ ! -f "$target" ]]; then
        action="created"
    elif injection_has_block "$target"; then
        action="updated"
    else
        action="added"
    fi

    if [[ "$dry_run" == "--dry-run" ]]; then
        echo "{\"action\":\"$action\",\"target\":\"$target\",\"dryRun\":true}"
        return 0
    fi

    # Perform injection (implementation details in injection_apply)
    injection_apply "$target" "$content" "$action"
}

# Check injection status for a target file
# Args: target_file
# Returns: JSON with status
# Validates block content matches expected @-reference format
injection_check() {
    local target="$1"
    local status

    if [[ ! -f "$target" ]]; then
        echo "{\"target\":\"$target\",\"status\":\"missing\",\"fileExists\":false}"
        return 0
    fi

    if ! injection_has_block "$target"; then
        echo "{\"target\":\"$target\",\"status\":\"none\",\"fileExists\":true}"
        return 0
    fi

    # Block exists - validate content matches expected @-reference
    local expected_reference="@.cleo/templates/AGENT-INJECTION.md"
    local block_content

    # Extract block content between markers (excluding markers themselves)
    block_content=$(awk "
        /${INJECTION_MARKER_START//\//\\/}/ { found = 1; next }
        /${INJECTION_MARKER_END//\//\\/}/ { found = 0; next }
        found { print }
    " "$target" | tr -d '[:space:]')

    # Expected content (normalized - no whitespace)
    local expected_normalized
    expected_normalized=$(echo "$expected_reference" | tr -d '[:space:]')

    if [[ "$block_content" == "$expected_normalized" ]]; then
        status="current"
    else
        status="outdated"
    fi

    echo "{\"target\":\"$target\",\"status\":\"$status\",\"fileExists\":true}"
}

# Check all targets and return combined status
# Returns: JSON array of all target statuses (including missing files)
injection_check_all() {
    local results=()
    local target

    injection_get_targets
    for target in "${REPLY[@]}"; do
        # Check ALL targets - injection_check handles missing files correctly
        results+=("$(injection_check "$target")")
    done

    printf '[%s]' "$(IFS=,; echo "${results[*]}")"
}

# Apply injection content to file (internal)
# Args: target content action
# Note: content param is unused - we inject @-reference instead of full content
injection_apply() {
    local target="$1"
    local content="$2"  # Unused - kept for backward compatibility
    local action="$3"
    local temp_file

    # Reference to template (relative to project root)
    local reference="@.cleo/templates/AGENT-INJECTION.md"

    # No version in markers - content is external, always current
    temp_file=$(mktemp)
    trap "rm -f '$temp_file'" RETURN

    case "$action" in
        created)
            # Wrap reference in markers (no version)
            echo "${INJECTION_MARKER_START} -->" > "$temp_file"
            echo "$reference" >> "$temp_file"
            echo "$INJECTION_MARKER_END" >> "$temp_file"
            ;;
        added)
            # Wrap reference in markers before prepending to existing file
            echo "${INJECTION_MARKER_START} -->" > "$temp_file"
            echo "$reference" >> "$temp_file"
            echo "$INJECTION_MARKER_END" >> "$temp_file"
            echo "" >> "$temp_file"
            cat "$target" >> "$temp_file"
            ;;
        updated)
            # Wrap reference in markers and replace existing block
            echo "${INJECTION_MARKER_START} -->" > "$temp_file"
            echo "$reference" >> "$temp_file"
            echo "$INJECTION_MARKER_END" >> "$temp_file"
            # Strip all existing blocks and content before them, keep only content after last END marker
            awk "
                /${INJECTION_MARKER_START//\//\\/}/ { skip = 1; next }
                /${INJECTION_MARKER_END//\//\\/}/ { skip = 0; seen_end = 1; next }
                !skip && seen_end { print }
            " "$target" | sed '/./,$!d' >> "$temp_file"
            ;;
    esac

    mv "$temp_file" "$target"
    echo "{\"action\":\"$action\",\"target\":\"$target\",\"success\":true}"
}

# ==============================================================================
# BATCH OPERATIONS
# ==============================================================================

# Update all injectable files in project directory
# Args: project_root (optional, defaults to .)
# Returns: JSON summary of updates
injection_update_all() {
    local project_root="${1:-.}"
    local updated=0
    local skipped=0
    local failed=0
    local results=()

    injection_get_targets
    for target in "${REPLY[@]}"; do
        local filepath
        if [[ "$project_root" == "." ]]; then
            filepath="$target"
        else
            filepath="$project_root/$target"
        fi

        # Check if update needed (skip only if file exists AND is current)
        if [[ -f "$filepath" ]]; then
            local status_json status
            status_json=$(injection_check "$filepath")
            status=$(echo "$status_json" | grep -oP '"status":"\K[^"]+' || echo "unknown")

            if [[ "$status" == "current" ]]; then
                ((skipped++))
                continue
            fi
        fi

        # Perform update (creates file if missing, updates if outdated/legacy)
        # Use temp file to capture stderr separately (avoids bash debug pollution from 2>&1)
        local result error_file exit_code
        error_file=$(mktemp)
        trap "rm -f '$error_file'" RETURN

        result=$(injection_update "$filepath" 2>"$error_file")
        exit_code=$?

        if [[ $exit_code -eq 0 ]]; then
            results+=("{\"target\":\"$target\",\"action\":\"updated\",\"success\":true}")
            ((updated++))
        else
            # Extract error message from JSON if present, otherwise use raw message
            local error_text
            error_text=$(jq -r '.error // empty' "$error_file" 2>/dev/null || cat "$error_file")
            # Escape for JSON
            error_text=$(echo "$error_text" | jq -Rs .)
            results+=("{\"target\":\"$target\",\"action\":\"failed\",\"success\":false,\"error\":$error_text}")
            ((failed++))
        fi

        rm -f "$error_file"
    done

    # Build JSON response
    local results_array
    if [[ ${#results[@]} -gt 0 ]]; then
        results_array=$(printf '%s,' "${results[@]}")
        results_array="[${results_array%,}]"
    else
        results_array="[]"
    fi

    echo "{\"updated\":$updated,\"skipped\":$skipped,\"failed\":$failed,\"results\":$results_array}"
}

# Get compact injection summary for all targets
# Returns: Compact status string for display
injection_get_summary() {
    local current=0
    local outdated=0
    local missing=0
    local none=0

    injection_get_targets
    for target in "${REPLY[@]}"; do
        [[ ! -f "$target" ]] && { ((missing++)); continue; }

        local status_json status
        status_json=$(injection_check "$target")
        status=$(echo "$status_json" | grep -oP '"status":"\K[^"]+' || echo "unknown")

        case "$status" in
            current) ((current++)) ;;
            outdated|legacy) ((outdated++)) ;;
            none) ((none++)) ;;
        esac
    done

    local total=$((current + outdated + none))
    echo "{\"current\":$current,\"outdated\":$outdated,\"none\":$none,\"missing\":$missing,\"total\":$total}"
}
