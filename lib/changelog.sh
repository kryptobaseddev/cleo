#!/usr/bin/env bash
# changelog.sh - Generate changelog from completed tasks
#
# LAYER: 3 (Feature Layer)
# DEPENDENCIES: file-ops.sh
# PROVIDES: generate_changelog, get_release_tasks, format_changelog_json,
#           write_changelog_file, append_to_changelog

#=== SOURCE GUARD ================================================
[[ -n "${_CHANGELOG_LOADED:-}" ]] && return 0
declare -r _CHANGELOG_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source file-ops for atomic operations (Layer 2)
if [[ -f "$_LIB_DIR/file-ops.sh" ]]; then
    # shellcheck source=lib/file-ops.sh
    source "$_LIB_DIR/file-ops.sh"
fi

# ============================================================================
# CONFIGURATION
# ============================================================================

# Default CLEO directory
CLEO_DIR="${CLEO_DIR:-.cleo}"
TODO_FILE="${TODO_FILE:-${CLEO_DIR}/todo.json}"
CHANGELOG_FILE="${CHANGELOG_FILE:-CHANGELOG.md}"

# Label categories for changelog grouping
# Features: feature, feat, enhancement
# Fixes: bug, fix, bugfix, hotfix
# Docs: docs, documentation
# Refactor: refactor, cleanup, chore
# Tests: test, testing
# Breaking: breaking, breaking-change

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

# get_release_tasks - Get full task objects for a release
#
# Args:
#   $1 - version (e.g., "v0.65.0")
#   $2 - (optional) todo file path
#
# Output: JSON array of task objects
get_release_tasks() {
    local version="$1"
    local todo_file="${2:-$TODO_FILE}"

    # Normalize version
    if [[ ! "$version" =~ ^v ]]; then
        version="v${version}"
    fi

    # Get task IDs from release, then get full task objects
    jq --arg v "$version" '
        (.project.releases // [] | map(select(.version == $v)) | .[0].tasks // []) as $task_ids |
        [.tasks[] | select(.id as $id | $task_ids | index($id))]
    ' "$todo_file"
}

# categorize_task - Determine the category of a task based on labels
#
# Args:
#   $1 - JSON task object (passed via jq)
#
# Returns: category string (feature, fix, docs, refactor, test, other)
categorize_task_jq() {
    # This is a jq filter, not a bash function
    cat << 'EOF'
def categorize:
    .labels // [] |
    if any(. == "feature" or . == "feat" or . == "enhancement") then "feature"
    elif any(. == "bug" or . == "fix" or . == "bugfix" or . == "hotfix") then "fix"
    elif any(. == "docs" or . == "documentation") then "docs"
    elif any(. == "refactor" or . == "cleanup" or . == "chore") then "refactor"
    elif any(. == "test" or . == "testing") then "test"
    elif any(. == "breaking" or . == "breaking-change") then "breaking"
    else "other"
    end;
EOF
}

# ============================================================================
# CORE FUNCTIONS
# ============================================================================

# generate_changelog - Generate changelog markdown for a release
#
# Args:
#   $1 - version (e.g., "v0.65.0")
#   $2 - (optional) release date (defaults to today)
#   $3 - (optional) todo file path
#
# Output: Markdown changelog text
generate_changelog() {
    local version="$1"
    local release_date="${2:-$(date +%Y-%m-%d)}"
    local todo_file="${3:-$TODO_FILE}"

    # Normalize version
    if [[ ! "$version" =~ ^v ]]; then
        version="v${version}"
    fi

    # Get tasks for release
    local tasks_json
    tasks_json=$(get_release_tasks "$version" "$todo_file")

    # Generate categorized changelog using jq
    jq -r --arg version "$version" --arg date "$release_date" '
        # Categorization function
        def categorize:
            .labels // [] |
            if any(. == "feature" or . == "feat" or . == "enhancement") then "feature"
            elif any(. == "bug" or . == "fix" or . == "bugfix" or . == "hotfix") then "fix"
            elif any(. == "docs" or . == "documentation") then "docs"
            elif any(. == "refactor" or . == "cleanup" or . == "chore") then "refactor"
            elif any(. == "test" or . == "testing") then "test"
            elif any(. == "breaking" or . == "breaking-change") then "breaking"
            else "other"
            end;

        # Group tasks by category
        group_by(categorize) |
        map({category: .[0] | categorize, tasks: .}) |

        # Build changelog output
        "## [\($version)] - \($date)\n" +
        (
            # Breaking changes first (if any)
            (map(select(.category == "breaking")) | if length > 0 then
                "\n### Breaking Changes\n" +
                (.[0].tasks | map("- \(.title) (\(.id))") | join("\n")) + "\n"
            else "" end) +

            # Features
            (map(select(.category == "feature")) | if length > 0 then
                "\n### Features\n" +
                (.[0].tasks | map("- \(.title) (\(.id))") | join("\n")) + "\n"
            else "" end) +

            # Bug Fixes
            (map(select(.category == "fix")) | if length > 0 then
                "\n### Bug Fixes\n" +
                (.[0].tasks | map("- \(.title) (\(.id))") | join("\n")) + "\n"
            else "" end) +

            # Documentation
            (map(select(.category == "docs")) | if length > 0 then
                "\n### Documentation\n" +
                (.[0].tasks | map("- \(.title) (\(.id))") | join("\n")) + "\n"
            else "" end) +

            # Refactoring
            (map(select(.category == "refactor")) | if length > 0 then
                "\n### Refactoring\n" +
                (.[0].tasks | map("- \(.title) (\(.id))") | join("\n")) + "\n"
            else "" end) +

            # Tests
            (map(select(.category == "test")) | if length > 0 then
                "\n### Tests\n" +
                (.[0].tasks | map("- \(.title) (\(.id))") | join("\n")) + "\n"
            else "" end) +

            # Other changes
            (map(select(.category == "other")) | if length > 0 then
                "\n### Other Changes\n" +
                (.[0].tasks | map("- \(.title) (\(.id))") | join("\n")) + "\n"
            else "" end)
        )
    ' <<< "$tasks_json"
}

# format_changelog_json - Generate changelog in JSON format
#
# Args:
#   $1 - version (e.g., "v0.65.0")
#   $2 - (optional) release date
#   $3 - (optional) todo file path
#
# Output: JSON changelog object
format_changelog_json() {
    local version="$1"
    local release_date="${2:-$(date +%Y-%m-%d)}"
    local todo_file="${3:-$TODO_FILE}"

    # Normalize version
    if [[ ! "$version" =~ ^v ]]; then
        version="v${version}"
    fi

    # Get tasks for release
    local tasks_json
    tasks_json=$(get_release_tasks "$version" "$todo_file")

    # Generate categorized changelog as JSON
    jq --arg version "$version" --arg date "$release_date" '
        # Categorization function
        def categorize:
            .labels // [] |
            if any(. == "feature" or . == "feat" or . == "enhancement") then "feature"
            elif any(. == "bug" or . == "fix" or . == "bugfix" or . == "hotfix") then "fix"
            elif any(. == "docs" or . == "documentation") then "docs"
            elif any(. == "refactor" or . == "cleanup" or . == "chore") then "refactor"
            elif any(. == "test" or . == "testing") then "test"
            elif any(. == "breaking" or . == "breaking-change") then "breaking"
            else "other"
            end;

        # Build structured output
        {
            version: $version,
            date: $date,
            breaking: [.[] | select(categorize == "breaking") | {id, title, description}],
            features: [.[] | select(categorize == "feature") | {id, title, description}],
            fixes: [.[] | select(categorize == "fix") | {id, title, description}],
            docs: [.[] | select(categorize == "docs") | {id, title, description}],
            refactoring: [.[] | select(categorize == "refactor") | {id, title, description}],
            tests: [.[] | select(categorize == "test") | {id, title, description}],
            other: [.[] | select(categorize == "other") | {id, title, description}]
        }
    ' <<< "$tasks_json"
}

# write_changelog_file - Write changelog to a file (creates or overwrites)
#
# Args:
#   $1 - version
#   $2 - output file path (defaults to CHANGELOG.md)
#   $3 - (optional) todo file path
#
# Returns: 0 on success, 1 on failure
write_changelog_file() {
    local version="$1"
    local output_file="${2:-$CHANGELOG_FILE}"
    local todo_file="${3:-$TODO_FILE}"

    local changelog_content
    changelog_content=$(generate_changelog "$version" "" "$todo_file")

    # Write to file
    echo "$changelog_content" > "$output_file"
    return $?
}

# append_to_changelog - Prepend new release to existing changelog
#
# Args:
#   $1 - version
#   $2 - output file path (defaults to CHANGELOG.md)
#   $3 - (optional) todo file path
#
# Returns: 0 on success, 1 on failure
append_to_changelog() {
    local version="$1"
    local output_file="${2:-$CHANGELOG_FILE}"
    local todo_file="${3:-$TODO_FILE}"

    local changelog_content
    changelog_content=$(generate_changelog "$version" "" "$todo_file")

    if [[ -f "$output_file" ]]; then
        # Prepend to existing changelog (after header if present)
        local temp_file
        temp_file=$(mktemp)

        # Check if file has standard changelog header
        if head -n1 "$output_file" | grep -q "^# Changelog"; then
            # Find the first version header (## [v) line to insert before
            local insert_line
            insert_line=$(grep -n "^## \[v\|^## \[" "$output_file" | head -1 | cut -d: -f1)

            if [[ -n "$insert_line" && "$insert_line" -gt 1 ]]; then
                # Insert new content before first version
                head -n $((insert_line - 1)) "$output_file" > "$temp_file"
                echo "$changelog_content" >> "$temp_file"
                echo "" >> "$temp_file"
                tail -n +$insert_line "$output_file" >> "$temp_file"
            else
                # No existing versions, add after header block (find first blank line after header)
                local header_end
                header_end=$(awk 'NR>1 && /^$/ {print NR; exit}' "$output_file")
                if [[ -n "$header_end" ]]; then
                    head -n "$header_end" "$output_file" > "$temp_file"
                    echo "$changelog_content" >> "$temp_file"
                    tail -n +$((header_end + 1)) "$output_file" >> "$temp_file"
                else
                    # Fallback: keep first 4 lines as header
                    head -n4 "$output_file" > "$temp_file"
                    echo "" >> "$temp_file"
                    echo "$changelog_content" >> "$temp_file"
                    tail -n +5 "$output_file" >> "$temp_file"
                fi
            fi
        else
            # No header, just prepend
            echo "$changelog_content" > "$temp_file"
            echo "" >> "$temp_file"
            cat "$output_file" >> "$temp_file"
        fi

        mv "$temp_file" "$output_file"
    else
        # Create new changelog with header
        {
            echo "# Changelog"
            echo ""
            echo "All notable changes to this project will be documented in this file."
            echo ""
            echo "$changelog_content"
        } > "$output_file"
    fi

    return $?
}

# get_release_notes - Get notes from a release
#
# Args:
#   $1 - version
#   $2 - (optional) todo file path
#
# Output: Release notes string or empty
get_release_notes() {
    local version="$1"
    local todo_file="${2:-$TODO_FILE}"

    # Normalize version
    if [[ ! "$version" =~ ^v ]]; then
        version="v${version}"
    fi

    jq -r --arg v "$version" '
        .project.releases // [] |
        map(select(.version == $v)) |
        .[0].notes // ""
    ' "$todo_file"
}
