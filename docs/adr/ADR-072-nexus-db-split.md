# ADR-072: Nexus DB Topology Split — nexus-registry.db + nexus-graph/<projectId>.db

**Status**: Proposed  
**Date**: 2026-05-12  
**Task**: T9150 (W6 — Nexus Restructure Release 2)  
**Supersedes**: none (extends existing nexus.db design)

---

## Context

The current `nexus.db` is a single SQLite file that holds:
- `project_registry` — global registry of all known projects (~80K rows after pollution)
- `nexus_nodes` — per-project graph nodes (millions of rows across all projects)
- `nexus_relations` — per-project graph edges
- `user_profile`, `sigils`, audit tables

This topology causes three documented problems:

1. **WAL contention**: An `analyze` run on project A holds a WAL write lock that blocks any read of project B from completing. Teams with 10+ concurrent agents (cleo-prime + parallel workers) see regular timeout cascades.

2. **Registry walk cost**: `cleo nexus list` must open the multi-GB `nexus.db` file to read 80K registry rows. A 14x latency regression vs the expected 200-row case.

3. **Cross-project leak risk**: A corrupted `nexus_nodes` batch write from a misbehaving agent can corrupt the WAL and break the entire registry. One write path touches all projects.

---

## Decision

Split `nexus.db` into two file families:

### A. `nexus-registry.db` (global, single file)

Contains: `project_registry`, `project_id_aliases`, `nexus_audit_log`, `nexus_schema_meta`, `user_profile`, `sigils`.

- Small (< 1 MB for 10K projects, no graph data).
- Opened once per CLI invocation via a read-ahead shared handle.
- Write lock is held only during `register` / `unregister` / `permission.set`.

### B. `nexus-graph/<projectId>.db` (per-project, one file per project)

Contains: `nexus_nodes`, `nexus_relations`, `nexus_contracts`, and per-project audit rows.

- Each project gets its own isolated SQLite file.
- Analyze runs on project A cannot WAL-block reads of project B.
- A corrupted project file is isolated — recovery is `rm nexus-graph/<id>.db && cleo nexus analyze`.

---

## Rationale

- **Independent WAL files**: SQLite WAL is per-file. Two separate files = two independent WAL journals. Concurrent reads + writes on separate projects incur zero cross-project contention.
- **Registry-walk latency**: `cleo nexus list` now opens a ~500 KB file instead of a potentially multi-GB file. Expected 10–100x latency improvement.
- **Failure isolation**: A corrupted per-project DB can be deleted and re-analyzed without losing any registry state.
- **Migration safety**: The old `nexus.db` is renamed to `nexus.db.legacy.<ts>` (not deleted) during migration. Rollback re-merges the legacy file.

---

## Irreversibility Profile

| Axis | Classification |
|------|---------------|
| Rollback window | 90 days (legacy file retained) |
| Data loss risk | None (legacy file kept as backup) |
| Breaking change | CLI behavior unchanged; dispatch layer is updated |
| Deployment risk | Low — migration is idempotent; reads before migration still work |

The split is **reversible within the rollback window** via `--rollback` flag. After 90 days the legacy file may be garbage-collected.

---

## Locking Protocol for Hybrid Ops

Hybrid ops (e.g. `transfer`, `contracts-link-tasks`, `transfer-preview`) touch both the registry and one or more project graphs. To prevent deadlock with concurrent operations:

**Canonical lock acquisition order**: `registry → graph(min-id) → graph(max-id)`

Where `min-id` and `max-id` are determined by lexicographic ordering of the projectId strings. This total ordering guarantees no cycle can form in the wait-for graph.

Implementation: use SQLite `BEGIN IMMEDIATE` on the registry DB first, then `BEGIN IMMEDIATE` on each graph DB in sorted order.

---

## Handle-Pool LRU

Cross-project queries (`cleo nexus impact-full`, `cleo nexus transfer`) open multiple per-project DB handles. A naive implementation opens O(n) handles for n projects.

**Solution**: `packages/core/src/nexus/store.ts` maintains a **soft-cap LRU pool of 32 Database handles**. When a 33rd handle is requested, the least-recently-used handle is closed first. This bounds file descriptor consumption to 33 (32 graph + 1 registry) regardless of project count.

---

## Migration Steps (implemented in `M-split-graph.ts`)

1. Open `nexus.db` read-only (no WAL contention during reads).
2. Create `nexus-registry.db` and copy registry tables via `ATTACH … INSERT … SELECT`.
3. For each `project_id` in `project_registry`: create `nexus-graph/<projectId>.db` and copy `nexus_nodes` + `nexus_relations` + `nexus_contracts` for that project.
4. Rename `nexus.db` → `nexus.db.legacy.<ts>`.
5. Write `nexus-version.json` with `{topology: "split", migratedAt: "<iso>"}`.

The migration is idempotent: if `nexus-version.json` already shows `topology: "split"`, it is a no-op.

---

## Rollback

`--rollback` flag re-merges:
1. `ATTACH nexus.db.legacy.<ts>` and confirm schema version compatibility.
2. `INSERT OR REPLACE` all tables from registry.db and each graph/*.db back into the legacy file.
3. Delete `nexus-registry.db` and `nexus-graph/`.
4. Update `nexus-version.json` to `{topology: "legacy"}`.

---

## Consequences

- **Positive**: Eliminates WAL contention, reduces list latency by 10x+, isolates per-project failures.
- **Negative**: Path changes require updating `getNexusDb()` / `getNexusRegistryDb()` call sites. Code that assumed one DB handle for all tables must be updated.
- **Neutral**: No user-facing CLI changes. `cleo nexus list`, `cleo graph context`, etc. are unaffected — the dispatch layer absorbs the path change.
