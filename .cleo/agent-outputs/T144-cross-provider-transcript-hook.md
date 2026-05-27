# T144: Cross-Provider Transcript Hook

**Epic**: T134 (Brain Memory Automation)
**Status**: complete
**Date**: 2026-03-23

## What Was Implemented

### 1. Extended AdapterHookProvider interface (contracts)

File: `packages/contracts/src/hooks.ts`

Added optional `getTranscript?(sessionId: string, projectDir: string): Promise<string | null>` method to `AdapterHookProvider`. The method is optional — adapters that do not support transcript access may omit it.

### 2. Claude Code adapter implementation

File: `packages/adapters/src/providers/claude-code/hooks.ts`

Implemented `getTranscript()` in `ClaudeCodeHookProvider`:
- `projectDirToClaudeHash(projectDir)` — converts an absolute project path to Claude's path-based directory name (e.g. `/mnt/projects/foo` → `-mnt-projects-foo`)
- `findLatestSessionJsonl(projectDir)` — scans `~/.claude/projects/{hash}/` for the most recently modified `.jsonl` file (best-effort match since CLEO session IDs differ from Claude's UUID-based ones)
- `parseJsonlTranscript(jsonlPath)` — extracts `[user]:` and `[assistant]:` text blocks from the JSONL, skipping tool results, file snapshots, thinking blocks, and progress entries
- Returns `null` on any filesystem or parse error

### 3. extractFromTranscript() function (core memory)

File: `packages/core/src/memory/auto-extract.ts`

Added `extractFromTranscript(projectRoot, sessionId, transcript)`:
- Heuristic-based extraction: filters assistant lines containing action words (implemented, fixed, added, refactored, discovered, found, learned, etc.)
- Stores up to 5 learnings per session (capped to avoid brain.db flooding)
- Stores one process decision summarising transcript word count and insight count
- Best-effort: wrapped in try/catch, never throws

### 4. Session-end handler wiring

File: `packages/core/src/hooks/handlers/session-hooks.ts`

In `handleSessionEnd`, after grading and before memory bridge refresh:
1. Loads config via `loadConfig()` and checks `brain.autoCapture`
2. Gets the active adapter via `AdapterManager.getInstance(projectRoot).getActive()`
3. Checks if `adapter.hooks.getTranscript` is a function (optional method guard)
4. Calls `getTranscript(sessionId, projectRoot)` — returns null for adapters without it
5. On non-null result, calls `extractFromTranscript()` for brain ingestion
6. Entire block wrapped in try/catch — logs warning but never blocks session end

## Acceptance Criteria Verification

- [x] `getTranscript` optional method on `AdapterHookProvider` interface
- [x] Session-end handler calls `getTranscript` when available
- [x] Transcript passed to `extractFromTranscript` for brain ingestion
- [x] Claude Code adapter implements `getTranscript` using `~/.claude/projects/`
- [x] Graceful no-op if adapter doesn't implement it (typeof guard)
- [x] TSDoc on all exports
- [x] Build passes (esbuild bundle, no new errors)

## Quality Gates

```
pnpm biome check  — 4 files, no fixes needed
pnpm run build    — Build complete (pre-existing warnings only)
pnpm run test packages/core/src/hooks/ — 37/37 passed
```

Pre-existing test failures (9 files, 25 tests) are unrelated migration/parity/timing issues documented in memory-bridge.md.

## Files Changed

- `packages/contracts/src/hooks.ts` — added `getTranscript?` to interface
- `packages/adapters/src/providers/claude-code/hooks.ts` — implemented `getTranscript`
- `packages/core/src/memory/auto-extract.ts` — added `extractFromTranscript`
- `packages/core/src/hooks/handlers/session-hooks.ts` — wired transcript extraction in `handleSessionEnd`
