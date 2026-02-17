# Migration Guide: Hybrid Registry Architecture

**Version**: 0.68.0
**Status**: Automatic (No User Action Required)

## Overview

Version 0.68.0 introduces the **hybrid registry architecture**, splitting project metadata between a global registry and per-project info files. This migration is fully automatic and transparent to users.

## What Changed

### Before (Single Registry Model)

All project data stored in the global registry:

```
~/.cleo/projects-registry.json
├── Project A: full metadata (schemas, health, issues, injections)
├── Project B: full metadata (schemas, health, issues, injections)
└── Project C: full metadata (schemas, health, issues, injections)
```

**Problems**:
- Global registry grew large with many projects
- Project-specific data not versioned with project
- Stale data if registry not synchronized
- Performance degradation with many projects

### After (Hybrid Model)

Data split between global registry and per-project files:

```
~/.cleo/projects-registry.json        Per-Project Files
├── Project A: minimal (path, status)  → .cleo/project-info.json (detailed)
├── Project B: minimal (path, status)  → .cleo/project-info.json (detailed)
└── Project C: minimal (path, status)  → .cleo/project-info.json (detailed)
```

**Benefits**:
- Global registry stays small and fast
- Detailed data stored locally in each project
- Project metadata versioned with project code
- Better performance for multi-project setups
- Offline access to project-specific data

## Migration Process

### Automatic Migration (Default)

**No user action required.** Migration happens automatically:

1. **On `cleo upgrade`**: Creates `project-info.json` if missing
2. **On `cleo init`**: Creates both global and per-project entries
3. **On `cleo doctor`**: Reads from per-project file if available

### What Gets Created

When you run `cleo upgrade` on an existing project:

```bash
# Before
.cleo/
├── todo.json
├── config.json
├── todo-archive.json
└── todo-log.jsonl

# After (new file added)
.cleo/
├── todo.json
├── config.json
├── todo-archive.json
├── todo-log.jsonl
└── project-info.json  ← NEW
```

### Per-Project File Contents

```json
{
  "$schema": "./schemas/project-info.schema.json",
  "schemaVersion": "1.0.0",
  "projectHash": "a3f5b2c8d1e9",
  "cleoVersion": "0.68.0",
  "lastUpdated": "2026-01-24T00:00:00Z",
  "schemas": {
    "todo": "2.8.0",
    "config": "1.5.0",
    "archive": "2.8.0",
    "log": "1.2.0"
  },
  "injection": {
    "CLAUDE.md": "0.68.0",
    "AGENTS.md": "0.68.0",
    "GEMINI.md": "0.68.0"
  },
  "health": {
    "status": "healthy",
    "lastCheck": "2026-01-24T00:00:00Z",
    "issues": []
  }
}
```

## Triggering Migration

### Method 1: Run Upgrade (Recommended)

```bash
cd /path/to/your/project
cleo upgrade
```

This creates `project-info.json` and updates the global registry.

### Method 2: Run Doctor

```bash
cleo doctor
```

Doctor will read from existing files and update health status. On next `upgrade`, the per-project file is created.

### Method 3: Re-Initialize

```bash
cleo init
```

Full re-initialization creates all files fresh.

## Backward Compatibility

### Legacy Projects Work Unchanged

Projects without `project-info.json` continue to work:

| Command | Behavior |
|---------|----------|
| `cleo list` | Works normally |
| `cleo add` | Works normally |
| `cleo doctor` | Falls back to reading project files directly |
| `cleo upgrade` | Creates `project-info.json` on next run |

### Version Matrix

| CLEO Version | Global Registry | Per-Project File | Behavior |
|--------------|-----------------|------------------|----------|
| < 0.68.0 | ✅ Used | ❌ N/A | Single registry model |
| >= 0.68.0 | ✅ Minimal | ✅ Detailed | Hybrid model |
| >= 0.68.0 (legacy project) | ✅ Used | ❌ Not yet created | Fallback to direct reads |

### Gradual Migration

No "big bang" migration required. Projects migrate individually:

1. Install CLEO 0.68.0+
2. Each project migrates on first `upgrade`
3. Legacy projects work until upgraded

## Data Preservation

### What's Preserved

- All task data (unchanged)
- All configuration (unchanged)
- Archive and log files (unchanged)
- Global registry entries (converted to minimal format)

### What's Created

- `.cleo/project-info.json` - New file with detailed metadata
- Schema versions extracted from actual files
- Injection versions detected from agent docs

## Verification

### Check Migration Status

```bash
# Verify per-project file exists
ls -la .cleo/project-info.json

# View contents
cat .cleo/project-info.json | jq .

# Check health status
cleo doctor
```

### Verify Global Registry

```bash
# View registered projects
cleo doctor --detail
```

## Rollback (If Needed)

The migration is non-destructive. To revert:

```bash
# Remove per-project file (optional)
rm .cleo/project-info.json

# CLEO will fall back to direct file reads
# Re-run upgrade to recreate if needed
```

## FAQ

### Q: Do I need to do anything?

**A**: No. Migration is automatic on `cleo upgrade`.

### Q: What if I have multiple projects?

**A**: Each project migrates independently. Run `cleo upgrade` in each project directory.

### Q: Can I skip migration?

**A**: Yes. Legacy projects work fine. Migration happens automatically when you next run `upgrade`.

### Q: Will this break my CI/CD?

**A**: No. The hybrid model is backward compatible. Existing workflows continue to work.

### Q: What about shared/team projects?

**A**: Each team member's global registry is separate. The per-project `project-info.json` can be committed to git (optional) for shared health tracking.

### Q: Should I commit project-info.json?

**A**: Optional. Benefits:
- **Commit**: Team shares health status, schema versions tracked
- **Gitignore**: Each developer has local status, less noise in commits

Add to `.gitignore` if not committing:
```
.cleo/project-info.json
```

## Technical Details

### Hash Generation

Project hash is a 12-character hex prefix of SHA-256:

```bash
echo -n "/path/to/project" | sha256sum | cut -c1-12
```

This links global registry entries to per-project files.

### Merge Behavior

When reading project data, `get_project_data()` merges sources:

1. Start with global registry data (base)
2. Overlay per-project data (takes precedence)
3. Return merged result

### Atomic Updates

All file writes use atomic operations:

1. Write to temp file
2. Validate JSON
3. Rename to target (atomic on POSIX)

## See Also

- [Project Registry Guide](../guides/project-registry.md) - Full architecture documentation
- [doctor command](../commands/doctor.md) - Health check details
- [upgrade command](../commands/upgrade.md) - Migration trigger
