# T11536 — Nexus Category-A Query-Site Inventory (RESEARCH)

**Epic:** T11535 EP-SCOPING-OPTIMIZATION | **Saga:** T11242 SG-DB-SUBSTRATE-V2 | **Date:** 2026-06-01

**Verdict:** The thesis is **CONFIRMED**. `nexus_nodes`, `nexus_relations`, `nexus_contracts`, `nexus_code_index` are per-project code-graph tables that currently live in the **GLOBAL** `nexus.db`. Every structural write/read carries (or implicitly assumes) a single project's `project_id`. Moving them to **PROJECT** scope (`<projectRoot>/.cleo/cleo.db`) and dropping the `project_id` column is correct.

---

## §1 — Inventory Table (table → defining file → query-sites → scope)

### `nexus_nodes`

- **Schema (target/consolidated):** `packages/core/src/store/schema/cleo-global/nexus.ts:338` — `projectId: text('project_id').notNull()` + indexes `idx_nexus_nodes_project`, `idx_nexus_nodes_project_kind`, `idx_nexus_nodes_project_file`.
- **Schema (legacy):** `packages/core/src/store/schema/nexus-schema.ts:217` (same columns).
- **DDL/runtime accessor:** `packages/core/src/store/nexus-sqlite.ts` (FTS5 triggers `nexus_nodes_fts_*`, backfill, table creation).
- **Pipeline writer:** `packages/nexus/src/pipeline/knowledge-graph.ts`, `packages/nexus/src/pipeline/index.ts` (Drizzle insert; `projectId` injected from `project_registry.project_id`, `index.ts:503`).
- **Read sites (project-scoped, `WHERE project_id = ?`):** `nexus/nexus-bridge.ts:105/140/200/219`, `nexus/impact.ts:302`.
- **Read sites (UNFILTERED — no project_id predicate):** `nexus/living-brain.ts:185/195/616/1022/...` (`SELECT ... FROM nexus_nodes LIMIT 50000`), `nexus/augment.ts:184/220/253`, `nexus/query-dsl.ts`, `nexus/wiki-index.ts`, `nexus/tasks-bridge.ts`, `nexus/api-extractors/topic-extractor.ts`, `memory/graph-memory-bridge.ts:255/353/423/516/620/976/1071/1342`, `sentient/ingesters/nexus-ingester.ts`, `tasks/nexus-impact-gate.ts:99`.
- **Studio consumers:** `studio/src/routes/api/nexus/*`, `api/search/+server.ts` (cross-project `scope=all` search), `api/health`, `+page.server.ts`, `lib/graph/adapters/nexus-adapter.ts`.
- **Current scope:** GLOBAL. **Target scope:** PROJECT.

### `nexus_relations`

- **Schema (target):** `cleo-global/nexus.ts:443` — `projectId: text('project_id').notNull()` + `idx_nexus_relations_project`, `idx_nexus_relations_project_type`. Hot-path plasticity columns on this table: `weight` (464), `last_accessed_at` (466), `co_accessed_count` (468).
- **Schema (legacy):** `nexus-schema.ts:360`.
- **Read/write sites (project-scoped):** `nexus-bridge.ts:178-181` (`AND r.project_id = ?`), `impact.ts:343`.
- **Plasticity writers (UNFILTERED — operate on whole global DB):** `memory/nexus-plasticity.ts:117/220` (`UPDATE nexus_relations SET weight=...`), `nexus/plasticity-queries.ts:146/183/231`, `nexus/query-dsl.ts:33/59-95`, `brain-lifecycle.ts` Step 6b/6c. `nexus-plasticity.ts:163` explicitly documents: *"Operates on the GLOBAL nexus.db ... spans all projects in a machine."*
- **Read sites (UNFILTERED):** `living-brain.ts:210/238/265/290/629/1035`, `augment.ts:182`, `wiki-index.ts:466`, `nexus-ingester.ts`, `studio/*`.
- **Current scope:** GLOBAL. **Target scope:** PROJECT.

### `nexus_contracts`

- **Schema (target):** `cleo-global/nexus.ts:500` — `projectId: text('project_id').notNull()` + `idx_nexus_contracts_project`, `idx_nexus_contracts_project_type`.
- **DDL/index creation:** `nexus-sqlite.ts:358-406` — `CREATE INDEX idx_nexus_contracts_project ON nexus_contracts(project_id)` and `idx_nexus_contracts_project_type ON nexus_contracts(project_id, type)`.
- **Writer:** API-contract extraction pipeline (`nexus/api-extractors/*`).
- **Current scope:** GLOBAL. **Target scope:** PROJECT.

### `nexus_code_index`

- **Schema (target):** `cleo-global/nexus.ts:549` — `projectId: text('project_id').notNull()` + `idx_nexus_code_index_project`.
- **Exodus mapping:** `store/exodus/table-name-map.ts:252` — `['code_index', 'nexus_code_index']` (legacy bare `code_index` → prefixed `nexus_code_index`).
- **Writer:** tree-sitter symbol indexer (`packages/nexus/src/pipeline/*`, `language-detection.ts:17`).
- **Current scope:** GLOBAL. **Target scope:** PROJECT.

---

## §2 — AC2 verdict: do all sites filter by `project_id`?

**Nuanced YES.** Two classes of call site exist, and BOTH prove project-scoping:

1. **Explicit `WHERE project_id = ?` sites** (`nexus-bridge.ts`, `impact.ts`, the `M-split-graph.ts` copy `... WHERE project_id=?`) — directly carry the predicate.
2. **Unfiltered full-table scans** (`living-brain.ts` `LIMIT 50000`, all plasticity writers, most of `query-dsl.ts`/`wiki-index.ts`/Studio) — these have **NO** `project_id` predicate. Under the current GLOBAL merged `nexus.db` this is a **latent multi-project contamination bug**: they return symbols/edges from ALL indexed projects mixed together (and plasticity `UPDATE`s touch every project's edges at once). `nexus-plasticity.ts:163` admits this. **Under the proposed PROJECT-scoped `.cleo/cleo.db` these unfiltered queries become naturally and correctly single-project** — the move *fixes* this class of bug rather than just relocating data. The `project_id` column becomes redundant (implicit-by-scope) and is dropped at exodus.

Net: 100% of the structural data is project-owned. The explicit-predicate sites confirm intent; the unfiltered sites confirm the move *improves* correctness.

---

## §3 — Scope confirmations

### KEEP GLOBAL — 6 nexus registry/audit tables (do NOT move)

1. `nexus_project_registry` (`cleo-global/nexus.ts:140`) — the cross-project registry itself.
2. `nexus_project_id_aliases` (`:187`) — legacy → canonical project-ID alias map.
3. `nexus_audit_log` (`:220`) — cross-project operation audit.
4. `nexus_schema_meta` (`:264`) — global-scope schema-version KV.
5. `nexus_user_profile` — global user identity/preference profile.
6. `nexus_sigils` — global agent peer-card registry.

### `telemetry_events` + `telemetry_schema_meta` — currently PROJECT, target GLOBAL

Defined in `packages/core/src/store/schema/cleo-project/telemetry.ts:37/74`. These are machine-wide command-invocation telemetry; the db-inventory assigns them `global` tier. **T11540 moves them OUT of project → global.** (Noted only — not in scope for T11537/T11538/T11539.)

### `skills_skill_usage` — AMBIGUOUS (stays GLOBAL, gets `project_id` column via T11544)

Out of scope for this ADR; noted.

---

## §4 — signaldock wiring audit: **LIVE-WIRED = YES**

signaldock is **actively wired into runtime**, NOT dead. Real callers (non-test, non-dist):

1. **Brain Living-Brain adapter** — `packages/brain/src/adapters/signaldock.ts` `getSignaldockSubstrate()` queries `agents` + `agent_connections`; registered in `adapters/index.ts:41` and in `ALL_SUBSTRATES` (`:30`). Connection: `packages/brain/src/db-connections.ts:139` opens read-only `signaldock.db`.
2. **`cleo init`** — `packages/core/src/init.ts:263` `openCleoDb('signaldock')` writes project-tier agent registrations into the global registry.
3. **`cleo upgrade`** — `packages/core/src/upgrade.ts:865` `ensureGlobalSignaldockDb()`, plus `openCleoDb('signaldock')` at `:978` and `:1207` for seed-agent sync.
4. **Seed install** — `packages/core/src/agents/seed-install.ts:684` `openCleoDb('signaldock')`.
5. **Agent CLI** — `packages/cleo/src/cli/commands/agent.ts:1988/2566/2639` (install/list/remove); `migrate-agents-v2.ts:306`.
6. **Orchestration** — `orchestrate/plan.ts`, `orchestration/validate-spawn.ts`, `registry-resolver.ts`, `classify.ts`, `spawn.ts`, `playbooks/agent-dispatcher.ts` all take a live `signaldock.db` handle for agent resolution.
7. **Accessors** — `store/agent-registry-accessor.ts`, `agent-resolver.ts`, `agent-doctor.ts`, `umbrella-data-accessor.ts:121`.
8. **Studio** — `studio/src/lib/server/db/connections.ts`, `routes/brain/+page.server.ts:146`.

**Scope verdict:** signaldock correctly stays GLOBAL (per ADR-037 / D1; `signaldock-sqlite.ts:56-87` hard-asserts global-only home). The only follow-up is exodus table-name updates (legacy `agents` → `signaldock_agents`) for the brain adapter — tracked under E6 (T11249), not this epic.

---

## §5 — Prior-art that the ADR must reconcile

- **ADR-036** (`nexus-sqlite.ts:49`): `getNexusDbPath()` hard-asserts `nexus.db` is **GLOBAL-only** under `getCleoHome()` and throws on drift. The residency split must explicitly supersede this for the 4 graph tables.
- **ADR-072 / T9150** (`packages/core/src/nexus/migrations/M-split-graph.ts`): an EARLIER split that moves the graph into per-project files `nexus-graph/<projectId>.db` under the **global** cleo home (NOT into `.cleo/cleo.db`). It is a separate (likely unwired) migration; the live `getNexusDb()` still opens the single global `nexus.db`. The new ADR **supersedes ADR-072's destination** — graph data moves into the project's portable `.cleo/cleo.db`, not a global sidecar. `M-split-graph.ts`'s `WHERE project_id=?` copy logic is reusable extraction scaffolding.

## §6 — Integrity gate available

`verifyMigration()` (`packages/core/src/store/exodus/verify-migration.ts`, surfaced via `runExodusVerify`, T11551 DHQ-045) is the reusable CORE parity primitive: per-table source/target row-count + content-hash parity, `PRAGMA foreign_key_check`, and enum-drift detection. Signature: `verifyMigration(sources: LegacyDbDescriptor[], projectDbPath: string, globalDbPath: string, onProgress?) → VerifyMigrationResult { ok, tables[], error? }`. This is the integrity gate for the graph move.

**No code changes were made (AC4).**
