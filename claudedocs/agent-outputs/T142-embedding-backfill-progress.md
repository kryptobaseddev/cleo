# T142: Embedding Backfill with Progress Reporting

**Status**: complete
**Epic**: T134 (Brain Memory Automation)
**Date**: 2026-03-23

## Summary

Enhanced `populateEmbeddings()` with an `onProgress` callback and an `errors` result field, then wired the function to the existing `cleo backfill` command via a new `--embeddings` flag.

## Changes

### 1. `packages/core/src/memory/brain-retrieval.ts`

- Added `errors: number` field to `PopulateEmbeddingsResult` (previously only had `processed` and `skipped`).
- Added new exported `PopulateEmbeddingsOptions` interface with:
  - `batchSize?: number` — existing option, now part of the named interface
  - `onProgress?: (current: number, total: number) => void` — new callback
- Updated `populateEmbeddings()` signature to accept `PopulateEmbeddingsOptions`.
- Catch blocks now increment `errors` counter instead of `skipped` for actual exceptions (distinguishes "provider returned null/unavailable" from "embed threw an error").
- `onProgress` is called after each observation is attempted (processed, skipped, or errored).

### 2. `packages/core/src/index.ts`

- Added `populateEmbeddings` to the named function export.
- Added `export type { PopulateEmbeddingsOptions, PopulateEmbeddingsResult }`.

### 3. `packages/core/src/internal.ts`

- Added `populateEmbeddings` and its type exports from `brain-retrieval.js` so the CLI can import via `@cleocode/core/internal`.

### 4. `packages/cleo/src/cli/commands/backfill.ts`

- Added `--embeddings` flag to the existing `cleo backfill` command.
- When `--embeddings` is passed:
  - Calls `populateEmbeddings()` with an `onProgress` handler.
  - TTY: overwrites the current line (`\x1b[2K\r`) for smooth inline progress.
  - Non-TTY: prints `Embedding N/total...` lines (avoids escape codes in pipes/CI).
  - On zero observations: prints informational message and exits cleanly.
  - On success: prints `Processed N, skipped N, errors N` summary.
- Default (no `--embeddings`): existing task AC/verification backfill behavior is unchanged.

### 5. `packages/contracts/src/config.ts` (build fix)

- Added `BrainMemoryBridgeConfig` and `BrainConfig` interfaces to contracts.
- Added optional `brain?: BrainConfig` to `CleoConfig`.
- Fixes pre-existing build breakage introduced by T138 (`memory-bridge-refresh.ts` accessed `config.brain?.memoryBridge?.autoRefresh` which had no type).

### 6. `packages/contracts/src/index.ts`

- Exported `BrainConfig` and `BrainMemoryBridgeConfig` from the contracts barrel.

## Quality Gates

- `pnpm biome check --write` — passed (fixed formatting in 3 files)
- `pnpm run build` — passed (build was broken before due to T138; fixed via contracts addition)
- Memory module tests: 253/253 passed
- Full test suite: 25 pre-existing failures unchanged (external_task_links migration issue + admin.test.ts smoke op count)

## CLI Usage

```
# Backfill embeddings for brain observations
cleo backfill --embeddings

# Output when running (TTY):
Embedding 45/100...
Processed 100, skipped 0, errors 0

# Output when no provider is available:
No observations to embed (provider unavailable or nothing to backfill).
```
