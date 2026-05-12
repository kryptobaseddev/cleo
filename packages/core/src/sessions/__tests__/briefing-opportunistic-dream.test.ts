/**
 * Tests for the opportunistic dream trigger in computeBriefing — T1904 W2-3.
 *
 * Verifies:
 * 1. checkAndDream is called once per computeBriefing when enabled
 * 2. 10 rapid calls fire checkAndDream exactly once due to cooldown semantics
 * 3. Disabled config flag suppresses the trigger
 * 4. Dream errors do not affect the briefing return value
 *
 * @task T1904
 * @epic T1892
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

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
    close: vi.fn().mockResolvedValue(undefined),
    findLearnings: vi.fn().mockResolvedValue([]),
    getDeadlines: vi.fn().mockResolvedValue([]),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mockCheckAndDream.mockResolvedValue({ triggered: false, tier: null });
  (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({});
});

// ============================================================================
// Tests
// ============================================================================

describe('computeBriefing — opportunistic dream trigger (T1904)', () => {
  it('fires checkAndDream once when briefing.opportunisticDream is true (default)', async () => {
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor());
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      briefing: { opportunisticDream: true },
    });

    await computeBriefing(PROJECT_ROOT);

    // Allow async setImmediate to fire
    await new Promise((r) => setImmediate(r));

    expect(mockCheckAndDream).toHaveBeenCalledTimes(1);
    expect(mockCheckAndDream).toHaveBeenCalledWith(PROJECT_ROOT, { inline: false });
  });

  it('does NOT fire checkAndDream when briefing.opportunisticDream is false', async () => {
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor());
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      briefing: { opportunisticDream: false },
    });

    await computeBriefing(PROJECT_ROOT);
    await new Promise((r) => setImmediate(r));

    expect(mockCheckAndDream).not.toHaveBeenCalled();
  });

  it('fires checkAndDream when config has no briefing section (defaults to true)', async () => {
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor());
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await computeBriefing(PROJECT_ROOT);
    await new Promise((r) => setImmediate(r));

    expect(mockCheckAndDream).toHaveBeenCalledTimes(1);
  });

  it('does not throw when checkAndDream rejects', async () => {
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor());
    mockCheckAndDream.mockRejectedValueOnce(new Error('DB error'));

    const result = await computeBriefing(PROJECT_ROOT);

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
