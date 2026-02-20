#!/usr/bin/env bash
# files-detect.sh - Auto-detect file paths from text content
#
# LAYER: 2 (Core Services)
# DEPENDENCIES: None
# PROVIDES: detect_files_from_text, merge_files_arrays

#=== SOURCE GUARD ================================================
[[ -n "${_FILES_DETECT_SH_LOADED:-}" ]] && return 0
declare -r _FILES_DETECT_SH_LOADED=1

set -euo pipefail

# ============================================================================
# FILE PATH DETECTION
# ============================================================================

# detect_files_from_text - Extract file paths from text content
#
# Scans text for patterns that look like file paths and returns unique matches.
# Supports common CLEO project file patterns (*.sh, *.json, *.md, *.bats, etc.)
#
# Usage: detect_files_from_text "text with lib/foo.sh and scripts/bar.sh mentions"
# Output: JSON array ["lib/foo.sh", "scripts/bar.sh"]
#
# Patterns matched:
#   - Explicit paths: lib/foo.sh, scripts/bar.sh, tests/unit/test.bats
#   - Schema files: schemas/*.schema.json
#   - Documentation: docs/*.md, *.md
#   - Templates: templates/*.json, templates/*.md
#   - Config files: *.json, *.yaml, *.yml
#   - Test files: *.bats
#   - Executable scripts: *.sh
#
# Arguments:
#   $1 - Text to scan for file paths
#
# Returns:
#   JSON array of unique file paths found (empty array if none)
#
detect_files_from_text() {
    local text="${1:-}"

    if [[ -z "$text" ]]; then
        echo "[]"
        return 0
    fi

    # Single unified pattern for file paths with directories
    # Matches: dir/file.ext or dir/subdir/file.ext
    # The final extension filter ensures we only keep valid file types
    local pattern='[a-zA-Z0-9_-]+/[a-zA-Z0-9_./-]+\.[a-zA-Z]+'

    # Collect all matches
    local all_matches=""

    # Use grep with extended regex to find matches
    # -o outputs only matching parts, -E enables extended regex
    local matches
    matches=$(echo "$text" | grep -oE "$pattern" 2>/dev/null || true)
    if [[ -n "$matches" ]]; then
        all_matches+="$matches"$'\n'
    fi

    # Also check for backtick-quoted paths which are common in notes
    # Match paths inside backticks: `path/to/file.ext`
    local backtick_matches
    backtick_matches=$(echo "$text" | grep -oE '\`[a-zA-Z0-9_./-]+\.[a-z]+\`' 2>/dev/null | sed 's/\`//g' || true)
    if [[ -n "$backtick_matches" ]]; then
        all_matches+="$backtick_matches"$'\n'
    fi

    # Remove empty lines, sort uniquely, and convert to JSON array
    if [[ -z "$all_matches" ]]; then
        echo "[]"
        return 0
    fi

    # Filter to valid extensions and deduplicate
    # Uses jq to filter only paths ending with valid extensions
    echo "$all_matches" | \
        grep -v '^$' | \
        sort -u | \
        jq -R -s 'split("\n") | map(select(length > 0)) | map(select(test("\\.(sh|json|md|bats|yaml|yml|ts|js|py)$"))) | unique'
}

# merge_files_arrays - Merge detected files with existing files array
#
# Combines two JSON arrays of file paths, deduplicating the result.
#
# Usage: merge_files_arrays '["existing.sh"]' '["new.sh", "existing.sh"]'
# Output: ["existing.sh", "new.sh"]
#
# Arguments:
#   $1 - Existing files array (JSON)
#   $2 - New files to merge (JSON)
#
# Returns:
#   JSON array of merged unique file paths
#
merge_files_arrays() {
    local existing="${1:-[]}"
    local new_files="${2:-[]}"

    # Handle empty/null inputs
    if [[ "$existing" == "null" || -z "$existing" ]]; then
        existing="[]"
    fi
    if [[ "$new_files" == "null" || -z "$new_files" ]]; then
        new_files="[]"
    fi

    # Merge and deduplicate using jq
    jq -n \
        --argjson existing "$existing" \
        --argjson new "$new_files" \
        '($existing + $new) | unique | sort'
}

# detect_and_merge_files - Convenience function combining detect + merge
#
# Detects files from text and merges with existing files array.
#
# Usage: detect_and_merge_files "text with lib/foo.sh" '["existing.sh"]'
# Output: ["existing.sh", "lib/foo.sh"]
#
# Arguments:
#   $1 - Text to scan for file paths
#   $2 - Existing files array (JSON, optional, defaults to [])
#
# Returns:
#   JSON array of merged unique file paths
#
detect_and_merge_files() {
    local text="${1:-}"
    local existing="${2:-[]}"

    local detected
    detected=$(detect_files_from_text "$text")

    merge_files_arrays "$existing" "$detected"
}

# validate_file_path - Check if a path looks like a valid project file
#
# Validates that a path matches expected project structure patterns.
# Does NOT check if file exists - only validates format.
#
# Usage: validate_file_path "lib/foo.sh" && echo "valid"
#
# Arguments:
#   $1 - File path to validate
#
# Returns:
#   0 if path looks valid, 1 otherwise
#
validate_file_path() {
    local path="${1:-}"

    [[ -z "$path" ]] && return 1

    # Must have file extension
    [[ ! "$path" =~ \.[a-z]+$ ]] && return 1

    # Must not start with / (relative paths only)
    [[ "$path" =~ ^/ ]] && return 1

    # Must not contain suspicious patterns
    [[ "$path" =~ \.\. ]] && return 1
    [[ "$path" =~ // ]] && return 1

    # Valid common extensions
    local valid_ext='(sh|json|md|bats|yaml|yml|ts|js|py|txt|html|css|go|rs|c|cpp|h|hpp|java|rb|php)'
    [[ "$path" =~ \.$valid_ext$ ]] && return 0

    return 1
}
