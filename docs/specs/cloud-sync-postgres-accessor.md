# Cloud Sync: PostgresDataAccessor Architecture Spec

**Status**: SCAFFOLD — interface defined, implementation deferred (T9062 child tasks)
**Task**: T9062
**Epic**: T9048 (DB Charter + DataAccessor Umbrella)
**Dependencies**: T9050 (UmbrellaDataAccessor), ADR-068, ADR-069

---

## 1. Motivation

CLEO is local-first: all data lives in project-scoped SQLite databases
(tasks.db, brain.db, conduit.db, llmtxt.db, telemetry.db). This is ideal
for offline operation, single-developer workflows, and portability.

Multi-developer / multi-machine workflows require a sync layer that:
- Preserves the local-first SQLite experience (no forced connectivity)
- Allows explicit push/pull to a shared Postgres backend
- Enforces per-project data isolation (multi-tenant)
- Aligns with the existing DataAccessor interface contract (T9050)

The key architectural decision established here: **PostgresDataAccessor
implements the same DataAccessor interface as SqliteDataAccessor**. Callers
that accept a `DataAccessor` parameter work with either engine without
modification — proving the T9050 abstraction is engine-neutral.

---

## 2. Multi-Tenant Namespacing

Each CLEO project maps to a **tenant namespace** within a shared Postgres
cluster. Two isolation strategies are supported (selectable per cluster):

### 2.1 Schema Strategy (default)

Each project gets a dedicated Postgres schema:

```
cleo_<projectHash>
  ├── tasks
  ├── task_dependencies
  ├── task_relations
  ├── sessions
  ├── schema_meta
  └── audit_log
```

`projectHash` is the 16-character hex used in worktree directory names
(e.g. `1e3146b7352ba279`), derived deterministically from the project root
path. This ensures stable cross-machine identity without a central registry.

**Isolation**: full schema separation. Cross-tenant access is impossible
at the Postgres schema level.

### 2.2 Row-Level Strategy

All projects share tables; a `project_id` column (= `projectHash`) is added
to every table, and Row Level Security (RLS) policies enforce tenant
boundaries. Simpler schema management; requires careful RLS configuration.

---

## 3. Sync Semantics

### 3.1 Initial Design: Last-Write-Wins (LWW)

- Each table row carries an `updated_at` timestamp.
- On push: local rows with `updated_at > last_push_at` are upserted to Postgres.
- On pull: Postgres rows with `updated_at > last_pull_at` are upserted to SQLite.
- Conflict resolution: higher `updated_at` wins. In case of ties, remote wins
  on pull; local wins on push.

### 3.2 CRDT Merge (opt-in, deferred)

cr-sqlite (T947) provides CRDT-merge semantics for brain.db (cross-device
knowledge sharing). Integration with PostgresDataAccessor is opt-in per
a separate ADR from T947. Not included in the initial implementation.

### 3.3 Sync Commands (implementation deferred)

```
cleo sync push    # Local → Postgres (rows changed since last push)
cleo sync pull    # Postgres → Local (rows changed since last pull)
cleo sync status  # Show divergence: N local changes, M remote changes
```

---

## 4. Auth + Authorization Model

Each tenant is identified by their **SignalDock identity** (Ed25519 keypair,
the same identity used for llmtxt/sdk ContributionReceipt signing).

- Every push batch is signed with the tenant's Ed25519 private key.
- The Postgres server (or a middleware layer) verifies the signature before
  accepting writes. Unsigned pushes are rejected with `401 Unauthorized`.
- Public keys are registered once per tenant in a `cleo_auth.tenants` table
  (or via the SignalDock identity service at signaldock.io).

---

## 5. DataAccessor Engine-Neutral Proof

`SqliteDataAccessor` has `engine: 'sqlite'`.
`PostgresDataAccessor` has `engine: 'postgres'`.

Both satisfy the `DataAccessor` interface contract defined in
`@cleocode/contracts/data-accessor.ts`. Any code that accepts a `DataAccessor`
parameter (e.g. task commands, brain operations) works with either without
modification — this is the T9050 abstraction proof.

```typescript
// This works with both SqliteDataAccessor and PostgresDataAccessor:
async function countTasks(accessor: DataAccessor): Promise<number> {
  return accessor.countTasks();
}
```

---

## 6. Backup Integration

Postgres-side backup integrates with the existing `cleo backup` system
(ADR-013 §9). A `cleo restore` can pull from cloud (Postgres) OR local
snapshot (SQLite WAL backup), with the user choosing the source.

---

## 7. Implementation Roadmap (T9062 child tasks)

The following tasks will be created under T9062 to implement the full spec:

| Wave | Task | Description |
|------|------|-------------|
| 1 | ADR: cloud-sync architecture | Document sync model decision + RLS vs schema choice |
| 1 | Driver + connection pool | postgres.js or pg driver, pool configuration |
| 2 | Schema migration | `CREATE SCHEMA cleo_<projectHash>` + table DDL matching SQLite |
| 2 | PostgresDataAccessor impl | Implement all DataAccessor methods with pg queries |
| 3 | Sync engine | LWW push/pull with `updated_at` change tracking |
| 3 | CLI commands | `cleo sync push/pull/status` |
| 4 | Auth middleware | Ed25519 signature verification for push batches |
| 4 | Integration tests | 2+ tenants in one Postgres instance, no cross-leakage |

---

## 8. Out of Scope

- **Realtime collaboration** (CRDT live editing) — separate project under llmtxt-graph
- **Rust signaldock-storage** Postgres feature — cloud-side counterpart, tracked separately
- **Full CRDT merge** — opt-in per T947 ADR, not in initial implementation
- **SaaS hosted cluster** — operator choice; spec is engine-agnostic

---

*This document is the SCAFFOLD deliverable for T9062. It will be superseded by
the ADR authored in the first implementation wave.*
