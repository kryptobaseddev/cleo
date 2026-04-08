/**
 * Tests for FIX-1.5 (T374): CleoError rich envelope propagation through engine catch blocks.
 *
 * Verifies that `cleoErrorToEngineError` correctly forwards .fix, .details,
 * and .alternatives from caught CleoError instances, and that task-engine
 * catch blocks now surface those fields end-to-end.
 *
 * @task T374
 * @epic T335
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock core modules before importing task-engine (same pattern as task-engine.test.ts)
// ---------------------------------------------------------------------------

vi.mock('../../../../../core/src/store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

vi.mock('../../../../../core/src/tasks/show.js', () => ({
  showTask: vi.fn(),
}));

vi.mock('../../../../../core/src/tasks/update.js', () => ({
  updateTask: vi.fn(),
}));

vi.mock('../../../../../core/src/tasks/complete.js', () => ({
  completeTask: vi.fn(),
}));

vi.mock('../../../../../core/src/tasks/add.js', () => ({
  addTask: vi.fn(),
}));

vi.mock('../../../../../core/src/tasks/delete.js', () => ({
  deleteTask: vi.fn(),
}));

vi.mock('../../../../../core/src/tasks/archive.js', () => ({
  archiveTasks: vi.fn(),
}));

vi.mock('../../../../../core/src/tasks/list.js', () => ({
  listTasks: vi.fn(),
}));

vi.mock('../../../../../core/src/tasks/find.js', () => ({
  findTasks: vi.fn(),
}));

vi.mock('../../../../../core/src/tasks/task-ops.js', () => ({
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
  predictImpact: vi.fn(),
  toCompact: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { completeTask as coreCompleteTask, getAccessor, showTask } from '@cleocode/core';
import { cleoErrorToEngineError } from '../_error.js';
import { taskComplete, taskShow } from '../task-engine.js';

const mockShowTask = vi.mocked(showTask);
const mockCompleteTask = vi.mocked(coreCompleteTask);
const mockGetAccessor = vi.mocked(getAccessor);

// ---------------------------------------------------------------------------
// Helper: build a CleoError-shaped object (structural type, avoids circular dep)
// ---------------------------------------------------------------------------

function makeCleoError(
  numericCode: number,
  message: string,
  options?: {
    fix?: string;
    details?: Record<string, unknown>;
    alternatives?: Array<{ action: string; command: string }>;
  },
): Error & {
  code: number;
  fix?: string;
  details?: Record<string, unknown>;
  alternatives?: Array<{ action: string; command: string }>;
} {
  const err = new Error(message) as Error & {
    code: number;
    fix?: string;
    details?: Record<string, unknown>;
    alternatives?: Array<{ action: string; command: string }>;
  };
  err.code = numericCode;
  if (options?.fix !== undefined) err.fix = options.fix;
  if (options?.details !== undefined) err.details = options.details;
  if (options?.alternatives !== undefined) err.alternatives = options.alternatives;
  return err;
}

// ---------------------------------------------------------------------------
// Unit tests for cleoErrorToEngineError helper
// ---------------------------------------------------------------------------

describe('cleoErrorToEngineError', () => {
  it('forwards fix, details, and alternatives from a full CleoError', () => {
    const err = makeCleoError(4, 'Task T999 not found', {
      fix: "Use 'cleo find T999' to search",
      details: { taskId: 'T999', scope: 'global' },
      alternatives: [{ action: 'search', command: 'cleo find T999' }],
    });

    const result = cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'fallback');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND'); // numeric 4 → 'E_NOT_FOUND'
    expect(result.error?.message).toBe('Task T999 not found');
    expect(result.error?.fix).toBe("Use 'cleo find T999' to search");
    expect(result.error?.details).toEqual({ taskId: 'T999', scope: 'global' });
    expect(result.error?.alternatives).toEqual([{ action: 'search', command: 'cleo find T999' }]);
  });

  it('includes only fix when alternatives and details are absent', () => {
    const err = makeCleoError(4, 'Not found', {
      fix: 'cleo find <query>',
    });

    const result = cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'fallback');

    expect(result.success).toBe(false);
    expect(result.error?.fix).toBe('cleo find <query>');
    expect(result.error?.alternatives).toBeUndefined();
    expect(result.error?.details).toBeUndefined();
  });

  it('uses fallback code and message for a plain Error with no code', () => {
    const err = new Error('Something went wrong');

    const result = cleoErrorToEngineError(
      err,
      'E_NOT_INITIALIZED',
      'Task database not initialized',
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_INITIALIZED');
    expect(result.error?.message).toBe('Something went wrong'); // message comes from err
    expect(result.error?.fix).toBeUndefined();
    expect(result.error?.alternatives).toBeUndefined();
    expect(result.error?.details).toBeUndefined();
  });

  it('uses fallback message when err.message is absent', () => {
    // Some non-Error throws don't have a message
    const result = cleoErrorToEngineError({}, 'E_GENERAL', 'Operation failed');

    expect(result.error?.message).toBe('Operation failed');
  });

  it('maps all known numeric exit codes to their canonical string codes', () => {
    // Spot check a few important mappings
    const cases: Array<[number, string]> = [
      [2, 'E_INVALID_INPUT'],
      [4, 'E_NOT_FOUND'],
      [6, 'E_VALIDATION'],
      [10, 'E_PARENT_NOT_FOUND'],
      [14, 'E_CIRCULAR_DEP'],
      [30, 'E_SESSION_EXISTS'],
      [31, 'E_SESSION_NOT_FOUND'],
    ];

    for (const [numericCode, expectedStringCode] of cases) {
      const err = makeCleoError(numericCode, `Error with code ${numericCode}`);
      const result = cleoErrorToEngineError(err, 'E_FALLBACK', 'fallback message');
      expect(result.error?.code, `code ${numericCode}`).toBe(expectedStringCode);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: taskShow propagates CleoError envelope
// ---------------------------------------------------------------------------

describe('taskShow end-to-end CleoError propagation', () => {
  const projectRoot = '/mock/project';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccessor.mockResolvedValue(
      {} as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );
  });

  it('propagates fix and alternatives when showTask throws a CleoError', async () => {
    const richErr = makeCleoError(4, "Task 'T999' not found", {
      fix: "Use 'cleo find' to search for tasks",
      alternatives: [
        { action: 'Search by text', command: 'cleo find "T999"' },
        { action: 'List all tasks', command: 'cleo list' },
      ],
    });
    mockShowTask.mockRejectedValue(richErr);

    const result = await taskShow(projectRoot, 'T999');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND');
    expect(result.error?.fix).toBe("Use 'cleo find' to search for tasks");
    expect(result.error?.alternatives).toHaveLength(2);
    expect(result.error?.alternatives?.[0]).toEqual({
      action: 'Search by text',
      command: 'cleo find "T999"',
    });
  });

  it('returns undefined fix/alternatives when showTask throws a plain Error', async () => {
    const plainErr = new Error('Database connection failed');
    mockShowTask.mockRejectedValue(plainErr);

    const result = await taskShow(projectRoot, 'T888');

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Database connection failed');
    expect(result.error?.fix).toBeUndefined();
    expect(result.error?.alternatives).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: taskComplete propagates CleoError envelope
// ---------------------------------------------------------------------------

describe('taskComplete end-to-end CleoError propagation', () => {
  const projectRoot = '/mock/project';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccessor.mockResolvedValue(
      {} as ReturnType<typeof getAccessor> extends Promise<infer T> ? T : never,
    );
  });

  it('propagates fix from a lifecycle gate failure CleoError', async () => {
    const gateErr = makeCleoError(80, 'Lifecycle gate failed: missing audit', {
      fix: 'Run cleo audit before completing',
      alternatives: [{ action: 'Run audit', command: 'cleo audit T555' }],
    });
    mockCompleteTask.mockRejectedValue(gateErr);

    const result = await taskComplete(projectRoot, 'T555');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_LIFECYCLE_GATE_FAILED');
    expect(result.error?.fix).toBe('Run cleo audit before completing');
    expect(result.error?.alternatives).toHaveLength(1);
  });

  it('propagates fix from a dependency error CleoError', async () => {
    const depErr = makeCleoError(5, 'Unresolved dependencies: T100, T200', {
      fix: 'Complete blocking tasks first',
      alternatives: [
        { action: 'Show blockers', command: 'cleo blockers T555' },
        { action: 'Show dependency tree', command: 'cleo deps T555' },
      ],
    });
    mockCompleteTask.mockRejectedValue(depErr);

    const result = await taskComplete(projectRoot, 'T555');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_DEPENDENCY');
    expect(result.error?.fix).toBe('Complete blocking tasks first');
    expect(result.error?.alternatives).toHaveLength(2);
  });
});
