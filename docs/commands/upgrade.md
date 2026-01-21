# upgrade Command

Unified project maintenance command for schema migration, structural repair, and documentation updates.

## Usage

```bash
cleo upgrade [OPTIONS]
```

## Description

The `upgrade` command provides a single, unified interface for all project maintenance tasks. It safely brings your CLEO project up to date with the latest schema versions, fixes structural issues, and ensures documentation is current.

**Philosophy**: Idempotent and safe - designed to be run frequently without risk. Creates automatic backups before making changes.

## Key Features

**Schema Migration**
- Migrates `todo.json`, `config.json`, `todo-archive.json`, `todo-log.json`
- Applies version-specific transformations
- Validates data integrity after migration

**Structural Repair**
- Fixes orphaned phase references
- Rebuilds checksum caches
- Validates task hierarchies

**Documentation Updates** (v0.50.0+)
- Updates all agent doc files (CLAUDE.md, AGENTS.md, GEMINI.md)
- Registry-based auto-discovery
- Creates missing files, updates outdated content
- Skips files already current (versionless since v0.58.7)

**Context Monitoring Setup**
- Configures Claude Code statusline integration
- Enables automatic context alerts

## Options

| Option | Description |
|--------|-------------|
| `--status` | Check what needs updating (read-only) |
| `--dry-run` | Preview changes without applying |
| `--force` | Skip confirmation prompts |
| `--verbose` | Show detailed progress |
| `-h, --help` | Show help message |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Project up to date (no changes needed) |
| 1 | Error occurred |
| 2 | Updates applied successfully |

## Examples

### Check Upgrade Status

```bash
cleo upgrade --status
```

**Output:**
```
CLEO Upgrade Status (v0.50.2)

[1] Schema Versions
    ✓ todo.json         v2.6.0 (current)
    ✓ config.json       v2.2.0 (current)
    ✓ todo-archive.json v1.3.0 (current)
    ✓ todo-log.json     v1.2.0 (current)

[2] Structural Integrity
    ✓ Phases valid
    ✓ Checksums current

[3] Agent Documentation
    ⚠ CLAUDE.md         (missing)
    ⚠ AGENTS.md         (outdated)
    ✓ GEMINI.md         (current)

[4] Context Monitoring
    ✓ Claude Code statusline configured

STATUS: Updates available (agent docs outdated)
Run 'cleo upgrade' to apply updates
```

### Preview Changes (Dry Run)

```bash
cleo upgrade --dry-run
```

**Output:**
```
CLEO Upgrade Preview (--dry-run)

Changes that would be applied:

[3] Agent Documentation
    → CLAUDE.md: missing → create
    → AGENTS.md: outdated → update
    ⊘ GEMINI.md: current (skip)

Backup would be created at:
.cleo/backups/safety/safety_20260105_120000_upgrade

No changes applied (dry run mode)
```

### Interactive Upgrade

```bash
cleo upgrade
```

**Output:**
```
CLEO Upgrade (v0.50.2)

Checking project status...

Updates available:
  • Agent docs: 2 files outdated

Creating safety backup...
✓ Backup: .cleo/backups/safety/safety_20260105_120000_upgrade

Apply updates? (y/N): y

Updating agent documentation...
✓ CLAUDE.md (created)
✓ AGENTS.md (updated)
⊘ GEMINI.md (current)

Validating...
✓ All checks passed

Upgrade complete! 2 updates applied
```

### Non-Interactive Upgrade

```bash
cleo upgrade --force
```

Skips confirmation prompts. Useful for automated workflows.

## Agent Documentation Updates

### Multi-File Injection (v0.50.0+)

The upgrade command uses registry-based auto-discovery to update all agent doc files:

**Files Managed:**
- `CLAUDE.md` - Claude Code instructions
- `AGENTS.md` - Universal multi-agent standard
- `GEMINI.md` - Gemini CLI instructions

**Update Behavior:**

| Current Status | Action | Description |
|----------------|--------|-------------|
| `current` | Skip | File matches installed version |
| `outdated` | Update | Replace injection with current version |
| `legacy` | Update | Add version marker to existing injection |
| `none` | Add | Prepend injection to existing file |
| `missing` | Create | Create file with injection |

**Version Detection:**

```bash
# Check current version in file
grep -oP 'CLEO:START v\K[0-9.]+' CLAUDE.md
# v0.49.0

# Check installed version
cleo version -s
# 0.50.2

# Status: outdated (0.49.0 != 0.50.2)
```

**What Gets Updated:**

```markdown
<!-- CLEO:START v0.50.2 -->
## Task Management (cleo)

[Updated content with latest commands, flags, and best practices]

<!-- CLEO:END -->
```

Everything outside the markers is preserved.

## Safety Backups

### Automatic Backup Creation

Before applying any changes, upgrade creates a safety backup:

**Location:**
```
.cleo/backups/safety/safety_YYYYMMDD_HHMMSS_upgrade/
```

**Contents:**
- All data files (todo.json, config.json, archive, log)
- metadata.json with backup details

**Restoration:**

```bash
# List available backups
cleo backup --list

# Restore from safety backup
cleo restore safety_20260105_120000_upgrade
```

### When Backups Are Created

| Trigger | Backup Type | Reason |
|---------|-------------|--------|
| Schema migration needed | safety | Data transformation |
| Structural repair needed | safety | File modifications |
| Agent docs outdated | *(none)* | Non-destructive prepend |
| All current | *(none)* | No changes needed |

## Status Output Details

### Section 1: Schema Versions

Shows schema version for each data file:

```
[1] Schema Versions
    ✓ todo.json         v2.6.0 (current)
    ⚠ config.json       v2.1.0 → v2.2.0 (migration available)
```

- `✓` - Current version
- `⚠` - Migration available
- `✗` - Critical issue

### Section 2: Structural Integrity

Validates internal consistency:

```
[2] Structural Integrity
    ✓ Phases valid
    ⚠ 3 orphaned phase references (fixable)
    ✓ Checksums current
```

### Section 3: Agent Documentation

Reports injection status for all files:

```
[3] Agent Documentation
    ⚠ CLAUDE.md         v0.49.0 → v0.50.2 (outdated)
    ✓ AGENTS.md         v0.50.2 (current)
    ⊘ GEMINI.md         (none - will be created)
```

Status indicators:
- `✓` - Current version
- `⚠` - Update available
- `⊘` - No injection (will be added)
- `✗` - Error reading file

### Section 4: Context Monitoring

Checks Claude Code integration:

```
[4] Context Monitoring
    ✓ Claude Code statusline configured
    ⊘ Statusline not configured (optional)
```

## Technical Details

### Injection Update Workflow

```bash
# Internal process:
1. Source lib/injection.sh
2. Call injection_check_all()
3. Parse status for each target
4. Identify outdated/missing files
5. Call injection_update_all() if changes needed
6. Validate result
```

### Version Comparison Logic

```bash
# Get installed version
template_path=$(injection_get_template_path)
installed=$(injection_extract_version "$template_path")

# Get file version
current=$(injection_extract_version "CLAUDE.md")

# Compare
if [[ "$current" != "$installed" ]]; then
    echo "Update needed: $current → $installed"
fi
```

### Registry Integration

The upgrade command uses the injection registry for file discovery:

```bash
# lib/injection-registry.sh
readonly INJECTION_TARGETS="CLAUDE.md AGENTS.md GEMINI.md"
```

**Adding Custom Targets:**

1. Edit `lib/injection-registry.sh`:
```bash
readonly INJECTION_TARGETS="CLAUDE.md AGENTS.md GEMINI.md COPILOT.md"
```

2. Run upgrade:
```bash
cleo upgrade
# Now detects and updates COPILOT.md automatically
```

## Output Formats

### Text Output (Default)

Human-readable with color coding:
- Green `✓` - Success/current
- Yellow `⚠` - Warning/outdated
- Red `✗` - Error
- Gray `⊘` - Neutral/none

### JSON Output

```bash
cleo upgrade --status --json
```

```json
{
  "$schema": "https://cleo.dev/schemas/v1/upgrade-status.schema.json",
  "_meta": {
    "version": "0.50.2",
    "command": "upgrade",
    "timestamp": "2026-01-05T12:00:00Z"
  },
  "success": true,
  "schemas": {
    "todo": {"current": "2.6.0", "status": "current"},
    "config": {"current": "2.2.0", "status": "current"},
    "archive": {"current": "1.3.0", "status": "current"},
    "log": {"current": "1.2.0", "status": "current"}
  },
  "structural": {
    "phasesValid": true,
    "checksumsValid": true
  },
  "agentDocs": [
    {
      "target": "CLAUDE.md",
      "status": "outdated",
      "currentVersion": "0.49.0",
      "installedVersion": "0.50.2"
    },
    {
      "target": "AGENTS.md",
      "status": "current",
      "currentVersion": "0.50.2",
      "installedVersion": "0.50.2"
    },
    {
      "target": "GEMINI.md",
      "status": "current",
      "currentVersion": "0.50.2",
      "installedVersion": "0.50.2"
    }
  ],
  "contextMonitoring": {
    "statuslineConfigured": true
  },
  "summary": {
    "updateRequired": true,
    "sections": {
      "schemas": "current",
      "structural": "current",
      "agentDocs": "outdated",
      "contextMonitoring": "current"
    }
  }
}
```

## Comparison with Other Commands

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `upgrade` | Full project update | After CLEO version upgrade, periodically |
| `init --update-docs` | Only doc injection | Quick doc updates, no schema changes |
| `validate --fix` | Data integrity | After manual file edits, corruption |
| `migrate run` | Schema only | Targeted migration (advanced) |

## Best Practices

### Regular Maintenance

```bash
# Check monthly or after CLEO updates
cleo upgrade --status

# Apply if needed
cleo upgrade
```

### Pre-Commit Hook

```bash
# .git/hooks/pre-commit
#!/bin/bash
cleo upgrade --status --quiet || {
    echo "⚠️  CLEO project outdated. Run: cleo upgrade"
    exit 1
}
```

### CI/CD Integration

```bash
# Validate project is current
cleo upgrade --status
exit_code=$?

if [[ $exit_code -ne 0 ]]; then
    echo "ERROR: Project requires upgrade"
    echo "Run: cleo upgrade"
    exit 1
fi
```

## Troubleshooting

### Issue: upgrade --status shows errors

**Symptom:** Section 3 shows `✗` for agent docs

**Cause:** File permission issues or corrupted markers

**Solution:**
```bash
# Check file permissions
ls -la CLAUDE.md AGENTS.md GEMINI.md

# Validate marker format
grep -n "CLEO:START\|CLEO:END" CLAUDE.md

# Force re-inject
cleo init --update-docs
```

### Issue: Backup creation fails

**Symptom:** `Failed to create safety backup`

**Cause:** Disk space or permission issues

**Solution:**
```bash
# Check disk space
df -h .

# Check backup directory permissions
ls -ld .cleo/backups/safety/

# Manual backup before retry
cleo backup
```

### Issue: Agent docs not updating

**Symptom:** `upgrade` runs but files unchanged

**Cause:** Files already current or marker corruption

**Solution:**
```bash
# Check versions manually
grep "CLEO:START" CLAUDE.md AGENTS.md GEMINI.md

# Force update
cleo upgrade --force

# If still failing, check lib/injection.sh logs
cleo upgrade --verbose
```

## See Also

- [lib/injection.md](../lib/injection.md) - Injection library API
- [init](init.md) - Initial project setup
- [validate](validate.md) - Data integrity checks
- [backup](backup.md) - Backup management
- [restore](restore.md) - Restore from backup
- [migrate](migrate.md) - Schema migration details
