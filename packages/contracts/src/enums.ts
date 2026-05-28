/**
 * Canonical task-axis enum constants.
 *
 * Single source of truth for the runtime const arrays that back the
 * task-axis discriminators (kind, scope, severity, size, archive reason,
 * relation type). Promoted from `packages/core/src/store/tasks-schema.ts`
 * in Phase 0c of the SG-ARCH-SOLID Saga so that downstream packages can
 * import the values without pulling in the Drizzle schema runtime.
 *
 * `tasks-schema.ts` imports these arrays back for Drizzle's
 * `text({ enum: ... })` column declarations, which preserves byte-identical
 * row-type narrowing and produces zero schema DDL change. `tasks-schema.ts`
 * also re-exports each constant under its original name to preserve the
 * existing public surface for every internal `import * as schema` consumer.
 *
 * The corresponding union types (`TaskKind`, `TaskScope`, `TaskSeverity`,
 * `TaskSize`, `ArchiveReasonValue`, etc.) already live in their respective
 * domain modules (`./task.ts`, `./tasks/archive.ts`) and are re-exported
 * from the package root.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9955 (Phase 0c)
 */

/**
 * Task kind axis — describes the intent of the work rather than its
 * position in the hierarchy. Defaults to `'work'` to preserve semantics
 * for tasks created before T944.
 *
 * Note: the DB column is named `role`; the TypeScript field is `kind`
 * (T9067 deferral).
 *
 * @task T944
 * @task T9072
 */
export const TASK_KINDS = ['work', 'research', 'experiment', 'bug', 'spike', 'release'] as const;

/**
 * Task scope axis — describes the granularity of the work (project-wide
 * vs. feature-scoped vs. unit-scoped). Orthogonal to type and kind.
 *
 * Backfill mapping from legacy `type` during migration:
 *   - `type='epic'`    → `scope='project'`
 *   - `type='task'`    → `scope='feature'` (also used for NULL legacy rows)
 *   - `type='subtask'` → `scope='unit'`
 *
 * @task T944
 */
export const TASK_SCOPES = ['project', 'feature', 'unit'] as const;

/**
 * Task severity axis — applies to ANY task kind (not just `kind='bug'`).
 *
 * Enforced by a CHECK constraint:
 *   `severity IS NULL OR severity IN ('P0','P1','P2','P3')`
 *
 * The original T944 constraint coupled severity to `role='bug'`. T9073
 * widened the constraint so that spikes, incidents, research tasks, and
 * any other kind can carry a severity level. Priority and severity are
 * fully orthogonal axes — setting severity does NOT auto-map to priority
 * (no SEVERITY_MAP on add/update).
 *
 * OWNER-WRITE-ONLY (T944 / T9073 / owner mandate): severity is set
 * through owner-authenticated paths only (signed attestation via
 * `appendSignedSeverityAttestation`). This prevents a prompt-injection
 * exploit where a compromised agent could mark a P0 task as P3 to
 * force-ship.
 *
 * @task T944
 * @task T9073
 */
export const TASK_SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const;

/**
 * Task size sentinel values matching the DB CHECK constraint on
 * `tasks.size`. CLEO favors qualitative sizing over time estimates
 * (see `cleo memory` rule "No time estimates").
 *
 * @task T944
 */
export const TASK_SIZES = ['small', 'medium', 'large'] as const;

/**
 * Truth-grade archive reason values enforced by a SQLite CHECK
 * constraint on `tasks.archive_reason` (see migration
 * `20260424000000_t1408-archive-reason-enum`).
 *
 * Council 2026-04-24 (FINDING #28 + T1407 follow-through) replaced the
 * legacy unconstrained TEXT column with this 6-value enum. Rows that
 * pre-dated the migration with non-conforming values (`completed`,
 * `deleted`, etc.) were normalized to `'completed-unverified'` before
 * the CHECK was applied, so EVERY existing row satisfies one of these
 * literals (or is `NULL`).
 *
 * Semantics:
 *   - `verified`             — closure passed all gates with audit-grade evidence.
 *   - `reconciled`           — closure derived by reconciliation against an
 *                              external source of truth (e.g. external task tracker).
 *   - `superseded`           — closure because another task subsumes the work.
 *   - `shadowed`             — closure because the task was experiment- or
 *                              proposal-shadowed by a newer plan.
 *   - `cancelled`            — closure via explicit cancellation
 *                              (`status='cancelled'`).
 *   - `completed-unverified` — closure happened but verification was skipped,
 *                              incomplete, or failed; metrics MUST NOT count
 *                              these as quality completions without opt-in.
 *
 * @task T1408
 * @epic T1407
 */
export const ARCHIVE_REASONS = [
  'verified',
  'reconciled',
  'superseded',
  'shadowed',
  'cancelled',
  'completed-unverified',
] as const;

/**
 * Task relation types matching the DB CHECK constraint on
 * `task_relations.relation_type`.
 *
 *   - `related`     — generic non-blocking association
 *   - `blocks`      — advisory non-blocking block context; hard scheduler
 *                     blocking belongs in `task_dependencies`
 *   - `duplicates`  — source is a duplicate of target (target is canonical)
 *   - `absorbs`     — source's work was absorbed into target
 *   - `fixes`       — source fixes target (bug→fix linkage)
 *   - `extends`     — source extends or refines target
 *   - `supersedes`  — source replaces target (target is retired)
 *   - `groups`      — soft grouping/provenance association; PM-Core V2
 *                     containment belongs in `tasks.parent_id`
 *
 * @task T944
 * @task ADR-088 (`groups` relation is non-containment only)
 */
export const TASK_RELATION_TYPES = [
  'related',
  'blocks',
  'duplicates',
  'absorbs',
  'fixes',
  'extends',
  'supersedes',
  'groups',
] as const;
