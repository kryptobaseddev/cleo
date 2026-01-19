#!/usr/bin/env bash
# orchestrator.sh - Orchestrator Protocol CLI Entry Point
#
# USAGE:
#   cleo orchestrator start [--epic <id>]     # Initialize orchestrator session
#   cleo orchestrator status                   # Show pending agents/tasks
#   cleo orchestrator next [--epic <id>]       # Get next agent to spawn
#   cleo orchestrator ready [--epic <id>]      # Get all parallel-safe tasks
#   cleo orchestrator context [--tokens <n>]   # Check context limits
#   cleo orchestrator spawn <task-id> [--template <name>]  # Generate spawn command
#   cleo orchestrator analyze <epic-id>        # Show dependency analysis
#   cleo orchestrator parallel <epic-id>       # Show parallel execution waves
#   cleo orchestrator check <task-id>...       # Check if tasks can run in parallel
#   cleo orchestrator validate                 # Full protocol validation
#   cleo orchestrator validate --subagent <id> # Validate specific subagent output
#   cleo orchestrator validate --manifest      # Validate manifest only
#   cleo orchestrator validate --orchestrator  # Validate orchestrator compliance
#
# The orchestrator command provides tools for LLM agents operating as
# orchestrators (delegating to subagents rather than implementing directly).
#
# EXIT CODES:
#   0   - Success
#   2   - Invalid input
#   4   - Not found
#   52  - Context critical

set -euo pipefail

# ============================================================================
# SETUP
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "$SCRIPT_DIR/../lib" && pwd)"

# Source required libraries
# shellcheck source=lib/exit-codes.sh
source "$LIB_DIR/exit-codes.sh"
# shellcheck source=lib/paths.sh
source "$LIB_DIR/paths.sh"
# shellcheck source=lib/orchestrator-startup.sh
source "$LIB_DIR/orchestrator-startup.sh"
# shellcheck source=lib/orchestrator-validator.sh
source "$LIB_DIR/orchestrator-validator.sh"

# ============================================================================
# COMMAND HANDLERS
# ============================================================================

cmd_start() {
    local epic_id=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --epic|-e)
                epic_id="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    orchestrator_get_startup_state "$epic_id"
}

cmd_status() {
    orchestrator_check_pending
}

cmd_next() {
    local epic_id=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --epic|-e)
                epic_id="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    if [[ -z "$epic_id" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "next"
            },
            "success": false,
            "error": {
                "code": "E_INVALID_INPUT",
                "message": "Epic ID required. Usage: cleo orchestrator next --epic <id>",
                "exitCode": 2
            }
        }'
        return "$EXIT_INVALID_INPUT"
    fi

    orchestrator_get_next_task "$epic_id"
}

cmd_ready() {
    local epic_id=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --epic|-e)
                epic_id="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    if [[ -z "$epic_id" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "ready"
            },
            "success": false,
            "error": {
                "code": "E_INVALID_INPUT",
                "message": "Epic ID required. Usage: cleo orchestrator ready --epic <id>",
                "exitCode": 2
            }
        }'
        return "$EXIT_INVALID_INPUT"
    fi

    orchestrator_get_ready_tasks "$epic_id"
}

cmd_context() {
    local tokens=0

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --tokens|-t)
                tokens="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    orchestrator_context_check "$tokens"
}

cmd_spawn() {
    local task_id=""
    local template="TASK-EXECUTOR"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --template|-T)
                template="$2"
                shift 2
                ;;
            -*)
                shift
                ;;
            *)
                if [[ -z "$task_id" ]]; then
                    task_id="$1"
                fi
                shift
                ;;
        esac
    done

    if [[ -z "$task_id" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "spawn"
            },
            "success": false,
            "error": {
                "code": "E_INVALID_INPUT",
                "message": "Task ID required. Usage: cleo orchestrator spawn <task-id> [--template <name>]",
                "exitCode": 2
            }
        }'
        return "$EXIT_INVALID_INPUT"
    fi

    orchestrator_spawn "$task_id" "$template"
}

cmd_analyze() {
    local epic_id=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            -*)
                shift
                ;;
            *)
                if [[ -z "$epic_id" ]]; then
                    epic_id="$1"
                fi
                shift
                ;;
        esac
    done

    if [[ -z "$epic_id" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "analyze"
            },
            "success": false,
            "error": {
                "code": "E_INVALID_INPUT",
                "message": "Epic ID required. Usage: cleo orchestrator analyze <epic-id>",
                "exitCode": 2
            }
        }'
        return "$EXIT_INVALID_INPUT"
    fi

    orchestrator_analyze_dependencies "$epic_id"
}

cmd_parallel() {
    local epic_id=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            -*)
                shift
                ;;
            *)
                if [[ -z "$epic_id" ]]; then
                    epic_id="$1"
                fi
                shift
                ;;
        esac
    done

    if [[ -z "$epic_id" ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "parallel"
            },
            "success": false,
            "error": {
                "code": "E_INVALID_INPUT",
                "message": "Epic ID required. Usage: cleo orchestrator parallel <epic-id>",
                "exitCode": 2
            }
        }'
        return "$EXIT_INVALID_INPUT"
    fi

    orchestrator_get_parallel_waves "$epic_id"
}

cmd_check() {
    local task_ids=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            -*)
                shift
                ;;
            *)
                task_ids+=("$1")
                shift
                ;;
        esac
    done

    if [[ ${#task_ids[@]} -eq 0 ]]; then
        jq -n '{
            "_meta": {
                "command": "orchestrator",
                "operation": "check"
            },
            "success": false,
            "error": {
                "code": "E_INVALID_INPUT",
                "message": "Task IDs required. Usage: cleo orchestrator check <task-id> [<task-id>...]",
                "exitCode": 2
            }
        }'
        return "$EXIT_INVALID_INPUT"
    fi

    orchestrator_can_parallelize "${task_ids[@]}"
}

cmd_validate() {
    local subagent_id=""
    local manifest_only=false
    local orchestrator_only=false
    local epic_id=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --subagent|-s)
                subagent_id="$2"
                shift 2
                ;;
            --manifest|-m)
                manifest_only=true
                shift
                ;;
            --orchestrator|-o)
                orchestrator_only=true
                shift
                ;;
            --epic|-e)
                epic_id="$2"
                shift 2
                ;;
            -*)
                shift
                ;;
            *)
                # Positional argument - could be epic ID
                if [[ -z "$epic_id" && -z "$subagent_id" ]]; then
                    epic_id="$1"
                fi
                shift
                ;;
        esac
    done

    # Subagent validation
    if [[ -n "$subagent_id" ]]; then
        validate_subagent_output "$subagent_id"
        return $?
    fi

    # Manifest only
    if [[ "$manifest_only" == "true" ]]; then
        validate_manifest_integrity
        return $?
    fi

    # Orchestrator only
    if [[ "$orchestrator_only" == "true" ]]; then
        validate_orchestrator_compliance "$epic_id"
        return $?
    fi

    # Full protocol validation
    validate_protocol "$epic_id"
}

cmd_help() {
    cat << 'EOF'
Orchestrator Protocol CLI

USAGE:
    cleo orchestrator <command> [options]

COMMANDS:
    start     Initialize orchestrator session, get complete startup state
    status    Check pending work from manifest and CLEO
    next      Get the next task to spawn an agent for
    ready     Get all tasks that can be spawned in parallel
    context   Check orchestrator context limits
    spawn     Generate spawn command for a task with prompt template
    analyze   Show dependency analysis and execution waves
    parallel  Show parallel execution waves for an epic
    check     Check if multiple tasks can be spawned in parallel
    validate  Validate protocol compliance (manifest, orchestrator, subagents)

OPTIONS:
    --epic, -e <id>       Epic ID to scope operations
    --tokens, -t <n>      Current token usage for context check
    --template, -T <name> Template name for spawn (default: TASK-EXECUTOR)
    --subagent, -s <id>   Research ID for subagent validation
    --manifest, -m        Validate manifest only
    --orchestrator, -o    Validate orchestrator compliance only

TEMPLATES:
    TASK-EXECUTOR   General task execution (default)
    RESEARCH-AGENT  Research and investigation
    EPIC-CREATOR    Epic planning and decomposition
    VALIDATOR       Testing and validation

EXAMPLES:
    # Start orchestrator for an epic
    cleo orchestrator start --epic T1575

    # Check what needs to be done
    cleo orchestrator status

    # Get next task to spawn agent for
    cleo orchestrator next --epic T1575

    # Get all parallel-safe tasks
    cleo orchestrator ready --epic T1575

    # Generate spawn command for a task
    cleo orchestrator spawn T1586
    cleo orchestrator spawn T1586 --template RESEARCH-AGENT

    # Analyze dependencies and waves
    cleo orchestrator analyze T1575

    # Get parallel execution waves
    cleo orchestrator parallel T1575

    # Check if tasks can run in parallel
    cleo orchestrator check T1578 T1580 T1582

    # Check context budget
    cleo orchestrator context --tokens 5000

    # Validate protocol compliance
    cleo orchestrator validate
    cleo orchestrator validate --epic T1575
    cleo orchestrator validate --subagent research-id-2026-01-18
    cleo orchestrator validate --manifest
    cleo orchestrator validate --orchestrator --epic T1575

DECISION MATRIX (from startup):
    Active session + focus    -> Resume focused task
    Active session, no focus  -> Spawn for manifest followup
    No session + pending      -> Create session, spawn
    No session, no pending    -> Request user direction

For protocol details, see: docs/specs/ORCHESTRATOR-PROTOCOL-SPEC.md
EOF
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    local subcommand="${1:-help}"
    shift || true

    case "$subcommand" in
        start)
            cmd_start "$@"
            ;;
        status)
            cmd_status "$@"
            ;;
        next)
            cmd_next "$@"
            ;;
        ready)
            cmd_ready "$@"
            ;;
        context)
            cmd_context "$@"
            ;;
        spawn)
            cmd_spawn "$@"
            ;;
        analyze)
            cmd_analyze "$@"
            ;;
        parallel)
            cmd_parallel "$@"
            ;;
        check)
            cmd_check "$@"
            ;;
        validate)
            cmd_validate "$@"
            ;;
        help|--help|-h)
            cmd_help
            ;;
        *)
            echo "Unknown command: $subcommand" >&2
            echo "Run 'cleo orchestrator help' for usage." >&2
            return "$EXIT_INVALID_INPUT"
            ;;
    esac
}

main "$@"
