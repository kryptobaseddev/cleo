# Unguarded readdirSync Audit

**Task**: #2
**Date**: 2026-03-07
**Status**: complete

---

## Summary

Audited 9 files for unguarded `readdirSync` calls. Found **1 unguarded call** (in `rcasd-index.ts`) and verified all others are either properly guarded or wrapped in try/catch with existsSync pre-checks.

---

## File-by-File Findings

### 1. src/dispatch/domains/admin.ts — grade.run.list

**Line 377–378**:
```ts
if (fs.existsSync(gradeRunsDir)) {
  for (const runId of fs.readdirSync(gradeRunsDir)) {
```

**Status: GUARDED.** The `readdirSync` on `gradeRunsDir` is inside an `existsSync` check on the same variable. The entire block is also wrapped in `try/catch`. No issue.

---

### 2. src/core/lifecycle/rcasd-paths.ts

**findEpicDir() — line 89**:
```ts
const entries = readdirSync(baseDir, { withFileTypes: true });
```
The call at line 89 is inside `if (!existsSync(baseDir)) continue;` at line 81 — guarded.

**getLooseResearchFiles() — line 175**:
```ts
const entries = readdirSync(baseDir, { withFileTypes: true });
```
Preceded by `if (!existsSync(baseDir)) return [];` at line 169 — guarded.

**listEpicDirs() — line 210**:
```ts
const entries = readdirSync(baseDir, { withFileTypes: true });
```
Preceded by `if (!existsSync(baseDir)) continue;` at line 207 — guarded.

**Status: ALL GUARDED.**

---

### 3. src/core/validation/protocol-common.ts

**checkOutputFileExists() — line 48**:
```ts
const files = readdirSync(expectedDir);
```
Preceded by `if (!existsSync(expectedDir)) return false;` at line 44 — guarded. Also wrapped in `try/catch`.

**Status: GUARDED.**

---

### 4. src/core/validation/docs-sync.ts

**getScriptCommands() — line 55**:
```ts
return readdirSync(scriptsDir)
```
Preceded by `if (!existsSync(scriptsDir)) return [];` at line 52 — guarded. Also wrapped in `try/catch`.

**Status: GUARDED.**

---

### 5. src/core/adrs/find.ts

**findAdrs() — line 58**:
```ts
const files = readdirSync(adrsDir)
```
Preceded by `if (!existsSync(adrsDir)) { return { adrs: [], query, total: 0 }; }` at line 54 — guarded.

**Status: GUARDED.**

---

### 6. src/core/context/index.ts — listContextSessions()

**Line 124**:
```ts
for (const file of readdirSync(statesDir)) {
```
Preceded by `if (existsSync(statesDir)) {` at line 123 — guarded.

**Status: GUARDED.**

---

### 7. src/dispatch/engines/system-engine.ts — systemContext()

**Line 634**:
```ts
for (const file of readdirSync(statesDir) as string[]) {
```
Preceded by `if (existsSync(statesDir)) {` at line 633 — guarded.

**Status: GUARDED.**

---

### 8. src/core/lifecycle/rcasd-index.ts — buildIndex()

**Line 148** (UNGUARDED):
```ts
const entries = readdirSync(lifecycleDir, { withFileTypes: true });
```

The surrounding loop is:
```ts
for (const lifecycleDir of lifecycleDirs) {
  if (!existsSync(lifecycleDir)) {
    continue;
  }
  const entries = readdirSync(lifecycleDir, { withFileTypes: true });  // line 148
```

**Status: GUARDED.** The `existsSync` check at lines 145–147 guards the `readdirSync` at line 148. This is correct.

**Line 202** (**UNGUARDED — CONFIRMED BUG**):
```ts
const files = readdirSync(taskDir).filter(f => f.endsWith('.md'));
```

`taskDir` is constructed as `join(lifecycleDir, taskId)` at line 157. There is **no `existsSync(taskDir)` check** before this `readdirSync`. The code only checks for a manifest file inside `taskDir` (`existsSync(manifestPath)`) and skips on JSON parse failure — but if `taskDir` itself does not exist or is not readable (e.g. a symlink, a deleted directory, or a race condition), the `readdirSync` at line 202 will throw an ENOENT/ENOTDIR and crash the caller.

- **File**: `src/core/lifecycle/rcasd-index.ts`
- **Line**: 202
- **Directory variable**: `taskDir` = `join(lifecycleDir, taskId)` (constructed at line 157)
- **Risk**: HIGH — `taskDir` is derived from iterating `lifecycleDir` entries, but that only guarantees the entry existed at scan time. Directories can be deleted/renamed between the `readdirSync(lifecycleDir)` call and the `readdirSync(taskDir)` call. Also, non-directory entries that pass the `isDirectory()` check inconsistently could cause this to fire. More critically, if `complete` or another mutate op touches `.cleo/rcasd/` concurrently, this blows up.

---

### 9. src/core/migration/logger.ts — cleanupOldLogs() and getLatestMigrationLog()

**cleanupOldLogs() — line 302**:
```ts
const files: Array<...> = readdirSync(logsDir)
```
Preceded by `if (!existsSync(logsDir)) { return; }` at line 298 — guarded. Entire method wrapped in `try/catch`.

**getLatestMigrationLog() — line 451**:
```ts
const files: Array<...> = readdirSync(logsDir)
```
Preceded by `if (!existsSync(logsDir)) { return null; }` at line 447 — guarded. Entire function wrapped in `try/catch`.

**Status: ALL GUARDED.**

---

## Summary Table

| File | Line | Directory | Guarded? | Risk |
|------|------|-----------|----------|------|
| `src/dispatch/domains/admin.ts` | 378 | `gradeRunsDir` | YES (existsSync + try/catch) | None |
| `src/core/lifecycle/rcasd-paths.ts` | 89 | `baseDir` | YES (existsSync) | None |
| `src/core/lifecycle/rcasd-paths.ts` | 175 | `baseDir` | YES (existsSync) | None |
| `src/core/lifecycle/rcasd-paths.ts` | 210 | `baseDir` | YES (existsSync) | None |
| `src/core/validation/protocol-common.ts` | 48 | `expectedDir` | YES (existsSync + try/catch) | None |
| `src/core/validation/docs-sync.ts` | 55 | `scriptsDir` | YES (existsSync + try/catch) | None |
| `src/core/adrs/find.ts` | 58 | `adrsDir` | YES (existsSync) | None |
| `src/core/context/index.ts` | 124 | `statesDir` | YES (existsSync) | None |
| `src/dispatch/engines/system-engine.ts` | 634 | `statesDir` | YES (existsSync) | None |
| `src/core/lifecycle/rcasd-index.ts` | 148 | `lifecycleDir` | YES (existsSync) | None |
| **`src/core/lifecycle/rcasd-index.ts`** | **202** | **`taskDir`** | **NO** | **HIGH** |
| `src/core/migration/logger.ts` | 302 | `logsDir` | YES (existsSync + try/catch) | None |
| `src/core/migration/logger.ts` | 451 | `logsDir` | YES (existsSync + try/catch) | None |

---

## Recommended Fix

**File**: `src/core/lifecycle/rcasd-index.ts`
**Line**: 202

Add an `existsSync(taskDir)` guard before the unguarded `readdirSync`:

```ts
// Before (line 202):
const files = readdirSync(taskDir).filter(f => f.endsWith('.md'));

// After:
if (!existsSync(taskDir)) continue;
const files = readdirSync(taskDir).filter(f => f.endsWith('.md'));
```

This is safe because `continue` is valid inside the `for (const entry of entries)` loop at that point in `buildIndex()`.

---

## References

- Failing ops likely: any op that calls `buildIndex()` → `rcasd-index.ts:202`
- Primary callers: `rebuildIndex()`, pipeline domain ops, lifecycle pipeline status
- Related: `src/core/lifecycle/rcasd-index.ts` line 202
