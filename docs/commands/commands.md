# commands Command

> List and query available claude-todo commands with native filtering

## Usage

```bash
claude-todo commands [OPTIONS] [COMMAND]
```

**Output**: JSON by default (non-TTY), text with `--human`

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--format` | `-f` | Output format (text\|json) | json (non-TTY) |
| `--json` | | Force JSON output | |
| `--human` | | Force human-readable output | |
| `--quiet` | `-q` | Suppress non-essential output | false |
| `--category` | `-c` | Filter by category | all |
| `--relevance` | `-r` | Filter by agent relevance | all |
| `--workflows` | | Show agent workflow sequences | |
| `--lookup` | | Show intent-to-command mapping | |
| `--help` | `-h` | Show help message | |

## Categories

| Category | Description |
|----------|-------------|
| `write` | Commands that modify state (add, complete, update, etc.) |
| `read` | Commands that query/display data (list, show, analyze, etc.) |
| `sync` | TodoWrite synchronization commands |
| `maintenance` | System maintenance (backup, validate, migrate, etc.) |

## Agent Relevance Levels

| Level | Meaning |
|-------|---------|
| `critical` | Core workflow commands (use frequently) |
| `high` | Important for context and decisions |
| `medium` | Useful but not essential |
| `low` | Rarely needed by agents |

## Examples

### List All Commands (JSON)

```bash
claude-todo commands
```

Output:
```json
{
  "$schema": "https://claude-todo.dev/schemas/v1/output.schema.json",
  "_meta": {"format": "json", "version": "0.20.0", "command": "commands", "timestamp": "..."},
  "success": true,
  "summary": {"totalCommands": 33, "categoryFilter": "all", "relevanceFilter": "all"},
  "commands": [...]
}
```

### Human-Readable List

```bash
claude-todo commands --human
```

### Filter by Category

```bash
# Write commands only
claude-todo commands -c write

# Sync commands
claude-todo commands --category sync
```

### Filter by Agent Relevance

```bash
# Critical commands for agents
claude-todo commands -r critical

# High + critical relevance
claude-todo commands -r high
```

### Single Command Details

```bash
claude-todo commands add
```

Output:
```json
{
  "_meta": {...},
  "success": true,
  "command": {
    "name": "add",
    "script": "add-task.sh",
    "category": "write",
    "synopsis": "Create new task with metadata...",
    "flags": ["--format", "--quiet", "--json", "--human", "--dry-run"],
    "exitCodes": [0, 2, 6, 10, 11, 12, 13],
    "agentRelevance": "high"
  }
}
```

### Agent Workflows

```bash
claude-todo commands --workflows
```

Output:
```json
{
  "_meta": {...},
  "success": true,
  "workflows": {
    "sessionStart": ["session start", "dash --compact", "focus show"],
    "taskSelection": ["analyze --json", "next --explain", "focus set <id>"],
    "validation": ["exists <id> --quiet", "validate"],
    "sessionEnd": ["complete <id>", "sync --extract", "session end"]
  }
}
```

### Quick Lookup (Intent → Command)

```bash
claude-todo commands --lookup
```

Output:
```json
{
  "_meta": {...},
  "success": true,
  "quickLookup": {
    "createTask": "add",
    "findTask": "find",
    "viewTask": "show",
    "modifyTask": "update",
    "completeTask": "complete",
    "nextTask": "next",
    "taskTriage": "analyze",
    "overview": "dash",
    "checkExists": "exists"
  }
}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Invalid input (bad filter value) |
| 3 | File error (COMMANDS-INDEX.json not found) |
| 4 | Command not found (when querying specific command) |

## Agent Usage Pattern

Instead of parsing with jq, use native flags:

```bash
# Get critical commands (no jq needed)
claude-todo commands -r critical

# Get write commands
claude-todo commands -c write

# Lookup specific command
claude-todo commands add
```

## Related Commands

- `help` - Human-oriented help text with examples
- `help <command>` - Detailed help for specific command

## Data Source

Reads from `COMMANDS-INDEX.json` which is the authoritative command registry following LLM-AGENT-FIRST-SPEC v3.0.
