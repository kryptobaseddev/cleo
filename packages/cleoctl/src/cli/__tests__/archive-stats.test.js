/**
 * Tests for archive analytics (core logic, invoked via CLI re-export).
 * @task T4555
 * @epic T4545
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeArchive } from '@cleocode/core/internal';
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
function createMockAccessor(archiveData = null) {
    return {
        engine: 'sqlite',
        loadArchive: vi.fn().mockResolvedValue(archiveData),
        close: vi.fn(),
        // Stub remaining DataAccessor methods — only loadArchive is used by analyzeArchive
        loadTaskFile: vi.fn(),
        saveTodoFile: vi.fn(),
        saveArchive: vi.fn(),
        loadSessions: vi.fn(),
        saveSessions: vi.fn(),
        loadSingleTask: vi.fn(),
        queryTasks: vi.fn(),
        getSubtree: vi.fn(),
        upsertTask: vi.fn(),
        deleteTask: vi.fn(),
        upsertSession: vi.fn(),
        deleteSession: vi.fn(),
        transaction: vi.fn(),
    };
}
describe('analyzeArchive', () => {
    let accessor;
    beforeEach(() => {
        vi.clearAllMocks();
        accessor = createMockAccessor(null);
    });
    it('returns empty result when no archive exists', async () => {
        const result = await analyzeArchive({}, accessor);
        expect(result.report).toBe('summary');
        expect(result.data.totalArchived).toBe(0);
    });
    it('returns summary by default', async () => {
        accessor = createMockAccessor(SAMPLE_ARCHIVE);
        const result = await analyzeArchive({}, accessor);
        expect(result.report).toBe('summary');
        const data = result.data;
        expect(data.totalArchived).toBe(3);
        expect(data.averageCycleTime).toBe(6);
    });
    it('returns by-phase report', async () => {
        accessor = createMockAccessor(SAMPLE_ARCHIVE);
        const result = await analyzeArchive({ report: 'by-phase' }, accessor);
        expect(result.report).toBe('by-phase');
        const data = result.data;
        expect(data.length).toBe(2);
        const alpha = data.find((d) => d.phase === 'alpha');
        expect(alpha?.count).toBe(2);
    });
    it('returns by-label report', async () => {
        accessor = createMockAccessor(SAMPLE_ARCHIVE);
        const result = await analyzeArchive({ report: 'by-label' }, accessor);
        expect(result.report).toBe('by-label');
        const data = result.data;
        const feature = data.find((d) => d.label === 'feature');
        expect(feature?.count).toBe(1);
    });
    it('returns by-priority report', async () => {
        accessor = createMockAccessor(SAMPLE_ARCHIVE);
        const result = await analyzeArchive({ report: 'by-priority' }, accessor);
        expect(result.report).toBe('by-priority');
        const data = result.data;
        expect(data.length).toBe(3);
    });
    it('returns cycle-times report with statistics', async () => {
        accessor = createMockAccessor(SAMPLE_ARCHIVE);
        const result = await analyzeArchive({ report: 'cycle-times' }, accessor);
        expect(result.report).toBe('cycle-times');
        const data = result.data;
        expect(data.count).toBe(3);
        expect(data.min).toBe(3);
        expect(data.max).toBe(10);
        expect(data.avg).toBe(6);
    });
    it('returns trends report', async () => {
        accessor = createMockAccessor(SAMPLE_ARCHIVE);
        const result = await analyzeArchive({ report: 'trends' }, accessor);
        expect(result.report).toBe('trends');
        const data = result.data;
        expect(data.totalPeriod).toBe(3);
        expect(data.byDay.length).toBe(3);
    });
    it('filters by since date', async () => {
        accessor = createMockAccessor(SAMPLE_ARCHIVE);
        const result = await analyzeArchive({ since: '2026-02-01' }, accessor);
        const data = result.data;
        expect(data.totalArchived).toBe(1);
    });
    it('filters by until date', async () => {
        accessor = createMockAccessor(SAMPLE_ARCHIVE);
        const result = await analyzeArchive({ until: '2026-01-20' }, accessor);
        const data = result.data;
        expect(data.totalArchived).toBe(2);
    });
    it('applies both since and until filters', async () => {
        accessor = createMockAccessor(SAMPLE_ARCHIVE);
        const result = await analyzeArchive({ since: '2026-01-16', until: '2026-01-25' }, accessor);
        const data = result.data;
        expect(data.totalArchived).toBe(1);
    });
});
//# sourceMappingURL=archive-stats.test.js.map