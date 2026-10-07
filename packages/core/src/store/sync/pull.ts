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
import { hasTable } from './schema.js';

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
   * Drop seen-txn rows first staged at or below this stream seq, or null to
   * keep every row. Only a floor the applier refuses below is safe
   * ({@link pruneSeenTxns}); the cloud pull passes none yet (T13256).
   */
  readonly pruneSeenUpTo?: number | null;
}

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
  }
  return { txns };
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

/**
 * Drop the seen-txn rows of `stream` first staged at or below `seq`, keeping
 * `_sync_seen_txn` bounded (§3.1). Only safe below a floor the applier
 * refuses any txn under: a seen txn can return in a NEW segment above a
 * checkpoint (a retired replica's late segment, a rebind's re-push), so a
 * checkpoint's coversSeq alone is not such a floor. No caller prunes until
 * that floor exists (T13256).
 *
 * @param db - The store.
 * @param stream - The stream.
 * @param seq - The floor, inclusive.
 * @returns How many rows were dropped.
 */
export function pruneSeenTxns(db: DatabaseSync, stream: string, seq: number): number {
  if (!hasTable(db, '_sync_seen_txn')) return 0;
  return Number(
    db.prepare('DELETE FROM _sync_seen_txn WHERE stream = ? AND seq <= ?').run(stream, seq).changes,
  );
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
      segments: 0,
      vaultDeltas: 0,
      staged: 0,
      redelivered: 0,
      after: readStreamCursor(db, o.stream)?.after ?? o.initialCursor.after,
      head: 0,
      apply: null,
    };
  }
  let cursor = readStreamCursor(db, o.stream) ?? o.initialCursor;
  let segments = 0;
  let vaultDeltas = 0;
  let staged = 0;
  let redelivered = 0;
  let head = cursor.after;
  let refusedSegment: string | null = null;
  // Seen-txn rows at or below the floor can no longer be re-delivered.
  if (o.pruneSeenUpTo !== undefined && o.pruneSeenUpTo !== null) {
    pruneSeenTxns(db, o.stream, o.pruneSeenUpTo);
  }
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
        refusedSegment = why;
        break;
      }
      decoded.push({ seg, txns: why.txns });
    }
    const pageCursor =
      refusedSegment === null
        ? page.cursor
        : advance(
            cursor,
            decoded.map((d) => d.seg),
          );
    withImmediateTransaction(db, () => {
      const seen = db.prepare(
        'INSERT INTO _sync_seen_txn (stream, txn, seq) VALUES (?, ?, ?) ON CONFLICT (stream, txn) DO NOTHING',
      );
      for (const { seg, txns } of decoded) {
        segments += 1;
        if (txns === null) {
          vaultDeltas += 1;
          continue;
        }
        // A transaction already staged under an earlier segment is re-delivered: skip it.
        const fresh = txns.filter((t) => Number(seen.run(o.stream, t.txn, seg.seq).changes) === 1);
        redelivered += txns.length - fresh.length;
        if (fresh.length === 0) continue;
        staged += stageTxns(
          db,
          o.stream,
          {
            seq: seg.seq,
            replicaId: seg.replicaId,
            replicaSeq: seg.replicaSeq,
            deviceId: seg.deviceId,
            schemaVersion: seg.schemaVersion,
            txns: fresh,
          },
          nowIso,
        );
      }
      writeStreamCursor(db, o.stream, pageCursor, nowIso);
    });
    cursor = pageCursor;
    if (refusedSegment !== null) break;
    if (page.segments.length === 0 || cursor.after >= page.head) break;
  }
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
    refused: refusedSegment,
    segments,
    vaultDeltas,
    staged,
    redelivered,
    after: cursor.after,
    head,
    apply,
  };
}
