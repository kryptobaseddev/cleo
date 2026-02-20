#!/usr/bin/env bash
# gap-check.sh - Documentation gap validation library
#
# LAYER: 3 (Shared Tools)
# DEPENDENCIES: platform-compat.sh, config.sh, file-ops.sh
# PROVIDES: gap_check_validate, find_review_docs, analyze_coverage

#=== SOURCE GUARD ================================================
[[ -n "${_GAP_CHECK_SH_LOADED:-}" ]] && return 0
declare -r _GAP_CHECK_SH_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source platform compatibility layer
if [[ -f "$_LIB_DIR/core/platform-compat.sh" ]]; then
    # shellcheck source=lib/core/platform-compat.sh
    source "$_LIB_DIR/core/platform-compat.sh"
else
    echo "ERROR: Cannot find platform-compat.sh in $_LIB_DIR" >&2
    exit 1
fi

# Source config library
if [[ -f "$_LIB_DIR/core/config.sh" ]]; then
    # shellcheck source=lib/core/config.sh
    source "$_LIB_DIR/core/config.sh"
fi

# Source file-ops library
if [[ -f "$_LIB_DIR/data/file-ops.sh" ]]; then
    # shellcheck source=lib/data/file-ops.sh
    source "$_LIB_DIR/data/file-ops.sh"
fi

# ============================================================================
# MANIFEST OPERATIONS
# ============================================================================

# Find documents in review status
# Args: $1 = epic/task ID (optional), $2 = manifest path
# Returns: JSON array of review documents
find_review_docs() {
    local filter_id="${1:-}"
    local manifest="${2:-claudedocs/agent-outputs/MANIFEST.jsonl}"

    [[ ! -f "$manifest" ]] && echo "[]" && return 0

    # Build filter based on whether ID is specified
    # Note: Using line-by-line processing to handle invalid JSON entries gracefully
    local result="[]"

    while IFS= read -r line; do
        # Skip invalid JSON lines
        if ! echo "$line" | jq empty 2>/dev/null; then
            continue
        fi

        # Check status
        local status
        status=$(echo "$line" | jq -r '.status // "unknown"')
        [[ "$status" != "review" ]] && continue

        # Check filter
        if [[ -n "$filter_id" ]]; then
            local has_task
            has_task=$(echo "$line" | jq --arg id "$filter_id" '(.linked_tasks // []) | index($id) != null')
            [[ "$has_task" != "true" ]] && continue
        fi

        # Extract fields
        local entry
        entry=$(echo "$line" | jq '{
            id: .id,
            file: .file,
            title: .title,
            topics: (.topics // []),
            linked_tasks: (.linked_tasks // [])
        }')

        # Append to result
        result=$(echo "$result" | jq --argjson entry "$entry" '. += [$entry]')
    done < "$manifest"

    echo "$result"
}

# Extract key topics from a document
# Args: $1 = file path
# Returns: JSON array of topics/sections
extract_topics() {
    local file="$1"

    [[ ! -f "$file" ]] && echo "[]" && return 1

    # Extract markdown headings (## and ###)
    grep -E '^##+ ' "$file" 2>/dev/null | \
        sed 's/^##* //' | \
        jq -R -s -c 'split("\n") | map(select(length > 0))' || echo "[]"
}

# Search canonical docs for topic coverage
# Args: $1 = topic/keyword, $2 = docs directory
# Returns: JSON object with coverage info
search_canonical_coverage() {
    local topic="$1"
    local docs_dir="${2:-docs}"

    # Escape special regex characters
    local escaped_topic
    escaped_topic=$(printf '%s\n' "$topic" | sed 's/[[\.*^$/]/\\&/g')

    # Search for topic in docs
    local matches
    matches=$(grep -r -i -l "$escaped_topic" "$docs_dir" 2>/dev/null || true)

    local match_count
    if [[ -z "$matches" ]]; then
        match_count=0
    else
        match_count=$(echo "$matches" | wc -l | tr -d ' ')
    fi

    local files_json
    if [[ $match_count -eq 0 ]]; then
        files_json="[]"
    else
        files_json=$(echo "$matches" | jq -R -s -c 'split("\n") | map(select(length > 0))')
    fi

    jq -n \
        --arg topic "$topic" \
        --argjson count "$match_count" \
        --argjson files "$files_json" \
        '{topic: $topic, matches: $count, files: $files}'
}

# ============================================================================
# GAP ANALYSIS
# ============================================================================

# Analyze coverage for review documents
# Args: $1 = epic/task ID (optional), $2 = project root
# Returns: JSON gap analysis report
analyze_coverage() {
    local filter_id="${1:-}"
    local project_root="${2:-.}"

    local manifest="${project_root}/claudedocs/agent-outputs/MANIFEST.jsonl"
    local docs_dir="${project_root}/docs"

    # Find review documents
    local review_docs
    review_docs=$(find_review_docs "$filter_id" "$manifest")

    local review_count
    review_count=$(echo "$review_docs" | jq 'length')

    # If no review documents, return clean status
    if [[ $review_count -eq 0 ]]; then
        jq -n \
            --arg epic "${filter_id:-all}" \
            '{
                epicId: $epic,
                timestamp: (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
                reviewDocs: [],
                gaps: [],
                coverage: [],
                status: "no_review_docs",
                canArchive: false
            }'
        return 0
    fi

    # Analyze each review document
    local gaps=()
    local coverage=()

    while IFS= read -r doc; do
        local doc_id file topics
        doc_id=$(echo "$doc" | jq -r '.id')
        file=$(echo "$doc" | jq -r '.file')
        topics=$(echo "$doc" | jq -r '.topics[]' 2>/dev/null || echo "")

        local doc_path="${project_root}/claudedocs/agent-outputs/${file}"

        # Extract headings from document
        local headings
        headings=$(extract_topics "$doc_path")

        # Check coverage for each topic
        local topic_gaps=()
        local topic_coverage=()

        for topic in $topics; do
            local coverage_info
            coverage_info=$(search_canonical_coverage "$topic" "$docs_dir")

            local match_count
            match_count=$(echo "$coverage_info" | jq -r '.matches')

            if [[ $match_count -eq 0 ]]; then
                topic_gaps+=("$topic")
            else
                topic_coverage+=("$topic")
            fi
        done

        # Record gaps for this document
        if [[ ${#topic_gaps[@]} -gt 0 ]]; then
            for gap_topic in "${topic_gaps[@]}"; do
                gaps+=("$(jq -n \
                    --arg type "missing_topic_coverage" \
                    --arg severity "warning" \
                    --arg doc "$doc_id" \
                    --arg topic "$gap_topic" \
                    '{
                        type: $type,
                        severity: $severity,
                        document: $doc,
                        topic: $topic,
                        fix: "Document \($topic) in canonical docs/"
                    }')")
            done
        fi

        # Record coverage
        for covered in "${topic_coverage[@]}"; do
            coverage+=("$(jq -n \
                --arg doc "$doc_id" \
                --arg topic "$covered" \
                '{document: $doc, topic: $topic}')")
        done
    done < <(echo "$review_docs" | jq -c '.[]')

    # Build gaps array
    local gaps_json
    if [[ ${#gaps[@]} -eq 0 ]]; then
        gaps_json="[]"
    else
        gaps_json=$(printf '%s\n' "${gaps[@]}" | jq -s '.')
    fi

    # Build coverage array
    local coverage_json
    if [[ ${#coverage[@]} -eq 0 ]]; then
        coverage_json="[]"
    else
        coverage_json=$(printf '%s\n' "${coverage[@]}" | jq -s '.')
    fi

    # Determine status
    local status can_archive
    local gap_count
    gap_count=$(echo "$gaps_json" | jq 'length')

    if [[ $gap_count -eq 0 ]]; then
        status="ready_to_archive"
        can_archive="true"
    else
        status="gaps_detected"
        can_archive="false"
    fi

    # Build final report
    jq -n \
        --arg epic "${filter_id:-all}" \
        --argjson review "$review_docs" \
        --argjson gaps "$gaps_json" \
        --argjson coverage "$coverage_json" \
        --arg status "$status" \
        --argjson can_archive "$can_archive" \
        '{
            epicId: $epic,
            timestamp: (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
            reviewDocs: $review,
            gaps: $gaps,
            coverage: $coverage,
            status: $status,
            canArchive: $can_archive
        }'
}

# ============================================================================
# HUMAN-READABLE OUTPUT
# ============================================================================

# Format gap report for human reading
# Args: $1 = gap report JSON
format_gap_report() {
    local report="$1"

    local epic_id status can_archive
    epic_id=$(echo "$report" | jq -r '.epicId')
    status=$(echo "$report" | jq -r '.status')
    can_archive=$(echo "$report" | jq -r '.canArchive')

    local review_count gap_count coverage_count
    review_count=$(echo "$report" | jq '.reviewDocs | length')
    gap_count=$(echo "$report" | jq '.gaps | length')
    coverage_count=$(echo "$report" | jq '.coverage | length')

    echo "Gap Analysis for Epic ${epic_id}"
    echo "===================================="
    echo ""

    # No review docs
    if [[ "$status" == "no_review_docs" ]]; then
        echo "No documents in review status."
        echo ""
        echo "Status: All clear (nothing to archive)"
        return 0
    fi

    # Review documents
    echo "Documents in review ($review_count):"
    echo "$report" | jq -r '.reviewDocs[] | "  - \(.file) (linked to \(.linked_tasks | join(", ")))"'
    echo ""

    # Coverage summary
    if [[ $coverage_count -gt 0 ]]; then
        echo "Topics with canonical coverage ($coverage_count):"
        echo "$report" | jq -r '.coverage | group_by(.document) | .[] |
            "  ✓ \(.[0].document): \(map(.topic) | join(", "))"'
        echo ""
    fi

    # Gaps
    if [[ $gap_count -gt 0 ]]; then
        echo "Gaps detected ($gap_count):"
        echo "$report" | jq -r '.gaps[] | "  ✗ \(.document): \(.topic) - \(.fix)"'
        echo ""

        echo "Action required:"
        echo "  1. Document missing topics in canonical docs/"
        echo "  2. Re-run: cleo docs gap-check ${epic_id}"
        echo "  3. After fixing: cleo docs archive ${epic_id} --ack"
        echo ""
        echo "Status: Gaps detected (archival blocked)"
    else
        echo "Status: No gaps detected (ready to archive)"
        echo ""
        echo "Next step:"
        echo "  cleo docs archive ${epic_id} --ack"
    fi
}

# ============================================================================
# MAIN GAP CHECK FUNCTION
# ============================================================================

# Run gap validation
# Args: $1 = epic/task ID, $2 = output format (json|human)
# Returns: 0 if no gaps, 1 if gaps found, 2 on error
gap_check_validate() {
    local filter_id="${1:-}"
    local format="${2:-json}"
    local project_root="${3:-.}"

    # Run analysis
    local report
    if ! report=$(analyze_coverage "$filter_id" "$project_root"); then
        echo "ERROR: Failed to analyze coverage" >&2
        return 2
    fi

    # Output format
    if [[ "$format" == "human" ]]; then
        format_gap_report "$report"
    else
        echo "$report"
    fi

    # Exit code based on status
    local status
    status=$(echo "$report" | jq -r '.status')

    case "$status" in
        no_review_docs)
            return 0
            ;;
        ready_to_archive)
            return 0
            ;;
        gaps_detected)
            return 1
            ;;
        *)
            return 2
            ;;
    esac
}
