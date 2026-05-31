# SQLite Schema Canonical Typing Report

**Epic:** T11263 (E10 — SQLite type-loose audit + Drizzle v1 strict-type/CHECK mapping)
**Saga:** T11242 (SG-DB-SUBSTRATE-V2)
**Children:** T11328 (per-column audit) · T11329 (CHECK/type mapping) · T11330 (JSON + naming) · T11331 (idempotency keys + this report)
**Status:** AUTHORITATIVE typing input handed to **T11245 (E2 — target-schema consolidation)**.
**Generated from:** `scripts/audit-sqlite-schema.mjs` (reproducible AST walk) → `docs/migration/sqlite-schema-columns.json` (machine-readable) + `docs/migration/sqlite-schema-columns.md` (per-table tables).

> **Hand-off contract (T11331 AC7).** This document is the single authoritative
> per-column typing source for the target-schema consolidation work in
> **T11245 (E2)**. E2 MUST treat the JSON artifact
> `docs/migration/sqlite-schema-columns.json` as the source of truth for column
> affinity / semantic-type / nullability / default, and this markdown as the
> mapping-rule SSoT for CHECK constraints, timestamp canonicalization, JSON
> validation, and idempotency-key placement. Re-run the audit script before E2
> sign-off to confirm the inventory has not drifted.

---

## 0. Scope, method, and reproducibility (T11328 AC1, AC4)

### What was audited

Every Drizzle `sqliteTable(...)` definition across the 21 schema modules that
constitute the current ~7-config / 10-`*-schema.ts` / 19-`sqliteTable`-module
topology. The audit is produced by a **committed reproducible script**, not hand
curation:

```bash
# emits the machine-readable JSON column table (T11328 AC2) + markdown dump
node scripts/audit-sqlite-schema.mjs \
  --out docs/migration/sqlite-schema-columns.json \
  --markdown docs/migration/sqlite-schema-columns.md
```

The script uses the TypeScript compiler API (`typescript` is already a workspace
dependency) to walk each file's AST, unwind the chained column-builder call
expression (`text('c', opts).notNull().default(...).primaryKey()`), and classify
every column. It is deterministic and idempotent — re-running after any schema
edit regenerates both artifacts.

### Source files inventoried (21 modules, 114 tables, 1181 columns)

| Source file | Target scope | Tables | Columns |
|---|---|--:|--:|
| `packages/core/src/store/schema/tasks.ts` | tasks | 11 | 121 |
| `packages/core/src/store/schema/attachments.ts` | tasks | 2 | 21 |
| `packages/core/src/store/schema/audit.ts` | tasks | 7 | 71 |
| `packages/core/src/store/schema/background-jobs.ts` | tasks | 1 | 10 |
| `packages/core/src/store/schema/evidence-bindings.ts` | tasks | 1 | 5 |
| `packages/core/src/store/schema/experiments.ts` | tasks | 1 | 8 |
| `packages/core/src/store/schema/lifecycle.ts` | tasks | 5 | 49 |
| `packages/core/src/store/schema/manifest.ts` | tasks | 2 | 27 |
| `packages/core/src/store/schema/provenance/commits.ts` | tasks | 3 | 30 |
| `packages/core/src/store/schema/provenance/pull-requests.ts` | tasks | 3 | 28 |
| `packages/core/src/store/schema/provenance/releases.ts` | tasks | 6 | 68 |
| `packages/core/src/store/chain-schema.ts` | tasks | 2 | 18 |
| `packages/core/src/store/conduit-schema.ts` | tasks (`conduit_*`) | 16 | 121 |
| `packages/core/src/store/memory-schema.ts` | brain | 21 | 272 |
| `packages/core/src/store/nexus-schema.ts` | brain (`nexus_*`) | 9 | 96 |
| `packages/core/src/store/signaldock-schema.ts` | brain (`signaldock_*`) | 13 | 133 |
| `packages/core/src/store/skills-schema.ts` | brain (`skills_*`) | 4 | 36 |
| `packages/core/src/agents/agent-schema.ts` | tasks | 2 | 20 |
| `packages/core/src/telemetry/schema.ts` | tasks (`telemetry_*`) | 2 | 12 |
| `packages/nexus/src/schema/code-index.ts` | brain (`nexus_*`) | 1 | 13 |
| `packages/playbooks/src/schema.ts` | tasks | 2 | 22 |
| **Total** | | **114** | **1181** |

`tasks-schema.ts` and `store/schema.ts` are barrels (re-export only) and carry no
own table definitions — they are intentionally excluded from the column walk to
avoid double counting. `validation-schemas.ts` is a `drizzle-orm/zod` derivation
(`createInsertSchema`/`createSelectSchema`) with **no `sqliteTable`** — its
validators are downstream of these tables and are not re-audited here.

The 114-table / ~111-table figure matches the EP-DRIZZLE-CONTAINMENT audit's
"~111 across 20 schema files" within counting tolerance (it counted 20 files,
this audit isolates 21 column-bearing modules including the `store/schema/`
subdomain split).

### Per-column descriptor (T11328 AC2)

Each column row in `sqlite-schema-columns.json` carries:

```jsonc
{
  "field": "createdAt",          // TS property identifier (camelCase)
  "column": "created_at",        // physical SQLite column name (snake_case)
  "affinity": "TEXT",            // declared storage class (TEXT/INTEGER/REAL/BLOB)
  "semanticType": "timestamp-text", // canonical inferred meaning
  "nullable": false,             // false iff .notNull()/.primaryKey()
  "primaryKey": false,
  "unique": false,
  "fk": false,                   // declares .references(...)
  "default": "sql`(datetime('now'))`",
  "enumRef": null,               // { enum: X } identifier when present
  "mode": null,                  // Drizzle column mode (boolean/timestamp/buffer/json)
  "autoIncrement": false,
  "nonConformer": null,          // non-conformance reason + target table, or null
  "targetScope": "tasks",        // consolidated scope (tasks | brain)
  "targetTable": "tasks_tasks"   // domain-prefixed exodus target table
}
```

---

## 1. Consolidated dual-scope target shape (locked decisions)

> **D1″ supersedes D1′ (owner ratification 2026-05-30, session 2).** The split axis is
> now **lifecycle (project vs global)**, NOT domain-cluster, and both files are named
> **`cleo.db`**. The earlier D1′ domain-split into `.cleo/tasks.db` + `.cleo/brain.db`
> is superseded: it conflated project- and global-tier domains in one file (e.g. global
> `nexus`/`skills` were folded into a project `brain.db`) and did not match the owner's
> "dual `cleo.db`, one project + one global" intent. The Pattern-A mechanics
> (single-file-per-scope, domain-prefixed tables, idempotent prefixer, the column→table
> attribution) are PRESERVED; only the scope axis + file naming change.

Per the locked SG-DB-SUBSTRATE-V2 decisions (**D1″ supersedes D1′ supersedes D1**):

- **Substrate:** SQLite consolidation, **Pattern A** — single-file-per-scope,
  domain-prefixed tables. **Two scopes survive, split by LIFECYCLE:**
  the **project** DB `<projectRoot>/.cleo/cleo.db` and the **global** DB
  `$XDG_DATA_HOME/cleo/cleo.db` (per-OS XDG path via `@cleocode/paths`).
- **Driver:** `node:sqlite` 3.53.0. **ORM:** `drizzle-orm@1.0.0-rc.3`
  (`drizzle-orm/node-sqlite`).
- **Table prefixes (lifecycle assignment):** **project** `cleo.db` holds every
  project-tier domain — `tasks_*` / `brain_*` (this project's memory) / `conduit_*` /
  `docs_*` / `telemetry_*` (+ lifecycle/provenance/chain/playbooks/agents). **global**
  `cleo.db` holds every global/cross-project domain — `nexus_*` / `skills_*` /
  `signaldock_*` (global agent identity) / `brain_*` + `tasks_*` for the global-tier
  brain & task stores. `brain_*` and `tasks_*` thus appear in BOTH files, disambiguated
  by which scope's `cleo.db` they live in (per-project state vs cross-project state).

Every column in the inventory is attributed to its `targetTable` using the
domain map plus an idempotent prefixer (a table already carrying a recognized domain
prefix — e.g. `brain_observations`, `nexus_audit_log` — is NOT double-prefixed). The
canonical task table `tasks` becomes `tasks_tasks` under Pattern A. The exodus tool
routes each table to the **project** or **global** `cleo.db` by its domain's lifecycle
tier (a domain is project-scoped unless it is in the global set `{nexus, skills,
signaldock-global, global-brain, global-tasks, telemetry-global}`).

### Scope assignment summary (D1″ — lifecycle)

| Target scope | DB file | Source domains | Note |
|---|---|---|---|
| **project** | `<projectRoot>/.cleo/cleo.db` | tasks / brain (this project's memory) / conduit / docs / telemetry / lifecycle / provenance / chain / playbooks / agents | all project-tier state |
| **global** | `$XDG_DATA_HOME/cleo/cleo.db` | nexus / skills / signaldock (global identity) / global-brain / global-tasks / telemetry-global | all cross-project state |

> **Exactly two `*.db` files survive per machine view** (one project `cleo.db` + one
> global `cleo.db`). No `tasks.db` / `brain.db` / `nexus.db` / `skills.db` /
> `signaldock.db` / `telemetry.db` / `manifest.db` / `llmtxt.db` / `attachments/index.db`
> sidecar survives; content-addressed blob FILES (not `.db`) are exempt.

### Per-scope re-derived counts (T11358 — supersedes 66/631 + 48/550)

The prior domain-split figures (`tasks` 66t/631c + `brain` 48t/550c) are SUPERSEDED.
Counts below are re-derived against the **lifecycle** split directly from the audit
artifact `docs/migration/sqlite-schema-columns.json` (114 tables / 1181 columns),
by classifying each table to its domain via `targetTable` prefix, then routing each
domain to its lifecycle tier. The classification is reproducible — re-run:

```bash
node -e 'const j=require("./docs/migration/sqlite-schema-columns.json");
const dom=tt=>{for(const p of["nexus","skills","signaldock","brain","conduit","telemetry","docs"])if(tt.startsWith(p+"_"))return p;return"tasks-core"};
const a={};for(const t of j.tables){const d=dom(t.targetTable);(a[d]??=(a[d]={t:0,c:0}));a[d].t++;a[d].c+=t.columns.length}console.table(a)'
```

| Domain (prefix) | Tables | Columns | Lifecycle tier |
|---|--:|--:|---|
| `tasks_*` (incl. provenance / releases / lifecycle / playbooks / agents / chain) | 45 | 450 | project |
| `conduit_*` | 14 | 116 | project |
| `docs_*` (attachments / manifest) | 4 | 48 | project |
| `telemetry_*` | 2 | 12 | project |
| `brain_*` (memory) | 22 | 277 | **mirrored** (project + global) |
| `nexus_*` | 10 | 109 | global |
| `skills_*` | 4 | 36 | global |
| `signaldock_*` | 13 | 133 | global |
| **Total (distinct source tables)** | **114** | **1181** | |

**Per-scope cleo.db totals** (the `brain_*` schema is SHARED — same DDL deployed to
both files, data partitioned by scope; it is counted in each):

| Scope | DB file | Composition | Tables | Columns |
|---|---|---|--:|--:|
| **project** | `<projectRoot>/.cleo/cleo.db` | tasks-core 45 + conduit 14 + docs 4 + telemetry 2 + brain 22 | **87** | **903** |
| **global** | `$XDG_DATA_HOME/cleo/cleo.db` | nexus 10 + skills 4 + signaldock 13 + brain 22 (mirrored) | **49** | **555** |

> **Scope-membership decision (T11358).** Only `brain_*` (memory) is mirrored into
> both scopes (the global brain holds cross-project memory; the project brain holds
> project-local memory). Project-tier `tasks_*` and its satellites (provenance,
> releases, lifecycle, playbooks) are **not** mirrored into global — a release/PR/run
> is intrinsically a project concern. `signaldock_*` folds under the **global**
> `cleo.db` per D1 (no standalone `signaldock.db`).

### Dual drizzle-kit configs (T11358 — target shape)

The dual-scope target is authored as two drizzle-kit (rc.3) configs:

| Config | Scope | `out` | Schema membership |
|---|---|---|---|
| `drizzle/cleo-project.config.ts` | project | `packages/core/migrations/drizzle-cleo-project` | 17 project-tier + mirrored-brain modules |
| `drizzle/cleo-global.config.ts` | global | `packages/core/migrations/drizzle-cleo-global` | nexus / skills / signaldock + mirrored-brain modules |

Wired into root `package.json` as `db:generate:cleo-project` / `db:generate:cleo-global`.

> **Generation boundary.** These configs declare per-scope domain MEMBERSHIP, not a
> generate-ready snapshot. Source modules carry UNPREFIXED physical table names, so
> several collide across domains in one file (e.g. `schema/attachments.ts` and
> `conduit-schema.ts` both define `attachments` → `tasks_attachments` vs
> `conduit_attachments`). Pattern-A domain-prefixing that resolves the collisions is
> applied by the **E3 exodus prefixer (T11248)**; running `drizzle-kit generate`
> against the consolidated configs is therefore deferred until exodus emits the
> prefixed schema. Until then `db:check` continues to validate the per-domain baseline
> configs only; the two `cleo-*` configs join the check loop once their first prefixed
> baseline migration exists.

---

## 2. Headline semantic-type distribution (T11328 AC1)

| Semantic type | Count | Notes |
|---|--:|---|
| `text` | 402 | Plain TEXT (opaque strings, content, hashes). |
| `id` | 164 | TEXT id / `*_id` (PK or logical key). |
| `timestamp-text` | 161 | TEXT ISO8601 (`datetime('now')` / `CURRENT_TIMESTAMP`). **Canonical form.** |
| `numeric` | 118 | INTEGER counters / sizes / scores. |
| `enum` | 87 | `text({ enum })` — CHECK-backed. |
| `fk` | 81 | TEXT `.references(...)`. |
| `json` | 63 | JSON-in-TEXT (see §5). |
| `timestamp-epoch` | 45 | INTEGER epoch seconds/ms. **NON-CONFORMER.** |
| `real` | 27 | REAL scores / weights (0.0–1.0). |
| `boolean` | 16 | `integer({ mode: 'boolean' })` — typed. |
| `boolean-untyped` | 12 | INTEGER 0/1 flag, NO `mode`/CHECK. **NON-CONFORMER.** |
| `timestamp-date` | 4 | `integer({ mode: 'timestamp' })` Date mapping. **NON-CONFORMER.** |
| `blob` | 1 | `blob({ mode: 'buffer' })` — conduit attachment bytes. |

**149 non-conformer annotations** total across the inventory (each on a distinct
column in the current dataset): 45 epoch timestamps + 4 Date timestamps + 12
untyped booleans + 25 enum-like bare-TEXT + 63 JSON-in-TEXT validator gaps.

The full per-table column tables (all 1181 rows) are committed at
`docs/migration/sqlite-schema-columns.md`; the structured form at
`docs/migration/sqlite-schema-columns.json`. The sections below are the
canonicalization MAPPING RULES E2 must apply.

---

## 3. Boolean mapping (T11329 AC1)

**Target rule.** Every boolean column is `INTEGER CHECK (col IN (0,1))` and uses
the Drizzle `{ mode: 'boolean' }` builder so the row type narrows to `boolean`.

### 3a. Already conformant (16 columns)

16 columns already declare `integer('col', { mode: 'boolean' })` (e.g.
`tasks.no_auto_complete`, `code_index.exported`, brain `verified` flags). These
gain only the explicit SQL CHECK at exodus; the TS shape is unchanged.

### 3b. NON-CONFORMERS — untyped INTEGER 0/1 flags (12 columns, T11329 AC4)

These store 0/1 as a bare `integer(...)` without `{ mode: 'boolean' }` and without
a CHECK. They MUST be migrated to the canonical form:

| Table → target | Column | Current default |
|---|---|---|
| `sessions` → `tasks_sessions` | `grade_mode` | (none) |
| `commits` → `tasks_commits` | `is_release_commit` | `0` |
| `commits` → `tasks_commits` | `is_merge_commit` | `0` |
| `commit_files` → `tasks_commit_files` | `is_binary` | `0` |
| `pull_requests` → `tasks_pull_requests` | `is_release_pr` | `0` |
| `pull_requests` → `tasks_pull_requests` | `is_bump_only` | `0` |
| `release_commits` → `tasks_release_commits` | `is_first` | `0` |
| `release_commits` → `tasks_release_commits` | `is_last` | `0` |
| `release_commits` → `tasks_release_commits` | `is_release_chore` | `0` |
| `project_agent_refs` → `conduit_project_agent_refs` | `enabled` | `1` |
| `agents` → `signaldock_agents` | `is_active` | `1` |
| `playbook_approvals` → `tasks_playbook_approvals` | `auto_passed` | `0` |

> **E2 finalize.** `sessions.grade_mode` has no default and is read in places as a
> small-int mode rather than a strict 0/1 — confirm it is genuinely boolean
> before applying the `IN (0,1)` CHECK; if it carries >2 states, model it as an
> enum instead. Flagged in §8.

### Drizzle rc.3 column snippet (compiles — T11329 AC2)

```ts
import { sql } from 'drizzle-orm';
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';

export const releaseCommits = sqliteTable('release_commits', {
  // … other columns …
  /** Whether this is the first commit in the release window. */
  isFirst: integer('is_first', { mode: 'boolean' })
    .notNull()
    .default(false),
});
```

The SQL `CHECK (is_first IN (0,1))` is added by the exodus migration alongside
the table create (drizzle-orm sqlite-core does not surface a typed per-column
CHECK DSL in rc.3, so the CHECK ships as raw DDL in the generated migration; the
`{ mode: 'boolean' }` builder guarantees the application only ever writes 0/1).

---

## 4. Timestamp canonicalization (T11329 AC1)

**The audit found THREE competing timestamp representations.** This is the
single highest-leverage canonicalization in the saga.

| Representation | Count | Where | Conformance |
|---|--:|---|---|
| TEXT ISO8601 (`datetime('now')` / `CURRENT_TIMESTAMP`) | 161 | tasks / lifecycle / provenance / brain (memory) / signaldock / skills / playbooks | **CANONICAL** |
| INTEGER epoch (raw `integer(...)`) | 45 | conduit (all tables) + `background_jobs.{started,completed,heartbeat}_at` | NON-CONFORMER |
| INTEGER `{ mode: 'timestamp' }` (Drizzle Date) | 4 | nexus `user_profile.{first_observed_at,last_reinforced_at}`, `sigils.{created_at,updated_at}` | NON-CONFORMER |

### Target rule

**ONE canonical form: TEXT ISO8601 with a CHECK.** Rationale:

1. The strong majority (161 of 210 timestamp columns) already use TEXT ISO8601.
2. TEXT ISO8601 is human-legible in `cleo show`/exports, sorts lexicographically,
   and round-trips cleanly through `json()` and backup VACUUM without epoch-unit
   ambiguity (the conduit epoch columns mix seconds and ms semantics across
   tables, a latent bug class).
3. SQLite's `datetime()` / `strftime()` operate natively on TEXT ISO8601.

### CHECK form

```sql
-- canonical timestamp CHECK (applied as raw DDL in the exodus migration)
CHECK (created_at IS NULL OR created_at GLOB
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
```

(`GLOB` prefix-match on `YYYY-MM-DD` is the cheap structural guard; the writer
layer is the strict producer via `datetime('now')` / `new Date().toISOString()`.)

### Drizzle rc.3 column snippet (compiles — T11329 AC2)

```ts
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const conduitMessages = sqliteTable('conduit_messages', {
  // … other columns …
  /** ISO-8601 UTC creation instant (canonical timestamp form). */
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  /** ISO-8601 UTC delivery instant; NULL until delivered. */
  deliveredAt: text('delivered_at'),
  /** ISO-8601 UTC read instant; NULL until read. */
  readAt: text('read_at'),
});
```

### Migration of the 49 non-conformers

- **45 epoch columns (conduit + background_jobs):** the exodus data copy converts
  with `strftime('%Y-%m-%dT%H:%M:%fZ', col, 'unixepoch')` (or `, 'unixepoch'` +
  `/1000` for the ms-valued columns). **E2 MUST disambiguate seconds-vs-ms per
  column** — the conduit accessor writes `Date.now()` (ms) into some columns and
  `strftime('%s')` (seconds) into `_conduit_meta.updated_at`; see §8.
- **4 Drizzle-Date columns (nexus):** drop `{ mode: 'timestamp' }`; the migration
  converts the stored epoch to ISO8601 TEXT and the new builder is plain `text`.

---

## 5. Enum-like TEXT → CHECK from contracts const arrays (T11329 AC3)

### 5a. Conformant `text({ enum })` columns (87 columns, 78 distinct enum sources)

87 columns already declare `text('col', { enum: X })`. Drizzle narrows the row
type to the union; the exodus migration emits the corresponding
`CHECK (col IN (...))`. The CHECK list MUST be **derived from the enum const
array identifier, not hand-typed** — i.e. generated by interpolating the array:

```ts
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { TASK_STATUSES } from '../status-registry.js';

export const tasks = sqliteTable('tasks_tasks', {
  status: text('status', { enum: TASK_STATUSES }).notNull().default('pending'),
});
// CHECK generation (exodus migration emitter — derived, never hand-typed):
//   const check = sql`CHECK (status IN (${sql.join(
//     TASK_STATUSES.map((v) => sql`${v}`), sql`, `)}))`;
```

**Enum source provenance.** Of the 78 distinct enum sources backing these 87
columns:

- **63 are named `as const` arrays.** The bulk live in `@cleocode/contracts`
  (`TASK_STATUSES`, `TASK_KINDS`, `TASK_SCOPES`, `TASK_SEVERITIES`, `TASK_SIZES`,
  `SESSION_STATUSES`, `ADR_STATUSES`, `GATE_STATUSES`, `MANIFEST_STATUSES`,
  `RELEASE_*`, etc.) and the `BRAIN_*` family (`BRAIN_DECISION_TYPES`,
  `BRAIN_MEMORY_TYPES`, `BRAIN_OBSERVATION_TYPES`, `BRAIN_STICKY_*`,
  `BRAIN_COGNITIVE_TYPES` ×4, `BRAIN_SOURCE_CONFIDENCE` ×4, `BRAIN_MEMORY_TIERS`
  ×4, …). These are the SSoT — CHECK lists derive directly from them.
- **15 are INLINE array literals** declared at the column site (e.g.
  `['text', 'child_task', 'evidence_bound']`, `['ltp', 'ltd']`,
  `['HITL', 'automated']`, `['owner', 'council', 'agent']`,
  `['static', 'hebbian', 'stdp']`, `['proposed', 'applied', 'reverted',
  'rejected']`). **E2 SHOULD promote these to named const arrays** in the
  owning schema module (or `@cleocode/contracts` where cross-package) so the
  CHECK derivation references a single identifier rather than a literal — same
  rule, no hand-typing. Flagged in §8.

### 5b. NON-CONFORMERS — enum-like bare TEXT lacking `{ enum }` / CHECK (25 columns, T11329 AC4)

These columns carry obviously-enum names (`status`, `kind`, `type`, `state`,
`visibility`, `content_type`, `change_type`, `mode`, `role`) but are declared as
bare `text('col')` — no enum narrowing, no CHECK:

| Source file | Columns (table.column) |
|---|---|
| `conduit-schema.ts` (9) | `conversations.visibility`, `messages.content_type`, `messages.status`, `delivery_jobs.status`, `attachments.mode`, `attachment_versions.change_type`, `attachment_approvals.status`, `topic_messages.kind`, `dead_letters` reason-class |
| `memory-schema.ts` (3) | `brain_transcript_events.role`, `brain_backfill_runs.kind`, `brain_backfill_runs.status` |
| `signaldock-schema.ts` (2) | `users.role`, `agents.status` |
| `manifest.ts` (2) | `pipeline_manifest.type`, `pipeline_manifest.status` |
| `schema.ts` (playbooks, 2) | `playbook_runs.status`, `playbook_approvals.status` |
| `attachments.ts` (1) | `attachments.type` |
| `commits.ts` (1) | `commit_files.change_type` |
| `pull-requests.ts` (1) | `pull_requests.state` |
| `releases.ts` (1) | `release_changesets.kind` |
| `chain-schema.ts` (1) | `warp_chain_instances.status` |
| `nexus-schema.ts` (1) | `sigils.role` |
| `code-index.ts` (1) | `code_index.kind` |

**Target rule.** Each MUST gain a named const array + `text({ enum })` + derived
CHECK. Where the legal value set already exists as a contracts const (e.g.
playbook statuses are typed in `@cleocode/contracts` —
`PlaybookRunStatus`/`PlaybookApprovalStatus`), reuse it; otherwise mint a new
`as const` array in the owning module. **E2 MUST enumerate the legal value set
per column from the writer code paths** (the audit identifies the gap; the exact
value list requires reading each writer). Flagged in §8.

---

## 6. JSON-in-TEXT validation + naming canonicalization (T11330)

### 6a. JSON-in-TEXT columns (63 — T11330 AC1)

63 columns store JSON serialized into a TEXT column. They are identified two ways
by the audit: by the `_json` / `Json` suffix convention (51) and by an
empty-array/object default literal `'[]'` / `'{}'` on a `text(...)` column without
the suffix (12 — e.g. `conduit_messages.attachments`, `conduit_messages.metadata`,
topic payloads). This 63 matches the prior **JSON-Column Audit** ("62 JSON-bearing
columns") within one (that audit excluded `brain_memory_trees.centroid`, a
JSON-encoded float array that this audit also classifies as plain `text`, NOT
json — it becomes a Float32 BLOB at exodus, never JSONB).

**Target rule (T11330 AC1).** Each JSON-in-TEXT column gets one of:

1. **Write-time validator** (Drizzle v1 `drizzle-orm/zod` refinement) for columns
   written through the typed insert path:

   ```ts
   import { z } from 'zod';
   // applied via createInsertSchema(...).extend({ ... }) in validation-schemas.ts
   const jsonText = z.string().refine(
     (s) => {
       try {
         JSON.parse(s);
         return true;
       } catch {
         return false;
       }
     },
     { message: 'must be valid JSON' },
   );
   ```

2. **Documented json1 read-time assertion** for columns read via raw SQL — read
   whole values with `SELECT json(col)` so node:sqlite returns parseable TEXT,
   and assert structure in the accessor.

**JSONB / DENORM routing is OWNED by the JSON-Column Audit, not re-decided here.**
That audit's matrix stands: 49 stay TEXT, 9 move to JSONB blob via `customType`
(`tasks.notes_json`, `sessions.{notes,tasks_completed,tasks_created}_json`,
`schema_meta.value` sequence, `brain_page_nodes.metadata_json`,
`brain_retrieval_log.entry_ids`, `attachments.{related_tasks,topics,keywords}`),
and 2 denormalize to junctions (`brain_sticky_notes.tags_json` → `sticky_tags`,
`tasks.labels_json` → `task_labels`). This typing report classifies all 63 as
`json` semantic type and defers the JSONB/DENORM disposition to that audit; E2
consumes BOTH documents.

### 6b. Snake_case naming audit (T11330 AC2)

The audit checked every physical table name and column name against
`^[a-z][a-z0-9_]*$`:

- **Non-snake_case COLUMN names: 0.** Drizzle's physical names (the string-literal
  first argument) are already snake_case across all 1181 columns. The camelCase TS
  property identifiers (`createdAt`) are the application-side field names and do
  not reach SQLite.
- **Non-snake_case TABLE names: 0**, with two legacy **leading-underscore** meta
  tables flagged for rename at exodus:

  | Current | Rewrite target | Disposition |
  |---|---|---|
  | `_conduit_meta` | `conduit_meta` | Rename, or drop in favor of `__drizzle_migrations`. |
  | `_conduit_migrations` | `conduit_migrations` | Legacy pre-Drizzle tracking; drop after runner-before-access is guaranteed (per EP-DRIZZLE-CONTAINMENT WS2). |

  These rewrites apply **at exodus time (T11248)**, not now.

### 6c. LIKE-on-JSON decision (T11330 AC3)

The EP-DRIZZLE-CONTAINMENT audit asserted "fragile LIKE-on-JSON is nearly absent
(only `sentient/proposal-dedup.ts`)". The more granular JSON-Column Audit and a
direct grep show this is an **under-count** — the canonical LIKE-on-serialized-JSON
call sites are:

- `sentient/proposal-dedup.ts:222-223`
- `sentient/proposal-rate-limiter.ts:75` (`labels_json LIKE :labelPattern`)
- `sentient/ops.ts:65,151,200`
- `sentient/stage-drift-tick.ts:229` (`notes_json LIKE '%dedupHash%'`)
- `store/sqlite-data-accessor.ts:662-663`
- `store/schema/tasks.ts:235` (partial-index predicate `labels_json LIKE '%sentient-tier2%'`)
- `nexus/living-brain.ts:433` (`metadata_json LIKE ?`)

**Decision.** LIKE-on-JSON is concentrated in the **sentient label/dedup hot path**
(`labels_json`) and the **brain page-node metadata path** (`metadata_json`). These
are exactly the columns the JSON-Column Audit routes to junctions
(`task_labels`) and JSONB (`metadata_json`) respectively — so the fragile filters
are eliminated as a side effect of that audit's disposition, NOT by new work here.
This stays low-leverage for E10. **E2 MUST NOT introduce new LIKE-on-JSON** beyond
this enumerated set; the `task_labels` junction + `jsonb_extract` are the
replacements.

---

## 7. Idempotency-key annotations for agent-retried writes (T11331 AC1)

Agent writes are retried (spawn failures, transport redelivery, sentient
re-ticks). Tables on a retried-write path need an `idempotency_key TEXT`
(UNIQUE or PRIMARY KEY) so a redelivered write is a no-op via
`onConflictDoNothing` (Idempotency Pattern A). **Concrete column schema is
deferred to T11245 (E2)** — this report marks WHERE the keys belong.

| Table → target | Retried-write path | idempotency_key today | Required treatment |
|---|---|---|---|
| `tasks` → `tasks_tasks` | sentient propose/stage-drift re-tick creates tasks | NO | `idempotency_key TEXT UNIQUE` (nullable; set by sentient/agent writers). Interim dedup is `notes_json LIKE '%dedupHash%'` — replace with the key. |
| `brain_observations` → `brain_observations` | `cleo memory observe` retried; graph-memory-bridge `setImmediate` async observers | NO | `idempotency_key TEXT UNIQUE` + `onConflictDoNothing`. Highest leverage — the bridge re-emits on race. |
| `messages` → `conduit_messages` | LocalTransport delivery + redelivery from `delivery_jobs` | NO | `idempotency_key TEXT UNIQUE`. Pairs with `delivery_jobs` retry loop (`max_attempts` default 6). |
| `topic_messages` → `conduit_topic_messages` | A2A broadcast republish | NO | `idempotency_key TEXT UNIQUE`. |
| `delivery_jobs` → `conduit_delivery_jobs` | the retry queue itself | NO (`id` PK) | `id` is the dedup key; add `idempotency_key` only if producers re-enqueue without a stable `id`. |
| `audit_log` → `tasks_audit_log` | audit writes on retried mutations | **YES** (`idempotency_key` exists) | CANONICAL MODEL — keep + add UNIQUE constraint if absent. |
| `background_jobs` → `tasks_background_jobs` | job claim/heartbeat re-runs | NO | `idempotency_key TEXT UNIQUE` keyed on `(job_type, payload_hash)` so a re-submitted job coalesces. |

**Drizzle rc.3 idempotency snippet (Pattern A — T11331 reference shape):**

```ts
import { sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const brainObservations = sqliteTable(
  'brain_observations',
  {
    id: text('id').primaryKey(),
    // … domain columns …
    /** Caller-supplied stable key; redelivered writes are a no-op. */
    idempotencyKey: text('idempotency_key'),
  },
  (t) => [unique('uq_brain_observations_idempotency_key').on(t.idempotencyKey)],
);
// write path: db.insert(brainObservations).values(row).onConflictDoNothing();
```

`audit_log` already proves the pattern works in this codebase. The 6 remaining
tables are the retried-write surface E2 must add keys to. `idempotency_key` is
nullable (legacy rows + non-agent writes have none); the UNIQUE constraint
ignores NULLs in SQLite, so only keyed writes coalesce.

---

## 8. Ambiguous typing decisions E2 (T11245) must finalize

The audit identifies the gaps deterministically; these specific resolutions
require reading writer code and are explicitly handed to E2:

1. **Epoch unit per conduit timestamp column (seconds vs milliseconds).** The
   conduit accessor writes `Date.now()` (ms) into message timestamps but
   `strftime('%s','now')` (seconds) into `_conduit_meta.updated_at` /
   `_conduit_migrations.applied_at`. The exodus epoch→ISO8601 conversion divisor
   differs per column. E2 MUST audit each of the 45 epoch columns' writer to pick
   `'unixepoch'` vs `'unixepoch'`-on-`/1000`.
2. **`sessions.grade_mode` boolean-vs-enum.** No default, read as a small int.
   Confirm strict 0/1 before applying the boolean CHECK; otherwise model as enum.
3. **Legal value sets for the 25 enum-like bare-TEXT non-conformers (§5b).** The
   audit flags the columns; the exact CHECK lists must be enumerated from each
   writer. Reuse existing contracts consts where they exist (playbook statuses,
   `AGENT_INSTANCE_STATUSES` for `agents.status`, etc.).
4. **Promote 15 inline enum arrays (§5a) to named const arrays** so CHECK
   derivation references an identifier, never a literal.
5. **JSONB-vs-TEXT-vs-DENORM disposition for the 63 JSON columns** is owned by the
   separate JSON-Column Audit (`json-storage-jsonb-audit`); E2 consumes that doc
   alongside this one. This report does not re-decide it.
6. **`_conduit_meta` / `_conduit_migrations` rename-or-drop** (§6b) — coordinate
   with EP-DRIZZLE-CONTAINMENT WS2 (runner-before-access guarantee).
7. **`brain_memory_trees.centroid`** → Float32 BLOB (NOT JSONB, NOT json) per the
   JSON-Column Audit; this report classifies it as `text` today.

---

## 9. Committed artifacts (reproducible — T11328 AC4)

| Artifact | Path | Purpose |
|---|---|---|
| Audit script | `scripts/audit-sqlite-schema.mjs` | Reproducible AST walk; regenerates the two artifacts below. |
| Machine-readable column table | `docs/migration/sqlite-schema-columns.json` | Per-column descriptor for all 1181 columns (T11328 AC2) — **E2's source of truth**. |
| Per-table markdown dump | `docs/migration/sqlite-schema-columns.md` | Human-browsable per-table column tables (all 114 tables). |
| This report | `docs/migration/sqlite-schema-canonical.md` | Canonical mapping rules + non-conformer flags + idempotency-key plan + E2 hand-off. |

Re-run: `node scripts/audit-sqlite-schema.mjs --markdown docs/migration/sqlite-schema-columns.md`.

---

## 10. Cross-references

- **T11245 (E2 — target-schema consolidation):** PRIMARY consumer. This report +
  `sqlite-schema-columns.json` are the authoritative typing input.
- **JSON-Column Audit** (`json-storage-jsonb-audit`, E4/T11286): owns the
  JSONB/TEXT/DENORM disposition for the 63 JSON columns. Consumed by E2 in tandem.
- **EP-DRIZZLE-CONTAINMENT** (T11295): owns the raw-SQL→typed-writer remediation,
  the DDL-SSoT-under-drizzle-kit work, and the `_conduit_*` legacy-table cleanup.
- **Locked substrate decisions:** SQLite Pattern A + drizzle-orm@1.0.0-rc.3 +
  node:sqlite 3.53.0 + Idempotency Pattern A (D1' supersedes D1).
