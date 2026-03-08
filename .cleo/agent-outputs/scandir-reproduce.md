# Scandir Error Reproduction Report

**Task**: T3 (reproducer agent)
**Date**: 2026-03-08
**Status**: complete

---

## Summary

Ran all specified cleo-dev ops against the current dist build. **No ENOENT/scandir errors were produced** by any op in the current state. This is because the existsSync guard fixes were already committed (commits `ccba9d67` and `8d06de6c`) and the dist was rebuilt at 19:45 on 2026-03-07, which includes those fixes.

The fixes in the repo address three specific unguarded `readdirSync` calls. This report documents what those errors were, which ops would have triggered them, and the current state of all tested ops.

---

## Ops Tested (All Exit 0, No Scandir Errors)

| Command | Exit | Notes |
|---------|------|-------|
| `grade list` | 0 | Returns empty — existsSync guard on gradeRunsDir added in admin.ts diff |
| `snapshot export` | 0 | No readdirSync in path |
| `stats` | 0 | No readdirSync in path |
| `context status` | 0 | existsSync guard on context-states dir present |
| `log` | 0 | Returns empty entries |
| `sequence show` | 0 | No readdirSync in path |
| `doctor` | 0 | All checks pass |
| `verify T5665` | 0 | Task now verified |
| `complete T5665` | 0 | Task completed successfully (after verify --all) |
| `adr list` | 0 | existsSync guard on adrsDir present |
| `detect-drift` | 0 | readdirSync calls all have existsSync guards |
| `otel status` | 0 | existsSync guard on otelDir present |
| `lifecycle show T5665` | 0 | existsSync guards present |
| `push` | 1 | Fails with git remote error (no remote set), not scandir |

---

## Root Cause of Original Scandir Errors (Pre-Fix)

Three locations had unguarded `readdirSync` calls:

### 1. `src/core/adrs/sync.ts` — `collectAdrFiles()`

**Fixed in commit**: `8d06de6c`

```typescript
// BEFORE (would throw ENOENT if .cleo/adrs/ sub-directory didn't exist):
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    const sub = join(dir, entry.name);
    for (const f of readdirSync(sub)) {  // unguarded scandir of sub
```

**What op triggers it**: `adr sync` (MCP: `admin.adr.sync`) AND `lifecycle stage.complete` for the `architecture_decision` stage (calls `syncAdrsToDb` → `collectAdrFiles`).

**Missing directory**: `.cleo/adrs/<subdirectory>` — any subdirectory inside the ADR dir that isn't readable or a race condition during creation.

**Error form**: `ENOENT: no such file or directory, scandir '/mnt/projects/claude-todo/.cleo/adrs/<subdir>'`

---

### 2. `src/core/nexus/sharing/index.ts` — `collectCleoFiles()`

**Fixed in commit**: `8d06de6c`

```typescript
// BEFORE (would throw ENOENT if .cleo/ dir didn't exist):
function collectCleoFiles(cleoDir: string): string[] {
  // no existsSync check before walk(cleoDir)
  const files: string[] = [];
  function walk(dir: string): void {
    const entries = readdirSync(dir);  // unguarded if cleoDir doesn't exist
```

**What op triggers it**: `nexus share.status` (MCP op) OR any sharing operation through `getSharingStatus()`.

**Missing directory**: `.cleo/` itself — triggered on fresh project init or if the .cleo dir was missing.

**Error form**: `ENOENT: no such file or directory, scandir '/path/to/project/.cleo'`

---

### 3. `src/core/lifecycle/rcasd-index.ts` — `buildIndex()` inner scan

**Fixed in commit**: `ccba9d67`

```typescript
// BEFORE (would throw if taskDir was deleted between existsSync check and readdirSync):
if (existsSync(manifestPath)) { ... }
// taskDir check missing here — taskDir could be removed between discovery and scan
const files = readdirSync(taskDir).filter(f => f.endsWith('.md'));  // unguarded
```

**What op triggers it**: Any op calling `buildIndex()`. This is only used in tests currently (not wired to production ops), but it would also be triggered by the `pipeline.stage.status` or similar that rebuilds the index.

**Missing directory**: `.cleo/rcasd/<epicId>/` — race condition if the task directory is removed after being listed but before being scanned.

**Error form**: `ENOENT: no such file or directory, scandir '/mnt/projects/claude-todo/.cleo/rcasd/<taskId>'`

---

## Current State of Dist vs Source

- **Dist built at**: 2026-03-07 19:45 (includes existsSync fixes from commits ccba9d67 and 8d06de6c)
- **Latest commit**: `127a00f5` at 19:47 (nexus registry cleanup — no readdirSync changes)
- **Current untracked changes**: `src/dispatch/domains/admin.ts` and `src/core/metrics/token-service.ts` (NOT yet built into dist)

The `admin.ts` working-tree changes add `grade.run.list` with a properly guarded `fs.existsSync(gradeRunsDir)` check before `fs.readdirSync(gradeRunsDir)` — no new scandir risk.

---

## All readdirSync Calls in Source — Guard Status

After reviewing all 60+ `readdirSync` calls across the codebase, all are now properly guarded by either:
- `existsSync()` check on the same or previous line
- `try/catch` wrapping the `readdirSync` call
- Called inside a function that begins with `if (!existsSync(...)) return []`

No additional unguarded `readdirSync` calls were found in production source code (excluding test files).

---

## References

- Commits with fixes: `ccba9d67`, `8d06de6c`
- Source files fixed: `src/core/adrs/sync.ts`, `src/core/nexus/sharing/index.ts`, `src/core/lifecycle/rcasd-index.ts`
- Ops that would have triggered errors: `admin.adr.sync`, `nexus.share.status`, `pipeline.stage.complete` (architecture_decision stage)
