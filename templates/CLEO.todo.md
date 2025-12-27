<!-- CLEO:START v0.37.0 -->
## Task Management (cleo CLI)

Use the `cleo` CLI for **all** task operations. Never read or edit `.cleo/*.json` files directly.

### Quick Reference
```bash
cleo list                    # View tasks
cleo add "Task title"        # Create task
cleo complete <task-id>      # Mark done
cleo focus set <task-id>     # Set focus (marks active)
cleo focus show              # Show current focus
cleo session start           # Start session
cleo session end             # End session
cleo validate                # Check file integrity
cleo archive                 # Archive completed tasks
cleo stats                   # Show statistics
cleo log --action <type>     # Add log entry
cleo help                    # All commands
```

### Session Protocol

**START** (beginning of work session):
```bash
cleo session start           # Logs session, shows context
cleo list                    # See pending tasks
cleo focus show              # Check last focus/notes
```

**WORK** (during session):
```bash
cleo focus set <task-id>     # Set focus (one task only)
cleo add "Subtask"           # Add new tasks as needed
cleo focus note "Progress"   # Update session note
cleo focus next "Next step"  # Set next action hint
```

**END** (before ending session):
```bash
cleo complete <task-id>      # Complete finished tasks
cleo archive                 # Clean up old completed tasks
cleo focus note "Status..."  # Save context for next session
cleo session end             # End session with optional note
```

### Task Commands
```bash
# Add task with options
cleo add "Task title" \
  --status pending \
  --priority high \
  --description "Details" \
  --labels "backend,api"

# Complete task
cleo complete <task-id>

# List with filters
cleo list --status pending --priority high

# JSON output (wrapped with metadata - access via .tasks[])
cleo list --format json | jq '.tasks[] | select(.status == "pending")'
cleo list --format json | jq -r '.tasks[].id'
```

### Focus Commands
```bash
cleo focus set <task-id>     # Set focus + mark active
cleo focus clear             # Clear focus
cleo focus show              # Show focus state
cleo focus note "text"       # Set progress note
cleo focus next "action"     # Set next action
```

### Session Commands
```bash
cleo session start           # Start new session
cleo session end             # End session
cleo session end --note "..."# End with note
cleo session status          # Check session state
cleo session info            # Detailed info
```

### Status Values
- `pending` - Not yet started
- `active` - Currently working (limit: ONE)
- `blocked` - Waiting on dependency
- `done` - Completed

### Anti-Hallucination Rules

**CRITICAL - ALWAYS FOLLOW:**
- **CLI only** - Never read/edit `.cleo/*.json` files directly
- **One active task** - Use `cleo focus set` (enforces single active)
- **Verify state** - Use `cleo list` to confirm, don't assume
- **Session discipline** - Start/end sessions properly
- **Archive is immutable** - Never try to modify archived tasks

### Aliases (installed automatically)
```bash
ct          # cleo
ct-add      # cleo add
ct-list     # cleo list
ct-done     # cleo complete
ct-focus    # cleo focus
```

### Error Recovery
```bash
cleo validate --fix          # Fix issues
cleo restore <backup>        # Restore from backup
ls .cleo/.backups/           # List backups
```
<!-- CLEO:END -->
