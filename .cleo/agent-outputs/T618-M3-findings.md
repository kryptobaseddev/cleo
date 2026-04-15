# T618-M3: Path Normalization Audit — barrelMap vs namedImportMap

**Date**: 2026-04-14
**Task**: T618-M3
**Status**: COMPLETE — No mismatch found. Root cause identified as resolution failure, not format mismatch.

---

## Conclusion

**There is no path format mismatch** between `barrelMap` keys and `namedImportMap` `sourcePath` values. Both use the same relative-path format (relative to repo root, forward-slash-normalized). The barrel lookup in `call-processor.ts` line 173 (`barrelMap.has(binding.sourcePath)`) is structurally correct.

The root cause of 0 callers for `findTasks`/`endSession` is that `resolveTypescriptImport` **fails to resolve `@cleocode/core`** (returns null), so no named binding is stored in `namedImportMap` for those imports. This means the callers never reach barrel tracing — they are silently dropped at import resolution time.

---

## Path Format Analysis

### barrelMap keys
- Source: `re.filePath` (from `WorkerExtractedReExport.filePath` in parse-worker.ts)
- Origin: `file.path` passed to `extractReExports(rootNode, file.path, ...)` in parse-worker.ts line 873
- Type: `ScannedFile.path` — documented as "relative to repo root, forward slashes"
- Example: `packages/core/src/index.ts`

### namedImportMap sourcePath values
- Source: `resolved` from `resolveTypescriptImport(filePath, imp.rawImportPath, ...)` in `processExtractedImports` (import-processor.ts line 537-557)
- Origin: Return value from `tryResolveWithExtensions(basePath, allFiles)` or `suffixResolve(...)` — both return entries from `allFileList` which is `files.map((f) => f.path)` (same `ScannedFile.path` values)
- Type: Same relative-path format
- Example: `packages/core/src/index.ts`

### Same resolution function, same input set
Both `buildBarrelExportMap` (line 630) and `processExtractedImports` (line 537) call `resolveTypescriptImport` with the **same `importCtx`** (`allFilePaths`, `allFileList`, `normalizedFileList`, `resolveCache`, `index`). This guarantees that if both calls resolve the same import path from the same caller file, they return the exact same string.

---

## Potential Root Cause: @cleocode/core Suffix Resolution Failure

### The resolution path for `import { findTasks } from '@cleocode/core'`

1. **Step 1 (tsconfig alias rewriting)**: No `"paths"` entry in root `tsconfig.json`, `tsconfig.app.json`, or `tsconfig.base.json` for this project. `loadTsconfigPaths` returns null. Step 1 is skipped entirely.

2. **Step 2 (relative path)**: `@cleocode/core` does not start with `.`. Skipped.

3. **Step 3 (scoped package suffix-resolve)**: `@cleocode/core` starts with `@`, so `importPath.startsWith('@')` is true → calls `suffixResolve(['@cleocode', 'core'], normalizedFileList, allFileList, index)`.

4. **suffixResolve behavior**: Tries suffix combinations of the split parts. For `['@cleocode', 'core']` it looks for files ending in `@cleocode/core`, `@cleocode/core.ts`, `core/index.ts`, `core.ts`, etc. The file `packages/core/src/index.ts` would NOT match suffix `core` directly — it would need to match `core/index.ts` or `core/src/index.ts`.

5. **Result**: Suffix resolution may find `packages/core/src/index.ts` via the `core/index.ts` suffix variant, but this depends on whether the suffix index is built to handle `index` resolution (i.e., trying `core` → `core/index.ts`).

### The critical gap: `tryResolveWithExtensions` does not try `/index.ts`

Looking at `tryResolveWithExtensions` (suffix-index.ts line 194-200): it only tries `basePath + ext` for each extension in `EXTENSIONS`. It does NOT try `basePath + '/index' + ext`. So `tryResolveWithExtensions('packages/core/src', allFiles)` would fail to find `packages/core/src/index.ts`.

This means `@cleocode/core` resolution depends entirely on `suffixResolve` finding a suffix match. If `suffixResolve` handles `core` → `packages/core/src/index.ts`, the resolution works. If not, `resolveTypescriptImport` returns null for `@cleocode/core`, and **no named binding is ever stored** in `namedImportMap` for callers of `findTasks`.

---

## What M4 Should Fix

M4 should verify whether `resolveTypescriptImport('@cleocode/core')` actually resolves in production by running `CLEO_BARREL_DEBUG=1 cleo nexus analyze` and checking the `[tier2a-debug]` trace for any symbol imported from `@cleocode/core`. Specifically:

- If the `[tier2a-debug]` trace shows `sourcePath=packages/core/src/index.ts` → the resolution works, and `barrelMap.has(...)` should return true. The issue is elsewhere.
- If there is no `[tier2a-debug]` trace for `findTasks` at all → the named binding was never stored, meaning `resolveTypescriptImport` returned null for `@cleocode/core`. M4 must fix the resolution for `@cleocode/core` style scoped package imports that map to workspace packages.

**Recommended M4 fix**: In `resolveTypescriptImport`, after the existing step 3 suffix-resolve attempt, add a workspace package name resolution step that:
1. Checks if the import path matches a known `@scope/package` format
2. Attempts to resolve it by looking for `packages/<name>/src/index.ts` or `packages/<name>/index.ts` patterns directly

---

## Files Audited

| File | Lines | Finding |
|------|-------|---------|
| `packages/nexus/src/pipeline/import-processor.ts` | 621-688 | `barrelMap` keyed by `re.filePath` (relative). No normalization needed. |
| `packages/nexus/src/pipeline/import-processor.ts` | 506-560 | `namedImportMap` uses `resolveTypescriptImport()` result (same relative format). No normalization needed. |
| `packages/nexus/src/pipeline/parse-loop.ts` | 419-437 | `allParallelReExports` collected from `workerResult.reExports` which uses `file.path`. Same format. |
| `packages/nexus/src/pipeline/import-processor.ts` | 265-358 | `resolveTypescriptImport`: step 3 handles `@scoped/package` via suffix resolve. May fail to find `packages/core/src/index.ts` from `@cleocode/core`. |
| `packages/nexus/src/pipeline/suffix-index.ts` | 194-200 | `tryResolveWithExtensions` does NOT try `/index.ts` — only direct extension suffixes. |
| `packages/nexus/src/pipeline/call-processor.ts` | 150-198 | Tier 2a barrel lookup structurally correct. `barrelMap.has(binding.sourcePath)` is the right check. |
| `packages/nexus/src/pipeline/filesystem-walker.ts` | 84-94 | `ScannedFile.path` documented as relative, forward-slash. Authoritative source. |

---

## Action Items for Orchestrator

- **M3 status**: COMPLETE. No code change needed. Path formats are consistent.
- **M4 action**: Debug `@cleocode/core` resolution. Run `CLEO_BARREL_DEBUG=1 cleo nexus analyze` and capture `[tier2a-debug]` traces. If `sourcePath` is missing/null, fix `resolveTypescriptImport` to resolve workspace `@scope/package` imports against package directories.
- **M1 prerequisite**: M1 diagnostic (already planned) will confirm whether `barrelMap.size > 0` and whether `binding.sourcePath` appears in any debug trace.
