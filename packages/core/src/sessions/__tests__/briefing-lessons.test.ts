/**
 * Tests for the lessons index in session briefing.
 *
 * Validates that computeBriefing lists current lessons as one-line rules with a
 * fetch pointer, omits the key when there are none, and warns when the read fails.
 *
 * @task T13949
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const mockListLessons = vi.fn();
vi.mock('../../memory/lessons.js', () => ({
  listLessons: mockListLessons,
}));

import { getTaskAccessor } from '../../store/data-accessor.js';
import { computeBriefing } from '../briefing.js';

/** Install a task accessor with no tasks and no focus. */
function setupMockAccessor(): void {
  const meta: Record<string, unknown> = {
    focus_state: { currentTask: null, currentPhase: null },
    file_meta: { schemaVersion: '2.10.0' },
  };
  (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue({
    loadSessions: vi.fn().mockResolvedValue([]),
    saveSessions: vi.fn().mockResolvedValue(undefined),
    getActiveSession: vi.fn().mockResolvedValue(null),
    resolveCurrentSession: vi.fn().mockResolvedValue(null),
    upsertSingleSession: vi.fn().mockResolvedValue(undefined),
    removeSingleSession: vi.fn().mockResolvedValue(undefined),
    queryTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0 }),
    loadSingleTask: vi.fn().mockResolvedValue(null),
    getMetaValue: vi.fn().mockImplementation((key: string) => Promise.resolve(meta[key] ?? null)),
    setMetaValue: vi.fn().mockResolvedValue(undefined),
    loadArchive: vi.fn().mockResolvedValue(null),
    saveArchive: vi.fn().mockResolvedValue(undefined),
    appendLog: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    engine: 'sqlite' as const,
  });
}

describe('computeBriefing lessons index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockAccessor();
  });

  it('lists lessons as rules with a fetch pointer, without the why', async () => {
    mockListLessons.mockResolvedValue([
      {
        id: 'O-abc',
        rule: 'Run biome before every push',
        why: 'Two PRs went red on format',
        createdAt: '2026-10-23 10:00:00',
        scope: 'project',
      },
      {
        id: 'GO-def',
        rule: 'Never run unreleased source on the live store',
        why: 'Owner directive',
        createdAt: '2026-10-22 09:00:00',
        scope: 'global',
      },
    ]);

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(mockListLessons).toHaveBeenCalledWith(
      '/fake/project',
      expect.objectContaining({ scope: 'all', limit: 8 }),
    );
    expect(briefing.lessons).toEqual([
      {
        id: 'O-abc',
        rule: 'Run biome before every push',
        scope: 'project',
        date: '2026-10-23 10:00:00',
        _next: { fetch: 'cleo memory fetch O-abc' },
      },
      {
        id: 'GO-def',
        rule: 'Never run unreleased source on the live store',
        scope: 'global',
        date: '2026-10-22 09:00:00',
        _next: { fetch: 'cleo memory fetch GO-def' },
      },
    ]);
  });

  it('truncates a long rule and warns about a failing store (T14003)', async () => {
    mockListLessons.mockImplementation(
      async (
        _root: string,
        options: { onStoreError?: (store: 'project' | 'global', error: Error) => void },
      ) => {
        options.onStoreError?.('project', new Error('project brain locked'));
        return [
          {
            id: 'GO-long',
            rule: 'r'.repeat(400),
            why: '',
            createdAt: '2026-10-22 09:00:00',
            scope: 'global',
          },
        ];
      },
    );

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.lessons?.[0]?.rule.length).toBeLessThanOrEqual(240);
    expect(briefing.warnings).toContain(
      'Lessons unavailable from the project brain: project brain locked',
    );
  });

  it('omits lessons when there are none', async () => {
    mockListLessons.mockResolvedValue([]);

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.lessons).toBeUndefined();
  });

  it('warns instead of failing when lessons cannot be read', async () => {
    mockListLessons.mockRejectedValue(new Error('BRAIN database unavailable'));

    const briefing = await computeBriefing('/fake/project', { scope: 'global' });

    expect(briefing.lessons).toBeUndefined();
    expect(briefing.warnings).toContain('Lessons unavailable: BRAIN database unavailable');
  });
});
