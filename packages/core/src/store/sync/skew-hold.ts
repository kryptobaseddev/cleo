/**
 * The per-replica FIFO skew hold (journal spec §1.3, M2).
 *
 * A received transaction whose HLC is more than the skew bound ahead of the
 * local wall clock is held: not applied, and it does not advance the clock.
 * Every later transaction from the SAME origin replica is held behind it, in
 * `(replicaSeq, index)` order, even when its own HLC is in bounds, so that
 * replica's causal order is preserved. Other replicas keep flowing. The held
 * head is re-evaluated on every drain, and the queue releases in order once
 * the head is within bounds. Nothing is ever dropped.
 *
 * This is the in-memory ordering core. Staging the held transactions durably
 * (`held-skew`) and reporting them through `cleo doctor sync` belong to the
 * pull slice (S5).
 *
 * @task T12342
 * @module store/sync/skew-hold
 */

import { type Hlc, isWithinSkew, MAX_DRIFT_MS, parseHlc } from './hlc.js';

/** One received transaction, as far as ordering is concerned. */
export interface InboundTxn {
  /** Origin replica id. */
  readonly replica: string;
  /** The origin's gap-free segment sequence number. */
  readonly replicaSeq: number;
  /** Position of the transaction inside its segment. */
  readonly index: number;
  /** The transaction's HLC (its largest op HLC), encoded. */
  readonly hlc: string;
}

/** A replica whose queue is blocked by an out-of-bound head. */
export interface HeldReplica {
  readonly replica: string;
  /** The transaction that is too far ahead. */
  readonly head: InboundTxn;
  /** How many transactions wait, the head included. */
  readonly waiting: number;
  /** How far the head is ahead of the local wall clock, in ms. */
  readonly aheadMs: number;
}

function order(a: InboundTxn, b: InboundTxn): number {
  if (a.replicaSeq !== b.replicaSeq) return a.replicaSeq - b.replicaSeq;
  return a.index - b.index;
}

/**
 * Per-replica FIFO queues that release transactions in origin order and hold
 * a replica's whole queue behind an out-of-bound head.
 */
export class SkewHold {
  private readonly queues = new Map<string, InboundTxn[]>();

  /**
   * @param maxDriftMs - The skew bound; defaults to {@link MAX_DRIFT_MS}.
   */
  constructor(private readonly maxDriftMs: number = MAX_DRIFT_MS) {}

  /**
   * Queue a received transaction behind earlier ones from the same replica.
   * A transaction the queue already holds (same replica, seq and index) is
   * ignored, so a re-pull is idempotent.
   */
  offer(txn: InboundTxn): void {
    const hlc: Hlc = parseHlc(txn.hlc);
    if (hlc.replica !== txn.replica) {
      throw new Error(`transaction HLC ${txn.hlc} was not issued by replica ${txn.replica}`);
    }
    const q = this.queues.get(txn.replica) ?? [];
    if (q.some((t) => t.replicaSeq === txn.replicaSeq && t.index === txn.index)) return;
    q.push(txn);
    q.sort(order);
    this.queues.set(txn.replica, q);
  }

  /**
   * Release every transaction that may apply now, in per-replica order, and
   * report the replicas that stay held.
   *
   * @param nowMs - The local wall clock.
   * @returns `ready` (to apply, grouped by replica in origin order) and `held`.
   */
  drain(nowMs: number): { ready: InboundTxn[]; held: HeldReplica[] } {
    const ready: InboundTxn[] = [];
    const held: HeldReplica[] = [];
    for (const [replica, q] of [...this.queues].sort(([a], [b]) => (a < b ? -1 : 1))) {
      while (q.length > 0) {
        const head = q[0] as InboundTxn;
        const h = parseHlc(head.hlc);
        if (!isWithinSkew(h, nowMs, this.maxDriftMs)) {
          held.push({ replica, head, waiting: q.length, aheadMs: h.phys - Math.floor(nowMs) });
          break;
        }
        ready.push(head);
        q.shift();
      }
      if (q.length === 0) this.queues.delete(replica);
    }
    return { ready, held };
  }

  /** How many transactions are queued, over all replicas. */
  get size(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }
}
