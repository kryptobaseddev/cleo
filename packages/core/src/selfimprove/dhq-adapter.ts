/**
 * Durable DHQ adapter for the self-improvement loop (T11889 · T11889-C).
 *
 * This adapter sits OUTSIDE the store chokepoint (it is in `selfimprove/`, not
 * `store/`), so it MUST NOT open a raw native handle (Gate-3). It is the lease
 * boundary: EVERY write it performs is wrapped in
 * {@link "../store/writer-lease.js".withWriterLease}`('project', 'bulk', …)`, which
 * serializes the write against any other writer on the `(project, bulk)` lane. It
 * then calls the Gate-3 accessors in
 * {@link "../store/selfimprove-dhq-store.js"} (the ONLY native-handle toucher) —
 * whose prepared statements target ONLY `selfimprove_dhq`.
 *
 * Two invariants the rest of the loop relies on:
 *
 *   1. **No raw / unleased write.** Reads go straight through the accessor (the
 *      shared handle, no lease); every WRITE goes through {@link upsertOpenDhq} /
 *      {@link recordPrUrl}, both of which acquire the lease first. There is no
 *      code path here that mutates `cleo.db` without the lease.
 *   2. **`selfimprove_dhq` ONLY — never a prod `tasks`/`brain` row.** The lease
 *      SERIALIZES the write; it does NOT confine it to a table. The
 *      table-confinement is ENTIRELY this adapter's discipline: it calls only the
 *      `selfimprove_dhq` accessors, whose SQL references no other table. A unit
 *      test asserts the accessor SQL targets `selfimprove_dhq` and nothing else.
 *
 * Lease-mode note (P5 spec §B.7): the default mode is `local` (no daemon), where a
 * contended lease DEGRADES under `busy_timeout` rather than throwing. To get a hard
 * denial signal for the circuit-breaker, the process runs in `require` mode
 * (`CLEO_WRITER_LEASE_MODE=require`), where an unacquirable lease THROWS
 * {@link "../store/writer-lease.js".LeaseUnavailableError}. This adapter does NOT
 * swallow that throw — it propagates so {@link runSelfImprove} trips the breaker.
 *
 * This module is import-time side-effect-free.
 *
 * @module @cleocode/core/selfimprove/dhq-adapter
 * @epic T11889
 * @task T11913
 */

import {
  getSelfimproveDhqNativeDb,
  readOpenSelfimproveDhq,
  type SelfimproveDhqRow,
  type SelfimproveDhqUpsert,
  setSelfimproveDhqPrUrl,
  upsertOpenSelfimproveDhq,
} from '../store/selfimprove-dhq-store.js';
import { withWriterLease } from '../store/writer-lease.js';

/**
 * The fields the engine supplies to {@link upsertOpenDhq}. `now` and the fixed
 * `status: 'open'` are stamped by the accessor; `dhqId` / `severity` carry through.
 */
export interface UpsertDhqInput {
  /** Stable `'DHQ-###'` handle (used only on first insert for a hash). */
  readonly dhqId: string;
  /** The scenario name replayed. */
  readonly scenario: string;
  /** sha256 of the normalized regression signature — the idempotency key. */
  readonly questionHash: string;
  /** Human-readable DHQ title. */
  readonly title: string;
  /** The envelope-diff payload (the evidence) as serialized JSON. */
  readonly regressionJson: string;
  /** Severity classification, or `null` until triaged. */
  readonly severity: string | null;
  /** Ties the row to ONE loop run. */
  readonly runId: string;
}

/** The durable DHQ adapter — the lease boundary for the self-improvement loop. */
export interface DhqAdapter {
  /**
   * Read the open DHQ row for a `question_hash` (lease-free — readers share the
   * handle). Returns `null` when no open row exists.
   */
  readOpen(questionHash: string): Promise<SelfimproveDhqRow | null>;
  /**
   * UPSERT exactly ONE open DHQ row for a `question_hash`, under the
   * `(project, bulk)` writer lease. Idempotent via the partial-UNIQUE index: a
   * repeated open regression refreshes the existing row.
   */
  upsertOpenDhq(input: UpsertDhqInput): Promise<void>;
  /**
   * Record the draft PR URL on the open DHQ row for a `question_hash`, under the
   * `(project, bulk)` writer lease.
   *
   * @returns The number of rows updated (0 when no open row exists).
   */
  recordPrUrl(questionHash: string, prUrl: string): Promise<number>;
}

/**
 * Construct the durable DHQ adapter bound to a project working directory.
 *
 * Every WRITE method acquires the `(project, bulk)` writer lease via
 * {@link "../store/writer-lease.js".withWriterLease} before delegating to the
 * Gate-3 accessor. The native handle is resolved per call through
 * {@link "../store/selfimprove-dhq-store.js".getSelfimproveDhqNativeDb} (the
 * chokepoint singleton — no raw open). The clock is injectable for deterministic
 * tests; production uses `Date.now`.
 *
 * @param opts - Adapter options.
 * @param opts.cwd - Project working directory for scope resolution (defaults to `cwd`).
 * @param opts.now - Injectable clock (defaults to {@link Date.now}).
 * @returns A {@link DhqAdapter}.
 *
 * @example
 * ```ts
 * const adapter = createDhqAdapter({ cwd: projectRoot });
 * await adapter.upsertOpenDhq({ dhqId: 'DHQ-001', … }); // leased UPSERT
 * ```
 */
export function createDhqAdapter(opts: { cwd?: string; now?: () => number } = {}): DhqAdapter {
  const cwd = opts.cwd;
  const now = opts.now ?? (() => Date.now());

  return {
    async readOpen(questionHash: string): Promise<SelfimproveDhqRow | null> {
      const native = await getSelfimproveDhqNativeDb(cwd);
      return readOpenSelfimproveDhq(native, questionHash);
    },

    async upsertOpenDhq(input: UpsertDhqInput): Promise<void> {
      // EVERY write is leased — never raw / unleased. The lease serializes against
      // other writers on (project, bulk); the table-confinement is the accessor's.
      await withWriterLease('project', 'bulk', async () => {
        const native = await getSelfimproveDhqNativeDb(cwd);
        const row: SelfimproveDhqUpsert = {
          dhqId: input.dhqId,
          scenario: input.scenario,
          questionHash: input.questionHash,
          title: input.title,
          regressionJson: input.regressionJson,
          severity: input.severity,
          runId: input.runId,
          now: now(),
        };
        upsertOpenSelfimproveDhq(native, row);
      });
    },

    async recordPrUrl(questionHash: string, prUrl: string): Promise<number> {
      return withWriterLease('project', 'bulk', async () => {
        const native = await getSelfimproveDhqNativeDb(cwd);
        return setSelfimproveDhqPrUrl(native, questionHash, prUrl, now());
      });
    },
  };
}
