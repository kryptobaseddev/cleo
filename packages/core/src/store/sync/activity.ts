/**
 * Journal activity: what each device changed and when, read from this
 * store's journal inbox (T13369).
 *
 * Every transaction a pull stages is an `_sync_inbox` row carrying the
 * writing replica, the Nexus device that signed its segment, the
 * transaction's HLC (its write time) and the times this store staged and
 * applied it. Own transactions come back through the same inbox as echoes,
 * so the inbox shows every device on the stream, this one included.
 *
 * A transaction its replica wrote after a server-confirmed retire is marked
 * `history` once applied (§1.5, T13366): the merge recorded no conflict for it.
 *
 * The inbox is the window: applied rows pruned after a verified checkpoint
 * are no longer listed. Read-only: nothing is written.
 *
 * @task T13369
 * @module store/sync/activity
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  CloudJournalActivityDevice,
  CloudJournalActivityItem,
  CloudJournalTableOps,
} from '@cleocode/contracts';
import { getStableDeviceId } from '../../llm/stable-device-id.js';
import { parseHlc } from './hlc.js';
import { isInheritedHistory } from './retire.js';
import { hasTable } from './schema.js';

/** Largest page {@link journalActivity} returns. */
export const JOURNAL_ACTIVITY_PAGE_MAX = 200;

/** Options of {@link journalActivity}. */
export interface JournalActivityOptions {
  /** Transactions to return (1..200, default 50). */
  readonly limit?: number;
  /** Older page: the `nextBefore` of a previous call. */
  readonly before?: string;
  /** Only transactions signed by this Nexus device id. */
  readonly deviceId?: string;
  /** Only transactions written at or after this instant (ms since the epoch). */
  readonly sinceMs?: number;
  /** Only transactions for this project id. */
  readonly project?: string;
  /** Device names by Nexus device id (from the account's device list). */
  readonly deviceNames?: ReadonlyMap<string, string>;
  /** This machine's stable device id (default: the persisted one). */
  readonly localDeviceId?: string;
}

/** What {@link journalActivity} returns. */
export interface JournalActivityPage {
  readonly items: CloudJournalActivityItem[];
  readonly devices: CloudJournalActivityDevice[];
  readonly nextBefore: string | null;
}

/** Thrown for a `before` cursor this module did not issue. */
export class JournalActivityCursorError extends Error {
  readonly code = 'E_VALIDATION';
  constructor(cursor: string) {
    super(`not a journal activity cursor: ${cursor}`);
    this.name = 'JournalActivityCursorError';
  }
}

interface Cursor {
  readonly hlc: string;
  readonly stream: string;
  readonly seq: number;
  readonly txnIdx: number;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.hlc, c.stream, c.seq, c.txnIdx]), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(raw: string): Cursor {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(v) &&
      v.length === 4 &&
      typeof v[0] === 'string' &&
      typeof v[1] === 'string' &&
      Number.isSafeInteger(v[2]) &&
      Number.isSafeInteger(v[3])
    ) {
      return { hlc: v[0], stream: v[1], seq: v[2] as number, txnIdx: v[3] as number };
    }
  } catch {
    // Falls through to the refusal.
  }
  // @sync-invariant none:input-shape a read-only listing refuses a cursor it did not issue
  throw new JournalActivityCursorError(raw);
}

/** The HLC's physical time as ISO-8601, or the raw HLC when it does not parse. */
function hlcTime(hlc: string): string {
  try {
    return new Date(parseHlc(hlc).phys).toISOString();
  } catch {
    return hlc;
  }
}

/** The replicas this machine bound in this store. */
function ownReplicas(db: DatabaseSync, localDeviceId: string): Set<string> {
  if (!hasTable(db, '_sync_replica')) return new Set();
  const rows = db
    .prepare('SELECT replica_id FROM _sync_replica WHERE device_id = ?')
    .all(localDeviceId) as Array<{ replica_id: string }>;
  return new Set(rows.map((r) => r.replica_id));
}

type TxnShape = {
  txn?: unknown;
  kind?: unknown;
  via?: unknown;
  actor?: unknown;
  project?: unknown;
  ops?: unknown;
};

function summarise(txnJson: string): {
  txn: string;
  kind: string;
  via: string;
  actor: CloudJournalActivityItem['actor'];
  project: string | null;
  ops: number;
  tables: Record<string, CloudJournalTableOps>;
} {
  let t: TxnShape = {};
  try {
    const parsed: unknown = JSON.parse(txnJson);
    if (parsed !== null && typeof parsed === 'object') t = parsed as TxnShape;
  } catch {
    // A row the stager accepted always parses; an unreadable one shows empty.
  }
  const tables: Record<string, CloudJournalTableOps> = {};
  const ops = Array.isArray(t.ops) ? t.ops : [];
  for (const op of ops) {
    if (op === null || typeof op !== 'object') continue;
    const { t: table, o } = op as { t?: unknown; o?: unknown };
    if (typeof table !== 'string' || (o !== 'I' && o !== 'U' && o !== 'D' && o !== 'K')) continue;
    tables[table] ??= { I: 0, U: 0, D: 0, K: 0 };
    tables[table][o] += 1;
  }
  const actor =
    t.actor !== null && typeof t.actor === 'object'
      ? (Object.fromEntries(
          Object.entries(t.actor as Record<string, unknown>).filter(
            ([, v]) => typeof v === 'string',
          ),
        ) as CloudJournalActivityItem['actor'])
      : null;
  return {
    txn: typeof t.txn === 'string' ? t.txn : '',
    kind: typeof t.kind === 'string' ? t.kind : '',
    via: typeof t.via === 'string' ? t.via : '',
    actor,
    project: typeof t.project === 'string' ? t.project : null,
    ops: ops.length,
    tables,
  };
}

/** The WHERE clause and parameters of the filters (the cursor excluded). */
function filters(opts: JournalActivityOptions): { where: string[]; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.deviceId !== undefined) {
    where.push('device_id = ?');
    params.push(opts.deviceId);
  }
  if (opts.sinceMs !== undefined) {
    // HLCs sort lexically by physical time; a bare 13-digit prefix sorts first.
    where.push('hlc >= ?');
    params.push(String(Math.max(0, Math.trunc(opts.sinceMs))).padStart(13, '0'));
  }
  if (opts.project !== undefined) {
    where.push("json_extract(txn_json, '$.project') = ?");
    params.push(opts.project);
  }
  return { where, params };
}

/**
 * List the transactions this store's journal received, newest first (by
 * HLC), with the device that wrote each one and a per-device summary.
 *
 * @param db - The store.
 * @param opts - Paging and filters.
 * @returns A page of transactions, the per-device summary and the next cursor.
 * @throws {JournalActivityCursorError} When `before` is not a cursor this module issued.
 */
export function journalActivity(
  db: DatabaseSync,
  opts: JournalActivityOptions = {},
): JournalActivityPage {
  if (!hasTable(db, '_sync_inbox')) return { items: [], devices: [], nextBefore: null };
  const requested =
    opts.limit !== undefined && Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 50;
  const limit = Math.min(Math.max(requested, 1), JOURNAL_ACTIVITY_PAGE_MAX);
  const own = ownReplicas(db, opts.localDeviceId ?? getStableDeviceId());
  const names = opts.deviceNames ?? new Map<string, string>();
  const { where, params } = filters(opts);

  const devRows = db
    .prepare(
      `SELECT device_id, replica_id, count(*) AS n, max(hlc) AS last
         FROM _sync_inbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY device_id, replica_id`,
    )
    .all(...params) as Array<{ device_id: string; replica_id: string; n: number; last: string }>;
  const byDevice = new Map<string, { txns: number; last: string; mine: boolean }>();
  for (const r of devRows) {
    const d = byDevice.get(r.device_id) ?? { txns: 0, last: '', mine: false };
    d.txns += Number(r.n);
    if (r.last > d.last) d.last = r.last;
    if (own.has(r.replica_id)) d.mine = true;
    byDevice.set(r.device_id, d);
  }
  const devices = [...byDevice.entries()]
    .sort((a, b) => (a[1].last < b[1].last ? 1 : a[1].last > b[1].last ? -1 : 0))
    .map(([deviceId, d]) => ({
      deviceId,
      deviceName: names.get(deviceId) ?? null,
      thisDevice: d.mine,
      txns: d.txns,
      lastAt: hlcTime(d.last),
    }));

  const pageWhere = [...where];
  const pageParams = [...params];
  if (opts.before !== undefined) {
    const c = decodeCursor(opts.before);
    pageWhere.push('(hlc, stream, seq, txn_idx) < (?, ?, ?, ?)');
    pageParams.push(c.hlc, c.stream, c.seq, c.txnIdx);
  }
  const rows = db
    .prepare(
      `SELECT stream, seq, txn_idx, replica_id, device_id, txn_json, hlc, status, reason,
              staged_at, applied_at
         FROM _sync_inbox ${pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : ''}
        ORDER BY hlc DESC, stream DESC, seq DESC, txn_idx DESC
        LIMIT ?`,
    )
    .all(...pageParams, limit + 1) as Array<{
    stream: string;
    seq: number;
    txn_idx: number;
    replica_id: string;
    device_id: string;
    txn_json: string;
    hlc: string;
    status: string;
    reason: string | null;
    staged_at: string;
    applied_at: string | null;
  }>;
  const page = rows.slice(0, limit);
  const items = page.map((r): CloudJournalActivityItem => {
    const s = summarise(r.txn_json);
    return {
      txn: s.txn,
      stream: r.stream,
      seq: Number(r.seq),
      txnIdx: Number(r.txn_idx),
      replicaId: r.replica_id,
      deviceId: r.device_id,
      deviceName: names.get(r.device_id) ?? null,
      thisDevice: own.has(r.replica_id),
      hlc: r.hlc,
      at: hlcTime(r.hlc),
      stagedAt: r.staged_at,
      appliedAt: r.applied_at,
      status: r.status,
      reason: r.reason,
      history:
        r.status === 'applied' && isInheritedHistory(db, r.stream, r.replica_id, Number(r.seq)),
      kind: s.kind,
      via: s.via,
      actor: s.actor,
      project: s.project,
      ops: s.ops,
      tables: s.tables,
    };
  });
  const last = page.at(-1);
  const nextBefore =
    rows.length > limit && last !== undefined
      ? encodeCursor({
          hlc: last.hlc,
          stream: last.stream,
          seq: Number(last.seq),
          txnIdx: Number(last.txn_idx),
        })
      : null;
  return { items, devices, nextBefore };
}
