#compdef cleo ct
#####################################################################
# zsh-completion.zsh - Zsh completion for cleo CLI
#
# Installation:
#   # Copy to your fpath (e.g., ~/.zsh/completions/):
#   mkdir -p ~/.zsh/completions
#   cp ~/.cleo/completions/zsh-completion.zsh \
#       ~/.zsh/completions/_cleo
#
#   # Add to ~/.zshrc:
#   fpath=(~/.zsh/completions $fpath)
#   autoload -Uz compinit && compinit
#
# Part of: Hierarchy Enhancement Phase 2 (T347)
#####################################################################

_cleo() {
    local curcontext="$curcontext" state line
    typeset -A opt_args

    local -a commands
    commands=(
        'add:Create a new task'
        'update:Update an existing task'
        'complete:Mark a task as done'
        'list:List tasks with filters'
        'show:Show task details'
        'focus:Manage task focus'
        'session:Manage work sessions'
        'archive:Archive completed tasks'
        'validate:Validate data integrity'
        'backup:Create backup'
        'restore:Restore from backup'
        'migrate:Run schema migrations'
        'stats:Show statistics'
        'deps:Show dependencies'
        'blockers:Show blocked tasks'
        'next:Suggest next task'
        'analyze:Analyze task triage'
        'dash:Project dashboard'
        'labels:List labels'
        'phases:Show phase progress'
        'phase:Manage current phase'
        'find:Search tasks'
        'export:Export tasks'
        'init:Initialize project'
        'log:View audit log'
        'sync:Sync with TodoWrite'
        'tree:Show hierarchy tree'
        'history:Show completion history'
        'exists:Check if task exists'
        'reparent:Move task to new parent'
        'promote:Promote task to root level'
        'research:Research and discover'
    )

    local -a global_opts
    global_opts=(
        '(-h --help)'{-h,--help}'[Show help]'
        '--version[Show version]'
        '--format[Output format]:format:(text json jsonl markdown table)'
        '(-q --quiet)'{-q,--quiet}'[Minimal output]'
    )

    _arguments -C \
        $global_opts \
        '1: :->command' \
        '*: :->args'

    case $state in
        command)
            _describe -t commands 'cleo commands' commands
            ;;
        args)
            case $words[2] in
                add|new)
                    _arguments \
                        '--parent[Parent task ID]:parent task:_cleo_parent_tasks' \
                        '--type[Task type]:type:(epic task subtask)' \
                        '--priority[Priority level]:priority:(critical high medium low)' \
                        '--status[Status]:status:(pending active blocked done)' \
                        '--phase[Project phase]:phase:_cleo_phases' \
                        '--size[Task size]:size:(small medium large)' \
                        '--labels[Labels (comma-separated)]:labels:_cleo_labels' \
                        '--depends[Dependencies]:depends:_cleo_task_ids' \
                        '--description[Description]:description:' \
                        '--blocked-by[Blocked reason]:reason:' \
                        '(-q --quiet)'{-q,--quiet}'[Minimal output]' \
                        '--format[Output format]:format:(text json)'
                    ;;

                update|edit)
                    _arguments \
                        '1:task id:_cleo_task_ids' \
                        '--title[New title]:title:' \
                        '--description[Description]:description:' \
                        '--priority[Priority]:priority:(critical high medium low)' \
                        '--status[Status]:status:(pending active blocked done)' \
                        '--labels[Labels]:labels:_cleo_labels' \
                        '--depends[Dependencies]:depends:_cleo_task_ids' \
                        '--notes[Add note]:notes:' \
                        '--phase[Phase]:phase:_cleo_phases' \
                        '--parent[Parent task]:parent:_cleo_parent_tasks' \
                        '--type[Task type]:type:(epic task subtask)' \
                        '--size[Size]:size:(small medium large)' \
                        '--blocked-by[Blocked reason]:reason:'
                    ;;

                complete|done)
                    _arguments \
                        '1:task id:_cleo_pending_tasks' \
                        '--notes[Completion notes]:notes:' \
                        '--skip-notes[Skip notes prompt]' \
                        '(-q --quiet)'{-q,--quiet}'[Minimal output]' \
                        '--format[Output format]:format:(text json)'
                    ;;

                list|ls)
                    _arguments \
                        '--status[Filter by status]:status:(pending active blocked done)' \
                        '--priority[Filter by priority]:priority:(critical high medium low)' \
                        '--phase[Filter by phase]:phase:_cleo_phases' \
                        '--label[Filter by label]:label:_cleo_labels' \
                        '--type[Filter by type]:type:(epic task subtask)' \
                        '--parent[Filter by parent]:parent:_cleo_parent_tasks' \
                        '--children[Show children of task]:task:_cleo_task_ids' \
                        '--tree[Show as hierarchy tree]' \
                        '--group-priority[Group by priority]' \
                        '--format[Output format]:format:(text json jsonl markdown table)' \
                        '(-q --quiet)'{-q,--quiet}'[Minimal output]' \
                        '--human[Force human-readable output]'
                    ;;

                show)
                    _arguments \
                        '1:task id:_cleo_task_ids' \
                        '--history[Include task history]' \
                        '--related[Show related tasks]' \
                        '--include-archive[Search archive]' \
                        '--format[Output format]:format:(text json)'
                    ;;

                focus)
                    local -a focus_cmds
                    focus_cmds=(
                        'set:Set focus on task'
                        'show:Show current focus'
                        'clear:Clear focus'
                        'note:Set session note'
                        'next:Set next action'
                    )
                    _arguments \
                        '1:subcommand:((${(j: :)focus_cmds}))' \
                        '2:task id:_cleo_pending_tasks'
                    ;;

                reparent)
                    _arguments \
                        '1:task id:_cleo_task_ids' \
                        '--to[New parent (empty for root)]:parent:_cleo_parent_tasks' \
                        '--format[Output format]:format:(text json)' \
                        '(-q --quiet)'{-q,--quiet}'[Minimal output]'
                    ;;

                promote)
                    _arguments \
                        '1:task id:_cleo_task_ids' \
                        '--no-type-update[Keep subtask type]' \
                        '--format[Output format]:format:(text json)' \
                        '(-q --quiet)'{-q,--quiet}'[Minimal output]'
                    ;;

                phase)
                    local -a phase_cmds
                    phase_cmds=(
                        'show:Show current phase'
                        'set:Set current phase'
                        'advance:Advance to next phase'
                        'complete:Complete current phase'
                        'list:List all phases'
                    )
                    _arguments \
                        '1:subcommand:((${(j: :)phase_cmds}))' \
                        '2:phase:_cleo_phases'
                    ;;

                session)
                    local -a session_cmds
                    session_cmds=(
                        'start:Start work session'
                        'end:End work session'
                        'status:Show session status'
                        'pause:Pause session'
                        'resume:Resume session'
                    )
                    _describe -t session 'session command' session_cmds
                    ;;

                deps)
                    _arguments \
                        '1:task id:_cleo_task_ids' \
                        'tree:Show full dependency tree' \
                        '--format[Output format]:format:(text json)'
                    ;;

                validate|check)
                    _arguments \
                        '--fix[Fix checksum issues]' \
                        '--check-orphans[Check for orphaned tasks]' \
                        '--fix-orphans[Fix orphaned tasks]:mode:(unlink delete)' \
                        '--format[Output format]:format:(text json)'
                    ;;

                find|search)
                    _arguments \
                        '1:query:' \
                        '--id[Search by ID prefix]:prefix:' \
                        '--exact[Exact match mode]' \
                        '--status[Filter by status]:status:(pending active blocked done)' \
                        '--field[Search field]:field:(title description)' \
                        '--include-archive[Include archived tasks]' \
                        '--format[Output format]:format:(text json)'
                    ;;

                export)
                    _arguments \
                        '--format[Export format]:format:(todowrite csv json markdown)' \
                        '--output[Output file]:file:_files' \
                        '--filter[Filter expression]:filter:'
                    ;;

                *)
                    _message "no more arguments"
                    ;;
            esac
            ;;
    esac
}

# Complete parent-eligible tasks (epic and task types)
_cleo_parent_tasks() {
    local todo_file="${TODO_FILE:-.claude/todo.json}"
    if [[ ! -f "$todo_file" ]]; then
        return
    fi

    local -a tasks
    tasks=(${(f)"$(jq -r '.tasks[] | select(.type != "subtask") | "\(.id):\(.title | .[0:40])"' "$todo_file" 2>/dev/null)"})
    _describe -t tasks 'parent task' tasks
}

# Complete all task IDs
_cleo_task_ids() {
    local todo_file="${TODO_FILE:-.claude/todo.json}"
    if [[ ! -f "$todo_file" ]]; then
        return
    fi

    local -a tasks
    tasks=(${(f)"$(jq -r '.tasks[] | "\(.id):\(.title | .[0:40])"' "$todo_file" 2>/dev/null)"})
    _describe -t tasks 'task' tasks
}

# Complete pending/active task IDs
_cleo_pending_tasks() {
    local todo_file="${TODO_FILE:-.claude/todo.json}"
    if [[ ! -f "$todo_file" ]]; then
        return
    fi

    local -a tasks
    tasks=(${(f)"$(jq -r '.tasks[] | select(.status == "pending" or .status == "active" or .status == "blocked") | "\(.id):\(.title | .[0:40])"' "$todo_file" 2>/dev/null)"})
    _describe -t tasks 'task' tasks
}

# Complete phases
_cleo_phases() {
    local todo_file="${TODO_FILE:-.claude/todo.json}"

    local -a phases
    if [[ -f "$todo_file" ]]; then
        phases=(${(f)"$(jq -r '.project.phases | keys[]' "$todo_file" 2>/dev/null)"})
    fi

    if [[ ${#phases} -eq 0 ]]; then
        phases=(setup core testing polish maintenance)
    fi

    _describe -t phases 'phase' phases
}

# Complete labels
_cleo_labels() {
    local todo_file="${TODO_FILE:-.claude/todo.json}"
    if [[ ! -f "$todo_file" ]]; then
        return
    fi

    local -a labels
    labels=(${(f)"$(jq -r '.tasks[].labels[]? // empty' "$todo_file" 2>/dev/null | sort -u)"})
    _describe -t labels 'label' labels
}

_cleo "$@"
