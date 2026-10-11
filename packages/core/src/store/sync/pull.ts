/**
 * Pull one stream's journal into the store (journal spec §3.1 "Receive",
 * §2.9; T12343 S5-1).
 *
 * {@link pullStream} pages through the stream after the store's persisted
 * `_sync_cursor` (the journal client verifies order, gaps, the replica-to-
 * device pin, trust, hashes and decryption before anything is returned),
 * and for each segment, in ONE local transaction per page:
 * - decodes it: `deflate-raw(canonical JSON of LedgerTxn[])`, parsed with
 *   the ledger schema; a vault delta segment (`cleo-vault-delta/v1`, a count
 *   correction a vault push appended before the stream's genesis) carries no
 *   ops and is passed over;
 * - checks every transaction's signature against the segment's device key
 *   (§2.8); one bad signature refuses the segment, and the pull stops there:
 *   the segments before it are staged and applied, the segment and what
 *   follows are not;
 * - skips every transaction id already staged from this stream
 *   (`_sync_seen_txn`): a re-delivered transaction is never staged twice, so
 *   a counter delta is never applied twice;
 * - refuses a transaction at or below its origin's floor that has no seen
 *   row (`_sync_seen_floor`, T13318): an origin's transactions are first
 *   delivered in `local_seq` order, so such a transaction was either pruned
 *   from the seen ledger or arrived out of order; the pull stops there, loud,
 *   and never skips it as seen;
 * - stages the rest (`stageTxns`), schema-ahead ones included (the applier
 *   holds them `refused-schema` and replays them after an upgrade);
 * - advances the cursor.
 *
 * Then the applier applies what is staged, in stream order, own echoes
 * included (they feed the fast path and the scoped rebase, §3.5).
 *
 * The page source is a port ({@link SegmentPuller}): the journal client in
 * production (`cloud/nexus-vault.ts`), a fake in tests.
 *
 * @task T12343
 * @module store/sync/pull
 */

import type { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
import type { TableScope } from '@cleocode/contracts';
import { LedgerTxn } from '@cleocode/contracts/ledger';
import { type ApplyReport, type ApplyStagedOptions, applyStagedTxns } from './apply/applier.js';
import { withImmediateTransaction } from './clock-store.js';
import { isSyncFlagOn } from './flags.js';
import { stageTxns } from './inbox.js';
import { ensureSyncSchema, hasTable, healSyncSchema } from './schema.js';

/** Where a pull stands (the journal client's `PullCursor`). */
export interface StreamCursor {
  /** The last stream seq staged. */
  readonly after: number;
  /** Whether `replicas` lists every replica with a segment at or below `after`. */
  readonly knowsAllReplicas: boolean;
  /** Per replica: the device pinned to it and its last replicaSeq staged. */
  readonly replicas: Readonly<
    Record<string, { readonly deviceId: string; readonly replicaSeq: number }>
  >;
}

/** One verified, decrypted segment, as the journal client returns it. */
export interface PulledStreamSegment {
  readonly seq: number;
  readonly replicaId: string;
  readonly replicaSeq: number;
  readonly deviceId: string;
  readonly plaintext: Uint8Array;
  readonly schemaVersion: number;
}

/** Pulls the next verified page after `cursor`. */
export type SegmentPuller = (cursor: StreamCursor) => Promise<{
  readonly segments: readonly PulledStreamSegment[];
  readonly cursor: StreamCursor;
  readonly head: number;
}>;

/** The index of a segment's first transaction its device did not sign, or null when every one is signed. */
export type TxnVerifier = (deviceId: string, txns: readonly LedgerTxn[]) => number | null;

/** The plaintext kind of a vault count-delta segment (`cloud/nexus-vault.ts`). */
export const VAULT_DELTA_KIND = 'cleo-vault-delta/v1';

/** Options for {@link pullStream}. */
export interface PullStreamOptions {
  readonly scope: TableScope;
  readonly stream: string;
  /** This store's bound replica (own echoes are recognised by it). */
  readonly replica: string;
  readonly pull: SegmentPuller;
  readonly verify: TxnVerifier;
  /** The cursor to start from when the store has none persisted (the checkpoint it was cut from or restored). */
  readonly initialCursor: StreamCursor;
  /** Wall clock. @defaultValue Date.now */
  readonly now?: () => number;
  /** Seals pending local captures before a rebase (the applier's `seal`). */
  readonly seal: ApplyStagedOptions['seal'];
  /** Applier options passed through (pages, budget). */
  readonly apply?: Partial<Pick<ApplyStagedOptions, 'pageOps' | 'pageMs' | 'undoBudgetBytes'>>;
  /** Environment for the `sync.pull` kill switch. @defaultValue process.env */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * After staging, drop each origin's seen-txn rows below its staged floor
   * ({@link pruneSeenTxns}, T13318). A pruned transaction delivered again is
   * refused (`below-floor`), never applied twice. @defaultValue false
   */
  readonly pruneSeen?: boolean;
}

/**
 * Why {@link pullStream} stopped short, as a kind callers branch on (the
 * message in `refused` is for people and may be reworded):
 * - `pull-off`: `sync.pull` is off, nothing was pulled;
 * - `segment`: a segment is malformed, carries a transaction its device did
 *   not sign, or a transaction that is not its replica's;
 * - `below-floor`: a segment carries a transaction at or below its origin's
 *   staged floor with no seen row: pruned from the seen ledger, or delivered
 *   out of `local_seq` order (T13318).
 */
export type PullRefusal = 'pull-off' | 'segment' | 'below-floor';

/** What {@link pullStream} did. */
export interface PullStreamReport {
  readonly stream: string;
  /**
   * Why the pull stopped short, or null: `sync.pull` off (nothing pulled), or
   * a refused segment (a malformed body or a transaction its device did not
   * sign), naming its seq, replica and device. Everything before a refused
   * segment was staged and applied, and the cursor stops just before it.
   */
  readonly refused: string | null;
  /** The kind of `refused` ({@link PullRefusal}), or null when nothing was refused. */
  readonly refusedKind: PullRefusal | null;
  /** Segments received, vault deltas passed over, transactions staged, re-deliveries skipped. */
  readonly segments: number;
  readonly vaultDeltas: number;
  readonly staged: number;
  readonly redelivered: number;
  /** The stream position the store has staged up to, and the server's head. */
  readonly after: number;
  readonly head: number;
  /** What the applier did, or null when the pull was refused. */
  readonly apply: ApplyReport | null;
}

/** A segment the store refuses to stage (a malformed body or a bad transaction signature). */
export class SegmentRefusedError extends Error {
  readonly code = 'E_SYNC_SEGMENT_REFUSED';
}

/** The store's persisted cursor for `stream`, or null. */
export function readStreamCursor(db: DatabaseSync, stream: string): StreamCursor | null {
  if (!hasTable(db, '_sync_cursor')) return null;
  const row = db.prepare('SELECT cursor_json FROM _sync_cursor WHERE stream = ?').get(stream) as
    | { cursor_json: string }
    | undefined;
  return row ? (JSON.parse(row.cursor_json) as StreamCursor) : null;
}

/**
 * Persist the store's pull position for `stream`, in the caller's
 * transaction (the pull's page, or a JOIN seeding it from the checkpoint it
 * restored).
 *
 * @param db - The store.
 * @param stream - The stream.
 * @param cursor - The position.
 * @param nowIso - The time.
 */
export function writeStreamCursor(
  db: DatabaseSync,
  stream: string,
  cursor: StreamCursor,
  nowIso: string,
): void {
  db.prepare(
    'INSERT INTO _sync_cursor (stream, cursor_json, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT (stream) DO UPDATE SET cursor_json = excluded.cursor_json, updated_at = excluded.updated_at',
  ).run(stream, JSON.stringify(cursor), nowIso);
}

/** Decode a segment's transactions, or `null` for a vault delta segment. */
function decode(seg: PulledStreamSegment): LedgerTxn[] | null {
  let text: string;
  try {
    text = inflateRawSync(seg.plaintext).toString('utf8');
  } catch {
    // Not deflated: a vault delta segment is plain JSON.
    try {
      const raw: unknown = JSON.parse(Buffer.from(seg.plaintext).toString('utf8'));
      if (
        typeof raw === 'object' &&
        raw !== null &&
        'kind' in raw &&
        raw.kind === VAULT_DELTA_KIND
      ) {
        return null;
      }
    } catch {
      // fall through to the refusal
    }
    // @sync-invariant none:input-shape a segment body that is neither a ledger segment nor a vault delta is never staged
    throw new SegmentRefusedError(
      `segment ${seg.seq} of replica ${seg.replicaId}: not a ledger segment`,
    );
  }
  const parsed = LedgerTxn.array().safeParse(JSON.parse(text));
  if (!parsed.success) {
    // @sync-invariant none:input-shape a ledger segment that does not parse is never staged
    throw new SegmentRefusedError(
      `segment ${seg.seq} of replica ${seg.replicaId}: transactions do not parse`,
    );
  }
  return parsed.data;
}

/** A segment's transactions (null for a vault delta), or why it is refused. */
function refusalOf(
  seg: PulledStreamSegment,
  verify: TxnVerifier,
): { readonly txns: LedgerTxn[] | null } | string {
  let txns: LedgerTxn[] | null;
  try {
    txns = decode(seg);
  } catch (err) {
    if (err instanceof SegmentRefusedError) return err.message;
    throw err;
  }
  if (txns !== null) {
    const bad = verify(seg.deviceId, txns);
    if (bad !== null) {
      return `segment ${seg.seq} of replica ${seg.replicaId}: transaction ${bad} is not signed by device ${seg.deviceId}`;
    }
    // A replica packs only its own transactions (`buildSegment`); the floor
    // is kept per origin, so a foreign id is refused, never staged.
    const foreign = txns.find((t) => localSeqOf(t.txn, seg.replicaId) === null);
    if (foreign !== undefined) {
      return `segment ${seg.seq} of replica ${seg.replicaId}: transaction ${foreign.txn} is not one of its transactions`;
    }
  }
  return { txns };
}

/**
 * The `local_seq` of `txn` when it is `replica`'s (`<replica>:<local_seq>`,
 * minted by the sealer from 1), else null.
 */
function localSeqOf(txn: string, replica: string): number | null {
  const prefix = `${replica}:`;
  if (!txn.startsWith(prefix)) return null;
  const rest = txn.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(rest)) return null;
  const n = Number(rest);
  return Number.isSafeInteger(n) ? n : null;
}

/** One origin's floor on a stream (`_sync_seen_floor`). */
interface SeenFloor {
  readonly stagedUpto: number;
  readonly prunedUpto: number;
}

function readFloor(db: DatabaseSync, stream: string, origin: string): SeenFloor {
  const row = db
    .prepare(
      'SELECT staged_upto, pruned_upto FROM _sync_seen_floor WHERE stream = ? AND origin = ?',
    )
    .get(stream, origin) as { staged_upto: number; pruned_upto: number } | undefined;
  return row
    ? { stagedUpto: Number(row.staged_upto), prunedUpto: Number(row.pruned_upto) }
    : { stagedUpto: 0, prunedUpto: 0 };
}

/** What a segment brings past the seen ledger, or why it is refused. */
type FreshPlan =
  | { readonly fresh: LedgerTxn[]; readonly redelivered: number; readonly stagedUpto: number }
  | { readonly refused: string };

/**
 * Split a verified segment's transactions into re-deliveries (a seen row
 * exists) and fresh ones, against the origin's floor (T13318). Read-only. A
 * transaction with no seen row at or below the floor refuses the whole
 * segment: its seen row was pruned, or it arrived out of `local_seq` order,
 * and either way skipping it as seen could lose it.
 */
function planFresh(
  db: DatabaseSync,
  stream: string,
  seg: PulledStreamSegment,
  txns: readonly LedgerTxn[],
): FreshPlan {
  const floor = readFloor(db, stream, seg.replicaId);
  const isSeen = db.prepare('SELECT 1 FROM _sync_seen_txn WHERE stream = ? AND txn = ?');
  const inSegment = new Set<string>();
  const fresh: LedgerTxn[] = [];
  let redelivered = 0;
  let upto = floor.stagedUpto;
  for (const t of txns) {
    if (inSegment.has(t.txn) || isSeen.get(stream, t.txn) !== undefined) {
      redelivered += 1;
      continue;
    }
    // refusalOf proved every id is the segment replica's.
    const seq = localSeqOf(t.txn, seg.replicaId) ?? 0;
    if (seq <= upto) {
      const why =
        seq <= floor.prunedUpto
          ? `its seen row was pruned (pruned_upto ${floor.prunedUpto})`
          : 'it arrived out of local_seq order';
      return {
        refused: `segment ${seg.seq} of replica ${seg.replicaId}: transaction ${t.txn} is at or below the origin's staged floor ${upto} on ${stream} with no seen row: ${why}; it is not staged`,
      };
    }
    inSegment.add(t.txn);
    fresh.push(t);
    upto = seq;
  }
  return { fresh, redelivered, stagedUpto: upto };
}

/** `cursor` advanced over `segs` (a page cut short by a refused segment). */
function advance(cursor: StreamCursor, segs: readonly PulledStreamSegment[]): StreamCursor {
  const replicas = { ...cursor.replicas };
  for (const s of segs) replicas[s.replicaId] = { deviceId: s.deviceId, replicaSeq: s.replicaSeq };
  return {
    after: segs.at(-1)?.seq ?? cursor.after,
    knowsAllReplicas: cursor.knowsAllReplicas,
    replicas,
  };
}

/** Bytes counted for a seen-txn row's `seq` integer. */
const SEEN_SEQ_BYTES = 8;

/** Estimated payload bytes of one seen-txn row (stream and txn text plus the seq integer). */
const seenBytes = (stream: string, txn: string): number =>
  Buffer.byteLength(stream, 'utf8') + Buffer.byteLength(txn, 'utf8') + SEEN_SEQ_BYTES;

/**
 * Install the floor table before a pull: a store whose journal predates it
 * gains it, and a store whose journal records the folder but lost the table
 * gets it re-created (§2.3a rule 9), its counts re-seeded from the seen rows.
 *
 * @param db - The store, outside a transaction.
 */
function ensureSeenFloor(db: DatabaseSync): void {
  if (hasTable(db, '_sync_seen_floor')) return;
  ensureSyncSchema(db);
  healSyncSchema(db, ['_sync_seen_floor']);
}

/**
 * {@link seenTxnReport} for a store with seen rows but no floor table yet
 * (its next pull installs it): the ledger walked once, O(rows).
 */
function seenLedgerWalk(db: DatabaseSync): {
  rows: number;
  bytes: number;
  byStream: Record<string, number>;
} {
  const byStream: Record<string, number> = {};
  let rows = 0;
  let bytes = 0;
  if (!hasTable(db, '_sync_seen_txn')) return { rows, bytes, byStream };
  for (const r of db
    .prepare(
      `SELECT stream, count(*) AS n, sum(octet_length(stream) + octet_length(txn) + ${SEEN_SEQ_BYTES}) AS b
         FROM _sync_seen_txn GROUP BY stream ORDER BY stream`,
    )
    .all() as Array<{ stream: string; n: number; b: number | null }>) {
    byStream[r.stream] = Number(r.n);
    rows += Number(r.n);
    bytes += Number(r.b ?? 0);
  }
  return { rows, bytes, byStream };
}

/**
 * The size of `_sync_seen_txn` (T13317), for `cleo cloud status`: rows per
 * stream and the estimated payload bytes (stream and txn text plus the seq
 * integer, without SQLite's page overhead). Read-only, and O(origins): it
 * sums the per-origin counts `_sync_seen_floor` keeps with every insert and
 * prune (T13318), never the ledger itself.
 *
 * @param db - The store.
 * @returns Zeroes when the tables are not installed; the ledger walked when
 *   only the floor table is missing.
 */
export function seenTxnReport(db: DatabaseSync): {
  rows: number;
  bytes: number;
  byStream: Record<string, number>;
} {
  if (!hasTable(db, '_sync_seen_floor')) return seenLedgerWalk(db);
  const byStream: Record<string, number> = {};
  let rows = 0;
  let bytes = 0;
  for (const r of db
    .prepare(
      `SELECT stream, sum(seen_rows) AS n, sum(seen_bytes) AS b
         FROM _sync_seen_floor GROUP BY stream HAVING sum(seen_rows) > 0 ORDER BY stream`,
    )
    .all() as Array<{ stream: string; n: number; b: number | null }>) {
    byStream[r.stream] = Number(r.n);
    rows += Number(r.n);
    bytes += Number(r.b ?? 0);
  }
  return { rows, bytes, byStream };
}

/**
 * Drop each origin's seen-txn rows of `stream` below its staged floor,
 * keeping `_sync_seen_txn` bounded (§3.1, T13318), and record how far each
 * origin was pruned (`pruned_upto`). Safe because an origin's transactions
 * are first delivered in `local_seq` order and the pull refuses any
 * transaction at or below the floor that has no seen row (`below-floor`):
 * a pruned transaction delivered again is refused loudly, never applied
 * twice. The row at the floor itself is kept, so re-delivery of the latest
 * transaction is still skipped quietly.
 *
 * @param db - The store, outside a transaction.
 * @param stream - The stream.
 * @returns How many rows were dropped.
 */
export function pruneSeenTxns(db: DatabaseSync, stream: string): number {
  if (!hasTable(db, '_sync_seen_floor')) return 0;
  return withImmediateTransaction(db, () => {
    const floors = db
      .prepare(
        'SELECT origin, staged_upto FROM _sync_seen_floor WHERE stream = ? AND staged_upto - 1 > pruned_upto',
      )
      .all(stream) as Array<{ origin: string; staged_upto: number }>;
    // The origin's ids sort between '<origin>:' and '<origin>;' (':' + 1),
    // a range of the (stream, txn) primary key.
    const rowsOf = db.prepare(
      `SELECT txn FROM _sync_seen_txn
        WHERE stream = ? AND txn >= ? AND txn < ? AND CAST(substr(txn, ?) AS INTEGER) <= ?`,
    );
    const drop = db.prepare('DELETE FROM _sync_seen_txn WHERE stream = ? AND txn = ?');
    const mark = db.prepare(
      `UPDATE _sync_seen_floor
          SET pruned_upto = ?, seen_rows = max(seen_rows - ?, 0), seen_bytes = max(seen_bytes - ?, 0)
        WHERE stream = ? AND origin = ?`,
    );
    let dropped = 0;
    for (const f of floors) {
      const upto = Number(f.staged_upto) - 1;
      const victims = rowsOf.all(
        stream,
        `${f.origin}:`,
        `${f.origin};`,
        f.origin.length + 2,
        upto,
      ) as Array<{ txn: string }>;
      let bytes = 0;
      for (const v of victims) {
        drop.run(stream, v.txn);
        bytes += seenBytes(stream, v.txn);
      }
      mark.run(upto, victims.length, bytes, stream, f.origin);
      dropped += victims.length;
    }
    return dropped;
  });
}

/**
 * Pull and stage a stream's new segments, then apply (module docs). Must run
 * outside a transaction. A refused segment stops the pull: everything
 * before it is staged and applied, the cursor stops just before it, and the
 * report's `refused` names it (T13307), so the next pull reaches it again
 * without re-staging anything.
 *
 * @param db - The store.
 * @param o - {@link PullStreamOptions}.
 * @returns What was received, staged and applied.
 */
export async function pullStream(
  db: DatabaseSync,
  o: PullStreamOptions,
): Promise<PullStreamReport> {
  const now = o.now ?? Date.now;
  if (!isSyncFlagOn(db, 'sync.pull', o.env ?? process.env)) {
    return {
      stream: o.stream,
      refused: 'sync.pull is off',
      refusedKind: 'pull-off',
      segments: 0,
      vaultDeltas: 0,
      staged: 0,
      redelivered: 0,
      after: readStreamCursor(db, o.stream)?.after ?? o.initialCursor.after,
      head: 0,
      apply: null,
    };
  }
  ensureSeenFloor(db);
  let cursor = readStreamCursor(db, o.stream) ?? o.initialCursor;
  let segments = 0;
  let vaultDeltas = 0;
  let staged = 0;
  let redelivered = 0;
  let head = cursor.after;
  let refused: string | null = null;
  let refusedKind: PullRefusal | null = null;
  for (;;) {
    const page = await o.pull(cursor);
    head = page.head;
    const nowIso = new Date(now()).toISOString();
    // Decode and verify the page before writing anything of it, up to the
    // first segment refused (T13307): what precedes it is staged and applied,
    // the cursor stops just before it, and the refusal is reported.
    const decoded: Array<{ seg: PulledStreamSegment; txns: LedgerTxn[] | null }> = [];
    for (const seg of page.segments) {
      const why = refusalOf(seg, o.verify);
      if (typeof why === 'string') {
        refused = why;
        refusedKind = 'segment';
        break;
      }
      decoded.push({ seg, txns: why.txns });
    }
    cursor = withImmediateTransaction(db, () => {
      const seen = db.prepare('INSERT INTO _sync_seen_txn (stream, txn, seq) VALUES (?, ?, ?)');
      const raise = db.prepare(
        `INSERT INTO _sync_seen_floor (stream, origin, staged_upto, seen_rows, seen_bytes)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (stream, origin) DO UPDATE SET
           staged_upto = excluded.staged_upto,
           seen_rows = seen_rows + excluded.seen_rows,
           seen_bytes = seen_bytes + excluded.seen_bytes`,
      );
      const done: PulledStreamSegment[] = [];
      for (const { seg, txns } of decoded) {
        if (txns !== null) {
          const plan = planFresh(db, o.stream, seg, txns);
          if ('refused' in plan) {
            refused = plan.refused;
            refusedKind = 'below-floor';
            break;
          }
          redelivered += plan.redelivered;
          if (plan.fresh.length > 0) {
            let bytes = 0;
            for (const t of plan.fresh) {
              seen.run(o.stream, t.txn, seg.seq);
              bytes += seenBytes(o.stream, t.txn);
            }
            raise.run(o.stream, seg.replicaId, plan.stagedUpto, plan.fresh.length, bytes);
            staged += stageTxns(
              db,
              o.stream,
              {
                seq: seg.seq,
                replicaId: seg.replicaId,
                replicaSeq: seg.replicaSeq,
                deviceId: seg.deviceId,
                schemaVersion: seg.schemaVersion,
                txns: plan.fresh,
              },
              nowIso,
            );
          }
        } else {
          vaultDeltas += 1;
        }
        segments += 1;
        done.push(seg);
      }
      const next = refused === null ? page.cursor : advance(cursor, done);
      writeStreamCursor(db, o.stream, next, nowIso);
      return next;
    });
    if (refused !== null) break;
    if (page.segments.length === 0 || cursor.after >= page.head) break;
  }
  if (o.pruneSeen === true) pruneSeenTxns(db, o.stream);
  const apply = applyStagedTxns(db, {
    scope: o.scope,
    stream: o.stream,
    replica: o.replica,
    now,
    seal: o.seal,
    ...(o.apply ?? {}),
  });
  return {
    stream: o.stream,
    refused,
    refusedKind,
    segments,
    vaultDeltas,
    staged,
    redelivered,
    after: cursor.after,
    head,
    apply,
  };
}
