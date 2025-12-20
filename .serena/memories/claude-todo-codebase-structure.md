# Claude-TODO Codebase Structure & Command Architecture

## Overview
Claude-TODO is a task management CLI system built in Bash with JSON-based storage. It uses a modular architecture with a main dispatcher, individual command scripts, and shared library functions.

---

## Directory Structure

```
/mnt/projects/claude-todo/
├── install.sh                 # Global installation script (copies to ~/.claude-todo/)
├── VERSION                    # Version file (e.g., 0.21.1)
├── schemas/                   # JSON Schema definitions
│   └── todo.schema.json      # Schema v2.3.0+ with project.phases
├── scripts/                   # User-facing command scripts (*.sh files)
│   ├── add-task.sh          # Add new task
│   ├── list-tasks.sh        # List tasks with filtering
│   ├── update-task.sh       # Update existing task
│   ├── complete-task.sh     # Mark task as done
│   ├── analyze.sh           # Task analysis & prioritization
│   ├── next.sh              # Suggest next task
│   ├── focus.sh             # Manage active focus
│   ├── session.sh           # Session lifecycle (start/end)
│   ├── show.sh              # Show single task details
│   ├── find.sh              # Fuzzy search tasks
│   ├── labels.sh            # List & analyze labels
│   ├── phases.sh            # Manage project phases
│   ├── dash.sh              # Project dashboard
│   ├── commands.sh          # Command discovery & help
│   └── ... (35+ total)
├── lib/                       # Shared library functions
│   ├── validation.sh         # Schema validation & anti-hallucination
│   ├── file-ops.sh          # Atomic file operations with locking
│   ├── logging.sh           # Colored output & logging
│   ├── output-format.sh     # TTY-aware format detection
│   ├── error-json.sh        # Structured error output
│   ├── exit-codes.sh        # Standardized exit codes
│   ├── analysis.sh          # Leverage scoring algorithms
│   ├── hierarchy.sh         # Parent-child task validation
│   ├── dependency-check.sh  # System dependency validation
│   ├── phase-tracking.sh    # Phase management
│   ├── config.sh            # Configuration utilities
│   └── ... (16+ total)
├── templates/                # Starter templates for new projects
├── docs/                      # User documentation
└── tests/                     # Test suite

## Installation
- `install.sh` copies everything to `~/.claude-todo/`
- Creates wrapper script at `~/.claude-todo/scripts/claude-todo`
- Script installed globally via symlink (e.g., `/usr/local/bin/claude-todo`)
```

---

## Command Routing Architecture

### Main Entry Point: The Dispatcher Wrapper
Location: Embedded in `install.sh` (lines 371-780) → Creates `~/.claude-todo/scripts/claude-todo`

**Key Features:**
1. **Command Resolution** (lines 574-596):
   - Checks aliases first (e.g., `ls` → `list`)
   - Then plugins (project-local or global)
   - Then core commands (defined in CMD_MAP)
   - Returns either "plugin:<path>" or "core:<command>"

2. **Command Mapping** (lines 387-419):
   ```bash
   declare -A CMD_MAP=(
     [init]="init.sh"
     [add]="add-task.sh"
     [list]="list-tasks.sh"
     [analyze]="analyze.sh"
     ...
   )
   ```

3. **Alias System** (lines 459-483):
   - Default aliases: `ls`, `done`, `new`, `edit`, `rm`, `check`, etc.
   - Configurable via global config

4. **Plugin System** (lines 489-519):
   - Auto-discovers from `$CLAUDE_TODO_HOME/plugins/` 
   - Auto-discovers from `./.claude/plugins/` (project-local)
   - Plugins override core commands with same name

5. **Execution** (lines 700-712):
   ```bash
   resolved=$(resolve_command "$CMD")
   if [[ "$resolved" == plugin:* ]]; then
     exec bash "${resolved#plugin:}" "$@"
   else
     target_cmd="${resolved#core:}"
     exec bash "$SCRIPT_DIR/${CMD_MAP[$target_cmd]}" "$@"
   fi
   ```

---

## Individual Command Structure

### Pattern 1: Standard Command Template
All commands follow this structure:

```bash
#!/usr/bin/env bash
# Command description and usage

set -euo pipefail

# 1. Set up paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"
CLAUDE_TODO_HOME="${CLAUDE_TODO_HOME:-$HOME/.claude-todo}"

# 2. Source version
VERSION="$(cat "$CLAUDE_TODO_HOME/VERSION" | tr -d '[:space:]')"

# 3. Source library functions (order matters)
source "$LIB_DIR/logging.sh"              # Colors & output
source "$LIB_DIR/output-format.sh"        # Format detection
source "$LIB_DIR/exit-codes.sh"           # Exit code constants
source "$LIB_DIR/error-json.sh"           # Structured error output
source "$LIB_DIR/validation.sh"           # Validation functions
source "$LIB_DIR/file-ops.sh"             # Atomic file operations

# 4. Define defaults
COMMAND_NAME="<command>"                  # For logging
TODO_FILE="${TODO_FILE:-.claude/todo.json}"
FORMAT=""                                 # Will be resolved later

# 5. Usage/help function
usage() { ... }

# 6. Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -f|--format) FORMAT="$2"; shift 2 ;;
    --json) FORMAT="json"; shift ;;
    --human) FORMAT="text"; shift ;;
    -h|--help) usage ;;
    *) shift ;;
  esac
done

# 7. Resolve format (TTY-aware auto-detection)
FORMAT=$(resolve_format "$FORMAT")

# 8. Main logic
# ... business logic ...

# 9. Output (format-aware)
if [[ "$FORMAT" == "json" ]]; then
  jq -n --arg version "$VERSION" \
    '{_meta: {format: "json", version: $version, command: "cmd"}, ...}'
else
  echo "Human-readable output"
fi

exit $EXIT_SUCCESS
```

### Example: add-task.sh (Lines 1-1007)
**Key patterns:**
- Dependency validation (lines 181-188)
- Argument parsing with validation (lines 484-577)
- File locking (lines 765-773) - prevents race conditions
- Atomic write pattern (lines 914-952):
  1. Create temp file
  2. Validate JSON
  3. Backup original
  4. Write temp
  5. Atomic move
- Structured error output (lines 161-165)
- Format-aware success output (lines 971-1005)

### Example: list-tasks.sh (Lines 1-893)
**Key patterns:**
- Early filtering with jq for performance (lines 261-307)
- Single jq operation for sort+paginate (lines 412-430)
- Multiple output formats (json, jsonl, markdown, table, text)
- Unicode/color support detection (lines 48-70)
- Proper JSON envelope with metadata (lines 654-699)

### Example: analyze.sh (Lines 1-100+ analyzed)
**Key patterns:**
- Leverage scoring algorithms (calls lib/analysis.sh)
- Human vs JSON output modes (--human, --full flags)
- Complex data transformation for triage
- Auto-focus capability (--auto-focus flag)

---

## Output Format Pattern (Critical for New Commands)

### JSON Output Structure
All commands output this envelope for JSON:
```json
{
  "$schema": "https://claude-todo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "version": "<VERSION>",
    "command": "<command-name>",
    "timestamp": "<ISO-8601>",
    "checksum": "<sha256-hash>"
  },
  "success": true,
  "result": { /* command-specific data */ }
}
```

### Format Detection (TTY-Aware)
```bash
FORMAT=$(resolve_format "$FORMAT")
# Priority: CLI arg > CLAUDE_TODO_FORMAT env > config > TTY auto-detect
# TTY → text (human-friendly)
# Pipe/redirect → json (agent-friendly)
```

### Error Output Pattern
```bash
output_error "$E_TASK_NOT_FOUND" "Task T999 not found" "${EXIT_NOT_FOUND:-4}" "true" "Use 'ct exists T999' to verify"
# Outputs JSON if FORMAT=json, colored text otherwise
```

---

## Library Functions (lib/*.sh)

### validation.sh
- `validate_title()` - Check title validity
- `validate_description()` - Field length checks
- `validate_note()` - Note validation
- `check_circular_dependencies()` - Dependency cycles
- `normalize_labels()` - Remove duplicate labels

### file-ops.sh
- `lock_file()` - Acquire file lock with timeout
- `unlock_file()` - Release file lock
- `save_json()` - Atomic JSON write (lock + backup + validate + move)
- `backup_file()` - Create timestamped backup

### output-format.sh
- `resolve_format()` - TTY-aware format detection
- `detect_unicode_support()` - Check terminal capabilities
- `should_use_color()` - Respects NO_COLOR env

### error-json.sh
- `output_error()` - Format-aware error output
- `output_error_json()` - Structured JSON error
- Depends on exit-codes.sh

### exit-codes.sh
- `EXIT_SUCCESS=0`
- `EXIT_INVALID_INPUT=2`
- `EXIT_FILE_ERROR=3`
- `EXIT_NOT_FOUND=4`
- `EXIT_DEPENDENCY_ERROR=5`
- `EXIT_VALIDATION_ERROR=6`
- `EXIT_LOCK_TIMEOUT=7`
- Hierarchy codes: 10-13 (parent not found, depth exceeded, etc.)

### analysis.sh
- `calculate_leverage_scores()` - Score by downstream impact
- `identify_bottlenecks()` - Find blocking tasks
- Uses jq for complex transformations

---

## Data Files Structure

### .claude/todo.json (Main task file)
```json
{
  "_meta": {
    "version": "2.3.0",
    "checksum": "<sha256-16-chars>"
  },
  "project": {
    "name": "project-name",
    "currentPhase": "core",
    "phases": {
      "setup": {"name": "Setup", "order": 1},
      "core": {"name": "Core", "order": 2},
      "polish": {"name": "Polish", "order": 3}
    }
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Task title",
      "status": "pending|active|blocked|done",
      "priority": "critical|high|medium|low",
      "type": "epic|task|subtask",
      "parentId": null,
      "size": "small|medium|large",
      "phase": "setup",
      "description": "...",
      "labels": ["bug", "security"],
      "depends": ["T002"],
      "notes": ["timestamp: note text"],
      "createdAt": "ISO-8601",
      "completedAt": "ISO-8601"
    }
  ]
}
```

### .claude/todo-archive.json
```json
{
  "archivedTasks": [/* completed task history */]
}
```

### .claude/todo-log.json
```json
{
  "entries": [
    {
      "id": "log-1234567890-abcdef",
      "timestamp": "ISO-8601",
      "action": "task_created|task_updated|task_completed",
      "taskId": "T001",
      "actor": "system",
      "details": {...},
      "before": {...},
      "after": {...}
    }
  ]
}
```

---

## File Locking Pattern (Critical)

All writes use atomic pattern with file locking:
```bash
lock_file "$TODO_FILE" LOCK_FD 30      # Acquire with 30s timeout
trap "unlock_file $LOCK_FD" EXIT       # Ensure release

# Do work while holding lock
UPDATED=$(jq '...' "$TODO_FILE")

# Atomic write (temp → validate → backup → move)
save_json "$TODO_FILE" "$UPDATED"

unlock_file "$LOCK_FD"                 # Explicit release
```

This prevents race conditions when multiple processes write simultaneously.

---

## Adding a New Command: checklist

1. **Create script**: `scripts/research.sh` (executable)
2. **Follow template**: Use existing command as template
3. **Source libraries**: logging.sh → output-format.sh → exit-codes.sh → error-json.sh → validation.sh
4. **Parse args**: Standard `while` loop with format handling
5. **Resolve format**: Call `FORMAT=$(resolve_format "$FORMAT")`
6. **Implement logic**: Main business logic
7. **Output format**: 
   - JSON: `jq -n --arg version "$VERSION" '{_meta: {...}, ...}'`
   - Text: colored echo with proper line breaks
8. **Error handling**: Use `output_error` for consistency
9. **Exit codes**: Use named constants from exit-codes.sh
10. **Register in dispatcher**: Add to `CMD_MAP` and `CMD_DESC` in install.sh
11. **Optional**: Add aliases in `CMD_ALIASES` if command has short form

---

## Key Design Principles

1. **Anti-hallucination**: Both title AND description required for all tasks
2. **Atomic operations**: All file writes use lock+validate+backup+move pattern
3. **LLM-agent-first**: JSON output by default when piped, text for TTY
4. **Format detection**: Automatic TTY vs pipe detection
5. **Structured errors**: JSON error envelopes with recovery suggestions
6. **File locking**: Prevents concurrent write race conditions
7. **Modular libraries**: Shared functions across all commands
8. **Plugin system**: Extensible via ./.claude/plugins/ or ~/.claude-todo/plugins/
9. **Immutable logs**: todo-log.json append-only audit trail
10. **Hierarchical tasks**: Epic → Task → Subtask with depth/sibling constraints
