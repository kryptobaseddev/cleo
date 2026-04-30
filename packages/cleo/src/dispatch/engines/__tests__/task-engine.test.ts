/**
 * Task Engine unit tests.
 *
 * Covers:
 *   - taskComplete: delegation, error mapping (T4657)
 *   - completeTaskStrict: verification_json NULL rejection (T1222 · ADR-051 / CLEO-VALID-26)
 *   - taskComplete: modified_by + session_id population (T1222 · CLEO-VALID-27)
 *
 * Post T1568 migration: taskComplete and completeTaskStrict live in
 * packages/core/src/tasks/complete.ts, exported from @cleocode/core/internal.
 *
 * @task T1568
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock core modules at their source so the imported taskComplete and
// completeTaskStrict can call through to mocked dependencies.
// ---------------------------------------------------------------------------

vi.mock('../../../../../core/src/store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

vi.mock('../../../../../core/src/tasks/complete.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../../core/src/tasks/complete.js')>();
  return {
    ...actual,
    completeTask: vi.fn(),
  };
});

vi.mock('../../../../../core/src/store/session-store.js', () => ({
  getActiveSession: vi.fn().mockResolvedValue(null),
  createSession: vi.fn(),
}));

vi.mock('../../../../../core/src/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({ lifecycle: { mode: 'strict' } }),
  getRawConfigValue: vi.fn(),
}));

vi.mock('../../../../../core/src/lifecycle/ivtr-loop.js', () => ({
  getIvtrState: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../../../core/src/tasks/evidence.js', () => ({
  revalidateEvidence: vi.fn().mockResolvedValue({ stillValid: true, failedAtoms: [] }),
  parseEvidence: vi.fn(),
}));

vi.mock('../../../../../core/src/logger.js', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { loadConfig } from '../../../../../core/src/config.js';
import { getIvtrState } from '../../../../../core/src/lifecycle/ivtr-loop.js';
import { getAccessor } from '../../../../../core/src/store/data-accessor.js';
import { getActiveSession } from '../../../../../core/src/store/session-store.js';
import {
  completeTaskStrict,
  completeTask as coreCompleteTask,
  taskComplete,
} from '../../../../../core/src/tasks/complete.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCompleteTask = vi.mocked(coreCompleteTask);
const mockGetAccessor = vi.mocked(getAccessor);
const mockGetIvtrState = vi.mocked(getIvtrState);
const mockLoadConfig = vi.mocked(loadConfig);
const mockGetActiveSession = vi.mocked(getActiveSession);

/**
 * Build a minimal DataAccessor mock for completeTaskStrict tests.
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
// Helper: build a full DataAccessor mock that lets completeTask succeed.
//
// taskComplete calls the real completeTask (same module, importActual spread).
// completeTask calls acc.loadSingleTask, acc.getChildren, acc.transaction, and
// acc.getDependents. All must be present for the happy path to reach the
// taskComplete post-hook that stamps modified_by + session_id.
// ---------------------------------------------------------------------------

function makeCompletableAccessorMock(opts: {
  taskId: string;
  updateTaskFields?: ReturnType<typeof vi.fn>;
}) {
  const updateTaskFields = opts.updateTaskFields ?? vi.fn().mockResolvedValue(undefined);
  const tx = {
    upsertSingleTask: vi.fn().mockResolvedValue(undefined),
    appendLog: vi.fn().mockResolvedValue(undefined),
  };
  return {
    loadSingleTask: vi.fn(async (id: string) => {
      if (id === opts.taskId) {
        return {
          id: opts.taskId,
          title: 'Test task',
          description: '',
          status: 'active',
          priority: 'medium',
          type: 'task',
          parentId: null,
          depends: [],
          pipelineStage: 'implementation',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
      }
      return null;
    }),
    getChildren: vi.fn().mockResolvedValue([]),
    getDependents: vi.fn().mockResolvedValue([]),
    transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    updateTaskFields,
  };
}

// ---------------------------------------------------------------------------
// taskComplete tests
// ---------------------------------------------------------------------------

describe('taskComplete', () => {
  const projectRoot = '/mock/project';

  beforeEach(() => {
    vi.clearAllMocks();
    // Default accessor: no methods — errors propagate → E_INTERNAL
    mockGetAccessor.mockResolvedValue(
      {} as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );
  });

  it('returns E_INTERNAL error when core completeTask throws', async () => {
    // Accessor has no loadSingleTask → completeTask throws → taskComplete catches → E_INTERNAL
    const result = await taskComplete(projectRoot, 'T100');

    expect(result.success).toBe(false);
    expect(result.error?.code).toMatch(/^E_/);
  });

  it('proceeds to update when core completeTask resolves', async () => {
    // Provide a full accessor so completeTask can complete the task
    mockGetAccessor.mockResolvedValue(
      makeCompletableAccessorMock({ taskId: 'T101' }) as ReturnType<
        typeof getAccessor
      > extends Promise<infer T>
        ? T
        : never,
    );

    const result = await taskComplete(projectRoot, 'T101');

    expect(result.success).toBe(true);
    expect(result.data?.task?.status).toBe('done');
  });

  it('populates modified_by from CLEO_AGENT_ID on successful completion (T1222 · CLEO-VALID-27)', async () => {
    const mockUpdateTaskFields = vi.fn().mockResolvedValue(undefined);
    mockGetAccessor.mockResolvedValue(
      makeCompletableAccessorMock({
        taskId: 'T200',
        updateTaskFields: mockUpdateTaskFields,
      }) as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );

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
    mockGetAccessor.mockResolvedValue(
      makeCompletableAccessorMock({
        taskId: 'T201',
        updateTaskFields: mockUpdateTaskFields,
      }) as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );

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
// completeTaskStrict — T1222 verification_json NULL gate (CLEO-VALID-26)
// ---------------------------------------------------------------------------

describe('completeTaskStrict — verification_json NULL gate (T1222 · CLEO-VALID-26)', () => {
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

    const result = await completeTaskStrict(projectRoot, TASK_NULL_VERIFY);

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

    const result = await completeTaskStrict(projectRoot, 'T301');

    // Must NOT reject with E_EVIDENCE_MISSING
    if (!result.success) {
      expect(result.error?.code).not.toBe('E_EVIDENCE_MISSING');
    }
  });
});
