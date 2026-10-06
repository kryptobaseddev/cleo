/**
 * Types of the pure merge engine (T12344, journal spec §3.2 "T12344 owns every
 * merge decision", §1.6, §1.7, §3.6).
 *
 * The engine decides, for one incoming op against the stream-derived state of
 * one row, which fields to write, whether the row is inserted or deleted, and
 * which conflicts to record. It never touches a database: the apply frame
 * (a later slice) turns an {@link OpOutcome} into writes and row meta.
 *
 * @module store/sync/merge/types
 * @task T12344
 */

import type { LedgerWireValue } from '@cleocode/contracts/ledger';

/** One column's merged value and the HLC of the write that set it. */
export interface FieldState {
  readonly value: LedgerWireValue;
  /** Encoded HLC of the winning write. */
  readonly hlc: string;
  /**
   * Encoded HLC of the latest explicit leave of an absorbing state on this
   * column (a reopen, restore …). An absorbing value older than it does not
   * override the column (see `absorbing` in {@link FieldRule}).
   */
  readonly leave?: string;
  /**
   * `rank-max` columns only: the alive candidate writes that no other alive
   * write dominates (higher or equal rank AND newer or equal HLC), oldest
   * first; `value`/`hlc` are the best of them by (rank, HLC). Absent when the
   * current value is the only candidate. A restore raises `leave`, which
   * kills every candidate older than it, so the next best is still known
   * whatever order the writes arrive in.
   */
  readonly frontier?: ReadonlyArray<{ readonly value: LedgerWireValue; readonly hlc: string }>;
  /**
   * The value is imposed by a terminal status (`TableMergeSpec.coupled`,
   * T13243), not a write: it is never a rank-max candidate, and the column's
   * real candidates stay in `frontier`, so the value it returns to when the
   * status leaves is the same in every order.
   */
  readonly derived?: true;
}

/**
 * The stream-derived state of one row: live with its fields, tombstoned, or
 * never seen (not live, no tombstone).
 */
export interface RowState {
  readonly live: boolean;
  /** Encoded HLC of the delete when the row is tombstoned; null otherwise. */
  readonly tombstone: string | null;
  /** Per-column state of a live row; empty otherwise. */
  readonly fields: Readonly<Record<string, FieldState>>;
}

/** A row the stream has never mentioned. */
export const UNSEEN_ROW: RowState = Object.freeze({ live: false, tombstone: null, fields: {} });

/**
 * A typed merge rule on one column (§3.6, inventory §3.6.6). Order-sensitive
 * rules are evaluated against the stream-derived state at the op's stream
 * position (§3.5 Rule 1), so every replica decides the same way.
 */
export type FieldRule =
  | {
      /**
       * States the column cannot leave without an explicit op (task status
       * done/cancelled/archived …). A non-absorbing write onto an absorbing
       * value is refused unless the transaction's `actor.op` is a leave op;
       * an absorbing write overrides a newer non-absorbing value unless an
       * explicit leave newer than it set the current value.
       */
      readonly kind: 'absorbing';
      readonly id: string;
      readonly states: readonly string[];
      readonly leaveOps: readonly string[];
    }
  | {
      /**
       * The column is the maximum of its writes by (rank in `order`, then
       * HLC), pipeline_stage by STAGE_ORDER: a max over a total order, so it
       * converges in every order, and the winner keeps its OWN HLC. NULL and
       * unranked values rank below every ranked one. A write whose
       * transaction's `actor.op` is a restore op raises the column's floor
       * (`FieldState.leave`) to its HLC: every write older than the floor is
       * dead, and the best alive write wins (see `FieldState.frontier`).
       */
      readonly kind: 'rank-max';
      readonly id: string;
      readonly order: readonly string[];
      readonly restoreOps: readonly string[];
    }
  | {
      /**
       * The column is frozen while `column` holds one of `values`
       * (verification_json once status = done). A write is refused unless the
       * transaction's `actor.op` is an unfreeze op.
       */
      readonly kind: 'frozen-while';
      readonly id: string;
      readonly column: string;
      readonly values: readonly string[];
      readonly unfreezeOps: readonly string[];
    }
  | {
      /** The column is set once; a different later value is refused. */
      readonly kind: 'write-once';
      readonly id: string;
    };

/** How a counter column (`SYNC_COUNTER_COLUMNS`) merges its deltas. */
export type CounterMode = 'sum' | 'max' | 'min';

/** Everything the engine needs to know about one sync-set table. */
export interface TableMergeSpec {
  /** The columns this replica's schema has; an op naming another is refused. */
  readonly columns: readonly string[];
  /** Counter columns and how they merge; never plain LWW. */
  readonly counters?: Readonly<Record<string, CounterMode>>;
  /** Columns that merge as one LWW unit, all taken from the winning op. */
  readonly groups?: readonly (readonly string[])[];
  /** Typed rules by column. */
  readonly rules?: Readonly<Record<string, FieldRule>>;
  /**
   * Columns a terminal status fixes (T13243): whenever the merged `status`
   * column holds a key of `map`, `column` shows the mapped value, so the two
   * never disagree after a race (a task done with stage `cancelled`). The
   * column's own rank-max candidates are kept underneath (`FieldState.derived`),
   * so its value is a function of the merged status and candidates alone,
   * and converges.
   */
  readonly coupled?: ReadonlyArray<{
    readonly column: string;
    readonly status: string;
    readonly map: Readonly<Record<string, string>>;
  }>;
}

/** The transaction-level context an op is applied in. */
export interface MergeContext {
  readonly table: TableMergeSpec;
  /** The transaction's `actor.op` (command), which explicit-leave rules read. */
  readonly actorOp?: string | null;
}

/** The kinds of conflict the engine records (`ConflictSummary.byKind`, §3.2). */
export type MergeConflictKind =
  /** A concurrent edit of the same field with a different value (seen via the before-image). */
  | 'field'
  /** A typed merge rule refused or overrode a write. */
  | 'typed-rule'
  /** An update of a row the stream has deleted: the op is voided and stays revivable. */
  | 'edit-vs-delete'
  /** A delete of a row whose fields carry newer writes than the delete. */
  | 'delete-vs-edit'
  /** (applier) A reference to a deleted row: the op is voided and stays revivable. */
  | 'dangling-ref'
  /** (applier) A guard trigger or constraint aborted the op's write: voided, revivable. */
  | 'guard'
  /** (applier) A parent delete whose sync-set children remain: the delete is voided. */
  | 'delete-with-live-children'
  /** (applier) A re-key onto a uid another live row holds: voided. */
  | 'uid-collision'
  /** (applier) A Gate C post-apply invariant broke: the whole transaction is voided. */
  | 'post-apply';

/** One recorded conflict. Never silently dropped: the applier persists it. */
export interface MergeConflict {
  readonly kind: MergeConflictKind;
  readonly table: string;
  readonly uid: string;
  readonly columns: readonly string[];
  /** The typed rule, for `typed-rule`. */
  readonly rule?: string;
  /** What happened to the incoming values of `columns`. */
  readonly resolution: 'incoming-applied' | 'incoming-dropped' | 'row-deleted' | 'op-voided';
  readonly opHlc: string;
  /** The local HLC the op was compared against, when there was one. */
  readonly localHlc?: string;
}

/** Why a column of the op was not written. */
export type SkipReason = 'older' | 'rule';

/** What the engine decided for one op. */
export interface OpOutcome {
  /**
   * - `applied`: every carried column (or the insert/delete) took effect;
   * - `partial`: some columns took effect;
   * - `skipped`: nothing changed because the op is older than what the row holds;
   * - `void`: refused (typed rule or edit-vs-delete); revivable;
   * - `pending`: an update of a row never seen; the receiver holds it;
   * - `refused-schema`: the op names a column this schema does not have.
   */
  readonly status: 'applied' | 'partial' | 'skipped' | 'void' | 'pending' | 'refused-schema';
  /** The row after the op. */
  readonly next: RowState;
  /** The row-level effect for the applier. */
  readonly effect: 'insert' | 'update' | 'delete' | 'tombstone' | 'none';
  /** Columns written (insert: every column of the new row; update: changed columns). */
  readonly written: readonly string[];
  readonly skipped: ReadonlyArray<{ readonly column: string; readonly reason: SkipReason }>;
  readonly conflicts: readonly MergeConflict[];
  /** For `refused-schema`: the columns this schema lacks. */
  readonly unknownColumns?: readonly string[];
  /**
   * For `refused-schema`: columns whose value their merge cannot take (a
   * `$inc` on a column that is not a `sum` counter, an absolute value on a
   * `sum` counter in a U, a non-number on a `max`/`min` counter), and the members a
   * U op leaves out of a merge group it carries part of. A current sealer
   * emits none of these.
   */
  readonly malformed?: readonly string[];
}
