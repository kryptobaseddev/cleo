/**
 * Project-scope `cleo.db` — consolidated **tasks-core (batch 2)** domain slice.
 *
 * Part of the consolidated PROJECT-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11360). Target-shape
 * authoring only — physical names carry the `tasks_` domain prefix. The live
 * runtime modules (`schema/background-jobs.ts`, `schema/experiments.ts`,
 * `schema/evidence-bindings.ts`, the `task_labels` junction in `schema/tasks.ts`)
 * keep their UNPREFIXED names until the exodus migration (T11248) swaps the
 * substrate.
 *
 * This batch covers four clean, self-contained tasks-core satellite tables:
 *   - `tasks_background_jobs`    ← `background_jobs`  (§4 epoch + §7 idempotency)
 *   - `tasks_experiments`        ← `experiments`
 *   - `tasks_evidence_ac_bindings` ← `evidence_ac_bindings`
 *   - `tasks_task_labels`        ← `task_labels`      (AC4 junction, E4 pattern)
 *
 * ## E10 §4 — epoch → canonical TEXT ISO8601
 *
 * `background_jobs.{started_at,completed_at,heartbeat_at}` were raw `integer(...)`
 * epoch columns. In the target shape they are canonical `text(...)` ISO8601.
 *
 * **§8.1 epoch-unit disambiguation (RESOLVED).** Reading the writer
 * (`packages/core/src/store/background-jobs.ts`) settles the unit: it writes
 * `Date.now()` — **milliseconds** — and reads back via
 * `new Date(row.startedAt).toISOString()`. So (unlike the conduit domain, which
 * is seconds) the exodus epoch→ISO8601 conversion for these three columns uses
 * the **ms divisor**: `strftime('%Y-%m-%dT%H:%M:%fZ', col/1000, 'unixepoch')`.
 * This resolves §8 item 1 for the background-jobs columns.
 *
 * ## E10 §5 — enum (already conformant, preserved)
 *
 * `background_jobs.status` → `{ enum: BACKGROUND_JOB_STATUSES }`;
 * `evidence_ac_bindings.binding_type` → `{ enum: EVIDENCE_BINDING_TYPES }`.
 * Both reference the named const arrays already exported from the live modules
 * (§5a — identifier, never literal).
 *
 * ## E10 §6 / AC4 — JSON + junction
 *
 * `experiments.metrics_delta_json` stays serialized TEXT per the JSON-Column
 * Audit. `tasks_task_labels` is the membership junction (E4 pattern, AC4) —
 * `(task_id, label)` composite PK + a label index — mirroring the shape already
 * on main (`task_labels`); no new JSON pattern is invented. `task_id` is a
 * cross-table FK into `tasks_tasks` resolved by the exodus prefixer; carried
 * here as a plain TEXT id since `tasks_tasks` is not in this batch.
 *
 * ## E10 §7 — idempotency key (Pattern A)
 *
 * `tasks_background_jobs` gains a nullable `idempotency_key TEXT` + UNIQUE
 * index. Per the canonical report §7 the key coalesces a re-submitted job on
 * `(job_type, payload_hash)`; the column holds that caller-computed stable key
 * and a redelivered claim is a no-op via `onConflictDoNothing` (UNIQUE ignores
 * NULLs, so legacy / un-keyed jobs are unaffected).
 *
 * @task T11360
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §4 · §5 · §6 · §7 · §8.1
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 */

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { BACKGROUND_JOB_STATUSES } from '../background-jobs.js';
import { EVIDENCE_BINDING_TYPES } from '../evidence-bindings.js';

/**
 * `tasks_background_jobs` — durable background job rows.
 *
 * Domain-prefixed target of the legacy `background_jobs` table. Jobs survive
 * process restart; a `running` row at startup is transitioned to `orphaned`.
 *
 * @task T11360 (target shape) · T641 (original)
 */
export const tasksBackgroundJobs = sqliteTable(
  'tasks_background_jobs',
  {
    /** Unique job identifier (UUID v4). */
    id: text('id').primaryKey(),
    /** Operation name, e.g. "nexus.analyze" or "tasks.sync.reconcile". */
    operation: text('operation').notNull(),
    /** Current lifecycle status — CHECK-backed via {@link BACKGROUND_JOB_STATUSES}. */
    status: text('status', { enum: BACKGROUND_JOB_STATUSES }).notNull().default('pending'),
    /** ISO-8601 UTC creation instant (was ms epoch, §4 / §8.1). */
    startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC completion instant; NULL while running (was ms epoch, §4). */
    completedAt: text('completed_at'),
    /** JSON-serialised result payload; NULL on failure or while running (TEXT). */
    result: text('result'),
    /** Human-readable error message; NULL on success or while running. */
    error: text('error'),
    /** Execution progress 0-100; NULL until progress is reported. */
    progress: integer('progress'),
    /** ISO-8601 UTC last-heartbeat instant (was ms epoch, §4 / §8.1). */
    heartbeatAt: text('heartbeat_at').notNull().default(sql`(datetime('now'))`),
    /** Agent or session ID that claimed this job; NULL if unclaimed. */
    claimedBy: text('claimed_by'),
    /**
     * Caller-computed stable idempotency key (§7 Pattern A), keyed on
     * `(job_type, payload_hash)`, so a re-submitted job coalesces; NULL for
     * legacy / un-keyed jobs. UNIQUE ignores NULLs.
     */
    idempotencyKey: text('idempotency_key'),
  },
  (table) => [
    index('idx_tasks_background_jobs_status').on(table.status),
    index('idx_tasks_background_jobs_operation').on(table.operation),
    index('idx_tasks_background_jobs_claimed_by').on(table.claimedBy),
    index('idx_tasks_background_jobs_started_at').on(table.startedAt),
    unique('uq_tasks_background_jobs_idempotency_key').on(table.idempotencyKey),
  ],
);

/**
 * `tasks_experiments` — experiment metadata side-table, keyed 1:1 to a task.
 *
 * Domain-prefixed target of the legacy `experiments` table. `task_id` is a
 * cross-table FK into `tasks_tasks` resolved by the exodus prefixer; carried
 * here as a plain TEXT id (PK).
 *
 * @task T11360 (target shape) · T944 (original)
 */
export const tasksExperiments = sqliteTable(
  'tasks_experiments',
  {
    /** Owning task ID (PK; FK → `tasks_tasks.id` resolved at exodus). */
    taskId: text('task_id').primaryKey(),
    /** Git branch used as the experiment sandbox (nullable until created). */
    sandboxBranch: text('sandbox_branch'),
    /** Baseline commit SHA the experiment forked from. */
    baselineCommit: text('baseline_commit'),
    /** ISO-8601 UTC merge-back instant; NULL = open (already canonical TEXT, §4). */
    mergedAt: text('merged_at'),
    /** Optional receipt ID linking to an audit/receipt record. */
    receiptId: text('receipt_id'),
    /** JSON-serialised metrics delta (TEXT per JSON audit). */
    metricsDeltaJson: text('metrics_delta_json'),
    /** ISO-8601 UTC creation instant (already canonical TEXT, §4). */
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    /** ISO-8601 UTC last-update instant (already canonical TEXT, §4). */
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_tasks_experiments_merged').on(table.mergedAt)],
);

/**
 * `tasks_evidence_ac_bindings` — M:N join between evidence atoms and ACs.
 *
 * Domain-prefixed target of the legacy `evidence_ac_bindings` table. `ac_id`
 * is a cross-table FK into `tasks_task_acceptance_criteria` resolved by the
 * exodus prefixer; carried here as a plain TEXT id. `evidence_atom_id` is NOT
 * an FK (atoms are derived, not stored normalised).
 *
 * @task T11360 (target shape) · T10503 (original)
 */
export const tasksEvidenceAcBindings = sqliteTable(
  'tasks_evidence_ac_bindings',
  {
    /** UUIDv4 — set by the writer. */
    id: text('id').primaryKey(),
    /** Stable hash / composite key of the evidence atom. NOT an FK. */
    evidenceAtomId: text('evidence_atom_id').notNull(),
    /** FK → `tasks_task_acceptance_criteria.id` (resolved at exodus). */
    acId: text('ac_id').notNull(),
    /** One of {direct, satisfies, coverage} — CHECK-backed via {@link EVIDENCE_BINDING_TYPES}. */
    bindingType: text('binding_type', { enum: EVIDENCE_BINDING_TYPES }).notNull(),
    /** ISO-8601 UTC binding-creation instant (already canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex('uq_tasks_evidence_ac_bindings_atom_ac_type').on(
      table.evidenceAtomId,
      table.acId,
      table.bindingType,
    ),
    index('idx_tasks_evidence_ac_bindings_ac_id').on(table.acId),
    index('idx_tasks_evidence_ac_bindings_evidence_atom_id').on(table.evidenceAtomId),
  ],
);

/**
 * `tasks_task_labels` — membership junction for task labels (AC4 · E4 pattern).
 *
 * Domain-prefixed target of the legacy `task_labels` junction (T11356). The
 * membership-query SSoT that replaces the fragile `labels_json LIKE '%label%'`
 * filters (§6c). `(task_id, label)` is the natural composite identity — a label
 * appears at most once per task. `task_id` is a cross-table FK into
 * `tasks_tasks` resolved by the exodus prefixer; carried here as a plain TEXT
 * id (the live junction's `ON DELETE CASCADE` is re-applied at exodus once
 * `tasks_tasks` is present in the same file).
 *
 * @task T11360 (target shape) · T11356 (original)
 */
export const tasksTaskLabels = sqliteTable(
  'tasks_task_labels',
  {
    /** Owning task id (FK → `tasks_tasks.id` resolved at exodus). */
    taskId: text('task_id').notNull(),
    /** A single label string (one row per label). */
    label: text('label').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.label] }),
    index('idx_tasks_task_labels_label').on(table.label),
  ],
);

// === TYPE EXPORTS ===

/** Row type for `tasks_background_jobs` SELECT queries (target shape). */
export type TasksBackgroundJobRow = typeof tasksBackgroundJobs.$inferSelect;
/** Row type for `tasks_background_jobs` INSERT operations (target shape). */
export type NewTasksBackgroundJobRow = typeof tasksBackgroundJobs.$inferInsert;
/** Row type for `tasks_experiments` SELECT queries (target shape). */
export type TasksExperimentRow = typeof tasksExperiments.$inferSelect;
/** Row type for `tasks_experiments` INSERT operations (target shape). */
export type NewTasksExperimentRow = typeof tasksExperiments.$inferInsert;
/** Row type for `tasks_evidence_ac_bindings` SELECT queries (target shape). */
export type TasksEvidenceAcBindingRow = typeof tasksEvidenceAcBindings.$inferSelect;
/** Row type for `tasks_evidence_ac_bindings` INSERT operations (target shape). */
export type NewTasksEvidenceAcBindingRow = typeof tasksEvidenceAcBindings.$inferInsert;
/** Row type for `tasks_task_labels` SELECT queries (target shape). */
export type TasksTaskLabelRow = typeof tasksTaskLabels.$inferSelect;
/** Row type for `tasks_task_labels` INSERT operations (target shape). */
export type NewTasksTaskLabelRow = typeof tasksTaskLabels.$inferInsert;
