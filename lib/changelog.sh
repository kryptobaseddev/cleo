#!/usr/bin/env bash
# changelog.sh - Task-to-Changelog Generation (Step 1 of 2)
#
# PURPOSE: Generates CHANGELOG.md content from cleo task metadata
# WORKFLOW: Part 1 of 2-step changelog pipeline
#   1. lib/changelog.sh: tasks → CHANGELOG.md (THIS SCRIPT)
#   2. scripts/generate-changelog.sh: CHANGELOG.md → docs/changelog/overview.mdx (Mintlify)
#
# NOTE: Despite T2539 consensus, this script and scripts/generate-changelog.sh
# serve different, non-overlapping purposes. They are sequential pipeline stages,
# not competing alternatives. See claudedocs/agent-outputs/2026-01-27_changelog-unification.md
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

# populate_release_tasks - Auto-populate release.tasks[] using hybrid date+label strategy
#
# Args:
#   $1 - version (e.g., "v0.65.0")
#   $2 - (optional) todo file path
#
# Output: Updates todo.json with discovered task IDs in release.tasks[]
# Returns: 0 on success, 1 on failure
#
# Algorithm:
#   1. Find tasks completed between prev_release and current_release
#   2. Filter by labels: version/changelog/release
#   3. Exclude epics (type != "epic")
#   4. Update release.tasks[] array
populate_release_tasks() {
    local version="$1"
    local todo_file="${2:-$TODO_FILE}"

    # Normalize version
    local version_normalized="${version#v}"
    local version_with_v="v${version_normalized}"

    # Get current and previous release timestamps
    local release_timestamp prev_timestamp
    release_timestamp=$(jq -r --arg v "$version_with_v" '
        .project.releases[] | select(.version == $v) | .releasedAt // .createdAt
    ' "$todo_file")

    if [[ -z "$release_timestamp" || "$release_timestamp" == "null" ]]; then
        echo "ERROR: Release $version_with_v not found or has no timestamp" >&2
        return 1
    fi

    prev_timestamp=$(jq -r --arg current_ts "$release_timestamp" '
        [.project.releases[] |
         select(.releasedAt != null) |
         select(.releasedAt < $current_ts)] |
        sort_by(.releasedAt) | .[-1].releasedAt // "1970-01-01T00:00:00Z"
    ' "$todo_file")

    # Find candidate tasks in date window + label filter
    # @task T2807
    # @epic T2802
    # @why Prevent non-done tasks from appearing in changelog (data integrity)
    # @what Add status validation check to changelog task filtering
    # @task T2808
    # @epic T2802
    # @why Prevent task double-counting across releases (data integrity)
    # @what Add version label priority filter - explicit labels beat generic labels
    local task_ids
    task_ids=$(jq -r \
        --arg start "$prev_timestamp" \
        --arg end "$release_timestamp" \
        --arg v1 "$version_normalized" \
        --arg v2 "$version_with_v" \
        '
        [.tasks[] |
         # Filter 1: Must have completion timestamp
         select(.completedAt != null) |
         # Filter 2: Must be in date window
         select(.completedAt >= $start and .completedAt <= $end) |
         # Filter 3: Must have status="done"
         select(.status == "done") |
         # Filter 4: Exclude epics (organizational tasks)
         select(.type != "epic") |
         # Filter 5: Must have relevant label
         select(
            (.labels // []) | (
                index($v1) or index($v2)
            )
         ) |
         # Filter 6: Exclude tasks already claimed by other versions explicit labels
         select(
            [(.labels // [])[] | select(. | startswith("v") and test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))] as $version_labels |
            ($version_labels | length == 0) or ($version_labels | index($v2))
         ) |
         .id
        ]
    ' "$todo_file")

    # Update release.tasks[] with discovered IDs
    local updated_json
    updated_json=$(jq \
        --arg version "$version_with_v" \
        --argjson task_ids "$task_ids" \
        '
        .project.releases = [
            .project.releases[] |
            if .version == $version then
                .tasks = $task_ids
            else .
            end
        ]
    ' "$todo_file")

    # Recalculate checksum after modifying todo.json
    local checksum
    checksum=$(echo "$updated_json" | jq -c '.tasks' | sha256sum | cut -c1-16)
    updated_json=$(echo "$updated_json" | jq --arg cs "$checksum" '._meta.checksum = $cs')

    # Write back to file
    echo "$updated_json" > "$todo_file.tmp"
    mv "$todo_file.tmp" "$todo_file"

    return 0
}

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

    # Normalize version for internal lookups (with v prefix)
    local version_lookup="$version"
    if [[ ! "$version_lookup" =~ ^v ]]; then
        version_lookup="v${version_lookup}"
    fi

    # Version for CHANGELOG output (without v prefix per Keep a Changelog standard)
    local version_display="${version_lookup#v}"

    # Get tasks for release
    local tasks_json
    tasks_json=$(get_release_tasks "$version_lookup" "$todo_file")

    # Generate categorized changelog using jq
    jq -r --arg version "$version_display" --arg date "$release_date" '
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

    # Normalize version (remove v prefix for comparison)
    local version_no_v="${version#v}"

    # IDEMPOTENCY CHECK: Skip if version header already exists with content
    # This prevents duplicate entries when called multiple times
    if [[ -f "$output_file" ]]; then
        if grep -q "^## \[${version_no_v}\]" "$output_file"; then
            # Check if it has content (not just empty header)
            local header_line
            header_line=$(grep -n "^## \[${version_no_v}\]" "$output_file" | head -1 | cut -d: -f1)
            local next_line=$((header_line + 1))
            local next_content
            next_content=$(sed -n "${next_line}p" "$output_file")
            # If next line is not empty and not another version header, content exists
            if [[ -n "$next_content" && ! "$next_content" =~ ^##\  ]]; then
                log_info "Changelog entry already exists for ${version_no_v} - skipping"
                return 0
            fi
            # Header exists but is empty - we'll replace it below
            log_info "Found empty header for ${version_no_v} - adding content"
        fi
    fi

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

# generate_changelog_from_commits - Generate changelog from git commits
#
# Args:
#   $1 - (optional) since_ref - git ref to start from (tag, commit, or "last-tag" for auto-detect)
#   $2 - (optional) until_ref - git ref to end at (default: HEAD)
#
# Output: Markdown changelog entries grouped by conventional commit type
#
# Algorithm:
#   1. Get commits since last tag (or specified ref)
#   2. Parse conventional commit format: type(scope): description (T####)
#   3. Group by type: feat, fix, docs, refactor, test, chore, breaking
#   4. Extract task IDs from commit messages
#   5. Generate Keep-a-Changelog format entries
#
# @task T2842
# @epic T2666
generate_changelog_from_commits() {
    local since_ref="${1:-last-tag}"
    local until_ref="${2:-HEAD}"

    # Auto-detect last tag if requested
    if [[ "$since_ref" == "last-tag" ]]; then
        since_ref=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
        if [[ -z "$since_ref" ]]; then
            # No tags exist, use first commit
            since_ref=$(git rev-list --max-parents=0 HEAD 2>/dev/null || echo "HEAD")
        fi
    fi

    # Get commits in range
    local commit_range
    if [[ -n "$since_ref" && "$since_ref" != "HEAD" ]]; then
        commit_range="${since_ref}..${until_ref}"
    else
        commit_range="$until_ref"
    fi

    # Parse commits and generate JSON for processing
    # Format: type|scope|description|taskIds
    local commits_json
    commits_json=$(git log --pretty=format:"%s" --no-merges "$commit_range" 2>/dev/null | \
        awk '
        BEGIN {
            print "["
            first = 1
        }
        {
            # Parse conventional commit format: type(scope): description (T####)
            subject = $0

            # Match pattern: type(scope): description or type: description
            if (match(subject, /^([a-z]+)(\([^)]+\))?:/)) {
                # Extract the matched prefix
                matched_prefix = substr(subject, 1, RLENGTH)
                # Get description after ": "
                desc = substr(subject, RLENGTH + 1)
                # Remove leading space from description
                sub(/^ /, "", desc)

                # Extract type
                if (match(matched_prefix, /^[a-z]+/)) {
                    type = substr(matched_prefix, 1, RLENGTH)
                }

                # Extract scope (if present)
                scope = ""
                if (match(matched_prefix, /\([^)]+\)/)) {
                    scope_with_parens = substr(matched_prefix, RSTART, RLENGTH)
                    # Remove parentheses
                    scope = substr(scope_with_parens, 2, length(scope_with_parens) - 2)
                }

                # Extract task IDs (T####)
                task_ids = ""
                temp = desc
                while (match(temp, /\(T[0-9]+\)/)) {
                    task_id = substr(temp, RSTART+1, RLENGTH-2)
                    if (task_ids == "") {
                        task_ids = task_id
                    } else {
                        task_ids = task_ids "," task_id
                    }
                    temp = substr(temp, RSTART+RLENGTH)
                }

                # Clean description (remove task IDs)
                gsub(/ ?\(T[0-9]+\)/, "", desc)

                # Escape quotes in description and scope
                gsub(/"/, "\\\"", desc)
                gsub(/"/, "\\\"", scope)

                # Output JSON
                if (!first) print ","
                printf "  {\"type\":\"%s\",\"scope\":\"%s\",\"description\":\"%s\",\"taskIds\":\"%s\"}", type, scope, desc, task_ids
                first = 0
            }
        }
        END {
            print ""
            print "]"
        }
    ')

    # Group by type and generate markdown using jq
    echo "$commits_json" | jq -r '
        # Filter out automated git checkpoint commits (lib/git-checkpoint.sh)
        # These have descriptions like "auto checkpoint", "session-end checkpoint", "manual checkpoint"
        map(select(.scope == "cleo" and (.description | test("^(auto|session-end|manual) checkpoint")) | not)) |

        # Group by type
        group_by(.type) |
        map({
            type: .[0].type,
            entries: map(
                if .scope != "" then
                    "- **" + .scope + "**: " + .description +
                    (if .taskIds != "" then " (" + .taskIds + ")" else "" end)
                else
                    "- " + .description +
                    (if .taskIds != "" then " (" + .taskIds + ")" else "" end)
                end
            )
        }) |

        # Map type to section header
        map(
            if .type == "feat" then
                {section: "### Features", entries: .entries}
            elif .type == "fix" then
                {section: "### Bug Fixes", entries: .entries}
            elif .type == "docs" then
                {section: "### Documentation", entries: .entries}
            elif .type == "refactor" then
                {section: "### Refactoring", entries: .entries}
            elif .type == "test" then
                {section: "### Tests", entries: .entries}
            elif .type == "chore" then
                {section: "### Other Changes", entries: .entries}
            elif .type == "breaking" then
                {section: "### Breaking Changes", entries: .entries}
            else
                {section: "### Other Changes", entries: .entries}
            end
        ) |

        # Sort sections (breaking first, then standard order)
        sort_by(
            if .section == "### Breaking Changes" then 0
            elif .section == "### Features" then 1
            elif .section == "### Bug Fixes" then 2
            elif .section == "### Documentation" then 3
            elif .section == "### Refactoring" then 4
            elif .section == "### Tests" then 5
            else 6
            end
        ) |

        # Generate markdown
        map(.section + "\n" + (.entries | join("\n"))) |
        join("\n\n")
    '
}

# extract_changelog_section - Extract version section from CHANGELOG.md
#
# Args:
#   $1 - version (e.g., "v0.75.0" or "0.75.0")
#   $2 - (optional) changelog file path (default: CHANGELOG.md)
#   $3 - (optional) output file path (default: stdout)
#
# Returns:
#   0 - Success (section extracted)
#   1 - Version section not found in changelog
#   2 - Section is empty (whitespace only)
#
# Example:
#   extract_changelog_section "v0.75.0" "CHANGELOG.md" "release-notes.txt"
extract_changelog_section() {
    local version="$1"
    local changelog="${2:-CHANGELOG.md}"
    local output="${3:--}"

    # Normalize version (remove 'v' prefix if present)
    local version_normalized="${version#v}"

    # Extract section using awk
    local section_content
    section_content=$(awk -v ver="$version_normalized" '
        # Match version header (with or without "v" prefix)
        /^## \[(v)?'"$version_normalized"'\]/ {
            found=1
            next
        }

        # Stop at next version section
        found && /^## \[/ {
            exit
        }

        # Print lines while in target section
        found {
            print
        }
    ' "$changelog")

    # Check if section was found
    if [[ -z "$section_content" ]]; then
        echo "ERROR: Changelog section for version $version not found" >&2
        return 1
    fi

    # Check if section is not empty (after trimming whitespace)
    if [[ "$section_content" =~ ^[[:space:]]*$ ]]; then
        echo "ERROR: Changelog section for $version is empty" >&2
        return 2
    fi

    # Write to output
    if [[ "$output" == "-" ]]; then
        echo "$section_content"
    else
        echo "$section_content" > "$output"
    fi

    return 0
}
