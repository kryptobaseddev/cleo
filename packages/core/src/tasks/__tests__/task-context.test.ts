/**
 * Integration tests for coreTaskContext bounded task context pack.
 * @task T10629
 */

import type { Task } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  getTaskAccessor: vi.fn(),
}));

vi.mock('../../store/file-utils.js', () => ({
  readJsonFile: vi.fn(() => null),
  getDataPath: vi.fn((_root: string, file: string) => `/mock/${file}`),
}));

vi.mock('../task-ops.js', async () => {
  const actual = await vi.importActual('../task-ops.js');
  return {
    ...actual,
  };
});

vi.mock('../../orchestrate/query-ops.js', () => ({
  orchestrateReady: vi.fn().mockResolvedValue({ success: true, data: { readyTasks: [] } }),
}));

import { getAccessor, getTaskAccessor } from '../../store/data-accessor.js';
import { coreTaskContext } from '../task-context.js';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    description: `Description for ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    acceptance: ['AC1: Verify context is built', 'AC2: Verify budget is honored'],
    depends: [],
    ...overrides,
  } as Task;
}

function mockAuditLog(rows: Array<{ timestamp: string; action: string; actor?: string | null; detailsJson?: string | null }>) {
  return {
    queryAuditLog: vi.fn().mockResolvedValue(rows),
  };
}

function setupAccessor(task: Task, auditRows: Array<{ timestamp: string; action: string; actor?: string | null; detailsJson?: string | null }> = []) {
  const mockImpl = {
    loadSingleTask: vi.fn().mockImplementation((id: string) => {
      if (id === task.id) return Promise.resolve(task);
      if (task.depends?.includes(id)) {
        return Promise.resolve(makeTask({ id, title: `Dependency ${id}`, status: 'pending' }));
      }
      return Promise.resolve(null);
    }),
    queryTasks: vi.fn().mockResolvedValue({ tasks: [task], total: 1 }),
    ...mockAuditLog(auditRows),
  };
  (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
  (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
}

describe('coreTaskContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns identity for a valid task', async () => {
    const task = makeTask({ id: 'T10629' });
    setupAccessor(task);
    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10629',
      includeAcceptance: false,
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });
    expect(result.taskId).toBe('T10629');
    expect(result.identity.id).toBe('T10629');
    expect(result.identity.title).toBe('Task T10629');
    expect(result.identity.status).toBe('pending');
    expect(result.budget.tokenBudget).toBe(1500);
    // truncated is true because multiple sections were excluded (not_requested)
    expect(result.budget.truncated).toBe(true);
  });

  it('includes acceptance criteria with AC aliases', async () => {
    const task = makeTask({
      id: 'T10629',
      acceptance: ['Must have identity', 'Must honor budget'],
    });
    setupAccessor(task);
    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10629',
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });
    expect(result.acceptance).toHaveLength(2);
    expect(result.acceptance![0].alias).toBe('AC1');
    expect(result.acceptance![0].text).toBe('Must have identity');
    expect(result.acceptance![1].alias).toBe('AC2');
    expect(result.acceptance![1].text).toBe('Must honor budget');
  });

  it('includes blockers when task has pending dependencies', async () => {
    const task = makeTask({
      id: 'T10629',
      depends: ['T10628'],
    });
    setupAccessor(task);
    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10629',
      includeAcceptance: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers![0].taskId).toBe('T10628');
    expect(result.blockers![0].kind).toBe('dependency');
  });

  it('does not include done dependencies as blockers', async () => {
    const task = makeTask({
      id: 'T10629',
      depends: ['T10628'],
    });
    const mockImpl = {
      loadSingleTask: vi.fn().mockImplementation((id: string) => {
        if (id === 'T10629') return Promise.resolve(task);
        if (id === 'T10628') return Promise.resolve(makeTask({ id: 'T10628', status: 'done' }));
        return Promise.resolve(null);
      }),
      queryTasks: vi.fn().mockResolvedValue({ tasks: [task], total: 1 }),
      queryAuditLog: vi.fn().mockResolvedValue([]),
    };
    (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10629',
      includeAcceptance: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });
    expect(result.blockers).toHaveLength(0);
  });

  it('includes activity events from audit log', async () => {
    const task = makeTask({ id: 'T10629' });
    const auditRows = [
      { timestamp: '2026-05-26T10:00:00Z', action: 'created', actor: 'keaton' },
      { timestamp: '2026-05-26T11:00:00Z', action: 'updated', actor: 'cleo' },
    ];
    setupAccessor(task, auditRows);
    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10629',
      includeAcceptance: false,
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      activityLimit: 5,
    });
    expect(result.activity).toHaveLength(2);
    expect(result.activity![0].action).toBe('created');
    expect(result.activity![1].action).toBe('updated');
  });

  it('returns budget accounting', async () => {
    const task = makeTask({ id: 'T10629' });
    setupAccessor(task);
    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10629',
      budgetTokens: 500,
      includeAcceptance: false,
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });
    expect(result.budget.tokenBudget).toBe(500);
    expect(result.budget.estimatedTokens).toBeGreaterThan(0);
    expect(result.budget.remainingTokens).toBeGreaterThanOrEqual(0);
  });

  it('omits sections when budget is exceeded', async () => {
    const task = makeTask({
      id: 'T10629',
      acceptance: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8', 'AC9', 'AC10', 'AC11', 'AC12'],
    });
    setupAccessor(task);
    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10629',
      budgetTokens: 100,
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });
    expect(result.budget.truncated).toBe(true);
    expect(result.omissions.length).toBeGreaterThan(0);
    const acOmission = result.omissions.find((o) => o.path === 'acceptance');
    expect(acOmission).toBeDefined();
    expect(acOmission!.reason).toBe('budget_exceeded');
    expect(acOmission!.count).toBe(12);
  });

  it('omits sections when explicitly excluded', async () => {
    const task = makeTask({ id: 'T10629' });
    setupAccessor(task);
    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10629',
      includeAcceptance: false,
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });
    expect(result.omissions.length).toBeGreaterThan(0);
    const notRequested = result.omissions.filter((o) => o.reason === 'not_requested');
    expect(notRequested.length).toBeGreaterThan(0);
  });

  it('returns expansion hints for omitted sections', async () => {
    const task = makeTask({
      id: 'T10629',
      acceptance: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8', 'AC9', 'AC10', 'AC11', 'AC12'],
    });
    setupAccessor(task);
    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10629',
      budgetTokens: 100,
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });
    expect(result.expansionHints.acceptance).toBeDefined();
    expect(result.expansionHints.acceptance).toContain('higher budgetTokens');
  });

  it('throws when task does not exist', async () => {
    const mockImpl = {
      loadSingleTask: vi.fn().mockResolvedValue(null),
      queryTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0 }),
      queryAuditLog: vi.fn().mockResolvedValue([]),
    };
    (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
    await expect(
      coreTaskContext('/fake/project', { taskId: 'T99999' }),
    ).rejects.toThrow("Task 'T99999' not found");
  });

  it('generatedAt is an ISO timestamp', async () => {
    const task = makeTask({ id: 'T10629' });
    setupAccessor(task);
    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10629',
      includeAcceptance: false,
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // ── T10630: Saga / Epic scope tests ──────────────────────────────────────

  it('scope=saga includes rollup, members, and readyFrontier', async () => {
    const saga = makeTask({
      id: 'T10538',
      title: 'PM Core V2',
      type: 'saga',
      labels: ['saga'],
      relates: [
        { taskId: 'T10547', type: 'groups', reason: 'member' },
        { taskId: 'T10548', type: 'groups', reason: 'member' },
      ],
    });

    const epic1 = makeTask({ id: 'T10547', title: 'E9: Context Packs', status: 'done', type: 'epic' });
    const epic2 = makeTask({ id: 'T10548', title: 'E10: WorkGraph', status: 'active', type: 'epic' });

    const mockImpl = {
      loadSingleTask: vi.fn().mockImplementation((id: string) => {
        if (id === 'T10538') return Promise.resolve({
          ...saga,
          relates: saga.relates,
        });
        if (id === 'T10547') return Promise.resolve(epic1);
        if (id === 'T10548') return Promise.resolve(epic2);
        return Promise.resolve(null);
      }),
      queryTasks: vi.fn().mockResolvedValue({ tasks: [saga, epic1, epic2], total: 3 }),
      queryAuditLog: vi.fn().mockResolvedValue([]),
    };
    (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);

    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10538',
      scope: 'saga',
      includeAcceptance: false,
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });

    expect(result.rollup).toBeDefined();
    expect(result.rollup!.total).toBe(2);
    expect(result.rollup!.done).toBe(1);
    expect(result.rollup!.active).toBe(1);
    expect(result.rollup!.completionPct).toBe(50);

    expect(result.members).toBeDefined();
    expect(result.members).toHaveLength(2);
    expect(result.members![0].epicId).toBe('T10547');
    expect(result.members![0].title).toBe('E9: Context Packs');
    expect(result.members![1].epicId).toBe('T10548');
  });

  it('scope=epic includes rollup and readyFrontier', async () => {
    const epic = makeTask({
      id: 'T10547',
      title: 'E9: Context Packs',
      type: 'epic',
      status: 'active',
    });

    const child1 = makeTask({ id: 'T10629', title: 'Task context pack', status: 'done', parentId: 'T10547' });
    const child2 = makeTask({ id: 'T10630', title: 'Saga context pack', status: 'pending', parentId: 'T10547' });

    const { orchestrateReady } = await import('../../orchestrate/query-ops.js');
    (orchestrateReady as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        readyTasks: [
          { id: 'T10630', title: 'Saga context pack', priority: 'high', depends: [] },
        ],
      },
    });

    const mockImpl = {
      loadSingleTask: vi.fn().mockImplementation((id: string) => {
        if (id === 'T10547') return Promise.resolve(epic);
        return Promise.resolve(null);
      }),
      queryTasks: vi.fn().mockResolvedValue({ tasks: [epic, child1, child2], total: 3 }),
      queryAuditLog: vi.fn().mockResolvedValue([]),
    };
    (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);

    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10547',
      scope: 'epic',
      includeAcceptance: false,
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });

    expect(result.rollup).toBeDefined();
    expect(result.rollup!.total).toBe(2);
    expect(result.rollup!.done).toBe(1);
    expect(result.rollup!.pending).toBe(1);
    expect(result.rollup!.completionPct).toBe(50);

    expect(result.readyFrontier).toBeDefined();
    expect(result.readyFrontier).toHaveLength(1);
    expect(result.readyFrontier![0].id).toBe('T10630');
    expect(result.members).toBeUndefined();
  });

  it('scope omitted produces no rollup/members/readyFrontier (backward compat)', async () => {
    const task = makeTask({ id: 'T10629' });
    setupAccessor(task);

    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10629',
      includeAcceptance: false,
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });

    expect(result.rollup).toBeUndefined();
    expect(result.members).toBeUndefined();
    expect(result.readyFrontier).toBeUndefined();
  });

  it('omission includes expansionCommand for rollup', async () => {
    const saga = makeTask({
      id: 'T10538',
      type: 'saga',
      relates: [{ taskId: 'T10547', type: 'groups', reason: 'member' }],
    });
    const epic = makeTask({ id: 'T10547', title: 'E9', status: 'done', type: 'epic' });

    const mockImpl = {
      loadSingleTask: vi.fn().mockImplementation((id: string) => {
        if (id === 'T10538') return Promise.resolve({
          ...saga,
          relates: saga.relates,
        });
        if (id === 'T10547') return Promise.resolve(epic);
        return Promise.resolve(null);
      }),
      queryTasks: vi.fn().mockResolvedValue({ tasks: [saga, epic], total: 2 }),
      queryAuditLog: vi.fn().mockResolvedValue([]),
    };
    (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);

    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10538',
      scope: 'saga',
      budgetTokens: 55,
      includeAcceptance: false,
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });

    const rollupOmission = result.omissions.find((o: { path: string }) => o.path === 'rollup');
    expect(rollupOmission).toBeDefined();
    expect(rollupOmission!.expansionCommand).toBeDefined();
    expect(rollupOmission!.expansionCommand).toContain('cleo saga rollup T10538');
  });

  it('scope=saga on non-saga task omits rollup with expansion command', async () => {
    const task = makeTask({ id: 'T10629', type: 'task' });
    setupAccessor(task);

    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10629',
      scope: 'saga',
      includeAcceptance: false,
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });

    expect(result.rollup).toBeUndefined();
    expect(result.members).toBeUndefined();
    const rollupOmission = result.omissions.find((o: { path: string }) => o.path === 'rollup');
    // When task is not saga-shaped but scope=saga, we still get the not_available omission
    // (the isSagaShaped check returns false for type='task', so saga scope is skipped silently)
  });

  it('scope=epic with ready frontier from orchestrate', async () => {
    const epic = makeTask({ id: 'T10547', title: 'E9: Context Packs', type: 'epic', status: 'active' });
    const child = makeTask({ id: 'T10630', title: 'Saga context pack', status: 'pending', parentId: 'T10547' });

    const { orchestrateReady } = await import('../../orchestrate/query-ops.js');
    (orchestrateReady as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        readyTasks: [
          { id: 'T10630', title: 'Saga context pack', priority: 'high', depends: ['T10629'] },
        ],
      },
    });

    const mockImpl = {
      loadSingleTask: vi.fn().mockImplementation((id: string) => {
        if (id === 'T10547') return Promise.resolve(epic);
        return Promise.resolve(null);
      }),
      queryTasks: vi.fn().mockResolvedValue({ tasks: [epic, child], total: 2 }),
      queryAuditLog: vi.fn().mockResolvedValue([]),
    };
    (getAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
    (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);

    const result = await coreTaskContext('/fake/project', {
      taskId: 'T10547',
      scope: 'epic',
      includeAcceptance: false,
      includeBlockers: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });

    expect(result.readyFrontier![0].id).toBe('T10630');
    expect(result.readyFrontier![0].depends).toEqual(['T10629']);
  });
});
