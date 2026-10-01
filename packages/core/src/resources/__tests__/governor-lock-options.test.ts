/**
 * A slot lock refreshes often enough that a holder frozen by a job pause
 * keeps its slot for the whole pause cap (#1777 round 6, R6-1).
 *
 * @task T12978
 */

import { isResourceGrant } from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('proper-lockfile', () => ({
  default: {
    lock: async (_path: string, opts: Record<string, unknown>) => {
      calls.push(opts);
      return async () => {};
    },
  },
}));

import type { ResourceSample } from '../backend.js';
import {
  _resetGovernorStateForTest,
  ResourceGovernor,
  SLOT_LOCK_STALE_MS,
  SLOT_LOCK_UPDATE_MS,
} from '../governor.js';

const sample: ResourceSample = {
  sampledAtMs: 1,
  pressureAvailable: true,
  memAvailableBytes: 32 * 1024 ** 3,
  globalPressure: {
    some: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
    full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
  },
  slicePressure: null,
  walObservations: [],
};

describe('slot lock options', () => {
  it('a grant takes its lock with the short refresh interval and the stale window', async () => {
    _resetGovernorStateForTest();
    delete process.env.CLEO_RESOURCES_MODE;
    const g = await new ResourceGovernor().acquire('db-heavy', { sample, blocking: false });
    expect(isResourceGrant(g)).toBe(true);
    if (isResourceGrant(g)) await g.release();
    expect(calls[0]).toMatchObject({ stale: SLOT_LOCK_STALE_MS, update: SLOT_LOCK_UPDATE_MS });
  });
});
