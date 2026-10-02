/**
 * The exact checkpoint rule under concurrent writers (journal spec §2.11, T089): window, pending,
 * voided, revived and pruned, and the stream's cumulative voided set; the v3 ratchet, the replay
 * pin's transitions, the schema floor (T090) and the normal form of the v3 lists (#30 review).
 *
 * Ported from cleo-nexus `packages/shared/src/manifest-check-v3.test.ts` (the server's own cases) so the
 * core mirror of the rules is held to the server's behaviour (T13034). The server's `txnDeltasProblem`
 * is module-private in `@cleocode/contracts/cloud` (arch gate 10), so its cases run through
 * `AppendSegmentRequest`, whose refinement applies it.
 *
 * @task T13034
 */
import { createHash } from 'node:crypto';
import { AppendSegmentRequest, Manifest, Segment, type TxnRef } from '@cleocode/contracts/cloud';
import { describe, expect, it } from 'vitest';
import {
  type CheckpointWindow,
  checkManifest,
  checkManifestV3,
  type DeclaredTxn,
  nextVoidedSet,
  schemaRises,
  windowOf,
} from '../manifest-check.js';
import { manifestCanonical } from '../signing.js';

const H = 'a'.repeat(64);
const R1 = '0192f1c2-7d3e-7abc-8def-0000000000a1';
const R2 = '0192f1c2-7d3e-7abc-8def-0000000000b1';
const PIN = { journal: 'c'.repeat(64), triggerSetHash: 'd'.repeat(64), transitions: [] };
const T = 'tasks_tasks';

const ref = (replicaId: string, replicaSeq: number, txn = 0): TxnRef => ({
  replicaId,
  replicaSeq,
  txn,
});
const tx = (r: TxnRef, created: number, deleted = 0): DeclaredTxn => ({
  ref: r,
  deltas: { [T]: { created, deleted } },
});
const v2 = (rows: number): Manifest => ({ schemaVersion: 1, tables: { [T]: { rows, hash: H } } });
const v3 = (rows: number, over: Partial<Manifest> = {}): Manifest => ({
  ...v2(rows),
  pending: [],
  voided: [],
  revived: [],
  pruned: {},
  replayPin: PIN,
  ...over,
});
const check = (
  parent: Manifest | null,
  next: Manifest,
  window: DeclaredTxn[] | CheckpointWindow,
  parentPending: DeclaredTxn[] = [],
  voidedBefore: DeclaredTxn[] = [],
) =>
  checkManifestV3({
    parent,
    next,
    window: Array.isArray(window) ? windowOf(window) : window,
    parentPending,
    voidedBefore,
    maxAcceptedSchemaVersion: 5,
  });

describe('checkManifestV3', () => {
  it('reduces to the old exact rule with empty lists (v2 manifests, v2 segments)', () => {
    expect(check(v2(10), v2(13), [tx(ref(R1, 0), 3)])).toEqual({ ok: true });
    expect(check(v2(10), v2(12), [tx(ref(R1, 0), 3)])).toMatchObject({
      ok: false,
      code: 'E_REGRESSION',
    });
  });

  it('concurrent inserts of the same uid: one effect voided', () => {
    // A and B both insert uid X; merged state has one row.
    const a = ref(R1, 0);
    const b = ref(R2, 0);
    const next = v3(11, { voided: [{ ref: b, deltas: { [T]: { created: 1, deleted: 0 } } }] });
    expect(check(v2(10), next, [tx(a, 1), tx(b, 1)])).toEqual({ ok: true });
    expect(check(v2(10), v3(11), [tx(a, 1), tx(b, 1)])).toMatchObject({ code: 'E_REGRESSION' });
  });

  it('double delete and a D that loses to a U are voided deletes', () => {
    const a = ref(R1, 0);
    const b = ref(R2, 0);
    const c = ref(R2, 1);
    const next = v3(9, {
      voided: [
        { ref: b, deltas: { [T]: { created: 0, deleted: 1 } } }, // second delete of the same uid
        { ref: c, deltas: { [T]: { created: 0, deleted: 1 } } }, // D lost to a concurrent U
      ],
    });
    expect(check(v2(10), next, [tx(a, 0, 1), tx(b, 0, 1), tx(c, 0, 1)])).toEqual({ ok: true });
  });

  it('deferred ops stay pending and land in a later window', () => {
    const a = ref(R1, 0);
    const p = ref(R2, 0, 1);
    const first = v3(11, { pending: [p] });
    expect(check(v2(10), first, [tx(a, 1), tx(p, 2)])).toEqual({ ok: true });
    // Next window: p lands; its declared deltas come from the parent's pending.
    expect(check(first, v3(13), [], [tx(p, 2)])).toEqual({ ok: true });
    // A pending ref that is neither in the window nor parent-pending is refused.
    expect(check(first, v3(13, { pending: [ref(R2, 9)] }), [], [tx(p, 2)])).toMatchObject({
      code: 'E_MANIFEST_ACCOUNTING',
      findings: [{ reason: 'pending-not-in-window' }],
    });
  });

  it('revival draws only on the cumulative voided set, within what is still voided', () => {
    const b = ref(R2, 0);
    const before = [tx(b, 1)];
    const next = v3(11, { revived: [{ ref: b, deltas: { [T]: { created: 1, deleted: 0 } } }] });
    expect(check(v2(10), next, [], [], before)).toEqual({ ok: true });
    expect(check(v2(10), next, [], [], [])).toMatchObject({
      findings: [{ reason: 'revived-not-voided' }],
    });
    const tooMuch = v3(12, { revived: [{ ref: b, deltas: { [T]: { created: 2, deleted: 0 } } }] });
    expect(check(v2(10), tooMuch, [], [], before)).toMatchObject({
      findings: [{ reason: 'revived-exceeds-voided' }],
    });
  });

  it('a void must name an applied transaction and stay within its declared counts', () => {
    const a = ref(R1, 0);
    expect(
      check(
        v2(10),
        v3(10, { voided: [{ ref: ref(R1, 7), deltas: { [T]: { created: 1, deleted: 0 } } }] }),
        [tx(a, 1)],
      ),
    ).toMatchObject({ findings: [{ reason: 'voided-not-applied' }] });
    expect(
      check(v2(10), v3(9, { voided: [{ ref: a, deltas: { [T]: { created: 2, deleted: 0 } } }] }), [
        tx(a, 1),
      ]),
    ).toMatchObject({ findings: [{ reason: 'voided-exceeds-declared' }] });
    // A pending transaction is not applied, so it cannot be voided either.
    expect(
      check(
        v2(10),
        v3(10, { pending: [a], voided: [{ ref: a, deltas: { [T]: { created: 1, deleted: 0 } } }] }),
        [tx(a, 1)],
      ),
    ).toMatchObject({ findings: [{ reason: 'voided-not-applied' }] });
  });

  it('pruned rows are bounded by what could exist, and counted', () => {
    const a = ref(R1, 0);
    expect(check(v2(10), v3(8, { pruned: { [T]: 3 } }), [tx(a, 1)])).toEqual({ ok: true });
    expect(check(v2(10), v3(0, { pruned: { [T]: 12 } }), [tx(a, 1)])).toMatchObject({
      findings: [{ reason: 'pruned-out-of-range', max: 11 }],
    });
  });

  it('refuses duplicate refs and a non-empty genesis', () => {
    const a = ref(R1, 0);
    expect(check(v2(10), v3(11, { pending: [a, a] }), [tx(a, 1)])).toMatchObject({
      findings: [{ reason: 'duplicate-ref', list: 'pending' }],
    });
    expect(check(null, v3(5), [])).toEqual({ ok: true });
    expect(check(null, v3(5, { pending: [a] }), [])).toMatchObject({
      findings: [{ reason: 'genesis-not-empty' }],
    });
    const pinned = { ...PIN, transitions: [{ seq: 1, schemaVersion: 2, journal: H }] };
    expect(check(null, v3(5, { replayPin: pinned }), [])).toMatchObject({
      findings: [{ reason: 'genesis-not-empty' }],
    });
  });

  it('a table named like an Object.prototype key is counted, not misread', () => {
    const a = ref(R1, 0);
    const parent: Manifest = { schemaVersion: 1, tables: {} };
    const next: Manifest = { schemaVersion: 1, tables: { constructor: { rows: 1, hash: H } } };
    expect(
      check(parent, next, [{ ref: a, deltas: { constructor: { created: 1, deleted: 0 } } }]),
    ).toEqual({
      ok: true,
    });
  });

  it('a schema version above the bound is refused first', () => {
    expect(
      checkManifestV3({
        parent: null,
        next: { ...v3(1), schemaVersion: 9 },
        window: windowOf([]),
        parentPending: [],
        voidedBefore: [],
        maxAcceptedSchemaVersion: 5,
      }),
    ).toMatchObject({ code: 'E_SCHEMA_AHEAD' });
  });

  it('a transition above the bound is E_SCHEMA_AHEAD too', () => {
    const pin = { ...PIN, transitions: [{ seq: 1, schemaVersion: 999, journal: H }] };
    expect(check(v3(1), v3(1, { replayPin: pin }), [])).toMatchObject({
      code: 'E_SCHEMA_AHEAD',
      schemaVersion: 999,
    });
  });
});

describe('#30 review: v3 ratchet, transitions, Decl(A) and the exact rule', () => {
  const a = ref(R1, 0);

  it('MED-1: after a v3 checkpoint a v2 one is refused as E_STREAM_VERSION, never E_REGRESSION', () => {
    // rows = parent + window, which a v2 author would compute: still refused, with its own code.
    expect(check(v3(10), v2(11), [tx(a, 1)])).toEqual({
      ok: false,
      code: 'E_STREAM_VERSION',
      reason: 'stream-v3',
      parentVersion: 3,
      nextVersion: 2,
    });
    // The upgrade (v2 parent, v3 child) and plain v2 lineages are unaffected.
    expect(check(v2(10), v3(11), [tx(a, 1)])).toEqual({ ok: true });
    expect(check(v2(10), v2(11), [tx(a, 1)])).toEqual({ ok: true });
  });

  it('LOW-6: every parent pending ref must resolve', () => {
    const p = ref(R2, 0);
    expect(check(v3(10, { pending: [p] }), v3(12), [], [])).toMatchObject({
      code: 'E_MANIFEST_ACCOUNTING',
      findings: [{ reason: 'pending-unresolved', ref: p }],
    });
    expect(check(v3(10, { pending: [p] }), v3(12), [], [tx(p, 2)])).toEqual({ ok: true });
  });

  it('LOW-5: Decl(A) from the window sum, with only the named transactions loaded', () => {
    const p = ref(R2, 0, 1);
    // The window holds a (+1, not named) and p (+2, named pending): only p is passed.
    const w: CheckpointWindow = {
      deltas: { [T]: { created: 3, deleted: 0 } },
      txns: [tx(p, 2)],
      schemaVersions: [],
    };
    expect(check(v2(10), v3(11, { pending: [p] }), w)).toEqual({ ok: true });
    expect(check(v2(10), v3(13, { pending: [p] }), w)).toMatchObject({ code: 'E_REGRESSION' });
    // A void of a transaction the server did not load is not in the window.
    expect(
      check(
        v2(10),
        v3(12, { voided: [{ ref: ref(R1, 7), deltas: { [T]: { created: 1, deleted: 0 } } }] }),
        w,
      ),
    ).toMatchObject({ findings: [{ reason: 'voided-not-applied' }] });
  });

  it('LOW-2: transitions are exactly the window rise points from the parent schemaVersion', () => {
    const versions = [
      { seq: 3, schemaVersion: 1 },
      { seq: 4, schemaVersion: 2 },
      { seq: 5, schemaVersion: 1 },
      { seq: 6, schemaVersion: 3 },
      { seq: 7, schemaVersion: 2 },
    ];
    expect(schemaRises(1, versions)).toEqual([
      { seq: 4, schemaVersion: 2 },
      { seq: 6, schemaVersion: 3 },
    ]);
    expect(schemaRises(2, versions)).toEqual([{ seq: 6, schemaVersion: 3 }]);
    const w = windowOf([], versions);
    const pin = (ts: Array<[number, number]>) => ({
      ...PIN,
      transitions: ts.map(([seq, schemaVersion]) => ({ seq, schemaVersion, journal: H })),
    });
    // A manifest whose window rose to 3 is at schemaVersion 3 itself (T090).
    const at3 = (over: Partial<Manifest>) => ({ ...v3(10, over), schemaVersion: 3 });
    expect(
      check(
        v3(10),
        at3({
          replayPin: pin([
            [4, 2],
            [6, 3],
          ]),
        }),
        w,
      ),
    ).toEqual({ ok: true });
    for (const wrong of [
      [],
      [[6, 3]],
      [[4, 2]],
      [
        [4, 2],
        [7, 3],
      ],
      [
        [3, 1],
        [4, 2],
        [6, 3],
      ],
    ] as Array<Array<[number, number]>>) {
      expect(check(v3(10), at3({ replayPin: pin(wrong) }), w)).toMatchObject({
        code: 'E_MANIFEST_ACCOUNTING',
        findings: [{ reason: 'transitions-mismatch' }],
      });
    }
    // The baseline is the parent's schemaVersion: from a schema-2 parent only the rise to 3 counts.
    const parent2 = { ...v3(10), schemaVersion: 2 };
    expect(
      check(parent2, { ...v3(10, { replayPin: pin([[6, 3]]) }), schemaVersion: 3 }, w),
    ).toEqual({
      ok: true,
    });
  });

  it("T090: the manifest schemaVersion is at least the parent's and the window's last rise", () => {
    const versions = [
      { seq: 3, schemaVersion: 1 },
      { seq: 4, schemaVersion: 2 },
    ];
    const w = windowOf([], versions);
    const pin = { ...PIN, transitions: [{ seq: 4, schemaVersion: 2, journal: H }] };
    // Its own transitions reach 2, but it claims 1.
    expect(check(v3(10), { ...v3(10, { replayPin: pin }), schemaVersion: 1 }, w)).toMatchObject({
      code: 'E_MANIFEST_ACCOUNTING',
      findings: [{ reason: 'schema-version-below-floor', schemaVersion: 1, floor: 2 }],
    });
    expect(check(v3(10), { ...v3(10, { replayPin: pin }), schemaVersion: 2 }, w)).toEqual({
      ok: true,
    });
    // A child at 1 under a parent at 4, with no rise in its window.
    const parent4 = { ...v3(10), schemaVersion: 4 };
    expect(check(parent4, v3(10), windowOf([], []))).toMatchObject({
      findings: [{ reason: 'schema-version-below-floor', schemaVersion: 1, floor: 4 }],
    });
    expect(check(parent4, { ...v3(10), schemaVersion: 4 }, windowOf([], []))).toEqual({ ok: true });
  });

  it('T090: the floor is the highest rise, not the last window segment', () => {
    // The window rises to 3, then a segment at 2 follows: the replay reached 3.
    const w = windowOf(
      [],
      [
        { seq: 3, schemaVersion: 3 },
        { seq: 4, schemaVersion: 2 },
      ],
    );
    const pin = { ...PIN, transitions: [{ seq: 3, schemaVersion: 3, journal: H }] };
    expect(check(v3(10), { ...v3(10, { replayPin: pin }), schemaVersion: 2 }, w)).toMatchObject({
      findings: [{ reason: 'schema-version-below-floor', schemaVersion: 2, floor: 3 }],
    });
    expect(check(v3(10), { ...v3(10, { replayPin: pin }), schemaVersion: 3 }, w)).toEqual({
      ok: true,
    });
  });

  it('T090: a genesis covering segments is floored by their highest rise (T13048)', () => {
    const w = windowOf(
      [],
      [
        { seq: 1, schemaVersion: 1 },
        { seq: 2, schemaVersion: 2 },
      ],
    );
    expect(check(null, { ...v3(5), schemaVersion: 1 }, w)).toMatchObject({
      code: 'E_MANIFEST_ACCOUNTING',
      findings: [{ reason: 'schema-version-below-floor', schemaVersion: 1, floor: 2 }],
    });
    expect(check(null, { ...v3(5), schemaVersion: 2 }, w)).toEqual({ ok: true });
    // A genesis with no segments has no floor beyond its own version.
    expect(check(null, v3(5), windowOf([], []))).toEqual({ ok: true });
  });

  it('LOW-3: an absent table with net deletes, and a new table with undeclared rows, are refused', () => {
    const del = { ref: a, deltas: { brain_x: { created: 0, deleted: 3 } } };
    expect(check(v3(5), v3(5), [del])).toMatchObject({
      code: 'E_REGRESSION',
      tables: [{ table: 'brain_x', expectedRows: -3, actualRows: 0, reason: 'missing-table' }],
    });
    const grown: Manifest = {
      ...v3(5),
      tables: { [T]: { rows: 5, hash: H }, brain_x: { rows: 1000, hash: H } },
    };
    expect(check(v3(5), grown, [])).toMatchObject({
      code: 'E_REGRESSION',
      tables: [{ table: 'brain_x', expectedRows: 0, actualRows: 1000 }],
    });
    // Declared creates make the new table fine; an empty new table needs none.
    expect(
      check(v3(5), grown, [{ ref: a, deltas: { brain_x: { created: 1000, deleted: 0 } } }]),
    ).toEqual({
      ok: true,
    });
    const empty: Manifest = {
      ...v3(5),
      tables: { [T]: { rows: 5, hash: H }, brain_x: { rows: 0, hash: H } },
    };
    expect(check(v3(5), empty, [])).toEqual({ ok: true });
    // The v2 rule (checkManifest) is exact the same way.
    expect(checkManifest(v2(5), v2(5), { brain_x: { created: 0, deleted: 3 } }, 5)).toMatchObject({
      code: 'E_REGRESSION',
    });
    expect(
      checkManifest(
        v2(5),
        { ...v2(5), tables: { ...v2(5).tables, brain_x: { rows: 9, hash: H } } },
        {},
        5,
      ),
    ).toMatchObject({ code: 'E_REGRESSION' });
  });
});

describe('#30 review LOW-1: one encoding for equal accounting (zod normal form)', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const parse = (m: unknown) => Manifest.safeParse(m).success;

  it('refuses zero-count table entries, empty deltas and zero prunes', () => {
    expect(parse(v3(1))).toBe(true);
    expect(parse(v3(1, { pruned: { [T]: 0 } }))).toBe(false);
    expect(
      parse(v3(1, { voided: [{ ref: ref(R1, 0), deltas: { [T]: { created: 0, deleted: 0 } } }] })),
    ).toBe(false);
    expect(parse(v3(1, { revived: [{ ref: ref(R1, 0), deltas: {} }] }))).toBe(false);
    expect(
      parse(
        v3(1, {
          voided: [
            {
              ref: ref(R1, 0),
              deltas: { [T]: { created: 1, deleted: 0 }, brain_x: { created: 0, deleted: 0 } },
            },
          ],
        }),
      ),
    ).toBe(false);
    // So the encodings the reviewer could make collide for the same accounting cannot be sent.
    expect(sha(manifestCanonical(v3(1)))).not.toBe(
      sha(manifestCanonical(v3(1, { pruned: { [T]: 0 } }))),
    );
  });

  it('refuses transitions that repeat or fall in seq or schemaVersion', () => {
    const pin = (ts: Array<[number, number]>) =>
      v3(1, {
        replayPin: {
          ...PIN,
          transitions: ts.map(([seq, schemaVersion]) => ({ seq, schemaVersion, journal: H })),
        },
      });
    expect(
      parse(
        pin([
          [3, 1],
          [9, 2],
        ]),
      ),
    ).toBe(true);
    expect(
      parse(
        pin([
          [9, 2],
          [3, 1],
        ]),
      ),
    ).toBe(false);
    expect(
      parse(
        pin([
          [3, 2],
          [3, 1],
        ]),
      ),
    ).toBe(false);
    expect(
      parse(
        pin([
          [3, 2],
          [9, 1],
        ]),
      ),
    ).toBe(false);
    expect(
      parse(
        pin([
          [3, 2],
          [9, 2],
        ]),
      ),
    ).toBe(false);
  });
});

describe('#30 review: segment bounds and old-server pages', () => {
  const seg = {
    replicaId: R2,
    deviceId: '0192f1c2-7d3e-4abc-8def-0000000000c1',
    segmentHash: H,
    replicaSeq: 0,
    schemaVersion: 1,
    hlcMin: `1790545492500-000000-${R2}`,
    hlcMax: `1790545492500-000000-${R2}`,
    deltas: {},
    signature: 'AA==',
    ciphertext: 'AA==',
  };

  it('LOW-5: a segment cannot declare more transactions than ops', () => {
    const txnDeltas = Array.from({ length: 3 }, (_, i) => ({ txn: i, deltas: {} }));
    expect(AppendSegmentRequest.safeParse({ ...seg, opCount: 3, txnDeltas }).success).toBe(true);
    expect(AppendSegmentRequest.safeParse({ ...seg, opCount: 2, txnDeltas }).success).toBe(false);
  });

  it('HIGH-1: a pulled segment without txnDeltas (a server before segment/v3) reads as v2', () => {
    const { ciphertext: _c, ...rest } = seg;
    const pulled = {
      ...rest,
      seq: 1,
      opCount: 1,
      ciphertext: 'AA==',
      blobSha256: null,
      receivedAt: new Date(0).toISOString(),
    };
    expect(Segment.safeParse(pulled).success).toBe(true);
    expect(Segment.safeParse({ ...pulled, txnDeltas: null }).success).toBe(true);
    expect(Segment.safeParse({ ...pulled, txnDeltas: [{ txn: 0, deltas: {} }] }).success).toBe(
      true,
    );
  });
});

describe('nextVoidedSet', () => {
  it('adds voided, subtracts revived, drops what is left with nothing', () => {
    const a = ref(R1, 0);
    const b = ref(R2, 0);
    const after = nextVoidedSet([tx(a, 2)], [tx(b, 1)], [tx(a, 2)]);
    expect(after).toEqual([{ ref: b, deltas: { [T]: { created: 1, deleted: 0 } } }]);
    expect(nextVoidedSet([tx(a, 2)], [], [tx(a, 1)])).toEqual([
      { ref: a, deltas: { [T]: { created: 1, deleted: 0 } } },
    ]);
  });
});

describe("txnDeltas sum check (the server's txnDeltasProblem, through AppendSegmentRequest)", () => {
  const deltas = { [T]: { created: 3, deleted: 1 } };
  const seg = (
    txnDeltas: Array<{ txn: number; deltas: Record<string, { created: number; deleted: number }> }>,
  ) => ({
    replicaId: R1,
    deviceId: '0192f1c2-7d3e-4abc-8def-0000000000c1',
    segmentHash: H,
    replicaSeq: 0,
    schemaVersion: 1,
    opCount: 4,
    hlcMin: `1790545492500-000000-${R1}`,
    hlcMax: `1790545492500-000000-${R1}`,
    deltas,
    txnDeltas,
    signature: 'AA==',
    ciphertext: 'AA==',
  });
  const SUM_RULE = 'txnDeltas must index every transaction 0..n-1 in order and sum to deltas';
  const refusal = (txnDeltas: Parameters<typeof seg>[0]) =>
    AppendSegmentRequest.safeParse(seg(txnDeltas)).error?.issues.map((i) => i.message);
  it('accepts contiguous transactions that sum to the segment deltas', () => {
    expect(
      AppendSegmentRequest.safeParse(
        seg([
          { txn: 0, deltas: { [T]: { created: 2, deleted: 0 } } },
          { txn: 1, deltas: { [T]: { created: 1, deleted: 1 } } },
        ]),
      ).success,
    ).toBe(true);
  });
  it('refuses gaps, reordering, an empty list and a wrong sum', () => {
    expect(refusal([])).toContain(SUM_RULE);
    expect(refusal([{ txn: 1, deltas }])).toContain(SUM_RULE);
    expect(refusal([{ txn: 0, deltas: { [T]: { created: 3, deleted: 0 } } }])).toContain(SUM_RULE);
    expect(
      refusal([{ txn: 0, deltas: { ...deltas, brain_x: { created: 1, deleted: 0 } } }]),
    ).toContain(SUM_RULE);
  });
});
