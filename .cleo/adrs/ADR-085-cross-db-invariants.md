---
id: adr-085-cross-db-invariants
tasks: [T10320, T10285, T10281]
kind: adr
summary: ADR-085 — Cross-DB Invariants Catalogue. Catalogues the five cross-database reference invariants linking tasks.db, brain.db, manifest.db, nexus.db, llmtxt.db, and conduit.db; defines validation procedures and repair actions for each.
---

# ADR-085: Cross-DB Invariants Catalogue

- **Status**: Proposed
- **Date**: 2026-05-23
- **Author**: cleo-prime (T10320 worker)
- **Tags**: database, invariants, cross-db, integrity, brain, manifest, nexus, llmtxt, conduit
- **Task**: T10320 (T-E4-1)
- **Epic**: T10285 (E4-DB-CROSS-LINKS)
- **Saga**: T10281 (SG-BRAIN-DB-RESILIENCE)
- **Related ADRs**: ADR-068 (CLEO Database Charter — 12 DBs, ownership, lifecycle), ADR-037 (signaldock/conduit separation), ADR-013 (runtime data safety)
- **Related Tasks**: T10321 (drift detector implementation), T10322 (`cleo doctor db-substrate`), T10323 (E_PROJECT_ID_DRIFT enforcement)

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## §1 Context

ADR-068 catalogues the canonical 12 CLEO databases — `tasks.db`, `brain.db`,
`conduit.db`, `nexus.db`, `telemetry.db`, `manifest.db` (blob index),
`llmtxt.db` (sessions), the project-tier legacy `signaldock.db`, the global
`signaldock.db` (identity registry), `global-brain`, `global-tasks`, and the
`skills` database. Each row in that charter declares ownership, readers,
writers, concurrency model, retention, backup, and privacy class for a single
DB in isolation.

ADR-068 deliberately stops at the per-DB boundary. What it does NOT codify is
the **reference graph** between databases — the columns where a value written
into one SQLite file is expected to resolve against a row in a different
SQLite file. SQLite cannot express foreign keys across attached-DB boundaries
when those DBs are opened in separate `DatabaseSync` handles (the CLEO model
per `openCleoDb` chokepoint, ADR-068 Decision D003), so these references are
**logical FKs only** — enforced (or violated) entirely by application code.

The Saga T10281 SG-BRAIN-DB-RESILIENCE audit (Epic T10285 E4-DB-CROSS-LINKS)
identified five cross-DB reference columns that are load-bearing for daily
CLEO operation:

1. `brain_observations.task_id` (and sibling `task_id` columns across the
   brain.db schema) referencing `tasks.id` in tasks.db. Every memory write
   that observes a task carries this column; broken references silently
   produce orphan memories that surface in `cleo memory find` results
   pointing at vanished tasks.
2. `pipeline_manifest.task_id` and `pipeline_manifest.epic_id` (in tasks.db
   via the manifest schema in `packages/core/src/store/schema/manifest.ts`)
   plus the parallel ownership tracked through `blob_attachments.uploaded_by`
   and `blob_attachments.doc_slug` in `manifest.db` (the blob index at
   `<projectRoot>/.cleo/blobs/manifest.db`). Both surfaces describe "which
   task owns this blob/attachment".
3. `project_registry.project_id` and `nexus_audit_log.project_id` in
   nexus.db, plus `nexusNodes.projectId` referenced from `clusters.ts` /
   `flows.ts` — every nexus row is partitioned by `project_id` to keep
   cross-project knowledge isolated. The `project_id` value in nexus.db
   MUST match the canonical project identity that other CLEO surfaces use
   to talk about the same project.
4. The forthcoming `llmtxt.db` session adapter (per ADR-068 row 8, "reserved
   for forthcoming AgentSession persistence") carries `session_id` columns
   that must round-trip with `sessions.id` in tasks.db. Today llmtxt
   sessions live in `<projectRoot>/.cleo/sessions/<sessionId>.llmtxt` flat
   files; once the DB-backed adapter lands the linkage moves from a path
   convention to a cross-DB invariant.
5. `delivery_jobs.id` and `dead_letters.job_id` in conduit.db reference jobs
   that are typically anchored against a task or brain memory (the spawn
   prompt referenced in the conduit message carries a `taskId`, and the
   brain observation recording the spawn carries the same `task_id`).
   Conduit jobs whose anchor task or anchor observation is gone produce
   un-routable replays.

Without a written catalogue, six failure modes compound:

- **Silent drift**: code adds a new cross-DB reference column without
  registering it anywhere, and the next refactor breaks the implicit FK.
- **Orphan accumulation**: deletes in `tasks.db` cascade nowhere because the
  other DBs are out of process; orphan rows pile up over months.
- **Audit opacity**: `cleo doctor` reports per-DB integrity (pragma
  `integrity_check`, schema version) but cannot answer "are my brain memories
  pointing at real tasks?".
- **Project-ID confusion**: nexus.db, project-context.json, and the
  base64url-of-cwd derivation each have a notion of "project identity" and
  they can drift apart — Saga T10281 already filed the duplicate-nexus.db
  symptom under `~/.local/share/cleo/nexus/<hash>/` against this very gap.
- **Migration brittleness**: a schema migration in tasks.db that renames or
  reshapes `tasks.id` (the canonical anchor) has no listed downstream sites,
  so the migration author has nothing to scan against.
- **Recovery indeterminacy**: the live malformed brain.db incident (Saga
  T10281 P0) has no documented "if brain.db is wiped, what becomes orphan in
  tasks.db / conduit.db / nexus.db?" answer.

This ADR codifies the five invariants, names each, fixes a validation
procedure each runtime/CI surface can mechanically execute, and pins the
repair action when validation fails. Implementation tasks are explicitly
**out of scope** — those land under T10321 (drift detector), T10322
(`cleo doctor db-substrate`), and T10323 (`E_PROJECT_ID_DRIFT` runtime gate
at `openCleoDb`).

## §2 Decision

CLEO declares the following five cross-DB invariants. Each invariant is
identified by a stable ID (`I1`..`I5`) used by audit tooling, doctor output,
and follow-up ADRs. Each carries a **name**, a **description**, a
**validation procedure**, and a **repair action on violation**.

### §2.1 I1 — `brain_observations.task_id` → `tasks.id`

**Name**: `brain-anchor-task-fk` (informal: "every brain memory points at a
real task")

**Description**: Every row in brain.db that carries a `task_id`-shaped
column references a task that exists in tasks.db at the moment the row is
written. Affected columns include but are not limited to:

- `brain_observations.task_id` (T1145-extended observations)
- `brain_decisions.context_task_id` (decision context anchor)
- `brain_memory_links.task_id` (PK component on the link table)
- Any future column declared via the brain Drizzle schema whose name ends in
  `_task_id` or whose Drizzle column comment marks it as a task anchor.

Because brain.db and tasks.db are opened via two separate `DatabaseSync`
handles (per ADR-068), SQLite cannot enforce this as a native FK. CLEO MUST
treat it as a logical FK: every write site in `packages/core/src/memory/`
that populates a `task_id` column MUST have validated the existence of the
referenced `tasks.id` in tasks.db within the same logical transaction, or
the column MUST be left NULL.

The `BrainAnchor` contract in `packages/contracts/src/memory/timeline.ts`
(carrying `{id, type, data}`) is a sibling surface that returns a brain row
projection — it is consumed by, but separate from, this invariant; this
invariant constrains the **stored column**, not the API projection.

**Validation procedure**:

```sql
-- Run inside brain.db with tasks.db attached read-only as `tasks`.
ATTACH DATABASE '<projectRoot>/.cleo/tasks.db' AS tasks_attached;
SELECT bo.id AS observation_id, bo.task_id
FROM brain_observations AS bo
LEFT JOIN tasks_attached.tasks AS t ON t.id = bo.task_id
WHERE bo.task_id IS NOT NULL AND t.id IS NULL;
```

A non-empty result set is a violation. The same shape repeats for
`brain_decisions.context_task_id` (anchored on the decision row) and
`brain_memory_links.task_id` (anchored on the link row's PK tuple).

**Repair action on violation**:

1. **Read-only flag**: emit `E_BRAIN_ORPHAN_TASK_ANCHOR` from `cleo doctor
   db-substrate` (T10322) with the orphan row IDs. Do NOT auto-delete —
   memory data is HIGH-sensitivity per ADR-068 row 2.
2. **Owner-gated repair**: `cleo memory sweep --orphans` (new sub-verb under
   the existing `cleo memory sweep --approve` surface) accepts the orphan
   list and offers two paths:
   - `--retain` rewrites the orphan rows' `task_id` to NULL (preserves the
     observation, drops the dangling anchor).
   - `--purge` deletes the orphan rows entirely (rare; reserved for memories
     that were demonstrably tied to a cancelled task).
3. **Migration provenance**: if the orphan stems from a known task rename
   (rare), `cleo task rename <old> <new>` MUST propagate the new ID across
   brain.db, manifest.db, and conduit.db in the same transaction batch
   (specified by T10321).

### §2.2 I2 — `manifest.db` blob ownership → `tasks.id`

**Name**: `manifest-blob-owner-fk` (informal: "every blob attachment is
owned by a real task")

**Description**: This invariant has **two co-equal surfaces** that together
describe "which task owns this attachment":

- **Surface A — tasks.db `pipeline_manifest` table**:
  `pipeline_manifest.task_id` and `pipeline_manifest.epic_id` (declared in
  `packages/core/src/store/schema/manifest.ts`) each reference `tasks.id`
  via Drizzle's `references(() => tasks.id, { onDelete: 'set null' })`.
  These are intra-DB FKs (both tables live in tasks.db) and SQLite enforces
  them when `PRAGMA foreign_keys=ON`, but the `set null` policy means the
  invariant CLEO cares about is **non-null FK integrity** — a non-null
  `task_id` value MUST resolve.
- **Surface B — manifest.db `blob_attachments` table** at
  `<projectRoot>/.cleo/blobs/manifest.db`: the `doc_slug` column resolves
  against the canonical docs SSoT slug index, which in turn carries a
  `task_id` foreign key into tasks.db. Transitively: every blob's
  `doc_slug` MUST map to a docs row whose owner `task_id` resolves in
  tasks.db.

The invariant covers both surfaces because the owner's mental model treats
"blob entries → real tasks" as a single property regardless of which file
the index row physically lives in.

**Validation procedure**:

For Surface A (intra-tasks.db, simple FK check):

```sql
-- Run inside tasks.db. `PRAGMA foreign_key_check` reports all FK violations
-- including the pipeline_manifest cascade.
PRAGMA foreign_key_check(pipeline_manifest);
```

For Surface B (cross-DB through docs slug index):

```sql
-- Run inside manifest.db with tasks.db attached read-only.
ATTACH DATABASE '<projectRoot>/.cleo/tasks.db' AS tasks_attached;
SELECT ba.id AS blob_id, ba.doc_slug
FROM blob_attachments AS ba
LEFT JOIN tasks_attached.docs_slugs AS s ON s.slug = ba.doc_slug
LEFT JOIN tasks_attached.tasks AS t ON t.id = s.task_id
WHERE ba.deleted_at IS NULL
  AND (s.slug IS NULL OR t.id IS NULL);
```

A non-empty result is a violation: the blob's slug either has no docs row,
or the docs row's owner task is gone. (The exact docs slug table name MAY
differ — T10321's implementation MUST resolve the current name via the
Drizzle schema; this ADR fixes the semantic, not the literal SQL.)

**Repair action on violation**:

1. **Read-only flag**: `cleo doctor db-substrate` (T10322) reports
   `E_MANIFEST_ORPHAN_BLOB` with the orphan blob IDs.
2. **Owner-gated repair**: `cleo docs prune --orphans` (new sub-verb under
   the canonical docs SSoT) marks the orphan blobs `deleted_at = <now>`
   (soft-delete — content-addressed blob storage in
   `<projectRoot>/.cleo/blobs/` is rebuildable, and the soft-delete
   preserves audit trail).
3. **Migration safety**: any tasks.db migration that hard-deletes a `tasks`
   row MUST first re-link or null out the dependent `pipeline_manifest`
   rows AND the dependent docs-slug rows — Drizzle's `onDelete: 'set null'`
   handles `pipeline_manifest` automatically; the docs-slug table policy
   MUST be verified by T10321's migration coverage report.

### §2.3 I3 — `nexus.db.project_id` ↔ canonical project identity

**Name**: `nexus-project-id-consistency` (informal: "nexus partitioning
matches the project's canonical ID")

**Description**: Every row in nexus.db that carries a `project_id` column
(including `project_registry.project_id`, `nexus_audit_log.project_id`,
`nexusNodes.projectId`, and every downstream nexus table partitioned by
project) MUST match the canonical project identity for the project whose
nexus index the row belongs to.

The canonical project identity is derived per `CLEO-INJECTION.md`'s "Project
resolution" rule for `cleo nexus` operations:

> `--project-id` > `--path` > `cwd`. Default ID = `base64url(path).slice(0,32)`.

That derivation is the SSoT. The `projectId` field MAY ALSO be persisted in
`.cleo/project-context.json` to lock the derivation against subsequent
`cwd` changes (e.g. when a project directory is renamed). If
`project-context.json` carries an explicit `projectId`, it takes precedence
over the base64url derivation — and BOTH values, the JSON-persisted and the
derivation, MUST match `nexus.db.project_id` for every row tagged with the
project. (The current `.cleo/project-context.json` schema does NOT include
a `projectId` field; the field is RESERVED for the T10323 enforcement work
and will be populated by `cleo init` once T10323 lands.)

`nexus.db` is global (`$XDG_DATA_HOME/cleo/nexus.db`) per ADR-068 row 5 —
one file, many projects, partitioned by `project_id`. The known duplicate
nexus subdirectory under `~/.local/share/cleo/nexus/<hash>/` flagged by
Saga T10281 is a separate structural bug (a per-project nexus DB written by
mistake, sibling to the canonical global one); resolving that bug is
covered by Epic T10285 acceptance criterion 2 — this invariant constrains
the canonical surface only.

**Validation procedure**:

At every `openCleoDb(role='nexus', cwd)` call (the chokepoint per ADR-068
Decision D003):

1. Resolve `expectedProjectId`:
   - If `<projectRoot>/.cleo/project-context.json` declares `projectId`,
     use it.
   - Otherwise, compute `base64url(<projectRoot>).slice(0, 32)`.
2. After opening nexus.db (read-write), execute:

   ```sql
   SELECT project_id
   FROM project_registry
   WHERE project_hash = ?      -- the base64url hash of <projectRoot>
   ```

3. If the row exists and `project_id != expectedProjectId`, raise
   `E_PROJECT_ID_DRIFT`. If the row does not exist, no drift — this is a
   first-touch register operation.

Periodic full-table sweep (run by `cleo doctor db-substrate`):

```sql
SELECT project_id, COUNT(*) AS n
FROM project_registry
GROUP BY project_id
HAVING COUNT(*) > 1;
```

Any duplicate `project_id` row in `project_registry` is a violation.

**Repair action on violation**:

1. **Runtime gate** (T10323): `openCleoDb` raises `E_PROJECT_ID_DRIFT` and
   refuses to return the handle. The caller MUST resolve the drift before
   retrying.
2. **Owner-gated repair**: `cleo nexus admin reconcile --project <path>`
   (new sub-verb under the existing `cleo nexus admin` surface) offers
   three paths:
   - `--accept-disk` rewrites `.cleo/project-context.json` to match the
     `project_registry` value.
   - `--accept-context` rewrites `project_registry` (and all referencing
     nexus tables) to match the `project-context.json` value.
   - `--re-register` deletes the project from nexus.db entirely and lets
     the next `cleo nexus query` re-register it from scratch.
3. **Duplicate row repair**: if `project_registry` carries two rows for the
   same project (the symptom flagged by Saga T10281), `cleo nexus admin
   dedupe` picks the row with the canonical path and migrates all
   referencing rows to its `project_id`, deleting the duplicate.

### §2.4 I4 — `llmtxt.db.session_id` ↔ `tasks.db.sessions.id`

**Name**: `llmtxt-session-task-fk` (informal: "every llmtxt session row
mirrors a real CLEO session")

**Description**: Once the DB-backed llmtxt AgentSession adapter lands (per
ADR-068 row 8, currently reserved), every `session_id` column in llmtxt.db
MUST reference a `sessions.id` row in tasks.db. Today the linkage is a
path-based convention — `<projectRoot>/.cleo/sessions/<sessionId>.llmtxt`
files name themselves after the tasks.db session — and the invariant
applies to the path naming: every flat file under `.cleo/sessions/` whose
stem looks like a session ID MUST resolve in `tasks.db.sessions`.

Once the DB-backed adapter is live the invariant moves from a path
convention to a literal cross-DB FK between `llmtxt.db.<session-table>`
and `tasks.db.sessions.id`.

**Validation procedure**:

Pre-DB-adapter (path-based):

```bash
# Each *.llmtxt under .cleo/sessions/ MUST match a sessions.id.
ls -1 .cleo/sessions/*.llmtxt 2>/dev/null \
  | xargs -n1 basename \
  | sed 's/\.llmtxt$//' \
  | while read sid; do
      sqlite3 .cleo/tasks.db \
        "SELECT 1 FROM sessions WHERE id = '$sid' LIMIT 1;" \
        | grep -q 1 || echo "ORPHAN: $sid"
    done
```

Post-DB-adapter (cross-DB):

```sql
-- Run inside llmtxt.db with tasks.db attached read-only.
ATTACH DATABASE '<projectRoot>/.cleo/tasks.db' AS tasks_attached;
SELECT ls.session_id
FROM llmtxt_sessions AS ls
LEFT JOIN tasks_attached.sessions AS s ON s.id = ls.session_id
WHERE s.id IS NULL;
```

A non-empty result is a violation. The literal `llmtxt_sessions` table name
is reserved by ADR-068 row 8 and MAY change when the adapter lands —
T10321's implementation MUST resolve the current name via the Drizzle
schema; this ADR fixes the semantic.

**Repair action on violation**:

1. **Read-only flag**: `cleo doctor db-substrate` (T10322) reports
   `E_LLMTXT_ORPHAN_SESSION` with the orphan session IDs.
2. **Owner-gated repair**: `cleo session prune --orphans` (extending the
   existing `cleo session prune` policy noted in ADR-068 row 8) deletes
   the orphan llmtxt rows / files. Session content is PII-class per
   ADR-068 — prune is destructive and explicit.
3. **Backup interaction**: per ADR-013 §9 the session files are NOT
   automatically backed up; the orphan-repair flow MUST log the deleted
   session IDs to `.cleo/audit/session-prune.jsonl` for post-hoc audit.

### §2.5 I5 — `conduit.db` job → `tasks.db` or `brain.db` anchor

**Name**: `conduit-job-anchor-fk` (informal: "every conduit job is anchored
on a real task or memory")

**Description**: Conduit job rows — `delivery_jobs.id` in conduit.db, and
the dead-letter projection `dead_letters.job_id` — carry a `payload`
column that, for CLEO-orchestrated jobs, encodes a JSON envelope with an
anchor reference. The anchor takes one of two shapes:

- `{ "anchorType": "task", "anchorId": "T1234" }` — the job belongs to a
  CLEO task; `anchorId` MUST resolve in tasks.db `tasks.id`.
- `{ "anchorType": "observation", "anchorId": "O-abc123" }` — the job
  belongs to a brain memory; `anchorId` MUST resolve in brain.db
  `brain_observations.id`.

Jobs that pre-date the anchor convention (e.g. raw conduit messages between
external agents) MAY omit the anchor field — those are exempt from this
invariant. Jobs that **declare** an anchor MUST resolve it.

**Validation procedure**:

```sql
-- Run inside conduit.db. The query extracts the anchor from the JSON
-- payload and is matched against tasks.db OR brain.db depending on
-- anchorType.
ATTACH DATABASE '<projectRoot>/.cleo/tasks.db' AS tasks_attached;
ATTACH DATABASE '<projectRoot>/.cleo/brain.db' AS brain_attached;

SELECT
  dj.id AS job_id,
  json_extract(dj.payload, '$.anchorType') AS anchor_type,
  json_extract(dj.payload, '$.anchorId')   AS anchor_id
FROM delivery_jobs AS dj
WHERE json_extract(dj.payload, '$.anchorId') IS NOT NULL
  AND (
    (json_extract(dj.payload, '$.anchorType') = 'task'
      AND NOT EXISTS (SELECT 1 FROM tasks_attached.tasks
                      WHERE id = json_extract(dj.payload, '$.anchorId')))
    OR
    (json_extract(dj.payload, '$.anchorType') = 'observation'
      AND NOT EXISTS (SELECT 1 FROM brain_attached.brain_observations
                      WHERE id = json_extract(dj.payload, '$.anchorId')))
  );
```

A non-empty result is a violation. The same shape applies to `dead_letters`
joined by `job_id` (dead-letter rows inherit the original payload's anchor
through the FK to `delivery_jobs.id` — when delivery_jobs has been pruned,
the dead-letter retains the last-known anchor for triage).

**Repair action on violation**:

1. **Read-only flag**: `cleo doctor db-substrate` (T10322) reports
   `E_CONDUIT_ORPHAN_JOB` with the orphan job IDs.
2. **Owner-gated repair**: `cleo conduit admin reap-orphans` (new sub-verb
   under the existing `cleo conduit admin` surface, see ADR-037 for the
   conduit admin contract):
   - Pending jobs (`status='pending'`) whose anchor is gone are
     hard-deleted (they cannot be delivered anyway).
   - In-flight jobs (`status='in-progress'` or `status='retrying'`) are
     moved to the dead-letter queue with `reason='orphan-anchor'` so they
     surface in operator review.
   - Completed jobs (`status='completed'` or `status='failed'`) are
     retained — the audit trail is more valuable than the anchor reference,
     and the dangling reference is harmless once delivery is done.
3. **Anchor migration**: if the orphan stems from a known anchor rename
   (rare — task renames or memory consolidation), `cleo conduit admin
   relink` accepts an old-anchor → new-anchor map and rewrites the payload
   JSON in-place inside a single transaction.

### §2.6 Invariant summary

| ID | Name | Source DB | Target DB | Validation surface | Repair verb |
|----|------|-----------|-----------|--------------------|-------------|
| I1 | `brain-anchor-task-fk` | brain.db | tasks.db | `cleo doctor db-substrate` + per-write check at brain ingestion | `cleo memory sweep --orphans` |
| I2 | `manifest-blob-owner-fk` | tasks.db (`pipeline_manifest`) + manifest.db (`blob_attachments`) | tasks.db (`tasks`) | `PRAGMA foreign_key_check(pipeline_manifest)` + cross-DB scan via docs slug index | `cleo docs prune --orphans` |
| I3 | `nexus-project-id-consistency` | nexus.db | `.cleo/project-context.json` + base64url derivation | runtime gate at `openCleoDb(nexus)` + `cleo doctor db-substrate` sweep | `cleo nexus admin reconcile` / `dedupe` |
| I4 | `llmtxt-session-task-fk` | llmtxt.db (or `.cleo/sessions/*.llmtxt` flat files pre-adapter) | tasks.db (`sessions`) | path scan today; cross-DB join once DB adapter lands | `cleo session prune --orphans` |
| I5 | `conduit-job-anchor-fk` | conduit.db (`delivery_jobs.payload`, `dead_letters.payload`) | tasks.db (`tasks`) OR brain.db (`brain_observations`) | JSON-extract scan inside conduit.db with both targets attached | `cleo conduit admin reap-orphans` / `relink` |

## §3 Consequences

### §3.1 Positive

- **Audit visibility**: `cleo doctor db-substrate` (T10322) gains a
  five-row report — one per invariant — that lets operators see cross-DB
  health at a glance. Today the same information requires five ad-hoc SQL
  scripts.
- **Migration safety**: every schema migration in tasks.db, brain.db,
  manifest.db, nexus.db, llmtxt.db, or conduit.db now has a listed
  downstream sites table to scan against. T10321's drift detector
  consumes this catalogue directly.
- **Recovery determinism**: when brain.db is wiped (the live malformed-DB
  symptom flagged by Saga T10281), the I1 invariant tells the operator
  exactly which tasks.db rows lose their anchors — no manual investigation.
- **Project-ID lock-down**: I3's runtime gate (T10323) catches the
  duplicate-nexus.db bug class (Epic T10285 AC2) at the open call,
  preventing accumulation.

### §3.2 Negative / costs

- **Validation latency**: the I3 runtime gate at `openCleoDb` adds one
  query (`SELECT project_id FROM project_registry WHERE project_hash = ?`)
  to every nexus open. The chokepoint cache (per ADR-068's `openCleoDb`
  caching policy) absorbs this cost — drift is checked once per process,
  not once per query.
- **Repair tooling sprawl**: five new repair sub-verbs (`cleo memory sweep
  --orphans`, `cleo docs prune --orphans`, `cleo nexus admin reconcile`,
  `cleo session prune --orphans`, `cleo conduit admin reap-orphans`). Each
  is small, but the operator now has five surfaces to learn. The
  catalogue here is the single index that lists them.
- **Manual repair gating**: orphans are NEVER auto-deleted — every repair
  verb is owner-gated. Operators who ignore the orphan reports accumulate
  silent drift. T10322 mitigates this by surfacing orphan counts in
  `cleo briefing` once they exceed a threshold.

### §3.3 Out of scope (deferred to follow-up tasks)

- **T10321 drift detector implementation**: the actual SQL queries and
  scan scheduler. This ADR fixes the contracts; T10321 ships the runtime.
- **T10322 `cleo doctor db-substrate`**: the doctor sub-verb that runs all
  five validation procedures and formats the report.
- **T10323 `E_PROJECT_ID_DRIFT` enforcement at `openCleoDb`**: the runtime
  gate for I3.
- **Cross-DB FK Drizzle tagging**: Epic T10285 AC5 mandates every
  cross-DB reference column carry an `@cross-db` Drizzle tag (or
  equivalent contract). The exact tagging surface is a separate ADR
  amendment under E4.
- **I3 `projectId` field addition to `.cleo/project-context.json`**: the
  schema change to add the field lands under T10323. Until then,
  base64url-of-cwd derivation is the only authoritative value.

## §4 Alternatives considered

### §4.1 Native SQLite cross-DB FKs via `ATTACH DATABASE` at open time

The chokepoint `openCleoDb` could attach all sibling DBs on every open
and declare `REFERENCES` constraints that span the attachment boundary.

**Rejected** because:

- It violates ADR-068 Decision D003's single-DB-per-handle invariant.
- Attaching brain.db (PII-class, HIGH-sensitivity) to every conduit.db
  open broadens the privacy blast radius unacceptably.
- WAL concurrency across attached DBs is fragile — readers block writers
  in ways the current per-DB WAL model does not.
- SQLite's `foreign_keys` pragma only enforces FKs declared at table-create
  time; retroactive cross-DB FKs would require schema rewrites in every
  affected DB.

### §4.2 In-process orphan-prevention transaction wrapper

A `withCrossDbTx(handles, fn)` helper that opens N DBs in one logical
transaction, validates the FK on commit, and rolls back if any orphan is
introduced.

**Rejected** because:

- SQLite does not support distributed transactions across separate
  `DatabaseSync` handles. The "logical transaction" would be wishful
  thinking — a crash between the brain.db commit and the tasks.db commit
  leaves orphans regardless.
- The per-write check at brain ingestion (I1's runtime side) is the
  pragmatic equivalent: validate before write, accept that a concurrent
  delete in tasks.db can still produce orphans (caught by the periodic
  doctor sweep).

### §4.3 Single monolithic CLEO database (collapse the 12 DBs into 1)

The fundamental reason cross-DB invariants exist is that CLEO uses 12
separate SQLite files. Collapse them.

**Rejected** because:

- ADR-068's per-DB ownership / privacy / retention model is the explicit
  reason the topology is fragmented. Memory data is HIGH-sensitivity and
  retained per memory's tier; conduit data is operational and TTL-bounded;
  nexus is global; tasks is per-project. Collapsing them collapses the
  retention and privacy policies too.
- Saga T10281's premise is that the multi-DB topology stays, but the
  invariants between DBs are documented and enforced.

### §4.4 Application-layer ORM with cross-DB FK awareness

Replace `node:sqlite` + Drizzle with an ORM (Prisma, TypeORM) that knows
about multiple databases and synthesizes the cross-DB checks.

**Rejected** because:

- Drizzle is already the SSoT per ADR-068 D003 (`packages/core/src/store/`
  uses Drizzle on top of `node:sqlite`). Replacing it is a Saga-level
  decision, not a follow-up.
- Prisma/TypeORM's "multiple databases" support is single-server multi-DB
  (e.g. multiple Postgres schemas), not the multi-file SQLite topology
  CLEO uses. Their model would still require application-layer FK code
  for our case.

### §4.5 Do nothing — keep invariants in code comments

The current state: cross-DB references exist, but their invariants are
implicit. Continue.

**Rejected** because:

- The malformed brain.db incident (Saga T10281 P0) demonstrates that the
  implicit model fails: when brain.db dies, no surface answers "what
  becomes orphan?" — operators rediscover the answer each incident.
- Future schema migrations have no scan target. The next refactor will
  break another logical FK.
- This is precisely the documentation-drift failure mode ADR-068 §"Why a
  charter and not another topology amendment" rejected for per-DB
  invariants; the same reasoning applies for cross-DB invariants.

## §5 Acceptance criteria

This ADR is accepted when:

1. The five invariants (I1..I5) are catalogued with name, description,
   validation procedure, and repair action — covered in §2.
2. The summary table in §2.6 lists every invariant with source DB, target
   DB, validation surface, and repair verb — covered.
3. Out-of-scope follow-ups (T10321 drift detector, T10322 `cleo doctor
   db-substrate`, T10323 `E_PROJECT_ID_DRIFT`) are explicitly listed —
   covered in §3.3.
4. ADR moves to `Status: Accepted` once T10322 and T10323 ship and the
   invariants are validated end-to-end in production. Until then this
   ADR is `Proposed`.

## §6 Implementation pointers (informational)

For implementers picking up T10321/T10322/T10323:

- **DB inventory SSoT**: `packages/core/src/store/db-inventory.json`
  (re-exported as `DB_INVENTORY` from `@cleocode/contracts`). Each invariant's
  source/target DBs MUST be looked up here, never hard-coded.
- **Drizzle schemas**:
  - `packages/core/src/store/schema/manifest.ts` — `pipeline_manifest`
    (I2 surface A)
  - `packages/core/src/store/schema/tasks.ts` — `tasks`, `sessions`
    (FK targets for I1/I4)
  - `packages/core/src/store/llmtxt-blob-adapter.ts` — `blob_attachments`
    in manifest.db (I2 surface B)
  - `packages/core/src/store/conduit-sqlite.ts` — `delivery_jobs`,
    `dead_letters` (I5)
  - `packages/core/migrations/drizzle-brain/*` — brain.db schema (I1)
  - `packages/core/migrations/drizzle-nexus/*` — nexus.db schema (I3)
- **Open chokepoint**: `packages/core/src/store/open-cleo-db.ts` —
  `openCleoDb(role, cwd)` is the canonical site for I3's runtime gate.
- **Doctor entry point**: `packages/cleo/src/cli/commands/doctor.ts` —
  the `db-substrate` sub-verb (T10322) hangs off here.
