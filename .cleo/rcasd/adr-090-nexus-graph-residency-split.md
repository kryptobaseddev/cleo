# ADR-090 — Nexus code-graph table residency: global→project scope split

**Status:** Proposed
**Date:** 2026-06-01
**Epic:** T11535 (EP-SCOPING-OPTIMIZATION) | **Saga:** T11242 (SG-DB-SUBSTRATE-V2)
**Task:** T11537 | **Supersedes (in part):** ADR-072 (nexus DB split destination), ADR-036 (nexus global-only assertion, for the 4 graph tables only)
**Decision class:** reversible (rollback path defined), gated on the exodus zero-loss proof (now satisfied).

---

## 1. Context

The legacy `nexus.db` (global, under `getCleoHome()`) conflates two data categories:

- **Category A — per-project code/knowledge graph:** `nexus_nodes`, `nexus_relations`, `nexus_contracts`, `nexus_code_index`. Each row belongs to exactly one project; each table carries a `project_id text NOT NULL` soft FK to `nexus_project_registry`.
- **Category B — cross-project registry/identity:** `nexus_project_registry`, `nexus_project_id_aliases`, `nexus_audit_log`, `nexus_schema_meta`, `nexus_user_profile`, `nexus_sigils`. Genuinely global.

The T11536 query-site inventory (`cleo docs fetch nexus-category-a-query-site-inventory`) confirms:

1. Explicit project-scoped sites (`packages/core/src/nexus/nexus-bridge.ts`, `impact.ts`) always filter `WHERE project_id = ?`.
2. A large set of read/write sites (`nexus/living-brain.ts`, `memory/nexus-plasticity.ts`, `nexus/query-dsl.ts`, `nexus/wiki-index.ts`, Studio routes) issue **unfiltered** full-table scans/updates. Under the current GLOBAL merged DB these return/modify **all projects' graph data at once** — a latent multi-project contamination bug. `nexus-plasticity.ts` explicitly documents that it "spans all projects in a machine."
3. Because the graph lives in global `nexus.db` and NOT in `<projectRoot>/.cleo/`, moving a project to another machine **loses its code-intelligence graph**.

This blocks the north-star goal: `.cleo/` as a portable, pluggable living brain.

## 2. Decision

### 2.1 Category A → PROJECT scope

The four code-graph tables MUST reside in the consolidated PROJECT database `<projectRoot>/.cleo/cleo.db`, authored in a new schema module `packages/core/src/store/schema/cleo-project/nexus-graph.ts` (implementation = T11538):

- `nexus_nodes`
- `nexus_relations`
- `nexus_contracts`
- `nexus_code_index`

The `project_id` column MUST be **dropped** from all four tables — scope is implicit by which project's `.cleo/cleo.db` is open. All `idx_*_project*` composite indexes that lead with `project_id` MUST be dropped or rewritten to drop the now-constant leading column (e.g. `idx_nexus_nodes_project_kind(project_id, kind)` → `idx_nexus_nodes_kind(kind)`). Intra-graph soft FKs (`nexus_relations.{source_id,target_id}` → `nexus_nodes.id`, `nexus_nodes.parent_id`, `nexus_nodes.community_id`, `nexus_contracts.{source_symbol_id,route_node_id}`) are intra-scope and MUST be preserved unchanged.

The four tables MUST be **removed** from the GLOBAL schema (`packages/core/src/store/schema/cleo-global/nexus.ts`), reducing the nexus global table count from 10 → 6 (implementation = T11539).

### 2.2 Category B → GLOBAL scope (unchanged)

These six tables MUST remain in GLOBAL `cleo.db` (`cleo-global/nexus.ts`):

`nexus_project_registry` · `nexus_project_id_aliases` · `nexus_audit_log` · `nexus_schema_meta` · `nexus_user_profile` · `nexus_sigils`.

### 2.3 `telemetry_events` + `telemetry_schema_meta` → GLOBAL (deferred)

These currently live in PROJECT scope (`cleo-project/telemetry.ts`) but are machine-wide command telemetry and SHOULD move to GLOBAL scope. This ADR records the intent; the implementation is **deferred to T11540** and is out of scope for T11538/T11539.

### 2.4 Accessor consequences

The live accessor (`packages/core/src/store/nexus-sqlite.ts`, `getNexusDb()` / `getNexusDbPath()`) currently hard-asserts a global-only home per ADR-036. For the four graph tables this assertion MUST be superseded: graph reads/writes MUST resolve the project's `.cleo/cleo.db` (via the `openDualScopeDb` pattern, T11516), while registry/identity reads continue to use the global handle. The previously-unfiltered scan sites become correct as-is (single project per DB); the explicit `WHERE project_id = ?` sites MUST drop that predicate. Accessor migration is owned by E6 (T11249) and the implement tasks (T11538/T11539) — this ADR is design-only and makes **no code changes**.

## 3. Migration / cutover (forward-only, 100% integrity)

The graph move rides the exodus cutover machinery, gated on the **exodus zero-loss proof (now satisfied; see brain observation "EXODUS COMPLETE: ZERO genuine data loss PROVEN").**

1. **Extract-by-project:** for each `project_registry` row, copy `SELECT * ... WHERE project_id = ?` from the legacy global `nexus.db` into that project's `.cleo/cleo.db`, dropping the `project_id` column in the target shape. This reuses the proven extraction predicate already present in `packages/core/src/nexus/migrations/M-split-graph.ts` (`INSERT ... SELECT * FROM legacy.<table> WHERE project_id=?`).
2. **Integrity gate (MUST pass before the legacy rows are retired):** run `verifyMigration()` (`packages/core/src/store/exodus/verify-migration.ts`, surfaced as `runExodusVerify`, T11551). It MUST report, per table, matching source/target row counts AND content-hash parity, a clean `PRAGMA foreign_key_check`, and zero enum/type drift. `ok: false` blocks the cutover.
3. **Forward-only:** the move MUST NOT introduce any integrity regression. The legacy global graph tables are retired (dropped) ONLY after `verifyMigration()` returns `ok: true` for every project. No dual-write window is required because graph data is recreatable (see §6).
4. **Rollback:** until the legacy tables are dropped, rollback is a no-op (global tables still present). After drop, rollback = re-run the indexer (`npx gitnexus analyze`) which fully rebuilds the graph from source. ADR-072's `rollbackSplit()` is NOT reused (different destination).

## 4. Portability — the `cleo adopt` contract (reference only; spec = T11541)

A project's `.cleo/cleo.db` is portable iff it embeds no machine-specific absolute paths. Post-split, the graph tables hold only intra-scope soft FKs, so they are move-safe. The remaining coupling is the GLOBAL `nexus_project_registry` entry (`project_path`, `brain_db_path`, `tasks_db_path` — absolute). On a new machine these MUST be re-derived:

- `cleo adopt [--from <path/.cleo/cleo.db>]` MUST detect an existing project `cleo.db`, re-register it in the new machine's global `nexus_project_registry` (re-deriving absolute paths from the discovered `projectPath`), and MUST NOT overwrite project data.

The full algorithm, the absolute-path column census, and the `cleo init` integration are specified in **T11541** — this ADR only fixes the requirement that the graph tables carry no absolute paths and that adoption re-derives registry paths.

## 5. SOLID/DRY groundwork (interface contracts for the implement tasks)

This ADR fixes the **interfaces** for three DRY refactors so the implement tasks have a contract. These are physical-schema-preserving (zero drift) refactors.

### 5.1 `brainMemoryColumns()` — DRY the 14-column brain block (T11542)

The block `{memory_tier, memory_type, verified, valid_at, invalid_at, source_confidence, citation_count, tier_promoted_at, tier_promotion_reason, content_hash, provenance_class, peer_id, peer_scope}` (+ implicit `id`-independent) is duplicated verbatim across `brain_decisions`, `brain_patterns`, `brain_learnings`, `brain_observations` in `packages/core/src/store/schema/cleo-shared/brain.ts`. Extract a column-group factory returning the exact Drizzle column map (same names, types, defaults, enums: `BRAIN_MEMORY_TIERS`, `BRAIN_COGNITIVE_TYPES`, `BRAIN_SOURCE_CONFIDENCE`):

```ts
/** Shared 14-column quality/tier/peer block for brain memory tables.
 *  Spread into the column map of each top-level brain memory table. */
export function brainMemoryColumns(opts?: {
  /** Per-table default for memory_type (decisions='semantic', patterns='procedural'). */
  defaultMemoryType?: BrainCognitiveType;
}): {
  memoryTier: SQLiteColumnBuilder; memoryType: SQLiteColumnBuilder;
  verified: SQLiteColumnBuilder; validAt: SQLiteColumnBuilder; invalidAt: SQLiteColumnBuilder;
  sourceConfidence: SQLiteColumnBuilder; citationCount: SQLiteColumnBuilder;
  tierPromotedAt: SQLiteColumnBuilder; tierPromotionReason: SQLiteColumnBuilder;
  contentHash: SQLiteColumnBuilder; provenanceClass: SQLiteColumnBuilder;
  peerId: SQLiteColumnBuilder; peerScope: SQLiteColumnBuilder;
};
```

Acceptance: the four tables spread `...brainMemoryColumns({...})`; `drizzle-kit` diff against the pre-refactor snapshot MUST be empty (zero physical drift). Per-table-specific indexes (`idx_brain_<t>_tier`, etc.) stay at the table site.

### 5.2 `makeSchemaMetaTable()` — DRY the identical `*_schema_meta` KV tables (T11543)

`tasks_schema_meta`, `nexus_schema_meta`, `brain_schema_meta` are byte-identical `{ key text PRIMARY KEY, value text NOT NULL }`. Provide a factory:

```ts
/** Factory for the canonical schema-version KV table.
 *  @param tableName fully-qualified physical name, e.g. 'nexus_schema_meta'. */
export function makeSchemaMetaTable(tableName: string): SQLiteTableWithColumns</* {
  key: text PK; value: text NOT NULL
} */>;
```

Usage: `export const nexusSchemaMeta = makeSchemaMetaTable('nexus_schema_meta');`. Acceptance: zero physical drift; applied to all three (and any future) schema-meta tables.

### 5.3 `nexus_relation_weights` — partition the Hebbian hot path (T11545)

`nexus_relations` carries write-heavy plasticity columns (`weight real DEFAULT 0`, `last_accessed_at text`, `co_accessed_count int DEFAULT 0`) alongside the read-mostly structural graph columns. Partition them into a sibling table to reduce hot-row width on structural queries:

```ts
/** Plasticity weights for nexus_relations edges (Hebbian co-access, T998).
 *  1:1 with nexus_relations.id. Lives in PROJECT scope (cleo-project/nexus-graph.ts). */
export const nexusRelationWeights = sqliteTable('nexus_relation_weights', {
  /** Soft FK → nexus_relations.id (intra-scope). PK. */
  relationId: text('relation_id').primaryKey(),
  weight: real('weight').notNull().default(0.0),
  lastAccessedAt: text('last_accessed_at'),
  coAccessedCount: integer('co_accessed_count').notNull().default(0),
});
```

Accessor impact: `nexus-plasticity.ts` (`UPDATE nexus_relations SET weight=...`) and `plasticity-queries.ts` JOINs MUST target `nexus_relation_weights` (LEFT JOIN on `relation_id`); `top-entries`/`augment` weight aggregates follow. This is an implement-task concern (T11545) but the table contract is fixed here. NOTE: this table lives in the PROJECT-scope `nexus-graph.ts` module (it partitions a Category-A table) — it MUST move with `nexus_relations`.

## 6. Dual-cleo.db mapping

This split is the nexus instance of the SG-DB-SUBSTRATE-V2 dual-`cleo.db` model:

| Scope | File | Nexus tables |
|-------|------|--------------|
| PROJECT | `<projectRoot>/.cleo/cleo.db` | `nexus_nodes`, `nexus_relations`, `nexus_contracts`, `nexus_code_index`, `nexus_relation_weights` |
| GLOBAL | `$XDG_DATA_HOME/cleo/cleo.db` | `nexus_project_registry`, `nexus_project_id_aliases`, `nexus_audit_log`, `nexus_schema_meta`, `nexus_user_profile`, `nexus_sigils` |

A cross-project consumer (e.g. Studio `scope=all` search, `studio/src/routes/api/search/+server.ts`) MUST iterate `project_registry` and fan out across each project's `.cleo/cleo.db` rather than scanning one merged table. This is an accessor concern, flagged for T11538/E6.

## 7. Risk / rollback

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Data loss during extract | low | `verifyMigration()` count+hash+FK gate blocks cutover; legacy tables retained until `ok:true` |
| Cross-project consumer breaks (Studio `scope=all`) | medium | Identified in inventory; accessor fan-out required in T11538/E6 before legacy drop |
| Accessor still opens global handle for graph | medium | Supersede ADR-036 assertion for the 4 tables; route through `openDualScopeDb` (T11516) |
| Plasticity writers silently no-op | low | `nexus_relation_weights` JOIN rewrite covered by T11545; graph rebuildable via `gitnexus analyze` |
| `project_id`-leading index loss degrades queries | low | Replace with non-leading-`project_id` indexes (§2.1); single-project DBs are smaller so scans cheaper |

**Rollback:** before legacy-table drop = no-op. After drop = `npx gitnexus analyze` rebuilds the graph from source (graph is derived, not authoritative).

## 8. Consequences

- `.cleo/cleo.db` becomes the complete portable project brain (tasks + memory + conduit + docs + code-graph).
- Per-project graph queries drop the multi-project `WHERE project_id` scan; unfiltered scans become correct.
- The redundant `project_id` column + its indexes are removed from 4 tables.
- ADR-072's per-project `nexus-graph/<id>.db` global sidecar destination is superseded; its extraction logic is reused.
- signaldock is unaffected (LIVE-WIRED, correctly GLOBAL; only legacy table-name updates pending under E6/T11249).

## 9. Blocking notes for the implement wave (T11538/T11539)

- **Accessor cross-project fan-out (Studio `scope=all`, `api/search`)** is the one place that legitimately reads many projects' graphs — it MUST be converted to iterate `project_registry` + open each `.cleo/cleo.db` BEFORE the global graph tables are dropped, or `scope=all` search breaks.
- **`getNexusDbPath()` ADR-036 hard-assert** throws if a graph DB resolves outside global home — T11538 MUST relax this for the 4 graph tables (route via `openDualScopeDb`).
- **`nexus_relation_weights` (T11545) MUST land with the move**, not after, or the plasticity writers target a dropped column.
- **No code changes were made in this ADR (T11537 AC4).**
