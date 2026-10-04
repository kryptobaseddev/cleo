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
       * The column only moves up the given order (pipeline_stage by
       * STAGE_ORDER). A lower ranked write is dropped by the rule, unless the
       * transaction's `actor.op` is a restore op. Unranked values merge by LWW.
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
  | 'delete-vs-edit';

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
}
