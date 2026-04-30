/**
 * Tests for taskShowWithHistory — `cleo show <taskId> --history` surface.
 *
 * Verifies:
 * - Without the flag: data has `task` but no `history` key.
 * - With the flag: data has `task` + `history` array.
 * - Tasks with no pipeline record return `history: []` (not an error).
 *
 * @task T787
 * @epic T769
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @cleocode/core/internal so tests run without a real SQLite DB.
// ---------------------------------------------------------------------------

vi.mock('@cleocode/core/internal', () => ({
  getAccessor: vi.fn(),
  showTask: vi.fn(),
  getLifecycleStatus: vi.fn(),
  // Provide enough of the barrel so task-engine.ts can import without crashing.
  addTask: vi.fn(),
  archiveTasks: vi.fn(),
  completeTask: vi.fn(),
  deleteTask: vi.fn(),
  findTasks: vi.fn(),
  listTasks: vi.fn(),
  updateTask: vi.fn(),
  coreTaskNext: vi.fn(),
  coreTaskBlockers: vi.fn(),
  coreTaskTree: vi.fn(),
  coreTaskDeps: vi.fn(),
  coreTaskRelates: vi.fn(),
  coreTaskRelatesAdd: vi.fn(),
  coreTaskAnalyze: vi.fn(),
  coreTaskRestore: vi.fn(),
  coreTaskUnarchive: vi.fn(),
  coreTaskReorder: vi.fn(),
  coreTaskReparent: vi.fn(),
  coreTaskPromote: vi.fn(),
  coreTaskReopen: vi.fn(),
  coreTaskComplexityEstimate: vi.fn(),
  coreTaskDepends: vi.fn(),
  coreTaskStats: vi.fn(),
  coreTaskExport: vi.fn(),
  coreTaskHistory: vi.fn(),
  coreTaskLint: vi.fn(),
  coreTaskBatchValidate: vi.fn(),
  coreTaskImport: vi.fn(),
  coreTaskRelatesFind: vi.fn(),
  coreTaskCancel: vi.fn(),
  coreTaskDepsCycles: vi.fn(),
  coreTaskDepsOverview: vi.fn(),
  predictImpact: vi.fn(),
  getActiveSession: vi.fn(),
  toCompact: vi.fn(),
  computeTaskView: vi.fn(),
  getIvtrState: vi.fn(),
  taskToRecord: vi.fn((task: unknown) => task),
  toHistoryEntry: vi.fn(),
}));

import { showTask as coreShowTask, getAccessor, getLifecycleStatus } from '@cleocode/core/internal';
import { taskShowWithHistory } from '../task-engine.js';

const mockGetAccessor = vi.mocked(getAccessor);
const mockShowTask = vi.mocked(coreShowTask);
const mockGetLifecycleStatus = vi.mocked(getLifecycleStatus);

/** Minimal Task shape satisfying TaskRecord conversion. */
const MOCK_TASK = {
  id: 'T001',
  title: 'Test task',
  description: 'A test task',
  status: 'active' as const,
  priority: 'medium' as const,
  type: 'task' as const,
  phase: undefined,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  completedAt: null,
  cancelledAt: null,
  parentId: undefined,
  position: 0,
  positionVersion: 0,
  depends: [],
  relates: [],
  files: [],
  acceptance: [],
  notes: undefined,
  labels: [],
  size: null,
  epicLifecycle: null,
  noAutoComplete: null,
  verification: null,
  origin: null,
  cancellationReason: undefined,
  blockedBy: undefined,
  pipelineStage: null,
};

/** Minimal lifecycle status returned by getLifecycleStatus. */
const MOCK_LIFECYCLE_STATUS = {
  epicId: 'T001',
  title: 'Test task',
  currentStage: 'implementation' as const,
  stages: [
    {
      stage: 'research',
      status: 'completed',
      completedAt: '2026-01-01T10:00:00Z',
      outputFile: 'research.md',
    },
    {
      stage: 'specification',
      status: 'completed',
      completedAt: '2026-01-02T10:00:00Z',
      outputFile: null,
    },
    { stage: 'implementation', status: 'in_progress', completedAt: undefined, outputFile: null },
    { stage: 'testing', status: 'not_started', completedAt: undefined, outputFile: null },
    { stage: 'validation', status: 'not_started', completedAt: undefined, outputFile: null },
    { stage: 'deployment', status: 'not_started', completedAt: undefined, outputFile: null },
    { stage: 'contribution', status: 'not_started', completedAt: undefined, outputFile: null },
  ],
  nextStage: 'testing' as const,
  blockedOn: [],
  initialized: true,
};

describe('taskShowWithHistory', () => {
  const projectRoot = '/mock/project';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccessor.mockResolvedValue(
      {} as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );
    mockShowTask.mockResolvedValue(
      MOCK_TASK as ReturnType<typeof coreShowTask> extends Promise<infer T> ? T : never,
    );
  });

  describe('without --history flag', () => {
    it('returns success with task but no history key', async () => {
      const result = await taskShowWithHistory(projectRoot, 'T001', false);

      expect(result.success).toBe(true);
      expect(result.data?.task).toBeDefined();
      expect(result.data?.task.id).toBe('T001');
      // history key must be absent when flag is not set
      expect('history' in (result.data ?? {})).toBe(false);
      expect(mockGetLifecycleStatus).not.toHaveBeenCalled();
    });
  });

  describe('with --history flag', () => {
    it('returns success with task and history array when pipeline exists', async () => {
      mockGetLifecycleStatus.mockResolvedValue(
        MOCK_LIFECYCLE_STATUS as ReturnType<typeof getLifecycleStatus> extends Promise<infer T>
          ? T
          : never,
      );

      const result = await taskShowWithHistory(projectRoot, 'T001', true);

      expect(result.success).toBe(true);
      expect(result.data?.task).toBeDefined();
      expect(result.data?.task.id).toBe('T001');
      expect(Array.isArray(result.data?.history)).toBe(true);
      expect(mockGetLifecycleStatus).toHaveBeenCalledWith(projectRoot, { taskId: 'T001' });
    });

    it('history entries have the required shape', async () => {
      mockGetLifecycleStatus.mockResolvedValue(
        MOCK_LIFECYCLE_STATUS as ReturnType<typeof getLifecycleStatus> extends Promise<infer T>
          ? T
          : never,
      );

      const result = await taskShowWithHistory(projectRoot, 'T001', true);

      const history = result.data?.history ?? [];
      expect(history.length).toBeGreaterThan(0);

      for (const entry of history) {
        expect(typeof entry.stage).toBe('string');
        expect(['not_started', 'in_progress', 'completed', 'skipped', 'failed']).toContain(
          entry.status,
        );
        // startedAt is string|null
        expect(entry.startedAt === null || typeof entry.startedAt === 'string').toBe(true);
        // completedAt is string|null
        expect(entry.completedAt === null || typeof entry.completedAt === 'string').toBe(true);
        // outputFile is string|null
        expect(entry.outputFile === null || typeof entry.outputFile === 'string').toBe(true);
      }
    });

    it('maps completedAt and outputFile from lifecycle status', async () => {
      mockGetLifecycleStatus.mockResolvedValue(
        MOCK_LIFECYCLE_STATUS as ReturnType<typeof getLifecycleStatus> extends Promise<infer T>
          ? T
          : never,
      );

      const result = await taskShowWithHistory(projectRoot, 'T001', true);
      const history = result.data?.history ?? [];

      const researchEntry = history.find((e) => e.stage === 'research');
      expect(researchEntry).toBeDefined();
      expect(researchEntry?.status).toBe('completed');
      expect(researchEntry?.completedAt).toBe('2026-01-01T10:00:00Z');
      expect(researchEntry?.outputFile).toBe('research.md');

      const testingEntry = history.find((e) => e.stage === 'testing');
      expect(testingEntry).toBeDefined();
      expect(testingEntry?.status).toBe('not_started');
      expect(testingEntry?.completedAt).toBeNull();
      expect(testingEntry?.outputFile).toBeNull();
    });

    it('returns history: [] when task has no pipeline (not an error)', async () => {
      // Simulate getLifecycleStatus throwing (no pipeline record)
      mockGetLifecycleStatus.mockRejectedValue(new Error('No pipeline found for task T001'));

      const result = await taskShowWithHistory(projectRoot, 'T001', true);

      expect(result.success).toBe(true);
      expect(result.data?.task.id).toBe('T001');
      expect(result.data?.history).toEqual([]);
    });

    it('returns history: [] for uninitialized pipeline', async () => {
      // getLifecycleStatus returns initialized: false with default stage list
      mockGetLifecycleStatus.mockResolvedValue({
        epicId: 'T001',
        currentStage: null,
        stages: [
          { stage: 'research', status: 'not_started' },
          { stage: 'specification', status: 'not_started' },
        ],
        nextStage: 'research',
        blockedOn: [],
        initialized: false,
      } as ReturnType<typeof getLifecycleStatus> extends Promise<infer T> ? T : never);

      const result = await taskShowWithHistory(projectRoot, 'T001', true);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data?.history)).toBe(true);
      // Uninitialized pipeline still returns stage list with not_started statuses
      const history = result.data?.history ?? [];
      expect(history.every((e) => e.status === 'not_started')).toBe(true);
    });
  });
});
