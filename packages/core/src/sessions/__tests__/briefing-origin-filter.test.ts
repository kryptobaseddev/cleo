/**
 * Tests for origin-based active epic filtering — T1899 W3-1.
 *
 * Verifies that computeActiveEpics:
 * 1. Excludes epics with origin='test-fixture'
 * 2. Includes epics with origin='production' (or null without fixture heuristic match)
 * 3. Falls back to heuristic for rows with no origin set
 *
 * @task T1899
 * @epic T1892
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

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

vi.mock('../../memory/dream-cycle.js', () => ({
  checkAndDream: vi.fn().mockResolvedValue({ triggered: false, tier: null }),
}));

// ============================================================================
// Imports
// ============================================================================

import { isTestFixtureOrigin } from '@cleocode/contracts';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { computeBriefing } from '../briefing.js';

// ============================================================================
// Helpers
// ============================================================================

const PROJECT_ROOT = '/fake/project';

function makeEpic(id: string, title: string, origin?: string | null) {
  return {
    id,
    title,
    type: 'epic',
    // Use 'active' so these epics don't appear in nextTasks (which only surfaces
    // pending tasks). Using 'active' here ensures the origin-filter tests remain
    // independent of the T9974 dedup-against-nextTasks logic.
    status: 'active',
    priority: 'medium',
    description: null,
    origin: origin ?? null,
    labels: [],
    depends: [],
    parentId: null,
    createdAt: new Date().toISOString(),
  };
}

function buildMockAccessor(tasks: unknown[]) {
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
});

// ============================================================================
// Tests
// ============================================================================

describe('computeBriefing — origin-based epic filtering (T1899)', () => {
  it('excludes epics with origin=test-fixture from activeEpics', async () => {
    const tasks = [
      makeEpic('E1', 'Test Epic Alpha', 'test-fixture'),
      makeEpic('T100', 'Real work epic', 'production'),
    ];
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor(tasks));

    const briefing = await computeBriefing(PROJECT_ROOT);

    const epicIds = briefing.activeEpics?.map((e) => e.id) ?? [];
    expect(epicIds).not.toContain('E1');
    expect(epicIds).toContain('T100');
  });

  it('includes epics with origin=production', async () => {
    const tasks = [makeEpic('T200', 'Feature epic', 'production')];
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor(tasks));

    const briefing = await computeBriefing(PROJECT_ROOT);

    const epicIds = briefing.activeEpics?.map((e) => e.id) ?? [];
    expect(epicIds).toContain('T200');
  });

  it('includes epics with origin=imported', async () => {
    const tasks = [makeEpic('T300', 'Imported epic', 'imported')];
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor(tasks));

    const briefing = await computeBriefing(PROJECT_ROOT);

    const epicIds = briefing.activeEpics?.map((e) => e.id) ?? [];
    expect(epicIds).toContain('T300');
  });

  it('falls back to heuristic for rows with no origin — T932EP excluded', async () => {
    const tasks = [makeEpic('T932EP', 'Legacy test fixture', null)];
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor(tasks));

    const briefing = await computeBriefing(PROJECT_ROOT);

    const epicIds = briefing.activeEpics?.map((e) => e.id) ?? [];
    expect(epicIds).not.toContain('T932EP');
  });

  it('falls back to heuristic for E1-style IDs with no origin', async () => {
    const tasks = [makeEpic('E1', 'Some fixture epic', null)];
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(buildMockAccessor(tasks));

    const briefing = await computeBriefing(PROJECT_ROOT);

    const epicIds = briefing.activeEpics?.map((e) => e.id) ?? [];
    expect(epicIds).not.toContain('E1');
  });

  it('isTestFixtureOrigin helper correctly identifies test-fixture', () => {
    expect(isTestFixtureOrigin('test-fixture')).toBe(true);
    expect(isTestFixtureOrigin('production')).toBe(false);
    expect(isTestFixtureOrigin(null)).toBe(false);
    expect(isTestFixtureOrigin(undefined)).toBe(false);
  });
});
