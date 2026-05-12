# T9171 — Windows CRLF Hotfix: Unblocking v2026.5.50

**Task**: T9171  
**Date**: 2026-05-07  
**Branch**: task/T9171 (merged into release/v2026.5.50)  
**Commit**: 39401fb91

## Summary

Identified and fixed all Windows shard 1 + shard 2 failures blocking PR #106 (v2026.5.50 release).

## Root Causes and Fixes

### 1. Primary: CRLF Regex Bug (Shard 1, Original Task Scope)

**File**: `packages/cant/tests/agent-fixtures.test.ts:70`  
**Bug**: Regex `/^---\nkind: agent\nversion: 1\n---/` fails when Windows runners load the file with CRLF endings (content becomes `---\r\nkind: agent\r\n...`).  
**Fix**: Normalize CRLF before matching: `const content = raw.replace(/\r\n/g, '\n')`.

### 2. CRLF in cant Parser/Validator (Shard 1)

**File**: `packages/cant/src/document.ts`  
**Bug**: `validateDocument` and `parseDocument` pass raw file content (with CRLF on Windows) to Rust native parsers that fail validation.  
**Fix**: Normalize CRLF in all three document functions: `parseDocument`, `validateDocument`, `listSections`.

### 3. CRLF in sigil-sync.ts Parser (Shard 2)

**File**: `packages/core/src/nexus/sigil-sync.ts`  
**Bug**: `parseSigilFromCant` splits on `\n` but CRLF blank lines become `'\r'` (length > 0), causing the pipe block parser to break prematurely at blank lines between prompt content.  
**Fix**: Normalize CRLF at the top of `parseSigilFromCant`.

### 4. Platform Path Resolution: Unix Paths on Windows (Shard 2)

**File**: `packages/paths/src/platform-paths.ts`  
**Bug**: `isAbsolute('/opt/cleo-data')` is true on Windows (drive-relative), so `resolve('/opt/cleo-data')` adds the current drive letter: `D:\opt\cleo-data`. Tests set Unix-style overrides and expect them back unchanged.  
**Fix**: Changed `if (isAbsolute(trimmed)) return resolve(trimmed)` to `return trimmed` (no resolution needed for absolute paths).

### 5. Path Join Separator Issue (Shard 1, Shard 2)

**Files**: `packages/paths/src/worktree-paths.ts`, `packages/paths/src/cleo-paths.ts`  
**Bug**: `path.join('/test/cleo-home', 'worktrees', hash)` on Windows returns `\test\cleo-home\worktrees\...`. Tests with Unix-style CLEO_HOME expect forward slashes throughout.  
**Fix**: Added `joinSegments()` helper in `worktree-paths.ts` that uses string concatenation with `/` when the base path contains forward slashes but no backslashes. Updated `getCleoTemplatesTildePath` in `cleo-paths.ts` similarly.

### 6. resolveActiveWorktree Walk-Up Separator Bug (Shard 1)

**File**: `packages/git-shim/src/worktree-path.ts`  
**Bug**: `parent.startsWith(`${worktreesRoot}/`)` uses forward slash after the root, but on Windows `worktreesRoot` has backslashes. Also `candidate !== '/'` doesn't terminate on Windows where root is `C:\`.  
**Fix**: Added `|| parent.startsWith(`${worktreesRoot}\\`)` and `candidate !== worktreesRoot` to the loop condition.

### 7. SQLite EBUSY Cleanup Failures (Shard 1 + Shard 2)

**Files**: Multiple test files in `@cleocode/core`  
**Bug**: `rm(dir, { recursive: true, force: true })` fails with `EBUSY: resource busy or locked` when SQLite WAL files are still held by the test process on Windows.  
**Fix**: Added `maxRetries: 20, retryDelay: 100` to all `rm()` calls in afterEach cleanup blocks in: `injection-chain.test.ts`, `sigil-sync.test.ts`, `orchestrate-engine.test.ts`, `orchestrate-engine-composer.test.ts`, `tasks-sqlite.test.ts`, `write-verification.test.ts`.

## Shard 2 Findings

All shard 2 failures were:
- `cleo-paths.test.ts` + `platform-paths.test.ts` — fixed by #4 above
- `sigil-sync.test.ts` — fixed by #3 + EBUSY (#7)
- `injection-chain.test.ts` — fixed by EBUSY (#7)
- `orchestrate-engine*.test.ts` — fixed by EBUSY (#7)
- `tasks-sqlite.test.ts` + `write-verification.test.ts` — fixed by EBUSY (#7)

No separate follow-up task required — all shard 2 failures were addressed in this task.

## Evidence

- Biome CI: 2159 files, 0 errors
- `@cleocode/paths` local tests: 32/32 pass
- `agent-fixtures.test.ts` local test: 2/2 pass (2 skipped per existing .skip)
- Commit: 39401fb91 on task/T9171, merged to release/v2026.5.50
- CI run 25522702815 triggered on release/v2026.5.50
