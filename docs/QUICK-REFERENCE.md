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

## Essential Commands (v0.8.2)

```bash
# SETUP
./install.sh                          # Install globally
claude-todo init                      # Initialize project

# TASKS
claude-todo add "Task description"    # Create task
claude-todo complete <id> --notes "What was done"  # Complete with notes (required)
claude-todo complete <id> --skip-notes             # Quick complete (bypass notes)
claude-todo list                      # List all tasks
claude-todo list --status pending     # Filter by status
claude-todo next                      # Get next task suggestion
claude-todo next --explain            # Show why task is suggested

# Note: complete command requires either --notes or --skip-notes flag

# FOCUS MANAGEMENT
claude-todo focus set <id>            # Set focus to task (marks active)
claude-todo focus clear               # Clear current focus
claude-todo focus show                # Show current focus
claude-todo focus note "text"         # Set session progress note
claude-todo focus next "text"         # Set suggested next action

# DASHBOARD & ANALYTICS
claude-todo dash                      # Full dashboard overview
claude-todo dash --compact            # Single-line summary
claude-todo labels                    # List all labels with counts
claude-todo labels show backend       # Show tasks with specific label
claude-todo labels stats              # Detailed label statistics

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
claude-todo backup --list             # List available backups
claude-todo restore <backup-path>     # Restore from backup
claude-todo restore <backup> --file todo.json  # Restore specific file
claude-todo restore <backup> --force  # Skip confirmation prompt
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

### validation.sh - Data Validation

#### Schema & Syntax
```bash
validate_schema "$file" "todo"       # JSON Schema validation (todo|archive|config|log)
validate_json_syntax "$file"         # Check JSON syntax with jq
validate_version "$file" "todo"      # Check version, trigger migration if needed
```

#### Task Validation
```bash
validate_title "$title"              # Title rules (max 120, no newlines, no invisible chars)
validate_task "$file" 0              # Validate task at index (all fields, timestamps)
validate_status_transition "pending" "active"  # Check if transition allowed
```

#### Anti-Hallucination Checks
```bash
check_id_uniqueness "$todo" "$archive"  # No duplicate IDs within/across files
check_timestamp_sanity "$created" "$completed"  # Timestamps valid, not future
normalize_labels "bug,feature,bug"   # Returns "bug,feature" (deduplicated/sorted)
```

#### Dependency Validation
```bash
validate_no_circular_deps "$file" "T001" "T002,T003"  # Check no cycles in deps
check_circular_dependencies "$file" "T001" "T002"     # Wrapper with error handling
```

#### Timestamp Utilities
```bash
get_current_timestamp                # Get current ISO 8601 timestamp
timestamp_to_epoch "$iso_timestamp"  # Convert ISO 8601 to Unix epoch
```

#### Comprehensive Validation
```bash
validate_all "$file" "todo" "$archive"  # Full validation suite (8 checks)
# Returns: 0=success, 1=schema error, 2=semantic error, 3=both
```

### file-ops.sh - File Operations

#### Atomic Operations
```bash
atomic_write "$file" "$content"      # Safe file writing with temp file
backup_file "$file"                  # Create timestamped backup
restore_backup "$file" [num]         # Restore from backup (most recent or by number)
```

#### Directory & Locking
```bash
ensure_directory "$dir"              # Create dir with 755 permissions
lock_file "$file" fd_var [timeout]   # Acquire exclusive lock (default 30s timeout)
unlock_file "$fd"                    # Release file lock
```

#### JSON Operations
```bash
load_json "$file"                    # Load and validate JSON file
save_json "$file" "$json"            # Pretty-print and atomic write
```

#### Backup Management
```bash
rotate_backups "$dir" "basename" 10  # Keep only 10 most recent backups
list_backups "$file"                 # List backups with timestamps and sizes
```

### logging.sh - Audit Logging

#### Core Logging Functions
```bash
# Main logging operation (atomic append to log file)
log_operation action actor taskId [before] [after] [details] [sessionId] [log_path]

# Create log entry JSON object
create_log_entry action actor taskId [before] [after] [details] [sessionId]
```

#### Utility Functions
```bash
# Color output detection
should_use_color                     # Check if color output should be used (respects NO_COLOR/FORCE_COLOR)

# ID and timestamp generation
generate_log_id                      # Generate unique log entry ID (log_<12-hex-chars>)
get_timestamp                        # Get ISO 8601 timestamp

# Validation
validate_action action               # Validate action type against schema
validate_actor actor                 # Validate actor type (human|claude|system)
```

#### Log File Management
```bash
# Initialize log file with default structure
init_log_file [log_path]

# Rotation and pruning
rotate_log retention_days [log_path]           # Rotate log based on retention policy
check_and_rotate_log config_path [log_path]    # Check config and rotate if needed
```

#### Query Functions
```bash
# Get filtered log entries
get_log_entries filter_type filter_value [log_path]
# filter_type: action|taskId|actor|date_range|all
# filter_value: value to filter by (or "start,end" for date_range)

# Get recent entries
get_recent_log_entries count [log_path]        # Get N most recent entries (default: 10)

# Get statistics
get_log_stats [log_path]                       # Get log metadata (totalEntries, firstEntry, etc.)
```

#### Convenience Logging Functions
```bash
# Task operations
log_task_created task_id task_content [session_id]
log_status_changed task_id old_status new_status [session_id]
log_task_updated task_id field old_value new_value [session_id]

# Session operations
log_session_start session_id [details_json]
log_session_end session_id [details_json]

# System operations
log_validation result details_json
log_error error_code error_message [recoverable] [task_id]

# Error handling
handle_log_error error_message      # Handle logging errors gracefully (non-fatal)
```

#### Examples
```bash
# Manual logging
log_operation "task_created" "claude" "T001" "null" "null" '{"content":"Fix bug"}' "session123"

# Convenience functions
log_task_created "T001" "Fix navigation bug" "session123"
log_status_changed "T001" "pending" "active" "session123"
log_task_updated "T001" "priority" "low" "high" "session123"
log_session_start "session123" '{"note":"Started work on auth feature"}'
log_session_end "session123" '{"tasksCompleted":3}'
log_validation "passed" '{"errors":0,"warnings":2}'
log_error "E001" "File not found" "true" "T001"

# Query examples
get_log_entries "action" "task_created"              # All task creation events
get_log_entries "taskId" "T001"                      # All events for task T001
get_log_entries "date_range" "2025-12-01,2025-12-13" # Events in date range
get_recent_log_entries 20                            # Last 20 log entries
get_log_stats                                        # Log metadata
```

### cache.sh
```bash
# Cache initialization & validation
cache_init [todo_file]               # Initialize cache, rebuild if stale
cache_is_valid                       # Check if cache is valid
cache_invalidate [todo_file]         # Force cache rebuild
cache_get_metadata                   # Get cache metadata file path

# Label & phase queries
cache_get_tasks_by_label <label>     # Get comma-separated task IDs for label
cache_get_tasks_by_phase <phase>     # Get comma-separated task IDs in phase
cache_get_all_labels                 # Get all cached label names
cache_get_all_phases                 # Get all cached phase slugs
cache_get_label_count <label>        # Get task count for label
cache_get_phase_count <phase>        # Get task count in phase

# Cache statistics
cache_stats                          # Get cache statistics (JSON)

# Example usage
cache_init .claude/todo.json
label_tasks=$(cache_get_tasks_by_label "bug")
label_count=$(cache_get_label_count "bug")
```

### analysis.sh
```bash
# Dependency graph construction
build_dependency_graph [todo_file]          # Build task → dependent tasks mapping
build_reverse_dependency_graph [todo_file]  # Build task → dependencies mapping

# Task filtering & analysis
get_incomplete_tasks [todo_file]            # Get all non-completed tasks
get_blocked_tasks [todo_file]               # Get all blocked tasks with reasons

# Critical path analysis
find_longest_path_from <task_id> <graph> <visited>  # DFS for longest chain
find_critical_path [todo_file]              # Find longest dependency chain
build_path_chain <start_id> <graph> <todo_file>    # Build task chain from start

# Impact & bottleneck analysis
find_bottlenecks [todo_file]                # Find tasks blocking most others
calculate_impact <task_id> [todo_file]      # Count transitively dependent tasks

# Recommendations
generate_recommendations [todo_file]        # Generate task recommendations

# Example usage
critical_path=$(find_critical_path .claude/todo.json)
bottlenecks=$(find_bottlenecks .claude/todo.json)
impact=$(calculate_impact "T001" .claude/todo.json)
```

### output-format.sh - Output Formatting

#### Configuration & Detection
```bash
load_output_config              # Load output config from file (cached)
get_output_config "key"         # Get config value: color|unicode|progressBars|dateFormat|csvDelimiter|compactTitles|maxTitleLength
detect_color_support            # Check terminal color support (respects NO_COLOR/FORCE_COLOR)
detect_unicode_support          # Check Unicode/UTF-8 support (respects LC_ALL/LANG)
get_terminal_width              # Get terminal width in columns (COLUMNS → tput cols → 80)
```

#### Format Resolution & Validation
```bash
validate_format "json" "text,json,csv"   # Validate format against allowed list
resolve_format "$CLI_FMT" true "$VALID"  # Resolve format (CLI > env > config > default)
```

#### Status Formatting
```bash
status_color "pending"          # Get ANSI color code (37=dim white, 96=cyan, 33=yellow, 32=green)
status_symbol "active" true     # Get status symbol (Unicode: ○◉⊗✓, ASCII: -*x+)
```

#### Priority Formatting
```bash
priority_color "high"           # Get ANSI color code (91=red, 93=yellow, 94=blue, 90=gray)
priority_symbol "critical" true # Get priority symbol (Unicode: 🔴🟡🔵⚪, ASCII: !HML)
```

#### Progress Visualization
```bash
progress_bar 80 100 20 true     # Generate progress bar: [████████░░] 80%
progress_bars_enabled           # Check if progress bars enabled in config
```

#### Box Drawing
```bash
draw_box "TL" true              # Return box character: TL|TR|BL|BR|H|V (Unicode: ╭╮╰╯─│, ASCII: ++--)
```

#### Output Helpers
```bash
print_colored 32 "Success" true       # Print colored text (ANSI color, text, newline)
print_header "Section" 60 true        # Print boxed section header
print_task_line "T001" "active" "high" "Fix bug" true  # Format task line with colors
```

#### Date & Title Formatting
```bash
format_date "2025-12-12T10:30:00Z"    # Format date per config (iso8601|relative|unix|locale)
truncate_title "Long title" 50        # Truncate title with ellipsis (respects config)
```

#### CSV & Text Utilities
```bash
get_csv_delimiter               # Get configured CSV delimiter (default: comma)
pluralize 5 "task" "tasks"      # Return singular/plural form (count, singular, [plural])
```

**Example Usage**:
```bash
# Check capabilities
if detect_color_support; then
  print_colored 32 "Colors enabled!"
fi

# Format with detection
unicode=$(detect_unicode_support && echo "true" || echo "false")
status=$(status_symbol "active" "$unicode")
echo "$status Task in progress"

# Create progress bar
progress=$(progress_bar 75 100 30 true)
echo "Progress: $progress"

# Format dates
formatted=$(format_date "2025-12-12T10:30:00Z")
echo "Created: $formatted"
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

### Custom Export Filter
```bash
# Custom jq filter for export
# Note: list command doesn't support custom formatters
# Use export command or jq for custom output
claude-todo export -f json | jq -r '.tasks[] | [.id, .status, .title] | @csv'
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

### Phase 3 Command Documentation

| Command | Document | Purpose |
|---------|----------|---------|
| **dash** | **[commands/dash.md](commands/dash.md)** | Dashboard and project overview |
| **labels** | **[commands/labels.md](commands/labels.md)** | Label analytics and management |
| **next** | **[commands/next.md](commands/next.md)** | Intelligent task suggestions |

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

# 3. List backups
claude-todo backup --list

# 4. Restore if needed
claude-todo restore <backup-path>
# OR restore specific file
claude-todo restore <backup> --file todo.json

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
