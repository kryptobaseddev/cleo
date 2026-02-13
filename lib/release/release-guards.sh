#!/usr/bin/env bash
# release-guards.sh - Epic-completeness and double-listing guard functions
#
# LAYER: 2 (Business Logic)
# DEPENDENCIES: (none - self-contained, uses inline jq queries)
# PROVIDES: check_epic_completeness, check_double_listing,
#           render_epic_completeness, render_double_listing
#
# @task T4433
# @epic T4431

#=== SOURCE GUARD ================================================
[[ -n "${_RELEASE_GUARDS_LOADED:-}" ]] && return 0
_RELEASE_GUARDS_LOADED=1

set -euo pipefail

# ============================================================================
# EPIC COMPLETENESS CHECK
# ============================================================================

# check_epic_completeness - Check whether all children of each epic are included
#
# For each task ID in the release list, walks parentId to find the epic ancestor.
# Groups release tasks by epic, then compares against all children of that epic.
# Missing children are categorized by status.
#
# Args:
#   $1 - JSON array of task IDs being released (e.g., '["T001","T002"]')
#   $2 - Path to todo.json
#
# Returns: 0 always (informational; blocking is handled by caller)
# Outputs: JSON object to stdout with epic completeness details
check_epic_completeness() {
    local release_ids_json="$1"
    local todo_file="$2"

    if [[ ! -f "$todo_file" ]]; then
        echo '{"hasIncomplete":false,"epics":[],"orphanTasks":[]}'
        return 0
    fi

    # Single jq invocation: walk parent chains, group by epic, diff children
    jq -c --argjson releaseIds "$release_ids_json" '
        # Build lookup maps
        .tasks as $tasks |
        ($tasks | map({(.id): .}) | add // {}) as $byId |

        # Function to find epic ancestor by walking parentId chain
        def find_epic($id):
            if $byId[$id] == null then null
            elif $byId[$id].type == "epic" then $id
            elif $byId[$id].parentId == null then null
            else
                $byId[$id].parentId as $pid |
                if $pid == null or $byId[$pid] == null then null
                elif $byId[$pid].type == "epic" then $pid
                elif $byId[$pid].parentId == null then null
                else
                    $byId[$pid].parentId as $gpid |
                    if $gpid == null or $byId[$gpid] == null then null
                    elif $byId[$gpid].type == "epic" then $gpid
                    else null
                    end
                end
            end;

        # For each release task, check if the task itself is an epic
        # If so, it IS the epic. Otherwise walk up.
        def resolve_epic($id):
            if $byId[$id] == null then null
            elif $byId[$id].type == "epic" then $id
            else find_epic($id)
            end;

        # Map each release task to its epic ancestor (or null)
        [ $releaseIds[] | . as $tid | {taskId: $tid, epicId: resolve_epic($tid)} ] as $mappings |

        # Orphan tasks: those with no epic ancestor
        [ $mappings[] | select(.epicId == null) | .taskId ] as $orphans |

        # Unique epic IDs (excluding nulls)
        [ $mappings[] | select(.epicId != null) | .epicId ] | unique as $epicIds |

        # Release task IDs as a set for quick lookup
        ($releaseIds | map({(.): true}) | add // {}) as $releaseSet |

        # Build epic report for each unique epic
        [
            $epicIds[] | . as $epicId |
            $byId[$epicId] as $epic |
            # Get all direct children of this epic
            [ $tasks[] | select(.parentId == $epicId) ] as $children |
            # Children included in the release
            [ $children[] | select($releaseSet[.id] == true) ] as $included |
            # Children NOT in the release
            [ $children[] | select($releaseSet[.id] != true) ] as $excluded |
            # Build missing list with status categorization
            {
                epicId: $epicId,
                epicTitle: ($epic.title // "Unknown"),
                totalChildren: ($children | length),
                includedCount: ($included | length),
                missing: [
                    $excluded[] | {
                        id: .id,
                        title: (.title // "Unknown"),
                        status: (.status // "pending")
                    }
                ]
            }
        ] as $epics |

        # Determine if any epic is incomplete
        ([ $epics[] | select((.missing | length) > 0) ] | length > 0) as $hasIncomplete |

        {
            hasIncomplete: $hasIncomplete,
            epics: $epics,
            orphanTasks: $orphans
        }
    ' "$todo_file"

    return 0
}

# ============================================================================
# DOUBLE-LISTING CHECK
# ============================================================================

# check_double_listing - Check if any release tasks appear in prior releases
#
# Queries all prior releases (status == "released", version != current) and
# checks if any current release task IDs overlap.
#
# Args:
#   $1 - JSON array of task IDs for current release
#   $2 - Current version string (e.g., "v0.95.0")
#   $3 - Path to todo.json
#
# Returns: 0 always (informational)
# Outputs: JSON object to stdout with overlap details
check_double_listing() {
    local release_ids_json="$1"
    local current_version="$2"
    local todo_file="$3"

    if [[ ! -f "$todo_file" ]]; then
        echo '{"hasOverlap":false,"overlaps":[]}'
        return 0
    fi

    jq -c --argjson releaseIds "$release_ids_json" --arg curVer "$current_version" '
        # Get all prior released releases (exclude current version)
        [
            (.project.releases // [])[] |
            select(.status == "released" and .version != $curVer)
        ] as $priorReleases |

        # For each release task, check if it appears in any prior release
        [
            $releaseIds[] | . as $tid |
            [
                $priorReleases[] |
                select(.tasks != null and (.tasks | index($tid) != null)) |
                .version
            ] as $foundIn |
            select(($foundIn | length) > 0) |
            {
                taskId: $tid,
                priorVersion: $foundIn[0]
            }
        ] as $overlaps |

        {
            hasOverlap: (($overlaps | length) > 0),
            overlaps: $overlaps
        }
    ' "$todo_file"

    return 0
}

# ============================================================================
# RENDERING FUNCTIONS
# ============================================================================

# render_epic_completeness - Render epic completeness results as text or JSON
#
# Args:
#   $1 - JSON result from check_epic_completeness
#   $2 - Format: "text" or "json"
#
# Text mode outputs human-readable warnings to stderr.
# JSON mode passes through the JSON structure to stdout.
render_epic_completeness() {
    local result_json="$1"
    local format="${2:-text}"

    if [[ "$format" == "json" ]]; then
        echo "$result_json"
        return 0
    fi

    # Text mode
    local has_incomplete
    has_incomplete=$(echo "$result_json" | jq -r '.hasIncomplete')

    if [[ "$has_incomplete" != "true" ]]; then
        local epic_count
        epic_count=$(echo "$result_json" | jq '.epics | length')
        if [[ "$epic_count" -gt 0 ]]; then
            echo "Epic Completeness: all epics complete" >&2
        fi
        return 0
    fi

    echo "Epic Completeness:" >&2

    # Iterate over epics
    local epic_count
    epic_count=$(echo "$result_json" | jq '.epics | length')
    local i=0

    while [[ $i -lt $epic_count ]]; do
        local epic_id epic_title total_children included_count missing_count
        epic_id=$(echo "$result_json" | jq -r ".epics[$i].epicId")
        epic_title=$(echo "$result_json" | jq -r ".epics[$i].epicTitle")
        total_children=$(echo "$result_json" | jq -r ".epics[$i].totalChildren")
        included_count=$(echo "$result_json" | jq -r ".epics[$i].includedCount")
        missing_count=$(echo "$result_json" | jq ".epics[$i].missing | length")

        if [[ "$missing_count" -eq 0 ]]; then
            printf "  %s (%s): %s/%s tasks included ✓\n" \
                "$epic_id" "$epic_title" "$included_count" "$total_children" >&2
        else
            printf "  %s (%s): %s/%s tasks included\n" \
                "$epic_id" "$epic_title" "$included_count" "$total_children" >&2

            # List missing tasks grouped by status
            local j=0
            while [[ $j -lt $missing_count ]]; do
                local m_id m_title m_status status_label
                m_id=$(echo "$result_json" | jq -r ".epics[$i].missing[$j].id")
                m_title=$(echo "$result_json" | jq -r ".epics[$i].missing[$j].title")
                m_status=$(echo "$result_json" | jq -r ".epics[$i].missing[$j].status")

                # Capitalize first letter of status for display
                status_label="$(echo "${m_status:0:1}" | tr '[:lower:]' '[:upper:]')${m_status:1}"

                printf "    ⚠ %-8s %s (%s)\n" "${status_label}:" "$m_id" "$m_title" >&2
                j=$((j + 1))
            done
        fi

        i=$((i + 1))
    done

    # Show orphan tasks if any
    local orphan_count
    orphan_count=$(echo "$result_json" | jq '.orphanTasks | length')
    if [[ "$orphan_count" -gt 0 ]]; then
        echo "  Orphan tasks (no epic ancestor):" >&2
        local k=0
        while [[ $k -lt $orphan_count ]]; do
            local orphan_id
            orphan_id=$(echo "$result_json" | jq -r ".orphanTasks[$k]")
            printf "    - %s\n" "$orphan_id" >&2
            k=$((k + 1))
        done
    fi

    return 0
}

# render_double_listing - Render double-listing results as text or JSON
#
# Args:
#   $1 - JSON result from check_double_listing
#   $2 - Format: "text" or "json"
#
# Text mode outputs warnings to stderr.
# JSON mode passes through the JSON structure to stdout.
render_double_listing() {
    local result_json="$1"
    local format="${2:-text}"

    if [[ "$format" == "json" ]]; then
        echo "$result_json"
        return 0
    fi

    # Text mode
    local has_overlap
    has_overlap=$(echo "$result_json" | jq -r '.hasOverlap')

    if [[ "$has_overlap" != "true" ]]; then
        return 0
    fi

    local overlap_count
    overlap_count=$(echo "$result_json" | jq '.overlaps | length')
    local i=0

    while [[ $i -lt $overlap_count ]]; do
        local task_id prior_version
        task_id=$(echo "$result_json" | jq -r ".overlaps[$i].taskId")
        prior_version=$(echo "$result_json" | jq -r ".overlaps[$i].priorVersion")
        printf "⚠ %s also appears in %s (double-listed)\n" "$task_id" "$prior_version" >&2
        i=$((i + 1))
    done

    return 0
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f check_epic_completeness
export -f check_double_listing
export -f render_epic_completeness
export -f render_double_listing
