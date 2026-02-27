# CLEO V2 Migration Guide: Bash CLI to TypeScript CLI

**Task**: T4472
**Epic**: T4454
**Date**: 2026-02-14
**Status**: complete

---

## Summary

This guide covers migrating from the CLEO Bash CLI (v0.x) to the TypeScript CLI (V2). The V2 rewrite delivers the same functionality with type-safe internals, LAFS-compliant output, and a modular architecture built on Node.js.

---

## Prerequisites

- Node.js 20+ (LTS recommended)
- npm or pnpm
- Existing CLEO Bash installation (for migration)

## What Changed

### Architecture

| Aspect | Bash CLI (v0.x) | TypeScript CLI (V2) |
|--------|-----------------|---------------------|
| Runtime | Bash + jq | Node.js + TypeScript |
| Entry point | `scripts/*.sh` | `src/cli/commands/*.ts` |
| Library code | `lib/*.sh` | `src/core/*` |
| Validation | `lib/validation/validation.sh` | `src/core/schema.ts` (ajv) |
| Output format | JSON via jq | LAFS envelopes via `formatOutput()` |
| Error handling | Exit codes + JSON | `CleoError` class + exit codes |
| Config resolution | Bash env + jq | Cascading: CLI > env > project > global > defaults |
| Store layer | `lib/data/file-ops.sh` | `src/store/json.ts` (atomic read/write) |
| Type system | None (string-based) | Full TypeScript interfaces |

### Output Format

V2 uses LAFS (LLM-Agent-First Schema) envelopes for all output:

```json
// Success
{
  "success": true,
  "data": { ... },
  "message": "optional human message"
}

// Error
{
  "success": false,
  "error": {
    "code": 4,
    "name": "E_NOT_FOUND",
    "message": "Task not found: T9999",
    "fix": "Use 'cleo find \"T9999\"' to search"
  }
}
```

The `_meta` envelope from the Bash CLI is replaced by the LAFS `success`/`data`/`error` structure. The `$schema` field is no longer included in responses.

## Command Equivalents

All commands remain available under the same names. The `ct` alias continues to work.

| Operation | Bash CLI | TypeScript CLI | Notes |
|-----------|----------|---------------|-------|
| Add task | `ct add "Title"` | `ct add "Title"` | Same syntax |
| List tasks | `ct list` | `ct list` | Same syntax |
| Show task | `ct show T1234` | `ct show T1234` | Same syntax |
| Find tasks | `ct find "query"` | `ct find "query"` | Same syntax |
| Complete task | `ct done T1234 --notes "..."` | `ct done T1234 --notes "..."` | Same syntax |
| Update task | `ct update T1234 --status active` | `ct update T1234 --status active` | Same syntax |
| Delete task | `ct delete T1234` | `ct delete T1234` | Same syntax |
| Archive | `ct archive` | `ct archive` | Same syntax |
| Focus set | `ct start T1234` | `ct start T1234` | Same syntax |
| Focus show | `ct current` | `ct current` | Same syntax |
| Session start | `ct session start --scope epic:T001` | `ct session start --scope epic:T001` | Same syntax |
| Session end | `ct session end --note "..."` | `ct session end --note "..."` | Same syntax |
| Session list | `ct session list` | `ct session list` | Same syntax |
| Deps graph | `ct deps T1234` | `ct deps T1234` | Same syntax |
| Phase management | `ct phase set core` | `ct phase set core` | Same syntax |
| Release | `ct release create v1.0.0` | `ct release create v1.0.0` | Same syntax |
| Research | `ct research link T1234 id` | `ct research link T1234 id` | Same syntax |
| Orchestrate | `ct orchestrate analyze T001` | `ct orchestrate analyze T001` | Same syntax |
| Lifecycle | `ct lifecycle check T001` | `ct lifecycle check T001` | Same syntax |
| Migrate | `ct migrate` | `ct migrate` | Same syntax |

## Breaking Changes

### 1. Response Envelope Structure

**Before (Bash CLI):**
```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "command": "add",
    "timestamp": "2026-02-14T00:00:00Z",
    "version": "0.95.4"
  },
  "success": true,
  "taskId": "T1234"
}
```

**After (TypeScript CLI):**
```json
{
  "success": true,
  "data": {
    "taskId": "T1234",
    "title": "New task"
  }
}
```

If you parse CLI output, update your parsers to read from `.data` instead of the top-level object.

### 2. Error Shape

**Before:** Error details at `error.code` (string like `E_NOT_FOUND`), `error.exitCode` (number).

**After:** Error details at `error.code` (number), `error.name` (string like `E_NOT_FOUND`), `error.message`, `error.fix`, `error.alternatives`.

### 3. Configuration Resolution

V2 introduces a formal cascade for configuration:

```
CLI flags > Environment variables > Project config (.cleo/config.json) > Global config (~/.cleo/config.json) > Defaults
```

New environment variable mapping is available. For example:
- `CLEO_FORMAT` maps to `output.defaultFormat`
- `CLEO_HIERARCHY_MAX_DEPTH` maps to `hierarchy.maxDepth`
- `CLEO_SESSION_AUTO_FOCUS` maps to `session.autoStart`

### 4. Task Status Enum

The canonical task status enum is now strictly enforced:

```
pending | active | blocked | done | cancelled
```

The legacy `completed` status is no longer valid. All tasks must use `done`.

## Configuration Migration

Your existing `.cleo/config.json` is fully compatible. V2 reads the same file with added defaults for new fields:

```json
{
  "output": {
    "defaultFormat": "json",
    "showColor": true,
    "showUnicode": true,
    "showProgressBars": true,
    "dateFormat": "relative"
  },
  "backup": {
    "maxOperationalBackups": 10,
    "maxSafetyBackups": 5,
    "compressionEnabled": false
  },
  "hierarchy": {
    "maxDepth": 3,
    "maxSiblings": 7,
    "cascadeDelete": false
  },
  "session": {
    "autoStart": false,
    "requireNotes": false,
    "multiSession": false
  },
  "lifecycle": {
    "mode": "strict"
  }
}
```

## Data Migration

V2 reads the same `.cleo/todo.json`, `.cleo/config.json`, `.cleo/sessions.json`, and `.cleo/todo-archive.json` files. No data migration is required. The `ct migrate` command handles any schema version upgrades automatically.

## Dual-CLI Period

During the 60-day parallel run period (see [deprecation plan](v2-deprecation-plan.md)), both CLIs are available:

```bash
cleo-v1 add "Task"    # Bash CLI (deprecated)
cleo add "Task"       # TypeScript CLI (default)
ct add "Task"         # Alias (points to TypeScript CLI)
```

## Troubleshooting Migration Issues

### "Command not found" after upgrade

Reinstall the symlinks:
```bash
npm install -g @cleo-dev/cli
# or
./install.sh
```

### JSON output looks different

V2 uses LAFS envelopes. Update scripts that parse output to use `.data` for success payloads and `.error` for error payloads.

### Schema validation errors

Run `ct migrate` to upgrade your data files to the latest schema version.

### Session errors

V2 requires `CLEO_SESSION` environment variable or `--session` flag for multi-session mode. If you get `E_SESSION_REQUIRED`, set the session ID.
