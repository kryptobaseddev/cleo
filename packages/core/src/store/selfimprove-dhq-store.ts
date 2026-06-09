/**
 * Store-layer accessor for the self-improvement DHQ table (`selfimprove_dhq`) —
 * T11889 · T11889-A · T11911.
 *
 * This module is the ONLY place that touches the native `cleo.db` handle for the
 * self-improvement loop's DHQ persistence. It lives INSIDE the store chokepoint
 * (`packages/core/src/store/**`), the Gate-3 allowlist, so it may extract the native
 * `DatabaseSync` that {@link openDualScopeDb} already holds (via drizzle's `$client`)
 * and run prepared statements over it — exactly the established `pi-session-store.ts`
 * pattern. It NEVER calls `new DatabaseSync(` itself.
 *
 * The durable adapter (`packages/core/src/selfimprove/dhq-adapter.ts`, T11889-C)
 * sits OUTSIDE the chokepoint, so it must NOT open a raw handle; it calls these
 * accessors and wraps every WRITE in `withWriterLease('project', 'bulk', …)` so the
 * write is serialized against any other writer on the `(project, bulk)` lane. The
 * lease SERIALIZES the write; the "only ever writes `selfimprove_dhq`, never a live
 * `tasks`/`brain` row" guarantee comes from this accessor's prepared statements
 * targeting ONLY `selfimprove_dhq` — adapter discipline, not the lease.
 *
 * Physical model (see the `t11889-selfimprove-dhq` migration):
 *  - `selfimprove_dhq(id, dhq_id, scenario, question_hash, title, regression_json,
 *    status, severity, pr_url, run_id, created_at, updated_at)` — one row per DHQ.
 *  - Idempotency: a raw-SQL partial-UNIQUE index `ux_selfimprove_dhq_open` keys on
 *    `question_hash WHERE status = 'open'`, so at most one open row per hash.
 *
 * @module
 * @task T11911
 * @task T11889
 * @epic T11889
 */

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { openDualScopeDb } from './dual-scope-db.js';
import {
  assertSelfimproveDhqOpenIndexPresent,
  SELFIMPROVE_DHQ_TABLE,
} from './selfimprove-dhq-schema.js';

export {
  assertSelfimproveDhqOpenIndexPresent,
  SELFIMPROVE_DHQ_OPEN_INDEX,
  SELFIMPROVE_DHQ_TABLE,
} from './selfimprove-dhq-schema.js';

/** A persisted DHQ row, decoded from `selfimprove_dhq`. */
export interface SelfimproveDhqRow {
  /** Stable `'DHQ-###'` handle for the question. */
  readonly dhqId: string;
  /** The scenario name replayed when this DHQ was raised. */
  readonly scenario: string;
  /** sha256 of the normalized regression signature — the idempotency key. */
  readonly questionHash: string;
  /** Human-readable DHQ title. */
  readonly title: string;
  /** The envelope-diff payload (the evidence) as serialized JSON. */
  readonly regressionJson: string;
  /** Lifecycle status — `'open'` while the regression is live. */
  readonly status: string;
  /** Severity classification, or `null` until triaged. */
  readonly severity: string | null;
  /** The draft PR URL once egress fires, or `null`. */
  readonly prUrl: string | null;
  /** Ties the row to ONE loop run. */
  readonly runId: string;
  /** Creation timestamp (epoch ms). */
  readonly createdAt: number;
  /** Last-update timestamp (epoch ms). */
  readonly updatedAt: number;
}

/**
 * Fields required to UPSERT one open DHQ. `status` is fixed to `'open'` by the
 * accessor (the partial-UNIQUE index keys on it); terminal-status transitions go
 * through {@link updateSelfimproveDhqStatus} instead.
 */
export interface SelfimproveDhqUpsert {
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
  /** The timestamp to stamp on insert/update (epoch ms). */
  readonly now: number;
}

/** Narrow shape of the native handle methods this accessor uses. */
type NativeRunResult = { changes: number | bigint; lastInsertRowid: number | bigint };
interface NativeStatement {
  run(...params: ReadonlyArray<string | number | null>): NativeRunResult;
  get(...params: ReadonlyArray<string | number | null>): Record<string, unknown> | undefined;
  all(...params: ReadonlyArray<string | number | null>): Array<Record<string, unknown>>;
}
interface NativeHandle {
  prepare(sql: string): NativeStatement;
}

/**
 * Extract the native `DatabaseSync` handle for the PROJECT-scope `cleo.db`.
 *
 * Routes through {@link openDualScopeDb} (the dual-scope chokepoint) — which applies
 * the pragma SSoT, runs the consolidated migrations (creating `selfimprove_dhq`),
 * and manages the singleton cache — then extracts the native handle drizzle holds on
 * `$client`. NEVER opens a raw connection (Gate 3): it reuses the handle the
 * chokepoint already owns.
 *
 * @param cwd - Working directory for project resolution (defaults to `cwd`).
 * @returns The live native handle.
 * @throws When the chokepoint returns a handle without `$client`.
 */
export async function getSelfimproveDhqNativeDb(cwd?: string): Promise<NativeHandle> {
  const handle = await openDualScopeDb('project', cwd);
  const native = (handle.db as unknown as { $client?: DatabaseSyncType }).$client;
  if (!native) {
    throw new Error(
      'T11911: openDualScopeDb returned a project handle without $client — ' +
        'cannot extract DatabaseSync for selfimprove_dhq persistence.',
    );
  }
  // The node:sqlite surface is wider than NativeHandle; narrow to what we use.
  return native as unknown as NativeHandle;
}

/** Decode a raw SQLite row into a typed {@link SelfimproveDhqRow}. */
function decodeRow(row: Record<string, unknown>): SelfimproveDhqRow {
  return {
    dhqId: String(row.dhq_id),
    scenario: String(row.scenario),
    questionHash: String(row.question_hash),
    title: String(row.title),
    regressionJson: String(row.regression_json),
    status: String(row.status),
    severity: row.severity === null || row.severity === undefined ? null : String(row.severity),
    prUrl: row.pr_url === null || row.pr_url === undefined ? null : String(row.pr_url),
    runId: String(row.run_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// ── Reads (no lease — readers operate on the shared handle) ────────────────────

/**
 * Return the open DHQ row for a `question_hash`, or `null` when none is open.
 *
 * @param native - The native project `cleo.db` handle.
 * @param questionHash - The regression-signature hash.
 * @returns The open row or `null`.
 */
export function readOpenSelfimproveDhq(
  native: NativeHandle,
  questionHash: string,
): SelfimproveDhqRow | null {
  const row = native
    .prepare(
      `SELECT id, dhq_id, scenario, question_hash, title, regression_json, status, ` +
        `severity, pr_url, run_id, created_at, updated_at ` +
        `FROM ${SELFIMPROVE_DHQ_TABLE} WHERE question_hash = ? AND status = 'open'`,
    )
    .get(questionHash);
  return row === undefined ? null : decodeRow(row);
}

/**
 * Return all DHQ rows for a scenario in stable creation order (`created_at ASC`).
 *
 * @param native - The native project `cleo.db` handle.
 * @param scenario - The scenario name.
 * @returns The ordered rows (empty when the scenario has none).
 */
export function readSelfimproveDhqByScenario(
  native: NativeHandle,
  scenario: string,
): SelfimproveDhqRow[] {
  const rows = native
    .prepare(
      `SELECT id, dhq_id, scenario, question_hash, title, regression_json, status, ` +
        `severity, pr_url, run_id, created_at, updated_at ` +
        `FROM ${SELFIMPROVE_DHQ_TABLE} WHERE scenario = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(scenario);
  return rows.map(decodeRow);
}

// ── Writes (caller MUST hold the writer lease — see dhq-adapter.ts) ────────────

/**
 * Insert (or, on a repeated open regression, refresh) exactly ONE open DHQ row for a
 * `question_hash`.
 *
 * The partial-UNIQUE index `ux_selfimprove_dhq_open (question_hash) WHERE status =
 * 'open'` makes this idempotent: a second open regression for the same hash updates
 * the existing open row's `updated_at` / `run_id` / `severity` instead of inserting a
 * duplicate. The caller MUST already hold the PROJECT/`bulk` writer lease — this
 * accessor performs the raw write and does NOT acquire the lease itself (the lease
 * boundary lives in `dhq-adapter.ts`, outside the chokepoint).
 *
 * @param native - The native project `cleo.db` handle (leased section).
 * @param row - The DHQ to upsert.
 */
export function upsertOpenSelfimproveDhq(native: NativeHandle, row: SelfimproveDhqUpsert): void {
  native
    .prepare(
      `INSERT INTO ${SELFIMPROVE_DHQ_TABLE} ` +
        `(dhq_id, scenario, question_hash, title, regression_json, status, severity, ` +
        `pr_url, run_id, created_at, updated_at) ` +
        `VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, ?, ?, ?) ` +
        `ON CONFLICT(question_hash) WHERE status = 'open' DO UPDATE SET ` +
        `regression_json = excluded.regression_json, severity = excluded.severity, ` +
        `run_id = excluded.run_id, updated_at = excluded.updated_at`,
    )
    .run(
      row.dhqId,
      row.scenario,
      row.questionHash,
      row.title,
      row.regressionJson,
      row.severity,
      row.runId,
      row.now,
      row.now,
    );
}

/**
 * Advance an open DHQ to a terminal status (e.g. `'fixed'` / `'dismissed'`) for a
 * `question_hash`. Frees the partial-UNIQUE slot so a future regression of the same
 * hash can open a new row.
 *
 * The caller MUST hold the writer lease.
 *
 * @param native - The native project `cleo.db` handle (leased section).
 * @param questionHash - The regression-signature hash whose open row to advance.
 * @param status - The new (non-open) status.
 * @param now - The update timestamp (epoch ms).
 * @returns The number of rows updated (0 when no open row exists).
 */
export function updateSelfimproveDhqStatus(
  native: NativeHandle,
  questionHash: string,
  status: string,
  now: number,
): number {
  const result = native
    .prepare(
      `UPDATE ${SELFIMPROVE_DHQ_TABLE} SET status = ?, updated_at = ? ` +
        `WHERE question_hash = ? AND status = 'open'`,
    )
    .run(status, now, questionHash);
  return Number(result.changes);
}

/**
 * Record the draft PR URL on the open DHQ row for a `question_hash`.
 *
 * The caller MUST hold the writer lease.
 *
 * @param native - The native project `cleo.db` handle (leased section).
 * @param questionHash - The regression-signature hash whose open row to annotate.
 * @param prUrl - The draft PR URL.
 * @param now - The update timestamp (epoch ms).
 * @returns The number of rows updated (0 when no open row exists).
 */
export function setSelfimproveDhqPrUrl(
  native: NativeHandle,
  questionHash: string,
  prUrl: string,
  now: number,
): number {
  const result = native
    .prepare(
      `UPDATE ${SELFIMPROVE_DHQ_TABLE} SET pr_url = ?, updated_at = ? ` +
        `WHERE question_hash = ? AND status = 'open'`,
    )
    .run(prUrl, now, questionHash);
  return Number(result.changes);
}

/**
 * Bootstrap check: open the project `cleo.db` (running migrations) and assert the
 * partial-UNIQUE open-row index is physically present.
 *
 * Convenience wrapper over {@link getSelfimproveDhqNativeDb} +
 * {@link assertSelfimproveDhqOpenIndexPresent} for callers that only have a `cwd`.
 *
 * @param cwd - Working directory for project resolution.
 * @throws `E_SELFIMPROVE_DHQ_INDEX_MISSING` if the index is absent.
 */
export async function assertSelfimproveDhqReady(cwd?: string): Promise<void> {
  const native = await getSelfimproveDhqNativeDb(cwd);
  assertSelfimproveDhqOpenIndexPresent(native as unknown as DatabaseSyncType);
}
