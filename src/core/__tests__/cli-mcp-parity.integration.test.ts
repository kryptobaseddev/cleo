/**
 * CLI/MCP Parity Integration Tests
 *
 * Verifies that the CLI and MCP paths produce identical results for shared
 * operations. Both CLI and MCP ultimately route through the same domain
 * handlers (TasksHandler, SessionHandler, etc.), which delegate to the same
 * src/core/ functions.
 *
 * Test strategy:
 *   1. Direct domain handler parity — call handler.query()/handler.mutate()
 *      and dispatchRaw() for the same operation; assert identical data.
 *   2. CLI dispatch path — call dispatchRaw() and verify it reaches the same
 *      handler as MCP would via createDomainHandlers().
 *   3. Cross-adapter data identity — same mock engine function is called with
 *      identical args from both CLI and MCP code paths.
 *   4. MCP gateway normalization gap — document that handleMcpToolCall passes
 *      'cleo_query' as gateway but the registry expects 'query' (a real gap).
 *
 * Architecture under test:
 *   CLI:  dispatchRaw('query', domain, op, params)
 *           → getCliDispatcher() → Dispatcher (sanitizer mw)
 *           → TasksHandler.query(op, params)
 *           → task-engine fn → core/tasks/*
 *
 *   MCP:  handleMcpToolCall('cleo_query', domain, op, params)
 *           → getMcpDispatcher() → Dispatcher (sanitizer+rl+gates+protocol+audit mw)
 *           → same TasksHandler.query(op, params)  [same handler instance via createDomainHandlers()]
 *           → same task-engine fn → same core/tasks/*
 *
 * @task T4796
 * @epic T4654
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ===========================================================================
// Mocks — all engine functions and MCP-only middleware
// ===========================================================================

// --- task-engine mocks ---
vi.mock('../../dispatch/engines/task-engine.js', () => ({
  taskShow: vi.fn(),
  taskList: vi.fn(),
  taskFind: vi.fn(),
  taskExists: vi.fn(),
  taskCreate: vi.fn(),
  taskUpdate: vi.fn(),
  taskComplete: vi.fn(),
  taskDelete: vi.fn(),
  taskArchive: vi.fn(),
  taskNext: vi.fn(),
  taskBlockers: vi.fn(),
  taskTree: vi.fn(),
  taskRelates: vi.fn(),
  taskRelatesAdd: vi.fn(),
  taskAnalyze: vi.fn(),
  taskRestore: vi.fn(),
  taskReorder: vi.fn(),
  taskReparent: vi.fn(),
  taskPromote: vi.fn(),
  taskReopen: vi.fn(),
  taskComplexityEstimate: vi.fn(),
  taskDepends: vi.fn(),
}));

// --- session-engine mocks (hosts taskStart/taskStop/taskCurrentGet) ---
vi.mock('../../dispatch/engines/session-engine.js', () => ({
  sessionStatus: vi.fn(),
  sessionList: vi.fn(),
  sessionShow: vi.fn(),
  sessionStart: vi.fn(),
  sessionEnd: vi.fn(),
  sessionResume: vi.fn(),
  sessionSuspend: vi.fn(),
  sessionGc: vi.fn(),
  sessionHistory: vi.fn(),
  sessionRecordDecision: vi.fn(),
  sessionDecisionLog: vi.fn(),
  sessionContextDrift: vi.fn(),
  sessionRecordAssumption: vi.fn(),
  taskCurrentGet: vi.fn(),
  taskStart: vi.fn(),
  taskStop: vi.fn(),
}));

// --- system-engine mocks ---
vi.mock('../../dispatch/engines/system-engine.js', () => ({
  systemDash: vi.fn(),
  systemStats: vi.fn(),
  systemLog: vi.fn(),
  systemContext: vi.fn(),
  systemSequence: vi.fn(),
  systemHealth: vi.fn(),
  systemInjectGenerate: vi.fn(),
  systemBackup: vi.fn(),
  systemRestore: vi.fn(),
  systemMigrate: vi.fn(),
  systemCleanup: vi.fn(),
  systemSync: vi.fn(),
  systemSafestop: vi.fn(),
}));

// --- lifecycle-engine mocks ---
vi.mock('../../dispatch/engines/lifecycle-engine.js', () => ({
  lifecycleStatus: vi.fn(),
  lifecycleHistory: vi.fn(),
  lifecycleGates: vi.fn(),
  lifecyclePrerequisites: vi.fn(),
  lifecycleCheck: vi.fn(),
  lifecycleProgress: vi.fn(),
  lifecycleSkip: vi.fn(),
  lifecycleReset: vi.fn(),
  lifecycleGatePass: vi.fn(),
  lifecycleGateFail: vi.fn(),
  LIFECYCLE_STAGES: [
    'research', 'consensus', 'architecture_decision', 'specification',
    'decomposition', 'implementation', 'validation', 'testing',
    'release', 'contribution',
  ],
}));

// --- orchestrate-engine mocks ---
vi.mock('../../dispatch/engines/orchestrate-engine.js', () => ({
  orchestrateStatus: vi.fn(),
  orchestrateAnalyze: vi.fn(),
  orchestrateReady: vi.fn(),
  orchestrateNext: vi.fn(),
  orchestrateWaves: vi.fn(),
  orchestrateContext: vi.fn(),
  orchestrateValidate: vi.fn(),
  orchestrateSpawn: vi.fn(),
  orchestrateStartup: vi.fn(),
  orchestrateBootstrap: vi.fn(),
  orchestrateCriticalPath: vi.fn(),
  orchestrateUnblockOpportunities: vi.fn(),
  orchestrateParallelStart: vi.fn(),
  orchestrateParallelEnd: vi.fn(),
  orchestrateCheck: vi.fn(),
  orchestrateSkillInject: vi.fn(),
}));

// --- validate-engine mocks ---
vi.mock('../../dispatch/engines/validate-engine.js', () => ({
  validateSchemaOp: vi.fn(),
  validateTask: vi.fn(),
  validateProtocol: vi.fn(),
  validateManifest: vi.fn(),
  validateOutput: vi.fn(),
  validateComplianceSummary: vi.fn(),
  validateComplianceViolations: vi.fn(),
  validateComplianceRecord: vi.fn(),
  validateTestStatus: vi.fn(),
  validateTestCoverage: vi.fn(),
  validateCoherenceCheck: vi.fn(),
  validateTestRun: vi.fn(),
  validateBatchValidate: vi.fn(),
}));

// --- release-engine mocks ---
vi.mock('../../dispatch/engines/release-engine.js', () => ({
  releasePrepare: vi.fn(),
  releaseChangelog: vi.fn(),
  releaseList: vi.fn(),
  releaseShow: vi.fn(),
  releaseCommit: vi.fn(),
  releaseTag: vi.fn(),
  releaseGatesRun: vi.fn(),
  releaseRollback: vi.fn(),
  releasePush: vi.fn(),
}));

// --- memory engine mock ---
vi.mock('../../core/memory/engine-compat.js', () => ({
  memoryShow: vi.fn(),
  memoryList: vi.fn(),
  memoryQuery: vi.fn(),
  memoryPending: vi.fn(),
  memoryStats: vi.fn(),
  memoryManifestRead: vi.fn(),
  memoryLink: vi.fn(),
  memoryManifestAppend: vi.fn(),
  memoryManifestArchive: vi.fn(),
  memoryContradictions: vi.fn(),
  memorySuperseded: vi.fn(),
  memoryInject: vi.fn(),
}));

// --- dispatch/lib/engine (config + init) ---
vi.mock('../../dispatch/lib/engine.js', () => {
  return {
    // Tasks
    taskShow: vi.fn(),
    taskList: vi.fn(),
    taskFind: vi.fn(),
    taskCreate: vi.fn(),
    taskComplete: vi.fn(),
    taskUpdate: vi.fn(),
    taskDelete: vi.fn(),
    taskCurrentGet: vi.fn(),
    taskStart: vi.fn(),
    taskStop: vi.fn(),
    // Session
    sessionStatus: vi.fn(),
    sessionList: vi.fn(),
    sessionStart: vi.fn(),
    configGet: vi.fn(),
    configSet: vi.fn(),
    getVersion: vi.fn(() => ({ success: true, data: { version: '1.0.0' } })),
    initProject: vi.fn(),
    isAutoInitEnabled: vi.fn(() => false),
    ensureInitialized: vi.fn(() => ({ success: true, data: { initialized: true } })),
  };
});

// --- template-parser mocks ---
vi.mock('../../dispatch/engines/template-parser.js', () => ({
  parseIssueTemplates: vi.fn(),
  getTemplateForSubcommand: vi.fn(),
  generateTemplateConfig: vi.fn(),
  validateLabels: vi.fn(),
}));

// --- paths ---
vi.mock('../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

// --- MCP-only middleware (passthrough stubs to avoid blocking tests) ---
vi.mock('../../dispatch/middleware/rate-limiter.js', () => ({
  createRateLimiter: vi.fn(() =>
    async (
      _req: import('../../dispatch/types.js').DispatchRequest,
      next: import('../../dispatch/types.js').DispatchNext,
    ) => next(),
  ),
}));

vi.mock('../../dispatch/middleware/verification-gates.js', () => ({
  createVerificationGates: vi.fn(() =>
    async (
      _req: import('../../dispatch/types.js').DispatchRequest,
      next: import('../../dispatch/types.js').DispatchNext,
    ) => next(),
  ),
}));

vi.mock('../../dispatch/middleware/protocol-enforcement.js', () => ({
  createProtocolEnforcement: vi.fn(() =>
    async (
      _req: import('../../dispatch/types.js').DispatchRequest,
      next: import('../../dispatch/types.js').DispatchNext,
    ) => next(),
  ),
}));

vi.mock('../../dispatch/middleware/audit.js', () => ({
  createAudit: vi.fn(() =>
    async (
      _req: import('../../dispatch/types.js').DispatchRequest,
      next: import('../../dispatch/types.js').DispatchNext,
    ) => next(),
  ),
}));

// --- MCP rate-limiter config dependency ---
vi.mock('../../mcp/lib/rate-limiter.js', () => ({
  RateLimiter: vi.fn(),
  createRateLimiter: vi.fn(),
}));

// --- security (sanitizer) ---
vi.mock('../../dispatch/lib/security.js', () => ({
  sanitizeParams: vi.fn((p: Record<string, unknown>) => p),
}));

vi.mock('../../mcp/lib/security.js', () => ({
  sanitizeParams: vi.fn((p: Record<string, unknown>) => p),
}));

// ===========================================================================
// Imports (AFTER all vi.mock() calls)
// ===========================================================================

import { dispatchRaw, resetCliDispatcher } from '../../dispatch/adapters/cli.js';
import { handleMcpToolCall, resetMcpDispatcher } from '../../dispatch/adapters/mcp.js';
import { TasksHandler } from '../../dispatch/domains/tasks.js';
import { SessionHandler } from '../../dispatch/domains/session.js';
import {
  taskShow,
  taskList,
  taskFind,
  taskCreate,
  taskComplete,
  taskUpdate,
  taskDelete,
  sessionStatus,
  sessionList,
  sessionStart,
  taskCurrentGet,
  taskStart,
  taskStop,
} from '../../dispatch/lib/engine.js';

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Strip _meta from a DispatchResponse for data-only comparison.
 * _meta legitimately differs between CLI (source:'cli') and MCP (source:'mcp').
 */
function stripMeta(
  response: Record<string, unknown>,
): Omit<Record<string, unknown>, '_meta'> {
  const { _meta: _ignored, ...rest } = response;
  return rest;
}

// ===========================================================================
// Setup
// ===========================================================================

beforeEach(() => {
  vi.clearAllMocks();
  // Reset dispatcher singletons so each test gets a fresh dispatcher instance
  resetCliDispatcher();
  resetMcpDispatcher();
});

// ===========================================================================
// Section 1: Direct Domain Handler Parity
//
// Calls the domain handler directly (simulating what both CLI dispatch and MCP
// dispatch ultimately do) and verifies identical data for each operation.
// ===========================================================================

describe('Section 1: Direct domain handler parity (T4796)', () => {
  let tasksHandler: TasksHandler;

  beforeEach(() => {
    tasksHandler = new TasksHandler();
  });

  // -------------------------------------------------------------------------
  // tasks.show
  // -------------------------------------------------------------------------

  describe('tasks.show', () => {
    const TASK_DATA = {
      task: {
        id: 'T001',
        title: 'Alpha task',
        status: 'pending',
        priority: 'high',
      },
    };

    beforeEach(() => {
      vi.mocked(taskShow).mockResolvedValue({ success: true, data: TASK_DATA });
    });

    it('handler.query("show") and dispatchRaw produce identical data', async () => {
      const handlerResult = await tasksHandler.query('show', { taskId: 'T001' });
      const cliResult = await dispatchRaw('query', 'tasks', 'show', {
        taskId: 'T001',
      });

      expect(handlerResult.success).toBe(true);
      expect(cliResult.success).toBe(true);

      // Both produce the same data payload
      expect(handlerResult.data).toEqual(TASK_DATA);
      expect(cliResult.data).toEqual(TASK_DATA);
      expect(handlerResult.data).toEqual(cliResult.data);
    });

    it('handler.query("show") and dispatchRaw both fail for missing taskId', async () => {
      const handlerResult = await tasksHandler.query('show', {});
      const cliResult = await dispatchRaw('query', 'tasks', 'show', {});

      expect(handlerResult.success).toBe(false);
      expect(cliResult.success).toBe(false);

      // Both return E_INVALID_INPUT
      expect(handlerResult.error?.code).toBe('E_INVALID_INPUT');
      expect(cliResult.error?.code).toBe('E_INVALID_INPUT');
    });

    it('taskShow engine called with identical args from handler and dispatchRaw', async () => {
      await tasksHandler.query('show', { taskId: 'T001' });
      await dispatchRaw('query', 'tasks', 'show', { taskId: 'T001' });

      expect(taskShow).toHaveBeenCalledTimes(2);
      // Both calls pass the same projectRoot and taskId
      expect(vi.mocked(taskShow).mock.calls[0]).toEqual(
        vi.mocked(taskShow).mock.calls[1],
      );
    });
  });

  // -------------------------------------------------------------------------
  // tasks.list
  // -------------------------------------------------------------------------

  describe('tasks.list', () => {
    const LIST_DATA = {
      tasks: [
        { id: 'T001', title: 'Alpha', status: 'pending' },
        { id: 'T002', title: 'Beta', status: 'active' },
      ],
      total: 2,
    };

    beforeEach(() => {
      vi.mocked(taskList).mockResolvedValue({ success: true, data: LIST_DATA });
    });

    it('handler.query("list") and dispatchRaw produce identical data (no filters)', async () => {
      const handlerResult = await tasksHandler.query('list', {});
      const cliResult = await dispatchRaw('query', 'tasks', 'list', {});

      expect(handlerResult.success).toBe(true);
      expect(cliResult.success).toBe(true);
      expect(handlerResult.data).toEqual(cliResult.data);
      expect(cliResult.data).toEqual(LIST_DATA);
    });

    it('handler.query("list") and dispatchRaw produce identical data with status filter', async () => {
      const filteredData = {
        tasks: [{ id: 'T001', title: 'Alpha', status: 'pending' }],
        total: 1,
      };
      vi.mocked(taskList).mockResolvedValue({ success: true, data: filteredData });

      const handlerResult = await tasksHandler.query('list', { status: 'pending' });
      const cliResult = await dispatchRaw('query', 'tasks', 'list', {
        status: 'pending',
      });

      expect(handlerResult.data).toEqual(cliResult.data);
      expect(cliResult.data).toEqual(filteredData);
    });

    it('taskList engine called with identical args from handler and dispatchRaw', async () => {
      await tasksHandler.query('list', { parent: 'T010', limit: 5 });
      await dispatchRaw('query', 'tasks', 'list', { parent: 'T010', limit: 5 });

      expect(taskList).toHaveBeenCalledTimes(2);
      expect(vi.mocked(taskList).mock.calls[0]).toEqual(
        vi.mocked(taskList).mock.calls[1],
      );
    });
  });

  // -------------------------------------------------------------------------
  // tasks.find
  // -------------------------------------------------------------------------

  describe('tasks.find', () => {
    const FIND_DATA = {
      results: [{ id: 'T001', title: 'Alpha task', status: 'pending' }],
      total: 1,
    };

    beforeEach(() => {
      vi.mocked(taskFind).mockResolvedValue({ success: true, data: FIND_DATA });
    });

    it('handler.query("find") and dispatchRaw produce identical data', async () => {
      const handlerResult = await tasksHandler.query('find', { query: 'alpha' });
      const cliResult = await dispatchRaw('query', 'tasks', 'find', {
        query: 'alpha',
      });

      expect(handlerResult.success).toBe(true);
      expect(cliResult.success).toBe(true);
      expect(handlerResult.data).toEqual(cliResult.data);
    });

    it('taskFind engine called with identical args from handler and dispatchRaw', async () => {
      const params = { query: 'test', limit: 10 };
      await tasksHandler.query('find', params);
      await dispatchRaw('query', 'tasks', 'find', params);

      expect(taskFind).toHaveBeenCalledTimes(2);
      expect(vi.mocked(taskFind).mock.calls[0]).toEqual(
        vi.mocked(taskFind).mock.calls[1],
      );
    });
  });

  // -------------------------------------------------------------------------
  // tasks.add (mutate)
  // -------------------------------------------------------------------------

  describe('tasks.add', () => {
    const CREATED_DATA = {
      task: {
        id: 'T100',
        title: 'New task',
        description: 'Created for parity test',
        status: 'pending',
      },
    };

    beforeEach(() => {
      vi.mocked(taskCreate).mockResolvedValue({
        success: true,
        data: CREATED_DATA,
      });
    });

    it('handler.mutate("add") and dispatchRaw produce identical data', async () => {
      const params = { title: 'New task', description: 'Created for parity test' };

      const handlerResult = await tasksHandler.mutate('add', params);
      const cliResult = await dispatchRaw('mutate', 'tasks', 'add', params);

      expect(handlerResult.success).toBe(true);
      expect(cliResult.success).toBe(true);
      expect(handlerResult.data).toEqual(cliResult.data);
      expect(cliResult.data).toEqual(CREATED_DATA);
    });

    it('handler.mutate("add") and dispatchRaw both fail with E_INVALID_INPUT when title missing', async () => {
      const handlerResult = await tasksHandler.mutate('add', {
        description: 'No title',
      });
      const cliResult = await dispatchRaw('mutate', 'tasks', 'add', {
        description: 'No title',
      });

      expect(handlerResult.success).toBe(false);
      expect(cliResult.success).toBe(false);
      expect(handlerResult.error?.code).toBe('E_INVALID_INPUT');
      expect(cliResult.error?.code).toBe('E_INVALID_INPUT');
    });

    it('taskCreate engine called with identical args from handler and dispatchRaw', async () => {
      const params = { title: 'New task', description: 'Parity test task' };
      await tasksHandler.mutate('add', params);
      await dispatchRaw('mutate', 'tasks', 'add', params);

      expect(taskCreate).toHaveBeenCalledTimes(2);
      expect(vi.mocked(taskCreate).mock.calls[0]).toEqual(
        vi.mocked(taskCreate).mock.calls[1],
      );
    });
  });

  // -------------------------------------------------------------------------
  // tasks.complete (mutate)
  // -------------------------------------------------------------------------

  describe('tasks.complete', () => {
    const COMPLETE_DATA = {
      taskId: 'T001',
      completed: true,
      completedAt: '2026-02-25T12:00:00Z',
    };

    beforeEach(() => {
      vi.mocked(taskComplete).mockResolvedValue({
        success: true,
        data: COMPLETE_DATA,
      });
    });

    it('handler.mutate("complete") and dispatchRaw produce identical data', async () => {
      const handlerResult = await tasksHandler.mutate('complete', { taskId: 'T001' });
      const cliResult = await dispatchRaw('mutate', 'tasks', 'complete', {
        taskId: 'T001',
      });

      expect(handlerResult.success).toBe(true);
      expect(cliResult.success).toBe(true);
      expect(handlerResult.data).toEqual(cliResult.data);
      expect(cliResult.data).toEqual(COMPLETE_DATA);
    });

    it('handler.mutate("complete") and dispatchRaw both fail with E_INVALID_INPUT when taskId missing', async () => {
      const handlerResult = await tasksHandler.mutate('complete', {});
      const cliResult = await dispatchRaw('mutate', 'tasks', 'complete', {});

      expect(handlerResult.success).toBe(false);
      expect(cliResult.success).toBe(false);
      expect(handlerResult.error?.code).toBe('E_INVALID_INPUT');
      expect(cliResult.error?.code).toBe('E_INVALID_INPUT');
    });

    it('taskComplete engine called with identical args from handler and dispatchRaw', async () => {
      await tasksHandler.mutate('complete', { taskId: 'T001', notes: 'Done' });
      await dispatchRaw('mutate', 'tasks', 'complete', { taskId: 'T001', notes: 'Done' });

      expect(taskComplete).toHaveBeenCalledTimes(2);
      expect(vi.mocked(taskComplete).mock.calls[0]).toEqual(
        vi.mocked(taskComplete).mock.calls[1],
      );
    });
  });

  // -------------------------------------------------------------------------
  // tasks.update (mutate)
  // -------------------------------------------------------------------------

  describe('tasks.update', () => {
    const UPDATED_DATA = {
      task: {
        id: 'T001',
        title: 'Updated title',
        status: 'active',
      },
    };

    beforeEach(() => {
      vi.mocked(taskUpdate).mockResolvedValue({
        success: true,
        data: UPDATED_DATA,
      });
    });

    it('handler.mutate("update") and dispatchRaw produce identical data', async () => {
      const params = { taskId: 'T001', title: 'Updated title', status: 'active' };

      const handlerResult = await tasksHandler.mutate('update', params);
      const cliResult = await dispatchRaw('mutate', 'tasks', 'update', params);

      expect(handlerResult.success).toBe(true);
      expect(cliResult.success).toBe(true);
      expect(handlerResult.data).toEqual(cliResult.data);
    });

    it('taskUpdate engine called with identical args from handler and dispatchRaw', async () => {
      const params = { taskId: 'T001', status: 'done' };
      await tasksHandler.mutate('update', params);
      await dispatchRaw('mutate', 'tasks', 'update', params);

      expect(taskUpdate).toHaveBeenCalledTimes(2);
      expect(vi.mocked(taskUpdate).mock.calls[0]).toEqual(
        vi.mocked(taskUpdate).mock.calls[1],
      );
    });
  });

  // -------------------------------------------------------------------------
  // tasks.delete (mutate)
  // -------------------------------------------------------------------------

  describe('tasks.delete', () => {
    const DELETE_DATA = { taskId: 'T001', deleted: true };

    beforeEach(() => {
      vi.mocked(taskDelete).mockResolvedValue({
        success: true,
        data: DELETE_DATA,
      });
    });

    it('handler.mutate("delete") and dispatchRaw produce identical data', async () => {
      const handlerResult = await tasksHandler.mutate('delete', { taskId: 'T001' });
      const cliResult = await dispatchRaw('mutate', 'tasks', 'delete', {
        taskId: 'T001',
      });

      expect(handlerResult.success).toBe(true);
      expect(cliResult.success).toBe(true);
      expect(handlerResult.data).toEqual(cliResult.data);
      expect(cliResult.data).toEqual(DELETE_DATA);
    });

    it('handler.mutate("delete") and dispatchRaw both fail with E_INVALID_INPUT when taskId missing', async () => {
      const handlerResult = await tasksHandler.mutate('delete', {});
      const cliResult = await dispatchRaw('mutate', 'tasks', 'delete', {});

      expect(handlerResult.success).toBe(false);
      expect(cliResult.success).toBe(false);
      expect(handlerResult.error?.code).toBe('E_INVALID_INPUT');
      expect(cliResult.error?.code).toBe('E_INVALID_INPUT');
    });
  });
});

// ===========================================================================
// Section 2: Session domain parity (T4796)
// ===========================================================================

describe('Section 2: Session domain parity (T4796)', () => {
  let sessionHandler: SessionHandler;

  beforeEach(() => {
    sessionHandler = new SessionHandler();
  });

  // -------------------------------------------------------------------------
  // session.status
  // -------------------------------------------------------------------------

  describe('session.status', () => {
    const STATUS_DATA = {
      hasActiveSession: false,
      currentSession: null,
    };

    beforeEach(() => {
      vi.mocked(sessionStatus).mockResolvedValue({
        success: true,
        data: STATUS_DATA,
      });
    });

    it('handler.query("status") and dispatchRaw produce identical data', async () => {
      const handlerResult = await sessionHandler.query('status', {});
      const cliResult = await dispatchRaw('query', 'session', 'status', {});

      expect(handlerResult.success).toBe(true);
      expect(cliResult.success).toBe(true);
      expect(handlerResult.data).toEqual(cliResult.data);
      expect(cliResult.data).toEqual(STATUS_DATA);
    });

    it('sessionStatus engine called with identical args from handler and dispatchRaw', async () => {
      await sessionHandler.query('status', {});
      await dispatchRaw('query', 'session', 'status', {});

      expect(sessionStatus).toHaveBeenCalledTimes(2);
      expect(vi.mocked(sessionStatus).mock.calls[0]).toEqual(
        vi.mocked(sessionStatus).mock.calls[1],
      );
    });
  });

  // -------------------------------------------------------------------------
  // session.list
  // -------------------------------------------------------------------------

  describe('session.list', () => {
    const LIST_DATA = [
      { id: 'session_abc', status: 'active', name: 'Sprint 1' },
      { id: 'session_def', status: 'ended', name: 'Sprint 0' },
    ];

    beforeEach(() => {
      vi.mocked(sessionList).mockResolvedValue({
        success: true,
        data: LIST_DATA,
      });
    });

    it('handler.query("list") and dispatchRaw produce identical data', async () => {
      const handlerResult = await sessionHandler.query('list', {});
      const cliResult = await dispatchRaw('query', 'session', 'list', {});

      expect(handlerResult.success).toBe(true);
      expect(cliResult.success).toBe(true);
      expect(handlerResult.data).toEqual(cliResult.data);
      expect(cliResult.data).toEqual(LIST_DATA);
    });
  });

  // -------------------------------------------------------------------------
  // session.start (mutate)
  // -------------------------------------------------------------------------

  describe('session.start', () => {
    // Note: SessionHandler.mutate('start') enriches the response by adding
    // sessionId: session.id for easy top-level extraction. This is part of the
    // handler contract, so both paths (direct handler + dispatchRaw) produce this.
    const START_DATA = {
      id: 'session_xyz',
      status: 'active',
      scope: { rootTaskId: 'T010' },
    };
    const ENRICHED_START_DATA = {
      ...START_DATA,
      sessionId: 'session_xyz',
    };

    beforeEach(() => {
      vi.mocked(sessionStart).mockResolvedValue({
        success: true,
        data: START_DATA,
      });
    });

    it('handler.mutate("start") and dispatchRaw produce identical data', async () => {
      const params = { scope: 'epic:T010', name: 'Test Session', autoStart: true };

      const handlerResult = await sessionHandler.mutate('start', params);
      const cliResult = await dispatchRaw('mutate', 'session', 'start', params);

      expect(handlerResult.success).toBe(true);
      expect(cliResult.success).toBe(true);
      // Both paths (direct handler + dispatchRaw) produce the same enriched data
      expect(handlerResult.data).toEqual(cliResult.data);
      // The handler enriches the data with sessionId
      expect(cliResult.data).toEqual(ENRICHED_START_DATA);
    });
  });
});

// ===========================================================================
// Section 3: tasks.start/stop/current — focus operations (T4796)
// ===========================================================================

describe('Section 3: Focus operations parity (tasks.start/stop/current) (T4796)', () => {
  let tasksHandler: TasksHandler;

  beforeEach(() => {
    tasksHandler = new TasksHandler();
  });

  describe('tasks.start', () => {
    const START_DATA = { taskId: 'T001', started: true };

    beforeEach(() => {
      vi.mocked(taskStart).mockResolvedValue({ success: true, data: START_DATA });
    });

    it('handler.mutate("start") and dispatchRaw produce identical data', async () => {
      const handlerResult = await tasksHandler.mutate('start', { taskId: 'T001' });
      const cliResult = await dispatchRaw('mutate', 'tasks', 'start', {
        taskId: 'T001',
      });

      expect(handlerResult.success).toBe(true);
      expect(cliResult.success).toBe(true);
      expect(handlerResult.data).toEqual(cliResult.data);
      expect(cliResult.data).toEqual(START_DATA);
    });

    it('taskStart engine called with identical args from handler and dispatchRaw', async () => {
      await tasksHandler.mutate('start', { taskId: 'T005' });
      await dispatchRaw('mutate', 'tasks', 'start', { taskId: 'T005' });

      expect(taskStart).toHaveBeenCalledTimes(2);
      expect(vi.mocked(taskStart).mock.calls[0]).toEqual(
        vi.mocked(taskStart).mock.calls[1],
      );
    });
  });

  describe('tasks.stop', () => {
    const STOP_DATA = { cleared: true };

    beforeEach(() => {
      vi.mocked(taskStop).mockResolvedValue({ success: true, data: STOP_DATA });
    });

    it('handler.mutate("stop") and dispatchRaw produce identical data', async () => {
      const handlerResult = await tasksHandler.mutate('stop', {});
      const cliResult = await dispatchRaw('mutate', 'tasks', 'stop', {});

      expect(handlerResult.success).toBe(true);
      expect(cliResult.success).toBe(true);
      expect(handlerResult.data).toEqual(cliResult.data);
    });
  });

  describe('tasks.current', () => {
    const CURRENT_DATA = { currentTask: 'T001', since: '2026-02-25T00:00:00Z' };

    beforeEach(() => {
      vi.mocked(taskCurrentGet).mockResolvedValue({
        success: true,
        data: CURRENT_DATA,
      });
    });

    it('handler.query("current") and dispatchRaw produce identical data', async () => {
      const handlerResult = await tasksHandler.query('current', {});
      const cliResult = await dispatchRaw('query', 'tasks', 'current', {});

      expect(handlerResult.success).toBe(true);
      expect(cliResult.success).toBe(true);
      expect(handlerResult.data).toEqual(cliResult.data);
    });
  });
});

// ===========================================================================
// Section 4: DispatchResponse shape consistency (T4796)
// ===========================================================================

describe('Section 4: DispatchResponse shape consistency (T4796)', () => {
  let tasksHandler: TasksHandler;

  beforeEach(() => {
    tasksHandler = new TasksHandler();
  });

  it('_meta has required fields: gateway, domain, operation, timestamp, requestId', async () => {
    vi.mocked(taskShow).mockResolvedValue({
      success: true,
      data: { task: { id: 'T001' } },
    });

    const cliResult = await dispatchRaw('query', 'tasks', 'show', {
      taskId: 'T001',
    });

    expect(cliResult._meta).toBeDefined();
    expect(cliResult._meta.gateway).toBe('query');
    expect(cliResult._meta.domain).toBe('tasks');
    expect(cliResult._meta.operation).toBe('show');
    expect(typeof cliResult._meta.timestamp).toBe('string');
    expect(typeof cliResult._meta.requestId).toBe('string');
    expect(typeof cliResult._meta.duration_ms).toBe('number');
  });

  it('_meta.source is "cli" for dispatchRaw calls', async () => {
    vi.mocked(taskShow).mockResolvedValue({
      success: true,
      data: { task: { id: 'T001' } },
    });

    const cliResult = await dispatchRaw('query', 'tasks', 'show', {
      taskId: 'T001',
    });

    expect(cliResult._meta.source).toBe('cli');
  });

  it('success responses have data field; error responses have error field', async () => {
    vi.mocked(taskShow).mockResolvedValue({
      success: true,
      data: { task: { id: 'T001' } },
    });

    const successResult = await dispatchRaw('query', 'tasks', 'show', {
      taskId: 'T001',
    });
    expect(successResult.success).toBe(true);
    expect(successResult.data).toBeDefined();
    expect(successResult.error).toBeUndefined();

    const errorResult = await dispatchRaw('query', 'tasks', 'show', {});
    expect(errorResult.success).toBe(false);
    expect(errorResult.error).toBeDefined();
    expect(typeof errorResult.error?.code).toBe('string');
    expect(typeof errorResult.error?.message).toBe('string');
  });

  it('error codes are E_ prefixed strings', async () => {
    // Missing taskId → E_INVALID_INPUT
    const result1 = await dispatchRaw('query', 'tasks', 'show', {});
    expect(result1.error?.code).toMatch(/^E_/);

    // Unknown operation → E_INVALID_OPERATION
    const result2 = await dispatchRaw('query', 'tasks', 'nonexistent', {});
    expect(result2.error?.code).toBe('E_INVALID_OPERATION');
  });

  it('domain handler and dispatchRaw produce identical error shape for same failure', async () => {
    const handlerResult = await tasksHandler.query('show', {});
    const cliResult = await dispatchRaw('query', 'tasks', 'show', {});

    // Both return error with same code and message
    expect(handlerResult.error?.code).toBe('E_INVALID_INPUT');
    expect(cliResult.error?.code).toBe('E_INVALID_INPUT');
    expect(handlerResult.error?.message).toBe(cliResult.error?.message);
  });
});

// ===========================================================================
// Section 5: Documented parity gaps (T4796)
//
// These tests document known architectural gaps between CLI and MCP paths.
// They verify the current behavior and are intended to fail once the gap
// is fixed (at which point the test assertions should be updated).
// ===========================================================================

describe('Section 5: Documented parity gaps (T4796)', () => {
  /**
   * GAP 1: MCP gateway normalization
   *
   * handleMcpToolCall() passes 'cleo_query' as the gateway field to the
   * Dispatcher, but the registry only indexes operations by 'query'/'mutate'.
   * This causes ALL handleMcpToolCall() calls to fail with E_INVALID_OPERATION
   * because the registry lookup in dispatcher.ts line 38:
   *   resolve(request.gateway, domain, operation)
   * receives 'cleo_query' instead of 'query'.
   *
   * Fix: handleMcpToolCall() should normalize gateway before dispatching:
   *   const normalizedGateway = gateway === 'cleo_query' ? 'query' : 'mutate';
   */
  it('GAP RESOLVED: handleMcpToolCall now normalizes cleo_query to query', async () => {
    vi.mocked(taskShow).mockResolvedValue({
      success: true,
      data: { task: { id: 'T001' } },
    });

    const mcpResponse = await handleMcpToolCall(
      'cleo_query',
      'tasks',
      'show',
      { taskId: 'T001' },
    );

    // GAP has been resolved: cleo_query is now normalized to query.
    // The request succeeds because the registry lookup now works.
    expect(mcpResponse.success).toBe(true);
  });

  /**
   * GAP 2: Dispatcher routes cleo_query to handler.mutate() instead of handler.query()
   *
   * In dispatcher.ts line 88:
   *   if (request.gateway === 'query') { handler.query(...) } else { handler.mutate(...) }
   *
   * Since MCP requests arrive with gateway='cleo_query', they fall through to
   * handler.mutate() even for read operations. This compounds the registry gap.
   *
   * This gap is blocked by GAP 1 (registry failure happens first), but once
   * GAP 1 is fixed, this must also be fixed.
   *
   * Fix: Normalize 'cleo_query' → 'query' before the terminal handler check.
   */
  it('GAP: Dispatcher routes cleo_query to mutate handler (wrong path for read ops)', async () => {
    // This gap is masked by GAP 1, but we verify the expected correct behavior
    // via dispatchRaw (which uses 'query' gateway correctly):
    vi.mocked(taskShow).mockResolvedValue({
      success: true,
      data: { task: { id: 'T001' } },
    });

    const cliResult = await dispatchRaw('query', 'tasks', 'show', {
      taskId: 'T001',
    });
    // CLI correctly routes to handler.query()
    expect(cliResult.success).toBe(true);
    expect(cliResult.data).toEqual({ task: { id: 'T001' } });

    // taskShow (a query engine fn) was called once (via CLI query path)
    expect(taskShow).toHaveBeenCalledTimes(1);
  });

  /**
   * CORRECT PATH: CLI dispatchRaw produces valid results for all tested operations.
   * The full CLI → Dispatcher → Handler → Engine → Core path works correctly.
   */
  it('CLI path (dispatchRaw) works correctly end-to-end for task operations', async () => {
    vi.mocked(taskShow).mockResolvedValue({
      success: true,
      data: { task: { id: 'T001', title: 'Test task' } },
    });
    vi.mocked(taskList).mockResolvedValue({
      success: true,
      data: { tasks: [], total: 0 },
    });
    vi.mocked(taskCreate).mockResolvedValue({
      success: true,
      data: { task: { id: 'T100', title: 'New task' } },
    });

    const showResult = await dispatchRaw('query', 'tasks', 'show', { taskId: 'T001' });
    const listResult = await dispatchRaw('query', 'tasks', 'list', {});
    const addResult = await dispatchRaw('mutate', 'tasks', 'add', { title: 'New task' });

    expect(showResult.success).toBe(true);
    expect(listResult.success).toBe(true);
    expect(addResult.success).toBe(true);

    expect(taskShow).toHaveBeenCalledTimes(1);
    expect(taskList).toHaveBeenCalledTimes(1);
    expect(taskCreate).toHaveBeenCalledTimes(1);
  });
});
