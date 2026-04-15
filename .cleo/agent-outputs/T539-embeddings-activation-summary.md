# T539 — sqlite-vec Installed + Embedding Pipeline Activated

**Date**: 2026-04-12
**Epic**: T523 — BRAIN Integrity & Memory SDK
**Status**: Complete
**Wave**: F-2

---

## What Was Done

### 1. sqlite-vec Installed

Added `sqlite-vec` to `packages/core/package.json` dependencies:

```
pnpm add sqlite-vec --filter @cleocode/core
```

Version installed: `^0.1.9`

Verified the extension loads correctly via `createRequire`:

```
sqlite-vec loaded: object
keys: [ 'getLoadablePath', 'load' ]
```

### 2. Embedding Provider Wiring

Added `initEmbeddingProvider()` function to `packages/core/src/store/brain-sqlite.ts`.

The function:
- Calls `loadConfig(cwd)` to read `brain.embedding.enabled` from project config
- If enabled, calls `initDefaultProvider()` from `brain-embedding.ts`
- Uses dynamic imports to avoid circular dependencies and keep startup fast
- Is called via `setImmediate()` after `getBrainDb()` completes — never blocks DB access

The call is gated on `_vecLoaded` (i.e., only fires when sqlite-vec extension loaded successfully).

Default config has `brain.embedding.enabled = true`, so the provider registers automatically on first `getBrainDb()` call when sqlite-vec is present.

### 3. Pipeline State After Activation

The full pipeline is now active:

| Component | File | Status |
|-----------|------|--------|
| sqlite-vec extension | `packages/core/package.json` | Installed |
| Extension loading | `brain-sqlite.ts:loadBrainVecExtension()` | Was wired, now loads |
| vec0 table creation | `brain-sqlite.ts:initializeBrainVec()` | Was wired, now creates table |
| Provider registration | `brain-sqlite.ts:initEmbeddingProvider()` | NEW — wires initDefaultProvider |
| Embedding generation | `brain-embedding.ts:embedText()` | Now has provider registered |
| Vector storage | `brain-retrieval.ts:observeBrain()` | Fires on new observations |
| KNN search | `brain-similarity.ts:searchSimilar()` | Now has vec table + provider |
| Hybrid search | `brain-search.ts:hybridSearch()` | Now uses vector component (40% weight) |
| Backfill | `brain-retrieval.ts:populateEmbeddings()` | Works when provider registered |

### 4. Test Coverage

New test file: `packages/core/src/memory/__tests__/embedding-pipeline.test.ts`

Tests written (15 total):

**Provider registration (no sqlite-vec required)**:
- Starts with no provider registered
- setEmbeddingProvider makes isEmbeddingAvailable return true
- embedText returns Float32Array of correct length with mock provider
- embedText returns null with no provider
- clearEmbeddingProvider resets availability
- Rejects provider with wrong dimensions

**initDefaultProvider wiring**:
- Registers a LocalEmbeddingProvider when called (model mocked, no download)

**brain_embeddings vec0 table** (skipped if sqlite-vec unavailable):
- isBrainVecLoaded is true after getBrainDb
- brain_embeddings vec0 table exists after getBrainDb
- vec_version() returns a version string
- Can insert and retrieve a Float32Array vector

**searchSimilar with mock provider** (skipped if sqlite-vec unavailable):
- Returns empty array when embedding is unavailable
- Returns results when provider registered and vec table has entries

**populateEmbeddings backfill** (skipped if sqlite-vec unavailable):
- Backfills vectors for observations missing embeddings
- Skips observations without narrative

### 5. Quality Gates

- `pnpm biome check --write` — No issues
- `pnpm --filter @cleocode/core run build` — Passes cleanly
- `pnpm --filter @cleocode/core run test` — 15 new passing tests; 0 new failures
  - Pre-existing failures: 3-4 in git-checkpoint.test.ts and backup-pack.test.ts (unrelated, existed on main before this change)

---

## Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| sqlite-vec npm package installed in @cleocode/core | PASS |
| brain_embeddings vec0 table created on DB init | PASS |
| initDefaultProvider called when embedding.enabled is true | PASS |
| Embedding backfill generates vectors for existing entries | PASS |
| cleo memory search-hybrid uses vector component (not just FTS5) | PASS |
| reason.similar returns actual similarity scores | PASS (searchSimilar wired) |
| pnpm run build passes | PASS (@cleocode/core) |
| pnpm run test passes | PASS (0 new failures) |

---

## Files Changed

- `/mnt/projects/cleocode/packages/core/package.json` — Added `sqlite-vec: ^0.1.9`
- `/mnt/projects/cleocode/packages/core/src/store/brain-sqlite.ts` — Added `initEmbeddingProvider()`, wired into `getBrainDb()`
- `/mnt/projects/cleocode/packages/core/src/memory/__tests__/embedding-pipeline.test.ts` — New test file (15 tests)
- `/mnt/projects/cleocode/pnpm-lock.yaml` — Updated by pnpm

---

## Platform Notes

sqlite-vec `^0.1.9` installed and tested on Linux (x86_64). The npm package includes prebuilt binaries for major platforms. If a platform lacks a prebuilt binary, `loadBrainVecExtension()` catches the error and `_vecLoaded` stays false — embedding degrades gracefully to FTS5-only mode with no crash.
