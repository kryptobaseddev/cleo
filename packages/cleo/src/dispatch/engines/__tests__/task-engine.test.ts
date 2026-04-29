/**
 * Task Engine unit tests.
 *
 * Covers:
 *   - taskComplete: delegation, error mapping (T4657)
 *   - taskCompleteStrict: verification_json NULL rejection (T1222 · ADR-051 / CLEO-VALID-26)
 *   - taskCompleteStrict: modified_by + session_id population (T1222 · CLEO-VALID-27)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// @cleocode/core/internal mock — covers all internal imports used by task-engine.ts.
// Declared first so vitest hoisting works correctly.
// ---------------------------------------------------------------------------
vi.mock('@cleocode/core/internal', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    getAccessor: vi.fn(),
    getIvtrState: vi.fn(),
    showTask: vi.fn(),
    getLifecycleStatus: vi.fn(),
    loadConfig: vi.fn().mockResolvedValue({ lifecycle: { mode: 'strict' } }),
    getLogger: vi.fn(() => mockLogger),
    getActiveSession: vi.fn().mockResolvedValue(null),
    // Full barrel stubs
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
    coreTaskCancel: vi.fn(),
    coreTaskDepsCycles: vi.fn(),
    coreTaskDepsOverview: vi.fn(),
    predictImpact: vi.fn(),
    toCompact: vi.fn(),
    computeTaskView: vi.fn(),
    revalidateEvidence: vi.fn().mockResolvedValue({ stillValid: true, failedAtoms: [] }),
  };
});

// ---------------------------------------------------------------------------
// @cleocode/core mock — used by the existing taskComplete tests.
//
// We use importOriginal() so canonical helpers (`engineError`, `engineSuccess`,
// `EngineResult` type, …) remain real — `_error.ts` re-exports them and the
// engine's catch-boundary calls `engineError` to build typed failure results.
// Only side-effecting domain functions are stubbed.
// ---------------------------------------------------------------------------
vi.mock('@cleocode/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core')>();
  return {
    ...actual,
    getLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
    completeTask: vi.fn(),
    getAccessor: vi.fn(),
    showTask: vi.fn(),
    updateTask: vi.fn(),
    getActiveSession: vi.fn().mockResolvedValue(null),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  completeTask as coreCompleteTask,
  getAccessor,
  getActiveSession,
  getIvtrState,
  loadConfig,
} from '@cleocode/core/internal';
import { taskComplete, taskCompleteStrict } from '../task-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCompleteTask = vi.mocked(coreCompleteTask);
const mockGetAccessor = vi.mocked(getAccessor);
const mockGetIvtrState = vi.mocked(getIvtrState);
const mockLoadConfig = vi.mocked(loadConfig);
const mockGetActiveSession = vi.mocked(getActiveSession);

/**
 * Build a minimal DataAccessor mock for taskCompleteStrict tests.
 *
 * @param opts.verification - null simulates verification_json IS NULL in the DB
 */
function makeStrictAccessorMock(opts: {
  taskId: string;
  verification?: Record<string, unknown> | null;
  updateTaskFields?: ReturnType<typeof vi.fn>;
}) {
  const updateTaskFields = opts.updateTaskFields ?? vi.fn().mockResolvedValue(undefined);
  return {
    loadSingleTask: vi.fn(async (id: string) => {
      if (id === opts.taskId) {
        return {
          id: opts.taskId,
          title: 'Strict task',
          description: '',
          status: 'active',
          priority: 'medium',
          type: 'task',
          parentId: null,
          verification: opts.verification ?? null,
          pipelineStage: 'implementation',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
      }
      return null;
    }),
    updateTaskFields,
    upsertSingleTask: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// taskComplete tests
// ---------------------------------------------------------------------------

describe('taskComplete', () => {
  const projectRoot = '/mock/project';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccessor.mockResolvedValue(
      {} as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );
  });

  it('returns E_TASK_COMPLETED (exitCode 17) when task is already done', async () => {
    const alreadyDoneErr = new Error('Task T100 is already completed');
    (alreadyDoneErr as Error & { code: number }).code = 17;
    mockCompleteTask.mockRejectedValue(alreadyDoneErr);

    const result = await taskComplete(projectRoot, 'T100');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_TASK_COMPLETED');
    expect(result.error?.message).toContain('already completed');
  });

  it('proceeds to update when task is not yet done', async () => {
    mockCompleteTask.mockResolvedValue({
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
    } as ReturnType<typeof coreCompleteTask> extends Promise<infer T> ? T : never);

    const result = await taskComplete(projectRoot, 'T101');

    expect(result.success).toBe(true);
    expect(result.data?.task?.status).toBe('done');
    expect(mockCompleteTask).toHaveBeenCalled();
  });

  it('returns E_NOT_FOUND with exitCode 4 when task does not exist', async () => {
    const notFoundErr = new Error('Task not found: T999');
    (notFoundErr as Error & { code: number }).code = 4;
    mockCompleteTask.mockRejectedValue(notFoundErr);

    const result = await taskComplete(projectRoot, 'T999');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND');
    expect(result.error?.exitCode).toBe(4);
  });

  it('populates modified_by from CLEO_AGENT_ID on successful completion (T1222 · CLEO-VALID-27)', async () => {
    const mockUpdateTaskFields = vi.fn().mockResolvedValue(undefined);
    mockGetAccessor.mockResolvedValue({
      updateTaskFields: mockUpdateTaskFields,
    } as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never);

    mockCompleteTask.mockResolvedValue({
      task: {
        id: 'T200',
        title: 'Test task',
        description: '',
        status: 'done',
        priority: 'medium',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        completedAt: '2026-01-02T00:00:00Z',
      },
    } as ReturnType<typeof coreCompleteTask> extends Promise<infer T> ? T : never);

    const agentId = 'test-agent-T1222';
    const originalAgentId = process.env['CLEO_AGENT_ID'];
    process.env['CLEO_AGENT_ID'] = agentId;

    try {
      const result = await taskComplete(projectRoot, 'T200');

      expect(result.success).toBe(true);
      // modified_by MUST be written via updateTaskFields on every successful completion
      expect(mockUpdateTaskFields).toHaveBeenCalledWith(
        'T200',
        expect.objectContaining({ modifiedBy: agentId }),
      );
    } finally {
      if (originalAgentId === undefined) {
        delete process.env['CLEO_AGENT_ID'];
      } else {
        process.env['CLEO_AGENT_ID'] = originalAgentId;
      }
    }
  });

  it('populates session_id from active session on successful completion (T1222 · CLEO-VALID-27)', async () => {
    const mockUpdateTaskFields = vi.fn().mockResolvedValue(undefined);
    mockGetAccessor.mockResolvedValue({
      updateTaskFields: mockUpdateTaskFields,
    } as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never);

    mockCompleteTask.mockResolvedValue({
      task: {
        id: 'T201',
        title: 'Session task',
        description: '',
        status: 'done',
        priority: 'medium',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        completedAt: '2026-01-02T00:00:00Z',
      },
    } as ReturnType<typeof coreCompleteTask> extends Promise<infer T> ? T : never);

    const sessionId = 'ses_20260424_test_session';
    mockGetActiveSession.mockResolvedValue({
      id: sessionId,
      status: 'active',
      startedAt: '2026-01-01T00:00:00Z',
    } as ReturnType<typeof getActiveSession> extends Promise<infer T> ? Exclude<T, null> : never);

    const result = await taskComplete(projectRoot, 'T201');

    expect(result.success).toBe(true);
    // session_id MUST be written via updateTaskFields on every successful completion
    expect(mockUpdateTaskFields).toHaveBeenCalledWith(
      'T201',
      expect.objectContaining({ sessionId }),
    );
  });
});

// ---------------------------------------------------------------------------
// taskCompleteStrict — T1222 verification_json NULL gate (CLEO-VALID-26)
// ---------------------------------------------------------------------------

describe('taskCompleteStrict — verification_json NULL gate (T1222 · CLEO-VALID-26)', () => {
  const projectRoot = '/mock/project/strict';
  const TASK_NULL_VERIFY = 'T300';

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: strict mode, no IVTR state
    mockLoadConfig.mockResolvedValue({
      lifecycle: { mode: 'strict' },
    } as ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never);
    mockGetIvtrState.mockResolvedValue(null);
    mockGetActiveSession.mockResolvedValue(null);
  });

  it('rejects with E_EVIDENCE_MISSING when task.verification is null (verification_json IS NULL)', async () => {
    mockGetAccessor.mockResolvedValue(
      makeStrictAccessorMock({
        taskId: TASK_NULL_VERIFY,
        verification: null,
      }) as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );

    const result = await taskCompleteStrict(projectRoot, TASK_NULL_VERIFY);

    // Must reject with the canonical E_EVIDENCE_MISSING code (ADR-051)
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_EVIDENCE_MISSING');
    expect(result.error?.message).toContain(TASK_NULL_VERIFY);
    expect(result.error?.fix).toContain('cleo verify');
  });

  it('allows completion through when task.verification is populated', async () => {
    mockGetAccessor.mockResolvedValue(
      makeStrictAccessorMock({
        taskId: 'T301',
        verification: {
          passed: true,
          round: 1,
          gates: { implemented: true, testsPassed: true, qaPassed: true },
          evidence: {},
          failureLog: [],
        },
      }) as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );

    // completeTask delegate — mock success so it doesn't throw
    mockCompleteTask.mockResolvedValue({
      task: {
        id: 'T301',
        title: 'Strict task',
        description: '',
        status: 'done',
        priority: 'medium',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        completedAt: '2026-01-02T00:00:00Z',
      },
    } as ReturnType<typeof coreCompleteTask> extends Promise<infer T> ? T : never);

    const result = await taskCompleteStrict(projectRoot, 'T301');

    // Must NOT reject with E_EVIDENCE_MISSING
    if (!result.success) {
      expect(result.error?.code).not.toBe('E_EVIDENCE_MISSING');
    }
  });
});
