<!-- CLAUDE-TODO:START v0.12.5 -->
## Task Management (claude-todo)

Use `ct` (alias for `claude-todo`) for all task operations. Full docs: `~/.claude-todo/docs/TODO_Task_Management.md`

### Essential Commands
```bash
ct list                    # View tasks
ct add "Task"              # Create task
ct done <id>               # Complete task
ct focus set <id>          # Set active task
ct focus show              # Show current focus
ct session start|end       # Session lifecycle
ct exists <id>             # Verify task exists
ct dash                    # Project overview
```

### Data Integrity
- **CLI only** - Never edit `.claude/*.json` directly
- **Verify state** - Use `ct list` before assuming
- **Session discipline** - Start/end sessions properly
<!-- CLAUDE-TODO:END -->
