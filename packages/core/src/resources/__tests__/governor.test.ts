/**
 * Tests for the ResourceGovernor admission core (T11999, Epic T11992).
 *
 * Samples are injected synthetically — no `/proc` reads — so budget math and
 * admission are deterministic and fast. Slot directories are isolated per fork
 * by the vitest harness (CLEO_HOME pinned to a per-fork tmpdir).
 *
 * @task T11999
 */

import { chmodSync, existsSync } from 'node:fs';
import { isResourceGrant, RESOURCE_DEFERRED_CODE } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLedger } from '../admission-ledger.js';
import type { ResourceSample } from '../backend.js';
import {
  _resetGovernorStateForTest,
  admitFailOpen,
  computeClassBudget,
  governorSlotDir,
  ResourceGovernor,
  resolveGovernorMode,
  slotFileCount,
} from '../governor.js';
import { ResourceMonitor } from '../monitor.js';
import {
  MEMORY_GATE_RETRY_AFTER_MS,
  type MemoryGateReporter,
  memoryGateReporter,
} from '../pressure-gate.js';
import {
  processGroupOf,
  processStart,
  type RunJob,
  removeRunJob,
  writeRunJob,
} from '../run-admission.js';

const GB = 1024 * 1024 * 1024;

/** Build a synthetic sample with a given MemAvailable and `some avg10`. */
function makeSample(
  opts: { memAvailableGb?: number; someAvg10?: number; fullAvg10?: number } = {},
): ResourceSample {
  const some = opts.someAvg10 ?? 0;
  const full = opts.fullAvg10 ?? 0;
  return {
    sampledAtMs: 1,
    pressureAvailable: true,
    memAvailableBytes: (opts.memAvailableGb ?? 32) * GB,
    globalPressure: {
      some: { avg10: some, avg60: some, avg300: some, totalUs: 0 },
      full: { avg10: full, avg60: full, avg300: full, totalUs: 0 },
    },
    slicePressure: null,
    walObservations: [],
  };
}

const BUDGET_OPTS = { cpuCount: 16, totalMemBytes: 64 * GB } as const;

describe('computeClassBudget (T11999)', () => {
  it('interactive-cli is never gated (Infinity)', () => {
    expect(computeClassBudget('interactive-cli', makeSample({ someAvg10: 99 }), BUDGET_OPTS)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('ledger classes: the budget is a count view of the admission ledger (T13133)', () => {
    // 256 GiB: capacity 192 GiB, a heavy run is 6 workers × 6 GiB = 36 GiB → 5 runs.
    const big = { cpuCount: 16, totalMemBytes: 256 * GB } as const;
    expect(computeClassBudget('test-run', makeSample(), big)).toBe(5);
    expect(computeClassBudget('scoped-build', makeSample(), big)).toBe(5);
    expect(computeClassBudget('full-build', makeSample(), big)).toBe(5);
    expect(computeClassBudget('test-run', makeSample({ someAvg10: 15 }), big)).toBe(2); // hold: half
    expect(computeClassBudget('test-run', makeSample({ someAvg10: 30 }), big)).toBe(0); // memory gate
  });

  it('one heavy run fills a 48 GiB machine, and nothing replaces the floor of one', () => {
    const mac = { cpuCount: 18, totalMemBytes: 48 * GB } as const;
    expect(computeClassBudget('test-run', makeSample(), mac)).toBe(1);
    expect(computeClassBudget('test-run', makeSample({ someAvg10: 15 }), mac)).toBe(1);
  });

  it('agent-session clamps by MemAvailable and cpus-2', () => {
    // 60 GB avail, 2 GB headroom, 4 GB/agent → ⌊58/4⌋=14, clamped to cpus-2=14
    expect(
      computeClassBudget('agent-session', makeSample({ memAvailableGb: 60 }), BUDGET_OPTS),
    ).toBe(14);
    // 6 GB avail → ⌊4/4⌋=1
    expect(
      computeClassBudget('agent-session', makeSample({ memAvailableGb: 6 }), BUDGET_OPTS),
    ).toBe(1);
  });

  it('db-heavy defers (0) under backoff-level pressure, else 1', () => {
    expect(computeClassBudget('db-heavy', makeSample({ someAvg10: 0 }), BUDGET_OPTS)).toBe(1);
    expect(computeClassBudget('db-heavy', makeSample({ someAvg10: 30 }), BUDGET_OPTS)).toBe(0);
  });

  it('ignoreCpuPressure: CPU saturation alone does not defer db-heavy; memory pressure still does (T13119, T13150)', () => {
    // macOS derives CPU pressure from the load average (T12981): load at 2.4x
    // the effective cores reads as cpu some avg10 ≈ 58, well past backoff.
    const cpuSaturated: ResourceSample = {
      ...makeSample({ someAvg10: 0 }),
      cpuPressure: {
        some: { avg10: 58, avg60: 58, avg300: 58, totalUs: 0 },
        full: null,
      },
    };
    expect(computeClassBudget('db-heavy', cpuSaturated, BUDGET_OPTS)).toBe(0);
    expect(
      computeClassBudget('db-heavy', cpuSaturated, { ...BUDGET_OPTS, ignoreCpuPressure: true }),
    ).toBe(1);
    const memoryPressured: ResourceSample = { ...cpuSaturated, ...makeSample({ someAvg10: 30 }) };
    expect(
      computeClassBudget('db-heavy', memoryPressured, { ...BUDGET_OPTS, ignoreCpuPressure: true }),
    ).toBe(0);
    const memoryStalled = makeSample({ someAvg10: 0, fullAvg10: 20 });
    expect(
      computeClassBudget('db-heavy', memoryStalled, { ...BUDGET_OPTS, ignoreCpuPressure: true }),
    ).toBe(0);
  });

  it('background-autonomous defers (0) under any hold-level pressure', () => {
    expect(
      computeClassBudget('background-autonomous', makeSample({ someAvg10: 0 }), BUDGET_OPTS),
    ).toBe(1);
    expect(
      computeClassBudget('background-autonomous', makeSample({ someAvg10: 15 }), BUDGET_OPTS),
    ).toBe(0);
  });
});

describe('ResourceGovernor.acquire (T11999)', () => {
  let gov: ResourceGovernor;

  beforeEach(() => {
    _resetGovernorStateForTest();
    delete process.env.CLEO_RESOURCES_MODE;
    gov = new ResourceGovernor();
  });
  afterEach(() => {
    _resetGovernorStateForTest();
    delete process.env.CLEO_RESOURCES_MODE;
  });

  it('off mode is a pure pass-through (ungated grant, slot -1)', async () => {
    process.env.CLEO_RESOURCES_MODE = 'off';
    _resetGovernorStateForTest();
    const r = await gov.acquire('db-heavy', { sample: makeSample({ someAvg10: 99 }) });
    expect(isResourceGrant(r)).toBe(true);
    if (isResourceGrant(r)) {
      expect(r.slot).toBe(-1);
      await r.release();
    }
  });

  it('interactive-cli is never gated even at extreme pressure', async () => {
    const r = await gov.acquire('interactive-cli', { sample: makeSample({ someAvg10: 99 }) });
    expect(isResourceGrant(r)).toBe(true);
  });

  it('grants a real slot when budget is available', async () => {
    const r = await gov.acquire('db-heavy', {
      sample: makeSample({ someAvg10: 0 }),
      blocking: false,
    });
    expect(isResourceGrant(r)).toBe(true);
    if (isResourceGrant(r)) {
      expect(r.slot).toBeGreaterThanOrEqual(0);
      expect(r.class).toBe('db-heavy');
      await r.release();
    }
  });

  it('zero-budget returns a structured E_RESOURCE_DEFERRED envelope', async () => {
    const r = await gov.acquire('db-heavy', {
      sample: makeSample({ someAvg10: 30 }),
      blocking: false,
    });
    expect(isResourceGrant(r)).toBe(false);
    if (!isResourceGrant(r)) {
      expect(r.deferred).toBe(true);
      expect(r.class).toBe('db-heavy');
      expect(r.retryAfterMs).toBeGreaterThan(0);
      expect(typeof r.reason).toBe('string');
    }
    // The contract code is exported for callers that surface it as an error.
    expect(RESOURCE_DEFERRED_CODE).toBe('E_RESOURCE_DEFERRED');
  });

  it('a forged CLEO_RUN_CLASS outside any cleo run job grants nothing (#1777 round 3, M-2)', async () => {
    process.env.CLEO_RUN_CLASS = 'db-heavy';
    try {
      const s = makeSample({ someAvg10: 0 }); // db-heavy budget = 1
      const first = await gov.acquire('db-heavy', { sample: s, blocking: false });
      const second = await gov.acquire('db-heavy', { sample: s, blocking: false });
      expect(isResourceGrant(first)).toBe(true);
      expect(isResourceGrant(second)).toBe(false);
      if (isResourceGrant(first)) await first.release();
    } finally {
      delete process.env.CLEO_RUN_CLASS;
    }
  });

  it('an env grant marker never bypasses admission (#1777 round 2, N1)', async () => {
    process.env.CLEO_GOVERNOR_GRANT = 'db-heavy';
    try {
      const s = makeSample({ someAvg10: 0 }); // db-heavy budget = 1
      const first = await gov.acquire('db-heavy', { sample: s, blocking: false });
      const second = await gov.acquire('db-heavy', { sample: s, blocking: false });
      expect(isResourceGrant(first)).toBe(true);
      expect(isResourceGrant(second)).toBe(false);
      if (isResourceGrant(first)) await first.release();
    } finally {
      delete process.env.CLEO_GOVERNOR_GRANT;
    }
  });

  describe('a live job record covers a nested acquire only on an exact match (#1777 round 4)', () => {
    // Real `ps` for our own group and its leader's start time (read-only).
    const pgid = processGroupOf(process.pid);
    const leaderStart = pgid === null ? null : processStart(pgid);

    /** With a db-heavy slot held, can a CLEO_RUN_CLASS acquire get another? */
    async function nestedGetsThrough(over: Partial<RunJob>): Promise<boolean> {
      const now = Date.now();
      const record: RunJob = {
        id: `${process.pid}-${now}`,
        pid: process.pid,
        runnerStart: null,
        childPid: pgid,
        childStart: leaderStart,
        class: 'db-heavy',
        command: 'pnpm test',
        cwd: '/',
        startedAtMs: now,
        sessionId: null,
        pausedAtMs: null,
        pausable: true,
        heartbeatAtMs: now,
        ...over,
      };
      writeRunJob(record);
      process.env.CLEO_RUN_CLASS = 'db-heavy';
      const s = makeSample({ someAvg10: 0 }); // db-heavy budget = 1
      const first = await gov.acquire('db-heavy', { sample: s, blocking: false });
      try {
        const second = await gov.acquire('db-heavy', { sample: s, blocking: false });
        if (isResourceGrant(second)) await second.release();
        return isResourceGrant(second);
      } finally {
        if (isResourceGrant(first)) await first.release();
        delete process.env.CLEO_RUN_CLASS;
        removeRunJob(record.id);
      }
    }

    it('our group with a different leader start time: no pass-through', async () => {
      expect(pgid).not.toBeNull();
      expect(await nestedGetsThrough({ childStart: 'Thu Jan  1 00:00:00 1970' })).toBe(false);
    });

    it("another group with our leader's start time: no pass-through", async () => {
      expect(await nestedGetsThrough({ childPid: 999_999 })).toBe(false);
    });

    it('a matching job of another class: no pass-through (MED-1)', async () => {
      expect(await nestedGetsThrough({ class: 'full-build' })).toBe(false);
    });

    // Control: the same record with group, start and class all matching does
    // pass through, so the cases above fail for the reason they name. Skipped
    // only where our group leader has exited and `ps` cannot read its start.
    it.skipIf(leaderStart === null)('an exact match passes through (control)', async () => {
      expect(await nestedGetsThrough({})).toBe(true);
    });
  });

  it('a saturated single-slot class defers the second non-blocking acquire, then recovers on release', async () => {
    const s = makeSample({ someAvg10: 0 }); // db-heavy budget = 1
    const first = await gov.acquire('db-heavy', { sample: s, blocking: false });
    expect(isResourceGrant(first)).toBe(true);

    const second = await gov.acquire('db-heavy', { sample: s, blocking: false });
    expect(isResourceGrant(second)).toBe(false); // no slot free

    if (isResourceGrant(first)) await first.release();

    const third = await gov.acquire('db-heavy', { sample: s, blocking: false });
    expect(isResourceGrant(third)).toBe(true); // slot freed
    if (isResourceGrant(third)) await third.release();
  });

  it('available() reports budget minus held slots', async () => {
    // Pin cpuCount so the agent-session budget (clamped at cpus-2) is
    // deterministic across CI runners with varying core counts.
    const s = makeSample({ someAvg10: 0, memAvailableGb: 60 }); // budget = clamp(1, 14, 14) = 14
    const before = await gov.available('agent-session', { ...BUDGET_OPTS, sample: s });
    expect(before).toBe(14);
    const g = await gov.acquire('agent-session', { ...BUDGET_OPTS, sample: s, blocking: false });
    const after = await gov.available('agent-session', { ...BUDGET_OPTS, sample: s });
    expect(after).toBe(13);
    if (isResourceGrant(g)) await g.release();
  });
});

describe('heavy classes go through the admission ledger (T13127, T13133)', () => {
  let gov: ResourceGovernor;

  beforeEach(() => {
    _resetGovernorStateForTest();
    delete process.env.CLEO_RESOURCES_MODE;
    gov = new ResourceGovernor();
  });
  afterEach(() => {
    _resetGovernorStateForTest();
  });

  /** A monitor whose samples follow a script of memory `some avg10` values. */
  function scriptedMonitor(series: readonly number[]): {
    monitor: ResourceMonitor;
    calls: () => number;
  } {
    let n = 0;
    const monitor = new ResourceMonitor({
      backend: {
        sample: async () =>
          makeSample({
            memAvailableGb: 128,
            someAvg10: series[Math.min(n++, series.length - 1)] ?? 0,
          }),
        sweepChildRss: async () => ({ sampledAtMs: 0, entries: [] }),
      },
    });
    return { monitor, calls: () => n };
  }

  function collector(): { reporter: MemoryGateReporter; lines: string[] } {
    const lines: string[] = [];
    return {
      reporter: memoryGateReporter((l) => lines.push(l), 'test run', { intervalMs: 0 }),
      lines,
    };
  }

  it('a non-blocking acquire under memory pressure is a deferral with the readings', async () => {
    const r = await gov.acquire('test-run', {
      ...BUDGET_OPTS,
      sample: makeSample({ memAvailableGb: 128, someAvg10: 40 }),
      blocking: false,
    });
    expect(r.deferred).toBe(true);
    if (!r.deferred) return;
    expect(r.memoryPressure).toMatchObject({ score: 40, refuseAbove: 25, resumeAtOrBelow: 15 });
    expect(r.reason).toMatch(/^memory pressure 40 \(refused above 25, resumes at 15 or below\)/);
    expect(r.retryAfterMs).toBe(MEMORY_GATE_RETRY_AFTER_MS);
    expect(readLedger()).toEqual([]); // nothing was started or held
    expect(slotFileCount('test-run')).toBe(0); // and no slot dir exists any more
  });

  it('a blocking acquire waits, saying so, and is admitted when pressure falls', async () => {
    const { monitor, calls } = scriptedMonitor([40, 30, 20, 12]);
    const { reporter, lines } = collector();
    const r = await gov.acquire('test-run', {
      ...BUDGET_OPTS,
      monitor,
      memoryPressure: reporter,
      pollMs: 5,
      timeoutMs: 20_000,
    });
    expect(isResourceGrant(r)).toBe(true);
    if (isResourceGrant(r)) await r.release();
    // 40 and 30 refuse; 20 is still refused (latched: not yet down to 15); 12
    // admits; the release samples once more for its scheduling pass.
    expect(calls()).toBe(5);
    expect(
      lines.filter((l) => l.startsWith('waiting: memory pressure')).length,
    ).toBeGreaterThanOrEqual(3);
    expect(lines.at(-1)).toMatch(
      /^memory pressure fell after waiting \d+s: admitting the test run\.$/,
    );
  }, 30_000);

  it('a blocking acquire under lasting pressure gives up at its timeout with the readings', async () => {
    const { monitor } = scriptedMonitor([50]);
    const t0 = Date.now();
    const r = await gov.acquire('scoped-build', {
      ...BUDGET_OPTS,
      monitor,
      pollMs: 5,
      timeoutMs: 60,
    });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.deferred).toBe(true);
    if (!r.deferred) return;
    expect(r.memoryPressure?.score).toBe(50);
  });

  it('hysteresis holds across acquirers: refused at 30, still refused at 20, admitted at 14', async () => {
    const at = (some: number) =>
      gov.acquire('test-run', {
        ...BUDGET_OPTS,
        sample: makeSample({ memAvailableGb: 128, someAvg10: some }),
        blocking: false,
      });
    const first = await at(20); // unlatched: 20 is not above 25
    expect(first.deferred).toBe(false);
    if (isResourceGrant(first)) await first.release();
    expect((await at(30)).deferred).toBe(true);
    const latched = await at(20);
    expect(latched.deferred).toBe(true);
    if (latched.deferred) expect(latched.memoryPressure?.latched).toBe(true);
    const resumed = await at(14);
    expect(resumed.deferred).toBe(false);
    if (isResourceGrant(resumed)) await resumed.release();
    const after = await at(20);
    expect(after.deferred).toBe(false);
    if (isResourceGrant(after)) await after.release();
  });

  it('a monitor that throws counts as no signal: admitted, never blocked', async () => {
    const monitor = new ResourceMonitor({
      backend: {
        sample: async () => {
          throw new Error('sysctl unavailable');
        },
        sweepChildRss: async () => ({ sampledAtMs: 0, entries: [] }),
      },
    });
    const r = await gov.acquire('test-run', { ...BUDGET_OPTS, monitor, timeoutMs: 1_000 });
    expect(isResourceGrant(r)).toBe(true);
    if (isResourceGrant(r)) await r.release();
  });

  it('a held heavy run defers the next, naming the holder, and a release frees it', async () => {
    const held = await gov.acquire('test-run', {
      ...BUDGET_OPTS,
      sample: makeSample(),
      blocking: false,
    });
    expect(held.deferred).toBe(false);
    const next = await gov.acquire('full-build', {
      ...BUDGET_OPTS,
      sample: makeSample(),
      blocking: false,
    });
    expect(next.deferred).toBe(true);
    if (next.deferred) expect(next.reason).toMatch(/held by class:test-run pid \d+/);
    if (isResourceGrant(held)) await held.release();
    const after = await gov.acquire('full-build', {
      ...BUDGET_OPTS,
      sample: makeSample(),
      blocking: false,
    });
    expect(after.deferred).toBe(false);
    if (isResourceGrant(after)) await after.release();
  });

  it('available() is 0 while the gate refuses, and recovers with it', async () => {
    // 64 GiB: capacity 48 GiB holds one 36 GiB heavy run.
    const at = (some: number) =>
      gov.available('test-run', {
        ...BUDGET_OPTS,
        sample: makeSample({ memAvailableGb: 128, someAvg10: some }),
      });
    expect(await at(0)).toBe(1);
    expect(await at(40)).toBe(0);
    expect(await at(20)).toBe(0); // latched until it falls to 15
    expect(await at(10)).toBe(1);
  });

  it('CPU saturation alone narrows test-run to 1 and never refuses it', async () => {
    const cpuBound: ResourceSample = {
      ...makeSample({ memAvailableGb: 128 }),
      cpuPressure: { some: { avg10: 95, avg60: 95, avg300: 95, totalUs: 0 }, full: null },
    };
    expect(await gov.available('test-run', { ...BUDGET_OPTS, sample: cpuBound })).toBe(1);
    const r = await gov.acquire('test-run', { ...BUDGET_OPTS, sample: cpuBound, blocking: false });
    expect(isResourceGrant(r)).toBe(true);
    if (isResourceGrant(r)) await r.release();
  });

  it('classes outside the ledger are not refused by the memory gate', async () => {
    const r = await gov.acquire('agent-session', {
      ...BUDGET_OPTS,
      sample: makeSample({ memAvailableGb: 128, someAvg10: 40 }),
      blocking: false,
    });
    expect(isResourceGrant(r)).toBe(true);
    if (isResourceGrant(r)) await r.release();
  });
});

describe('resolveGovernorMode (T11999)', () => {
  afterEach(() => {
    _resetGovernorStateForTest();
    delete process.env.CLEO_RESOURCES_MODE;
  });

  it('defaults to local when unset', () => {
    _resetGovernorStateForTest();
    delete process.env.CLEO_RESOURCES_MODE;
    expect(resolveGovernorMode()).toBe('local');
  });

  it('honours off and supervisor; unknown → local', () => {
    _resetGovernorStateForTest();
    process.env.CLEO_RESOURCES_MODE = 'off';
    expect(resolveGovernorMode()).toBe('off');
    _resetGovernorStateForTest();
    process.env.CLEO_RESOURCES_MODE = 'bogus';
    expect(resolveGovernorMode()).toBe('local');
  });

  it('supervisor mode demotes to local for admission (off-by-default arbiter)', async () => {
    _resetGovernorStateForTest();
    process.env.CLEO_RESOURCES_MODE = 'supervisor';
    const gov = new ResourceGovernor();
    // demotes to local arbitration → still grants a real local slot
    const r = await gov.acquire('db-heavy', {
      sample: makeSample({ someAvg10: 0 }),
      blocking: false,
    });
    expect(isResourceGrant(r)).toBe(true);
    if (isResourceGrant(r)) {
      expect(r.slot).toBeGreaterThanOrEqual(0);
      await r.release();
    }
  });
});

describe('an unwritable slot dir is an error, never a busy slot (#1777 R8-1)', () => {
  // Root ignores directory permissions: the read-only case cannot be staged.
  const asRoot = process.getuid?.() === 0;
  const s = makeSample({ someAvg10: 0 }); // db-heavy budget = 1
  let gov: ResourceGovernor;
  let dir: string;

  beforeEach(async () => {
    _resetGovernorStateForTest();
    delete process.env.CLEO_RESOURCES_MODE;
    gov = new ResourceGovernor();
    dir = governorSlotDir('db-heavy');
    // A home that already has its slot dir (an earlier unsandboxed run).
    const first = await gov.tryAcquire('db-heavy', { sample: s });
    expect(isResourceGrant(first)).toBe(true);
    if (isResourceGrant(first)) await first.release();
    expect(existsSync(dir)).toBe(true);
  });
  afterEach(() => {
    if (existsSync(dir)) chmodSync(dir, 0o755);
    _resetGovernorStateForTest();
  });

  it.skipIf(asRoot)('a read-only slot dir makes tryAcquire throw, not defer', async () => {
    chmodSync(dir, 0o555);
    await expect(gov.tryAcquire('db-heavy', { sample: s })).rejects.toMatchObject({
      code: expect.stringMatching(/^(EACCES|EPERM)$/),
    });
  });

  it.skipIf(asRoot)(
    'a blocking acquire throws at once instead of waiting out its timeout',
    async () => {
      chmodSync(dir, 0o555);
      const t0 = Date.now();
      await expect(
        gov.acquire('db-heavy', { sample: s, timeoutMs: 20_000, pollMs: 10 }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(EACCES|EPERM)$/) });
      expect(Date.now() - t0).toBeLessThan(10_000);
    },
  );

  it.skipIf(asRoot)('admitFailOpen turns it into an ungated grant that says why', async () => {
    chmodSync(dir, 0o555);
    const r = await admitFailOpen('db-heavy', () => gov.tryAcquire('db-heavy', { sample: s }));
    expect(r.admission).toMatchObject({ deferred: false, class: 'db-heavy', slot: -1 });
    expect(r.ungoverned?.code).toMatch(/^(EACCES|EPERM)$/);
  });

  it.skipIf(asRoot)('available() does not count an unwritable slot as held', async () => {
    chmodSync(dir, 0o555);
    expect(await gov.available('db-heavy', { sample: s })).toBe(1);
  });

  it('a slot held by someone else is still busy: a deferral, no throw', async () => {
    const held = await gov.tryAcquire('db-heavy', { sample: s });
    expect(isResourceGrant(held)).toBe(true);
    const second = await gov.tryAcquire('db-heavy', { sample: s });
    expect(second.deferred).toBe(true);
    if (isResourceGrant(held)) await held.release();
  });

  it('admitFailOpen lets any other error through: it is a bug, not a sandbox', async () => {
    await expect(
      admitFailOpen('db-heavy', async () => {
        throw new TypeError('cannot read properties of undefined');
      }),
    ).rejects.toThrow(TypeError);
  });
});
