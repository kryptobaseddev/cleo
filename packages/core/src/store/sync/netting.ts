/**
 * Netting inside one transaction (journal spec §2.4, R8, N8; S3b, T12985).
 *
 * The sealer builds one draft op per capture; {@link netTransaction} reduces a
 * transaction's drafts to the ops a receiver needs. Drafts are grouped per
 * (table, local key `rk`), not per uid: a re-key changes the uid but never
 * the local key, so a row's whole history in the transaction is one chain.
 *
 * Per chain:
 *
 * 1. **Re-keys.** Adjacent K ops collapse: K(x → NULL) followed by the fill's
 *    K(NULL → y) is one K(x → y) (N8). A K whose old uid never left the device
 *    (row meta `sent = 0`, or no meta) is **dropped**: every op of the chain
 *    then uses the final uid, and the caller moves the row meta ({@link
 *    NetResult.renames}). A K on a sent uid is **kept**; ops before it use the
 *    old uid, ops after it the new one.
 * 2. **Net each stretch between kept K ops** (§2.4 table):
 *
 * | sequence | result |
 * |---|---|
 * | I, then any U | I with the final image |
 * | U, U, … | one U: first before, last after per column; unchanged columns dropped; no op when nothing changed |
 * | I … D | nothing |
 * | D, then I | U of the columns that differ, or nothing |
 * | D, I, D | D, before-image from the first D |
 * | U … D | D, before-image from the first U's before |
 * | I on a uid row meta knows live (foreign REPLACE) | U against it |
 *
 * 3. **Counters (§2.6).** On a U, a column declared in
 *    {@link SYNC_COUNTER_COLUMNS} carries `{$inc: after − before}` instead of
 *    the absolute value; the before-image keeps the old value.
 *
 * Apply-intent subtraction (§3.3) needs `_sync_apply_intent`, which arrives
 * with pull/apply (S5); {@link subtractIntents} is the seam and is a no-op
 * until then. Compaction across transactions (ops not yet in a segment) is
 * S4, where segment state exists.
 *
 * Pure: no database access; the caller supplies row-meta facts.
 *
 * @module store/sync/netting
 * @task T12985
 * @epic T12323
 */

import { canonicalJson, type WireValue } from './sealer-values.js';

/**
 * In-place counter columns per table (§2.6, `SYNC_COUNTER_COLUMNS`): sealed
 * as `{$inc: delta}` on update. Empty while no counter-bearing table is in
 * the sync set (brain_patterns joins with T12894).
 */
export const SYNC_COUNTER_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({});

/** A counter delta on the wire (§2.6). */
export interface IncValue {
  readonly $inc: number;
}

/** A draft op: one capture, before netting. `u`/`nu` may be NULL mid-re-key. */
export interface DraftOp {
  readonly t: string;
  /** Local key of the row (the capture's `rk`): stable across re-keys. */
  readonly rk: string;
  /** Capture seq, for ordering. */
  readonly seq: number;
  readonly o: 'I' | 'U' | 'D' | 'K';
  /** Row uid; for K the OLD uid. NULL when not yet known. */
  readonly u: string | null;
  /** K only: the new uid (NULL for a clear). */
  readonly nu?: string | null;
  readonly bfp?: string;
  readonly obfp?: string;
  readonly k?: Record<string, WireValue>;
  readonly a?: Record<string, WireValue | IncValue>;
  readonly b?: Record<string, WireValue>;
}

/** A netted op, ready for an HLC. */
export type NettedOp = Omit<DraftOp, 'rk'> & { readonly u: string | null };

/** Row-meta facts the netting needs. */
export interface MetaFacts {
  /** Whether a persisted segment ever carried this uid (`sent = 1`). */
  sent(table: string, uid: string): boolean;
  /** Whether row meta knows this uid as a LIVE row (not a tombstone). */
  live(table: string, uid: string): boolean;
}

/** What netting produced. */
export interface NetResult {
  readonly ops: NettedOp[];
  /** Dropped re-keys: move row meta `from` → `to` without an op. */
  readonly renames: ReadonlyArray<{
    readonly t: string;
    readonly from: string;
    readonly to: string;
  }>;
}

const same = (x: unknown, y: unknown): boolean => canonicalJson(x) === canonicalJson(y);

/** Collapse adjacent K ops of a chain: x→a then a→b is x→b (N8). */
function collapseRekeys(chain: DraftOp[]): DraftOp[] {
  const out: DraftOp[] = [];
  for (const op of chain) {
    const prev = out[out.length - 1];
    if (op.o === 'K' && prev?.o === 'K' && (prev.nu ?? null) === (op.u ?? null)) {
      out[out.length - 1] = {
        ...prev,
        nu: op.nu ?? null,
        ...(op.bfp !== undefined ? { bfp: op.bfp } : {}),
      };
      continue;
    }
    out.push(op);
  }
  return out;
}

type Acc =
  | { s: 'none' }
  | { s: 'I'; a: Record<string, WireValue | IncValue>; first: DraftOp }
  | {
      s: 'U';
      a: Record<string, WireValue | IncValue>;
      b: Record<string, WireValue>;
      first: DraftOp;
    }
  | { s: 'D'; b: Record<string, WireValue>; first: DraftOp }
  | {
      s: 'DI';
      b: Record<string, WireValue>;
      a: Record<string, WireValue | IncValue>;
      first: DraftOp;
      ins: DraftOp;
    }
  | { s: 'gone'; first: DraftOp };

function step(acc: Acc, op: DraftOp): Acc {
  const a = op.a ?? {};
  const b = op.b ?? {};
  switch (acc.s) {
    case 'none':
      if (op.o === 'I') return { s: 'I', a: { ...a }, first: op };
      if (op.o === 'U') return { s: 'U', a: { ...a }, b: { ...b }, first: op };
      return { s: 'D', b: { ...b }, first: op };
    case 'gone':
      // I … D, then more: start again from here.
      return step({ s: 'none' }, op);
    case 'I':
      if (op.o === 'U') return { ...acc, a: { ...acc.a, ...a } };
      if (op.o === 'D') return { s: 'gone', first: acc.first };
      return { s: 'I', a: { ...a }, first: acc.first }; // I, I: the later image
    case 'U':
      if (op.o === 'U') return { ...acc, a: { ...acc.a, ...a }, b: { ...b, ...acc.b } };
      if (op.o === 'D') return { s: 'D', b: { ...b, ...acc.b }, first: acc.first };
      return { s: 'I', a: { ...a }, first: acc.first };
    case 'D':
      if (op.o === 'I') return { s: 'DI', b: acc.b, a: { ...a }, first: acc.first, ins: op };
      return acc; // D, D (or U after D): the first before-image stands
    case 'DI':
      if (op.o === 'U') return { ...acc, a: { ...acc.a, ...a } };
      if (op.o === 'D') return { s: 'D', b: acc.b, first: acc.first };
      return { ...acc, a: { ...a } };
  }
}

function counterize(
  table: string,
  a: Record<string, WireValue | IncValue>,
  b: Record<string, WireValue>,
  registry: Readonly<Record<string, readonly string[]>>,
): Record<string, WireValue | IncValue> {
  const counters = registry[table];
  if (!counters || counters.length === 0) return a;
  const out = { ...a };
  for (const col of counters) {
    const after = a[col];
    const before = b[col];
    if (typeof after === 'number' && typeof before === 'number')
      out[col] = { $inc: after - before };
  }
  return out;
}

/** Turn one stretch's accumulator into at most one op. */
function settle(
  acc: Acc,
  uid: string | null,
  bfp: string | undefined,
  facts: MetaFacts,
  counters: Readonly<Record<string, readonly string[]>>,
): NettedOp | null {
  const base = (first: DraftOp) => ({
    t: first.t,
    seq: first.seq,
    u: uid,
    ...(bfp !== undefined ? { bfp } : {}),
    ...(first.k !== undefined ? { k: first.k } : {}),
  });
  switch (acc.s) {
    case 'none':
    case 'gone':
      return null;
    case 'I': {
      // A foreign REPLACE: an insert of a uid row meta already knows as live.
      if (uid !== null && acc.first.o === 'I' && facts.live(acc.first.t, uid)) {
        return { ...base(acc.first), o: 'U', a: acc.a };
      }
      return { ...base(acc.first), o: 'I', a: acc.a };
    }
    case 'U': {
      const a: Record<string, WireValue | IncValue> = {};
      const b: Record<string, WireValue> = {};
      for (const col of new Set([...Object.keys(acc.a), ...Object.keys(acc.b)])) {
        if (same(acc.a[col] ?? null, acc.b[col] ?? null)) continue;
        if (col in acc.a) a[col] = acc.a[col] as WireValue | IncValue;
        if (col in acc.b) b[col] = acc.b[col] as WireValue;
      }
      if (Object.keys(a).length === 0) return null;
      return { ...base(acc.first), o: 'U', a: counterize(acc.first.t, a, b, counters), b };
    }
    case 'D':
      return { ...base(acc.first), o: 'D', b: acc.b };
    case 'DI': {
      // D then I: never a tombstone plus an insert; the columns that differ.
      const a: Record<string, WireValue | IncValue> = {};
      const b: Record<string, WireValue> = {};
      for (const col of new Set([...Object.keys(acc.a), ...Object.keys(acc.b)])) {
        const now = acc.a[col] ?? null;
        const was = acc.b[col] ?? null;
        if (same(now, was)) continue;
        a[col] = now as WireValue | IncValue;
        b[col] = was;
      }
      if (Object.keys(a).length === 0) return null;
      return { ...base(acc.first), o: 'U', a: counterize(acc.first.t, a, b, counters), b };
    }
  }
}

/** Intent subtraction (§3.3): the S5 seam. No apply intents exist before pull. */
export function subtractIntents(ops: readonly DraftOp[]): DraftOp[] {
  return [...ops];
}

/**
 * Net one transaction's drafts (§2.4). Output is ordered by each op's first
 * capture seq; kept K ops sit between their chain's stretches.
 */
export function netTransaction(
  drafts: readonly DraftOp[],
  facts: MetaFacts,
  counters: Readonly<Record<string, readonly string[]>> = SYNC_COUNTER_COLUMNS,
): NetResult {
  const chains = new Map<string, DraftOp[]>();
  for (const d of subtractIntents(drafts)) {
    const key = `${d.t}\u0000${d.rk}`;
    let c = chains.get(key);
    if (!c) {
      c = [];
      chains.set(key, c);
    }
    c.push(d);
  }

  const out: NettedOp[] = [];
  const renames: Array<{ t: string; from: string; to: string }> = [];
  for (const raw of chains.values()) {
    const chain = collapseRekeys(raw);
    // The uid each stretch uses: a dropped K renames the whole chain to its
    // final uid; a kept K splits it.
    const kept = new Set<DraftOp>();
    let finalUid: string | null = null;
    for (const op of chain) {
      if (op.o !== 'K') {
        finalUid = finalUid ?? op.u;
        continue;
      }
      const from = op.u ?? null;
      const to = op.nu ?? null;
      if (from !== null && facts.sent(op.t, from)) kept.add(op);
      else if (from !== null && to !== null) renames.push({ t: op.t, from, to });
      finalUid = to;
    }
    let acc: Acc = { s: 'none' };
    let last: DraftOp | null = null;
    // The birth_fp the stretch ends with: a dropped K's new value wins.
    let bfp: string | undefined;
    // Stretch uid: before a kept K its old uid; otherwise the uid after the
    // last K in the stretch (a dropped K rewrites earlier ops).
    const stretchUid = (start: number, end: number): string | null => {
      for (let i = end - 1; i >= start; i--) {
        const op = chain[i] as DraftOp;
        if (op.o === 'K') return op.nu ?? null;
      }
      for (let i = start; i < end; i++) {
        const op = chain[i] as DraftOp;
        if (op.u !== null) return op.u;
      }
      return null;
    };
    let start = 0;
    const flush = (end: number) => {
      if (last !== null) {
        const keptAfter =
          chain[end] && kept.has(chain[end] as DraftOp) ? (chain[end] as DraftOp) : null;
        const uid = keptAfter ? (keptAfter.u ?? null) : (stretchUid(start, end) ?? finalUid);
        const settled = settle(acc, uid, bfp, facts, counters);
        if (settled) out.push(settled);
      }
      acc = { s: 'none' };
      last = null;
      bfp = undefined;
    };
    chain.forEach((op, i) => {
      if (op.o === 'K') {
        if (kept.has(op)) {
          flush(i);
          const { rk: _rk, ...k } = op;
          out.push(k);
          start = i + 1;
        } else if (op.bfp !== undefined) {
          bfp = op.bfp;
        }
        return;
      }
      acc = step(acc, op);
      last = op;
      if (op.bfp !== undefined) bfp = op.bfp;
    });
    flush(chain.length);
  }
  out.sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0));
  return { ops: out, renames };
}
