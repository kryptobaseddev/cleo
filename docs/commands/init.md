# init Command

Initialize a new cleo project or update existing configuration.

## Usage

```bash
cleo init [PROJECT_NAME] [OPTIONS]
```

## Description

The `init` command sets up a new project for cleo by creating the `.cleo/` directory structure and required JSON files. It also automatically injects CLEO task management instructions into all agent documentation files (CLAUDE.md, AGENTS.md, GEMINI.md) using registry-based auto-discovery.

**Multi-File Injection**: Starting in v0.50.0, `init` automatically detects and updates all agent doc files in your project. No per-file flags needed - the injection registry determines which files to update.

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
| `--update-docs` | Update agent docs only (safe on existing projects) | `false` |
| `-f, --format FMT` | Output format: `text`, `json` | auto-detect |
| `--json` | Force JSON output | |
| `--human` | Force human-readable text output | |
| `-q, --quiet` | Suppress non-essential output | `false` |
| `-h, --help` | Show help message | |

**Deprecated Options** (removed in v0.50.0):
- `--target FILE` - Registry-based auto-discovery replaces per-file flags
- `--no-claude-md` - Injection now automatic, no skip option
- `--update-claude-md` - Use `--update-docs` instead

## Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `EXIT_SUCCESS` | Success |
| 2 | `EXIT_INVALID_INPUT` | `--force` provided without `--confirm-wipe` |
| 3 | `EXIT_FILE_ERROR` | Failed to create safety backup |
| 101 | `EXIT_ALREADY_EXISTS` | Project already initialized (use `--force --confirm-wipe`) |
| 102 | `EXIT_NO_CHANGE` | No changes needed (`--update-docs` with current agent docs) |

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
[INFO] Injected CLEO instructions into 3 agent doc files
[INFO]   ✓ CLAUDE.md (created)
[INFO]   ✓ AGENTS.md (created)
[INFO]   ✓ GEMINI.md (created)

cleo initialized successfully!
```

### Update Agent Docs Only (Existing Project)

```bash
# Safe operation - only updates agent docs, doesn't touch task data
cleo init --update-docs
```

Output:
```
[SUCCESS] Updated 2 agent doc file(s)
```

Or if already current:
```
[INFO] Agent docs already up-to-date (3 file(s))
```

**Use cases:**
- Create missing CLAUDE.md/AGENTS.md/GEMINI.md on existing project
- Update outdated injection content
- Lightweight alternative to full `cleo upgrade`

### Update via Upgrade Command

```bash
# Full upgrade - includes agent docs, schemas, migrations, etc.
cleo upgrade
```

Output:
```
[INFO] Updating agent documentation injections...
[INFO]   ✓ CLAUDE.md (updated)
[INFO]   ✓ AGENTS.md (created)
[INFO]   ⊘ GEMINI.md (current)
[INFO] Updated 2 of 3 files
```

**Note:** `cleo init` automatically injects into all agent files on first run. Use `cleo init --update-docs` for quick updates or `cleo upgrade` for comprehensive project maintenance.

### Multi-Agent Project Support

**Registry-Based Auto-Discovery** (v0.50.0+):

```bash
# Creates/updates ALL agent doc files automatically
cleo init

# No per-file flags needed - registry determines targets:
# - CLAUDE.md (Claude Code)
# - AGENTS.md (multi-agent standard, Google/OpenAI backed)
# - GEMINI.md (Gemini CLI)
```

**Behavior:**
- Creates missing files with injection
- Updates outdated injections (content mismatch)
- Skips files with current content
- Same CLEO template content for all targets
- Markers: `<!-- CLEO:START -->` and `<!-- CLEO:END -->` (versionless since v0.58.7)

**Why Multiple Files?**
Different LLM agents prefer different instruction files. CLEO injects identical content into all standard formats for maximum compatibility.

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
# [INFO] Initializing CLEO for project: my-project
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
| `CLAUDE.md` | Agent doc file with CLEO injection (created/updated) |
| `AGENTS.md` | Agent doc file with CLEO injection (created/updated) |
| `GEMINI.md` | Agent doc file with CLEO injection (created/updated) |

## Directory Structure

```
project/
├── .cleo/
│   ├── todo.json          # Active tasks
│   ├── config.json        # Configuration
│   ├── todo-archive.json  # Archived tasks
│   ├── todo-log.json      # Audit log
│   ├── schemas/           # JSON Schema files
│   └── backups/
│       ├── safety/        # Pre-operation backups
│       ├── snapshot/      # Point-in-time snapshots
│       ├── incremental/   # Version history
│       ├── archive/       # Long-term archives
│       └── migration/     # Schema migration backups
├── CLAUDE.md              # Claude Code instructions
├── AGENTS.md              # Multi-agent instructions
└── GEMINI.md              # Gemini CLI instructions
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

## Agent Doc File Injection

The init command adds task management instructions to all agent doc files using registry-based auto-discovery:

**Files Injected:**
- `CLAUDE.md` - Claude Code CLI instructions
- `AGENTS.md` - Universal multi-agent standard (Google/OpenAI backed)
- `GEMINI.md` - Gemini CLI instructions

**Injection Format:**
```markdown
<!-- CLEO:START v0.50.2 -->
## Task Management (cleo)

Use `ct` (alias for `cleo`) for all task operations.
...
<!-- CLEO:END -->
```

**Features:**
- **Versioned markers** - Track instruction version
- **Auto-updates** - Run `cleo init --update-docs` to upgrade all files
- **Content preservation** - Only replaces injection block, keeps other content
- **Registry-based** - Add new targets by modifying `lib/injection-registry.sh`

**Adding Custom Targets:**
Edit `lib/injection-registry.sh`:
```bash
readonly INJECTION_TARGETS="CLAUDE.md AGENTS.md GEMINI.md COPILOT.md"
```

Then run `cleo init --update-docs` to inject into all targets.

## Behavior Summary

| Scenario | Behavior | Exit Code |
|----------|----------|-----------|
| Fresh directory | Creates all files + injects all agent docs | 0 |
| Already initialized (no flags) | Warns, exits | 101 |
| `--force` only | Warns about missing `--confirm-wipe`, exits | 2 |
| `--force --confirm-wipe` | Creates backup, wipes, reinitializes | 0 |

## Technical Details

### Injection Library

Init uses `lib/injection.sh` for agent doc file management:

```bash
# Internal workflow:
1. Source lib/injection.sh
2. Call injection_update_all(".")
3. For each target in INJECTION_TARGETS:
   - Check status (missing/outdated/current)
   - Skip if current
   - Create or update if needed
4. Return JSON summary
```

See [lib/injection.md](../lib/injection.md) for API reference.

### Version Detection

```bash
# Extract version from marker:
<!-- CLEO:START v0.50.2 -->

# Regex pattern:
CLEO:START v([0-9]+\.[0-9]+\.[0-9]+)
```

### File Actions

| Status | Action | Description |
|--------|--------|-------------|
| `missing` | Create | File doesn't exist, create with injection |
| `none` | Add | File exists, prepend injection |
| `outdated` | Update | Replace old injection with current |
| `legacy` | Update | No version marker, replace with versioned |
| `current` | Skip | Injection matches installed version |

## See Also

- [lib/injection.md](../lib/injection.md) - Injection library API reference
- [validate](validate.md) - Check project integrity
- [upgrade](upgrade.md) - Upgrade project and injections
- [backup](backup.md) - Backup management
- [restore](restore.md) - Restore from backup
- [migrate](migrate.md) - Schema version migration
- [session](session.md) - Start working
