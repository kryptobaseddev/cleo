/**
 * Tests for the opportunistic dream trigger in computeBriefing — T1904 W2-3.
 *
 * Verifies:
 * 1. checkAndDream is called once per computeBriefing when the dream is allowed
 *    (T11655: a one-shot read briefing must OPT IN; default is OFF)
 * 2. Disabled config flag suppresses the trigger even when allowed
 * 3. The one-shot default (no opt-in, no long-lived host) suppresses the trigger
 * 4. A long-lived sentient host (CLEO_SENTIENT_DAEMON) re-enables the trigger
 * 5. Dream errors do not affect the briefing return value
 *
 * @task T1904
 * @task T11655
 * @epic T1892
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Mocks — declared before imports
// ============================================================================

const mockCheckAndDream = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ triggered: false, tier: null }),
);

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
  loadConfig: vi.fn().mockResolvedValue({}),
}));

// ============================================================================
// Imports after mocks
// ============================================================================

import { loadConfig } from '../../config.js';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { computeBriefing } from '../briefing.js';

// ============================================================================
// Helpers
// ============================================================================

const PROJECT_ROOT = '/fake/project';

function buildMockAccessor(tasks: unknown[] = []) {
  return {
    queryTasks: vi.fn().mockResolvedValue({ tasks, total: tasks.length }),
    getMetaValue: vi.fn().mockResolvedValue(null),
    getActiveSession: vi.fn().mockResolvedValue(null),
    resolveCurrentSession: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
    findLearnings: vi.fn().mockResolvedValue([]),
    getDeadlines: vi.fn().mockResolvedValue([]),
  };
}

const ORIGINAL_DAEMON_ENV = process.env['CLEO_SENTIENT_DAEMON'];
const ORIGINAL_SPAWN_ENV = process.env['CLEO_SENTIENT_SPAWN'];

beforeEach(() => {
  // T11655: ensure no long-lived-host env leaks between tests.
  delete process.env['CLEO_SENTIENT_DAEMON'];
  delete process.env['CLEO_SENTIENT_SPAWN'];
});

afterEach(() => {
  vi.clearAllMocks();
  mockCheckAndDream.mockResolvedValue({ triggered: false, tier: null });
  (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({});
  if (ORIGINAL_DAEMON_ENV === undefined) delete process.env['CLEO_SENTIENT_DAEMON'];
  else process.env['CLEO_SENTIENT_DAEMON'] = ORIGINAL_DAEMON_ENV;
  if (ORIGINAL_SPAWN_ENV === undefined) delete process.env['CLEO_SENTIENT_SPAWN'];
  else process.env['CLEO_SENTIENT_SPAWN'] = ORIGINAL_SPAWN_ENV;
});

// ============================================================================
// Tests
// ============================================================================

describe('computeBriefing — opportunistic dream trigger (T1904 · T11655)', () => {
  it('fires checkAndDream once when the dream is explicitly allowed and the flag is true', async () => {
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor());
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      briefing: { opportunisticDream: true },
    });

    await computeBriefing(PROJECT_ROOT, { allowOpportunisticDream: true });

    // Allow async setImmediate to fire
    await new Promise((r) => setImmediate(r));

    expect(mockCheckAndDream).toHaveBeenCalledTimes(1);
    expect(mockCheckAndDream).toHaveBeenCalledWith(PROJECT_ROOT, { inline: false });
  });

  it('T11655: does NOT fire on a one-shot read briefing (default — no opt-in, no long-lived host)', async () => {
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor());
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      briefing: { opportunisticDream: true },
    });

    // No allowOpportunisticDream, no CLEO_SENTIENT_* env → one-shot CLI default.
    await computeBriefing(PROJECT_ROOT);
    await new Promise((r) => setImmediate(r));

    expect(mockCheckAndDream).not.toHaveBeenCalled();
  });

  it('does NOT fire checkAndDream when briefing.opportunisticDream is false even if allowed', async () => {
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor());
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      briefing: { opportunisticDream: false },
    });

    await computeBriefing(PROJECT_ROOT, { allowOpportunisticDream: true });
    await new Promise((r) => setImmediate(r));

    expect(mockCheckAndDream).not.toHaveBeenCalled();
  });

  it('T11655: fires inside a long-lived sentient host (CLEO_SENTIENT_DAEMON) without an explicit opt-in', async () => {
    process.env['CLEO_SENTIENT_DAEMON'] = '1';
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor());
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await computeBriefing(PROJECT_ROOT);
    await new Promise((r) => setImmediate(r));

    expect(mockCheckAndDream).toHaveBeenCalledTimes(1);
  });

  it('does not throw when checkAndDream rejects', async () => {
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor());
    mockCheckAndDream.mockRejectedValueOnce(new Error('DB error'));

    const result = await computeBriefing(PROJECT_ROOT, { allowOpportunisticDream: true });

    expect(result).toBeDefined();
    expect(result.nextTasks).toBeDefined();
  });

  it('returns a complete briefing regardless of dream trigger outcome', async () => {
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor());

    const result = await computeBriefing(PROJECT_ROOT);

    expect(result.nextTasks).toBeDefined();
    expect(Array.isArray(result.nextTasks)).toBe(true);
  });
});
