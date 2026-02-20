#!/usr/bin/env bash
# staleness.sh - Stale task detection and categorization
#
# LAYER: 3 (Domain Logic)
# DEPENDENCIES: config.sh
# PROVIDES: is_task_stale, get_stale_tasks, categorize_staleness,
#           get_staleness_metadata
#
# Stale Indicators:
# - old_pending: Created > pendingDays ago, still pending (default: 30)
# - no_updates: No notes/updates in > noUpdateDays (default: 14)
# - long_blocked: Blocked for > blockedDays without progress (default: 7)
# - urgent_neglected: High/critical priority but untouched > urgentNeglectedDays (default: 7)

#=== SOURCE GUARD ================================================
[[ -n "${_STALENESS_LOADED:-}" ]] && return 0
declare -r _STALENESS_LOADED=1

set -euo pipefail

# ============================================================================
# LIBRARY DEPENDENCIES
# ============================================================================

_STALENESS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source config library for unified config access
if [[ -f "$_STALENESS_LIB_DIR/core/config.sh" ]]; then
    # shellcheck source=lib/core/config.sh
    source "$_STALENESS_LIB_DIR/core/config.sh"
fi

# ============================================================================
# DEFAULT CONFIGURATION VALUES
# ============================================================================

# Default staleness thresholds (used when config not available)
readonly STALE_DEFAULT_PENDING_DAYS=30
readonly STALE_DEFAULT_NO_UPDATE_DAYS=14
readonly STALE_DEFAULT_BLOCKED_DAYS=7
readonly STALE_DEFAULT_URGENT_NEGLECTED_DAYS=7

# ============================================================================
# CONFIGURATION GETTERS
# ============================================================================

#######################################
# Check if stale detection is enabled
# Returns: "true" or "false" (default: true)
#######################################
get_stale_detection_enabled() {
    if declare -f get_config_value >/dev/null 2>&1; then
        get_config_value "analyze.staleDetection.enabled" "true"
    else
        echo "true"
    fi
}

#######################################
# Get pending days threshold
# Returns: integer (default: 30)
#######################################
get_stale_pending_days() {
    if declare -f get_config_value >/dev/null 2>&1; then
        get_config_value "analyze.staleDetection.pendingDays" "$STALE_DEFAULT_PENDING_DAYS"
    else
        echo "$STALE_DEFAULT_PENDING_DAYS"
    fi
}

#######################################
# Get no-update days threshold
# Returns: integer (default: 14)
#######################################
get_stale_no_update_days() {
    if declare -f get_config_value >/dev/null 2>&1; then
        get_config_value "analyze.staleDetection.noUpdateDays" "$STALE_DEFAULT_NO_UPDATE_DAYS"
    else
        echo "$STALE_DEFAULT_NO_UPDATE_DAYS"
    fi
}

#######################################
# Get blocked days threshold
# Returns: integer (default: 7)
#######################################
get_stale_blocked_days() {
    if declare -f get_config_value >/dev/null 2>&1; then
        get_config_value "analyze.staleDetection.blockedDays" "$STALE_DEFAULT_BLOCKED_DAYS"
    else
        echo "$STALE_DEFAULT_BLOCKED_DAYS"
    fi
}

#######################################
# Get urgent neglected days threshold
# Returns: integer (default: 7)
#######################################
get_stale_urgent_neglected_days() {
    if declare -f get_config_value >/dev/null 2>&1; then
        get_config_value "analyze.staleDetection.urgentNeglectedDays" "$STALE_DEFAULT_URGENT_NEGLECTED_DAYS"
    else
        echo "$STALE_DEFAULT_URGENT_NEGLECTED_DAYS"
    fi
}

#######################################
# Get entire staleDetection config section as JSON
# Returns: JSON object with all staleDetection settings
#######################################
get_stale_detection_config() {
    local enabled pending_days no_update_days blocked_days urgent_neglected_days

    enabled=$(get_stale_detection_enabled)
    pending_days=$(get_stale_pending_days)
    no_update_days=$(get_stale_no_update_days)
    blocked_days=$(get_stale_blocked_days)
    urgent_neglected_days=$(get_stale_urgent_neglected_days)

    jq -nc \
        --argjson enabled "$enabled" \
        --argjson pendingDays "$pending_days" \
        --argjson noUpdateDays "$no_update_days" \
        --argjson blockedDays "$blocked_days" \
        --argjson urgentNeglectedDays "$urgent_neglected_days" \
        '{
            enabled: $enabled,
            pendingDays: $pendingDays,
            noUpdateDays: $noUpdateDays,
            blockedDays: $blockedDays,
            urgentNeglectedDays: $urgentNeglectedDays
        }'
}

# ============================================================================
# STALENESS DETECTION FUNCTIONS
# ============================================================================

#######################################
# Categorize the staleness type for a task
# Arguments:
#   $1 - Task JSON (single task object)
#   $2 - Config JSON (optional, uses defaults if not provided)
# Outputs:
#   Staleness type: 'old_pending' | 'no_updates' | 'long_blocked' | 'urgent_neglected' | null
# Returns:
#   0 on success (outputs type or null)
#   1 on error (invalid input)
#######################################
categorize_staleness() {
    local task_json="$1"
    local config_json="${2:-}"

    # Validate task JSON
    if [[ -z "$task_json" ]] || ! echo "$task_json" | jq -e '.' >/dev/null 2>&1; then
        echo "ERROR: Invalid task JSON" >&2
        return 1
    fi

    # Get config values - use provided config or fetch from config getters
    local pending_days no_update_days blocked_days urgent_neglected_days

    if [[ -n "$config_json" ]] && echo "$config_json" | jq -e '.' >/dev/null 2>&1; then
        pending_days=$(echo "$config_json" | jq -r '.pendingDays // '"$STALE_DEFAULT_PENDING_DAYS")
        no_update_days=$(echo "$config_json" | jq -r '.noUpdateDays // '"$STALE_DEFAULT_NO_UPDATE_DAYS")
        blocked_days=$(echo "$config_json" | jq -r '.blockedDays // '"$STALE_DEFAULT_BLOCKED_DAYS")
        urgent_neglected_days=$(echo "$config_json" | jq -r '.urgentNeglectedDays // '"$STALE_DEFAULT_URGENT_NEGLECTED_DAYS")
    else
        pending_days=$(get_stale_pending_days)
        no_update_days=$(get_stale_no_update_days)
        blocked_days=$(get_stale_blocked_days)
        urgent_neglected_days=$(get_stale_urgent_neglected_days)
    fi

    # Calculate staleness using jq
    # Priority order (return most severe first):
    # 1. urgent_neglected (high/critical priority neglected)
    # 2. long_blocked (blocked for too long)
    # 3. old_pending (pending for too long)
    # 4. no_updates (no activity for too long)
    echo "$task_json" | jq -r --argjson pending_days "$pending_days" \
        --argjson no_update_days "$no_update_days" \
        --argjson blocked_days "$blocked_days" \
        --argjson urgent_neglected_days "$urgent_neglected_days" \
        '
        # Skip done or cancelled tasks
        if .status == "done" or .status == "cancelled" then
            null
        else
            # Get current time
            now as $now |

            # Parse timestamps (handle null/missing gracefully)
            (if .createdAt then (.createdAt | fromdateiso8601) else $now end) as $created |

            # Find last update time (most recent note or createdAt)
            # Notes can be:
            # - strings with embedded timestamps: "2025-12-17 00:02:40 UTC: content"
            # - objects with timestamp field: {"timestamp": "...", "content": "..."}
            (
                if .notes and (.notes | length) > 0 then
                    (.notes | map(
                        if type == "string" then
                            # Extract timestamp from string format "YYYY-MM-DD HH:MM:SS UTC: ..."
                            # Convert to ISO8601 format for parsing
                            (capture("^(?<date>[0-9]{4}-[0-9]{2}-[0-9]{2}) (?<time>[0-9]{2}:[0-9]{2}:[0-9]{2}) UTC") // null) |
                            if . then "\(.date)T\(.time)Z" | fromdateiso8601
                            else $created
                            end
                        elif type == "object" then
                            # Object format with timestamp field
                            if .timestamp then (.timestamp | fromdateiso8601)
                            else $created
                            end
                        else
                            $created
                        end
                    ) | max)
                else
                    $created
                end
            ) as $last_update |

            # Calculate days since various events
            (($now - $created) / 86400 | floor) as $days_since_created |
            (($now - $last_update) / 86400 | floor) as $days_since_update |

            # Check staleness conditions in priority order
            if (.priority == "critical" or .priority == "high") and
               .status != "blocked" and
               $days_since_update > $urgent_neglected_days then
                "urgent_neglected"
            elif .status == "blocked" and $days_since_update > $blocked_days then
                "long_blocked"
            elif .status == "pending" and $days_since_created > $pending_days then
                "old_pending"
            elif $days_since_update > $no_update_days then
                "no_updates"
            else
                null
            end
        end
        '
}

#######################################
# Check if a task is stale
# Arguments:
#   $1 - Task JSON (single task object)
#   $2 - Config JSON (optional)
# Returns:
#   0 if task is stale (true)
#   1 if task is not stale (false)
#   2 on error
#######################################
is_task_stale() {
    local task_json="$1"
    local config_json="${2:-}"

    local staleness_type
    staleness_type=$(categorize_staleness "$task_json" "$config_json") || return 2

    # Check if staleness type is not null
    if [[ "$staleness_type" != "null" && -n "$staleness_type" ]]; then
        return 0  # Stale
    else
        return 1  # Not stale
    fi
}

#######################################
# Get staleness metadata for a task
# Arguments:
#   $1 - Task JSON (single task object)
#   $2 - Config JSON (optional)
# Outputs:
#   JSON object with staleness metadata or null if not stale
#   {
#     "type": "old_pending",
#     "daysSinceCreated": 45,
#     "daysSinceUpdate": 30,
#     "reason": "Created 45 days ago, no updates"
#   }
# Returns:
#   0 on success
#   1 on error
#######################################
get_staleness_metadata() {
    local task_json="$1"
    local config_json="${2:-}"

    # Validate task JSON
    if [[ -z "$task_json" ]] || ! echo "$task_json" | jq -e '.' >/dev/null 2>&1; then
        echo "ERROR: Invalid task JSON" >&2
        return 1
    fi

    # Get config values
    local pending_days no_update_days blocked_days urgent_neglected_days

    if [[ -n "$config_json" ]] && echo "$config_json" | jq -e '.' >/dev/null 2>&1; then
        pending_days=$(echo "$config_json" | jq -r '.pendingDays // '"$STALE_DEFAULT_PENDING_DAYS")
        no_update_days=$(echo "$config_json" | jq -r '.noUpdateDays // '"$STALE_DEFAULT_NO_UPDATE_DAYS")
        blocked_days=$(echo "$config_json" | jq -r '.blockedDays // '"$STALE_DEFAULT_BLOCKED_DAYS")
        urgent_neglected_days=$(echo "$config_json" | jq -r '.urgentNeglectedDays // '"$STALE_DEFAULT_URGENT_NEGLECTED_DAYS")
    else
        pending_days=$(get_stale_pending_days)
        no_update_days=$(get_stale_no_update_days)
        blocked_days=$(get_stale_blocked_days)
        urgent_neglected_days=$(get_stale_urgent_neglected_days)
    fi

    echo "$task_json" | jq --argjson pending_days "$pending_days" \
        --argjson no_update_days "$no_update_days" \
        --argjson blocked_days "$blocked_days" \
        --argjson urgent_neglected_days "$urgent_neglected_days" \
        '
        # Skip done or cancelled tasks
        if .status == "done" or .status == "cancelled" then
            null
        else
            now as $now |

            # Parse timestamps
            (if .createdAt then (.createdAt | fromdateiso8601) else $now end) as $created |

            # Find last update time
            # Notes can be strings ("YYYY-MM-DD HH:MM:SS UTC: ...") or objects with timestamp field
            (
                if .notes and (.notes | length) > 0 then
                    (.notes | map(
                        if type == "string" then
                            (capture("^(?<date>[0-9]{4}-[0-9]{2}-[0-9]{2}) (?<time>[0-9]{2}:[0-9]{2}:[0-9]{2}) UTC") // null) |
                            if . then "\(.date)T\(.time)Z" | fromdateiso8601
                            else $created
                            end
                        elif type == "object" then
                            if .timestamp then (.timestamp | fromdateiso8601)
                            else $created
                            end
                        else
                            $created
                        end
                    ) | max)
                else
                    $created
                end
            ) as $last_update |

            # Calculate days
            (($now - $created) / 86400 | floor) as $days_since_created |
            (($now - $last_update) / 86400 | floor) as $days_since_update |

            # Determine staleness type and reason
            if (.priority == "critical" or .priority == "high") and
               .status != "blocked" and
               $days_since_update > $urgent_neglected_days then
                {
                    type: "urgent_neglected",
                    daysSinceCreated: $days_since_created,
                    daysSinceUpdate: $days_since_update,
                    reason: "\(.priority | ascii_upcase) priority task untouched for \($days_since_update) days"
                }
            elif .status == "blocked" and $days_since_update > $blocked_days then
                {
                    type: "long_blocked",
                    daysSinceCreated: $days_since_created,
                    daysSinceUpdate: $days_since_update,
                    reason: "Blocked for \($days_since_update) days without progress"
                }
            elif .status == "pending" and $days_since_created > $pending_days then
                {
                    type: "old_pending",
                    daysSinceCreated: $days_since_created,
                    daysSinceUpdate: $days_since_update,
                    reason: "Created \($days_since_created) days ago, still pending"
                }
            elif $days_since_update > $no_update_days then
                {
                    type: "no_updates",
                    daysSinceCreated: $days_since_created,
                    daysSinceUpdate: $days_since_update,
                    reason: "No updates for \($days_since_update) days"
                }
            else
                null
            end
        end
        '
}

#######################################
# Get all stale tasks from a todo file
# Arguments:
#   $1 - Path to todo.json file
#   $2 - Config JSON (optional)
# Outputs:
#   JSON array of stale tasks with metadata:
#   [
#     {
#       "taskId": "T123",
#       "title": "...",
#       "priority": "high",
#       "status": "pending",
#       "staleness": {
#         "type": "old_pending",
#         "daysSinceCreated": 45,
#         "daysSinceUpdate": 30,
#         "reason": "Created 45 days ago, no updates"
#       }
#     }
#   ]
# Returns:
#   0 on success
#   1 on error
#######################################
get_stale_tasks() {
    local todo_file="$1"
    local config_json="${2:-}"

    # Validate file exists
    if [[ ! -f "$todo_file" ]]; then
        echo "ERROR: File not found: $todo_file" >&2
        return 1
    fi

    # Get config values
    local pending_days no_update_days blocked_days urgent_neglected_days

    if [[ -n "$config_json" ]] && echo "$config_json" | jq -e '.' >/dev/null 2>&1; then
        pending_days=$(echo "$config_json" | jq -r '.pendingDays // '"$STALE_DEFAULT_PENDING_DAYS")
        no_update_days=$(echo "$config_json" | jq -r '.noUpdateDays // '"$STALE_DEFAULT_NO_UPDATE_DAYS")
        blocked_days=$(echo "$config_json" | jq -r '.blockedDays // '"$STALE_DEFAULT_BLOCKED_DAYS")
        urgent_neglected_days=$(echo "$config_json" | jq -r '.urgentNeglectedDays // '"$STALE_DEFAULT_URGENT_NEGLECTED_DAYS")
    else
        pending_days=$(get_stale_pending_days)
        no_update_days=$(get_stale_no_update_days)
        blocked_days=$(get_stale_blocked_days)
        urgent_neglected_days=$(get_stale_urgent_neglected_days)
    fi

    # Process all tasks and filter stale ones
    jq --argjson pending_days "$pending_days" \
        --argjson no_update_days "$no_update_days" \
        --argjson blocked_days "$blocked_days" \
        --argjson urgent_neglected_days "$urgent_neglected_days" \
        '
        now as $now |

        # Process each task
        [.tasks[] |
            # Skip done or cancelled tasks
            select(.status != "done" and .status != "cancelled") |

            # Parse timestamps
            (if .createdAt then (.createdAt | fromdateiso8601) else $now end) as $created |

            # Find last update time
            # Notes can be strings ("YYYY-MM-DD HH:MM:SS UTC: ...") or objects with timestamp field
            (
                if .notes and (.notes | length) > 0 then
                    (.notes | map(
                        if type == "string" then
                            (capture("^(?<date>[0-9]{4}-[0-9]{2}-[0-9]{2}) (?<time>[0-9]{2}:[0-9]{2}:[0-9]{2}) UTC") // null) |
                            if . then "\(.date)T\(.time)Z" | fromdateiso8601
                            else $created
                            end
                        elif type == "object" then
                            if .timestamp then (.timestamp | fromdateiso8601)
                            else $created
                            end
                        else
                            $created
                        end
                    ) | max)
                else
                    $created
                end
            ) as $last_update |

            # Calculate days
            (($now - $created) / 86400 | floor) as $days_since_created |
            (($now - $last_update) / 86400 | floor) as $days_since_update |

            # Determine staleness
            (
                if (.priority == "critical" or .priority == "high") and
                   .status != "blocked" and
                   $days_since_update > $urgent_neglected_days then
                    {
                        type: "urgent_neglected",
                        daysSinceCreated: $days_since_created,
                        daysSinceUpdate: $days_since_update,
                        reason: "\(.priority | ascii_upcase) priority task untouched for \($days_since_update) days"
                    }
                elif .status == "blocked" and $days_since_update > $blocked_days then
                    {
                        type: "long_blocked",
                        daysSinceCreated: $days_since_created,
                        daysSinceUpdate: $days_since_update,
                        reason: "Blocked for \($days_since_update) days without progress"
                    }
                elif .status == "pending" and $days_since_created > $pending_days then
                    {
                        type: "old_pending",
                        daysSinceCreated: $days_since_created,
                        daysSinceUpdate: $days_since_update,
                        reason: "Created \($days_since_created) days ago, still pending"
                    }
                elif $days_since_update > $no_update_days then
                    {
                        type: "no_updates",
                        daysSinceCreated: $days_since_created,
                        daysSinceUpdate: $days_since_update,
                        reason: "No updates for \($days_since_update) days"
                    }
                else
                    null
                end
            ) as $staleness |

            # Only include stale tasks
            select($staleness != null) |
            {
                taskId: .id,
                title: .title,
                priority: .priority,
                status: .status,
                phase: .phase,
                type: .type,
                staleness: $staleness
            }
        ] |

        # Sort by severity: urgent_neglected > long_blocked > old_pending > no_updates
        # Then by days (most stale first)
        sort_by(
            (if .staleness.type == "urgent_neglected" then 0
             elif .staleness.type == "long_blocked" then 1
             elif .staleness.type == "old_pending" then 2
             else 3 end),
            -(.staleness.daysSinceUpdate // 0)
        )
        ' "$todo_file"
}

# ============================================================================
# EXPORTS
# ============================================================================

export -f get_stale_detection_enabled
export -f get_stale_pending_days
export -f get_stale_no_update_days
export -f get_stale_blocked_days
export -f get_stale_urgent_neglected_days
export -f get_stale_detection_config
export -f categorize_staleness
export -f is_task_stale
export -f get_staleness_metadata
export -f get_stale_tasks
