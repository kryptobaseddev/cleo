# init Command

Initialize a new cleo project or update existing configuration.

## Usage

```bash
cleo init [PROJECT_NAME] [OPTIONS]
```

## Description

The `init` command sets up a new project for cleo by creating the `.cleo/` directory structure and required JSON files. It can also update an existing project's CLAUDE.md injection to the latest version.

**Safeguard**: Running `init` on an already-initialized project will NOT overwrite data. Reinitializing requires explicit double confirmation with `--force --confirm-wipe`.

## Arguments

| Argument | Description | Required |
|----------|-------------|----------|
| `PROJECT_NAME` | Optional project name (for display) | No |

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--force` | Signal intent to reinitialize (requires `--confirm-wipe`) | `false` |
| `--confirm-wipe` | Confirm destructive data wipe (used with `--force`) | `false` |
| `--no-claude-md` | Skip CLAUDE.md integration | `false` |
| `--update-claude-md` | Only update doc file injection (no other changes) | `false` |
| `--update-docs` | Alias for `--update-claude-md` | `false` |
| `--target FILE` | Target doc file for injection (CLAUDE.md, AGENTS.md, GEMINI.md) | `CLAUDE.md` |
| `-f, --format FMT` | Output format: `text`, `json` | auto-detect |
| `--json` | Force JSON output | |
| `--human` | Force human-readable text output | |
| `-q, --quiet` | Suppress non-essential output | `false` |
| `-h, --help` | Show help message | |

## Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `EXIT_SUCCESS` | Success |
| 2 | `EXIT_INVALID_INPUT` | `--force` provided without `--confirm-wipe` |
| 3 | `EXIT_FILE_ERROR` | Failed to create safety backup |
| 101 | `EXIT_ALREADY_EXISTS` | Project already initialized (use `--force --confirm-wipe`) |

## Examples

### New Project Setup

```bash
# Initialize in current directory
cd my-project
cleo init

# Initialize with project name
cleo init "my-project"
```

Output:
```
[INFO] Initializing cleo in /path/to/project
[INFO] Created .cleo/ directory
[INFO] Created .cleo/todo.json
[INFO] Created .cleo/config.json
[INFO] Created .cleo/todo-archive.json
[INFO] Created .cleo/todo-log.json
[INFO] Updated CLAUDE.md with task management injection

cleo initialized successfully!
```

### Update CLAUDE.md Injection

```bash
# Update CLAUDE.md injection to latest version
cleo init --update-claude-md

# Or use the alias
cleo init --update-docs
```

### Multi-Doc Injection (--target)

```bash
# Inject into different agent doc files
cleo init --target CLAUDE.md    # Default for Claude Code
cleo init --target AGENTS.md    # For multi-agent projects
cleo init --target GEMINI.md    # For Gemini CLI

# Same CLEO template content is used for all targets
# Markers: <!-- CLEO:START vX.X.X --> and <!-- CLEO:END -->
```

### Attempt to Reinitialize (Blocked)

```bash
# Without --force: exits with code 101
cleo init
# [WARN] Project already initialized at .cleo/todo.json
# [WARN] Found 4 data file(s) that would be WIPED:
# [WARN]   - .cleo/todo.json
# [WARN]   - .cleo/todo-archive.json
# [WARN]   - .cleo/config.json
# [WARN]   - .cleo/todo-log.json
# [WARN] To reinitialize, use BOTH flags: --force --confirm-wipe
```

### Attempt with --force Only (Blocked)

```bash
# With --force but no --confirm-wipe: exits with code 2
cleo init --force
# [ERROR] --force requires --confirm-wipe for destructive reinitialize
# [WARN] ⚠️  DESTRUCTIVE OPERATION WARNING ⚠️
# [WARN] This will PERMANENTLY WIPE 4 data file(s)
# [WARN] A safety backup will be created at: .cleo/backups/safety/
```

### Full Reinitialize (With Safety Backup)

```bash
# Both flags required - creates backup before wiping
cleo init --force --confirm-wipe
# [INFO] Creating safety backup before reinitialize...
# [INFO] Safety backup created at: .cleo/backups/safety/safety_20251223_120000_init_reinitialize
# [WARN] Proceeding with DESTRUCTIVE reinitialize - wiping existing data...
# [INFO] Initializing CLAUDE-TODO for project: my-project
# ...
```

## JSON Output

### Already Initialized (Exit 101)

```json
{
  "$schema": "https://cleo.dev/schemas/v1/error.schema.json",
  "_meta": {
    "format": "json",
    "version": "0.32.1",
    "command": "init",
    "timestamp": "2025-12-23T12:00:00Z"
  },
  "success": false,
  "error": {
    "code": "E_ALREADY_INITIALIZED",
    "message": "Project already initialized at .cleo/todo.json",
    "exitCode": 101,
    "recoverable": true,
    "suggestion": "Use --force --confirm-wipe to reinitialize (DESTRUCTIVE: will wipe all existing data after creating safety backup)",
    "context": {
      "existingFiles": 4,
      "dataDirectory": ".claude",
      "affectedFiles": ["todo.json", "todo-archive.json", "config.json", "todo-log.json"]
    }
  }
}
```

### Missing --confirm-wipe (Exit 2)

```json
{
  "$schema": "https://cleo.dev/schemas/v1/error.schema.json",
  "_meta": {
    "format": "json",
    "version": "0.32.1",
    "command": "init",
    "timestamp": "2025-12-23T12:00:00Z"
  },
  "success": false,
  "error": {
    "code": "E_CONFIRMATION_REQUIRED",
    "message": "--force requires --confirm-wipe to proceed with destructive reinitialize",
    "exitCode": 2,
    "recoverable": true,
    "suggestion": "Add --confirm-wipe to confirm you want to WIPE all existing data (a safety backup will be created first)",
    "context": {
      "existingFiles": 4,
      "safetyBackupLocation": ".cleo/backups/safety/"
    }
  }
}
```

## Files Created

| File | Description |
|------|-------------|
| `.cleo/todo.json` | Active tasks with metadata |
| `.cleo/config.json` | Project configuration |
| `.cleo/todo-archive.json` | Archived completed tasks |
| `.cleo/todo-log.json` | Audit log of all operations |
| `.cleo/schemas/` | JSON Schema files for validation |
| `.cleo/backups/` | Backup directories (safety, snapshot, etc.) |
| `CLAUDE.md` (updated) | Task management injection added |

## Directory Structure

```
project/
├── .cleo/
│   ├── todo.json          # Active tasks
│   ├── config.json   # Configuration
│   ├── todo-archive.json  # Archived tasks
│   ├── todo-log.json      # Audit log
│   ├── schemas/           # JSON Schema files
│   └── backups/
│       ├── safety/        # Pre-operation backups
│       ├── snapshot/      # Point-in-time snapshots
│       ├── incremental/   # Version history
│       ├── archive/       # Long-term archives
│       └── migration/     # Schema migration backups
└── CLAUDE.md              # Updated with injection
```

## Safety Backup on Reinitialize

When reinitializing with `--force --confirm-wipe`, a safety backup is automatically created:

**Location**: `.cleo/backups/safety/safety_YYYYMMDD_HHMMSS_init_reinitialize/`

**Files Backed Up**:
- `todo.json` - All active tasks
- `todo-archive.json` - All archived tasks
- `config.json` - Configuration
- `todo-log.json` - Audit log

**Metadata**: Includes `metadata.json` with backup timestamp, file count, and total size.

## CLAUDE.md Injection

The init command adds a task management section to CLAUDE.md:

```markdown
<!-- CLAUDE-TODO:START v0.32.1 -->
## Task Management (cleo)

Use `ct` (alias for `cleo`) for all task operations.
...
<!-- CLAUDE-TODO:END -->
```

This section:
- Provides essential command reference for AI assistants
- Auto-updates when `--update-claude-md` is run
- Preserves content outside the markers

## Behavior Summary

| Scenario | Behavior | Exit Code |
|----------|----------|-----------|
| Fresh directory | Creates all files | 0 |
| Already initialized (no flags) | Warns, exits | 101 |
| `--force` only | Warns about missing `--confirm-wipe`, exits | 2 |
| `--force --confirm-wipe` | Creates backup, wipes, reinitializes | 0 |
| `--update-claude-md` | Only updates CLAUDE.md injection | 0 |

## See Also

- [validate](validate.md) - Check project integrity
- [backup](backup.md) - Backup management
- [restore](restore.md) - Restore from backup
- [migrate](migrate.md) - Schema version migration
- [session](session.md) - Start working
