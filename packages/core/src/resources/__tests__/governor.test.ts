/**
 * Tests for the ResourceGovernor admission core (T11999, Epic T11992).
 *
 * Samples are injected synthetically — no `/proc` reads — so budget math and
 * admission are deterministic and fast. Slot directories are isolated per fork
 * by the vitest harness (CLEO_HOME pinned to a per-fork tmpdir).
 *
 * @task T11999
 */

import { isResourceGrant, RESOURCE_DEFERRED_CODE } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResourceSample } from '../backend.js';
import {
  _resetGovernorStateForTest,
  computeClassBudget,
  ResourceGovernor,
  resolveGovernorMode,
} from '../governor.js';

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

  it('full-build is pinned to 1 machine-wide regardless of pressure', () => {
    expect(computeClassBudget('full-build', makeSample({ someAvg10: 0 }), BUDGET_OPTS)).toBe(1);
    expect(computeClassBudget('full-build', makeSample({ someAvg10: 90 }), BUDGET_OPTS)).toBe(1);
  });

  it('test-run scales down under pressure: base → half (some>10) → 1 (some>25)', () => {
    const base = computeClassBudget('test-run', makeSample({ someAvg10: 0 }), BUDGET_OPTS);
    expect(base).toBe(4); // max(1, 16/4)
    expect(computeClassBudget('test-run', makeSample({ someAvg10: 15 }), BUDGET_OPTS)).toBe(2); // halved
    expect(computeClassBudget('test-run', makeSample({ someAvg10: 30 }), BUDGET_OPTS)).toBe(1); // floor
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
