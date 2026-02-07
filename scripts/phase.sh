#!/usr/bin/env bash
###CLEO
# command: phase
# category: write
# synopsis: Project-level phase lifecycle management (set, show, transitions)
# relevance: medium
# flags: --format,--quiet
# exits: 0,2,4
# json-output: true
# subcommands: set,show,history
###END
# Project-level phase management for cleo
# Usage: cleo phase <subcommand> [args]
# Subcommands: show, set, start, complete, advance, list

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEO_HOME="${CLEO_HOME:-$HOME/.cleo}"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Source libraries with dual-path fallback (Layer 0: Foundation)
# shellcheck source=../lib/exit-codes.sh
if [[ -f "$CLEO_HOME/lib/exit-codes.sh" ]]; then
    source "$CLEO_HOME/lib/exit-codes.sh"
elif [[ -f "$LIB_DIR/exit-codes.sh" ]]; then
    source "$LIB_DIR/exit-codes.sh"
fi

if [[ -f "$CLEO_HOME/lib/platform-compat.sh" ]]; then
    source "$CLEO_HOME/lib/platform-compat.sh"
elif [[ -f "$LIB_DIR/platform-compat.sh" ]]; then
    source "$LIB_DIR/platform-compat.sh"
fi

# Source libraries (Layer 1: Core Infrastructure)
if [[ -f "$CLEO_HOME/lib/error-json.sh" ]]; then
    source "$CLEO_HOME/lib/error-json.sh"
elif [[ -f "$LIB_DIR/error-json.sh" ]]; then
    source "$LIB_DIR/error-json.sh"
fi

if [[ -f "$CLEO_HOME/lib/output-format.sh" ]]; then
    source "$CLEO_HOME/lib/output-format.sh"
elif [[ -f "$LIB_DIR/output-format.sh" ]]; then
    source "$LIB_DIR/output-format.sh"
fi

# Source libraries (Layer 2: Core Services)
if [[ -f "$CLEO_HOME/lib/validation.sh" ]]; then
    source "$CLEO_HOME/lib/validation.sh"
elif [[ -f "$LIB_DIR/validation.sh" ]]; then
    source "$LIB_DIR/validation.sh"
fi

if [[ -f "$CLEO_HOME/lib/file-ops.sh" ]]; then
    source "$CLEO_HOME/lib/file-ops.sh"
elif [[ -f "$LIB_DIR/file-ops.sh" ]]; then
    source "$LIB_DIR/file-ops.sh"
fi

if [[ -f "$CLEO_HOME/lib/phase-tracking.sh" ]]; then
    source "$CLEO_HOME/lib/phase-tracking.sh"
elif [[ -f "$LIB_DIR/phase-tracking.sh" ]]; then
    source "$LIB_DIR/phase-tracking.sh"
fi

if [[ -f "$CLEO_HOME/lib/logging.sh" ]]; then
    source "$CLEO_HOME/lib/logging.sh"
elif [[ -f "$LIB_DIR/logging.sh" ]]; then
    source "$LIB_DIR/logging.sh"
fi

if [[ -f "$CLEO_HOME/lib/config.sh" ]]; then
    source "$CLEO_HOME/lib/config.sh"
elif [[ -f "$LIB_DIR/config.sh" ]]; then
    source "$LIB_DIR/config.sh"
fi

# Source version library for proper version management
if [[ -f "$CLEO_HOME/lib/version.sh" ]]; then
    source "$CLEO_HOME/lib/version.sh"
elif [[ -f "$LIB_DIR/version.sh" ]]; then
    source "$LIB_DIR/version.sh"
fi

# Source centralized flag parsing
if [[ -f "$CLEO_HOME/lib/flags.sh" ]]; then
    source "$CLEO_HOME/lib/flags.sh"
elif [[ -f "$LIB_DIR/flags.sh" ]]; then
    source "$LIB_DIR/flags.sh"
fi

# Globals
TODO_FILE="${CLEO_DIR:-.cleo}/todo.json"
FORMAT=""
COMMAND_NAME="phase"
readonly COMMAND_NAME
DRY_RUN=false
QUIET=false

# SUBCOMMANDS

# Show current phase
cmd_show() {
    local current_phase
    current_phase=$(get_current_phase "$TODO_FILE")

    if [[ -z "$current_phase" || "$current_phase" == "null" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg version "${CLEO_VERSION:-$(get_version)}" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase show",
                        "timestamp": $ts,
                        "version": $version,
                        "format": "json"
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_NOT_SET",
                        "message": "No current phase set"
                    }
                }'
        else
            echo "No current phase set"
        fi
        return "$EXIT_NOT_FOUND"
    fi

    local phase_info
    phase_info=$(get_phase "$current_phase" "$TODO_FILE")

    if [[ "$FORMAT" == "json" ]]; then
        local timestamp
        timestamp=$(get_iso_timestamp)
        echo "$phase_info" | jq \
            --arg ts "$timestamp" \
            --arg slug "$current_phase" \
            --arg version "${CLEO_VERSION:-$(get_version)}" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "command": "phase show",
                    "timestamp": $ts,
                    "version": $version,
                    "format": "json"
                },
                "success": true,
                "currentPhase": {
                    "slug": $slug,
                    "name": .name,
                    "status": .status,
                    "startedAt": (.startedAt // null),
                    "completedAt": (.completedAt // null)
                }
            }'
    else
        echo "Current Phase: $current_phase"
        echo "$phase_info" | jq -r '"  Name: \(.name)\n  Status: \(.status)\n  Started: \(.startedAt // "not started")"'
    fi
}

# Set current phase
cmd_set() {
    local slug=""
    local allow_rollback=false
    local force=false

    # Parse flags
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --rollback)
                allow_rollback=true
                shift
                ;;
            --force)
                force=true
                shift
                ;;
            *)
                if [[ -z "$slug" ]]; then
                    slug="$1"
                    shift
                else
                    output_error "$E_INPUT_INVALID" "Unexpected argument: $1"
                    return "$EXIT_INVALID_INPUT"
                fi
                ;;
        esac
    done

    if [[ -z "$slug" ]]; then
        output_error "$E_INPUT_MISSING" "Phase slug required"
        return "$EXIT_INVALID_INPUT"
    fi

    local old_phase
    old_phase=$(get_current_phase "$TODO_FILE")

    # Validate phase exists before attempting set
    # Handle legacy data where .project may be a string (pre-v2.2.0)
    if ! jq -e --arg slug "$slug" '(.project | type) == "object" and .project.phases[$slug] != null' "$TODO_FILE" >/dev/null 2>&1; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$slug" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase set",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_NOT_FOUND",
                        "message": ("Phase '\''" + $slug + "'\'' does not exist")
                    }
                }'
        else
            output_error "$E_PHASE_NOT_FOUND" "Phase '$slug' does not exist"
        fi
        return "$EXIT_NOT_FOUND"
    fi

    # Detect rollback by comparing phase orders
    if [[ -n "$old_phase" && "$old_phase" != "null" ]]; then
        local old_order new_order old_name new_name
        # Handle legacy data where .project may be a string (pre-v2.2.0)
        old_order=$(jq -r --arg slug "$old_phase" '(if (.project | type) == "object" then .project.phases[$slug].order else null end) // 0' "$TODO_FILE")
        new_order=$(jq -r --arg slug "$slug" '(if (.project | type) == "object" then .project.phases[$slug].order else null end) // 0' "$TODO_FILE")

        if [[ "$new_order" -lt "$old_order" ]]; then
            # This is a rollback
            old_name=$(jq -r --arg slug "$old_phase" '(if (.project | type) == "object" then .project.phases[$slug].name else null end) // $slug' "$TODO_FILE")
            new_name=$(jq -r --arg slug "$slug" '(if (.project | type) == "object" then .project.phases[$slug].name else null end) // $slug' "$TODO_FILE")

            if [[ "$allow_rollback" != true ]]; then
                if [[ "$FORMAT" == "json" ]]; then
                    local timestamp
                    timestamp=$(get_iso_timestamp)
                    jq -nc \
                        --arg ts "$timestamp" \
                        --arg from "$old_phase" \
                        --arg to "$slug" \
                        --argjson from_order "$old_order" \
                        --argjson to_order "$new_order" \
                        '{
                            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                            "_meta": {
                                "command": "phase set",
                                "timestamp": $ts
                            },
                            "success": false,
                            "error": {
                                "code": "E_PHASE_ROLLBACK_FORBIDDEN",
                                "message": ("Rolling back from '\''" + $from + "'\'' (order " + ($from_order | tostring) + ") to '\''" + $to + "'\'' (order " + ($to_order | tostring) + ") requires --rollback flag"),
                                "fromPhase": $from,
                                "toPhase": $to,
                                "fromOrder": $from_order,
                                "toOrder": $to_order
                            }
                        }'
                else
                    output_error "$E_PHASE_INVALID" "Rolling back from '$old_name' (order $old_order) to '$new_name' (order $new_order) requires --rollback flag"
                fi
                return "$EXIT_VALIDATION_ERROR"
            fi

            # Confirmation prompt unless --force
            if [[ "$force" != true ]]; then
                if [[ "$FORMAT" == "json" ]]; then
                    # JSON mode always requires --force for non-interactive
                    local timestamp
                    timestamp=$(get_iso_timestamp)
                    jq -nc \
                        --arg ts "$timestamp" \
                        '{
                            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                            "_meta": {
                                "command": "phase set",
                                "timestamp": $ts
                            },
                            "success": false,
                            "error": {
                                "code": "E_PHASE_ROLLBACK_REQUIRES_FORCE",
                                "message": "Rollback requires --force flag in JSON mode (non-interactive)"
                            }
                        }'
                    return "$EXIT_VALIDATION_ERROR"
                else
                    echo "WARNING: This will rollback from '$old_name' (order $old_order) to '$new_name' (order $new_order)." >&2
                    read -p "Continue? [y/N] " -n 1 -r
                    echo
                    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                        echo "Rollback cancelled"
                        return "$EXIT_SUCCESS"
                    fi
                fi
            fi
        fi

        # Check for phase skipping (warnOnPhaseSkip config)
        local warn_on_skip=true
        if declare -f should_warn_on_phase_skip >/dev/null 2>&1; then
            warn_on_skip=$(should_warn_on_phase_skip)
        elif declare -f get_config_value >/dev/null 2>&1; then
            warn_on_skip=$(get_config_value "validation.phaseValidation.warnOnPhaseSkip" "true")
        fi

        if [[ "$warn_on_skip" == "true" && "$new_order" -gt "$((old_order + 1))" ]]; then
            # Skipping phases forward
            local skipped_count=$((new_order - old_order - 1))
            if [[ "$FORMAT" == "json" ]]; then
                # Just include warning in success response later
                :
            else
                echo "WARNING: Skipping $skipped_count intermediate phase(s) from '$old_phase' (order $old_order) to '$slug' (order $new_order)." >&2
            fi
        fi
    fi

    # Handle dry-run mode
    if [[ "$DRY_RUN" == "true" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg prev "${old_phase:-null}" \
                --arg curr "$slug" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase set",
                        "timestamp": $ts
                    },
                    "success": true,
                    "dryRun": true,
                    "wouldSet": {
                        "previousPhase": (if $prev == "null" or $prev == "" then null else $prev end),
                        "newPhase": $curr
                    }
                }'
        else
            echo "[DRY-RUN] Would set phase to: $slug (from ${old_phase:-none})"
        fi
        return "$EXIT_SUCCESS"
    fi

    if set_current_phase "$slug" "$TODO_FILE" 2>/dev/null; then
        # Determine if this was a rollback (comparing orders)
        local is_rollback=false
        local is_skip=false
        local skipped_phases=0
        if [[ -n "$old_phase" && "$old_phase" != "null" && "$old_phase" != "none" ]]; then
            local check_old_order check_new_order
            # Handle legacy data where .project may be a string (pre-v2.2.0)
            check_old_order=$(jq -r --arg slug "$old_phase" '(if (.project | type) == "object" then .project.phases[$slug].order else null end) // 0' "$TODO_FILE")
            check_new_order=$(jq -r --arg slug "$slug" '(if (.project | type) == "object" then .project.phases[$slug].order else null end) // 0' "$TODO_FILE")
            if [[ "$check_new_order" -lt "$check_old_order" ]]; then
                is_rollback=true
            elif [[ "$check_new_order" -gt "$((check_old_order + 1))" ]]; then
                is_skip=true
                skipped_phases=$((check_new_order - check_old_order - 1))
            fi
        fi

        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            # Build warning message if skipping phases
            local skip_warning=""
            if [[ "$is_skip" == "true" ]]; then
                skip_warning="Skipped $skipped_phases intermediate phase(s)"
            fi
            jq -nc \
                --arg ts "$timestamp" \
                --arg prev "${old_phase:-null}" \
                --arg curr "$slug" \
                --argjson rollback "$is_rollback" \
                --argjson skip "$is_skip" \
                --argjson skippedCount "$skipped_phases" \
                --arg skipWarning "$skip_warning" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase set",
                        "timestamp": $ts
                    },
                    "success": true,
                    "previousPhase": (if $prev == "null" or $prev == "" then null else $prev end),
                    "currentPhase": $curr,
                    "isRollback": $rollback,
                    "isSkip": $skip
                } + (if $skip then {
                    "skippedPhases": $skippedCount,
                    "warning": $skipWarning
                } else {} end)'
        else
            if [[ "$is_rollback" == "true" ]]; then
                echo "Phase rolled back to: $slug (from ${old_phase})"
            elif [[ "$is_skip" == "true" ]]; then
                echo "Phase set to: $slug (skipped $skipped_phases intermediate phase(s))"
            else
                echo "Phase set to: $slug"
            fi
        fi

        # Log with appropriate function based on rollback status
        if [[ "$is_rollback" == "true" ]]; then
            log_phase_rollback "${old_phase}" "$slug" "Manual rollback via phase set --rollback"
            # Record rollback in phase history
            add_phase_history_entry "$slug" "rollback" "$TODO_FILE" "${old_phase}" "Rollback from ${old_phase} to ${slug} via phase set --rollback"
        else
            log_phase_changed "${old_phase:-none}" "$slug"
        fi
    else
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$slug" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase set",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_SET_FAILED",
                        "message": ("Failed to set phase to '\''" + $slug + "'\''")
                    }
                }'
        fi
        return "$EXIT_GENERAL_ERROR"
    fi
}

# Start a phase (pending → active)
cmd_start() {
    local slug="$1"

    # Check phase exists
    # Handle legacy data where .project may be a string (pre-v2.2.0)
    if ! jq -e --arg slug "$slug" '(.project | type) == "object" and .project.phases[$slug] != null' "$TODO_FILE" >/dev/null 2>&1; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$slug" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase start",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_NOT_FOUND",
                        "message": ("Phase '\''" + $slug + "'\'' does not exist")
                    }
                }'
        else
            output_error "$E_PHASE_NOT_FOUND" "Phase '$slug' does not exist"
        fi
        return "$EXIT_NOT_FOUND"
    fi

    # Check phase status
    local current_status
    current_status=$(get_phase_status "$slug" "$TODO_FILE")
    if [[ "$current_status" != "pending" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$slug" \
                --arg status "$current_status" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase start",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_INVALID_STATUS",
                        "message": ("Can only start pending phases. Phase '\''" + $slug + "'\'' has status '\''" + $status + "'\''")
                    }
                }'
        else
            output_error "$E_PHASE_INVALID" "Can only start pending phases (current: $current_status)"
        fi
        return "$EXIT_INVALID_INPUT"
    fi

    if start_phase "$slug" "$TODO_FILE" 2>/dev/null; then
        local started_at
        started_at=$(get_iso_timestamp)
        if [[ "$FORMAT" == "json" ]]; then
            jq -nc \
                --arg ts "$started_at" \
                --arg slug "$slug" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase start",
                        "timestamp": $ts
                    },
                    "success": true,
                    "phase": $slug,
                    "startedAt": $ts
                }'
        else
            echo "Started phase: $slug"
        fi
        log_phase_started "$slug"
        # Record in phase history
        add_phase_history_entry "$slug" "started" "$TODO_FILE" "null" "Phase started via 'phase start'"
    else
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$slug" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase start",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_START_FAILED",
                        "message": ("Failed to start phase '\''" + $slug + "'\''")
                    }
                }'
        fi
        return "$EXIT_GENERAL_ERROR"
    fi
}

# Complete a phase (active → completed)
cmd_complete() {
    local slug="$1"
    local started_at

    # Check phase exists
    # Handle legacy data where .project may be a string (pre-v2.2.0)
    if ! jq -e --arg slug "$slug" '(.project | type) == "object" and .project.phases[$slug] != null' "$TODO_FILE" >/dev/null 2>&1; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$slug" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase complete",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_NOT_FOUND",
                        "message": ("Phase '\''" + $slug + "'\'' does not exist")
                    }
                }'
        else
            output_error "$E_PHASE_NOT_FOUND" "Phase '$slug' does not exist"
        fi
        return "$EXIT_NOT_FOUND"
    fi

    # Check phase status
    local current_status
    current_status=$(get_phase_status "$slug" "$TODO_FILE")
    if [[ "$current_status" != "active" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$slug" \
                --arg status "$current_status" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase complete",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_INVALID_STATUS",
                        "message": ("Can only complete active phases. Phase '\''" + $slug + "'\'' has status '\''" + $status + "'\''")
                    }
                }'
        else
            output_error "$E_PHASE_INVALID" "Can only complete active phases (current: $current_status)"
        fi
        return "$EXIT_INVALID_INPUT"
    fi

    # Check for incomplete tasks
    local incomplete_count
    incomplete_count=$(jq --arg phase "$slug" '
        [.tasks[] | select(.phase == $phase and .status != "done")] | length
    ' "$TODO_FILE")

    if [[ "$incomplete_count" -gt 0 ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$slug" \
                --argjson count "$incomplete_count" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase complete",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_INCOMPLETE_TASKS",
                        "message": ("Cannot complete phase '\''" + $slug + "'\'' - " + ($count | tostring) + " incomplete task(s) pending"),
                        "incompleteTasks": $count
                    }
                }'
        else
            output_error "$E_VALIDATION_REQUIRED" "Cannot complete phase '$slug' - $incomplete_count incomplete task(s) pending"
        fi
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Handle legacy data where .project may be a string (pre-v2.2.0)
    started_at=$(jq -r --arg slug "$slug" '(if (.project | type) == "object" then .project.phases[$slug].startedAt else null end) // null' "$TODO_FILE")

    if complete_phase "$slug" "$TODO_FILE" 2>/dev/null; then
        local completed_at
        completed_at=$(get_iso_timestamp)
        if [[ "$FORMAT" == "json" ]]; then
            jq -nc \
                --arg ts "$completed_at" \
                --arg slug "$slug" \
                --arg started "$started_at" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase complete",
                        "timestamp": $ts
                    },
                    "success": true,
                    "phase": $slug,
                    "startedAt": (if $started == "null" then null else $started end),
                    "completedAt": $ts
                }'
        else
            echo "Completed phase: $slug"
        fi
        log_phase_completed "$slug" "$started_at"
        # Record in phase history
        add_phase_history_entry "$slug" "completed" "$TODO_FILE" "null" "Phase completed via 'phase complete'"
    else
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$slug" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase complete",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_COMPLETE_FAILED",
                        "message": ("Failed to complete phase '\''" + $slug + "'\''")
                    }
                }'
        fi
        return "$EXIT_GENERAL_ERROR"
    fi
}

# Advance to next phase
cmd_advance() {
    local current
    local current_started
    local force_advance=false

    # Parse --force flag
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --force|-f)
                force_advance=true
                shift
                ;;
            *)
                if [[ "$FORMAT" == "json" ]]; then
                    local timestamp
                    timestamp=$(get_iso_timestamp)
                    jq -nc \
                        --arg ts "$timestamp" \
                        --arg arg "$1" \
                        '{
                            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                            "_meta": {
                                "command": "phase advance",
                                "timestamp": $ts
                            },
                            "success": false,
                            "error": {
                                "code": "E_INPUT_INVALID",
                                "message": ("Unknown argument: " + $arg)
                            }
                        }'
                else
                    output_error "$E_INPUT_INVALID" "Unknown argument: $1"
                fi
                return "$EXIT_INVALID_INPUT"
                ;;
        esac
    done

    current=$(get_current_phase "$TODO_FILE")

    # Check if current phase is set
    if [[ -z "$current" || "$current" == "null" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase advance",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_NOT_SET",
                        "message": "No current phase set"
                    }
                }'
        else
            output_error "$E_PHASE_NOT_FOUND" "No current phase set"
        fi
        return "$EXIT_NOT_FOUND"
    fi

    # Handle legacy data where .project may be a string (pre-v2.2.0)
    current_started=$(jq -r --arg slug "$current" '(if (.project | type) == "object" then .project.phases[$slug].startedAt else null end) // null' "$TODO_FILE")

    # Find next phase
    local current_order
    # Handle legacy data where .project may be a string (pre-v2.2.0)
    current_order=$(jq -r --arg slug "$current" '(if (.project | type) == "object" then .project.phases[$slug].order else null end) // 0' "$TODO_FILE")
    local next_phase
    next_phase=$(jq -r --argjson order "$current_order" '
        (if (.project | type) == "object" then .project.phases else null end // {}) | to_entries
        | sort_by(.value.order)
        | map(select(.value.order > $order))
        | first.key // empty
    ' "$TODO_FILE")

    if [[ -z "$next_phase" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg current "$current" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase advance",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_NO_NEXT",
                        "message": ("No more phases after '\''" + $current + "'\''")
                    }
                }'
        else
            echo "INFO: No more phases after '$current'" >&2
        fi
        return "$EXIT_NO_DATA"
    fi

    # Check for incomplete tasks in current phase
    local incomplete_count
    incomplete_count=$(jq --arg phase "$current" '
        [.tasks[] | select(.phase == $phase and .status != "done")] | length
    ' "$TODO_FILE")

    if [[ "$incomplete_count" -gt 0 ]]; then
        # Read config for validation rules using config.sh library for priority resolution
        local block_on_critical=true
        local phase_threshold=90

        if declare -f get_config_value >/dev/null 2>&1; then
            block_on_critical=$(get_config_value "validation.phaseValidation.blockOnCriticalTasks" "true")
            phase_threshold=$(get_config_value "validation.phaseValidation.phaseAdvanceThreshold" "90")
        else
            # Fallback to direct jq if config.sh not available
            local config_file="${CLEO_DIR:-.cleo}/config.json"
            if [[ -f "$config_file" ]]; then
                block_on_critical=$(jq -r '.validation.phaseValidation.blockOnCriticalTasks // true' "$config_file")
                phase_threshold=$(jq -r '.validation.phaseValidation.phaseAdvanceThreshold // 90' "$config_file")
            fi
        fi

        # Check for critical tasks
        local critical_count
        critical_count=$(jq --arg phase "$current" '
            [.tasks[] | select(.phase == $phase and .status != "done" and .priority == "critical")] | length
        ' "$TODO_FILE")

        # If critical tasks exist and blockOnCriticalTasks is true, block even with --force
        if [[ "$critical_count" -gt 0 && "$block_on_critical" == "true" ]]; then
            if [[ "$FORMAT" == "json" ]]; then
                local timestamp
                timestamp=$(get_iso_timestamp)
                jq -nc \
                    --arg ts "$timestamp" \
                    --arg slug "$current" \
                    --argjson count "$critical_count" \
                    '{
                        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                        "_meta": {
                            "command": "phase advance",
                            "timestamp": $ts
                        },
                        "success": false,
                        "error": {
                            "code": "E_PHASE_CRITICAL_TASKS",
                            "message": ("Cannot advance - " + ($count | tostring) + " critical task(s) remain in phase '\''" + $slug + "'\'' (blockOnCriticalTasks enabled)"),
                            "criticalTasks": $count,
                            "currentPhase": $slug
                        }
                    }'
            else
                output_error "$E_VALIDATION_REQUIRED" "Cannot advance - $critical_count critical task(s) remain in phase '$current'" "" "" "Complete critical tasks or set validation.phaseValidation.blockOnCriticalTasks to false"
            fi
            return "$EXIT_VALIDATION_ERROR"
        fi

        # Calculate completion percentage
        local total_count
        total_count=$(jq --arg phase "$current" '
            [.tasks[] | select(.phase == $phase)] | length
        ' "$TODO_FILE")

        local completion_percent=0
        if [[ "$total_count" -gt 0 ]]; then
            completion_percent=$(( (total_count - incomplete_count) * 100 / total_count ))
        fi

        # Check if completion percentage meets threshold
        if [[ "$completion_percent" -lt "$phase_threshold" && "$force_advance" != "true" ]]; then
            if [[ "$FORMAT" == "json" ]]; then
                local timestamp
                timestamp=$(get_iso_timestamp)
                jq -nc \
                    --arg ts "$timestamp" \
                    --arg slug "$current" \
                    --argjson count "$incomplete_count" \
                    --argjson percent "$completion_percent" \
                    --argjson threshold "$phase_threshold" \
                    '{
                        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                        "_meta": {
                            "command": "phase advance",
                            "timestamp": $ts
                        },
                        "success": false,
                        "error": {
                            "code": "E_PHASE_INCOMPLETE_TASKS",
                            "message": ("Cannot advance - " + ($count | tostring) + " incomplete task(s) in phase '\''" + $slug + "'\'' (" + ($percent | tostring) + "% complete, threshold: " + ($threshold | tostring) + "%)"),
                            "incompleteTasks": $count,
                            "completionPercent": $percent,
                            "threshold": $threshold,
                            "currentPhase": $slug,
                            "hint": "Use --force to override"
                        }
                    }'
            else
                output_error "$E_VALIDATION_REQUIRED" "Cannot advance - $incomplete_count incomplete task(s) in phase '$current' (Completion: $completion_percent%, threshold: $phase_threshold%)" "" "" "Use 'phase advance --force' to override"
            fi
            return "$EXIT_VALIDATION_ERROR"
        fi

        # If we get here, either force flag is set or threshold is met
        # Show interactive prompt unless --force was used or not a TTY
        if [[ "$force_advance" != "true" && -t 0 && "$FORMAT" != "json" ]]; then
            # Show task breakdown by priority
            local high_count medium_count low_count
            high_count=$(jq --arg phase "$current" '
                [.tasks[] | select(.phase == $phase and .status != "done" and .priority == "high")] | length
            ' "$TODO_FILE")
            medium_count=$(jq --arg phase "$current" '
                [.tasks[] | select(.phase == $phase and .status != "done" and .priority == "medium")] | length
            ' "$TODO_FILE")
            low_count=$(jq --arg phase "$current" '
                [.tasks[] | select(.phase == $phase and .status != "done" and .priority == "low")] | length
            ' "$TODO_FILE")

            echo "WARNING: $incomplete_count task(s) remain in phase '$current':" >&2
            [[ "$high_count" -gt 0 ]] && echo "  - $high_count high priority" >&2
            [[ "$medium_count" -gt 0 ]] && echo "  - $medium_count medium priority" >&2
            [[ "$low_count" -gt 0 ]] && echo "  - $low_count low priority" >&2
            echo "" >&2
            read -r -p "Continue advancing to '$next_phase'? [y/N] " response

            if [[ ! "$response" =~ ^[Yy]$ ]]; then
                if [[ "$FORMAT" == "json" ]]; then
                    local timestamp
                    timestamp=$(get_iso_timestamp)
                    jq -nc \
                        --arg ts "$timestamp" \
                        --arg current "$current" \
                        '{
                            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                            "_meta": {
                                "command": "phase advance",
                                "timestamp": $ts
                            },
                            "success": true,
                            "noChange": true,
                            "reason": "User cancelled advance operation",
                            "currentPhase": $current
                        }'
                else
                    echo "Advance cancelled" >&2
                fi
                return "$EXIT_NO_CHANGE"
            fi
        elif [[ "$force_advance" == "true" ]]; then
            # Show warning for forced advance
            if [[ "$FORMAT" != "json" ]]; then
                echo "WARNING: Forcing advance with $incomplete_count incomplete task(s)" >&2
            fi
        fi
    fi

    local result
    if [[ "$force_advance" == "true" ]]; then
        result=$(advance_phase "$TODO_FILE" "true" 2>&1)
    else
        result=$(advance_phase "$TODO_FILE" "false" 2>&1)
    fi
    local advance_status=$?

    if [[ $advance_status -eq 0 ]]; then
        local new_phase
        new_phase=$(get_current_phase "$TODO_FILE")
        local advanced_at
        advanced_at=$(get_iso_timestamp)

        if [[ "$FORMAT" == "json" ]]; then
            jq -nc \
                --arg ts "$advanced_at" \
                --arg prev "$current" \
                --arg curr "$new_phase" \
                --argjson forced "$([[ "$force_advance" == "true" ]] && echo true || echo false)" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase advance",
                        "timestamp": $ts
                    },
                    "success": true,
                    "previousPhase": $prev,
                    "currentPhase": $curr,
                    "forced": $forced
                }'
        else
            echo "$result"
        fi
        log_phase_completed "$current" "$current_started"
        log_phase_started "$new_phase"
        # Record both transitions in phase history
        add_phase_history_entry "$current" "completed" "$TODO_FILE" "null" "Phase completed via 'phase advance'"
        add_phase_history_entry "$new_phase" "started" "$TODO_FILE" "$current" "Phase started via 'phase advance' from $current"
    else
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg msg "$result" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase advance",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_ADVANCE_FAILED",
                        "message": $msg
                    }
                }'
        fi
        return "$EXIT_GENERAL_ERROR"
    fi
}

# List all phases
cmd_list() {
    local current_phase
    current_phase=$(get_current_phase "$TODO_FILE")

    if [[ "$FORMAT" == "json" ]]; then
        local timestamp
        timestamp=$(get_iso_timestamp)
        # Handle legacy data where .project may be a string (pre-v2.2.0)
        jq \
            --arg ts "$timestamp" \
            --arg current "$current_phase" \
            '
            # Get phases with type guard for legacy data
            (if (.project | type) == "object" then .project.phases else null end // {}) as $phases |
            {
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "command": "phase list",
                    "timestamp": $ts
                },
                "success": true,
                "currentPhase": (if $current == "" or $current == "null" then null else $current end),
                "phases": [
                    $phases | to_entries | sort_by(.value.order) | .[] |
                    {
                        "slug": .key,
                        "name": .value.name,
                        "order": .value.order,
                        "status": .value.status,
                        "startedAt": (.value.startedAt // null),
                        "completedAt": (.value.completedAt // null),
                        "isCurrent": (.key == $current)
                    }
                ],
                "summary": {
                    "total": ($phases | length),
                    "pending": ([$phases | to_entries[] | select(.value.status == "pending")] | length),
                    "active": ([$phases | to_entries[] | select(.value.status == "active")] | length),
                    "completed": ([$phases | to_entries[] | select(.value.status == "completed")] | length)
                }
            }' "$TODO_FILE"
    else
        echo "Project Phases:"
        echo "==============="
        # Handle legacy data where .project may be a string (pre-v2.2.0)
        jq -r --arg current "$current_phase" '
            (if (.project | type) == "object" then .project.phases else null end // {}) | to_entries | sort_by(.value.order) | .[] |
            (if .key == $current then "★ " else "  " end) +
            "[\(.value.order)] \(.key): \(.value.name) (\(.value.status))"
        ' "$TODO_FILE"
    fi
}

# Rename a phase and update all task references
# Rename a phase and update all task references
cmd_rename() {
    local old_name="$1"
    local new_name="$2"
    local backup_file
    local temp_file
    local updated_count
    local current_phase

    # Validate old phase exists
    # Handle legacy data where .project may be a string (pre-v2.2.0)
    if ! jq -e --arg slug "$old_name" '(.project | type) == "object" and .project.phases[$slug] != null' "$TODO_FILE" >/dev/null 2>&1; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$old_name" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase rename",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_NOT_FOUND",
                        "message": ("Phase '\''" + $slug + "'\'' does not exist")
                    }
                }'
        else
            output_error "$E_PHASE_NOT_FOUND" "Phase '$old_name' does not exist"
        fi
        return "$EXIT_NOT_FOUND"
    fi

    # Validate new name doesn't already exist
    # Handle legacy data where .project may be a string (pre-v2.2.0)
    if jq -e --arg slug "$new_name" '(.project | type) == "object" and .project.phases[$slug] != null' "$TODO_FILE" >/dev/null 2>&1; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$new_name" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase rename",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_ALREADY_EXISTS",
                        "message": ("Phase '\''" + $slug + "'\'' already exists")
                    }
                }'
        else
            output_error "$E_PHASE_INVALID" "Phase '$new_name' already exists"
        fi
        return "$EXIT_INVALID_INPUT"
    fi

    # Validate new name format (lowercase, alphanumeric, hyphens only)
    if ! echo "$new_name" | grep -qE '^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$'; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$new_name" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase rename",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_INVALID_NAME",
                        "message": ("Invalid phase name '\''" + $slug + "'\''. Must be lowercase alphanumeric with hyphens, not starting/ending with hyphen")
                    }
                }'
        else
            output_error "$E_INPUT_INVALID" "Invalid phase name '$new_name'" "" "" "Phase names must be lowercase alphanumeric with hyphens, not starting/ending with hyphen"
        fi
        return "$EXIT_INVALID_INPUT"
    fi

    # Warn if renaming the current project phase (for consistency with delete protection)
    current_phase=$(get_current_phase "$TODO_FILE")
    if [[ "$current_phase" == "$old_name" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            : # JSON mode: include warning in output, but don't block
        else
            echo "INFO: Renaming current project phase '$old_name' to '$new_name'" >&2
        fi
    fi

    # Create backup before changes
    backup_file=$(backup_file "$TODO_FILE")
    if [[ $? -ne 0 ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase rename",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_BACKUP_FAILED",
                        "message": "Failed to create backup before rename operation"
                    }
                }'
        else
            output_error "$E_FILE_WRITE_ERROR" "Failed to create backup"
        fi
        return "$EXIT_GENERAL_ERROR"
    fi

    # Perform atomic operation
    temp_file=$(mktemp)
    local timestamp
    timestamp=$(get_iso_timestamp)

    # Step 1-4: Copy phase definition, update tasks, update currentPhase, remove old
    # Handle legacy data where .project may be a string (pre-v2.2.0)
    if ! jq --arg old "$old_name" --arg new "$new_name" --arg ts "$timestamp" '
        # Guard: Only proceed if .project is an object
        if (.project | type) != "object" then
            error("Cannot rename phase: .project is not an object (legacy data format)")
        else
            # Copy phase definition with new name
            .project.phases[$new] = .project.phases[$old] |

            # Update all task.phase references
            .tasks = (.tasks | map(
                if .phase == $old then
                    .phase = $new
                else
                    .
                end
            )) |

            # Update project.currentPhase if it matches
            (if .project.currentPhase == $old then
                .project.currentPhase = $new
            else
                .
            end) |

            # Update focus.currentPhase if it matches
            (if .focus.currentPhase == $old then
                .focus.currentPhase = $new
            else
                .
            end) |

            # Remove old phase definition
            del(.project.phases[$old]) |

            # Update lastUpdated timestamp
            .lastUpdated = $ts
        end
    ' "$TODO_FILE" > "$temp_file"; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase rename",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_RENAME_FAILED",
                        "message": "Failed to perform rename operation"
                    }
                }'
        else
            output_error "$E_FILE_WRITE_ERROR" "Failed to rename phase"
        fi
        rm -f "$temp_file"
        restore_backup "$TODO_FILE"
        return "$EXIT_GENERAL_ERROR"
    fi

    # Validate temp file is valid JSON
    if ! jq empty "$temp_file" 2>/dev/null; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase rename",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_VALIDATION_FAILED",
                        "message": "Rename produced invalid JSON"
                    }
                }'
        else
            output_error "$E_VALIDATION_SCHEMA" "Rename produced invalid JSON"
        fi
        rm -f "$temp_file"
        restore_backup "$TODO_FILE"
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Count updated tasks
    updated_count=$(jq --arg new "$new_name" '[.tasks[] | select(.phase == $new)] | length' "$temp_file")

    # Check if currentPhase was updated
    # Handle legacy data where .project may be a string (pre-v2.2.0)
    current_phase=$(jq -r '(if (.project | type) == "object" then .project.currentPhase else null end) // empty' "$temp_file")

    # Atomic rename - replace original file
    if ! mv "$temp_file" "$TODO_FILE"; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase rename",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_FILE_WRITE_FAILED",
                        "message": "Failed to write updated file"
                    }
                }'
        else
            output_error "$E_FILE_WRITE_ERROR" "Failed to write updated file"
        fi
        rm -f "$temp_file"
        restore_backup "$TODO_FILE"
        return "$EXIT_GENERAL_ERROR"
    fi

    # Log the rename operation
    if command -v log_operation >/dev/null 2>&1; then
        local details
        details=$(jq -nc \
            --arg old "$old_name" \
            --arg new "$new_name" \
            --argjson count "$updated_count" \
            '{oldName: $old, newName: $new, tasksUpdated: $count}')
        log_operation "phase_changed" "human" "null" "null" "null" "$details" "null" 2>/dev/null || true
    fi

    # Output success
    if [[ "$FORMAT" == "json" ]]; then
        timestamp=$(get_iso_timestamp)
        jq -nc \
            --arg ts "$timestamp" \
            --arg old "$old_name" \
            --arg new "$new_name" \
            --argjson count "$updated_count" \
            --arg current "$current_phase" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "command": "phase rename",
                    "timestamp": $ts
                },
                "success": true,
                "oldName": $old,
                "newName": $new,
                "tasksUpdated": $count,
                "currentPhaseUpdated": ($current == $new)
            }'
    else
        echo "Renaming phase '$old_name' to '$new_name'..."
        echo "Updated $updated_count tasks"
        if [[ "$current_phase" == "$new_name" ]]; then
            echo "Updated project.currentPhase"
        fi
        echo "Phase renamed successfully"
    fi

    return "$EXIT_SUCCESS"
}

# ============================================================================
# USAGE

# Delete a phase with task reassignment protection
cmd_delete() {
    local slug="$1"
    local reassign_to="${2:-}"
    local force="${3:-false}"

    # Check phase exists
    # Handle legacy data where .project may be a string (pre-v2.2.0)
    if ! jq -e --arg slug "$slug" '(.project | type) == "object" and .project.phases[$slug] != null' "$TODO_FILE" >/dev/null 2>&1; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$slug" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase delete",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_NOT_FOUND",
                        "message": ("Phase '\'''" + $slug + "'\'' does not exist")
                    }
                }'
        else
            output_error "$E_PHASE_NOT_FOUND" "Phase '$slug' does not exist"
        fi
        return "$EXIT_NOT_FOUND"
    fi

    # Check if phase is current project phase
    local current_phase
    current_phase=$(get_current_phase "$TODO_FILE")
    if [[ "$current_phase" == "$slug" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$slug" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase delete",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_IS_CURRENT",
                        "message": ("Cannot delete current project phase '\'''" + $slug + "'\''. Use '\''phase set'\'' to change phase first")
                    }
                }'
        else
            output_error "$E_PHASE_INVALID" "Cannot delete current project phase '$slug'" "" "" "Use 'cleo phase set <other-phase>' to change the current phase first"
        fi
        return "$EXIT_VALIDATION_ERROR"
    fi

    # Count tasks with this phase
    local task_count
    task_count=$(jq --arg phase "$slug" '
        [.tasks[] | select(.phase == $phase)] | length
    ' "$TODO_FILE")

    # Count tasks by status for detailed reporting
    local pending_count active_count blocked_count done_count
    pending_count=$(jq --arg phase "$slug" '[.tasks[] | select(.phase == $phase and .status == "pending")] | length' "$TODO_FILE")
    active_count=$(jq --arg phase "$slug" '[.tasks[] | select(.phase == $phase and .status == "active")] | length' "$TODO_FILE")
    blocked_count=$(jq --arg phase "$slug" '[.tasks[] | select(.phase == $phase and .status == "blocked")] | length' "$TODO_FILE")
    done_count=$(jq --arg phase "$slug" '[.tasks[] | select(.phase == $phase and .status == "done")] | length' "$TODO_FILE")

    # If tasks exist and no reassignment specified, error
    if [[ "$task_count" -gt 0 && -z "$reassign_to" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$slug" \
                --argjson total "$task_count" \
                --argjson pending "$pending_count" \
                --argjson active "$active_count" \
                --argjson blocked "$blocked_count" \
                --argjson done "$done_count" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase delete",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_PHASE_HAS_TASKS",
                        "message": ("Cannot delete '\'''" + $slug + "'\'': " + ($total | tostring) + " tasks would be orphaned. Use --reassign-to <phase>"),
                        "taskCount": {
                            "total": $total,
                            "pending": $pending,
                            "active": $active,
                            "blocked": $blocked,
                            "done": $done
                        }
                    }
                }'
        else
            output_error "$E_VALIDATION_REQUIRED" "Cannot delete '$slug': $task_count tasks would be orphaned (pending: $pending_count, active: $active_count, blocked: $blocked_count, done: $done_count)" "" "" "Use: cleo phase delete $slug --reassign-to <phase>"
        fi
        return "$EXIT_VALIDATION_ERROR"
    fi

    # If tasks exist and reassignment specified, validate target phase
    if [[ "$task_count" -gt 0 && -n "$reassign_to" ]]; then
        # Handle legacy data where .project may be a string (pre-v2.2.0)
        if ! jq -e --arg slug "$reassign_to" '(.project | type) == "object" and .project.phases[$slug] != null' "$TODO_FILE" >/dev/null 2>&1; then
            if [[ "$FORMAT" == "json" ]]; then
                local timestamp
                timestamp=$(get_iso_timestamp)
                jq -nc \
                    --arg ts "$timestamp" \
                    --arg slug "$reassign_to" \
                    '{
                        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                        "_meta": {
                            "command": "phase delete",
                            "timestamp": $ts
                        },
                        "success": false,
                        "error": {
                            "code": "E_PHASE_NOT_FOUND",
                            "message": ("Reassignment target phase '\'''" + $slug + "'\'' does not exist")
                        }
                    }'
            else
                output_error "$E_PHASE_NOT_FOUND" "Reassignment target phase '$reassign_to' does not exist"
            fi
            return "$EXIT_NOT_FOUND"
        fi
    fi

    # Require --force flag for safety
    if [[ "$force" != "true" ]]; then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                --arg slug "$slug" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase delete",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_FORCE_REQUIRED",
                        "message": "Phase deletion requires --force flag for safety"
                    }
                }'
        else
            if [[ "$task_count" -gt 0 ]]; then
                output_error "$E_INPUT_MISSING" "Phase deletion requires --force flag for safety" "" "" "Use: cleo phase delete $slug --reassign-to $reassign_to --force"
            else
                output_error "$E_INPUT_MISSING" "Phase deletion requires --force flag for safety" "" "" "Use: cleo phase delete $slug --force"
            fi
        fi
        return "$EXIT_INVALID_INPUT"
    fi

    # Create backup before any changes
    local backup_path
    if ! backup_path=$(backup_file "$TODO_FILE" 2>&1); then
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp
            timestamp=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase delete",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_BACKUP_FAILED",
                        "message": "Failed to create backup before phase deletion"
                    }
                }'
        else
            output_error "$E_FILE_WRITE_ERROR" "Failed to create backup before phase deletion"
        fi
        return "$EXIT_FILE_ERROR"
    fi

    # Build jq operation atomically
    local temp_file
    temp_file=$(mktemp)
    local timestamp
    timestamp=$(get_iso_timestamp)

    # Reassign tasks if needed, then delete phase
    # Handle legacy data where .project may be a string (pre-v2.2.0)
    if [[ "$task_count" -gt 0 && -n "$reassign_to" ]]; then
        jq --arg slug "$slug" \
           --arg reassign "$reassign_to" \
           --arg ts "$timestamp" '
            # Guard: Only proceed if .project is an object
            if (.project | type) != "object" then
                error("Cannot delete phase: .project is not an object (legacy data format)")
            else
                # Reassign all tasks with this phase
                .tasks = [.tasks[] | if .phase == $slug then .phase = $reassign else . end] |
                # Delete the phase
                del(.project.phases[$slug]) |
                # Update timestamp
                .lastUpdated = $ts
            end
        ' "$TODO_FILE" > "$temp_file"
    else
        jq --arg slug "$slug" \
           --arg ts "$timestamp" '
            # Guard: Only proceed if .project is an object
            if (.project | type) != "object" then
                error("Cannot delete phase: .project is not an object (legacy data format)")
            else
                # Delete the phase
                del(.project.phases[$slug]) |
                # Update timestamp
                .lastUpdated = $ts
            end
        ' "$TODO_FILE" > "$temp_file"
    fi

    # Recalculate checksum
    local new_checksum
    new_checksum=$(jq -c '.tasks' "$temp_file" | sha256sum | cut -c1-16)
    jq --arg checksum "$new_checksum" '._meta.checksum = $checksum' "$temp_file" > "${temp_file}.2"
    mv "${temp_file}.2" "$temp_file"

    # Atomic write
    if ! save_json "$TODO_FILE" "$(cat "$temp_file")"; then
        rm -f "$temp_file"
        if [[ "$FORMAT" == "json" ]]; then
            local timestamp_err
            timestamp_err=$(get_iso_timestamp)
            jq -nc \
                --arg ts "$timestamp_err" \
                '{
                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                    "_meta": {
                        "command": "phase delete",
                        "timestamp": $ts
                    },
                    "success": false,
                    "error": {
                        "code": "E_FILE_WRITE_ERROR",
                        "message": "Failed to write changes to todo file"
                    }
                }'
        else
            output_error "$E_FILE_WRITE_ERROR" "Failed to write changes"
        fi
        return "$EXIT_FILE_ERROR"
    fi
    rm -f "$temp_file"

    # Log the operation
    if [[ "$task_count" -gt 0 && -n "$reassign_to" ]]; then
        log_phase_deleted "$slug" "$reassign_to" "$task_count"
    else
        log_phase_deleted "$slug" "none" 0
    fi

    # Success output
    if [[ "$FORMAT" == "json" ]]; then
        jq -nc \
            --arg ts "$timestamp" \
            --arg slug "$slug" \
            --arg reassign "${reassign_to:-null}" \
            --argjson count "$task_count" \
            '{
                "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                "_meta": {
                    "command": "phase delete",
                    "timestamp": $ts
                },
                "success": true,
                "deletedPhase": $slug,
                "tasksReassigned": (if $reassign != "null" then $count else 0 end),
                "reassignedTo": (if $reassign != "null" then $reassign else null end)
            }'
    else
        if [[ "$task_count" -gt 0 && -n "$reassign_to" ]]; then
            echo "Phase '$slug' has $task_count tasks:"
            [[ "$pending_count" -gt 0 ]] && echo "  - $pending_count pending"
            [[ "$active_count" -gt 0 ]] && echo "  - $active_count active"
            [[ "$blocked_count" -gt 0 ]] && echo "  - $blocked_count blocked"
            [[ "$done_count" -gt 0 ]] && echo "  - $done_count done"
            echo ""
            echo "Reassigning to '$reassign_to'..."
            echo "Updated $task_count tasks"
        fi
        echo "Phase '$slug' deleted"
    fi
}
usage() {
    cat <<EOF
Usage: cleo phase [OPTIONS] <subcommand> [args]

Options:
  -f, --format FORMAT   Output format: text (default) or json
  --json                Shorthand for --format json
  --human               Shorthand for --format text
  -q, --quiet           Suppress informational messages
  --dry-run             Preview changes without modifying files
  -h, --help            Show this help message

Subcommands:
  show              Show current project phase
  set <slug>        Set current phase (doesn't change status)
                    Flags: --rollback (allow backward movement)
                           --force (skip confirmation prompt)
  start <slug>      Start a phase (pending → active)
  complete <slug>   Complete a phase (active → completed)
  advance           Complete current phase and start next
                    Flags: --force/-f (skip validation and interactive prompt)
  list              List all phases with status
  rename <old> <new> Rename a phase and update all task references
  delete <slug>     Delete a phase with task reassignment protection
                    Flags: --reassign-to <phase> (reassign tasks to another phase)
                           --force (required safety flag)

Examples:
  cleo phase show
  cleo phase set core
  cleo phase set setup --rollback          # Rollback with prompt
  cleo phase set setup --rollback --force  # Rollback without prompt
  cleo phase start polish
  cleo phase advance --force               # Skip prompt for incomplete tasks
  cleo phase advance
  cleo phase rename core development       # Rename phase and update tasks
  cleo phase delete old-phase --reassign-to setup --force  # Delete with reassignment
  cleo phase --json list                   # JSON output for automation
  cleo phase -f json show                  # JSON output
EOF
}

# MAIN

main() {
    # Defensive check for output_error function
    if ! declare -f output_error >/dev/null 2>&1; then
        echo "ERROR: output_error function not available. Ensure error-json.sh is sourced." >&2
        exit "${EXIT_DEPENDENCY_ERROR:-5}"
    fi

    # Parse global flags before subcommand
    while [[ $# -gt 0 ]]; do
        case "$1" in
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
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            -h|--help|help)
                usage
                exit "$EXIT_SUCCESS"
                ;;
            *)
                break
                ;;
        esac
    done

    # Resolve format using output-format.sh (TTY-aware default)
    if command -v resolve_format &>/dev/null; then
        FORMAT=$(resolve_format "$FORMAT")
    else
        # Fallback if output-format.sh not available: TTY-aware detection
        if [[ -z "$FORMAT" ]]; then
            if [[ -t 1 ]]; then
                FORMAT="human"
            else
                FORMAT="json"
            fi
        fi
    fi

    if [[ $# -lt 1 ]]; then
        usage
        exit "$EXIT_INVALID_INPUT"
    fi

    local subcommand="$1"
    shift

    case "$subcommand" in
        show)
            cmd_show
            ;;
        set)
            if [[ $# -lt 1 ]]; then
                if [[ "$FORMAT" == "json" ]]; then
                    local timestamp
                    timestamp=$(get_iso_timestamp)
                    jq -nc \
                        --arg ts "$timestamp" \
                        '{
                            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                            "_meta": {
                                "command": "phase set",
                                "timestamp": $ts
                            },
                            "success": false,
                            "error": {
                                "code": "E_INPUT_MISSING",
                                "message": "Phase slug required. Usage: cleo phase set <slug>"
                            }
                        }'
                else
                    output_error "$E_INPUT_MISSING" "Phase slug required. Usage: cleo phase set <slug>"
                fi
                exit "$EXIT_INVALID_INPUT"
            fi
            cmd_set "$@"
            ;;
        start)
            if [[ $# -lt 1 ]]; then
                if [[ "$FORMAT" == "json" ]]; then
                    local timestamp
                    timestamp=$(get_iso_timestamp)
                    jq -nc \
                        --arg ts "$timestamp" \
                        '{
                            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                            "_meta": {
                                "command": "phase start",
                                "timestamp": $ts
                            },
                            "success": false,
                            "error": {
                                "code": "E_INPUT_MISSING",
                                "message": "Phase slug required. Usage: cleo phase start <slug>"
                            }
                        }'
                else
                    output_error "$E_INPUT_MISSING" "Phase slug required. Usage: cleo phase start <slug>"
                fi
                exit "$EXIT_INVALID_INPUT"
            fi
            cmd_start "$1"
            ;;
        complete)
            if [[ $# -lt 1 ]]; then
                if [[ "$FORMAT" == "json" ]]; then
                    local timestamp
                    timestamp=$(get_iso_timestamp)
                    jq -nc \
                        --arg ts "$timestamp" \
                        '{
                            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                            "_meta": {
                                "command": "phase complete",
                                "timestamp": $ts
                            },
                            "success": false,
                            "error": {
                                "code": "E_INPUT_MISSING",
                                "message": "Phase slug required. Usage: cleo phase complete <slug>"
                            }
                        }'
                else
                    output_error "$E_INPUT_MISSING" "Phase slug required. Usage: cleo phase complete <slug>"
                fi
                exit "$EXIT_INVALID_INPUT"
            fi
            cmd_complete "$1"
            ;;
        advance)
            cmd_advance "$@"
            ;;
        list)
            cmd_list
            ;;
        delete)
            if [[ $# -lt 1 ]]; then
                if [[ "$FORMAT" == "json" ]]; then
                    local timestamp
                    timestamp=$(get_iso_timestamp)
                    jq -nc \
                        --arg ts "$timestamp" \
                        '{
                            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                            "_meta": {
                                "command": "phase delete",
                                "timestamp": $ts
                            },
                            "success": false,
                            "error": {
                                "code": "E_INPUT_MISSING",
                                "message": "Phase slug required. Usage: cleo phase delete <slug> --reassign-to <phase> --force"
                            }
                        }'
                else
                    output_error "$E_INPUT_MISSING" "Phase slug required. Usage: cleo phase delete <slug> --reassign-to <phase> --force"
                fi
                exit "$EXIT_INVALID_INPUT"
            fi

            # Parse delete flags
            local slug="$1"
            shift
            local reassign_to=""
            local force="false"

            while [[ $# -gt 0 ]]; do
                case "$1" in
                    --reassign-to)
                        reassign_to="$2"
                        shift 2
                        ;;
                    --force)
                        force="true"
                        shift
                        ;;
                    *)
                        if [[ "$FORMAT" == "json" ]]; then
                            local timestamp
                            timestamp=$(get_iso_timestamp)
                            jq -nc \
                                --arg ts "$timestamp" \
                                --arg flag "$1" \
                                '{
                                    "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                                    "_meta": {
                                        "command": "phase delete",
                                        "timestamp": $ts
                                    },
                                    "success": false,
                                    "error": {
                                        "code": "E_INPUT_INVALID",
                                        "message": ("Unknown flag: " + $flag + ". Valid flags: --reassign-to, --force")
                                    }
                                }'
                        else
                            output_error "$E_INPUT_INVALID" "Unknown flag: $1. Valid flags: --reassign-to, --force"
                        fi
                        exit "$EXIT_INVALID_INPUT"
                        ;;
                esac
            done

            cmd_delete "$slug" "$reassign_to" "$force"
            ;;
        rename)
            if [[ $# -lt 2 ]]; then
                if [[ "$FORMAT" == "json" ]]; then
                    local timestamp
                    timestamp=$(get_iso_timestamp)
                    jq -nc \
                        --arg ts "$timestamp" \
                        '{
                            "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                            "_meta": {
                                "command": "phase rename",
                                "timestamp": $ts
                            },
                            "success": false,
                            "error": {
                                "code": "E_INPUT_MISSING",
                                "message": "Both old and new phase names required. Usage: cleo phase rename <old> <new>"
                            }
                        }'
                else
                    output_error "$E_INPUT_MISSING" "Both old and new phase names required. Usage: cleo phase rename <old> <new>"
                fi
                exit "$EXIT_INVALID_INPUT"
            fi
            cmd_rename "$1" "$2"
            ;;
        *)
            if [[ "$FORMAT" == "json" ]]; then
                local timestamp
                timestamp=$(get_iso_timestamp)
                jq -nc \
                    --arg ts "$timestamp" \
                    --arg cmd "$subcommand" \
                    '{
                        "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
                        "_meta": {
                            "command": "phase",
                            "timestamp": $ts
                        },
                        "success": false,
                        "error": {
                            "code": "E_INPUT_INVALID",
                            "message": ("Unknown subcommand: " + $cmd + ". Valid subcommands: show, set, start, complete, advance, list, rename, delete")
                        }
                    }'
            else
                output_error "$E_INPUT_INVALID" "Unknown subcommand: $subcommand. Valid subcommands: show, set, start, complete, advance, list, rename, delete"
                usage
            fi
            exit "$EXIT_INVALID_INPUT"
            ;;
    esac
}

main "$@"
