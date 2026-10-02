/**
 * Netting inside one transaction (journal spec §2.4, R8, N8; S3b, T12985).
 *
 * The sealer builds one draft op per capture; {@link netTransaction} reduces a
 * transaction's drafts to the ops a receiver needs. Netting is per (table,
 * uid) (§2.4): drafts are first chained per (table, local key `rk`), because a
 * re-key changes the uid but never the local key, and then chains with no K
 * that carry the same uid merge, so a delete of one local row and an insert
 * of another under the same uid (an AC relink) net to one U (T13035).
 *
 * Per chain:
 *
 * 1. **Re-keys.** Adjacent K ops collapse: K(x → NULL) followed by the fill's
 *    K(NULL → y) is one K(x → y) (N8). A K whose old uid no sealed op ever
 *    carried (no row meta) is **dropped**: every op of the chain then uses the
 *    final uid, and the caller moves the row meta ({@link NetResult.renames}).
 *    A K on a uid row meta knows is **kept** (T13035): ops sealed earlier on
 *    the old uid are never rewritten, so the K is what links them to the new
 *    uid. Ops before a kept K use the old uid, ops after it the new one.
 * 2. **Net each stretch between kept K ops** (§2.4 table):
 *
 * | sequence | result |
 * |---|---|
 * | I, then any U | I with the final image |
 * | U, U, … | one U: first before, last after per column; unchanged columns dropped; no op when nothing changed |
 * | I … D | nothing |
 * | D, then I | U of the non-key columns that differ, or nothing |
 * | D, I, D | D, before-image from the first D |
 * | U … D | D, before-image from the first U's before |
 * | I on a uid row meta knows live, not deleted earlier in the transaction (foreign REPLACE) | U against it |
 *
 * 3. **Counters (§2.6).** On a U, a column declared in
 *    {@link SYNC_COUNTER_COLUMNS} carries `{$inc: after − before}` instead of
 *    the absolute value; the before-image keeps the old value.
 *
 * Each op keeps its first capture's `seq` (output order) and records its last
 * capture's in `last`: the sealer takes the op's HLC time and local key from
 * the last capture (T13037).
 *
 * Apply-intent subtraction (§3.3) needs `_sync_apply_intent`, which arrives
 * with pull/apply (S5); {@link subtractIntents} is the seam and is a no-op
 * until then, so the sealer refuses apply and rebase frames. Across
 * transactions, the sealer drops the dead incarnation of a row that never got
 * a uid (I … D, T13036); the rest of cross-transaction compaction is S4,
 * where segment state exists.
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

/** A netted op, ready for an HLC. `last` is its last capture's seq. */
export type NettedOp = Omit<DraftOp, 'rk'> & { readonly u: string | null; readonly last: number };

/** Row-meta facts the netting needs. */
export interface MetaFacts {
  /** Whether a persisted segment ever carried this uid (`sent = 1`). */
  sent(table: string, uid: string): boolean;
  /** Whether row meta knows this uid as a LIVE row (not a tombstone). */
  live(table: string, uid: string): boolean;
  /** Whether row meta knows this uid at all: some sealed op carried it. */
  known(table: string, uid: string): boolean;
}

/** Netting options beyond row meta. */
export interface NetOptions {
  /** In-place counter columns per table (§2.6). */
  readonly counters?: Readonly<Record<string, readonly string[]>>;
  /** A table's key columns: a D-then-I U never carries them (§2.4). */
  readonly keyColumns?: (table: string) => readonly string[];
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
  lastOp: DraftOp,
  uid: string | null,
  bfp: string | undefined,
  live: (table: string, uid: string, seq: number) => boolean,
  counters: Readonly<Record<string, readonly string[]>>,
  keys: readonly string[],
): NettedOp | null {
  const base = (first: DraftOp) => ({
    t: first.t,
    seq: first.seq,
    last: lastOp.seq,
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
      if (uid !== null && acc.first.o === 'I' && live(acc.first.t, uid, acc.first.seq)) {
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
        if (keys.includes(col)) continue;
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
 * Chain drafts per (table, rk), then merge the chains that carry the same
 * single uid (§2.4 nets per uid; T13035). A chain's uid is its one non-NULL
 * uid, counting a fill's K(NULL → y) as y. A chain with a real re-key (a K
 * from a non-NULL uid) stays on its own: its uid changes along the chain, so
 * merging it by uid could put a collision loser's ops on the winner's row.
 */
function chainsOf(drafts: readonly DraftOp[]): DraftOp[][] {
  const byRk = new Map<string, DraftOp[]>();
  for (const d of drafts) {
    const key = `${d.t}\u0000${d.rk}`;
    let c = byRk.get(key);
    if (!c) {
      c = [];
      byRk.set(key, c);
    }
    c.push(d);
  }
  const out: DraftOp[][] = [];
  const byUid = new Map<string, DraftOp[]>();
  for (const chain of byRk.values()) {
    const rekeys = chain.some((d) => d.o === 'K' && d.u !== null);
    const uids = new Set<string>();
    for (const d of chain) {
      const u = d.o === 'K' ? (d.nu ?? null) : d.u;
      if (u !== null) uids.add(u);
    }
    const only = uids.size === 1 ? [...uids][0] : undefined;
    if (rekeys || only === undefined) {
      out.push(chain);
      continue;
    }
    const key = `${chain[0]?.t}\u0000${only}`;
    const into = byUid.get(key);
    if (into) {
      into.push(...chain);
      into.sort((x, y) => x.seq - y.seq);
    } else {
      byUid.set(key, chain);
      out.push(chain);
    }
  }
  return out;
}

/**
 * Net one transaction's drafts (§2.4). Output is ordered by each op's first
 * capture seq; kept K ops sit between their chain's stretches.
 */
export function netTransaction(
  drafts: readonly DraftOp[],
  facts: MetaFacts,
  options: NetOptions = {},
): NetResult {
  const counters = options.counters ?? SYNC_COUNTER_COLUMNS;
  const keyColumns = options.keyColumns ?? (() => []);
  const input = subtractIntents(drafts);
  // A uid deleted earlier in this transaction is not live for a later I,
  // whatever row meta says (T13035): that I stays an I.
  const deletedAt = new Map<string, number>();
  for (const d of input) {
    if (d.o !== 'D' || d.u === null) continue;
    const key = `${d.t}\u0000${d.u}`;
    if (!deletedAt.has(key)) deletedAt.set(key, d.seq);
  }
  const live = (t: string, u: string, seq: number): boolean => {
    const at = deletedAt.get(`${t}\u0000${u}`);
    return (at === undefined || at > seq) && facts.live(t, u);
  };

  const out: NettedOp[] = [];
  const renames: Array<{ t: string; from: string; to: string }> = [];
  for (const raw of chainsOf(input)) {
    const chain = collapseRekeys(raw);
    const keys = chain[0] ? keyColumns(chain[0].t) : [];
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
      if (from !== null && (facts.sent(op.t, from) || facts.known(op.t, from))) kept.add(op);
      // A K that keeps its uid (only birth_fp changed) renames nothing.
      else if (from !== null && to !== null && from !== to) renames.push({ t: op.t, from, to });
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
        const settled = settle(acc, last, uid, bfp, live, counters, keys);
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
          out.push({ ...k, last: op.seq });
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
