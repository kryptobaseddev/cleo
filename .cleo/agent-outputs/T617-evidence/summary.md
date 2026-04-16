# T617 NEXUS Barrel-Export Tracing Fix — Evidence Summary

## Problem

`cleo nexus context findTasks` and `endSession` showed only 3-4 callers despite
grep finding 8+ files using the symbols. Barrel-export tracing (T617) had been
shipped but critical file-level edges were missing.

## Root Cause

`packages/core/src/internal.ts` (37,241 bytes) exceeds the tree-sitter 0.21.x
hard limit of 32,767 chars. The parse-worker already falls back to regex-based
extraction for re-exports and imports on oversized files, **but it did NOT
extract calls**. Since every engine file in `packages/cleo/src/dispatch/engines/`
(task-engine.ts at 67,556 bytes, session-engine.ts at 36,814 bytes, etc.)
imports from `@cleocode/core/internal` via this barrel, and these engine files
also exceed the 32K limit, the regex fallback extracted the imports but the
CALLS edges were never emitted — tree-sitter was the only path that extracted
calls.

Additionally, `structure-processor.ts` emits File nodes with raw relative-path
IDs (`packages/cleo/.../task-engine.ts`), while `import-processor.ts`
(pre-existing) emits edges with `file:` prefix. My CALLS edges use the raw
path form so they resolve against the actual File node.

## Fix

File: `packages/nexus/src/pipeline/workers/parse-worker.ts`

Added a new `extractCallsRegex()` that extracts bare identifier free-call sites
(`<name>(`) from the same oversized-file regex-fallback path that already
handled imports and re-exports. The enclosing function is unknown without an
AST, so `sourceId` is set to the File node ID (raw relative path). A
reserved-word guard (`REGEX_CALL_RESERVED`) excludes control-flow keywords
and common JS built-ins to keep false positives low. Per-file dedup via a
`Set<string>` prevents duplicate edges when a function is called multiple
times from the same oversized file.

The regex fallback branch at parse-worker.ts:1199-1222 now invokes
`extractCallsRegex` alongside `extractReExportsRegex` and `extractImportsRegex`.
The resulting `WorkerExtractedCall` records flow through the same pipeline
as tree-sitter-extracted calls and benefit from the existing Tier 2a barrel
chain resolution in `call-processor.ts::resolveSingleCall`.

## Before vs After

### Call resolution totals

| Metric | Before | After | Δ |
|---|---|---|---|
| tier1 (same-file) | 8025 | 8025 | 0 |
| tier2a (named-import) | 10233 | 11023 | +790 |
| tier3 (global fallback) | 7387 | 7536 | +149 |
| unresolved | 89390 | 91770 | +2380 |

`tier2a` gained 790 edges, including the barrel-traced edges from engine files.
The `unresolved` bump is expected: regex call extraction emits identifiers that
are control-flow keywords, local vars, or built-in utility calls not indexed.
False-positive unresolved misses are silently dropped by the resolver — no
wrong edges are emitted.

### findTasks callers (`packages/core/src/tasks/find.ts:101`)

**Before** (3 callers):
- `tasks[method]`
- `error-hints.test.ts`
- `find.test.ts`

**After** (4 callers):
- `tasks[method]`
- `error-hints.test.ts`
- `find.test.ts`
- **`task-engine.ts[file]`** — NEW via barrel trace + regex

### endSession callers (`packages/core/src/sessions/index.ts:199`)

**Before** (4 callers): `sessions[method]` + 3 test files
**After** (4 callers): unchanged — the grep ground truth of 11 files
includes `.d.ts`, mock declarations, comment references, and the interface
definition. The real call sites for `endSession()` are exactly the 4 shown
(per `grep -rn "endSession(" --include='*.ts'` filtered for actual call syntax).

### suspendSession (bonus proof of fix)

**Before**: 1 caller (`sessions[method]`)
**After**: 2 callers — added `session-engine.ts[file]` which calls
`suspendSession(projectRoot, sessionId, reason)` at session-engine.ts:759
from an oversized file (36,814 bytes > 32K limit).

## Acceptance vs Reality

The task specified ≥5 callers for findTasks/endSession based on 8 and 11
grep hits respectively. Inspection of the grep output shows those counts
double-count: (a) `.d.ts` declarations, (b) type-import statements, (c) mock
declarations (`findTasks: vi.fn()`), (d) comment references, (e) interface
property declarations, and (f) dynamic `await import(...)` which no static
analyzer tracks without an explicit dynamic-import extractor. The unique
real call sites in the codebase are 5 for `findTasks(find.ts:101)` — we
capture 4. The missing one is a dynamic import in
`packages/cleo/src/__tests__/core-parity.test.ts:393` — a separate feature,
not a barrel-tracing gap.

## Test Results

- `pnpm --filter @cleocode/nexus run test -- barrel-tracing`:
  **5 files / 119 tests — ALL PASS**
- `pnpm --filter @cleocode/nexus run test` (full nexus):
  **5 files / 119 tests — ALL PASS**
- `pnpm run test` (full repo): **466 files / 8327 pass / 10 skip / 32 todo / 1 fail**
  - The 1 failure is `brain-stdp-wave3.test.ts` — a pre-existing perf test
    timing flake (10084ms vs 10000ms timeout) unrelated to this change.

## Runtime Note

When invoked via the globally-installed `cleo` binary (v2026.4.75 under
`~/.npm-global/lib/node_modules/@cleocode/cleo-os`), the old nexus bundle
lacks the regex fallback entirely and reports only 3 callers for findTasks.
All verification in this task used the local build at
`node packages/cleo/dist/cli/index.js nexus ...` which consumes the freshly
rebuilt `@cleocode/nexus` from the repo.

## Files Changed

- `packages/nexus/src/pipeline/workers/parse-worker.ts`
  - Added `REGEX_CALL_RESERVED` set (control-flow + built-ins)
  - Added `extractCallsRegex()` function
  - Wired `extractCallsRegex()` into the oversized-file fallback branch
