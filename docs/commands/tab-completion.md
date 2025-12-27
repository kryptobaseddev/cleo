# Tab Completion

> Shell completion for cleo CLI commands, options, and task IDs

## Overview

Tab completion provides intelligent suggestions for commands, options, and values as you type. The completion scripts are context-aware and filter suggestions based on your current command.

## Installation

### Bash

Add to `~/.bashrc`:

```bash
source ~/.cleo/completions/bash-completion.sh
```

**Alternative (system-wide):**
```bash
sudo cp ~/.cleo/completions/bash-completion.sh /etc/bash_completion.d/cleo
```

### Zsh

Add to `~/.zshrc`:

```bash
fpath=(~/.cleo/completions $fpath)
autoload -Uz compinit && compinit
```

**Alternative (explicit copy):**
```bash
mkdir -p ~/.zsh/completions
cp ~/.cleo/completions/zsh-completion.zsh ~/.zsh/completions/_cleo
```

Then add to `~/.zshrc`:
```bash
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit && compinit
```

## Features

### Command Completion

All 30+ commands are supported with descriptions:

```bash
cleo <TAB>  # Shows: add, update, complete, list, show, focus...
ct <TAB>           # Same (alias supported)
```

**Supported commands:**
- `add`, `update`, `complete`, `list`, `show`
- `focus`, `session`, `archive`, `validate`, `backup`, `restore`
- `migrate`, `stats`, `deps`, `blockers`, `next`, `analyze`
- `dash`, `labels`, `phases`, `phase`, `find`, `search`
- `export`, `init`, `log`, `sync`, `tree`, `history`
- `exists`, `reparent`, `promote`, `research`, `dig`

### Flag Completion

Each command has context-aware flag completion:

```bash
ct add --<TAB>         # Shows: --parent, --type, --priority, --phase, --labels...
ct list --<TAB>        # Shows: --status, --priority, --phase, --type, --tree...
ct update T001 --<TAB> # Shows: --title, --description, --priority, --status...
```

### Value Completion

Values are completed based on context:

| Flag | Completions |
|------|-------------|
| `--type` | `epic`, `task`, `subtask` |
| `--priority` | `critical`, `high`, `medium`, `low` |
| `--status` | `pending`, `active`, `blocked`, `done` |
| `--size` | `small`, `medium`, `large` |
| `--phase` | Project phases from todo.json or defaults |
| `--labels` | Existing labels from your tasks |
| `--format` | `text`, `json`, `jsonl`, `markdown`, `table` |

### Task ID Completion

Task IDs are completed from your project's todo.json:

```bash
ct complete <TAB>       # Shows: T001, T002, T003... (pending/active/blocked)
ct show <TAB>           # Shows: all task IDs
ct focus set <TAB>      # Shows: pending/active task IDs only
ct update <TAB>         # Shows: all task IDs
ct deps <TAB>           # Shows: all task IDs
```

**Zsh bonus:** Task titles are shown alongside IDs for easier identification:
```
T001:Setup project structure
T002:Implement core features
T003:Write documentation
```

### Context-Aware Parent Completion

The `--parent` flag uses intelligent filtering:

```bash
ct add --parent <TAB>   # Shows only epic and task types (not subtask)
ct reparent T005 --to <TAB>  # Shows valid parent candidates
```

This prevents hierarchy violations by only suggesting valid parent tasks. Subtasks cannot be parents, so they are automatically filtered out.

### Status-Filtered Completion

Some commands only show tasks with relevant statuses:

| Command | Status Filter |
|---------|---------------|
| `complete` | pending, active, blocked |
| `focus set` | pending, active |
| `show` | all statuses |
| `update` | all statuses |

## Subcommand Completion

Commands with subcommands support nested completion:

### focus
```bash
ct focus <TAB>    # Shows: set, show, clear, note, next
ct focus set <TAB>   # Shows: pending/active task IDs
```

### session
```bash
ct session <TAB>  # Shows: start, end, status, pause, resume
```

### phase
```bash
ct phase <TAB>    # Shows: show, set, advance, complete, list
ct phase set <TAB>   # Shows: available phases
```

### deps
```bash
ct deps <TAB>     # Shows: task IDs or 'tree'
ct deps tree      # Show full dependency tree
```

## Command-Specific Options

### add / new
```bash
ct add "Task" --<TAB>
# --parent, --type, --priority, --status, --phase, --size
# --labels, --depends, --description, --blocked-by, --quiet, --format
```

### update / edit
```bash
ct update T001 --<TAB>
# --title, --description, --priority, --status, --labels
# --depends, --notes, --phase, --parent, --type, --size, --blocked-by
```

### list / ls
```bash
ct list --<TAB>
# --status, --priority, --phase, --label, --type, --parent
# --children, --tree, --group-priority, --format, --quiet, --human
```

### validate / check
```bash
ct validate --<TAB>
# --fix, --check-orphans, --fix-orphans, --format
```

### find / search
```bash
ct find "query" --<TAB>
# --id, --exact, --status, --field, --format, --include-archive
```

### export
```bash
ct export --<TAB>
# --format (todowrite, csv, json, markdown), --output, --filter
```

### reparent
```bash
ct reparent T001 --<TAB>
# --to (parent task IDs), --format, --quiet
```

### promote
```bash
ct promote T001 --<TAB>
# --no-type-update, --format, --quiet
```

## Troubleshooting

### Completion Not Working

1. **Verify script is sourced:**
   ```bash
   # Bash
   type _claude_todo_completions  # Should show function definition

   # Zsh
   type _claude_todo  # Should show function definition
   ```

2. **Re-source your shell config:**
   ```bash
   source ~/.bashrc   # or ~/.zshrc
   ```

3. **Check file exists:**
   ```bash
   ls -la ~/.cleo/completions/
   ```

4. **Verify jq is installed (required for task ID completion):**
   ```bash
   which jq
   ```

### Task IDs Not Appearing

The completion scripts read from `.cleo/todo.json` in the current directory. Ensure you're in a project with initialized cleo.

```bash
cd /path/to/your/project
cleo list  # Verify tasks exist
ct add --parent <TAB>  # Should now show task IDs
```

### Zsh Completion Cache

If completions are stale, rebuild the cache:

```bash
rm -f ~/.zcompdump*
compinit
```

### Bash Completion Not Triggering

Ensure bash-completion is enabled in your shell:

```bash
# Check if bash-completion is loaded
if type _init_completion &>/dev/null; then
    echo "bash-completion is available"
fi
```

## Customization

### Custom TODO_FILE Location

If you use a custom todo file location, set the environment variable:

```bash
export TODO_FILE="/custom/path/.cleo/todo.json"
```

### Adding Custom Completions

Both scripts can be extended. The key functions are:

| Function (Bash) | Function (Zsh) | Purpose |
|-----------------|----------------|---------|
| `_complete_parent_tasks` | `_claude_todo_parent_tasks` | Parent-eligible tasks |
| `_complete_task_ids` | `_claude_todo_task_ids` | All task IDs |
| `_complete_phases` | `_claude_todo_phases` | Phase slugs |
| `_complete_labels` | `_claude_todo_labels` | Existing labels |
| - | `_claude_todo_pending_tasks` | Pending/active tasks only |

## Technical Details

### Bash Implementation
- Uses `complete -F` with `COMPREPLY` array
- Function: `_claude_todo_completions`
- Registers for both `cleo` and `ct` commands
- Uses `compgen -W` for word generation

### Zsh Implementation
- Uses `_arguments` and `compadd` for completion
- Uses `_describe` for labeled completions
- Function: `_claude_todo`
- Provides command descriptions in completion menu
- Supports task title preview alongside IDs

### Default Phases

When no project phases are defined, completions fall back to:
- `setup`, `core`, `testing`, `polish`, `maintenance`

## Related Documentation

- [Command Reference](../INDEX.md) - Full command documentation
- [Task Hierarchy](hierarchy.md) - Epic/Task/Subtask structure
- [Phase Management](../INDEX.md#phases) - Phase system overview
