/**
 * Process-keepalive contract for the fire-and-forget dream dispatch (T9948).
 *
 * **Bug**: a single `cleo briefing` invocation could hold the SQLite writer
 * lock for the full duration of `runConsolidation` (often >5 minutes on a
 * busy brain.db), blocking every other agent's `cleo doctor`/`cleo find`/
 * `cleo show` call that landed during the window. Root cause: the
 * opportunistic dream trigger fired `setImmediate(run)` without
 * `.unref()`-ing the handle, so the briefing process stayed alive — and
 * held the brain.db writer lock — until consolidation finished.
 *
 * **Fix contract pinned by this test**: the fire-and-forget path inside
 * `dispatchDream` MUST call `.unref()` on the timer handle so the host
 * process exits as soon as the briefing's own await chain resolves. The
 * dream still runs to completion inside long-lived hosts (sentient daemon,
 * test harnesses) because their event loop is kept alive by unrelated work.
 *
 * **Why a unit test on the handle, not an end-to-end repro**: a real
 * 2-process repro would spawn two `cleo` subprocesses, deliberately stall
 * one inside `runConsolidation`, and assert the other doesn't block. That
 * is environment-coupled, slow, and the failure mode (parent process
 * lifetime) is already exactly captured by `setImmediate(...).unref()`.
 * Asserting the unref is what regression-locks the fix.
 *
 * @task T9948 — cleo briefing holds DB lock for 7+ minutes
 * @bug Multi-agent: agent A's briefing blocked agent B's doctor for 7+ min
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Mocks — declared before imports
// ============================================================================

// Track every Immediate handle returned by setImmediate so we can assert
// `.unref()` was called on the dream-dispatched one.
type ImmediateRecord = {
  handle: NodeJS.Immediate;
  unrefCalled: boolean;
  refCalled: boolean;
};

const immediateRecords: ImmediateRecord[] = [];
let originalSetImmediate: typeof setImmediate;

vi.mock('../brain-lifecycle.js', () => ({
  runConsolidation: vi.fn().mockResolvedValue({
    deduplicated: 0,
    qualityRecomputed: 0,
    tierPromotions: { promoted: [], evicted: [] },
    contradictions: 0,
    softEvicted: 0,
    edgesStrengthened: 0,
    nexusEdgesStrengthened: 0,
    summariesGenerated: 0,
  }),
}));

vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainDb: vi.fn().mockResolvedValue({}),
  getBrainNativeDb: vi.fn().mockReturnValue(null),
}));

// ============================================================================
// Imports after mocks
// ============================================================================

import { _resetDreamState, checkAndDream } from '../dream-cycle.js';

// ============================================================================
// Helpers
// ============================================================================

beforeEach(() => {
  _resetDreamState();
  immediateRecords.length = 0;

  // Patch global setImmediate to record every call AND wrap the returned
  // handle so we can detect `.unref()` invocations made by production code.
  originalSetImmediate = global.setImmediate;
  // setImmediate has multiple overloads and a `__promisify__` property that
  // vitest/Node typings disagree about; we only care about the (cb) ->
  // Immediate behaviour for this test, so we cast through `unknown`.
  (global as unknown as { setImmediate: typeof setImmediate }).setImmediate = ((
    cb: (...args: unknown[]) => void,
    ...args: unknown[]
  ) => {
    const handle = originalSetImmediate(cb, ...args);
    const record: ImmediateRecord = {
      handle,
      unrefCalled: false,
      refCalled: false,
    };
    const originalUnref = handle.unref.bind(handle);
    const originalRef = handle.ref.bind(handle);
    handle.unref = (): NodeJS.Immediate => {
      record.unrefCalled = true;
      return originalUnref();
    };
    handle.ref = (): NodeJS.Immediate => {
      record.refCalled = true;
      return originalRef();
    };
    immediateRecords.push(record);
    return handle;
  }) as typeof setImmediate;
});

afterEach(() => {
  global.setImmediate = originalSetImmediate;
  _resetDreamState();
  vi.clearAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('dispatchDream — process keepalive contract (T9948)', () => {
  it('fire-and-forget path calls .unref() on the setImmediate handle', async () => {
    // Trigger the volume tier by short-circuiting via a low threshold. The
    // brain-lifecycle mock above guarantees runConsolidation returns
    // immediately so we can observe the handle without waiting on real I/O.
    //
    // checkAndDream returns AFTER scheduling — the immediate is still
    // pending at this point. We verify .unref() was called BEFORE we let
    // the event loop drain.
    const result = await checkAndDream('/fake/project', {
      volumeThreshold: 0, // force tier 1 to fire
      inline: false,
    });

    // Sanity: the dream was actually scheduled (not skipped by cooldown / DB
    // unavailability / etc). The mock returns observation count 0, so the
    // volume tier fires IFF threshold ≤ 0.
    // If the test starts failing here, the cooldown guard or DB-availability
    // check changed and the assertion below would be vacuously true.
    if (!result.triggered) {
      // The trigger short-circuit didn't fire — but the keepalive contract
      // still matters for every OTHER setImmediate call dispatchDream makes.
      // In practice this branch is unreachable with the mocks above; keep
      // it explicit so a future regression surfaces here rather than as a
      // silent green test.
      expect(result.triggered, `dream was not triggered: ${result.skippedReason}`).toBe(true);
    }

    // The fire-and-forget path MUST have scheduled exactly one immediate
    // and MUST have unref()-ed it.
    expect(immediateRecords.length).toBeGreaterThanOrEqual(1);
    const dreamImmediate = immediateRecords[immediateRecords.length - 1];
    expect(dreamImmediate?.unrefCalled).toBe(true);
  });

  it('inline path does NOT schedule a setImmediate (synchronous run)', async () => {
    const before = immediateRecords.length;
    await checkAndDream('/fake/project', {
      volumeThreshold: 0,
      inline: true,
    });
    // No new immediates from this code path.
    const after = immediateRecords.length;
    expect(after).toBe(before);
  });

  it('repeated rapid calls do not pile up more keepalive handles than allowed', async () => {
    // The first call fires; subsequent calls within DREAM_COOLDOWN_MS skip.
    // So only ONE immediate should be scheduled across 5 rapid calls.
    for (let i = 0; i < 5; i++) {
      await checkAndDream('/fake/project', {
        volumeThreshold: 0,
        inline: false,
      });
    }
    expect(immediateRecords.length).toBe(1);
    expect(immediateRecords[0]?.unrefCalled).toBe(true);
  });
});
