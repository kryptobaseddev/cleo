/**
 * Tests for the admission ledger (T13133): one byte budget, one FIFO queue
 * with backfill and reservation, verified re-entrancy, liveness, and a
 * critical section that loses no update under 20 concurrent admitters.
 *
 * @task T13133
 */

import { execFileSync } from 'node:child_process';
import * as fileSystem from 'node:fs';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMISSION_ENV,
  ADMISSION_PRESSURE_ENV,
  admissionCapacityBytes,
  admissionToken,
  admit,
  budgetShare,
  describeAdmissionIoError,
  describeCharge,
  describeHolders,
  describeScope,
  enclosingGrant,
  entryLiveness,
  entryVerdict,
  footprintForTool,
  GIB,
  gitHookInstalled,
  HEAVY_FOOTPRINT_BYTES,
  LEDGER_HEARTBEAT_STALE_MS,
  LEDGER_ORPHAN_MS,
  LEDGER_RESERVATION_MS,
  type LedgerEntry,
  lightBudgetShare,
  type ProcessFacts,
  planFootprintBytes,
  planRunFootprint,
  readForeignEntries,
  readLedger,
  readLedgerBudget,
  reapLedger,
  removeLedgerEntry,
  schedulePass,
  suspectCycle,
  TINY_LANE_SLOTS,
  TINY_LANE_WINDOWS,
  URGENT_AGING_MS,
} from '../admission-ledger.js';
import type { ResourceSample } from '../backend.js';
import { scriptFootprint } from '../hook-footprint.js';
import { ResourceMonitor } from '../monitor.js';
import { _resetMemoryGateForTest, memoryGateReporter } from '../pressure-gate.js';
import { lightCommandReason } from '../run-class.js';
import type { PidProbe } from '../slot-holder.js';
import { _resetToolGroupsForTest, trackToolGroup } from '../tool-groups.js';
import { TOP_MEMORY_FAILED_REUSE_MS } from '../top-memory.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const HOST = hostname();

function entry(over: Partial<LedgerEntry> & Pick<LedgerEntry, 'id'>): LedgerEntry {
  return {
    nonce: 'n',
    pid: 4242,
    host: HOST,
    startedAt: 'Sat Oct 3 10:00:00 2026',
    label: 'tool:test',
    command: 'cleo verify T1',
    cwd: '/p',
    footprintBytes: GIB,
    state: 'waiting',
    enqueuedAtMs: 0,
    admittedAtMs: null,
    heartbeatAtMs: 0,
    toolGroups: [],
    ...over,
  };
}

function sampleAt(memSome: number, cpuSome: number | null = null): ResourceSample {
  const line = (v: number) => ({ avg10: v, avg60: v, avg300: v, totalUs: 0 });
  return {
    sampledAtMs: 0,
    pressureAvailable: true,
    memAvailableBytes: 8 * GIB,
    globalPressure: { some: line(memSome), full: line(0) },
    slicePressure: null,
    cpuPressure: cpuSome === null ? null : { some: line(cpuSome), full: null },
    walObservations: [],
  };
}

const admittedIds = (es: readonly LedgerEntry[]): string[] =>
  es.filter((e) => e.state === 'admitted').map((e) => e.id);

describe('footprints and capacity', () => {
  it('a 48 GiB machine holds two heavy runs (18 GiB each of 36 GiB, T13132); single-process runs are charged their heap', () => {
    expect(admissionCapacityBytes(48 * GIB)).toBe(36 * GIB);
    expect(footprintForTool('test', 48 * GIB)).toBe(18 * GIB);
    // typecheck and lint: the planned heap (default 4096 MiB) + 2048 MiB of process overhead
    expect(footprintForTool('typecheck', 48 * GIB)).toBe(6 * GIB);
    expect(footprintForTool('lint', 48 * GIB)).toBe(6 * GIB);
    expect(footprintForTool('typecheck', 48 * GIB, 8192)).toBe(10 * GIB);
    expect(footprintForTool('audit', 48 * GIB)).toBe(GIB);
  });

  it('a 16 GiB laptop keeps 4 GiB back and charges a heavy run 1 worker', () => {
    expect(admissionCapacityBytes(16 * GIB)).toBe(12 * GIB);
    expect(footprintForTool('test', 16 * GIB)).toBe(6 * GIB);
  });

  it('a planned run is charged packages × workers × (heap + overhead) (T13132)', () => {
    expect(planFootprintBytes({ workspaceConcurrency: 1, workers: 3, heapMb: 4096 })).toBe(
      18 * GIB,
    );
    expect(planFootprintBytes({ workspaceConcurrency: 2, workers: 1, heapMb: 1024 })).toBe(6 * GIB);
  });
});

describe('schedulePass', () => {
  const ctx = { capacityBytes: 10 * GIB, share: 'full' as const, nowMs: 1_000 };

  it('admits in FIFO order while the budget lasts', () => {
    const out = schedulePass(
      [
        entry({ id: 'b', enqueuedAtMs: 2, footprintBytes: 4 * GIB }),
        entry({ id: 'a', enqueuedAtMs: 1, footprintBytes: 4 * GIB }),
        entry({ id: 'c', enqueuedAtMs: 3, footprintBytes: 4 * GIB }),
      ],
      ctx,
    );
    expect(admittedIds(out).sort()).toEqual(['a', 'b']);
  });

  it('backfills a small run past a young big one that does not fit', () => {
    const out = schedulePass(
      [
        entry({ id: 'held', state: 'admitted', footprintBytes: 6 * GIB }),
        entry({ id: 'big', enqueuedAtMs: 900, footprintBytes: 8 * GIB }),
        entry({ id: 'small', enqueuedAtMs: 950, footprintBytes: GIB }),
      ],
      ctx,
    );
    expect(admittedIds(out).sort()).toEqual(['held', 'small']);
  });

  it('a big run waiting past the reservation stops backfill, so it cannot starve', () => {
    // 2 GiB: above the tiny lane (T13367), so the reservation holds it back.
    const out = schedulePass(
      [
        entry({ id: 'held', state: 'admitted', footprintBytes: 6 * GIB }),
        entry({ id: 'big', enqueuedAtMs: 0, footprintBytes: 8 * GIB }),
        entry({ id: 'small', enqueuedAtMs: 950, footprintBytes: 2 * GIB }),
      ],
      { ...ctx, nowMs: LEDGER_RESERVATION_MS },
    );
    expect(admittedIds(out)).toEqual(['held']);
  });

  it('the tiny lane passes a blocked head: at most TINY_LANE_SLOTS runs of 1 GiB or less (T13367)', () => {
    const out = schedulePass(
      [
        entry({ id: 'held', state: 'admitted', footprintBytes: 4 * GIB }),
        entry({ id: 'big', enqueuedAtMs: 0, footprintBytes: 8 * GIB }),
        ...[1, 2, 3, 4].map((n) =>
          entry({ id: `fmt${n}`, enqueuedAtMs: 900 + n, footprintBytes: GIB }),
        ),
      ],
      { ...ctx, nowMs: LEDGER_RESERVATION_MS },
    );
    expect(TINY_LANE_SLOTS).toBe(3);
    expect(admittedIds(out).sort()).toEqual(['fmt1', 'fmt2', 'fmt3', 'held']);
  });

  it('a blocked head is admitted under steady 1 GiB arrivals: the tiny lane closes (T13389)', () => {
    // One pass per 30 s: the oldest tiny run finishes and a new one arrives.
    const step = 30_000;
    const run = (head: number, held: number, tinies: number): number | null => {
      let ledger: LedgerEntry[] = [
        entry({ id: 'head', enqueuedAtMs: 0, footprintBytes: head }),
        ...(held > 0 ? [entry({ id: 'held', state: 'admitted', footprintBytes: held })] : []),
        ...Array.from({ length: tinies }, (_, k) =>
          entry({ id: `t-${k}`, state: 'admitted', enqueuedAtMs: 1 + k, footprintBytes: GIB }),
        ),
      ];
      for (let n = 1; n <= 50; n++) {
        const nowMs = LEDGER_RESERVATION_MS + n * step;
        const oldest = ledger.find((e) => e.state === 'admitted' && e.id.startsWith('t'));
        ledger = ledger.filter((e) => e !== oldest);
        ledger.push(entry({ id: `t${n}`, enqueuedAtMs: nowMs, footprintBytes: GIB }));
        ledger = schedulePass(ledger, { ...ctx, nowMs });
        if (ledger.find((e) => e.id === 'head')?.state === 'admitted') return n;
      }
      return null;
    };
    // A head charged the whole budget never opens the lane: it starts once the tiny run drains.
    expect(run(10 * GIB, 0, 1)).toBe(1);
    // A partial head, with two tiny runs always in flight, starts at most one
    // pass after the lane closes (it waited TINY_LANE_WINDOWS reservations).
    const lastOpenPass = (LEDGER_RESERVATION_MS * (TINY_LANE_WINDOWS - 1)) / step;
    const n = run(8 * GIB, 1.5 * GIB, 2);
    expect(n).not.toBeNull();
    expect(n as number).toBeLessThanOrEqual(lastOpenPass + 2);
  });

  it('the tiny lane never takes more than the memory budget leaves (T13367)', () => {
    const out = schedulePass(
      [
        entry({ id: 'held', state: 'admitted', footprintBytes: 9.5 * GIB }),
        entry({ id: 'big', enqueuedAtMs: 0, footprintBytes: 8 * GIB }),
        entry({ id: 'fmt', enqueuedAtMs: 950, footprintBytes: GIB }),
      ],
      { ...ctx, nowMs: LEDGER_RESERVATION_MS },
    );
    expect(admittedIds(out)).toEqual(['held']);
  });

  describe('the tiny reserve sits outside the pressure share (T13587)', () => {
    const halved = {
      capacityBytes: 48 * GIB,
      share: 'half' as const,
      lightShare: 'half' as const,
      nowMs: LEDGER_RESERVATION_MS,
    };
    const holder = entry({ id: 'holder', state: 'admitted', footprintBytes: 24 * GIB });

    it('a 24 GiB holder on a halved 48 GiB budget admits a 1 GiB head', () => {
      const out = schedulePass(
        [holder, entry({ id: 'fmt', enqueuedAtMs: 0, footprintBytes: GIB })],
        halved,
      );
      expect(admittedIds(out).sort()).toEqual(['fmt', 'holder']);
    });

    it('only tiny runs use it, at most TINY_LANE_SLOTS of them', () => {
      const out = schedulePass(
        [
          holder,
          entry({ id: 'build', enqueuedAtMs: 0, footprintBytes: 2 * GIB }),
          ...[1, 2, 3, 4].map((n) =>
            entry({ id: `fmt${n}`, enqueuedAtMs: n, footprintBytes: GIB }),
          ),
        ],
        halved,
      );
      expect(admittedIds(out).sort()).toEqual(['fmt1', 'fmt2', 'fmt3', 'holder']);
    });

    it('never starves a whole-capacity head behind steady tiny arrivals (T13591)', () => {
      // One pass per 30 s: the oldest tiny run finishes and a new one arrives.
      const step = 30_000;
      let ledger: LedgerEntry[] = [
        entry({ id: 'head', enqueuedAtMs: 0, footprintBytes: 48 * GIB }),
        ...[0, 1, 2].map((k) =>
          entry({ id: `t-${k}`, state: 'admitted', enqueuedAtMs: 1 + k, footprintBytes: GIB }),
        ),
      ];
      let startedAt: number | null = null;
      for (let n = 1; n <= 50 && startedAt === null; n++) {
        const nowMs = LEDGER_RESERVATION_MS + n * step;
        const oldest = ledger.find((e) => e.state === 'admitted' && e.id.startsWith('t'));
        ledger = ledger.filter((e) => e !== oldest);
        ledger.push(entry({ id: `t${n}`, enqueuedAtMs: nowMs, footprintBytes: GIB }));
        ledger = schedulePass(ledger, { ...halved, nowMs });
        if (ledger.find((e) => e.id === 'head')?.state === 'admitted') startedAt = n;
      }
      // The reserve stays shut for it, so the running tiny runs drain and it starts.
      expect(startedAt).not.toBeNull();
      expect(startedAt as number).toBeLessThanOrEqual(4);
    });

    it('a near-capacity head waits at most TINY_LANE_WINDOWS reservations behind steady tiny arrivals (T13591)', () => {
      // 46 GiB: under the capacity, over the halved budget, so it starts only
      // once nothing runs; the reserve must close for the tiny runs to drain.
      const step = 30_000;
      let ledger: LedgerEntry[] = [
        entry({ id: 'head', enqueuedAtMs: 0, footprintBytes: 46 * GIB }),
      ];
      let startedAt: number | null = null;
      for (let n = 1; n <= 80 && startedAt === null; n++) {
        const nowMs = n * step;
        const tinies = ledger.filter((e) => e.state === 'admitted' && e.id.startsWith('t'));
        if (tinies.length >= 2) ledger = ledger.filter((e) => e !== tinies[0]);
        ledger.push(entry({ id: `t${n}`, enqueuedAtMs: nowMs, footprintBytes: GIB }));
        ledger = schedulePass(ledger, { ...halved, nowMs });
        if (ledger.find((e) => e.id === 'head')?.state === 'admitted') startedAt = nowMs;
      }
      expect(startedAt).not.toBeNull();
      expect(startedAt as number).toBeLessThanOrEqual(
        LEDGER_RESERVATION_MS * TINY_LANE_WINDOWS + 4 * step,
      );
    });

    it('the reserve never admits past a waiting whole-capacity head, even before its reservation (T13591)', () => {
      const ledger = [
        entry({ id: 'head', enqueuedAtMs: 0, footprintBytes: 48 * GIB }),
        // Fills the halved budget: only the reserve could admit the formatter.
        entry({ id: 'busy', state: 'admitted', footprintBytes: 24 * GIB }),
        entry({ id: 'fmt', enqueuedAtMs: 10, footprintBytes: GIB }),
      ];
      const young = { ...halved, nowMs: 1_000 };
      expect(admittedIds(schedulePass(ledger, young)).sort()).toEqual(['busy']);
      // A head that fits under the capacity leaves the reserve open while it is young.
      const partial = ledger.map((e) => (e.id === 'head' ? { ...e, footprintBytes: 20 * GIB } : e));
      expect(admittedIds(schedulePass(partial, young))).toContain('fmt');
    });

    it('the memory gate (none) still admits nothing', () => {
      const out = schedulePass([holder, entry({ id: 'fmt', footprintBytes: GIB })], {
        ...halved,
        share: 'none',
        lightShare: 'none',
      });
      expect(admittedIds(out)).toEqual(['holder']);
    });
  });

  it('a run larger than the capacity runs alone, never waiting forever on its size', () => {
    const huge = entry({ id: 'huge', footprintBytes: 99 * GIB });
    expect(admittedIds(schedulePass([huge], ctx))).toEqual(['huge']);
    expect(admittedIds(schedulePass([entry({ id: 'x', state: 'admitted' }), huge], ctx))).toEqual([
      'x',
    ]);
  });

  it('hold halves the budget but still starts one run when nothing runs', () => {
    const waiting = [
      entry({ id: 'a', enqueuedAtMs: 1, footprintBytes: 4 * GIB }),
      entry({ id: 'b', enqueuedAtMs: 2, footprintBytes: 4 * GIB }),
    ];
    expect(admittedIds(schedulePass(waiting, { ...ctx, share: 'half' }))).toEqual(['a']);
    const big = [entry({ id: 'big', footprintBytes: 9 * GIB })];
    expect(admittedIds(schedulePass(big, { ...ctx, share: 'half' }))).toEqual(['big']);
  });

  it('CPU saturation admits one heavy run at a time; the memory gate admits none', () => {
    const big = { capacityBytes: 100 * GIB, nowMs: 1_000 };
    const heavy = (id: string, at: number) =>
      entry({ id, enqueuedAtMs: at, footprintBytes: HEAVY_FOOTPRINT_BYTES + GIB });
    const waiting = [heavy('a', 1), heavy('b', 2)];
    expect(
      admittedIds(schedulePass(waiting, { ...big, share: 'one', lightShare: 'full' })),
    ).toEqual(['a']);
    expect(
      admittedIds(schedulePass(waiting, { ...big, share: 'none', lightShare: 'none' })),
    ).toEqual([]);
  });

  it('a CPU-blocked heavy head past its reservation keeps its bytes, but light runs still pass (#1865 MED-1)', () => {
    const ctx48 = { capacityBytes: 48 * GIB, share: 'one' as const, lightShare: 'full' as const };
    const ledger = [
      entry({ id: 'h1', state: 'admitted', footprintBytes: 18 * GIB, admittedAtMs: 0 }),
      entry({ id: 'h2', enqueuedAtMs: 0, footprintBytes: 18 * GIB }),
      entry({ id: 'l1', enqueuedAtMs: 1_000, footprintBytes: 2 * GIB }),
    ];
    expect(admittedIds(schedulePass(ledger, { ...ctx48, nowMs: 60_000 }))).toEqual(['h1', 'l1']);
    expect(admittedIds(schedulePass(ledger, { ...ctx48, nowMs: 200_000 }))).toEqual(['h1', 'l1']);
    // ... but never into the head's reserved share: 18 + 18 reserved + 13 > 48.
    const big = [
      ...ledger.slice(0, 2),
      entry({ id: 'l2', enqueuedAtMs: 1_000, footprintBytes: 13 * GIB }),
    ];
    expect(admittedIds(schedulePass(big, { ...ctx48, nowMs: 200_000 }))).toEqual(['h1']);
    // A head blocked by bytes still stops everything behind it.
    const bytes = [
      entry({ id: 'h1', state: 'admitted', footprintBytes: 40 * GIB, admittedAtMs: 0 }),
      entry({ id: 'h2', enqueuedAtMs: 0, footprintBytes: 18 * GIB }),
      entry({ id: 'l1', enqueuedAtMs: 1_000, footprintBytes: 2 * GIB }),
    ];
    expect(admittedIds(schedulePass(bytes, { ...ctx48, share: 'full', nowMs: 200_000 }))).toEqual([
      'h1',
    ]);
  });

  it('CPU saturation never serialises light runs behind a heavy one (T13132)', () => {
    const big = { capacityBytes: 100 * GIB, nowMs: 1_000 };
    const ledger = [
      entry({ id: 'h', state: 'admitted', footprintBytes: 18 * GIB, admittedAtMs: 1 }),
      entry({ id: 'h2', enqueuedAtMs: 2, footprintBytes: 18 * GIB }),
      // A typecheck (heap + overhead = 6 GiB) and a single-file test run.
      entry({ id: 'tc', enqueuedAtMs: 3, footprintBytes: HEAVY_FOOTPRINT_BYTES }),
      entry({ id: 'one-file', enqueuedAtMs: 4, footprintBytes: 6 * GIB }),
    ];
    const out = schedulePass(ledger, { ...big, share: 'one', lightShare: 'full' });
    expect(admittedIds(out)).toEqual(['h', 'tc', 'one-file']);
    // Memory pressure (half) narrows light runs too.
    const half = schedulePass(ledger, {
      capacityBytes: 40 * GIB,
      nowMs: 1_000,
      share: 'one',
      lightShare: 'half',
    });
    expect(admittedIds(half)).toEqual(['h']);
  });
});

describe('an urgent run queues ahead of routine work, within the budget (T13921)', () => {
  const ctx = { capacityBytes: 24 * GIB, share: 'full' as const, nowMs: 1_000 };

  it('is admitted before older routine waiters when only one fits', () => {
    const out = schedulePass(
      [
        entry({ id: 'holder', state: 'admitted', footprintBytes: 12 * GIB, admittedAtMs: 0 }),
        entry({ id: 'push-1', footprintBytes: 12 * GIB, enqueuedAtMs: 1 }),
        entry({ id: 'push-2', footprintBytes: 12 * GIB, enqueuedAtMs: 2 }),
        entry({ id: 'fix', footprintBytes: 12 * GIB, enqueuedAtMs: 3, priority: 'urgent' }),
      ],
      ctx,
    );
    expect(admittedIds(out)).toEqual(['holder', 'fix']);
  });

  it('never exceeds the budget: with no room it waits, at the head of the queue', () => {
    const out = schedulePass(
      [
        entry({ id: 'holder', state: 'admitted', footprintBytes: 20 * GIB, admittedAtMs: 0 }),
        entry({ id: 'push-1', footprintBytes: 2 * GIB, enqueuedAtMs: 1 }),
        entry({ id: 'fix', footprintBytes: 12 * GIB, enqueuedAtMs: 3, priority: 'urgent' }),
      ],
      ctx,
    );
    // The routine run that fits may still backfill around the waiting urgent head.
    expect(admittedIds(out)).toEqual(['holder', 'push-1']);
  });

  it('a young urgent run that does not fit never takes the reservation of an older head', () => {
    const nowMs = LEDGER_RESERVATION_MS + 10_000;
    const out = schedulePass(
      [
        entry({ id: 'holder', state: 'admitted', footprintBytes: 12 * GIB, admittedAtMs: 0 }),
        // Waited past its reservation: nothing that is not tiny may pass it.
        entry({ id: 'head', footprintBytes: 20 * GIB, enqueuedAtMs: 0 }),
        entry({ id: 'fix', footprintBytes: 16 * GIB, enqueuedAtMs: nowMs - 1, priority: 'urgent' }),
        entry({ id: 'small', footprintBytes: 4 * GIB, enqueuedAtMs: 5 }),
      ],
      { ...ctx, nowMs },
    );
    // Before T13971 the urgent run consumed the head's reservation and 'small' backfilled.
    expect(admittedIds(out)).toEqual(['holder']);
  });

  it('several urgent runs keep FIFO order among themselves', () => {
    const out = schedulePass(
      [
        entry({ id: 'holder', state: 'admitted', footprintBytes: 12 * GIB, admittedAtMs: 0 }),
        entry({ id: 'u-2', footprintBytes: 12 * GIB, enqueuedAtMs: 5, priority: 'urgent' }),
        entry({ id: 'u-1', footprintBytes: 12 * GIB, enqueuedAtMs: 4, priority: 'urgent' }),
      ],
      ctx,
    );
    expect(admittedIds(out)).toEqual(['holder', 'u-1']);
  });

  it('a routine run waiting URGENT_AGING_MS is no longer passed by a new urgent one', () => {
    const nowMs = URGENT_AGING_MS + 60_000;
    const out = schedulePass(
      [
        entry({ id: 'holder', state: 'admitted', footprintBytes: 12 * GIB, admittedAtMs: 0 }),
        entry({ id: 'old-push', footprintBytes: 12 * GIB, enqueuedAtMs: 0 }),
        entry({ id: 'fix', footprintBytes: 12 * GIB, enqueuedAtMs: nowMs - 1, priority: 'urgent' }),
      ],
      { ...ctx, nowMs },
    );
    expect(admittedIds(out)).toEqual(['holder', 'old-push']);
  });
});

describe('the full-build slot is exclusive whatever the footprint (T13237)', () => {
  const ctx = { capacityBytes: 36 * GIB, share: 'full' as const, nowMs: 1_000 };

  it('admits one exclusive run at a time even when two fit the budget', () => {
    const out = schedulePass(
      [
        entry({ id: 'fb1', enqueuedAtMs: 1, footprintBytes: 12 * GIB, exclusive: true }),
        entry({ id: 'fb2', enqueuedAtMs: 2, footprintBytes: 12 * GIB, exclusive: true }),
      ],
      ctx,
    );
    expect(admittedIds(out)).toEqual(['fb1']);
  });

  it('an admitted full build keeps a second one waiting; other runs still share the budget', () => {
    const out = schedulePass(
      [
        entry({ id: 'fb1', state: 'admitted', footprintBytes: 12 * GIB, exclusive: true }),
        entry({ id: 'fb2', enqueuedAtMs: 2, footprintBytes: 2 * GIB, exclusive: true }),
        entry({ id: 'test', enqueuedAtMs: 3, footprintBytes: 12 * GIB }),
      ],
      ctx,
    );
    expect(admittedIds(out).sort()).toEqual(['fb1', 'test']);
  });

  it('a reserved full-build head blocked only by the slot lets light runs pass but no heavy run', () => {
    const out = schedulePass(
      [
        entry({ id: 'fb1', state: 'admitted', footprintBytes: 12 * GIB, exclusive: true }),
        entry({ id: 'fb2', enqueuedAtMs: 0, footprintBytes: 12 * GIB, exclusive: true }),
        entry({ id: 'heavy', enqueuedAtMs: 1, footprintBytes: 12 * GIB }),
        entry({ id: 'light', enqueuedAtMs: 2, footprintBytes: GIB }),
      ],
      { ...ctx, nowMs: 10 * 60_000 },
    );
    expect(admittedIds(out).sort()).toEqual(['fb1', 'light']);
  });
});

describe('no two exclusive runs ever overlap (T13237, #1899 review HIGH)', () => {
  // A 16 GiB host: capacity 12 GiB, and a full build is charged exactly
  // HEAVY_FOOTPRINT_BYTES (6 GiB), so it counts as LIGHT.
  const capacityBytes = admissionCapacityBytes(16 * GIB);

  it('the reviewer sequence: three light exclusive entries past the reservation admit one', () => {
    const entries = [
      entry({ id: 'e1', state: 'admitted', footprintBytes: 6 * GIB, exclusive: true }),
      entry({ id: 'e2', enqueuedAtMs: 0, footprintBytes: 6 * GIB, exclusive: true }),
      entry({ id: 'e3', enqueuedAtMs: 1_000, footprintBytes: 6 * GIB, exclusive: true }),
    ];
    // Also on a 48 GiB host's capacity, where e3 fits beside the reserved
    // head by bytes, so only the exclusive check keeps it out.
    for (const cap of [capacityBytes, admissionCapacityBytes(48 * GIB)]) {
      for (const nowMs of [60_000, 200_000]) {
        const out = schedulePass(entries, { capacityBytes: cap, share: 'full', nowMs });
        expect(admittedIds(out)).toEqual(['e1']);
      }
    }
  });

  it('a light exclusive does not pass a CPU-reserved heavy head while another holds the slot', () => {
    const out = schedulePass(
      [
        entry({ id: 'fb', state: 'admitted', footprintBytes: GIB, exclusive: true }),
        entry({ id: 'heavy-run', state: 'admitted', footprintBytes: 7 * GIB }),
        entry({ id: 'heavy-head', enqueuedAtMs: 0, footprintBytes: 7 * GIB }),
        entry({ id: 'fb2', enqueuedAtMs: 1, footprintBytes: GIB, exclusive: true }),
      ],
      { capacityBytes: 36 * GIB, share: 'one', lightShare: 'full', nowMs: 10 * 60_000 },
    );
    expect(admittedIds(out).sort()).toEqual(['fb', 'heavy-run']);
  });

  it('property: over random arrivals, completions and pressure, at most one exclusive run is admitted', () => {
    // Deterministic PRNG (mulberry32), so a failure reproduces from its seed.
    const rng = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const sizes = [GIB, 6 * GIB, 6 * GIB, 7 * GIB, 12 * GIB, 40 * GIB];
    const shares = ['full', 'full', 'half', 'one'] as const;
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
      let ledger: LedgerEntry[] = [];
      let nowMs = 0;
      let n = 0;
      for (let step = 0; step < 60; step++) {
        nowMs += Math.floor(r() * 90_000);
        // Arrivals.
        const arrivals = Math.floor(r() * 3);
        for (let k = 0; k < arrivals; k++) {
          ledger.push(
            entry({
              id: `s${seed}-${n++}`,
              enqueuedAtMs: nowMs,
              footprintBytes: pick(sizes),
              ...(r() < 0.5 ? { exclusive: true } : {}),
            }),
          );
        }
        // Completions.
        ledger = ledger.filter((e) => e.state !== 'admitted' || r() > 0.3);
        const cap = pick([admissionCapacityBytes(16 * GIB), 36 * GIB]);
        ledger = schedulePass(ledger, {
          capacityBytes: cap,
          share: pick(shares),
          lightShare: pick(['full', 'half'] as const),
          nowMs,
        });
        const exclusives = ledger.filter((e) => e.state === 'admitted' && e.exclusive === true);
        if (exclusives.length > 1) {
          throw new Error(`seed ${seed} step ${step}: ${exclusives.map((e) => e.id).join(', ')}`);
        }
      }
    }
  });
});

describe('entryLiveness', () => {
  const probe = (over: Partial<PidProbe>): PidProbe => ({
    liveness: () => 'alive',
    startedAt: () => 'Sat Oct 3 10:00:00 2026',
    groupLiveness: () => 'gone',
    ...over,
  });
  const now = 20 * LEDGER_HEARTBEAT_STALE_MS;
  // Stale (no heartbeat for 2 minutes) but younger than the orphan bound.
  const stale = { heartbeatAtMs: now - 2 * LEDGER_HEARTBEAT_STALE_MS };
  const orphan = { heartbeatAtMs: now - LEDGER_ORPHAN_MS };

  it('a gone pid is dead at once, unless a tool group it started still runs', () => {
    expect(
      entryLiveness(entry({ id: 'e', heartbeatAtMs: now }), now, probe({ liveness: () => 'gone' })),
    ).toBe('dead');
    expect(
      entryLiveness(
        entry({ id: 'e', heartbeatAtMs: now, toolGroups: [777] }),
        now,
        probe({ liveness: () => 'gone', groupLiveness: () => 'alive' }),
      ),
    ).toBe('alive');
  });

  it('a recycled pid (stale heartbeat, different start time) is dead', () => {
    expect(
      entryLiveness(
        entry({ id: 'e', ...stale }),
        now,
        probe({ startedAt: () => 'Mon Jan 1 00:00:00 2026' }),
      ),
    ).toBe('dead');
  });

  it('a fresh heartbeat or a failed probe keeps it', () => {
    expect(
      entryLiveness(
        entry({ id: 'e', heartbeatAtMs: now }),
        now,
        probe({ startedAt: () => 'other' }),
      ),
    ).toBe('alive');
    expect(
      entryLiveness(entry({ id: 'e', ...stale }), now, probe({ liveness: () => 'unknown' })),
    ).toBe('alive');
    expect(entryLiveness(entry({ id: 'e', ...stale }), now, probe({ startedAt: () => null }))).toBe(
      'alive',
    );
  });

  it('an unidentifiable holder is kept until the orphan bound, then dropped (MED-3)', () => {
    const unknownProbe = probe({ liveness: () => 'unknown' });
    const noStart = probe({ startedAt: () => null });
    const unrecorded = { startedAt: null };
    expect(entryLiveness(entry({ id: 'e', ...stale }), now, unknownProbe)).toBe('alive');
    expect(entryLiveness(entry({ id: 'e', ...orphan }), now, unknownProbe)).toBe('dead');
    expect(entryLiveness(entry({ id: 'e', ...orphan }), now, noStart)).toBe('dead');
    expect(entryLiveness(entry({ id: 'e', ...unrecorded, ...stale }), now, probe({}))).toBe(
      'alive',
    );
    expect(entryLiveness(entry({ id: 'e', ...unrecorded, ...orphan }), now, probe({}))).toBe(
      'dead',
    );
    // A gone holder whose tool group id still runs: the group id may be recycled.
    const groupAlive = probe({ liveness: () => 'gone', groupLiveness: () => 'alive' });
    expect(entryLiveness(entry({ id: 'e', toolGroups: [777], ...stale }), now, groupAlive)).toBe(
      'alive',
    );
    expect(entryLiveness(entry({ id: 'e', toolGroups: [777], ...orphan }), now, groupAlive)).toBe(
      'dead',
    );
  });

  it('an identified live holder is never dropped, however old its heartbeat', () => {
    expect(entryLiveness(entry({ id: 'e', heartbeatAtMs: 0 }), now, probe({}))).toBe('alive');
  });

  it('names the evidence behind each verdict (T14066)', () => {
    const v = (e: LedgerEntry, p: PidProbe) => entryVerdict(e, now, p);
    const alive = (reason: string) => ({ state: 'alive', reason });
    const dead = (reason: string) => ({ state: 'dead', reason });
    const gone = { liveness: () => 'gone' as const };
    expect(v(entry({ id: 'e', heartbeatAtMs: now }), probe({}))).toEqual(alive('pid-alive'));
    expect(v(entry({ id: 'e', ...stale }), probe({}))).toEqual(alive('pid-alive'));
    expect(v(entry({ id: 'e', heartbeatAtMs: now }), probe({ liveness: () => 'unknown' }))).toEqual(
      alive('heartbeat-fresh'),
    );
    expect(v(entry({ id: 'e', ...stale }), probe({ liveness: () => 'unknown' }))).toEqual(
      alive('unidentifiable'),
    );
    expect(
      v(
        entry({ id: 'e', toolGroups: [776, 777], ...stale }),
        probe({ ...gone, groupLiveness: (g) => (g === 777 ? 'alive' : 'gone') }),
      ),
    ).toEqual(alive('group-alive:777'));
    expect(
      v(
        entry({ id: 'e', toolGroups: [777], ...stale }),
        probe({ ...gone, groupLiveness: () => 'unknown' }),
      ),
    ).toEqual(alive('group-unknown:777'));
    expect(v(entry({ id: 'e', heartbeatAtMs: now }), probe(gone))).toEqual(dead('pid-gone'));
    expect(v(entry({ id: 'e', ...stale }), probe({ startedAt: () => 'other' }))).toEqual(
      dead('pid-recycled'),
    );
    expect(v(entry({ id: 'e', ...orphan }), probe({ liveness: () => 'unknown' }))).toEqual(
      dead('orphaned'),
    );
    expect(v(entry({ id: 'e', host: 'elsewhere', heartbeatAtMs: now }), probe({}))).toEqual(
      alive('other-host:elsewhere'),
    );
    expect(v(entry({ id: 'e', host: 'elsewhere', ...stale }), probe({}))).toEqual(
      dead('other-host-stale:elsewhere'),
    );
  });

  it('a gone holder is kept while its recorded child lives, never for a recycled child pid (T13046)', () => {
    const child = { pid: 5000, startedAt: 'child-start' };
    const holderGone = (childStart: string | null): PidProbe =>
      probe({
        liveness: (pid) => (pid === 5000 ? 'alive' : 'gone'),
        startedAt: (pid) => (pid === 5000 ? childStart : null),
      });
    // A foreground or nested child leads no group: toolGroups is empty.
    expect(
      entryVerdict(entry({ id: 'e', child, ...stale }), now, holderGone('child-start')),
    ).toEqual({ state: 'alive', reason: 'child-alive:5000' });
    expect(entryVerdict(entry({ id: 'e', child, ...stale }), now, holderGone('reused'))).toEqual({
      state: 'dead',
      reason: 'pid-gone',
    });
    // `ps` could not say: kept, until the orphan bound.
    expect(entryLiveness(entry({ id: 'e', child, ...stale }), now, holderGone(null))).toBe('alive');
    expect(
      entryLiveness(entry({ id: 'e', child, ...orphan }), now, holderGone('child-start')),
    ).toBe('dead');
  });

  it('another host is judged by its heartbeat alone', () => {
    expect(
      entryLiveness(entry({ id: 'e', host: 'elsewhere', heartbeatAtMs: now }), now, probe({})),
    ).toBe('alive');
    expect(entryLiveness(entry({ id: 'e', host: 'elsewhere', ...stale }), now, probe({}))).toBe(
      'dead',
    );
  });
});

describe('enclosingGrant (re-entrancy)', () => {
  const holder = entry({
    id: 'h',
    nonce: 'secret',
    pid: 500,
    state: 'admitted',
    toolGroups: [600],
  });
  const facts = (over: Partial<ProcessFacts> = {}): ProcessFacts => ({
    ancestorsOf: () => [499, 500, 1],
    groupOf: () => 900,
    startedAt: () => holder.startedAt,
    ...over,
  });

  it('a descendant with the token rides the grant', () => {
    expect(
      enclosingGrant([holder], 1000, { [ADMISSION_ENV]: admissionToken(holder) }, facts()),
    ).toBe(holder);
  });

  it('the token alone grants nothing: not a descendant, no ride', () => {
    expect(
      enclosingGrant(
        [holder],
        1000,
        { [ADMISSION_ENV]: admissionToken(holder) },
        facts({ ancestorsOf: () => [2, 3] }),
      ),
    ).toBeNull();
  });

  it('a scrubbed environment still rides by ancestry', () => {
    expect(enclosingGrant([holder], 1000, {}, facts())).toBe(holder);
  });

  it('a recycled ancestor pid (different start time) is not the holder', () => {
    expect(enclosingGrant([holder], 1000, {}, facts({ startedAt: () => 'other' }))).toBeNull();
  });

  it('a holder recorded without a start time rides by ancestry only with its token (T13188)', () => {
    const unknown = { ...holder, startedAt: null };
    // Its pid may have been recycled into our ancestry: ancestry alone proves nothing.
    expect(enclosingGrant([unknown], 1000, {}, facts())).toBeNull();
    expect(enclosingGrant([unknown], 1000, { [ADMISSION_ENV]: 'h.wrong' }, facts())).toBeNull();
    expect(
      enclosingGrant([unknown], 1000, { [ADMISSION_ENV]: admissionToken(unknown) }, facts()),
    ).toBe(unknown);
  });

  it('membership of a tool group the holder started proves it only with the token (MED-1)', () => {
    const inGroup = facts({ ancestorsOf: () => [1], groupOf: () => 600 });
    expect(
      enclosingGrant([holder], 1000, { [ADMISSION_ENV]: admissionToken(holder) }, inGroup),
    ).toBe(holder);
    // A recycled group id is all a stranger has: without the token it proves nothing.
    expect(enclosingGrant([holder], 1000, {}, inGroup)).toBeNull();
    expect(
      enclosingGrant([holder], 1000, { [ADMISSION_ENV]: 'h.wrong-nonce' }, inGroup),
    ).toBeNull();
    // And never for another host's entry.
    expect(
      enclosingGrant(
        [{ ...holder, host: 'elsewhere' }],
        1000,
        { [ADMISSION_ENV]: admissionToken(holder) },
        inGroup,
      ),
    ).toBeNull();
  });

  it('ancestry proves it whatever the recorded hostname (LOW-4: hostnames follow the network)', () => {
    expect(enclosingGrant([{ ...holder, host: 'renamed.local' }], 1000, {}, facts())).toEqual({
      ...holder,
      host: 'renamed.local',
    });
  });

  it('without a token, the nearest admitted ancestor wins, not the oldest (T13452)', () => {
    const p = entry({ id: 'P', pid: 100, state: 'admitted', footprintBytes: GIB, enqueuedAtMs: 1 });
    const c = entry({
      id: 'C',
      pid: 200,
      state: 'admitted',
      footprintBytes: 24 * GIB,
      enqueuedAtMs: 2,
      parentId: 'P',
    });
    const tree: ProcessFacts = {
      ancestorsOf: () => [200, 100, 1],
      groupOf: () => null,
      startedAt: () => p.startedAt,
    };
    expect(enclosingGrant([p, c], 300, {}, tree)?.id).toBe('C');
    // The token still names the grant to check first.
    expect(enclosingGrant([p, c], 300, { [ADMISSION_ENV]: admissionToken(p) }, tree)?.id).toBe('P');
  });

  it('a holder never rides its own grant, and waiting entries grant nothing', () => {
    expect(enclosingGrant([holder], 500, {}, facts())).toBeNull();
    expect(enclosingGrant([{ ...holder, state: 'waiting' }], 1000, {}, facts())).toBeNull();
  });
});

describe('status names what holds the budget (T13132)', () => {
  it('a holder line carries the scope and task', () => {
    const [line] = describeHolders(
      [
        entry({
          id: 'w',
          state: 'admitted',
          admittedAtMs: 0,
          footprintBytes: 18 * GIB,
          scope: 'full',
          task: 'T1043',
        }),
      ],
      61_000,
    );
    expect(line).toMatch(
      /^tool:test \[scope=full, task T1043\] pid 4242 on .*18 GiB, for 1m 01s; /,
    );
    expect(describeScope({})).toBe('');
  });

  it('light runs take the memory share alone: CPU never narrows them', () => {
    const cpu = { ...sampleAt(0, 95) };
    expect(budgetShare(cpu, false)).toBe('one');
    expect(lightBudgetShare(cpu, false)).toBe('full');
    expect(lightBudgetShare(sampleAt(15), false)).toBe('half');
    expect(lightBudgetShare(sampleAt(0), true)).toBe('none');
  });
});

describe('the wait report says why each holder counts (T14066)', () => {
  it('a holder line shows its host, heartbeat age, child, tool groups and verdict with the reason', () => {
    const groupAlive: PidProbe = {
      liveness: () => 'gone',
      startedAt: () => null,
      groupLiveness: (g) => (g === 9002 ? 'alive' : 'gone'),
    };
    const [line] = describeHolders(
      [
        entry({
          id: 'h',
          state: 'admitted',
          admittedAtMs: 0,
          heartbeatAtMs: 30_000,
          footprintBytes: 24 * GIB,
          cwd: '/private/tmp/job',
          child: { pid: 9001, startedAt: null },
          toolGroups: [9001, 9002],
        }),
      ],
      120_000,
      groupAlive,
    );
    expect(line).toBe(
      `tool:test pid 4242 on ${HOST} (cleo verify T1) in /private/tmp/job, 24 GiB, for 2m 00s; ` +
        'heartbeat 1m 30s ago, child 9001, groups 9001,9002, alive (group-alive:9002)',
    );
  });
});

describe('suspectCycle', () => {
  const table = new Map<number, { ppid: number; command: string }>([
    [
      100,
      { ppid: 1, command: 'node /usr/local/bin/cleo run --class test --wait -- run.sh vitest' },
    ],
    [101, { ppid: 100, command: '/bin/bash /Users/x/.cleo-heavy/run.sh vitest run' }],
    [
      199,
      {
        ppid: 1,
        command: '/bin/bash /Users/x/.cleo-heavy/run.sh cleo verify T1 --evidence tool:test',
      },
    ],
    [200, { ppid: 199, command: 'node /usr/local/bin/cleo verify T1' }],
  ]);
  const holder = entry({ id: 'h', pid: 100, state: 'admitted', label: 'run:test-run' });

  it('names the wrapper both sides run (the 2026-10-03 run.sh inversion)', () => {
    const line = suspectCycle(200, [holder], table);
    expect(line).toContain('suspected wait cycle');
    expect(line).toContain('run.sh (pid 101)');
    expect(line).toContain('run.sh (pid 199)');
  });

  it('says nothing when only generic programs are shared', () => {
    const plain = new Map(table);
    plain.set(199, { ppid: 1, command: '/bin/zsh -c cleo verify T1' });
    expect(suspectCycle(200, [holder], plain)).toBeNull();
  });
});

describe('admit (one ledger, real critical section)', () => {
  let dir: string;
  const calm = async () => sampleAt(0);
  const capacityBytes = 10 * GIB;
  const saved = process.env.CLEO_RESOURCES_MODE;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-ledger-'));
    delete process.env.CLEO_RESOURCES_MODE;
    _resetMemoryGateForTest();
  });
  afterEach(() => {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already writable.
    }
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLEO_RESOURCES_MODE;
    else process.env.CLEO_RESOURCES_MODE = saved;
    _resetMemoryGateForTest();
  });

  // No real `top`/`ps` probe in these tests: a refusal names an empty list.
  const base = { capacityBytes, sample: calm, env: {}, pollMs: 5, topMemory: () => [] };

  it('a half-share ledger names the narrowed budget and its share in the refusal and status (T13572)', async () => {
    const halved = { ...base, sample: async () => sampleAt(15) };
    const a = await admit(
      { label: 'tool:test', footprintBytes: 4 * GIB },
      { ...halved, dir, wait: false },
    );
    expect(a.admitted).toBe(true);
    const b = await admit(
      { label: 'tool:typecheck', footprintBytes: 2 * GIB },
      { ...halved, dir, wait: false },
    );
    expect(b.admitted).toBe(false);
    if (!b.admitted) {
      expect(b.refusal.reason).toMatch(
        /machine budget in use: 4\.0 GiB of 5\.0 GiB (light|heavy) budget \((light|heavy) share half from [a-zA-Z ]+pressure; capacity 10 GiB\)/,
      );
    }
    expect(readLedgerBudget(dir, capacityBytes)).toMatchObject({
      capacityBytes,
      lightShare: 'half',
      lightBudgetBytes: 5 * GIB,
    });
    if (a.admitted) await a.grant.release();
  });

  it('AC2 (T13967): usage above a narrowed budget says it was narrowed after the holders were admitted', async () => {
    const a = await admit(
      { label: 'tool:test', footprintBytes: 8 * GIB },
      { ...base, dir, wait: false },
    );
    expect(a.admitted).toBe(true);
    const b = await admit(
      { label: 'tool:typecheck', footprintBytes: 2 * GIB },
      { ...base, sample: async () => sampleAt(15), dir, wait: false },
    );
    expect(b.admitted).toBe(false);
    if (!b.admitted) {
      expect(b.refusal.reason).toMatch(
        /8\.0 GiB of 5\.0 GiB light budget \(light share half from memory pressure; capacity 10 GiB; narrowed after the running jobs were admitted, so they hold more\)/,
      );
    }
    if (a.admitted) await a.grant.release();
  });

  it('admits within the budget, refuses beyond it with the holders, and frees on release', async () => {
    const a = await admit(
      { label: 'tool:test', footprintBytes: 8 * GIB },
      { ...base, dir, wait: false },
    );
    expect(a.admitted).toBe(true);
    const b = await admit(
      { label: 'tool:typecheck', footprintBytes: 5 * GIB },
      { ...base, dir, wait: false },
    );
    expect(b.admitted).toBe(false);
    if (!b.admitted) {
      expect(b.refusal.reason).toMatch(/machine budget in use: 8\.0 GiB of 10 GiB by 1 run\(s\)/);
      expect(b.refusal.holders[0]).toMatch(/^tool:test pid \d+/);
      expect(b.refusal.memoryPressure).toBeNull();
    }
    expect(readLedger(dir).map((e) => e.state)).toEqual(['admitted']); // the refused run left
    if (a.admitted) {
      expect(a.grant.token).toMatch(/^\d+-\d+-[0-9a-f]+\.[0-9a-f]+$/);
      await a.grant.release();
      await a.grant.release(); // idempotent
    }
    expect(readLedger(dir)).toEqual([]);
    const c = await admit(
      { label: 'tool:typecheck', footprintBytes: 5 * GIB },
      { ...base, dir, wait: false },
    );
    expect(c.admitted).toBe(true);
    if (c.admitted) await c.grant.release();
  });

  it('T13237: a second full build is refused while one holds the slot, naming it; free on release', async () => {
    const first = await admit(
      { label: 'run:full-build', footprintBytes: 2 * GIB, exclusive: true },
      { ...base, dir, wait: false },
    );
    expect(first.admitted).toBe(true);
    const second = await admit(
      { label: 'run:full-build', footprintBytes: 2 * GIB, exclusive: true },
      { ...base, dir, wait: false },
    );
    expect(second.admitted).toBe(false);
    if (!second.admitted) {
      expect(second.refusal.reason).toMatch(
        /holds the machine-wide full-build slot \(run:full-build pid \d+\)/,
      );
    }
    const other = await admit(
      { label: 'tool:test', footprintBytes: 2 * GIB },
      { ...base, dir, wait: false },
    );
    expect(other.admitted).toBe(true);
    if (other.admitted) await other.grant.release();
    if (first.admitted) await first.grant.release();
    const third = await admit(
      { label: 'run:full-build', footprintBytes: 2 * GIB, exclusive: true },
      { ...base, dir, wait: false },
    );
    expect(third.admitted).toBe(true);
    if (third.admitted) await third.grant.release();
  });

  it('a run larger than the budget is charged the budget: it runs alone, and the report says so', async () => {
    const huge = await admit(
      { label: 'tool:test', footprintBytes: 99 * GIB },
      { ...base, dir, wait: false },
    );
    expect(huge.admitted).toBe(true);
    const next = await admit(
      { label: 'tool:lint', footprintBytes: GIB },
      { ...base, dir, wait: false },
    );
    expect(next.admitted).toBe(false);
    if (!next.admitted) {
      expect(next.refusal.reason).toMatch(/^machine budget in use: 10 GiB of 10 GiB by 1 run\(s\)/);
    }
    if (huge.admitted) await huge.grant.release();
  });

  it('a waiting run is admitted as soon as the holder releases', async () => {
    const a = await admit(
      { label: 'tool:test', footprintBytes: 8 * GIB },
      { ...base, dir, wait: false },
    );
    if (!a.admitted) throw new Error('expected an admission');
    const waiting = admit(
      { label: 'tool:build', footprintBytes: 8 * GIB },
      { ...base, dir, wait: true, timeoutMs: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(
      readLedger(dir)
        .map((e) => e.state)
        .sort(),
    ).toEqual(['admitted', 'waiting']);
    await a.grant.release();
    const b = await waiting;
    expect(b.admitted).toBe(true);
    if (b.admitted) {
      expect(b.grant.waitedMs).toBeGreaterThan(0);
      await b.grant.release();
    }
  });

  it('an aborted signal promptly refuses admission and the queue entry is removed (T13681)', async () => {
    const a = await admit(
      { label: 'tool:test', footprintBytes: 8 * GIB },
      { ...base, dir, wait: false },
    );
    if (!a.admitted) throw new Error('expected an admission');
    const stop = new AbortController();
    const waiting = admit(
      { label: 'tool:build', footprintBytes: 8 * GIB },
      { ...base, dir, wait: true, timeoutMs: 600_000, signal: stop.signal },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(
      readLedger(dir)
        .map((e) => e.state)
        .sort(),
    ).toEqual(['admitted', 'waiting']);
    stop.abort();
    const b = await waiting;
    expect(b.admitted).toBe(false);
    await vi.waitFor(() => {
      expect(readLedger(dir).map((e) => e.state)).toEqual(['admitted']);
    });
    await a.grant.release();
  });

  it('the memory gate refuses with the readings; a waiter says so and starts when pressure falls', async () => {
    const refused = await admit(
      { label: 'tool:test', footprintBytes: GIB },
      { ...base, dir, wait: false, sample: async () => sampleAt(40) },
    );
    expect(refused.admitted).toBe(false);
    if (!refused.admitted) {
      expect(refused.refusal.memoryPressure?.score).toBe(40);
      expect(refused.refusal.reason).toMatch(/^memory pressure 40 \(refused above 25/);
    }
    _resetMemoryGateForTest();
    let n = 0;
    const lines: string[] = [];
    const out = await admit(
      { label: 'tool:test', footprintBytes: GIB },
      {
        ...base,
        dir,
        wait: true,
        timeoutMs: 20_000,
        sample: async () => sampleAt(n++ < 2 ? 40 : 5),
        memoryPressure: memoryGateReporter((l) => lines.push(l), 'test run', { intervalMs: 0 }),
      },
    );
    expect(out.admitted).toBe(true);
    if (out.admitted) await out.grant.release();
    expect(lines[0]).toMatch(/^waiting: memory pressure 40 /);
    expect(lines.at(-1)).toMatch(/^memory pressure fell after waiting/);
  });

  it('external pressure with zero CLEO usage: the refusal, the wait and the status name the cause (T13914)', async () => {
    const agy = { pid: 4242, command: 'agy', footprintBytes: 17 * GIB };
    const node = { pid: 77, command: 'node', footprintBytes: 2 * GIB };
    const topMemory = vi.fn(() => [agy, node]);
    const pressed = { ...base, sample: async () => sampleAt(40), topMemory };
    const refused = await admit(
      { label: 'tool:test', footprintBytes: GIB },
      {
        ...pressed,
        dir,
        wait: false,
      },
    );
    expect(refused.admitted).toBe(false);
    if (!refused.admitted) {
      expect(refused.refusal.holders).toEqual([]); // no CLEO run holds anything
      expect(refused.refusal.reason).toContain(
        'largest memory users: agy pid 4242 17.0 GiB, node pid 77 2.0 GiB (quit or restart them',
      );
      expect(refused.refusal.memoryPressure?.topConsumers?.processes).toEqual([agy, node]);
    }
    // `cleo doctor tool-locks` reads the same cause from the ledger.
    const budget = readLedgerBudget(dir, capacityBytes);
    expect(budget.lightShare).toBe('none');
    expect(budget.cause).toMatch(/^memory pressure 40 \(refused above 25.*agy pid 4242 17\.0 GiB/);
    // A long waiter names the cause and when it gives up, not just "Holders: none".
    let t = Date.now();
    const notices: string[] = [];
    const out = await admit(
      { label: 'tool:build', footprintBytes: GIB },
      {
        ...pressed,
        dir,
        wait: true,
        timeoutMs: 90_000,
        now: () => t,
        sleep: async (ms) => {
          t += Math.max(ms, 1_000);
        },
        notice: (l) => notices.push(l),
      },
    );
    expect(out.admitted).toBe(false);
    expect(notices[0]).toMatch(/Holders: none\. The budget is closed by memory pressure 40 /);
    expect(notices[0]).toContain('agy pid 4242 17.0 GiB');
    expect(notices[0]).toMatch(/this wait gives up in \d+s\.$/);
    // One probe per 30 s window while the gate keeps refusing (90 s of waiting), not one per pass.
    expect(topMemory.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('the memory users named leave out the runs CLEO holds (T13965)', async () => {
    const holder = await admit(
      { label: 'tool:test', footprintBytes: GIB },
      {
        ...base,
        dir,
        wait: false,
        pid: 4_100_001,
        facts: { ancestorsOf: () => [], groupOf: () => null, startedAt: () => null },
      },
    );
    expect(holder.admitted).toBe(true);
    const topMemory = vi.fn(() => [
      { pid: 4_100_001, command: 'node', footprintBytes: 20 * GIB }, // CLEO's own run
      { pid: 4242, command: 'agy', footprintBytes: 17 * GIB },
    ]);
    const refused = await admit(
      { label: 'tool:test', footprintBytes: GIB },
      { ...base, dir, wait: false, sample: async () => sampleAt(40), topMemory },
    );
    expect(refused.admitted).toBe(false);
    if (!refused.admitted) {
      expect(refused.refusal.reason).toContain('largest memory users: agy pid 4242 17.0 GiB (');
      expect(refused.refusal.reason).not.toContain('pid 4100001');
    }
    if (holder.admitted) await holder.grant.release();
  });

  it('a failed probe reads UNKNOWN, is retried after a backoff; reap never probes', async () => {
    const failing = vi.fn((): null => null);
    let t = Date.now();
    const pressed = {
      ...base,
      sample: async () => sampleAt(40),
      topMemory: failing,
      now: () => t,
    };
    const first = await admit(
      { label: 'tool:test', footprintBytes: GIB },
      {
        ...pressed,
        dir,
        wait: false,
      },
    );
    expect(first.admitted).toBe(false);
    if (!first.admitted) expect(first.refusal.reason).toContain('largest memory users: UNKNOWN');
    await admit({ label: 'tool:test', footprintBytes: GIB }, { ...pressed, dir, wait: false });
    expect(failing).toHaveBeenCalledTimes(1); // a failure is reused, not re-run every pass
    t += TOP_MEMORY_FAILED_REUSE_MS;
    await admit({ label: 'tool:test', footprintBytes: GIB }, { ...pressed, dir, wait: false });
    expect(failing).toHaveBeenCalledTimes(2); // ...but only for the shorter failure window
    // Reaping a dead holder under the same pressure never runs the probe.
    const spy = vi.fn(() => []);
    writeFileSync(
      join(dir, 'ledger.json'),
      JSON.stringify({
        version: 1,
        entries: [entry({ id: 'dead', pid: 999_999, state: 'admitted', admittedAtMs: 0 })],
      }),
    );
    const reaped = await reapLedger({
      dir,
      capacityBytes,
      sample: async () => sampleAt(40),
      topMemory: spy,
      probe: { liveness: () => 'gone', startedAt: () => null, groupLiveness: () => 'gone' },
    });
    expect(reaped).toEqual(['dead']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a run nested in an admitted run rides it: no new entry, no wait', async () => {
    const outer = await admit(
      { label: 'run:test-run', footprintBytes: 10 * GIB },
      { ...base, dir, wait: false },
    );
    if (!outer.admitted) throw new Error('expected an admission');
    const holderPid = process.pid;
    const nested = await admit(
      { label: 'tool:test', footprintBytes: 10 * GIB },
      {
        ...base,
        dir,
        wait: false,
        pid: 99_999,
        env: { [ADMISSION_ENV]: outer.grant.token },
        facts: {
          ancestorsOf: () => [holderPid],
          groupOf: () => null,
          startedAt: (pid) => readLedger(dir).find((e) => e.pid === pid)?.startedAt ?? null,
        },
      },
    );
    expect(nested.admitted).toBe(true);
    if (nested.admitted) {
      expect(nested.grant.nested).toBe(true);
      expect(nested.grant.token).toBe(outer.grant.token);
    }
    expect(readLedger(dir)).toHaveLength(1);
    await outer.grant.release();
  });

  it('under a light parent, a nested heavy run queues for its own footprint (T13452)', async () => {
    const nestedIn = async (outerBytes: number, innerBytes: number) => {
      const outer = await admit(
        { label: 'run:scoped-build', footprintBytes: outerBytes },
        { ...base, dir, wait: false },
      );
      if (!outer.admitted) throw new Error('expected an admission');
      const holderPid = process.pid;
      const nested = await admit(
        { label: 'run:full-build', footprintBytes: innerBytes },
        {
          ...base,
          dir,
          wait: false,
          pid: 99_999,
          env: { [ADMISSION_ENV]: outer.grant.token },
          facts: {
            ancestorsOf: () => [holderPid],
            groupOf: () => null,
            startedAt: (pid) => readLedger(dir).find((e) => e.pid === pid)?.startedAt ?? null,
          },
        },
      );
      const ledger = readLedger(dir).map((e) => e.footprintBytes);
      if (nested.admitted) await nested.grant.release();
      await outer.grant.release();
      return { nested, ledger };
    };
    // A 1 GiB grant does not carry an 8 GiB run: it gets its own entry.
    const own = await nestedIn(GIB, 8 * GIB);
    expect(own.nested.admitted && own.nested.grant.nested).toBe(false);
    expect(own.ledger).toEqual([GIB, 8 * GIB]);
    // A capacity-sized run never waits on its own parent.
    const whole = await nestedIn(GIB, 20 * GIB);
    expect(whole.nested.admitted).toBe(true);
    expect(whole.ledger).toEqual([GIB, 20 * GIB]);
    // A heavy parent's grant still carries a bigger nested run.
    const heavy = await nestedIn(8 * GIB, 9 * GIB);
    expect(heavy.nested.admitted && heavy.nested.grant.nested).toBe(true);
    expect(heavy.ledger).toEqual([8 * GIB]);
  });

  it('a holder that died without releasing is reaped, and its share freed', async () => {
    const gone: PidProbe = {
      liveness: (pid) => (pid === 4_000_001 ? 'gone' : 'alive'),
      startedAt: () => null,
      groupLiveness: () => 'gone',
    };
    // Plant a dead holder by admitting as a fake pid.
    const dead = await admit(
      { label: 'tool:test', footprintBytes: 10 * GIB },
      {
        ...base,
        dir,
        wait: false,
        pid: 4_000_001,
        facts: { ancestorsOf: () => [], groupOf: () => null, startedAt: () => null },
      },
    );
    expect(dead.admitted).toBe(true);
    const next = await admit(
      { label: 'tool:test', footprintBytes: 10 * GIB },
      { ...base, dir, wait: false, probe: gone },
    );
    expect(next.admitted).toBe(true);
    expect(readLedger(dir).map((e) => e.pid)).toEqual([process.pid]);
    if (next.admitted) await next.grant.release();
    expect(await reapLedger({ dir, probe: gone, capacityBytes, sample: calm })).toEqual([]);
  });

  describe('a dead holder is released once nothing it started runs (T14066, T13046)', () => {
    const plant = {
      pid: 4_000_001,
      facts: { ancestorsOf: () => [], groupOf: () => null, startedAt: () => null },
    };
    beforeEach(() => _resetToolGroupsForTest());
    afterEach(() => _resetToolGroupsForTest());

    it('a finished tool group leaves the record, so a reused group id never keeps the holder', async () => {
      const held = await admit(
        { label: 'tool:test', footprintBytes: 10 * GIB },
        { ...base, dir, wait: false, ...plant },
      );
      expect(held.admitted).toBe(true);
      const untrack = trackToolGroup(4_000_777);
      await vi.waitFor(() => expect(readLedger(dir)[0]?.toolGroups).toEqual([4_000_777]));
      untrack();
      await vi.waitFor(() => expect(readLedger(dir)[0]?.toolGroups).toEqual([]));
      // The holder dies; another process group takes the finished group's id.
      const reused: PidProbe = {
        liveness: (pid) => (pid === 4_000_001 ? 'gone' : 'alive'),
        startedAt: () => null,
        groupLiveness: () => 'alive',
      };
      const next = await admit(
        { label: 'tool:test', footprintBytes: 10 * GIB },
        { ...base, dir, wait: false, probe: reused },
      );
      expect(next.admitted).toBe(true);
      expect(readLedger(dir).map((e) => e.pid)).toEqual([process.pid]);
      if (next.admitted) await next.grant.release();
      if (held.admitted) await held.grant.release();
    });

    it('a live child of a dead runner keeps the charge: tool:test cannot admit beside it', async () => {
      const held = await admit(
        { label: 'run:test-run', footprintBytes: 10 * GIB },
        { ...base, dir, wait: false, ...plant },
      );
      if (!held.admitted) throw new Error('expected the planted holder to be admitted');
      held.grant.recordChild?.({ pid: 4_000_002, startedAt: 'child-start' });
      await vi.waitFor(() =>
        expect(readLedger(dir)[0]?.child).toEqual({ pid: 4_000_002, startedAt: 'child-start' }),
      );
      let childAlive = true;
      const probe: PidProbe = {
        liveness: (pid) =>
          pid === process.pid || (pid === 4_000_002 && childAlive) ? 'alive' : 'gone',
        startedAt: (pid) => (pid === 4_000_002 ? 'child-start' : null),
        groupLiveness: () => 'gone',
      };
      const beside = await admit(
        { label: 'tool:test', footprintBytes: 10 * GIB },
        { ...base, dir, wait: false, probe },
      );
      expect(beside.admitted).toBe(false);
      if (!beside.admitted) {
        expect(beside.refusal.holders[0]).toMatch(
          /^run:test-run pid 4000001 .*child 4000002, alive \(child-alive:4000002\)$/,
        );
      }
      childAlive = false;
      const after = await admit(
        { label: 'tool:test', footprintBytes: 10 * GIB },
        { ...base, dir, wait: false, probe },
      );
      expect(after.admitted).toBe(true);
      if (after.admitted) await after.grant.release();
      await held.grant.release();
    });

    it('every pass calls onPass before probing the holders; a throw is ignored', async () => {
      const onPass = vi.fn(() => {
        throw new Error('ps failed');
      });
      const out = await admit(
        { label: 'tool:test', footprintBytes: GIB },
        { ...base, dir, wait: false, onPass },
      );
      expect(out.admitted).toBe(true);
      expect(onPass).toHaveBeenCalledTimes(1);
      if (out.admitted) await out.grant.release();
    });
  });

  it('CLEO_ADMISSION_PRESSURE=off ignores host pressure; an explicit sampler still counts', async () => {
    const line = { avg10: 40, avg60: 40, avg300: 40, totalUs: 0 };
    const spy = vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue({
      ...sampleAt(0),
      globalPressure: { some: line, full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 } },
    });
    const saved = process.env[ADMISSION_PRESSURE_ENV];
    try {
      const { sample: _ignored, ...noSampler } = base;
      process.env[ADMISSION_PRESSURE_ENV] = 'off';
      const off = await admit(
        { label: 'tool:test', footprintBytes: GIB },
        { ...noSampler, dir, wait: false },
      );
      expect(off.admitted).toBe(true);
      if (off.admitted) await off.grant.release();
      delete process.env[ADMISSION_PRESSURE_ENV];
      _resetMemoryGateForTest();
      const on = await admit(
        { label: 'tool:test', footprintBytes: GIB },
        { ...noSampler, dir, wait: false },
      );
      expect(on.admitted).toBe(false);
      _resetMemoryGateForTest();
      process.env[ADMISSION_PRESSURE_ENV] = 'off';
      const explicit = await admit(
        { label: 'tool:test', footprintBytes: GIB },
        { ...noSampler, dir, wait: false, sample: async () => sampleAt(40) },
      );
      expect(explicit.admitted).toBe(false);
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env[ADMISSION_PRESSURE_ENV];
      else process.env[ADMISSION_PRESSURE_ENV] = saved;
    }
  });

  it('CLEO_RESOURCES_MODE=off admits everything without touching the ledger', async () => {
    process.env.CLEO_RESOURCES_MODE = 'off';
    const out = await admit(
      { label: 'tool:test', footprintBytes: 99 * GIB },
      { ...base, dir, wait: false },
    );
    expect(out.admitted).toBe(true);
    expect(readLedger(dir)).toEqual([]);
  });

  const unstageable = process.getuid?.() === 0 || process.platform === 'win32';
  it.skipIf(unstageable)(
    'an unwritable ledger fails open: ungoverned, never a deferral that never clears',
    async () => {
      chmodSync(dir, 0o500);
      const out = await admit(
        { label: 'tool:test', footprintBytes: GIB },
        { ...base, dir: join(dir, 'sub'), wait: true },
      );
      expect(out.admitted).toBe(true);
      if (out.admitted) expect(out.grant.ungoverned?.code).toMatch(/^(EACCES|EPERM)$/);
    },
  );

  it.skipIf(unstageable)(
    'a read-only ledger dir that exists fails open at once, without waiting out lock retries',
    async () => {
      chmodSync(dir, 0o500);
      const t0 = Date.now();
      const out = await admit(
        { label: 'tool:test', footprintBytes: GIB },
        { ...base, dir, wait: true },
      );
      expect(out.admitted).toBe(true);
      if (out.admitted) expect(out.grant.ungoverned?.code).toMatch(/^(EACCES|EPERM)$/);
      expect(Date.now() - t0).toBeLessThan(2_000);
    },
  );

  it('a long waiter names the holders after a minute', async () => {
    const a = await admit(
      { label: 'tool:test', footprintBytes: 10 * GIB },
      { ...base, dir, wait: false },
    );
    if (!a.admitted) throw new Error('expected an admission');
    let t = Date.now();
    const notices: string[] = [];
    const out = await admit(
      { label: 'tool:build', footprintBytes: 10 * GIB },
      {
        ...base,
        dir,
        wait: true,
        timeoutMs: 90_000,
        now: () => t,
        sleep: async (ms) => {
          t += Math.max(ms, 1_000);
        },
        notice: (l) => notices.push(l),
      },
    );
    expect(out.admitted).toBe(false);
    expect(notices[0]).toMatch(
      /^still waiting after 1m 0\ds for the machine budget \(10 GiB of 10 GiB in use, queue position 1, 0 waiting ahead\)\. Holders: tool:test pid/,
    );
    await a.grant.release();
  });

  it('a long urgent waiter reports its queue position (T13921)', async () => {
    const a = await admit(
      { label: 'tool:test', footprintBytes: 10 * GIB },
      { ...base, dir, wait: false },
    );
    if (!a.admitted) throw new Error('expected an admission');
    let t = Date.now();
    const notices: string[] = [];
    const out = await admit(
      { label: 'run:scoped-build', footprintBytes: 10 * GIB, urgent: true },
      {
        ...base,
        dir,
        wait: true,
        timeoutMs: 70_000,
        now: () => t,
        sleep: async (ms) => {
          t += Math.max(ms, 1_000);
        },
        notice: (l) => notices.push(l),
      },
    );
    expect(out.admitted).toBe(false);
    expect(notices[0]).toContain('queue position 1 (urgent), 0 waiting ahead). Holders: tool:test');
    await a.grant.release();
  });

  it('a queued run calls keepAlive on entering the wait and every interval after, ignoring failures (T13492)', async () => {
    const a = await admit(
      { label: 'tool:test', footprintBytes: 10 * GIB },
      { ...base, dir, wait: false },
    );
    if (!a.admitted) throw new Error('expected an admission');
    let t = Date.now();
    const t0 = t;
    const calls: number[] = [];
    const out = await admit(
      { label: 'tool:build', footprintBytes: 10 * GIB },
      {
        ...base,
        dir,
        wait: true,
        timeoutMs: 12 * 60_000,
        now: () => t,
        sleep: async (ms) => {
          t += Math.max(ms, 1_000);
        },
        keepAlive: async () => {
          calls.push(t - t0);
          throw new Error('store busy');
        },
      },
    );
    expect(out.admitted).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe(0);
    expect(calls[1]).toBeGreaterThanOrEqual(5 * 60_000);
    expect(calls[2]).toBeGreaterThanOrEqual(10 * 60_000);
    await a.grant.release();
  });

  const ledgerPath = (): string => join(dir, 'ledger.json');

  it('entries of an unknown format are kept verbatim and charged until provably gone (MED-2)', async () => {
    const now = Date.now();
    const sized = { id: 'future-1', state: 'paused', footprintBytes: 6 * GIB, heartbeatAtMs: now };
    const unsized = { id: 'future-2', phase: 'x', heartbeatAtMs: now };
    writeFileSync(ledgerPath(), JSON.stringify({ version: 1, entries: [sized] }));
    const refused = await admit(
      { label: 'tool:test', footprintBytes: 5 * GIB },
      { ...base, dir, wait: false },
    );
    expect(refused.admitted).toBe(false);
    if (!refused.admitted) {
      expect(refused.refusal.reason).toMatch(/6(\.0)? GiB of 10(\.0)? GiB by 1 run\(s\)/);
      expect(refused.refusal.holders).toContain('1 entry of another CLEO version');
    }
    const fits = await admit(
      { label: 'tool:test', footprintBytes: 4 * GIB },
      { ...base, dir, wait: false },
    );
    expect(fits.admitted).toBe(true);
    if (fits.admitted) await fits.grant.release();
    expect(readForeignEntries(dir)).toEqual([sized]);

    // No footprint: charged the whole capacity, so nothing else starts.
    writeFileSync(ledgerPath(), JSON.stringify({ version: 1, entries: [unsized] }));
    const blocked = await admit(
      { label: 'tool:test', footprintBytes: GIB },
      { ...base, dir, wait: false },
    );
    expect(blocked.admitted).toBe(false);
    expect(readForeignEntries(dir)).toEqual([unsized]);

    // Past the orphan bound it is reaped like any holder.
    const old = { ...unsized, heartbeatAtMs: now - LEDGER_ORPHAN_MS };
    writeFileSync(ledgerPath(), JSON.stringify({ version: 1, entries: [old] }));
    expect(await reapLedger({ dir, capacityBytes, sample: calm })).toEqual(['future-2']);
    expect(readForeignEntries(dir)).toEqual([]);
  });

  it('a ledger written by a newer CLEO is never rewritten: admission runs ungoverned and says why (MED-2)', async () => {
    const newer = JSON.stringify({ version: 2, entries: [{ id: 'x', slots: 3 }] });
    writeFileSync(ledgerPath(), newer);
    const out = await admit(
      { label: 'tool:test', footprintBytes: GIB },
      { ...base, dir, wait: true },
    );
    expect(out.admitted).toBe(true);
    if (!out.admitted || out.grant.ungoverned === null) throw new Error('expected ungoverned');
    expect(out.grant.ungoverned.code).toBe('E_LEDGER_VERSION');
    expect(describeAdmissionIoError(out.grant.ungoverned)).toContain('written by a newer CLEO');
    expect(readFileSync(ledgerPath(), 'utf-8')).toBe(newer);
  });

  it('a corrupt ledger is moved aside, not silently destroyed', async () => {
    writeFileSync(ledgerPath(), '{"version":1,"entries":[');
    const out = await admit(
      { label: 'tool:test', footprintBytes: GIB },
      { ...base, dir, wait: false },
    );
    expect(out.admitted).toBe(true);
    if (out.admitted) await out.grant.release();
    expect(readdirSync(dir).some((f) => f.startsWith('ledger.json.corrupt-'))).toBe(true);
  });

  it('a failed release never throws and keeps retrying in the background (LOW-5)', async () => {
    const out = await admit(
      { label: 'tool:test', footprintBytes: GIB },
      { ...base, dir, wait: false },
    );
    if (!out.admitted) throw new Error('expected an admission');
    // Not contention (which the lock loop retries) and not unwritable state:
    // a failure release cannot clean up now.
    const spy = vi.spyOn(lockfile, 'lock').mockRejectedValueOnce(new Error('lock failed'));
    try {
      await expect(out.grant.release()).resolves.toBeUndefined();
      expect(readLedger(dir)).toHaveLength(1);
      await vi.waitFor(() => expect(readLedger(dir)).toEqual([]), { timeout: 5_000, interval: 50 });
    } finally {
      spy.mockRestore();
    }
  });

  it('waiters reuse a pressure verdict under 2 s old instead of sampling again (LOW-6)', async () => {
    const spy = vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(sampleAt(0));
    const saved = process.env[ADMISSION_PRESSURE_ENV];
    delete process.env[ADMISSION_PRESSURE_ENV];
    try {
      const { sample: _ignored, ...live } = base;
      let t = 1_000_000;
      const opts = { ...live, dir, wait: false, now: () => t };
      const a = await admit({ label: 'tool:a', footprintBytes: GIB }, opts);
      const b = await admit({ label: 'tool:b', footprintBytes: GIB }, opts);
      expect(a.admitted && b.admitted).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      t += 2_500;
      const c = await admit({ label: 'tool:c', footprintBytes: GIB }, opts);
      expect(spy).toHaveBeenCalledTimes(2);
      for (const g of [a, b, c]) if (g.admitted) await g.grant.release();
      // An explicit sampler is always asked.
      const d = await admit(
        { label: 'tool:d', footprintBytes: GIB },
        { ...base, dir, wait: false, now: () => t },
      );
      expect(d.admitted).toBe(true);
      if (d.admitted) await d.grant.release();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env[ADMISSION_PRESSURE_ENV];
      else process.env[ADMISSION_PRESSURE_ENV] = saved;
    }
  });

  it('a waiter skips its own passes while another process keeps the pressure verdict fresh (LOW-6)', async () => {
    const holder = await admit(
      { label: 'tool:test', footprintBytes: 10 * GIB },
      { ...base, dir, wait: false },
    );
    if (!holder.admitted) throw new Error('expected an admission');
    const sampled = vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(sampleAt(0));
    const locks = vi.spyOn(lockfile, 'lock');
    const saved = process.env[ADMISSION_PRESSURE_ENV];
    delete process.env[ADMISSION_PRESSURE_ENV];
    try {
      const { sample: _ignored, ...live } = base;
      let t = Date.now();
      // Another process samples and writes a verdict between every poll.
      const freshen = (): void => {
        const doc = JSON.parse(readFileSync(ledgerPath(), 'utf-8')) as Record<string, unknown>;
        doc.pressure = { share: 'full', reading: null, sampledAtMs: t };
        writeFileSync(ledgerPath(), JSON.stringify(doc));
      };
      freshen();
      const out = await admit(
        { label: 'tool:build', footprintBytes: GIB },
        {
          ...live,
          dir,
          wait: true,
          timeoutMs: 10_000,
          pollMs: 250,
          now: () => t,
          sleep: async (ms) => {
            t += ms;
            freshen();
          },
        },
      );
      expect(out.admitted).toBe(false);
      expect(sampled).not.toHaveBeenCalled();
      // The first pass and the leave at the timeout; no pass every 2 s.
      expect(locks).toHaveBeenCalledTimes(2);
    } finally {
      sampled.mockRestore();
      locks.mockRestore();
      if (saved === undefined) delete process.env[ADMISSION_PRESSURE_ENV];
      else process.env[ADMISSION_PRESSURE_ENV] = saved;
      await holder.grant.release();
    }
  });

  it('removeLedgerEntry drops a named entry whatever its liveness (doctor --remove)', async () => {
    const held = await admit(
      { label: 'tool:test', footprintBytes: 10 * GIB },
      { ...base, dir, wait: false, pid: 4_000_002 },
    );
    if (!held.admitted || held.grant.id === null) throw new Error('expected an admission');
    expect(await removeLedgerEntry('no-such-id', { dir, capacityBytes, sample: calm })).toBe(false);
    expect(await removeLedgerEntry(held.grant.id, { dir, capacityBytes, sample: calm })).toBe(true);
    expect(readLedger(dir)).toEqual([]);
    await held.grant.release();
  });

  describe('T13889 queue deadlines and cleanup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(lockfile, 'lock').mockResolvedValue(async () => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('bounds repeated isolated-budget deferrals at the explicit deadline', async () => {
      const holder = await admit(
        { label: 'holder', footprintBytes: capacityBytes },
        { ...base, dir, wait: true, timeoutMs: 0 },
      );
      if (!holder.admitted) throw new Error('expected isolated holder');
      const onePass = await admit(
        { label: 'one-pass', footprintBytes: capacityBytes },
        { ...base, dir, wait: true, timeoutMs: 0 },
      );
      expect(onePass.admitted).toBe(false);
      const started = Date.now();
      let settled = false;
      const waiting = admit(
        { label: 'waiting', footprintBytes: capacityBytes },
        { ...base, dir, wait: true, timeoutMs: 1001, pollMs: 400 },
      ).then((out) => {
        settled = true;
        return out;
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(false);
      expect(
        readLedger(dir)
          .map((e) => e.state)
          .sort(),
      ).toEqual(['admitted', 'waiting']);
      await vi.advanceTimersByTimeAsync(1);
      expect((await waiting).admitted).toBe(false);
      expect(Date.now() - started).toBe(1001);
      await vi.advanceTimersByTimeAsync(0);
      expect(readLedger(dir).map((e) => e.label)).toEqual(['holder']);
      await holder.grant.release();
    });

    it('bounds a stalled scheduling sample and never enqueues on its late completion', async () => {
      let resolveSample: (sample: ResourceSample) => void = () => {};
      const pending = new Promise<ResourceSample>((resolve) => {
        resolveSample = resolve;
      });
      const intervals = vi.spyOn(globalThis, 'setInterval');
      const waiting = admit(
        { label: 'late-sample', footprintBytes: GIB },
        { ...base, dir, wait: true, timeoutMs: 1001, sample: () => pending },
      );
      await vi.advanceTimersByTimeAsync(1001);
      expect((await waiting).admitted).toBe(false);
      resolveSample(sampleAt(0));
      await vi.advanceTimersByTimeAsync(0);
      expect(readLedger(dir)).toEqual([]);
      expect(lockfile.lock).not.toHaveBeenCalled();
      expect(intervals).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      'deadline',
      'signal',
    ] as const)('bounds a pending lock on %s and unlocks a late acquisition exactly once', async (stop) => {
      let resolveLock: (unlock: Awaited<ReturnType<typeof lockfile.lock>>) => void = () => {};
      const pending = new Promise<Awaited<ReturnType<typeof lockfile.lock>>>((resolve) => {
        resolveLock = resolve;
      });
      vi.mocked(lockfile.lock).mockReturnValueOnce(pending);
      const unlock = vi.fn(async () => {});
      const intervals = vi.spyOn(globalThis, 'setInterval');
      const signal = new AbortController();
      const waiting = admit(
        { label: 'late-lock', footprintBytes: GIB },
        { ...base, dir, wait: true, timeoutMs: 1001, signal: signal.signal },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(lockfile.lock).toHaveBeenCalledTimes(1);
      if (stop === 'signal') signal.abort();
      else await vi.advanceTimersByTimeAsync(1001);
      expect((await waiting).admitted).toBe(false);
      resolveLock(unlock);
      await vi.advanceTimersByTimeAsync(0);
      expect(unlock).toHaveBeenCalledTimes(1);
      expect(readLedger(dir)).toEqual([]);
      expect(intervals).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects a peer admission observed after expiry without starting a heartbeat', async () => {
      const holder = await admit(
        { label: 'holder', footprintBytes: capacityBytes },
        { ...base, dir, wait: false },
      );
      if (!holder.admitted) throw new Error('expected isolated holder');
      const intervals = vi.spyOn(globalThis, 'setInterval');
      const waiting = await admit(
        { label: 'late-peer', footprintBytes: capacityBytes },
        {
          ...base,
          dir,
          wait: true,
          timeoutMs: 1001,
          sleep: async () => {
            vi.setSystemTime(Date.now() + 1001);
            const entries = readLedger(dir).map((e) =>
              e.label === 'late-peer' ? { ...e, state: 'admitted', admittedAtMs: Date.now() } : e,
            );
            writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ version: 1, entries }));
          },
        },
      );
      expect(waiting.admitted).toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(readLedger(dir).map((e) => e.label)).toEqual(['holder']);
      expect(intervals).not.toHaveBeenCalled();
      await holder.grant.release();
    });

    it.each([
      {
        name: 'expired positive budget',
        wait: true,
        timeoutMs: 1001,
        elapsedMs: 1001,
        admitted: false,
      },
      {
        name: 'unexpired positive budget',
        wait: true,
        timeoutMs: 1001,
        elapsedMs: 1000,
        admitted: true,
      },
      { name: 'zero-budget one-pass', wait: true, timeoutMs: 0, elapsedMs: 1001, admitted: true },
      {
        name: 'non-waiting request',
        wait: false,
        timeoutMs: 1001,
        elapsedMs: 1001,
        admitted: true,
      },
    ])('checks the clock before failing open after I/O: $name', async (test) => {
      vi.mocked(lockfile.lock).mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + test.elapsedMs);
        throw Object.assign(new Error('ledger unavailable'), { code: 'EACCES' });
      });
      const intervals = vi.spyOn(globalThis, 'setInterval');
      const out = await admit(
        { label: 'failed-lock', footprintBytes: GIB },
        { ...base, dir, wait: test.wait, timeoutMs: test.timeoutMs },
      );
      expect(out.admitted).toBe(test.admitted);
      if (out.admitted) {
        expect(out.grant.ungoverned?.code).toBe('EACCES');
        await out.grant.release();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(readLedger(dir)).toEqual([]);
      expect(intervals).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      { phase: 'unlocked', failure: 'EACCES' },
      { phase: 'locked', failure: 'EPERM' },
      { phase: 'unlocked', failure: 'malformed JSON' },
      { phase: 'locked', failure: 'malformed entry list' },
    ] as const)('retries $phase cleanup reads after $failure without replacing the ledger', async (test) => {
      const holder = await admit(
        { label: 'holder', footprintBytes: capacityBytes },
        { ...base, dir, wait: false },
      );
      if (!holder.admitted) throw new Error('expected isolated holder');
      const intervals = vi.spyOn(globalThis, 'setInterval');
      const waiting = admit(
        { label: 'unreadable-cleanup', footprintBytes: capacityBytes },
        { ...base, dir, wait: true, timeoutMs: 1001, pollMs: 400 },
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(readLedger(dir).map((e) => e.label)).toEqual(['holder', 'unreadable-cleanup']);
      const file = join(dir, 'ledger.json');
      const { readFileSync: originalRead } =
        await vi.importActual<typeof import('node:fs')>('node:fs');
      const before = originalRead(file, 'utf-8');
      let unavailable = true;
      let reads = 0;
      vi.spyOn(fileSystem, 'readFileSync').mockImplementation((path, options) => {
        if (String(path) === file) {
          reads++;
          if (unavailable && (test.phase === 'unlocked' || reads > 1)) {
            if (test.failure === 'malformed JSON') return '{';
            if (test.failure === 'malformed entry list') return '{"version":1,"entries":null}';
            throw Object.assign(new Error('ledger is unreadable'), { code: test.failure });
          }
        }
        return originalRead(path, options);
      });
      await vi.advanceTimersByTimeAsync(1);
      expect((await waiting).admitted).toBe(false);
      expect(reads).toBeGreaterThanOrEqual(test.phase === 'unlocked' ? 1 : 2);
      expect(originalRead(file, 'utf-8')).toBe(before);
      expect(intervals).not.toHaveBeenCalled();
      unavailable = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(readLedger(dir).map((e) => e.label)).toEqual(['holder']);
      await holder.grant.release();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('returns while cleanup storage is unavailable and retries removal after recovery', async () => {
      const holder = await admit(
        { label: 'holder', footprintBytes: capacityBytes },
        { ...base, dir, wait: false },
      );
      if (!holder.admitted) throw new Error('expected isolated holder');
      const intervals = vi.spyOn(globalThis, 'setInterval');
      const waiting = admit(
        { label: 'cleanup', footprintBytes: capacityBytes },
        { ...base, dir, wait: true, timeoutMs: 1001, pollMs: 400 },
      );
      await vi.advanceTimersByTimeAsync(0);
      vi.mocked(lockfile.lock).mockRejectedValueOnce(
        Object.assign(new Error('storage unavailable'), { code: 'EACCES' }),
      );
      await vi.advanceTimersByTimeAsync(1001);
      expect((await waiting).admitted).toBe(false);
      expect(
        readLedger(dir)
          .map((e) => e.label)
          .sort(),
      ).toEqual(['cleanup', 'holder']);
      await vi.advanceTimersByTimeAsync(1000);
      expect(readLedger(dir).map((e) => e.label)).toEqual(['holder']);
      expect(intervals).not.toHaveBeenCalled();
      await holder.grant.release();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('20 concurrent admitters: no lost update, no deadlock, never over budget', async () => {
    const cap = 3 * GIB;
    let running = 0;
    let peak = 0;
    let done = 0;
    const one = async (i: number): Promise<void> => {
      const out = await admit(
        { label: `tool:t${i}`, footprintBytes: GIB },
        {
          capacityBytes: cap,
          sample: calm,
          env: {},
          dir,
          wait: true,
          timeoutMs: 60_000,
          pollMs: 5,
        },
      );
      if (!out.admitted) throw new Error(`admitter ${i} refused: ${out.refusal.reason}`);
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10 + (i % 4) * 5));
      running--;
      await out.grant.release();
      done++;
    };
    await Promise.all(Array.from({ length: 20 }, (_, i) => one(i)));
    expect(done).toBe(20);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(readLedger(dir)).toEqual([]);
  }, 60_000);
});

describe('cleo run is charged by its real scope (T13367)', () => {
  const RAM = 48;

  it('a test run in a serial vitest project plans one worker (T14033)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleo-serial-vitest-'));
    try {
      writeFileSync(join(dir, 'vitest.config.ts'), 'test: { fileParallelism: false }');
      const argv = ['pnpm', 'exec', 'vitest', 'run'];
      const serial = planRunFootprint('test-run', argv, {}, RAM, undefined, undefined, dir);
      expect(serial.resources?.workers).toBe(1);
      expect(serial.overlay.VITEST_MAX_WORKERS).toBe('1');
      // A project with no limit keeps the CLEO plan.
      rmSync(join(dir, 'vitest.config.ts'));
      const open = planRunFootprint('test-run', argv, {}, RAM, undefined, undefined, dir);
      expect(open.resources?.workers).toBeGreaterThan(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the plan lists the project settings its overlay overrides, for the run envelope (T14038)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleo-project-overrides-'));
    try {
      writeFileSync(join(dir, '.npmrc'), 'workspace-concurrency=6\n');
      const plan = planRunFootprint(
        'test-run',
        ['pnpm', 'test'],
        {},
        RAM,
        undefined,
        undefined,
        dir,
      );
      expect(plan.resources?.projectOverrides).toEqual([
        {
          setting: 'pnpm workspace-concurrency',
          file: '.npmrc',
          projectValue: '6',
          variable: 'npm_config_workspace_concurrency',
          appliedValue: plan.overlay.npm_config_workspace_concurrency,
        },
      ]);
      rmSync(join(dir, '.npmrc'));
      const none = planRunFootprint(
        'test-run',
        ['pnpm', 'test'],
        {},
        RAM,
        undefined,
        undefined,
        dir,
      );
      expect(none.resources).not.toHaveProperty('projectOverrides');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a two-file biome check is charged 1 GiB, not the 24 GiB heavy plan', () => {
    const plan = planRunFootprint(
      'scoped-build',
      ['pnpm', 'biome', 'check', 'a.ts', 'b.ts'],
      {},
      RAM,
    );
    expect(plan.footprintBytes).toBe(GIB);
    expect(plan.resources).toBeNull();
    expect(plan.footprintReason).toBe('biome check on 2 named paths');
  });

  it('a root pnpm run build keeps the full-build heavy plan', () => {
    const plan = planRunFootprint('full-build', ['pnpm', 'run', 'build'], {}, RAM);
    expect(plan.footprintBytes).toBeGreaterThan(HEAVY_FOOTPRINT_BYTES);
    expect(plan.footprintReason).toBe('full-build plan');
  });

  it('an explicit full-build is never shrunk, even for a file-scoped command', () => {
    const plan = planRunFootprint('full-build', ['biome', 'check', 'a.ts'], {}, RAM);
    expect(plan.footprintBytes).toBeGreaterThan(HEAVY_FOOTPRINT_BYTES);
  });

  it('eslint on files and tsc -p on one package are charged one process', () => {
    for (const argv of [
      ['pnpm', 'exec', 'eslint', 'src/a.ts'],
      ['pnpm', 'exec', 'tsc', '--noEmit', '-p', 'packages/core'],
    ]) {
      const plan = planRunFootprint('scoped-build', argv, {}, RAM);
      expect(plan.footprintBytes, argv.join(' ')).toBeLessThanOrEqual(HEAVY_FOOTPRINT_BYTES);
      expect(plan.resources?.workers, argv.join(' ')).toBe(1);
    }
  });

  it('a bare tsc --noEmit under --class build: one heap, no worker slots; two fit where two heavy plans do not (T13440)', () => {
    const single = planRunFootprint('scoped-build', ['pnpm', 'exec', 'tsc', '--noEmit'], {}, RAM);
    const heavy = planRunFootprint('scoped-build', ['pnpm', 'run', 'lint'], {}, RAM);
    expect(single.resources?.workers).toBe(1);
    expect(single.resources?.workspaceConcurrency ?? 1).toBe(1);
    expect(single.footprintBytes).toBeLessThanOrEqual(HEAVY_FOOTPRINT_BYTES);
    expect(single.footprintReason).toBe('tsc without -b (one process)');
    expect(heavy.footprintBytes).toBeGreaterThan(HEAVY_FOOTPRINT_BYTES);
    const capacity = 36 * GIB;
    const two = (bytes: number) =>
      admittedIds(
        schedulePass(
          [
            entry({ id: 'a', enqueuedAtMs: 1, footprintBytes: bytes }),
            entry({ id: 'b', enqueuedAtMs: 2, footprintBytes: bytes }),
            entry({ id: 'p0', enqueuedAtMs: 3, footprintBytes: bytes }),
            entry({ id: 'p1', enqueuedAtMs: 4, footprintBytes: bytes }),
          ],
          { capacityBytes: capacity, share: 'full', nowMs: 1_000 },
        ),
      );
    expect(two(single.footprintBytes ?? 0)).toEqual(['a', 'b', 'p0', 'p1']);
    expect(two(heavy.footprintBytes ?? 0)).not.toContain('p1');
  });

  it('a two-file biome check is admitted while a full build holds the budget', () => {
    const capacity = 36 * GIB;
    const build = planRunFootprint('full-build', ['pnpm', 'run', 'build'], {}, RAM);
    const fmt = planRunFootprint('scoped-build', ['biome', 'check', 'a.ts', 'b.ts'], {}, RAM);
    const out = schedulePass(
      [
        entry({
          id: 'build',
          state: 'admitted',
          footprintBytes: build.footprintBytes ?? 0,
          exclusive: true,
        }),
        // A heavy run queued past its reservation, blocked by bytes (but not
        // charged the whole budget, which never opens the tiny lane).
        entry({
          id: 'test',
          enqueuedAtMs: 0,
          footprintBytes: capacity - (build.footprintBytes ?? 0) + GIB,
        }),
        entry({ id: 'fmt', enqueuedAtMs: 1, footprintBytes: fmt.footprintBytes ?? 0 }),
      ],
      { capacityBytes: capacity, share: 'full', nowMs: LEDGER_RESERVATION_MS + 1 },
    );
    expect(admittedIds(out).sort()).toEqual(['build', 'fmt']);
  });

  it('the reason reaches the ledger status line', () => {
    const line = describeHolders(
      [
        entry({
          id: 'x',
          state: 'admitted',
          admittedAtMs: 0,
          label: 'run:scoped-build',
          footprintReason: 'biome check on 2 named paths',
        }),
      ],
      1_000,
    )[0];
    expect(line).toContain('(biome check on 2 named paths)');
  });
});

/** A hook never measured (T13921): tests must not read this machine's measurements. */
const unmeasured = (): null => null;

describe('a git push is charged by what actually runs (T13452)', () => {
  const RAM = 48;

  it('a measured hook is charged its peak plus the margin, capped at its plan (T13921)', () => {
    const measured = (peakBytes: number) => () => ({ key: 'pre-push:abc', peakBytes });
    const plan = planRunFootprint(
      'scoped-build',
      ['git', 'push'],
      {},
      RAM,
      () => true,
      measured(4 * GIB),
    );
    expect(plan.footprintBytes).toBe(5 * GIB);
    expect(plan.footprintReason).toBe(
      'scoped-build plan: runs the pre-push hook, measured peak 4.0 GiB + 25%',
    );
    expect(plan.hookKey).toBe('pre-push:abc');
    // The heap and worker plan it is spawned with is unchanged.
    expect(plan.resources).not.toBeNull();
    // A peak above the plan is charged the plan; a tiny one at least the light footprint.
    const planned = planRunFootprint(
      'scoped-build',
      ['git', 'push'],
      {},
      RAM,
      () => true,
      unmeasured,
    );
    const big = planRunFootprint(
      'scoped-build',
      ['git', 'push'],
      {},
      RAM,
      () => true,
      measured(64 * GIB),
    );
    expect(big.footprintBytes).toBe(planned.footprintBytes);
    expect(big.footprintReason).toBe('scoped-build plan: runs the pre-push hook');
    const tiny = planRunFootprint(
      'scoped-build',
      ['git', 'push'],
      {},
      RAM,
      () => true,
      measured(1024),
    );
    expect(tiny.footprintBytes).toBe(GIB);
    // Not measured yet: the class plan, and the key to record under.
    const fresh = planRunFootprint(
      'scoped-build',
      ['git', 'push'],
      {},
      RAM,
      () => true,
      () => ({
        key: 'pre-push:abc',
        peakBytes: null,
      }),
    );
    expect(fresh.footprintBytes).toBe(planned.footprintBytes);
    expect(fresh.hookKey).toBe('pre-push:abc');
  });

  it('without a hook: the light footprint, with the reason', () => {
    const plan = planRunFootprint(
      'scoped-build',
      ['git', 'push', '-u', 'origin', 'x'],
      {},
      RAM,
      () => false,
    );
    expect(plan.footprintBytes).toBe(GIB);
    expect(plan.resources).toBeNull();
    expect(plan.footprintReason).toBe('git push runs no heavy tool');
  });

  it('git -C <worktree> push probes the hook with the -C directory (T13458)', () => {
    const calls: Array<[string, readonly string[]]> = [];
    const plan = planRunFootprint(
      'scoped-build',
      ['git', '-C', '/wt', 'push'],
      {},
      RAM,
      (hook, globals) => {
        calls.push([hook, globals]);
        return true;
      },
      unmeasured,
    );
    expect(calls).toEqual([['pre-push', ['-C', '/wt']]]);
    expect(plan.footprintReason).toBe('scoped-build plan: runs the pre-push hook');
  });

  it('with an installed pre-push hook: the class plan, naming the hook', () => {
    const seen: string[] = [];
    const plan = planRunFootprint(
      'scoped-build',
      ['git', 'push'],
      {},
      RAM,
      (hook) => {
        seen.push(hook);
        return true;
      },
      unmeasured,
    );
    expect(seen).toEqual(['pre-push']);
    expect(plan.footprintBytes).toBeGreaterThan(HEAVY_FOOTPRINT_BYTES);
    expect(plan.footprintReason).toBe('scoped-build plan: runs the pre-push hook');
  });

  it('gitHookInstalled reads core.hooksPath and requires an executable file', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cleo-t13452-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      expect(gitHookInstalled(repo, 'pre-push')).toBe(false);
      writeFileSync(join(repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
      expect(gitHookInstalled(repo, 'pre-push')).toBe(false); // not executable
      chmodSync(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
      expect(gitHookInstalled(repo, 'pre-push')).toBe(true);
      // T13458: probed in the -C directory, from anywhere.
      expect(gitHookInstalled(tmpdir(), 'pre-push', ['-C', repo])).toBe(true);
      // An inline -c core.hooksPath on the command is honoured.
      expect(gitHookInstalled(repo, 'pre-push', ['-c', 'core.hooksPath=nowhere'])).toBe(false);
      execFileSync('git', ['config', 'core.hooksPath', 'hooks-elsewhere'], { cwd: repo });
      expect(gitHookInstalled(repo, 'pre-push')).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a command looksHeavy rejects is charged light, naming it; a runner of other commands is not', () => {
    for (const [argv, reason] of [
      [['node', 'scripts/gen.mjs'], 'node scripts/gen.mjs runs no heavy tool'],
      [['git', 'status'], 'git status runs no heavy tool'],
      [['ls', '-la'], 'ls runs no heavy tool'],
      [['timeout', '60', 'sudo', '-u', 'me', 'cat', 'a'], 'cat runs no heavy tool'],
      [['env', 'NODE_OPTIONS=--no-warnings', 'node', 'gen.mjs'], 'node gen.mjs runs no heavy tool'],
    ] as const) {
      const plan = planRunFootprint('scoped-build', argv, {}, RAM, () => true, unmeasured);
      expect(plan.footprintBytes, argv.join(' ')).toBe(GIB);
      expect(plan.resources, argv.join(' ')).toBeNull();
      expect(plan.footprintReason).toBe(reason);
    }
    for (const argv of [
      ['bash', '-c', 'pnpm test'],
      ['make', 'all'],
      ['pnpm', 'run', 'generate'],
      ['cleo', 'verify', 'T1'],
      ['node', 'bin/cleo.js', 'verify', 'T1'],
      // B1 of the #2280 review: anything off the allowlist keeps the plan.
      ['cargo', 'clippy'],
      ['cargo', 'nextest', 'run'],
      ['go', 'vet', './...'],
      ['gradle', 'build'],
      ['mvn', 'verify'],
      ['xcodebuild', 'test'],
      ['docker', 'build', '.'],
      ['npx', 'tsx', 'scripts/x.ts'],
      ['./scripts/test.sh'],
      ['pre-commit', 'run', '--all-files'],
      ['lefthook', 'run', 'pre-commit'],
      ['node', '--test', 'a.test.mjs'],
      ['node', '--max-old-space-size=8192', 'build.mjs'],
      ['timeout', '600', 'cargo', 'check'],
      ['sudo', 'pytest'],
      ['watchexec', 'ls'],
      ['parallel', 'echo', ':::', 'a'],
      ['node', 'node_modules/vitest/vitest.mjs', 'run'],
      ['node', './node_modules/.bin/tsc.js'],
      ['env', 'NODE_OPTIONS=--max-old-space-size=16384', 'node', 'gen.mjs'],
      ['NODE_OPTIONS=--max-semi-space-size=64', 'node', 'gen.mjs'],
      ['NODE_OPTIONS=--max_old_space_size=30000', 'node', 'gen.mjs'],
      ['node', 'node_modules\\vitest\\vitest.mjs', 'run'],
    ]) {
      const plan = planRunFootprint('scoped-build', argv, {}, RAM);
      expect(plan.footprintBytes, argv.join(' ')).toBeGreaterThan(HEAVY_FOOTPRINT_BYTES);
    }
    // An explicit test run, or full-build, of the same command keeps its class plan.
    for (const cls of ['test-run', 'full-build'] as const) {
      const plan = planRunFootprint(cls, ['node', 'scripts/gen.mjs'], {}, RAM);
      expect(plan.footprintBytes, cls).toBeGreaterThan(HEAVY_FOOTPRINT_BYTES);
    }
  });

  it('git commit with an installed pre-commit hook keeps the class plan, naming the hook', () => {
    const plan = planRunFootprint(
      'scoped-build',
      ['git', 'commit', '-m', 'x'],
      {},
      RAM,
      (hook) => hook === 'pre-commit',
      unmeasured,
    );
    expect(plan.resources).not.toBeNull();
    expect(plan.footprintReason).toBe('scoped-build plan: runs the pre-commit hook');
  });
});

describe('a nested run never waits on its own ancestors (T13452)', () => {
  const NOW = 1_000_000;
  const parent = entry({ id: 'parent', state: 'admitted', footprintBytes: GIB, enqueuedAtMs: 1 });
  const others = [1, 2, 3].map((n) =>
    entry({ id: `tiny${n}`, state: 'admitted', footprintBytes: GIB, enqueuedAtMs: 0 }),
  );
  const pass = (ram: number, ledger: LedgerEntry[]) => {
    const capacityBytes = admissionCapacityBytes(ram * GIB);
    const child = entry({
      id: 'child',
      parentId: 'parent',
      footprintBytes:
        planRunFootprint('full-build', ['pnpm', 'run', 'build'], {}, ram).footprintBytes ?? 0,
      enqueuedAtMs: 10,
    });
    // An older capacity-sized head, past its reservation: it waits for an idle machine.
    const head = entry({ id: 'head', footprintBytes: capacityBytes, enqueuedAtMs: 2 });
    return admittedIds(
      schedulePass([...ledger, head, child], {
        capacityBytes,
        share: 'half',
        nowMs: NOW,
      }),
    );
  };

  for (const ram of [8, 16, 64]) {
    it(`${ram} GiB, share half: admitted beside its light parent, past a blocked head`, () => {
      expect(pass(ram, [parent])).toContain('child');
    });
  }

  it('16 and 64 GiB, share half, tiny reserve full: still admitted', () => {
    expect(pass(16, [...others, parent])).toContain('child');
    expect(pass(64, [...others, parent])).toContain('child');
  });

  it('8 GiB, tiny reserve full: waits only for the unrelated runs, then starts', () => {
    expect(pass(8, [...others, parent])).not.toContain('child');
    expect(pass(8, [parent])).toContain('child');
  });

  it('a non-nested run of the same size still waits for the parent', () => {
    const capacityBytes = admissionCapacityBytes(64 * GIB);
    const stranger = entry({ id: 'stranger', footprintBytes: 24 * GIB, enqueuedAtMs: 10 });
    const out = schedulePass([...others, parent, stranger], {
      capacityBytes,
      share: 'half',
      nowMs: NOW,
    });
    expect(admittedIds(out)).not.toContain('stranger');
  });
});

describe('an install is charged one process, not half a heavy run (T13914)', () => {
  it('pnpm install --lockfile-only and pnpm add -D are charged a single-process plan', () => {
    const one = planRunFootprint('scoped-build', ['tsc', '--noEmit'], {}, 64).footprintBytes;
    for (const argv of [
      ['pnpm', 'install', '--lockfile-only'],
      ['pnpm', 'add', '-D', 'left-pad'],
    ]) {
      const plan = planRunFootprint('scoped-build', argv, {}, 64);
      expect(plan.footprintBytes, argv.join(' ')).toBe(one);
      expect(plan.footprintBytes, argv.join(' ')).toBeLessThan(12 * GIB);
      expect(plan.footprintReason).toMatch(/one package-manager process/);
    }
  });
});

describe('a node script that hosts a heavy tool is never charged light (T14050)', () => {
  const RAM = 48;
  const program = ['node', 'scripts/typecheck/full-program.cjs', '--project', 'tsconfig.json'];
  const script =
    (heavyTool: string | null, peakBytes: number | null = null) =>
    (): { key: string; heavyTool: string | null; peakBytes: number | null } => ({
      key: 'full-program.cjs:abc',
      heavyTool,
      peakBytes,
    });
  const plan = (argv: readonly string[], peak: ReturnType<typeof script>) =>
    planRunFootprint('scoped-build', argv, {}, RAM, () => false, unmeasured, '/repo', peak);

  it('a script whose path names typecheck, or that loads typescript, keeps the class plan and is measured', () => {
    expect(lightCommandReason(program)).toBeNull();
    const byPath = plan(program, script(null));
    expect(byPath.footprintBytes).toBeGreaterThan(GIB);
    expect(byPath.resources).not.toBeNull();
    expect(byPath.footprintReason).toBe(
      'scoped-build plan: node scripts/typecheck/full-program.cjs hosts a heavy tool (its path names typecheck); charged the plan until 3 runs are measured',
    );
    expect(byPath.hookKey).toBe('full-program.cjs:abc');
    const byContent = plan(['node', 'scripts/check.mjs'], script('typescript'));
    expect(byContent.footprintBytes).toBe(byPath.footprintBytes);
    expect(byContent.footprintReason).toMatch(
      /^scoped-build plan: node scripts\/check\.mjs hosts a heavy tool \(it loads typescript\)/,
    );
  });

  it('once measured, it is charged its peak plus the margin; a plain script stays light and unmeasured', () => {
    const measured = plan(program, script(null, 3.8 * GIB));
    expect(measured.footprintBytes).toBe(Math.ceil(3.8 * GIB * 1.25));
    expect(measured.footprintReason).toBe(
      'scoped-build plan: node scripts/typecheck/full-program.cjs hosts a heavy tool (its path names typecheck), measured peak 3.8 GiB + 25%',
    );
    expect(describeCharge('scoped-build', measured)).toBe(`4.8 GiB: ${measured.footprintReason}`);
    const plain = plan(['node', 'scripts/gen.mjs'], script(null));
    expect(plain.footprintBytes).toBe(GIB);
    expect(plain.footprintReason).toBe('node scripts/gen.mjs runs no heavy tool');
    expect(plain.hookKey).toBeUndefined();
  });
});

/**
 * Kodo (mbx …FX5CJD): a tiny python3 YAML/metadata check under `cleo run
 * --class build` was charged the whole scoped-build plan (T14079).
 */
describe('a Python or shell script that runs no heavy tool is charged light (T14079)', () => {
  const RAM = 48;
  const read =
    (heavyTool: string | null, peakBytes: number | null = null) =>
    (): { key: string; heavyTool: string | null; peakBytes: number | null } => ({
      key: 'check_meta.py:abc',
      heavyTool,
      peakBytes,
    });
  const plan = (
    argv: readonly string[],
    peak: () => { key: string; heavyTool: string | null; peakBytes: number | null } | null,
  ) => planRunFootprint('scoped-build', argv, {}, RAM, () => false, unmeasured, '/repo', peak);

  it('AC1: python3 on a small check is light, with the reason as the derivation line', () => {
    const argv = ['python3', 'scripts/check_meta.py', 'meta/a.yaml'];
    expect(lightCommandReason(argv)).toBe('python3 scripts/check_meta.py runs no heavy tool');
    const light = plan(argv, read(null));
    expect(light.footprintBytes).toBe(GIB);
    expect(light.resources).toBeNull();
    expect(describeCharge('scoped-build', light)).toBe(
      '1.0 GiB: python3 scripts/check_meta.py runs no heavy tool',
    );
    expect(plan(['bash', 'scripts/lint_yaml.sh'], read(null)).footprintBytes).toBe(GIB);
  });

  it('AC2: a script that runs a test runner or compiler keeps the class plan; so does an unreadable one', () => {
    const heavy = plan(['python3', 'scripts/check_meta.py'], read('pytest'));
    expect(heavy.footprintBytes).toBeGreaterThan(GIB);
    expect(heavy.footprintReason).toMatch(
      /^scoped-build plan: python3 scripts\/check_meta\.py hosts a heavy tool \(it runs pytest\)/,
    );
    expect(plan(['bash', 'scripts/ci.sh'], () => null).footprintReason).toMatch(
      /hosts a heavy tool \(it cannot be read\)/,
    );
    // By path too, as for node scripts: a script named for a heavy job.
    expect(lightCommandReason(['python3', 'scripts/run_tests.py'])).toBeNull();
    // `python3 -m pytest` is not a plain script.
    expect(lightCommandReason(['python3', '-m', 'pytest'])).toBeNull();
  });

  it('AC3: a heavy script is charged its measured peak once recorded', () => {
    const measured = plan(['python3', 'scripts/check_meta.py'], read('pytest', 2 * GIB));
    expect(measured.footprintBytes).toBe(Math.ceil(2 * GIB * 1.25));
    expect(measured.footprintReason).toMatch(/measured peak 2\.0 GiB \+ 25%$/);
    expect(measured.hookKey).toBe('check_meta.py:abc');
  });

  it('scriptFootprint reads what a Python or shell script runs, never a node script', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cleo-script-fp-'));
    try {
      writeFileSync(
        join(repo, 'light.py'),
        'import yaml, sys\nprint(yaml.safe_load(open(sys.argv[1])))\n',
      );
      writeFileSync(join(repo, 'heavy.sh'), '#!/bin/sh\npnpm run test -- a.test.ts\n');
      writeFileSync(join(repo, 'gen.mjs'), "// runs make in prose only\nconsole.log('x');\n");
      expect(scriptFootprint(repo, 'light.py')?.heavyTool).toBeNull();
      expect(scriptFootprint(repo, 'heavy.sh')?.heavyTool).toBe('pnpm run test');
      expect(scriptFootprint(repo, 'gen.mjs')?.heavyTool).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/**
 * 2026-10-23 18:36: `biome check --write <2 files>` timed out at position 6
 * behind two hooked pushes (12 GiB each) and a test run (24 GiB) holding the
 * whole 48 GiB capacity under a halved light share (T13967).
 */
describe('a tiny run starts while holders fill the whole capacity (T13967)', () => {
  const ledger = (fmts: number) => [
    entry({ id: 'push1', state: 'admitted', footprintBytes: 12 * GIB }),
    entry({ id: 'push2', state: 'admitted', footprintBytes: 12 * GIB }),
    entry({ id: 'test', state: 'admitted', footprintBytes: 24 * GIB }),
    entry({ id: 'build', enqueuedAtMs: 100, footprintBytes: 12 * GIB }),
    ...Array.from({ length: fmts }, (_, n) =>
      entry({ id: `fmt${n}`, enqueuedAtMs: 200 + n, footprintBytes: GIB }),
    ),
  ];
  const ctx48 = {
    capacityBytes: 48 * GIB,
    share: 'half' as const,
    lightShare: 'half' as const,
    nowMs: 60_000,
  };

  it('AC1/AC3: the 1 GiB formatter is admitted; the heavy waiter is not', () => {
    const out = admittedIds(schedulePass(ledger(1), ctx48));
    expect(out).toContain('fmt0');
    expect(out).not.toContain('build');
  });

  it('at most TINY_LANE_SLOTS tiny runs sit past the capacity, and the memory gate still refuses', () => {
    const out = admittedIds(schedulePass(ledger(5), ctx48)).filter((id) => id.startsWith('fmt'));
    expect(out).toHaveLength(TINY_LANE_SLOTS);
    expect(
      admittedIds(schedulePass(ledger(1), { ...ctx48, share: 'none', lightShare: 'none' })),
    ).not.toContain('fmt0');
  });
});

describe('a scoped build is charged its own plan, not a whole heavy run (T13759)', () => {
  it('64 GiB: a scoped build plans 2 workers (12 GiB); a test run keeps 4 (24 GiB); full-build is not shrunk', () => {
    const scoped = planRunFootprint('scoped-build', ['pnpm', 'run', 'build'], {}, 64);
    expect(scoped.resources?.workers).toBe(2);
    expect(scoped.overlay.VITEST_MAX_WORKERS).toBe('2');
    expect(scoped.footprintBytes).toBe(12 * GIB);
    expect(planRunFootprint('test-run', ['pnpm', 'test'], {}, 64).footprintBytes).toBe(24 * GIB);
    expect(planRunFootprint('full-build', ['pnpm', 'run', 'build'], {}, 64).footprintBytes).toBe(
      24 * GIB,
    );
  });

  it('a hooked commit is sized to the scoped plan it is spawned with', () => {
    const plan = planRunFootprint(
      'scoped-build',
      ['git', 'commit', '-m', 'x'],
      {},
      64,
      () => true,
      unmeasured,
    );
    expect(plan.footprintBytes).toBe(12 * GIB);
  });

  it('a multi-process scoped build stays heavy; a one-worker machine is unchanged', () => {
    expect(
      planRunFootprint('scoped-build', ['pnpm', 'run', 'build'], {}, 48).resources?.workers,
    ).toBe(2);
    expect(
      planRunFootprint('scoped-build', ['pnpm', 'run', 'build'], {}, 16).resources?.workers,
    ).toBe(1);
  });

  it('two scoped builds are admitted together within a pressure-halved budget', () => {
    const capacity = admissionCapacityBytes(64 * GIB);
    const bytes =
      planRunFootprint('scoped-build', ['pnpm', 'run', 'build'], {}, 64).footprintBytes ?? 0;
    const pass = (footprintBytes: number) =>
      admittedIds(
        schedulePass(
          [
            entry({ id: 'build', enqueuedAtMs: 1, footprintBytes }),
            entry({ id: 'commit', enqueuedAtMs: 2, footprintBytes }),
          ],
          { capacityBytes: capacity, share: 'half', nowMs: 1_000 },
        ),
      );
    expect(pass(bytes)).toEqual(['build', 'commit']);
    // Before T13759 each was charged 24 GiB, the whole halved budget: one at a time.
    expect(pass(24 * GIB)).toEqual(['build']);
  });
});
