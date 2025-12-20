<!-- CLAUDE-TODO:START v0.21.0 -->
## Task Management (claude-todo)

Use `ct` (alias for `claude-todo`) for all task operations. Full docs: `~/.claude-todo/docs/TODO_Task_Management.md`

### Essential Commands
```bash
ct list                    # View tasks (JSON when piped)
ct find "query"            # Fuzzy search (99% less context than list)
ct add "Task"              # Create task
ct done <id>               # Complete task
ct focus set <id>          # Set active task
ct focus show              # Show current focus
ct session start|end       # Session lifecycle
ct exists <id>             # Verify task exists
ct dash                    # Project overview
ct analyze                 # Task triage (JSON default)
ct analyze --auto-focus    # Auto-set focus to top task
```

### LLM-Agent-First Design
- **JSON auto-detection**: Piped output → JSON (no `--format` needed)
- **Native filters**: Use `--status`, `--label`, `--phase` instead of jq
- **Context-efficient**: Prefer `find` over `list` for task discovery
- **Command discovery**: `ct commands -r critical` (no jq needed)

### Phase Tracking (v0.13.3+)
```bash
ct phases                  # List phases with progress
ct phase set <slug>        # Set current project phase
ct phase show              # Show current phase
ct list --phase core       # Filter tasks by phase
```

### Data Integrity
- **CLI only** - Never edit `.claude/*.json` directly
- **Verify state** - Use `ct list` before assuming
- **Session discipline** - Start/end sessions properly
<!-- CLAUDE-TODO:END -->
