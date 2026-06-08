/**
 * Store-layer accessor for the Pi `SessionStorage` tree-persistence tables
 * (`pi_session_entries` + `pi_session_leaf`) — T11761 · S3 · T11899.
 *
 * This module is the ONLY place that touches the native `cleo.db` handle for Pi
 * session persistence. It lives INSIDE the store chokepoint (`packages/core/src/
 * store/**`), the Gate-3 allowlist, so it may extract the native `DatabaseSync`
 * that {@link openDualScopeDb} already holds (via drizzle's `$client`) and run
 * prepared statements over it — exactly the established `conduit-sqlite.ts`
 * pattern. It NEVER calls `new DatabaseSync(` itself.
 *
 * The durable adapter (`packages/core/src/llm/pi/pi-session-storage.ts`) sits
 * OUTSIDE the chokepoint, so it must NOT open a raw handle; it calls these
 * accessors and wraps every WRITE in `withWriterLease('project', 'bulk', …)` so
 * the daemon remains the sole arbitrated writer (ZERO authority for Pi).
 *
 * Physical model (see the `t11899-pi-session-tree` migration):
 *  - `pi_session_entries(session_id, entry_id, parent_id, type, payload_json,
 *    seq, ts)` — one row per `SessionTreeEntry`; PRIMARY KEY `(session_id,
 *    entry_id)`. `seq` is a per-session monotonic insertion ordinal that
 *    preserves append order (entry ids are random 8-char tokens, so insertion
 *    order is NOT recoverable from the id alone).
 *  - `pi_session_leaf(session_id, leaf_id, created_at, updated_at)` — one row per
 *    session recording the active tree leaf (and the session's `createdAt`
 *    metadata anchor).
 *
 * @module
 * @task T11899
 * @task T11761
 * @epic T10403
 */

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { openDualScopeDb } from './dual-scope-db.js';

/** Physical name of the Pi session-entry tree table. */
export const PI_SESSION_ENTRIES_TABLE = 'pi_session_entries' as const;

/** Physical name of the Pi session leaf-pointer / metadata table. */
export const PI_SESSION_LEAF_TABLE = 'pi_session_leaf' as const;

/**
 * A persisted Pi session-tree entry row, decoded from `pi_session_entries`.
 *
 * `payloadJson` is the JSON-serialized residue of the `SessionTreeEntry` minus
 * the columnized fields (`id` / `parentId` / `type` / `timestamp`) — the adapter
 * re-hydrates the full Pi entry by merging the columns back over it.
 */
export interface PiSessionEntryRow {
  /** Owning session id (daemon-stamped; never minted by Pi). */
  readonly sessionId: string;
  /** The Pi entry id (`SessionTreeEntry.id`). */
  readonly entryId: string;
  /** Parent entry id, or `null` at a tree root. */
  readonly parentId: string | null;
  /** The `SessionTreeEntry.type` discriminator (`message` / `leaf` / `label` / …). */
  readonly type: string;
  /** JSON residue of the entry's type-specific fields. */
  readonly payloadJson: string;
  /** Per-session monotonic insertion ordinal (preserves append order). */
  readonly seq: number;
  /** The Pi entry timestamp (`SessionTreeEntry.timestamp`, ISO-8601). */
  readonly ts: string;
}

/** The leaf-pointer + metadata row for one session. */
export interface PiSessionLeafRow {
  /** Owning session id. */
  readonly sessionId: string;
  /** The active tree leaf entry id, or `null` (no leaf yet / reset to root). */
  readonly leafId: string | null;
  /** Session creation timestamp (ISO-8601) — the metadata `createdAt` anchor. */
  readonly createdAt: string;
  /** Last leaf-update timestamp (ISO-8601). */
  readonly updatedAt: string;
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
 * Routes through {@link openDualScopeDb} (the dual-scope chokepoint) — which
 * applies the pragma SSoT, runs the consolidated migrations (creating the
 * `pi_session_*` tables), and manages the singleton cache — then extracts the
 * native handle drizzle holds on `$client`. NEVER opens a raw connection (Gate
 * 3): it reuses the handle the chokepoint already owns.
 *
 * @param cwd - Working directory for project resolution (defaults to `cwd`).
 * @returns The live native handle.
 * @throws When the chokepoint returns a handle without `$client`.
 */
export async function getPiSessionNativeDb(cwd?: string): Promise<NativeHandle> {
  const handle = await openDualScopeDb('project', cwd);
  const native = (handle.db as unknown as { $client?: DatabaseSyncType }).$client;
  if (!native) {
    throw new Error(
      'T11899: openDualScopeDb returned a project handle without $client — ' +
        'cannot extract DatabaseSync for Pi session persistence.',
    );
  }
  // The node:sqlite surface is wider than NativeStatement; narrow to what we use.
  return native as unknown as NativeHandle;
}

// ── Reads (no lease — readers operate on the shared handle) ────────────────────

/**
 * Return the leaf/metadata row for a session, or `null` when the session has no
 * row yet (never written to).
 *
 * @param native - The native project `cleo.db` handle.
 * @param sessionId - The session id.
 * @returns The leaf row or `null`.
 */
export function readPiSessionLeaf(
  native: NativeHandle,
  sessionId: string,
): PiSessionLeafRow | null {
  const row = native
    .prepare(
      `SELECT session_id, leaf_id, created_at, updated_at FROM ${PI_SESSION_LEAF_TABLE} WHERE session_id = ?`,
    )
    .get(sessionId);
  if (row === undefined) return null;
  return {
    sessionId: String(row.session_id),
    leafId: row.leaf_id === null || row.leaf_id === undefined ? null : String(row.leaf_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Return all entry rows for a session in stable append order (`seq ASC`).
 *
 * @param native - The native project `cleo.db` handle.
 * @param sessionId - The session id.
 * @returns The ordered entry rows (empty when the session has none).
 */
export function readPiSessionEntries(native: NativeHandle, sessionId: string): PiSessionEntryRow[] {
  const rows = native
    .prepare(
      `SELECT session_id, entry_id, parent_id, type, payload_json, seq, ts ` +
        `FROM ${PI_SESSION_ENTRIES_TABLE} WHERE session_id = ? ORDER BY seq ASC`,
    )
    .all(sessionId);
  return rows.map(decodeEntryRow);
}

/**
 * Return a single entry row by id, or `null` when absent.
 *
 * @param native - The native project `cleo.db` handle.
 * @param sessionId - The owning session id.
 * @param entryId - The entry id.
 * @returns The entry row or `null`.
 */
export function readPiSessionEntry(
  native: NativeHandle,
  sessionId: string,
  entryId: string,
): PiSessionEntryRow | null {
  const row = native
    .prepare(
      `SELECT session_id, entry_id, parent_id, type, payload_json, seq, ts ` +
        `FROM ${PI_SESSION_ENTRIES_TABLE} WHERE session_id = ? AND entry_id = ?`,
    )
    .get(sessionId, entryId);
  return row === undefined ? null : decodeEntryRow(row);
}

/** Decode a raw SQLite row into a typed {@link PiSessionEntryRow}. */
function decodeEntryRow(row: Record<string, unknown>): PiSessionEntryRow {
  return {
    sessionId: String(row.session_id),
    entryId: String(row.entry_id),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    type: String(row.type),
    payloadJson: String(row.payload_json),
    seq: Number(row.seq),
    ts: String(row.ts),
  };
}

// ── Writes (caller MUST hold the writer lease — see pi-session-storage.ts) ─────

/**
 * Insert (or no-op on conflict) one session-tree entry.
 *
 * The caller MUST already hold the PROJECT/`bulk` writer lease — this accessor
 * performs the raw write and does NOT acquire the lease itself (separation of
 * concerns: the lease boundary lives in `pi-session-storage.ts`, outside the
 * chokepoint). The `seq` is computed as `MAX(seq)+1` for the session under the
 * same statement batch, so it is monotonic per session.
 *
 * @param native - The native project `cleo.db` handle (leased section).
 * @param row - The entry to persist (without `seq` — assigned here).
 */
export function insertPiSessionEntry(
  native: NativeHandle,
  row: Omit<PiSessionEntryRow, 'seq'>,
): void {
  const next = native
    .prepare(
      `SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM ${PI_SESSION_ENTRIES_TABLE} WHERE session_id = ?`,
    )
    .get(row.sessionId);
  const seq = next === undefined ? 0 : Number(next.seq);
  native
    .prepare(
      `INSERT OR IGNORE INTO ${PI_SESSION_ENTRIES_TABLE} ` +
        `(session_id, entry_id, parent_id, type, payload_json, seq, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.sessionId, row.entryId, row.parentId, row.type, row.payloadJson, seq, row.ts);
}

/**
 * Upsert the leaf pointer + metadata row for a session.
 *
 * On first write the `created_at` anchor is set to `createdAt`; subsequent writes
 * preserve the existing `created_at` (via `ON CONFLICT`) and only advance
 * `leaf_id` + `updated_at`. The caller MUST hold the writer lease.
 *
 * @param native - The native project `cleo.db` handle (leased section).
 * @param sessionId - The session id.
 * @param leafId - The new active leaf id, or `null`.
 * @param createdAt - The session creation anchor (used only on first insert).
 * @param updatedAt - The update timestamp.
 */
export function upsertPiSessionLeaf(
  native: NativeHandle,
  sessionId: string,
  leafId: string | null,
  createdAt: string,
  updatedAt: string,
): void {
  native
    .prepare(
      `INSERT INTO ${PI_SESSION_LEAF_TABLE} (session_id, leaf_id, created_at, updated_at) ` +
        `VALUES (?, ?, ?, ?) ` +
        `ON CONFLICT(session_id) DO UPDATE SET leaf_id = excluded.leaf_id, updated_at = excluded.updated_at`,
    )
    .run(sessionId, leafId, createdAt, updatedAt);
}
