import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock core modules before importing task-engine
vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

vi.mock('../../../core/tasks/show.js', () => ({
  showTask: vi.fn(),
}));

vi.mock('../../../core/tasks/update.js', () => ({
  updateTask: vi.fn(),
}));

vi.mock('../../../core/tasks/add.js', () => ({
  addTask: vi.fn(),
}));

vi.mock('../../../core/tasks/delete.js', () => ({
  deleteTask: vi.fn(),
}));

vi.mock('../../../core/tasks/archive.js', () => ({
  archiveTasks: vi.fn(),
}));

vi.mock('../../../core/tasks/list.js', () => ({
  listTasks: vi.fn(),
}));

vi.mock('../../../core/tasks/find.js', () => ({
  findTasks: vi.fn(),
}));

vi.mock('../../../core/tasks/task-ops.js', () => ({
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
}));

import { taskComplete } from '../task-engine.js';
import { showTask } from '../../../core/tasks/show.js';
import { updateTask } from '../../../core/tasks/update.js';
import { getAccessor } from '../../../store/data-accessor.js';

const mockShowTask = vi.mocked(showTask);
const mockUpdateTask = vi.mocked(updateTask);
const mockGetAccessor = vi.mocked(getAccessor);

describe('taskComplete', () => {
  const projectRoot = '/mock/project';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccessor.mockResolvedValue({} as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never);
  });

  it('returns E_TASK_COMPLETED (exitCode 104) when task is already done', async () => {
    mockShowTask.mockResolvedValue({
      id: 'T100',
      title: 'Test task',
      description: 'A test task',
      status: 'done',
      priority: 'medium',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      completedAt: '2026-01-02T00:00:00Z',
    } as ReturnType<typeof showTask> extends Promise<infer T> ? T : never);

    const result = await taskComplete(projectRoot, 'T100');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_TASK_COMPLETED');
    expect(result.error?.exitCode).toBe(104);
    expect(result.error?.message).toContain('already completed');
    // Should NOT have called updateTask
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it('proceeds to update when task is not yet done', async () => {
    mockShowTask.mockResolvedValue({
      id: 'T101',
      title: 'Pending task',
      description: 'A pending task',
      status: 'active',
      priority: 'medium',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    } as ReturnType<typeof showTask> extends Promise<infer T> ? T : never);

    mockUpdateTask.mockResolvedValue({
      task: {
        id: 'T101',
        title: 'Pending task',
        description: 'A pending task',
        status: 'done',
        priority: 'medium',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        completedAt: '2026-01-02T00:00:00Z',
      },
      changes: ['status: active → done'],
    } as ReturnType<typeof updateTask> extends Promise<infer T> ? T : never);

    const result = await taskComplete(projectRoot, 'T101');

    expect(result.success).toBe(true);
    expect(result.data?.task?.status).toBe('done');
    expect(mockUpdateTask).toHaveBeenCalled();
  });

  it('returns E_NOT_FOUND with exitCode 4 when task does not exist', async () => {
    const notFoundErr = new Error("Task 'T999' not found") as Error & { code: number };
    notFoundErr.code = 4;

    // taskShow catches the error internally and returns { success: false }
    mockShowTask.mockRejectedValue(notFoundErr);

    // taskUpdate also throws NOT_FOUND since the task doesn't exist
    mockUpdateTask.mockRejectedValue(notFoundErr);

    const result = await taskComplete(projectRoot, 'T999');

    // taskShow returns success:false (not done), then taskUpdate throws NOT_FOUND
    // which gets caught and returned with exitCode: 4
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND');
    expect(result.error?.exitCode).toBe(4);
  });
});
