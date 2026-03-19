#!/usr/bin/env bash
#####################################################################
# bash-completion.sh - Bash completion for cleo CLI
#
# Installation:
#   # Add to ~/.bashrc or ~/.bash_profile:
#   source ~/.cleo/completions/bash-completion.sh
#
#   # Or install system-wide:
#   sudo cp ~/.cleo/completions/bash-completion.sh \
#       /etc/bash_completion.d/cleo
#
# Part of: Hierarchy Enhancement Phase 2 (T347)
#####################################################################

_cleo_completions() {
    local cur prev opts
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"

    # All available commands
    local commands="add update complete list show focus session archive \
        validate backup restore migrate stats deps blockers next analyze \
        dash labels phases phase find search export init log sync tree \
        history exists reparent promote research dig"

    # All available options
    local global_opts="--help --version --format --quiet"

    # Command-specific completions
    case "${COMP_WORDS[1]}" in
        add|new)
            case "$prev" in
                --parent|-p)
                    # Complete with parent-eligible tasks (epic and task types only)
                    _complete_parent_tasks
                    return 0
                    ;;
                --type|-t)
                    COMPREPLY=($(compgen -W "epic task subtask" -- "$cur"))
                    return 0
                    ;;
                --priority)
                    COMPREPLY=($(compgen -W "critical high medium low" -- "$cur"))
                    return 0
                    ;;
                --status)
                    COMPREPLY=($(compgen -W "pending active blocked done" -- "$cur"))
                    return 0
                    ;;
                --phase)
                    _complete_phases
                    return 0
                    ;;
                --size)
                    COMPREPLY=($(compgen -W "small medium large" -- "$cur"))
                    return 0
                    ;;
                --labels)
                    _complete_labels
                    return 0
                    ;;
                --depends)
                    _complete_task_ids
                    return 0
                    ;;
            esac
            local add_opts="--parent --type --priority --status --phase --size \
                --labels --depends --description --blocked-by --quiet --format"
            COMPREPLY=($(compgen -W "$add_opts" -- "$cur"))
            ;;

        update|edit)
            case "$prev" in
                update|edit)
                    _complete_task_ids
                    return 0
                    ;;
                --parent|-p)
                    _complete_parent_tasks
                    return 0
                    ;;
                --type|-t)
                    COMPREPLY=($(compgen -W "epic task subtask" -- "$cur"))
                    return 0
                    ;;
                --priority)
                    COMPREPLY=($(compgen -W "critical high medium low" -- "$cur"))
                    return 0
                    ;;
                --status)
                    COMPREPLY=($(compgen -W "pending active blocked done" -- "$cur"))
                    return 0
                    ;;
                --phase)
                    _complete_phases
                    return 0
                    ;;
                --size)
                    COMPREPLY=($(compgen -W "small medium large" -- "$cur"))
                    return 0
                    ;;
            esac
            local update_opts="--title --description --priority --status --labels \
                --depends --notes --phase --parent --type --size --blocked-by \
                --quiet --format"
            COMPREPLY=($(compgen -W "$update_opts" -- "$cur"))
            ;;

        complete|done)
            case "$prev" in
                complete|done)
                    _complete_task_ids "pending,active,blocked"
                    return 0
                    ;;
            esac
            local complete_opts="--notes --skip-notes --quiet --format"
            COMPREPLY=($(compgen -W "$complete_opts" -- "$cur"))
            ;;

        list|ls)
            case "$prev" in
                --status)
                    COMPREPLY=($(compgen -W "pending active blocked done" -- "$cur"))
                    return 0
                    ;;
                --priority)
                    COMPREPLY=($(compgen -W "critical high medium low" -- "$cur"))
                    return 0
                    ;;
                --phase)
                    _complete_phases
                    return 0
                    ;;
                --label)
                    _complete_labels
                    return 0
                    ;;
                --type)
                    COMPREPLY=($(compgen -W "epic task subtask" -- "$cur"))
                    return 0
                    ;;
                --parent)
                    _complete_parent_tasks
                    return 0
                    ;;
                --format)
                    COMPREPLY=($(compgen -W "text json jsonl markdown table" -- "$cur"))
                    return 0
                    ;;
            esac
            local list_opts="--status --priority --phase --label --type --parent \
                --children --tree --group-priority --format --quiet --human"
            COMPREPLY=($(compgen -W "$list_opts" -- "$cur"))
            ;;

        show)
            case "$prev" in
                show)
                    _complete_task_ids
                    return 0
                    ;;
            esac
            local show_opts="--history --related --include-archive --format"
            COMPREPLY=($(compgen -W "$show_opts" -- "$cur"))
            ;;

        focus)
            case "$prev" in
                focus)
                    COMPREPLY=($(compgen -W "set show clear note next" -- "$cur"))
                    return 0
                    ;;
                set)
                    _complete_task_ids "pending,active"
                    return 0
                    ;;
            esac
            ;;

        reparent)
            case "$prev" in
                reparent)
                    _complete_task_ids
                    return 0
                    ;;
                --to)
                    _complete_parent_tasks
                    return 0
                    ;;
            esac
            local reparent_opts="--to --format --quiet"
            COMPREPLY=($(compgen -W "$reparent_opts" -- "$cur"))
            ;;

        promote)
            case "$prev" in
                promote)
                    _complete_task_ids
                    return 0
                    ;;
            esac
            local promote_opts="--no-type-update --format --quiet"
            COMPREPLY=($(compgen -W "$promote_opts" -- "$cur"))
            ;;

        phase)
            case "$prev" in
                phase)
                    COMPREPLY=($(compgen -W "show set advance complete list" -- "$cur"))
                    return 0
                    ;;
                set)
                    _complete_phases
                    return 0
                    ;;
            esac
            ;;

        session)
            case "$prev" in
                session)
                    COMPREPLY=($(compgen -W "start end status pause resume" -- "$cur"))
                    return 0
                    ;;
            esac
            ;;

        deps)
            case "$prev" in
                deps)
                    _complete_task_ids
                    return 0
                    ;;
            esac
            local deps_opts="tree --format"
            COMPREPLY=($(compgen -W "$deps_opts" -- "$cur"))
            ;;

        validate|check)
            local validate_opts="--fix --check-orphans --fix-orphans --format"
            COMPREPLY=($(compgen -W "$validate_opts" -- "$cur"))
            ;;

        find|search)
            local find_opts="--id --exact --status --field --format --include-archive"
            COMPREPLY=($(compgen -W "$find_opts" -- "$cur"))
            ;;

        export)
            case "$prev" in
                --format)
                    COMPREPLY=($(compgen -W "todowrite csv json markdown" -- "$cur"))
                    return 0
                    ;;
            esac
            local export_opts="--format --output --filter"
            COMPREPLY=($(compgen -W "$export_opts" -- "$cur"))
            ;;

        *)
            # Complete commands
            if [[ ${COMP_CWORD} -eq 1 ]]; then
                COMPREPLY=($(compgen -W "$commands" -- "$cur"))
            else
                COMPREPLY=($(compgen -W "$global_opts" -- "$cur"))
            fi
            ;;
    esac
}

# Complete parent-eligible tasks (epic and task types only, not subtask)
_complete_parent_tasks() {
    local cur="${COMP_WORDS[COMP_CWORD]}"
    local todo_file="${TODO_FILE:-.claude/todo.json}"

    if [[ ! -f "$todo_file" ]]; then
        return 0
    fi

    # Get tasks that can be parents (epic or task type, not subtask)
    local tasks
    tasks=$(jq -r '.tasks[] | select(.type != "subtask") | "\(.id) \(.title | .[0:40])"' "$todo_file" 2>/dev/null)

    # If current word starts with T, complete task IDs
    if [[ "$cur" == T* ]]; then
        local ids
        ids=$(echo "$tasks" | cut -d' ' -f1 | grep "^$cur")
        COMPREPLY=($(compgen -W "$ids" -- "$cur"))
    else
        # Complete with "ID - Title" format
        local formatted
        formatted=$(echo "$tasks" | while read -r line; do
            echo "$line" | awk '{print $1}'
        done)
        COMPREPLY=($(compgen -W "$formatted" -- "$cur"))
    fi
}

# Complete all task IDs
_complete_task_ids() {
    local cur="${COMP_WORDS[COMP_CWORD]}"
    local todo_file="${TODO_FILE:-.claude/todo.json}"
    local status_filter="${1:-}"

    if [[ ! -f "$todo_file" ]]; then
        return 0
    fi

    local ids
    if [[ -n "$status_filter" ]]; then
        # Filter by status
        ids=$(jq -r --arg statuses "$status_filter" '
            ($statuses | split(",")) as $s |
            .tasks[] | select(.status as $st | $s | index($st)) | .id
        ' "$todo_file" 2>/dev/null)
    else
        ids=$(jq -r '.tasks[].id' "$todo_file" 2>/dev/null)
    fi

    COMPREPLY=($(compgen -W "$ids" -- "$cur"))
}

# Complete phases
_complete_phases() {
    local cur="${COMP_WORDS[COMP_CWORD]}"
    local todo_file="${TODO_FILE:-.claude/todo.json}"

    if [[ ! -f "$todo_file" ]]; then
        COMPREPLY=($(compgen -W "setup core testing polish maintenance" -- "$cur"))
        return 0
    fi

    local phases
    phases=$(jq -r '.project.phases | keys[]' "$todo_file" 2>/dev/null)

    if [[ -z "$phases" ]]; then
        phases="setup core testing polish maintenance"
    fi

    COMPREPLY=($(compgen -W "$phases" -- "$cur"))
}

# Complete labels
_complete_labels() {
    local cur="${COMP_WORDS[COMP_CWORD]}"
    local todo_file="${TODO_FILE:-.claude/todo.json}"

    if [[ ! -f "$todo_file" ]]; then
        return 0
    fi

    local labels
    labels=$(jq -r '.tasks[].labels[]? // empty' "$todo_file" 2>/dev/null | sort -u)

    COMPREPLY=($(compgen -W "$labels" -- "$cur"))
}

# Register completion for cleo and ct alias
complete -F _cleo_completions cleo
complete -F _cleo_completions ct
