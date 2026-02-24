# Migration Guide: Agent Outputs Directory

**Version**: 0.80.0 (supersedes v0.70.0)
**Status**: Automatic (No User Action Required)
**Canonical Location**: `.cleo/agent-outputs/`

## Overview

Agent outputs are stored at `.cleo/agent-outputs/` (the canonical location since v0.80.0). This migration guide covers the unified migration from all legacy locations into the canonical path.

### Migration History

| Version | Directory | Status |
|---------|-----------|--------|
| pre-v0.61.0 | `claudedocs/research-outputs/` | Legacy (auto-migrated) |
| v0.61.0–v0.70.0 | `claudedocs/agent-outputs/` | Legacy (auto-migrated) |
| v0.80.0+ | `.cleo/agent-outputs/` | **Current canonical** |

> **NOTE**: The `research-outputs` naming predates the `agent-outputs` rename
> (T2348). Projects that still have `research-outputs/` will have their
> content merged into `.cleo/agent-outputs/` in a single unified migration
> pass. MANIFEST.jsonl paths are rewritten automatically during merge.

### What Changed

The original `research-outputs` directory was designed for research subagent results only. It was renamed to `agent-outputs` when the system was unified to store outputs from all agent types (research, analysis, contribution, implementation). The directory was then relocated from `claudedocs/` into `.cleo/` to consolidate all CLEO state under a single project directory.

## Automatic Migration

### When It Runs

Migration runs automatically during:

| Command | Behavior |
|---------|----------|
| `cleo upgrade` | Detects and migrates any legacy directories |
| `cleo init` | Migrates existing projects before creating structure |

### What Happens

1. **Discovery**: Checks for `claudedocs/research-outputs/` and `claudedocs/agent-outputs/`
2. **Copy**: Files from legacy directories are copied to `.cleo/agent-outputs/` (oldest first, so newer files win on conflicts)
3. **Manifest merge**: MANIFEST.jsonl entries are collected from all sources, deduplicated by ID, and path references are rewritten to `.cleo/agent-outputs/`
4. **Config update**: Any config pointing to a legacy path is updated to `.cleo/agent-outputs`
5. **Cleanup**: Legacy directories are removed; empty `claudedocs/` is also removed

### Check Migration Status

```bash
# Check if legacy directories exist
ls -la claudedocs/ 2>/dev/null

# Verify canonical location
ls -la .cleo/agent-outputs/

# Run doctor to check for legacy paths
cleo doctor
```

## What Gets Migrated

### Directory Structure

```
Before (any combination of these may exist):
claudedocs/research-outputs/
├── MANIFEST.jsonl
├── 2026-01-15_auth-research.md
└── 2026-01-20_api-analysis.md

claudedocs/agent-outputs/
├── MANIFEST.jsonl
├── 2026-02-01_deploy-analysis.md
└── 2026-02-05_perf-research.md

After (single canonical location):
.cleo/agent-outputs/
├── MANIFEST.jsonl          ← merged, paths rewritten
├── 2026-01-15_auth-research.md
├── 2026-01-20_api-analysis.md
├── 2026-02-01_deploy-analysis.md
└── 2026-02-05_perf-research.md
```

### MANIFEST.jsonl Path Rewriting

All file path references inside MANIFEST.jsonl are rewritten during migration:

```jsonl
// Before (research-outputs era)
{"id":"R001","file":"claudedocs/research-outputs/2026-01-15_auth-research.md",...}

// Before (agent-outputs in claudedocs era)
{"id":"A001","file":"claudedocs/agent-outputs/2026-02-01_deploy-analysis.md",...}

// After (canonical)
{"id":"R001","file":".cleo/agent-outputs/2026-01-15_auth-research.md",...}
{"id":"A001","file":".cleo/agent-outputs/2026-02-01_deploy-analysis.md",...}
```

### Manifest Deduplication

When merging manifests from multiple sources:
- Existing `.cleo/agent-outputs/MANIFEST.jsonl` entries take priority
- Legacy entries are appended only if their `id` field is not already present
- All path references are rewritten regardless of source

## Manual Migration Steps

If automatic migration fails, follow these manual steps:

### Step 1: Create Target Directory

```bash
mkdir -p .cleo/agent-outputs
```

### Step 2: Copy Files (oldest first)

```bash
# Copy from research-outputs if it exists
if [ -d "claudedocs/research-outputs" ]; then
  cp -n claudedocs/research-outputs/*.md .cleo/agent-outputs/ 2>/dev/null
fi

# Copy from agent-outputs if it exists (overwrites older files)
if [ -d "claudedocs/agent-outputs" ]; then
  cp -n claudedocs/agent-outputs/*.md .cleo/agent-outputs/ 2>/dev/null
fi
```

### Step 3: Merge and Rewrite MANIFEST.jsonl

```bash
# Collect and rewrite manifest entries
{
  # Existing canonical entries first
  [ -f ".cleo/agent-outputs/MANIFEST.jsonl" ] && cat .cleo/agent-outputs/MANIFEST.jsonl

  # Then legacy entries with path rewriting
  for dir in claudedocs/research-outputs claudedocs/agent-outputs; do
    [ -f "$dir/MANIFEST.jsonl" ] && \
      sed 's|claudedocs/research-outputs/|.cleo/agent-outputs/|g; s|claudedocs/agent-outputs/|.cleo/agent-outputs/|g' \
      "$dir/MANIFEST.jsonl"
  done
} > .cleo/agent-outputs/MANIFEST.jsonl.tmp

mv .cleo/agent-outputs/MANIFEST.jsonl.tmp .cleo/agent-outputs/MANIFEST.jsonl
```

### Step 4: Remove Legacy Directories

```bash
rm -rf claudedocs/research-outputs
rm -rf claudedocs/agent-outputs

# Remove claudedocs/ if empty
rmdir claudedocs 2>/dev/null
```

### Step 5: Update Config

```bash
# Remove deprecated config keys, set canonical path
cleo config set agentOutputs.directory .cleo/agent-outputs
```

### Step 6: Verify

```bash
cleo validate
cleo research list
```

## Troubleshooting

### Permission Errors

**Problem**: Cannot copy or remove directories due to permissions.

**Solution**:
```bash
chmod -R u+rw claudedocs/
cleo upgrade
```

### Manifest Corruption

**Problem**: `MANIFEST.jsonl` contains invalid JSON after migration.

**Solution**:
```bash
# Validate each line
while IFS= read -r line; do
  echo "$line" | jq . > /dev/null 2>&1 || echo "Invalid: $line"
done < .cleo/agent-outputs/MANIFEST.jsonl
```

### Files Missing After Migration

**Problem**: Output files not found after migration.

**Solution**: Check if files are still in legacy directories (migration may have partially failed):
```bash
ls -la claudedocs/research-outputs/ 2>/dev/null
ls -la claudedocs/agent-outputs/ 2>/dev/null
```

If found, re-run `cleo upgrade` to complete the migration.

## Configuration

### Current Configuration Keys

```json
{
  "agentOutputs": {
    "directory": ".cleo/agent-outputs",
    "manifestFile": "MANIFEST.jsonl",
    "archiveDir": "archive",
    "archiveDays": 30
  }
}
```

### Deprecated Configuration Keys

These keys are still read as fallbacks but should not be used in new configs:

| Deprecated Key | Maps To |
|---------------|---------|
| `research.outputDir` | `agentOutputs.directory` |
| `research.manifestFile` | `agentOutputs.manifestFile` |
| `research.archiveDir` | `agentOutputs.archiveDir` |
| `research.archiveDays` | `agentOutputs.archiveDays` |
| `directories.agentOutputs` | `agentOutputs.directory` |

Config fallback priority (defined in `src/core/paths.ts`):
1. `config.agentOutputs.directory` (canonical)
2. `config.research.outputDir` (deprecated)
3. `config.directories.agentOutputs` (deprecated)
4. Default: `.cleo/agent-outputs`

## CLI Command Compatibility

All research commands work unchanged with the new location:

| Command | Status |
|---------|--------|
| `cleo research list` | Works (resolves via `getAgentOutputsDir()`) |
| `cleo research show <id>` | Works |
| `cleo research inject` | Works |
| `cleo research link <task> <id>` | Works |
| `cleo research init` | Creates `.cleo/agent-outputs/` |
| `cleo research status` | Works |

## Verification Checklist

After migration, verify:

- [ ] `.cleo/agent-outputs/` directory exists
- [ ] `claudedocs/research-outputs/` does NOT exist
- [ ] `claudedocs/agent-outputs/` does NOT exist
- [ ] `MANIFEST.jsonl` paths reference `.cleo/agent-outputs/` (not `claudedocs/`)
- [ ] `cleo validate` passes
- [ ] `cleo research list` returns expected entries
- [ ] `cleo doctor` shows no legacy directory warnings

## See Also

- [Research Command Reference](../commands/research.md)
- [Agent Outputs Architecture](../architecture/agent-outputs.md)
- Path resolution: `src/core/paths.ts` (`getAgentOutputsDir()`, `getManifestPath()`)
- Migration logic: `src/core/upgrade.ts` (Step 5) and `src/core/init.ts` (`migrateLegacyAgentOutputs()`)
