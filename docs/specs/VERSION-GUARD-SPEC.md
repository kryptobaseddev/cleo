# Version Guard System Specification

> **SUPERSEDED**: This document has been superseded by [HEALTH-REGISTRY-SPEC.md](./HEALTH-REGISTRY-SPEC.md) which provides a comprehensive health registry system including version guards, health monitoring, and multi-agent coordination.

## Overview

This specification defines a three-layer defense system for schema integrity in cleo,
ensuring data compatibility and providing clear migration paths when schema versions change.

## Problem Statement

Current issues:
1. Schemas exist in TWO locations (global `~/.cleo/schemas/` + project `.cleo/schemas/`)
2. No proactive version checking - users discover issues only via explicit `ct validate`
3. Write commands (add/update/complete/archive) can corrupt data if schema is outdated
4. Multiple documentation sources for migration (fragmented)
5. No automatic migration prompting

## Proposed Solution: Three-Layer Defense

### Layer 1: Startup Guard (lib/startup-guard.sh)

**Purpose:** Fast version check on every command startup

**Behavior:**
- Single jq call to read `._meta.version` from `.cleo/todo.json`
- Compare against expected version from `schemas/version-manifest.json`
- Return status: OK (0), WARN (1), BLOCK (2)

**Performance Target:** < 10ms

**Pseudocode:**
```bash
quick_version_check() {
    local todo_file=".cleo/todo.json"
    [[ ! -f "$todo_file" ]] && return 0  # No project, skip

    local current=$(jq -r '._meta.version // "unknown"' "$todo_file" 2>/dev/null)
    local expected=$(jq -r '.current.todo' "$VERSION_MANIFEST" 2>/dev/null)

    if [[ "$current" == "$expected" ]]; then
        return 0  # OK
    fi

    local current_major="${current%%.*}"
    local expected_major="${expected%%.*}"

    if [[ "$current_major" != "$expected_major" ]]; then
        return 2  # BLOCK - major version mismatch
    fi

    return 1  # WARN - minor version mismatch
}
```

**Integration Point:** Called by wrapper script before dispatching to command

### Layer 2: Write Guard (lib/write-guard.sh)

**Purpose:** Pre-write validation with inline migration option

**Behavior:**
- Called by add-task.sh, update-task.sh, complete-task.sh, archive.sh
- Checks: version + checksum + basic integrity
- If migration needed: prompt user (interactive) or fail with instructions (non-interactive)

**Pseudocode:**
```bash
can_write_safely() {
    local result=$(quick_version_check)

    case $result in
        0) return 0 ;;  # OK to write
        1)  # Minor mismatch - offer migration
            if is_interactive; then
                prompt_migrate_and_continue
            else
                emit_json_warning "SCHEMA_OUTDATED"
                return 0  # Allow write with warning in non-interactive
            fi
            ;;
        2)  # Major mismatch - block
            emit_error "SCHEMA_INCOMPATIBLE" "Major version mismatch. Run: ct migrate run"
            return 1
            ;;
    esac
}
```

### Layer 3: Full Validation (validate.sh)

**Purpose:** Comprehensive validation with --fix capability

**Behavior:**
- Existing 11+ checks
- --fix mode for auto-repair
- Used for troubleshooting and CI/CD

**No changes needed** - existing implementation is sufficient

## Version Manifest (schemas/version-manifest.json)

**Purpose:** Single source of truth for schema versions

**Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "cleo-version-manifest-v1",

  "current": {
    "todo": "2.3.0",
    "config": "2.2.0",
    "archive": "2.1.0",
    "log": "2.1.0"
  },

  "minimum": {
    "todo": "2.0.0",
    "config": "2.0.0",
    "archive": "2.0.0",
    "log": "2.0.0"
  },

  "history": [
    {
      "version": "2.3.0",
      "date": "2024-12-18",
      "type": "todo",
      "changes": [
        "Added type field (epic|task|subtask)",
        "Added parentId field for hierarchy",
        "Added size field (small|medium|large)"
      ],
      "migration": "auto",
      "breaking": false
    },
    {
      "version": "2.2.0",
      "date": "2024-12-15",
      "type": "todo",
      "changes": [
        "Added project.phases object",
        "Added project.currentPhase field"
      ],
      "migration": "auto",
      "breaking": false
    }
  ]
}
```

**Migration from lib/migrate.sh:**
- Replace hardcoded `SCHEMA_VERSION_*` constants
- Read from manifest at runtime: `jq -r '.current.todo' "$VERSION_MANIFEST"`

## Configuration Options

Add to `config.json` schema:

```json
{
  "validation": {
    "checkVersionOnStartup": {
      "type": "boolean",
      "default": true,
      "description": "Run quick version check on every command"
    },
    "startupCheckBehavior": {
      "type": "string",
      "enum": ["warn", "block", "silent"],
      "default": "warn",
      "description": "What to do when version mismatch detected on startup"
    },
    "writeGuardBehavior": {
      "type": "string",
      "enum": ["prompt", "auto", "warn", "block"],
      "default": "prompt",
      "description": "Behavior when write command detects version mismatch"
    },
    "suppressWarningsUntil": {
      "type": "string",
      "format": "date-time",
      "description": "Suppress version warnings until this timestamp (prevents warning fatigue)"
    }
  }
}
```

## Behavior Matrix

| Scenario | Read Command | Write Command (interactive) | Write Command (non-interactive) |
|----------|--------------|-----------------------------|---------------------------------|
| Same version | proceed | proceed | proceed |
| Minor behind | warn | prompt migrate | warn + proceed |
| Major behind | warn | block | block + error |
| Unknown version | warn | prompt migrate | warn + proceed |
| Ahead of global | warn (downgrade?) | warn + proceed | warn + proceed |

## Non-Interactive Detection

```bash
is_interactive() {
    [[ -t 0 && -t 1 ]]  # stdin and stdout are terminals
}
```

## Error Messages

### Version Mismatch Warning (startup)
```
[WARN] Schema version outdated (v2.2.0 → v2.3.0)
       Run 'ct migrate run' to upgrade, or 'ct migrate status' for details.
       (Suppress: ct config set validation.suppressWarningsUntil "$(date -d '+7 days' -Iseconds)")
```

### Write Guard Prompt (interactive)
```
Schema version outdated (v2.2.0 → v2.3.0)
Migration adds: type, parentId, size fields for task hierarchy

Options:
  [M] Migrate now and continue (recommended)
  [S] Skip migration and proceed anyway
  [A] Abort

Choice [M/s/a]:
```

### Write Guard Block (major mismatch)
```
[ERROR] Cannot write: schema version incompatible
        Project: v1.5.0, Expected: v2.3.0
        Major version change requires explicit migration.

        Run: ct migrate run
        See: ct migrate status --verbose
```

### JSON Output (non-interactive)
```json
{
  "_meta": {"command": "add", "timestamp": "..."},
  "success": false,
  "error": {
    "code": "E_SCHEMA_OUTDATED",
    "message": "Schema version mismatch",
    "current": "2.2.0",
    "expected": "2.3.0",
    "action": "Run 'ct migrate run' to upgrade"
  }
}
```

## Implementation Phases

### Phase 1: Foundation (v0.24.0)
- [ ] Create `schemas/version-manifest.json`
- [ ] Create `lib/startup-guard.sh` with `quick_version_check()`
- [ ] Modify `lib/migrate.sh` to read from manifest
- [ ] Add startup check to wrapper (warn only)
- [ ] Add config options to schema

### Phase 2: Write Protection (v0.25.0)
- [ ] Create `lib/write-guard.sh` with `can_write_safely()`
- [ ] Integrate into add-task.sh, update-task.sh, complete-task.sh, archive.sh
- [ ] Implement inline migration prompt
- [ ] Add non-interactive mode support

### Phase 3: Polish (v0.26.0)
- [ ] Add post-install project scan to install.sh
- [ ] Consolidate migration documentation
- [ ] Add warning suppression mechanism
- [ ] Performance optimization (caching)

## Performance Considerations

1. **Fast path optimization:** If version matches, exit immediately
2. **Caching:** Cache version check result in environment variable for session
3. **Lazy loading:** Don't parse full manifest unless needed
4. **Alternative to jq:** Use `grep` + `sed` for ultra-fast version extraction if jq proves too slow

## Testing Strategy

1. **Unit tests:**
   - Version comparison logic
   - Manifest parsing
   - Error message generation

2. **Integration tests:**
   - Startup guard with various version combinations
   - Write guard with migration flow
   - Non-interactive mode behavior

3. **Performance tests:**
   - Measure startup latency with/without guard
   - Test with large todo.json files (1000+ tasks)

## Backward Compatibility

1. **Missing version field:** Treat as "1.0.0" (oldest supported)
2. **Default config:** All checks enabled, warn-only (non-blocking)
3. **Gradual rollout:** Feature flags for new blocking behavior
