/**
 * HLC encoding, ordering and clock rules (journal spec §1.1, §1.3), the
 * per-replica FIFO skew hold (M2), and R7: the HLC never reads a uid.
 *
 * Pure: no store, no filesystem writes.
 *
 * @task T12342
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareHlc,
  encodeHlc,
  genesisHlc,
  type Hlc,
  HlcError,
  isWithinSkew,
  MAX_COUNTER,
  MAX_DRIFT_MS,
  parseHlc,
  receive,
  tick,
} from '../hlc.js';
import { SkewHold } from '../skew-hold.js';

const A = '0192f1c2-0000-7000-8000-00000000000a';
const B = '0192f1c2-0000-7000-8000-00000000000b';
const T0 = 1_790_545_492_500;

const h = (phys: number, ctr: number, replica = A): Hlc => ({ phys, ctr, replica });

describe('encode / parse', () => {
  it('round-trips the contract format', () => {
    const s = encodeHlc(h(T0, 3));
    expect(s).toBe(`${T0}-000003-${A}`);
    expect(s).toMatch(/^\d{13}-\d{6}-[0-9a-f-]{36}$/);
    expect(parseHlc(s)).toEqual(h(T0, 3));
  });

  it('pads small physical times to 13 digits', () => {
    expect(encodeHlc(genesisHlc(A))).toBe(`0000000000000-000000-${A}`);
  });

  it('rejects malformed values', () => {
    expect(() => parseHlc('123-000001-x')).toThrow(HlcError);
    expect(() => parseHlc(`${T0}-000001-${A.toUpperCase()}`)).toThrow(HlcError);
    expect(() => encodeHlc(h(T0, MAX_COUNTER + 1))).toThrow(HlcError);
    expect(() => encodeHlc(h(-1, 0))).toThrow(HlcError);
    expect(() => encodeHlc(h(T0, 0, 'not-a-uuid'))).toThrow(HlcError);
  });
});

describe('compareHlc', () => {
  it('orders by phys, then counter, then replica', () => {
    expect(compareHlc(h(1, 9), h(2, 0))).toBeLessThan(0);
    expect(compareHlc(h(2, 1), h(2, 0))).toBeGreaterThan(0);
    expect(compareHlc(h(2, 1, A), h(2, 1, B))).toBeLessThan(0);
    expect(compareHlc(h(2, 1), h(2, 1))).toBe(0);
  });

  it('agrees with the lexical order of the encoded strings', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    const values = Array.from({ length: 400 }, () =>
      h(
        rnd(3) === 0 ? rnd(10) : T0 + rnd(5),
        rnd(4) === 0 ? MAX_COUNTER - rnd(2) : rnd(12),
        rnd(2) ? A : B,
      ),
    );
    const byTuple = [...values].sort(compareHlc).map(encodeHlc);
    const byString = values.map(encodeHlc).sort();
    expect(byTuple).toEqual(byString);
  });
});

describe('tick', () => {
  it('takes the wall clock when it moved forward, resetting the counter', () => {
    expect(tick(h(T0, 7), T0 + 5)).toEqual(h(T0 + 5, 0));
  });

  it('increments the counter within one millisecond', () => {
    expect(tick(h(T0, 7), T0)).toEqual(h(T0, 8));
  });

  it('never goes backwards when the wall clock steps back (NTP)', () => {
    expect(tick(h(T0, 7), T0 - 60_000)).toEqual(h(T0, 8));
  });

  it('carries a counter overflow into the physical part', () => {
    expect(tick(h(T0, MAX_COUNTER), T0)).toEqual(h(T0 + 1, 0));
  });

  it('issues strictly increasing values for a 10^6+ batch in one millisecond', () => {
    let c = h(T0, 0);
    let prev = encodeHlc(c);
    for (let i = 0; i < MAX_COUNTER + 5; i++) {
      c = tick(c, T0);
      const s = encodeHlc(c);
      if (s <= prev) throw new Error(`not increasing at ${i}: ${prev} then ${s}`);
      prev = s;
    }
    expect(c.phys).toBe(T0 + 1);
  });
});

describe('receive', () => {
  it('all three equal: max counter + 1', () => {
    expect(receive(h(T0, 4), h(T0, 9, B), T0)).toEqual(h(T0, 10));
  });

  it('local ahead: local counter + 1', () => {
    expect(receive(h(T0 + 5, 4), h(T0, 9, B), T0)).toEqual(h(T0 + 5, 5));
  });

  it('remote ahead: remote counter + 1, keeping the local replica id', () => {
    expect(receive(h(T0, 4), h(T0 + 5, 9, B), T0)).toEqual(h(T0 + 5, 10));
  });

  it('wall clock ahead of both: counter 0', () => {
    expect(receive(h(T0, 4), h(T0 + 1, 9, B), T0 + 10)).toEqual(h(T0 + 10, 0));
  });

  it('the result is greater than both inputs', () => {
    const local = h(T0, 4);
    const remote = h(T0 + 2, MAX_COUNTER, B);
    const out = receive(local, remote, T0);
    expect(compareHlc(out, local)).toBeGreaterThan(0);
    expect(compareHlc(out, remote)).toBeGreaterThan(0);
  });
});

describe('skew bound', () => {
  it('is five minutes by default', () => {
    expect(MAX_DRIFT_MS).toBe(300_000);
    expect(isWithinSkew(h(T0 + MAX_DRIFT_MS, 0, B), T0)).toBe(true);
    expect(isWithinSkew(h(T0 + MAX_DRIFT_MS + 1, 0, B), T0)).toBe(false);
  });
});

describe('SkewHold: per-replica FIFO', () => {
  const txn = (replica: string, replicaSeq: number, index: number, phys: number) => ({
    replica,
    replicaSeq,
    index,
    hlc: encodeHlc(h(phys, 0, replica)),
  });

  it('holds an out-of-bound head and everything behind it from the same replica', () => {
    const hold = new SkewHold();
    const far = T0 + MAX_DRIFT_MS + 60_000;
    hold.offer(txn(B, 2, 0, T0)); // in bounds, but behind the held head
    hold.offer(txn(B, 1, 0, far)); // the head: too far ahead
    hold.offer(txn(A, 1, 0, T0));
    const first = hold.drain(T0);
    expect(first.ready).toEqual([txn(A, 1, 0, T0)]);
    expect(first.held).toEqual([
      { replica: B, head: txn(B, 1, 0, far), waiting: 2, aheadMs: far - T0 },
    ]);
    expect(hold.size).toBe(2);
  });

  it('releases the queue in (replicaSeq, index) order once the head is in bounds, dropping nothing', () => {
    const hold = new SkewHold();
    const far = T0 + MAX_DRIFT_MS + 60_000;
    for (const t of [txn(B, 2, 1, T0), txn(B, 1, 0, far), txn(B, 2, 0, T0), txn(B, 1, 1, T0)]) {
      hold.offer(t);
    }
    expect(hold.drain(T0).ready).toEqual([]);
    const later = hold.drain(far - MAX_DRIFT_MS);
    expect(later.held).toEqual([]);
    expect(later.ready.map((t) => [t.replicaSeq, t.index])).toEqual([
      [1, 0],
      [1, 1],
      [2, 0],
      [2, 1],
    ]);
    expect(hold.size).toBe(0);
  });

  it('a re-offered transaction is not queued twice', () => {
    const hold = new SkewHold();
    hold.offer(txn(A, 1, 0, T0));
    hold.offer(txn(A, 1, 0, T0));
    expect(hold.size).toBe(1);
  });

  it('refuses a transaction whose HLC another replica issued', () => {
    const hold = new SkewHold();
    expect(() => hold.offer({ ...txn(A, 1, 0, T0), replica: B })).toThrow(/not issued by replica/);
  });
});

describe('R7: the HLC never reads a uid', () => {
  it('hlc.ts imports nothing and never mentions a uid outside comments', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'hlc.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bimport\b|\brequire\(/);
    // "uid" anywhere except inside "uuid" (the replica id's format name).
    expect(code).not.toMatch(/(^|[^u])uid/i);
  });
});
