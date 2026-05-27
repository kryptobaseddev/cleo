/**
 * Briefing-level keepalive + trace contract for the opportunistic dream
 * trigger (T9948).
 *
 * **Bug**: `cleo briefing` held the SQLite writer lock for 13 minutes
 * because its opportunistic dream trigger fired without `.unref()`-ing
 * the timer handle. Other agents' `cleo doctor --audit-worktree-orphans`
 * blocked behind the writer lock for 7+ minutes.
 *
 * **What this test pins**:
 *  1. AC3 — `computeBriefing` emits a structured trace BEFORE firing the
 *     opportunistic dream so contention-investigation tooling can
 *     correlate a writer-lock holder with the dream trigger event.
 *  2. The dream trigger is fire-and-forget (not awaited) so the briefing
 *     resolves promptly even when the dream cycle would take minutes.
 *
 * The lower-level `.unref()` contract is pinned by
 * `dream-cycle-keepalive.test.ts`.
 *
 * @task T9948
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Mocks — declared before imports
// ============================================================================

const mockCheckAndDream = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ triggered: false, tier: null }),
);

// Track logger.debug calls so we can assert the trace event.
const debugLog = vi.hoisted(() => vi.fn());

vi.mock('../../memory/dream-cycle.js', () => ({
  checkAndDream: mockCheckAndDream,
}));

vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  getTaskAccessor: vi.fn(),
  createDataAccessor: vi.fn(),
}));

vi.mock('../handoff.js', () => ({
  getLastHandoff: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../lifecycle/pipeline.js', () => ({
  getPipeline: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({ briefing: { opportunisticDream: true } }),
}));

vi.mock('../../logger.js', () => ({
  getLogger: vi.fn(() => ({
    debug: debugLog,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  })),
}));

// ============================================================================
// Imports after mocks
// ============================================================================

import { getTaskAccessor } from '../../store/data-accessor.js';
import { computeBriefing } from '../briefing.js';

// ============================================================================
// Helpers
// ============================================================================

function buildMockAccessor(tasks: unknown[] = []) {
  return {
    queryTasks: vi.fn().mockResolvedValue({ tasks, total: tasks.length }),
    getMetaValue: vi.fn().mockResolvedValue(null),
    getActiveSession: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
    findLearnings: vi.fn().mockResolvedValue([]),
    getDeadlines: vi.fn().mockResolvedValue([]),
    loadSessions: vi.fn().mockResolvedValue([]),
  };
}

beforeEach(() => {
  (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor());
  mockCheckAndDream.mockResolvedValue({ triggered: false, tier: null });
  debugLog.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('computeBriefing — keepalive + trace contract (T9948)', () => {
  it('emits an opportunistic-dream-trigger debug trace before firing', async () => {
    await computeBriefing('/fake/project');

    // Allow the post-return async work to fully settle so the trace fires.
    await new Promise((r) => setImmediate(r));

    // AC3: contention-audit trace MUST be present whenever the opportunistic
    // dream is scheduled. Identify it by the `event` field on the structured
    // log payload — message text is informational.
    const traceCalls = debugLog.mock.calls.filter((call) => {
      const payload = call[0] as Record<string, unknown> | undefined;
      return payload?.['event'] === 'opportunistic-dream-trigger';
    });
    expect(traceCalls.length).toBe(1);
    const payload = traceCalls[0]?.[0] as Record<string, unknown>;
    expect(payload['task']).toBe('T9948');
    expect(payload['projectRoot']).toBe('/fake/project');
  });

  it('briefing does NOT await checkAndDream (fire-and-forget)', async () => {
    // Make checkAndDream hang forever — if briefing awaited it, this test
    // would time out.
    mockCheckAndDream.mockImplementation(() => new Promise(() => undefined));

    const start = Date.now();
    const result = await computeBriefing('/fake/project');
    const elapsed = Date.now() - start;

    // 500ms is a generous upper bound — the briefing path under mocks
    // resolves in single-digit ms in practice. We accept anything under
    // half a second; a regression that awaits checkAndDream would
    // manifest as the test hitting the vitest 5s timeout.
    expect(elapsed).toBeLessThan(500);
    expect(result).toBeDefined();
    expect(result.nextTasks).toBeDefined();
  });

  it('does not emit the trace when opportunisticDream is disabled', async () => {
    const { loadConfig } = await import('../../config.js');
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      briefing: { opportunisticDream: false },
    });

    await computeBriefing('/fake/project');
    await new Promise((r) => setImmediate(r));

    const traceCalls = debugLog.mock.calls.filter((call) => {
      const payload = call[0] as Record<string, unknown> | undefined;
      return payload?.['event'] === 'opportunistic-dream-trigger';
    });
    expect(traceCalls.length).toBe(0);
    expect(mockCheckAndDream).not.toHaveBeenCalled();
  });
});
