/**
 * ResourceGovernor supervisor-mode tests (T12001 · Epic T11992).
 *
 * In `supervisor` mode the governor routes admission through the Rust arbiter's
 * `resource_admit` / `resource_release` verbs (mocked here). A granted admit
 * yields a grant whose `release` calls `resource_release`; a deferred admit
 * yields the structured deferral; an unreachable supervisor degrades to the
 * local slot engine (a grant) — never a deadlock.
 *
 * @task T12001
 */

import type {
  ResourceAdmitResultResponse,
  ResourceReleaseResultResponse,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceSample } from '../backend.js';

const sendResourceAdmit =
  vi.fn<
    (
      s: string,
      c: string,
      h: string,
      b: number,
    ) => Promise<ResourceAdmitResultResponse | { unavailable: true; reason: string }>
  >();
const sendResourceRelease =
  vi.fn<
    (
      s: string,
      c: string,
      h: string,
    ) => Promise<ResourceReleaseResultResponse | { unavailable: true; reason: string }>
  >();

vi.mock('../supervisor-admit.js', () => ({
  resolveSupervisorSocketPath: () => '/tmp/test-supervisor.sock',
  sendResourceAdmit: (s: string, c: string, h: string, b: number) => sendResourceAdmit(s, c, h, b),
  sendResourceRelease: (s: string, c: string, h: string) => sendResourceRelease(s, c, h),
}));

const GB = 1024 * 1024 * 1024;

function makeSample(): ResourceSample {
  return {
    sampledAtMs: 1,
    pressureAvailable: true,
    memAvailableBytes: 32 * GB,
    globalPressure: {
      some: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
      full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
    },
    slicePressure: null,
    walObservations: [],
  };
}

const BUDGET_OPTS = { cpuCount: 16, totalMemBytes: 64 * GB } as const;

describe('ResourceGovernor — supervisor mode (T12001)', () => {
  beforeEach(async () => {
    process.env.CLEO_RESOURCES_MODE = 'supervisor';
    const { _resetGovernorStateForTest } = await import('../governor.js');
    _resetGovernorStateForTest();
    sendResourceAdmit.mockReset();
    sendResourceRelease.mockReset();
  });

  afterEach(() => {
    process.env.CLEO_RESOURCES_MODE = undefined;
    vi.restoreAllMocks();
  });

  it('admits through the arbiter and releases via resource_release', async () => {
    sendResourceAdmit.mockResolvedValue({
      kind: 'resource_admit_result',
      disposition: 'admitted',
      retry_after_ms: 0,
      slots_remaining: 0,
    });
    sendResourceRelease.mockResolvedValue({
      kind: 'resource_release_result',
      released: true,
      slots_remaining: 0,
    });
    const { ResourceGovernor } = await import('../governor.js');
    const gov = new ResourceGovernor();

    const res = await gov.tryAcquire('db-heavy', { sample: makeSample(), ...BUDGET_OPTS });
    expect(res.deferred).toBe(false);
    expect(sendResourceAdmit).toHaveBeenCalledOnce();
    // The client-computed budget is forwarded to the arbiter (db-heavy = 1).
    expect(sendResourceAdmit.mock.calls[0]?.[3]).toBe(1);

    if (!res.deferred) await res.release();
    expect(sendResourceRelease).toHaveBeenCalledOnce();
  });

  it('returns the structured deferral when the arbiter defers', async () => {
    sendResourceAdmit.mockResolvedValue({
      kind: 'resource_admit_result',
      disposition: 'deferred',
      retry_after_ms: 2000,
      slots_remaining: 0,
    });
    const { ResourceGovernor } = await import('../governor.js');
    const gov = new ResourceGovernor();

    const res = await gov.tryAcquire('full-build', { sample: makeSample(), ...BUDGET_OPTS });
    expect(res.deferred).toBe(true);
    if (res.deferred) {
      expect(res.class).toBe('full-build');
      expect(res.retryAfterMs).toBe(2000);
    }
    expect(sendResourceRelease).not.toHaveBeenCalled();
  });

  it('degrades to the local slot engine when the supervisor is unreachable', async () => {
    sendResourceAdmit.mockResolvedValue({ unavailable: true, reason: 'connect refused' });
    const { ResourceGovernor } = await import('../governor.js');
    const gov = new ResourceGovernor();

    const res = await gov.tryAcquire('test-run', { sample: makeSample(), ...BUDGET_OPTS });
    // Local engine granted a slot (degrade path) — NOT a deferral.
    expect(res.deferred).toBe(false);
    expect(sendResourceAdmit).toHaveBeenCalledOnce();
    if (!res.deferred) await res.release();
  });
});
