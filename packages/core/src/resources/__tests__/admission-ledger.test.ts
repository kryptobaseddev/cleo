/**
 * Tests for the admission ledger (T13133): one byte budget, one FIFO queue
 * with backfill and reservation, verified re-entrancy, liveness, and a
 * critical section that loses no update under 20 concurrent admitters.
 *
 * @task T13133
 */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMISSION_ENV,
  ADMISSION_PRESSURE_ENV,
  admissionCapacityBytes,
  admissionToken,
  admit,
  enclosingGrant,
  entryLiveness,
  footprintForTool,
  GIB,
  LEDGER_HEARTBEAT_STALE_MS,
  LEDGER_RESERVATION_MS,
  type LedgerEntry,
  type ProcessFacts,
  readLedger,
  reapLedger,
  schedulePass,
  suspectCycle,
} from '../admission-ledger.js';
import type { ResourceSample } from '../backend.js';
import { ResourceMonitor } from '../monitor.js';
import { _resetMemoryGateForTest, memoryGateReporter } from '../pressure-gate.js';
import type { PidProbe } from '../slot-holder.js';

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
  it('a 48 GiB machine holds exactly one heavy run (36 GiB of 36 GiB); single-process runs are charged their heap', () => {
    expect(admissionCapacityBytes(48 * GIB)).toBe(36 * GIB);
    expect(footprintForTool('test', 48 * GIB)).toBe(36 * GIB);
    // typecheck and lint: the planned heap (default 4096 MiB) + 2048 MiB of process overhead
    expect(footprintForTool('typecheck', 48 * GIB)).toBe(6 * GIB);
    expect(footprintForTool('lint', 48 * GIB)).toBe(6 * GIB);
    expect(footprintForTool('typecheck', 48 * GIB, 8192)).toBe(10 * GIB);
    expect(footprintForTool('audit', 48 * GIB)).toBe(GIB);
  });

  it('a 16 GiB laptop keeps 4 GiB back and charges a heavy run 2 workers', () => {
    expect(admissionCapacityBytes(16 * GIB)).toBe(12 * GIB);
    expect(footprintForTool('test', 16 * GIB)).toBe(12 * GIB);
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
    const out = schedulePass(
      [
        entry({ id: 'held', state: 'admitted', footprintBytes: 6 * GIB }),
        entry({ id: 'big', enqueuedAtMs: 0, footprintBytes: 8 * GIB }),
        entry({ id: 'small', enqueuedAtMs: 950, footprintBytes: GIB }),
      ],
      { ...ctx, nowMs: LEDGER_RESERVATION_MS },
    );
    expect(admittedIds(out)).toEqual(['held']);
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

  it('CPU saturation admits one run at a time; the memory gate admits none', () => {
    const waiting = [entry({ id: 'a', enqueuedAtMs: 1 }), entry({ id: 'b', enqueuedAtMs: 2 })];
    expect(admittedIds(schedulePass(waiting, { ...ctx, share: 'one' }))).toEqual(['a']);
    expect(admittedIds(schedulePass(waiting, { ...ctx, share: 'none' }))).toEqual([]);
  });
});

describe('entryLiveness', () => {
  const probe = (over: Partial<PidProbe>): PidProbe => ({
    liveness: () => 'alive',
    startedAt: () => 'Sat Oct 3 10:00:00 2026',
    groupLiveness: () => 'gone',
    ...over,
  });
  const now = 10 * LEDGER_HEARTBEAT_STALE_MS;
  const stale = { heartbeatAtMs: 0 };

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

  it('membership of a tool group the holder started also proves it', () => {
    expect(
      enclosingGrant([holder], 1000, {}, facts({ ancestorsOf: () => [1], groupOf: () => 600 })),
    ).toBe(holder);
  });

  it('a holder never rides its own grant, and waiting entries grant nothing', () => {
    expect(enclosingGrant([holder], 500, {}, facts())).toBeNull();
    expect(enclosingGrant([{ ...holder, state: 'waiting' }], 1000, {}, facts())).toBeNull();
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

  const base = { capacityBytes, sample: calm, env: {}, pollMs: 5 };

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
      /^still waiting after 1m 0\ds for the machine budget \(10 GiB of 10 GiB in use, 0 waiting ahead\)\. Holders: tool:test pid/,
    );
    await a.grant.release();
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
