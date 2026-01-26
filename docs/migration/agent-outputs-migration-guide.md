# Migration Guide: Agent Outputs Directory

**Version**: 0.70.0
**Status**: Automatic (No User Action Required)
**Epic**: T2348 - Cross-Agent Communication Protocol Unification

## Overview

This migration renames the research outputs directory from `claudedocs/research-outputs/` to `claudedocs/agent-outputs/`. This change reflects the unified agent communication protocol where all agent outputs (research, analysis, contributions) are stored in a single location.

### Why the Rename?

The original `research-outputs` directory was designed specifically for research subagent results. With the Cross-Agent Communication Protocol Unification (T2348), this directory now stores outputs from:

- Research subagents
- Analysis subagents
- Contribution protocol outputs
- Any agent-generated artifacts

The name `agent-outputs` better reflects this broader purpose.

## Automatic Migration

### When It Runs

Migration runs automatically during:

| Command | Behavior |
|---------|----------|
| `cleo upgrade` | Migrates if `research-outputs/` exists |
| `cleo init` | Migrates existing projects before creating structure |

### Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| `0` | Migration completed successfully | None needed |
| `100` | Already migrated or nothing to migrate | Skip (normal) |
| `1` | Error during migration | See Troubleshooting |

### Check Migration Status

```bash
# Check if migration is needed
cleo upgrade --status

# Or check directly
ls -la claudedocs/

# If you see:
# research-outputs/  → Migration needed
# agent-outputs/     → Already migrated
# Neither            → Nothing to migrate
```

## What Gets Migrated

### 1. Directory Rename

```
Before:
claudedocs/research-outputs/
├── MANIFEST.jsonl
├── 2026-01-15_auth-research.md
└── 2026-01-20_api-analysis.md

After:
claudedocs/agent-outputs/
├── MANIFEST.jsonl
├── 2026-01-15_auth-research.md
└── 2026-01-20_api-analysis.md
```

### 2. MANIFEST.jsonl Path Updates

File paths inside `MANIFEST.jsonl` are updated:

```jsonl
// Before
{"id":"R001","file":"claudedocs/research-outputs/2026-01-15_auth-research.md",...}

// After
{"id":"R001","file":"claudedocs/agent-outputs/2026-01-15_auth-research.md",...}
```

### 3. .gitignore Updates

References in `.gitignore` are updated:

```gitignore
# Before
claudedocs/research-outputs/

# After
claudedocs/agent-outputs/
```

### 4. Backup Creation

Before any changes, a complete backup is created:

```
.cleo/backups/migration/research-outputs_20260126_143000/
├── MANIFEST.jsonl
├── 2026-01-15_auth-research.md
└── 2026-01-20_api-analysis.md
```

## Manual Migration Steps

If automatic migration fails, follow these manual steps:

### Step 1: Create Backup

```bash
# Create timestamped backup
cp -r claudedocs/research-outputs .cleo/backups/migration/research-outputs_$(date +%Y%m%d_%H%M%S)
```

### Step 2: Rename Directory

```bash
mv claudedocs/research-outputs claudedocs/agent-outputs
```

### Step 3: Update MANIFEST.jsonl

```bash
# Update file paths in manifest
sed -i 's|research-outputs/|agent-outputs/|g' claudedocs/agent-outputs/MANIFEST.jsonl
```

### Step 4: Update .gitignore (if present)

```bash
# Update gitignore references
sed -i 's|claudedocs/research-outputs|claudedocs/agent-outputs|g' .gitignore
```

### Step 5: Verify

```bash
# Validate structure
cleo validate

# Check research commands work
cleo research list
```

## Troubleshooting

### Both Directories Exist

**Problem**: Both `research-outputs/` and `agent-outputs/` exist.

**Symptoms**:
```
WARNING: Both research-outputs/ and agent-outputs/ exist
  Old: claudedocs/research-outputs
  New: claudedocs/agent-outputs
  Manual intervention required to resolve
```

**Solution**:
1. Determine which has the latest data (check timestamps)
2. Merge contents if both have unique files
3. Remove the older/duplicate directory

```bash
# Check timestamps
ls -la claudedocs/research-outputs/
ls -la claudedocs/agent-outputs/

# If research-outputs is newer, merge into agent-outputs
cp -n claudedocs/research-outputs/* claudedocs/agent-outputs/

# Merge manifests (if both have entries)
cat claudedocs/research-outputs/MANIFEST.jsonl >> claudedocs/agent-outputs/MANIFEST.jsonl

# Remove old directory
rm -rf claudedocs/research-outputs

# Update paths in merged manifest
sed -i 's|research-outputs/|agent-outputs/|g' claudedocs/agent-outputs/MANIFEST.jsonl
```

### Permission Errors

**Problem**: Cannot rename or copy directories due to permissions.

**Solution**:
```bash
# Check directory permissions
ls -la claudedocs/

# Fix permissions if needed
chmod -R u+rw claudedocs/research-outputs/

# Retry migration
cleo upgrade
```

### Manifest Corruption

**Problem**: `MANIFEST.jsonl` contains invalid JSON after migration.

**Symptoms**:
```
ERROR: Invalid JSON in MANIFEST.jsonl at line X
```

**Solution**:
```bash
# Validate JSONL file (each line must be valid JSON)
while IFS= read -r line; do
  echo "$line" | jq . > /dev/null 2>&1 || echo "Invalid: $line"
done < claudedocs/agent-outputs/MANIFEST.jsonl

# If corruption found, restore from backup
cp .cleo/backups/migration/research-outputs_*/MANIFEST.jsonl claudedocs/agent-outputs/

# Then update paths
sed -i 's|research-outputs/|agent-outputs/|g' claudedocs/agent-outputs/MANIFEST.jsonl
```

### Files Missing After Migration

**Problem**: Research files not found after migration.

**Solution**:
```bash
# Check backup location
ls -la .cleo/backups/migration/

# Restore from backup
cp .cleo/backups/migration/research-outputs_*/*.md claudedocs/agent-outputs/

# Verify files restored
ls -la claudedocs/agent-outputs/
```

## Rollback Procedure

### Method 1: Restore from Backup

```bash
# Find backup
ls -la .cleo/backups/migration/

# Restore backup
BACKUP=$(ls -td .cleo/backups/migration/research-outputs_* | head -1)
rm -rf claudedocs/agent-outputs
cp -r "$BACKUP" claudedocs/research-outputs
```

### Method 2: Reverse the Rename

```bash
# Reverse directory rename
mv claudedocs/agent-outputs claudedocs/research-outputs

# Reverse manifest path updates
sed -i 's|agent-outputs/|research-outputs/|g' claudedocs/research-outputs/MANIFEST.jsonl

# Reverse gitignore updates
sed -i 's|claudedocs/agent-outputs|claudedocs/research-outputs|g' .gitignore
```

### Method 3: Use CLEO Restore

```bash
# List available backups
cleo backup --list

# Restore from a full backup (if available)
cleo restore
```

## Configuration Changes

### Old Configuration Keys (Deprecated)

```json
{
  "research": {
    "outputDir": "claudedocs/research-outputs",
    "manifestFile": "MANIFEST.jsonl",
    "archiveDir": "archive",
    "archiveDays": 30
  }
}
```

### New Configuration Keys

```json
{
  "agentOutputs": {
    "directory": "claudedocs/agent-outputs",
    "manifestFile": "MANIFEST.jsonl",
    "archiveDir": "archive",
    "archiveDays": 30
  }
}
```

### Backward Compatibility

Old configuration keys are automatically mapped to new keys:

| Old Key | New Key |
|---------|---------|
| `research.outputDir` | `agentOutputs.directory` |
| `research.manifestFile` | `agentOutputs.manifestFile` |
| `research.archiveDir` | `agentOutputs.archiveDir` |
| `research.archiveDays` | `agentOutputs.archiveDays` |
| `research.manifest.maxEntries` | `agentOutputs.manifest.maxEntries` |
| `research.manifest.thresholdBytes` | `agentOutputs.manifest.thresholdBytes` |
| `research.manifest.archivePercent` | `agentOutputs.manifest.archivePercent` |
| `research.manifest.autoRotate` | `agentOutputs.manifest.autoRotate` |

**No action required**: CLEO automatically reads old config keys and applies them to the new structure. You can update your config to use the new keys at your convenience.

### Update Configuration (Optional)

```bash
# View current config
cleo config show

# Set new-style config key
cleo config set agentOutputs.archiveDays 60

# Old-style keys still work (mapped automatically)
cleo config set research.archiveDays 60  # Still valid
```

## CLI Command Compatibility

All research commands work unchanged:

| Command | Status |
|---------|--------|
| `cleo research list` | Works (uses new directory) |
| `cleo research show <id>` | Works |
| `cleo research inject` | Works |
| `cleo research link <task> <id>` | Works |
| `cleo research init` | Creates agent-outputs/ |
| `cleo research status` | Works |

## Verification Checklist

After migration, verify:

- [ ] `claudedocs/agent-outputs/` directory exists
- [ ] `claudedocs/research-outputs/` directory does NOT exist
- [ ] `MANIFEST.jsonl` contains updated paths (`agent-outputs/`, not `research-outputs/`)
- [ ] `.gitignore` references `claudedocs/agent-outputs/` (if applicable)
- [ ] `cleo validate` passes
- [ ] `cleo research list` returns expected entries
- [ ] Backup exists in `.cleo/backups/migration/`

## Migration Log

Successful migrations are logged to `.cleo/.migration.log`:

```
2026-01-26T14:30:00Z DIRECTORY_MIGRATION: research-outputs → agent-outputs (backup: .cleo/backups/migration/research-outputs_20260126_143000)
```

## See Also

- [Research Command Reference](../commands/research.md) - Full research command documentation
- [Agent Outputs Architecture](../architecture/agent-outputs.md) - Directory structure details
- [Contribution Protocol](../../skills/contribution-protocol/SKILL.md) - Unified agent contribution system
