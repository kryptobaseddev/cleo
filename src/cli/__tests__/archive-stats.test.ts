/**
 * Tests for archive-stats CLI command core logic.
 * @task T4555
 * @epic T4545
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getArchiveStats } from '../commands/archive-stats.js';

// Mock the data accessor used by getArchiveStats
const mockLoadArchive = vi.fn();

vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn().mockResolvedValue({
    engine: 'sqlite',
    loadArchive: (...args: unknown[]) => mockLoadArchive(...args),
    close: vi.fn(),
  }),
}));

vi.mock('../../core/paths.js', () => ({
  getArchivePath: (cwd?: string) => '.cleo/tasks-archive.json',
  getCleoDirAbsolute: (cwd?: string) => cwd ? `${cwd}/.cleo` : '.cleo',
  getTaskPath: (cwd?: string) => cwd ? `${cwd}/.cleo/tasks.json` : '.cleo/tasks.json',
}));

const SAMPLE_ARCHIVE = {
  archivedTasks: [
    {
      id: 'T001',
      title: 'First task',
      status: 'done',
      priority: 'high',
      phase: 'alpha',
      labels: ['feature', 'cli'],
      _archive: {
        archivedAt: '2026-01-15T10:00:00Z',
        cycleTimeDays: 5,
        archiveSource: 'auto',
      },
    },
    {
      id: 'T002',
      title: 'Second task',
      status: 'done',
      priority: 'medium',
      phase: 'alpha',
      labels: ['bug'],
      _archive: {
        archivedAt: '2026-01-20T10:00:00Z',
        cycleTimeDays: 3,
        archiveSource: 'manual',
      },
    },
    {
      id: 'T003',
      title: 'Third task',
      status: 'cancelled',
      priority: 'low',
      phase: 'beta',
      labels: ['docs'],
      _archive: {
        archivedAt: '2026-02-01T10:00:00Z',
        cycleTimeDays: 10,
        archiveSource: 'auto',
      },
    },
  ],
};

describe('getArchiveStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result when no archive exists', async () => {
    mockLoadArchive.mockResolvedValue(null);
    const result = await getArchiveStats({});
    expect(result.report).toBe('summary');
    expect((result.data as Record<string, unknown>).totalArchived).toBe(0);
  });

  it('returns summary by default', async () => {
    mockLoadArchive.mockResolvedValue(SAMPLE_ARCHIVE);
    const result = await getArchiveStats({});
    expect(result.report).toBe('summary');

    const data = result.data as Record<string, unknown>;
    expect(data.totalArchived).toBe(3);
    expect(data.averageCycleTime).toBe(6);
  });

  it('returns by-phase report', async () => {
    mockLoadArchive.mockResolvedValue(SAMPLE_ARCHIVE);
    const result = await getArchiveStats({ report: 'by-phase' });
    expect(result.report).toBe('by-phase');

    const data = result.data as Array<Record<string, unknown>>;
    expect(data.length).toBe(2);
    const alpha = data.find(d => d.phase === 'alpha');
    expect(alpha?.count).toBe(2);
  });

  it('returns by-label report', async () => {
    mockLoadArchive.mockResolvedValue(SAMPLE_ARCHIVE);
    const result = await getArchiveStats({ report: 'by-label' });
    expect(result.report).toBe('by-label');

    const data = result.data as Array<{ label: string; count: number }>;
    const feature = data.find(d => d.label === 'feature');
    expect(feature?.count).toBe(1);
  });

  it('returns by-priority report', async () => {
    mockLoadArchive.mockResolvedValue(SAMPLE_ARCHIVE);
    const result = await getArchiveStats({ report: 'by-priority' });
    expect(result.report).toBe('by-priority');

    const data = result.data as Array<Record<string, unknown>>;
    expect(data.length).toBe(3);
  });

  it('returns cycle-times report with statistics', async () => {
    mockLoadArchive.mockResolvedValue(SAMPLE_ARCHIVE);
    const result = await getArchiveStats({ report: 'cycle-times' });
    expect(result.report).toBe('cycle-times');

    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(3);
    expect(data.min).toBe(3);
    expect(data.max).toBe(10);
    expect(data.avg).toBe(6);
  });

  it('returns trends report', async () => {
    mockLoadArchive.mockResolvedValue(SAMPLE_ARCHIVE);
    const result = await getArchiveStats({ report: 'trends' });
    expect(result.report).toBe('trends');

    const data = result.data as Record<string, unknown>;
    expect(data.totalPeriod).toBe(3);
    expect((data.byDay as unknown[]).length).toBe(3);
  });

  it('filters by since date', async () => {
    mockLoadArchive.mockResolvedValue(SAMPLE_ARCHIVE);
    const result = await getArchiveStats({ since: '2026-02-01' });
    const data = result.data as Record<string, unknown>;
    expect(data.totalArchived).toBe(1);
  });

  it('filters by until date', async () => {
    mockLoadArchive.mockResolvedValue(SAMPLE_ARCHIVE);
    const result = await getArchiveStats({ until: '2026-01-20' });
    const data = result.data as Record<string, unknown>;
    expect(data.totalArchived).toBe(2);
  });

  it('applies both since and until filters', async () => {
    mockLoadArchive.mockResolvedValue(SAMPLE_ARCHIVE);
    const result = await getArchiveStats({ since: '2026-01-16', until: '2026-01-25' });
    const data = result.data as Record<string, unknown>;
    expect(data.totalArchived).toBe(1);
  });
});
