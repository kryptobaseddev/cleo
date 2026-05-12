# V4 Database Integrity Report

**Date**: 2026-04-28  
**Validator**: V4 (db-integrity)  
**Scope**: 5 CLEO databases after 40-commit campaign (v2026.4.149–v2026.4.152)

---

## Overall Status: PARTIAL

All 5 databases are structurally sound and functionally operational. One pre-existing build regression (`openai` bundled into core esbuild output) causes 3 STDP integration tests to fail. This is a build configuration issue, not a database integrity issue.

---

## Per-Database Results

### 1. tasks.db (project)

| Check | Result |
|-------|--------|
| File created on `cleo init` | PASS — 692224 bytes |
| WAL mode | PASS — `journal_mode: wal` |
| WAL sidecar files | INFO — auto-checkpointed (wal_autocheckpoint=1000), no -wal/-shm at rest |
| CRUD: add task T002 | PASS — `{"success":true,"data":{"task":{"id":"T002"...}}}` |
| CRUD: show T002 | PASS — task returned with correct fields |
| CRUD: update description | PASS — `description: "updated"` confirmed via read-back |
| Migration idempotency | PASS — `cleo migrate storage` returns `{"migrations":[]}` (nothing to run) |
| Health check | PASS — `tasks_db: integrity ok`, `2 task(s) present` |

### 2. brain.db (project)

| Check | Result |
|-------|--------|
| File created on `cleo init` | PASS — 724992 bytes |
| WAL mode | PASS — `journal_mode: wal` |
| Schema migrations (ALTER TABLE) | WARN — on startup, 9 `ALTER TABLE` runs add missing columns (`retrieval_order`, `delta_ms`, `stability_score`, `provenance_class`, `times_derived`, `level`, `tree_id`). These are backwards-compatible additive migrations that fire because the global brain.db predates these columns. Self-healing works correctly. |
| memory observe | PASS — `{"id":"O-mohvozwz-0","type":"discovery","createdAt":"2026-04-28 00:19:05"}` |
| memory find (FTS BM25) | PASS — result returned with `bm25Score:1`, `rrfScore:0.0167` |
| memory fetch | PASS — full record returned including `provenanceClass`, `citationCount`, `stabilityScore` |
| memory dream (installed cleo) | PASS with WARN — `success: true`, but Wave 6 dreamer upgrade failed: `no such column: e.observation_id`. This is a schema mismatch between installed cleo v2026.4.147 and the main project brain.db (see note below). Dream cycle still completes successfully. |
| memory dream (repo-local dist) | FAIL — `Dynamic require of "stream" is not supported` (see T682 section) |

**Note on `observation_id` warning**: `sleep-consolidation.ts` queries `brain_embeddings e ON e.observation_id = o.id` but `brain_embeddings` is a `vec0` virtual table (sqlite-vec extension). The installed cleo v2026.4.147 code references this schema path but the `vec0` table schema differs between versions. Dream cycle returns success:true and completes consolidation despite this error.

### 3. conduit.db (project)

| Check | Result |
|-------|--------|
| File created on `cleo init` | PASS — 262144 bytes |
| WAL mode | PASS — `journal_mode: wal` |
| Schema (tables) | PASS — 22 tables including topics, topic_messages, messages, conversations, FTS index |
| `cleo conduit status` | PASS — `{"connected":true,"transport":"local","pollerRunning":false}` |
| Publish to topic | PASS — `{"messageId":"9cdacbc5...","topicName":"smoke-topic","transport":"local"}` |
| Row confirmed in DB | PASS — 1 topic created, 1 topic_message written |

### 4. nexus.db (global — `~/.local/share/cleo/nexus.db`)

| Check | Result |
|-------|--------|
| File exists | PASS — 284098560 bytes |
| WAL mode | PASS — `journal_mode: wal` |
| Active WAL sidecars | PASS — `nexus.db-wal` (416152 bytes) and `nexus.db-shm` (32768 bytes) present (active writes) |
| Tables | PASS — 9 tables: nexus_nodes, nexus_relations, project_registry, sigils, etc. |
| Data counts | PASS — 82453 nodes, 193767 relations |
| Project auto-registration | PASS — `/tmp/db-validation` registered with `health_status:"unknown"` on `cleo init` |
| `cleo nexus status` | INFO — reports "NOT INDEXED" for test project (no `cleo nexus analyze` run, expected) |

**Note**: nexus.db is a global shared database. It stores codebase symbol graphs. The test project was correctly auto-registered during `cleo init`.

### 5. signaldock.db (global — `~/.local/share/cleo/signaldock.db`)

| Check | Result |
|-------|--------|
| File exists | PASS — 286720 bytes |
| WAL mode | PASS — `journal_mode: wal` |
| Tables | PASS — 16 tables including agents, users, organizations, sessions, skills |
| `cleo agent list` | PASS — returns `{"success":true,"data":{"success":true,"data":[]}}` (no crash) |
| Agent records | PASS — 10 agents present in DB (cleo-prime-dev, etc.) |

**Note**: `admin health` reports `signaldock_db: warn — signaldock.db not found` for the test project directory, but this is expected — signaldock.db is global, not per-project. The global path check is the correct one.

---

## WAL Safety (ADR-013 §9)

| Database | WAL Mode | WAL Sidecars at Rest | WAL Auto-Checkpoint |
|----------|----------|---------------------|---------------------|
| tasks.db | wal | None (checkpointed) | 1000 pages |
| brain.db | wal | None (checkpointed) | 1000 pages |
| conduit.db | wal | None (checkpointed) | 1000 pages |
| nexus.db | wal | Active (`-wal`, `-shm` present) | 1000 pages |
| signaldock.db | wal | None (checkpointed) | unknown |

All 5 databases operate in WAL mode. ADR-013 §9 is satisfied. The `.gitignore` correctly prevents tracking `.cleo/tasks.db`, `.cleo/brain.db`, etc.

---

## Migration Status

- `cleo migrate storage` → `{"migrations":[],"dryRun":false}` — all migrations already applied, idempotent
- Brain startup auto-applies 9 additive schema changes via `ALTER TABLE` — self-healing, correct behavior
- `cleo admin health` → `overall: warning` (signaldock.db path check fires for project dir, expected)

---

## Cross-DB Aggregation

- `cleo dash` → PASS — aggregates from tasks.db and brain.db correctly, returns project summary with task counts, high-priority items, active session

---

## Test Results

### store tests (`packages/core/src/store/__tests__/`)
- **63 test files, 887 tests: ALL PASSED**
- Sequence repair warnings are cosmetic (counter repair self-heals)

### memory tests (`packages/core/src/memory/__tests__/`)
- **57 test files, 835 tests: PASSED; 1 skipped**
- **1 file failed: `brain-stdp-functional.test.ts` — 3 tests**

#### T682 STDP Failure Root Cause

The 3 failing tests (`T682-1`, `T682-2`, `T682-3`) invoke `cleo memory dream` via the repo-local esbuild bundle at `packages/cleo/dist/cli/index.js`. That bundle loads `@cleocode/core` externally from `packages/core/dist/index.js` (the esbuild-built standalone bundle).

The esbuild core bundle inlines `openai` (added in T1386 / v2026.4.140) which transitively imports `node-fetch@2.x`. node-fetch@2 uses CJS `require('stream')`. When bundled into an ESM module via esbuild without being marked external, Node.js throws:

```
Error: Dynamic require of "stream" is not supported
```

**Root cause**: `openai` is not in `sharedExternals` in `build.mjs`, causing it to be bundled inline. `node-fetch@2` (an openai dependency) uses `require('stream')` which is incompatible with ESM bundling.

**Impact**: Only the repo-local esbuild bundle (`packages/cleo/dist/cli/index.js`) is affected. The **installed cleo** (v2026.4.147, pre-T1386 in its own bundle) runs `memory dream` successfully. The 5 databases are unaffected. This is a build configuration regression introduced in the T1386 wave, not a database integrity issue.

**Fix path**: Add `'openai'` (and optionally `'@google/generative-ai'`, `'p-retry'`, `'jsonrepair'`) to `sharedExternals` in `build.mjs`.

---

## Issues Found

### Schema Issues
1. **`brain_embeddings` / `observation_id` mismatch** (WARN): Installed cleo v2026.4.147 references `brain_embeddings.observation_id` in `sleep-consolidation.ts` Wave 6 upgrade path, but the live `brain_embeddings` is a `vec0` virtual table. Wave 6 fails with `no such column: e.observation_id` but the error is caught and dream returns `success:true`. **Not a data loss risk; consolidation still completes.**

2. **`nexus_nodes` weight column missing** (INFO): Tests log `no such column: weight` from nexus reconciler. Tests that hit this path handle the error gracefully and still pass.

### Build Issues
3. **`openai` not externalized** (FAIL for T682): `openai` and its CJS dependency `node-fetch@2` are bundled into the esbuild core output. This crashes the repo-local CLI with `Dynamic require of stream`. The published/installed CLI uses a separate bundle that doesn't have this issue.

---

## Cleanup

Test directory `/tmp/db-validation` retained for forensics (no data sensitivity, but useful for post-hoc debugging of brain.db migration warnings).

---

## Verdict

**V4 PARTIAL** — All 5 databases are operational with correct WAL mode, migrations apply cleanly, CRUD works for all databases, 63 store test files pass (887 tests). 3 STDP integration tests fail due to a build configuration regression (`openai` bundled into ESM without `require()` shim) introduced by T1386 PSYCHE LLM layer, not a database integrity issue.
