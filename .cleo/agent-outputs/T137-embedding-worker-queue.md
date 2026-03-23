# T137 — Embedding Worker Thread for Async Processing

**Epic**: T134 (Brain Memory Automation)
**Status**: complete
**Date**: 2026-03-23

## What was implemented

### New files

**`packages/core/src/memory/embedding-worker.ts`**
- Worker thread script loaded by `new Worker(workerPath)`
- Receives `{ id, text }` messages via `parentPort`
- Calls `getLocalEmbeddingProvider().embed(text)` (lazy import — model loads once per worker lifetime)
- Returns `{ id, embedding: number[] }` on success, `{ id, error: string }` on failure
- Crashes on non-worker entry (guards `parentPort` null check)

**`packages/core/src/memory/embedding-queue.ts`**
- `EmbeddingQueue` class — singleton via `getEmbeddingQueue()`
- `enqueue(observationId, text, onComplete)` — adds item, schedules drain via `setImmediate`
- Drain loop processes up to 10 items (BATCH_SIZE) per cycle, yields 50ms between batches
- Worker path resolved via `import.meta.url` + `existsSync` — graceful null when worker file absent (esbuild bundle context)
- Fallback: `setImmediate` + direct `LocalEmbeddingProvider.embed()` when worker unavailable
- `shutdown()` — flushes queue, terminates worker; idempotent
- `resetEmbeddingQueue()` — for testing only
- Registers `process.exit`, `SIGTERM`, `SIGINT` handlers on first `getEmbeddingQueue()` call

### Modified files

**`packages/core/src/memory/brain-retrieval.ts`**
- Added `import { getEmbeddingQueue } from './embedding-queue.js'`
- Replaced `setImmediate(() => embedText(...))` in `observeBrain()` with `getEmbeddingQueue().enqueue(id, text, callback)`
- `embedText` import retained for `populateEmbeddings()` batch backfill (unchanged)

## Quality gates

- `pnpm biome check --write` — clean (no warnings, no fixes needed on final pass)
- `pnpm run build` — passes (esbuild + tsc declaration emit)

## Design decisions

- **Worker path resolution**: Uses `import.meta.url` + `existsSync` — works in tsc dev (`dist/memory/embedding-worker.js`), gracefully falls back in esbuild bundle context (single `dist/index.js` — worker file not adjacent)
- **Fallback path**: When worker unavailable, uses `setImmediate` + direct `LocalEmbeddingProvider.embed()` — preserves original behavior exactly
- **Callback pattern**: `onComplete` callback passed to `enqueue()` performs the SQLite write — decouples queue from DB internals
- **Float32Array transport**: Serialized as `number[]` across worker boundary (structured clone supports Float32Array natively but `number[]` avoids transferable complexity)
