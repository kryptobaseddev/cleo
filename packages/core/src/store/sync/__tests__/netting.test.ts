/**
 * Netting inside one transaction (journal spec §2.4, R8, N8; T12985).
 *
 * One test (or more) per row of the §2.4 table, plus the re-key rules:
 * collapse, drop-when-unsent with rename, keep-when-sent with split.
 *
 * @task T12985
 */

import { describe, expect, it } from 'vitest';
import { type DraftOp, type MetaFacts, netTransaction } from '../netting.js';

const T = 'tasks_tasks';
let seq = 0;
const d = (o: DraftOp['o'], rest: Partial<DraftOp> = {}): DraftOp => ({
  t: T,
  rk: '["\'T1\'"]',
  seq: ++seq,
  o,
  u: 'u1',
  ...rest,
});

const none: MetaFacts = { sent: () => false, live: () => false, known: () => false };
const facts = (sent: string[] = [], live: string[] = [], known: string[] = []): MetaFacts => ({
  sent: (_t, u) => sent.includes(u),
  live: (_t, u) => live.includes(u),
  known: (_t, u) => known.includes(u) || sent.includes(u) || live.includes(u),
});
const strip = (ops: ReturnType<typeof netTransaction>['ops']) =>
  ops.map(({ seq: _s, last: _l, ...rest }) => rest);

describe('netTransaction: §2.4 table', () => {
  it('I, then any U: I with the final image', () => {
    const r = netTransaction(
      [
        d('I', { a: { title: 'a', status: 'pending' }, bfp: 'fp1' }),
        d('U', { a: { title: 'b' }, b: { title: 'a' } }),
        d('U', { a: { status: 'done' }, b: { status: 'pending' } }),
      ],
      none,
    );
    expect(strip(r.ops)).toEqual([
      { t: T, u: 'u1', o: 'I', bfp: 'fp1', a: { title: 'b', status: 'done' } },
    ]);
  });

  it('U, U: first before, last after per column; unchanged columns dropped', () => {
    const r = netTransaction(
      [
        d('U', { a: { title: 'b', status: 'active' }, b: { title: 'a', status: 'pending' } }),
        d('U', { a: { title: 'c', status: 'pending' }, b: { title: 'b', status: 'active' } }),
      ],
      none,
    );
    expect(strip(r.ops)).toEqual([{ t: T, u: 'u1', o: 'U', a: { title: 'c' }, b: { title: 'a' } }]);
  });

  it('U, U that ends where it started: no op', () => {
    const r = netTransaction(
      [
        d('U', { a: { title: 'b' }, b: { title: 'a' } }),
        d('U', { a: { title: 'a' }, b: { title: 'b' } }),
      ],
      none,
    );
    expect(r.ops).toEqual([]);
  });

  it('I … D: nothing', () => {
    const r = netTransaction(
      [
        d('I', { a: { title: 'a' } }),
        d('U', { a: { title: 'b' }, b: { title: 'a' } }),
        d('D', { b: { title: 'b' } }),
      ],
      none,
    );
    expect(r.ops).toEqual([]);
  });

  it('D, then I: a U of the columns that differ, never tombstone + insert', () => {
    const r = netTransaction(
      [
        d('D', { b: { title: 'a', status: 'pending', notes: 'x' } }),
        d('I', { a: { title: 'a', status: 'done' } }),
      ],
      none,
    );
    expect(strip(r.ops)).toEqual([
      {
        t: T,
        u: 'u1',
        o: 'U',
        a: { status: 'done', notes: null },
        b: { status: 'pending', notes: 'x' },
      },
    ]);
  });

  it('D, then an identical I: nothing', () => {
    const r = netTransaction([d('D', { b: { title: 'a' } }), d('I', { a: { title: 'a' } })], none);
    expect(r.ops).toEqual([]);
  });

  it('D, I, D: D with the first before-image', () => {
    const r = netTransaction(
      [
        d('D', { b: { title: 'first' } }),
        d('I', { a: { title: 'second' } }),
        d('D', { b: { title: 'second' } }),
      ],
      none,
    );
    expect(strip(r.ops)).toEqual([{ t: T, u: 'u1', o: 'D', b: { title: 'first' } }]);
  });

  it("U … D: D with the first U's before", () => {
    const r = netTransaction(
      [
        d('U', { a: { title: 'b' }, b: { title: 'a' } }),
        d('D', { b: { title: 'b', status: 'pending' } }),
      ],
      none,
    );
    expect(strip(r.ops)).toEqual([{ t: T, u: 'u1', o: 'D', b: { title: 'a', status: 'pending' } }]);
  });

  it('I on a uid row meta knows live (foreign REPLACE): a U', () => {
    const r = netTransaction([d('I', { a: { title: 'x' } })], facts([], ['u1']));
    expect(strip(r.ops)).toEqual([{ t: T, u: 'u1', o: 'U', a: { title: 'x' } }]);
  });

  it('separate rows stay separate and keep capture order', () => {
    const r = netTransaction(
      [
        d('I', { rk: 'p', u: 'p1', a: { id: 'P' } }),
        d('I', { rk: 'c', u: 'c1', a: { id: 'C' } }),
        d('U', { rk: 'p', u: 'p1', a: { title: 'x' }, b: { title: null } }),
      ],
      none,
    );
    expect(r.ops.map((o) => o.u)).toEqual(['p1', 'c1']);
  });
});

describe('netTransaction: re-keys', () => {
  it('K(x → NULL) then the fill K(NULL → y) nets to one K(x → y) (N8)', () => {
    const r = netTransaction(
      [d('K', { u: 'x', nu: null, obfp: 'f0' }), d('K', { u: null, nu: 'y', bfp: 'f1' })],
      facts(['x']),
    );
    expect(strip(r.ops)).toEqual([{ t: T, o: 'K', u: 'x', nu: 'y', obfp: 'f0', bfp: 'f1' }]);
  });

  it('a K on a uid that never left the device is dropped and earlier ops take the final uid', () => {
    const r = netTransaction(
      [
        d('I', { u: 'x', a: { title: 'a' }, bfp: 'f0' }),
        d('K', { u: 'x', nu: 'y', bfp: 'f1' }),
        d('U', { u: 'y', a: { title: 'b' }, b: { title: 'a' } }),
      ],
      none,
    );
    expect(strip(r.ops)).toEqual([{ t: T, u: 'y', o: 'I', bfp: 'f1', a: { title: 'b' } }]);
    expect(r.renames).toEqual([{ t: T, from: 'x', to: 'y' }]);
  });

  it('a K on a sent uid is kept; ops before use the old uid, after it the new one', () => {
    const r = netTransaction(
      [
        d('U', { u: 'x', a: { title: 'b' }, b: { title: 'a' } }),
        d('K', { u: 'x', nu: 'y', bfp: 'f1' }),
        d('U', { u: 'y', a: { title: 'c' }, b: { title: 'b' } }),
      ],
      facts(['x']),
    );
    expect(strip(r.ops).map((o) => [o.o, o.u, o.o === 'K' ? o.nu : undefined])).toEqual([
      ['U', 'x', undefined],
      ['K', 'x', 'y'],
      ['U', 'y', undefined],
    ]);
    expect(r.renames).toEqual([]);
  });

  it('a K on an unsent uid that a sealed op already carried is kept (T13035)', () => {
    // Row meta knows x (an earlier transaction sealed it), nothing was sent:
    // the earlier sealed ops are never rewritten, so the K must travel.
    const r = netTransaction(
      [
        d('K', { u: 'x', nu: 'y', bfp: 'f1' }),
        d('U', { u: 'y', a: { title: 'b' }, b: { title: 'a' } }),
      ],
      facts([], [], ['x']),
    );
    expect(strip(r.ops).map((o) => [o.o, o.u])).toEqual([
      ['K', 'x'],
      ['U', 'y'],
    ]);
    expect(r.renames).toEqual([]);
  });

  it('a clear with no fill in the transaction leaves an op without a uid (the sealer keeps it pending)', () => {
    const r = netTransaction(
      [d('U', { u: 'x', a: { title: 'b' }, b: { title: 'a' } }), d('K', { u: 'x', nu: null })],
      none,
    );
    expect(r.ops[0]?.u).toBeNull();
  });
});

describe('netTransaction: counters (§2.6)', () => {
  it('a declared counter column seals as {$inc}; the before-image keeps the old value', () => {
    const r = netTransaction(
      [
        d('U', { a: { hits: 5, note: 'x' }, b: { hits: 2, note: 'w' } }),
        d('U', { a: { hits: 9 }, b: { hits: 5 } }),
      ],
      none,
      { counters: { [T]: ['hits'] } },
    );
    expect(strip(r.ops)).toEqual([
      { t: T, u: 'u1', o: 'U', a: { hits: { $inc: 7 }, note: 'x' }, b: { hits: 2, note: 'w' } },
    ]);
  });

  it('an insert keeps the absolute counter value', () => {
    const r = netTransaction([d('I', { a: { hits: 3 } })], none, { counters: { [T]: ['hits'] } });
    expect(r.ops[0]?.a).toEqual({ hits: 3 });
  });
});

describe('netTransaction: per uid across local keys (T13035)', () => {
  const A = 'tasks_task_acceptance_criteria';
  const ac = (o: DraftOp['o'], rk: string, rest: Partial<DraftOp> = {}): DraftOp => ({
    t: A,
    rk,
    seq: ++seq,
    o,
    u: 'X',
    ...rest,
  });

  it('a delete of one local row and an insert of another under the same uid net to one U of the non-key columns', () => {
    const r = netTransaction(
      [
        ac('D', '["1"]', { b: { id: 1, text: 'old', ordinal: 1 } }),
        ac('I', '["2"]', { a: { id: 2, text: 'new', ordinal: 1 } }),
      ],
      facts([], ['X']),
      { keyColumns: (t) => (t === A ? ['id'] : []) },
    );
    expect(strip(r.ops)).toEqual([
      { t: A, u: 'X', o: 'U', a: { text: 'new' }, b: { text: 'old' } },
    ]);
  });

  it('a relink whose insert takes the uid from the fill (K NULL → X) also nets to one U', () => {
    const r = netTransaction(
      [
        ac('D', '["1"]', { b: { id: 1, text: 'old' } }),
        ac('I', '["2"]', { u: null, a: { id: 2, text: 'new' } }),
        ac('K', '["2"]', { u: null, nu: 'X', bfp: 'fx' }),
      ],
      facts([], ['X']),
      { keyColumns: () => ['id'] },
    );
    expect(strip(r.ops)).toEqual([
      { t: A, u: 'X', o: 'U', bfp: 'fx', a: { text: 'new' }, b: { text: 'old' } },
    ]);
  });

  it('an I after a same-transaction D of its uid in an unmerged chain stays an I', () => {
    // The insert's chain re-keys X → Z (X is known), so it does not merge
    // with the D; row meta still says X is live, but the transaction deleted
    // it first, so the I is not a foreign REPLACE.
    const r = netTransaction(
      [
        ac('D', '["1"]', { b: { text: 'old' } }),
        ac('I', '["2"]', { a: { text: 'new' } }),
        ac('K', '["2"]', { u: 'X', nu: 'Z' }),
      ],
      facts([], ['X']),
    );
    expect(strip(r.ops).map((o) => [o.o, o.u])).toEqual([
      ['D', 'X'],
      ['I', 'X'],
      ['K', 'X'],
    ]);
  });

  it('each op records its last capture for the HLC (T13037)', () => {
    const first = d('U', { a: { title: 'b' }, b: { title: 'a' } });
    const second = d('U', { a: { title: 'c' }, b: { title: 'b' } });
    const r = netTransaction([first, second], none);
    expect(r.ops[0]).toMatchObject({ seq: first.seq, last: second.seq });
  });
});
