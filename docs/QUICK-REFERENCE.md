# CLAUDE-TODO Quick Reference Card

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────┐
│ Global: ~/.claude-todo/                             │
│ ├── schemas/ (JSON Schema validation)              │
│ ├── scripts/ (user-facing operations)              │
│ ├── lib/ (shared functions)                        │
│ └── templates/ (starter files)                     │
└─────────────────────────────────────────────────────┘
                      │
                      │ Provides to
                      ▼
┌─────────────────────────────────────────────────────┐
│ Project: .claude/                                   │
│ ├── todo.json (active tasks)                       │
│ ├── todo-archive.json (completed)                  │
│ ├── todo-config.json (settings)                    │
│ ├── todo-log.json (audit trail)                    │
│ └── .backups/ (versioned backups)                  │
└─────────────────────────────────────────────────────┘
```

## Essential Commands

```bash
# SETUP
./install.sh                          # Install globally
claude-todo init                      # Initialize project

# TASKS
claude-todo add "Task description"    # Create task
claude-todo complete <task-id>        # Complete task
claude-todo list                      # List all tasks
claude-todo list --status pending     # Filter by status

# EXPORT (TodoWrite Integration)
claude-todo export --format todowrite # Export for Claude Code
claude-todo export --format markdown  # Export as checklist
claude-todo export --format json      # Export raw JSON
claude-todo export --format csv       # Export as CSV
claude-todo export --format tsv       # Export as TSV
claude-todo export --format jsonl     # Export as JSONL (streaming)

# MAINTENANCE
claude-todo archive                   # Archive completed tasks
claude-todo validate                  # Validate all files
claude-todo backup                    # Manual backup
claude-todo stats                     # Show statistics
claude-todo help                      # Show all commands
```

## Short Flags (v0.7.0+)

```bash
# Common short flags
-s STATUS      --status STATUS       # Filter/set status
-p PRIORITY    --priority PRIORITY   # Filter/set priority
-l LABEL       --label(s) LABEL      # Filter/set labels
-f FORMAT      --format FORMAT       # Output format
-v             --verbose             # Verbose output
-c             --compact             # Compact view
-q             --quiet               # Quiet mode (scripting)
-h             --help                # Show help

# Examples
claude-todo list -s pending -p high  # Pending high-priority tasks
claude-todo add "Task" -p critical -l bug,urgent -q  # Add quietly
claude-todo export -f csv            # Export as CSV
NO_COLOR=1 claude-todo list          # Disable colors
FORCE_COLOR=1 claude-todo list       # Force colors in CI
```

## Output Formats

| Format | Flag | Use Case |
|--------|------|----------|
| text | `-f text` | Human terminal (default) |
| json | `-f json` | API with `_meta` envelope |
| jsonl | `-f jsonl` | Streaming, log processing |
| csv | `-f csv` | Spreadsheets, data analysis |
| tsv | `-f tsv` | Unix pipelines |
| markdown | `-f markdown` | Documentation |
| table | `-f table` | Compact ASCII tables |

## Data Flow Patterns

### Task Lifecycle
```
CREATE → VALIDATE → WRITE → BACKUP → LOG
  ↓
PENDING → ACTIVE → DONE
            ↓
         BLOCKED (optional)
            ↓
         ARCHIVE (after N days)
```

### Validation Pipeline
```
JSON → Schema Check → Anti-Hallucination → Cross-File → ✅ Valid
        ↓               ↓                    ↓
     Structure      Semantics           Integrity
```

### Atomic Write Pattern
```
1. Write to .tmp
2. Validate .tmp
3. Backup original
4. Atomic rename .tmp → .json
5. Rollback on error
```

## Anti-Hallucination Checks

| Check | Purpose | Example Error |
|-------|---------|---------------|
| **ID Uniqueness** | No duplicate IDs | "Duplicate ID: T001" |
| **Status Enum** | Valid status only | "Invalid status: 'completed'" |
| **Timestamp Sanity** | Not in future | "createdAt in future" |
| **Content Pairing** | Both title & description | "Missing description" |
| **Duplicate Content** | No identical tasks | "Duplicate: 'Fix bug'" |

## File Interaction Matrix

| Operation | todo.json | archive.json | config.json | log.json |
|-----------|-----------|--------------|-------------|----------|
| **add-task** | R+W | - | R | W |
| **complete-task** | R+W | - | R | W |
| **archive** | R+W | R+W | R | W |
| **list-tasks** | R | R* | R | - |
| **stats** | R | R | R | R |
| **validate** | R | R | R | R |

*R* = Read, *W* = Write, *R+W* = Read then Write (atomic update)

## Configuration Hierarchy

```
Defaults → Global → Project → Environment → CLI
           (~/.c-t)  (.claude)  (CLAUDE_TODO_*) (--flags)
                                                    │
                                              Final Value
```

## Schema Files

| File | Purpose | Key Validations |
|------|---------|-----------------|
| **todo.schema.json** | Active tasks | Status enum, required fields |
| **archive.schema.json** | Completed tasks | Same as todo.schema.json |
| **config.schema.json** | Configuration | Value ranges, types |
| **log.schema.json** | Change log | Operation types, timestamps |

## Library Functions

### validation.sh
```bash
validate_schema "$file"              # JSON Schema validation
validate_anti_hallucination "$file"  # Semantic checks
check_duplicate_ids "$file1" "$file2" # Cross-file uniqueness
```

### file-ops.sh
```bash
atomic_write "$file" "$content"      # Safe file writing
backup_file "$file"                  # Create versioned backup
restore_backup "$backup_file"        # Restore from backup
```

### logging.sh
```bash
log_operation "create" "$task_id"    # Log to todo-log.json
create_log_entry "$operation" "$id"  # Generate log entry
```

### config.sh
**Note**: Not implemented. Configuration is loaded directly in scripts using jq.

## Task Object Structure

```json
{
  "id": "T001",
  "status": "pending|active|blocked|done",
  "title": "Fix navigation bug",
  "description": "Navigation links not working on mobile viewports",
  "createdAt": "2025-12-05T10:00:00Z",
  "completedAt": "2025-12-05T10:30:00Z"
}
```

## Log Entry Structure

```json
{
  "id": "log_abc123def456",
  "timestamp": "2025-12-05T10:00:00Z",
  "sessionId": "session_xyz789",
  "action": "status_changed",
  "actor": "claude",
  "taskId": "T001",
  "before": {"status": "pending"},
  "after": {"status": "active"},
  "details": null
}
```

## Backup Rotation

```
.backups/
├── todo.json.1  ← Most recent (current backup)
├── todo.json.2
├── ...
└── todo.json.10 ← Oldest (will be rotated out)

On next operation:
├── todo.json.1  ← NEW backup
├── todo.json.2  ← Was .1
└── [old .10 deleted]
```

## Error Codes

| Code | Meaning |
|------|---------|
| **0** | Success |
| **1** | Schema validation error |
| **2** | Semantic validation error (anti-hallucination) |
| **3** | File operation error |
| **4** | Configuration error |

## Common Patterns

### Adding Custom Validation
```bash
# .claude/validators/my-validator.sh
validate_custom() {
    local todo_file="$1"
    # Custom validation logic
    return 0  # Success
}
```

### Event Hook
```bash
# .claude/hooks/on-task-create.sh
#!/usr/bin/env bash
task_id="$1"
# Custom action (notify, log, sync)
```

### Custom Formatter
```bash
# ~/.claude-todo/formatters/csv-export.sh
format_csv() {
    local todo_file="$1"
    jq -r '.tasks[] | [.id, .status, .title] | @csv' "$todo_file"
}
```

## Testing Quick Reference

```bash
# Run all tests
./tests/run-all-tests.sh

# Run specific test
./tests/test-validation.sh

# Test with fixtures
./tests/test-validation.sh fixtures/valid-todo.json
```

## Debugging

```bash
# Verbose mode
CLAUDE_TODO_LOG_LEVEL=debug ./scripts/add-task.sh "Test"

# Trace execution
bash -x ./scripts/archive.sh

# Validate specific file
jq -e . .claude/todo.json && echo "Valid JSON"
```

## Performance Targets

| Operation | Target | Note |
|-----------|--------|------|
| Task creation | < 100ms | Single task |
| Task completion | < 100ms | Single task |
| Archive | < 500ms | 100 tasks |
| Validation | < 200ms | 100 tasks |
| List | < 50ms | 100 tasks |

## Best Practices

1. **Always validate** before committing changes
2. **Use atomic writes** for all file operations
3. **Backup before modify** - automatic with atomic_write()
4. **Log all operations** - audit trail is critical
5. **Check return codes** - handle errors gracefully
6. **Quote variables** - `"$var"` not `$var`
7. **Use readonly** for constants
8. **Document functions** - purpose, args, returns

## Common Error Messages

| Error | Cause | Fix |
|-------|-------|-----|
| "Duplicate ID: T001" | Same ID exists | Regenerate ID |
| "Missing description" | Task incomplete | Add description field |
| "Invalid status: 'completed'" | Wrong enum value | Use: pending, active, blocked, or done |
| "Timestamp in future" | Clock skew | Check system time |
| "Schema validation failed" | Structure wrong | Check against schema |

## Recommended Aliases

```bash
# Add to ~/.bashrc or ~/.zshrc (optional - claude-todo is already short)
alias ct='claude-todo'
alias ct-add='claude-todo add'
alias ct-list='claude-todo list'
alias ct-complete='claude-todo complete'
alias ct-archive='claude-todo archive'
alias ct-stats='claude-todo stats'
alias ct-validate='claude-todo validate'
```

## Directory Permissions

```bash
# Data files
chmod 644 .claude/todo*.json

# Scripts
chmod 755 ~/.claude-todo/scripts/*.sh

# Backups (owner only)
chmod 700 .claude/.backups/
chmod 600 .claude/.backups/*.json
```

## Key Design Principles

1. **Single Source of Truth**: todo.json is authoritative
2. **Immutable History**: Append-only log
3. **Fail-Safe Operations**: Atomic writes with rollback
4. **Schema-First**: Validation prevents corruption
5. **Zero-Config Defaults**: Works out of the box

## Extension Points

| Type | Location | Purpose |
|------|----------|---------|
| **Validators** | `.claude/validators/` | Custom validation rules |
| **Hooks** | `.claude/hooks/` | Event-triggered actions |
| **Formatters** | `~/.claude-todo/formatters/` | Output formats |
| **Integrations** | `~/.claude-todo/integrations/` | External system sync |

## Documentation Links

| Document | Purpose |
|----------|---------|
| **[ARCHITECTURE.md](architecture/ARCHITECTURE.md)** | Complete system design |
| **[DATA-FLOW-DIAGRAMS.md](architecture/DATA-FLOWS.md)** | Visual workflows |
| **[ARCHITECTURE.md#executive-summary](architecture/ARCHITECTURE.md#executive-summary)** | Executive overview |
| **[usage.md](usage.md)** | Detailed usage guide |
| **[configuration.md](reference/configuration.md)** | Config reference |

## Upgrade Path

```bash
# Check current version
cat ~/.claude-todo/VERSION

# Upgrade to latest
cd claude-todo
git pull
./install.sh --upgrade

# Migrations run automatically
```

## Health Check

```bash
# Run system health check

Checks:
✅ File integrity
✅ Schema compliance
✅ Backup freshness
✅ Log file size
✅ Archive size
✅ Configuration validity
```

## When Things Go Wrong

```bash
# 1. Validate files
claude-todo validate

# 2. Try auto-fix
claude-todo validate --fix

# 3. Check backups
ls -lh .claude/.backups/

# 4. Restore if needed
claude-todo restore .claude/.backups/todo.json.1

# 5. Check logs
jq '.entries[-10:]' .claude/todo-log.json
```

## Installation Checklist

- [ ] Clone repository
- [ ] Run `./install.sh`
- [ ] Verify `~/.claude-todo/` created
- [ ] Source shell config or restart terminal
- [ ] Navigate to project
- [ ] Run `claude-todo init`
- [ ] Verify `.claude/` created
- [ ] Check `.gitignore` updated
- [ ] Run `claude-todo validate` to confirm
- [ ] Run `claude-todo add "Test task"` to test

## Quick Troubleshooting

**Problem**: "Permission denied"
**Solution**: `chmod 755 ~/.claude-todo/scripts/*.sh`

**Problem**: "Invalid JSON"
**Solution**: `claude-todo validate --fix` or restore backup

**Problem**: "Duplicate ID"
**Solution**: Edit JSON manually or restore backup

**Problem**: "Missing schema"
**Solution**: Re-run `./install.sh`

---

**For detailed information, always refer to [ARCHITECTURE.md](architecture/ARCHITECTURE.md)**
