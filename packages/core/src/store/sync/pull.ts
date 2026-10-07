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
 *   (§2.8); one bad signature refuses the segment, and the pull stops before
 *   staging anything of it;
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
}

/** What {@link pullStream} did. */
export interface PullStreamReport {
  readonly stream: string;
  /** Segments received, vault deltas passed over, transactions staged, re-deliveries skipped. */
  readonly segments: number;
  readonly vaultDeltas: number;
  readonly staged: number;
  readonly redelivered: number;
  /** The stream position the store has staged up to, and the server's head. */
  readonly after: number;
  readonly head: number;
  readonly apply: ApplyReport;
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

/**
 * Pull and stage a stream's new segments, then apply (module docs). Must run
 * outside a transaction. A refused segment stops the pull with
 * {@link SegmentRefusedError} after the pages before it were staged.
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
  let cursor = readStreamCursor(db, o.stream) ?? o.initialCursor;
  let segments = 0;
  let vaultDeltas = 0;
  let staged = 0;
  let redelivered = 0;
  let head = cursor.after;
  for (;;) {
    const page = await o.pull(cursor);
    head = page.head;
    const nowIso = new Date(now()).toISOString();
    // Decode and verify the whole page before writing anything of it.
    const decoded = page.segments.map((seg) => {
      const txns = decode(seg);
      if (txns !== null) {
        const bad = o.verify(seg.deviceId, txns);
        if (bad !== null) {
          // @sync-invariant none:input-shape a transaction its device did not sign is never staged (§2.8)
          throw new SegmentRefusedError(
            `segment ${seg.seq} of replica ${seg.replicaId}: transaction ${bad} is not signed by device ${seg.deviceId}`,
          );
        }
      }
      return { seg, txns };
    });
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
      db.prepare(
        'INSERT INTO _sync_cursor (stream, cursor_json, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT (stream) DO UPDATE SET cursor_json = excluded.cursor_json, updated_at = excluded.updated_at',
      ).run(o.stream, JSON.stringify(page.cursor), nowIso);
    });
    cursor = page.cursor;
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
    segments,
    vaultDeltas,
    staged,
    redelivered,
    after: cursor.after,
    head,
    apply,
  };
}
