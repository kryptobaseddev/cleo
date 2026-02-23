import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock engine imports (all domain handlers need these)
vi.mock('../../lib/engine.js', () => ({
  // Task engine
  taskShow: vi.fn(() => ({ success: true, data: { id: 'T001', title: 'Test' } })),
  taskList: vi.fn(() => ({ success: true, data: [] })),
  taskFind: vi.fn(() => ({ success: true, data: [] })),
  taskExists: vi.fn(() => ({ success: true, data: { exists: true, taskId: 'T001' } })),
  taskCreate: vi.fn(() => ({ success: true, data: { id: 'T001', title: 'New' } })),
  taskUpdate: vi.fn(() => ({ success: true, data: { id: 'T001' } })),
  taskComplete: vi.fn(() => ({ success: true, data: { id: 'T001' } })),
  taskDelete: vi.fn(() => ({ success: true, data: { deleted: true } })),
  taskArchive: vi.fn(() => ({ success: true, data: { archived: 0 } })),
  taskNext: vi.fn(() => ({ success: true, data: { suggestions: [] } })),
  taskBlockers: vi.fn(() => ({ success: true, data: { blockedTasks: [] } })),
  taskTree: vi.fn(() => ({ success: true, data: { tree: [] } })),
  taskRelates: vi.fn(() => ({ success: true, data: { relations: [] } })),
  taskRelatesAdd: vi.fn(() => ({ success: true, data: {} })),
  taskAnalyze: vi.fn(() => ({ success: true, data: {} })),
  taskRestore: vi.fn(() => ({ success: true, data: {} })),
  taskReorder: vi.fn(() => ({ success: true, data: {} })),
  taskReparent: vi.fn(() => ({ success: true, data: {} })),
  taskPromote: vi.fn(() => ({ success: true, data: {} })),
  taskReopen: vi.fn(() => ({ success: true, data: {} })),
  taskComplexityEstimate: vi.fn(() => ({ success: true, data: {} })),
  taskDepends: vi.fn(() => ({ success: true, data: {} })),
  taskCurrentGet: vi.fn(() => ({ success: true, data: {} })),
  taskStart: vi.fn(() => ({ success: true, data: {} })),
  taskStop: vi.fn(() => ({ success: true, data: {} })),
  // Session engine
  sessionStatus: vi.fn(() => ({ success: true, data: {} })),
  sessionList: vi.fn(() => ({ success: true, data: [] })),
  sessionShow: vi.fn(() => ({ success: true, data: {} })),
  sessionStart: vi.fn(() => ({ success: true, data: {} })),
  sessionEnd: vi.fn(() => ({ success: true, data: {} })),
  sessionResume: vi.fn(() => ({ success: true, data: {} })),
  sessionSuspend: vi.fn(() => ({ success: true, data: {} })),
  sessionGc: vi.fn(() => ({ success: true, data: {} })),
  sessionHistory: vi.fn(() => ({ success: true, data: [] })),
  sessionRecordDecision: vi.fn(() => ({ success: true, data: {} })),
  sessionDecisionLog: vi.fn(() => ({ success: true, data: [] })),
  sessionContextDrift: vi.fn(() => ({ success: true, data: {} })),
  sessionRecordAssumption: vi.fn(() => ({ success: true, data: {} })),
  // System engine
  systemDash: vi.fn(() => ({ success: true, data: {} })),
  systemStats: vi.fn(() => ({ success: true, data: {} })),
  systemLog: vi.fn(() => ({ success: true, data: {} })),
  systemContext: vi.fn(() => ({ success: true, data: {} })),
  systemSequence: vi.fn(() => ({ success: true, data: {} })),
  systemHealth: vi.fn(() => ({ success: true, data: {} })),
  systemInjectGenerate: vi.fn(() => ({ success: true, data: {} })),
  systemBackup: vi.fn(() => ({ success: true, data: {} })),
  systemRestore: vi.fn(() => ({ success: true, data: {} })),
  systemMigrate: vi.fn(() => ({ success: true, data: {} })),
  systemCleanup: vi.fn(() => ({ success: true, data: {} })),
  systemSync: vi.fn(() => ({ success: true, data: {} })),
  systemSafestop: vi.fn(() => ({ success: true, data: {} })),
  systemRoadmap: vi.fn(() => ({ success: true, data: {} })),
  systemCompliance: vi.fn(() => ({ success: true, data: {} })),
  systemLabels: vi.fn(() => ({ success: true, data: {} })),
  systemArchiveStats: vi.fn(() => ({ success: true, data: {} })),
  systemUncancel: vi.fn(() => ({ success: true, data: {} })),
  configGet: vi.fn(() => ({ success: true, data: {} })),
  configSet: vi.fn(() => ({ success: true, data: {} })),
  getVersion: vi.fn(() => ({ success: true, data: { version: '1.0.0' } })),
  initProject: vi.fn(() => ({ success: true, data: {} })),
  // Research engine
  researchShow: vi.fn(() => ({ success: true, data: {} })),
  researchList: vi.fn(() => ({ success: true, data: [] })),
  researchQuery: vi.fn(() => ({ success: true, data: [] })),
  researchPending: vi.fn(() => ({ success: true, data: [] })),
  researchStats: vi.fn(() => ({ success: true, data: {} })),
  researchManifestRead: vi.fn(() => ({ success: true, data: [] })),
  researchLink: vi.fn(() => ({ success: true, data: {} })),
  researchManifestAppend: vi.fn(() => ({ success: true, data: {} })),
  researchManifestArchive: vi.fn(() => ({ success: true, data: {} })),
  researchContradictions: vi.fn(() => ({ success: true, data: [] })),
  researchSuperseded: vi.fn(() => ({ success: true, data: [] })),
  researchInject: vi.fn(() => ({ success: true, data: {} })),
  // Validate engine
  validateSchemaOp: vi.fn(() => ({ success: true, data: {} })),
  validateTaskOp: vi.fn(() => ({ success: true, data: {} })),
  validateProtocol: vi.fn(() => ({ success: true, data: {} })),
  validateManifestOp: vi.fn(() => ({ success: true, data: {} })),
  validateOutput: vi.fn(() => ({ success: true, data: {} })),
  validateComplianceSummary: vi.fn(() => ({ success: true, data: {} })),
  validateComplianceViolations: vi.fn(() => ({ success: true, data: [] })),
  validateComplianceRecord: vi.fn(() => ({ success: true, data: {} })),
  validateTestStatus: vi.fn(() => ({ success: true, data: {} })),
  validateTestCoverage: vi.fn(() => ({ success: true, data: {} })),
  validateCoherenceCheck: vi.fn(() => ({ success: true, data: {} })),
  validateTestRun: vi.fn(() => ({ success: true, data: {} })),
  validateBatchValidate: vi.fn(() => ({ success: true, data: {} })),
  // Orchestrate engine
  orchestrateStatus: vi.fn(() => ({ success: true, data: {} })),
  orchestrateAnalyze: vi.fn(() => ({ success: true, data: {} })),
  orchestrateReady: vi.fn(() => ({ success: true, data: {} })),
  orchestrateNext: vi.fn(() => ({ success: true, data: {} })),
  orchestrateWaves: vi.fn(() => ({ success: true, data: {} })),
  orchestrateContext: vi.fn(() => ({ success: true, data: {} })),
  orchestrateSkillList: vi.fn(() => ({ success: true, data: [] })),
  orchestrateValidate: vi.fn(() => ({ success: true, data: {} })),
  orchestrateSpawn: vi.fn(() => ({ success: true, data: {} })),
  orchestrateStartup: vi.fn(() => ({ success: true, data: {} })),
  orchestrateBootstrap: vi.fn(() => ({ success: true, data: {} })),
  orchestrateCriticalPath: vi.fn(() => ({ success: true, data: {} })),
  orchestrateUnblockOpportunities: vi.fn(() => ({ success: true, data: {} })),
  orchestrateParallelStart: vi.fn(() => ({ success: true, data: {} })),
  orchestrateParallelEnd: vi.fn(() => ({ success: true, data: {} })),
  orchestrateCheck: vi.fn(() => ({ success: true, data: {} })),
  orchestrateSkillInject: vi.fn(() => ({ success: true, data: {} })),
  // Lifecycle engine
  lifecycleStatus: vi.fn(() => ({ success: true, data: {} })),
  lifecycleHistory: vi.fn(() => ({ success: true, data: [] })),
  lifecycleGates: vi.fn(() => ({ success: true, data: {} })),
  lifecyclePrerequisites: vi.fn(() => ({ success: true, data: {} })),
  lifecycleCheck: vi.fn(() => ({ success: true, data: {} })),
  lifecycleProgress: vi.fn(() => ({ success: true, data: {} })),
  lifecycleSkip: vi.fn(() => ({ success: true, data: {} })),
  lifecycleReset: vi.fn(() => ({ success: true, data: {} })),
  lifecycleGatePass: vi.fn(() => ({ success: true, data: {} })),
  lifecycleGateFail: vi.fn(() => ({ success: true, data: {} })),
  LIFECYCLE_STAGES: ['research', 'consensus', 'spec', 'decompose', 'implement', 'verify', 'test', 'release'],
  // Release engine
  releasePrepare: vi.fn(() => ({ success: true, data: {} })),
  releaseChangelog: vi.fn(() => ({ success: true, data: {} })),
  releaseList: vi.fn(() => ({ success: true, data: [] })),
  releaseShow: vi.fn(() => ({ success: true, data: {} })),
  releaseCommit: vi.fn(() => ({ success: true, data: {} })),
  releaseTag: vi.fn(() => ({ success: true, data: {} })),
  releaseGatesRun: vi.fn(() => ({ success: true, data: {} })),
  releaseRollback: vi.fn(() => ({ success: true, data: {} })),
  releasePush: vi.fn(() => ({ success: true, data: {} })),
  // Tools - provider/skill/issue
  providerList: vi.fn(() => ({ success: true, data: [] })),
  providerDetect: vi.fn(() => ({ success: true, data: {} })),
  injectionCheck: vi.fn(() => ({ success: true, data: {} })),
  parseIssueTemplates: vi.fn(() => ({ success: true, data: [] })),
  generateTemplateConfig: vi.fn(() => ({ success: true, data: {} })),
  validateLabels: vi.fn(() => ({ success: true, data: {} })),
}));

// Mock paths
vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

// Mock CLI output
vi.mock('../../../cli/renderers/index.js', () => ({
  cliOutput: vi.fn(),
  cliError: vi.fn(),
}));

// Mock security module
vi.mock('../../../mcp/lib/security.js', () => ({
  sanitizeParams: vi.fn((p: Record<string, unknown>) => p),
}));

import { createCliDispatcher, dispatchFromCli, dispatchRaw, resetCliDispatcher } from '../cli.js';
import { cliOutput, cliError } from '../../../cli/renderers/index.js';

describe('CLI Adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCliDispatcher();
  });

  // Prevent process.exit from actually exiting
  const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

  afterEach(() => {
    mockExit.mockClear();
  });

  describe('createCliDispatcher', () => {
    it('creates a Dispatcher instance with all 9 domain handlers', () => {
      const dispatcher = createCliDispatcher();
      expect(dispatcher).toBeDefined();
      expect(typeof dispatcher.dispatch).toBe('function');
    });
  });

  describe('dispatchFromCli', () => {
    it('dispatches a successful query and calls cliOutput', async () => {
      await dispatchFromCli('query', 'tasks', 'show', { taskId: 'T001' }, { command: 'show' });

      expect(cliOutput).toHaveBeenCalledWith(
        { id: 'T001', title: 'Test' },
        expect.objectContaining({
          command: 'show',
          operation: 'tasks.show',
        }),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('dispatches a failed query and calls cliError + process.exit', async () => {
      await dispatchFromCli('query', 'tasks', 'nonexistent', {}, { command: 'test' });

      expect(cliError).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(expect.any(Number));
    });

    it('sets default operation from domain.operation when not provided', async () => {
      await dispatchFromCli('query', 'tasks', 'show', { taskId: 'T001' });

      expect(cliOutput).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          command: 'show',
          operation: 'tasks.show',
        }),
      );
    });

    it('uses custom outputOpts when provided', async () => {
      await dispatchFromCli('query', 'tasks', 'show', { taskId: 'T001' }, {
        command: 'my-cmd',
        operation: 'custom.op',
        message: 'OK',
      });

      expect(cliOutput).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          command: 'my-cmd',
          operation: 'custom.op',
          message: 'OK',
        }),
      );
    });
  });

  describe('dispatchRaw', () => {
    it('returns raw response without calling cliOutput', async () => {
      const response = await dispatchRaw('query', 'tasks', 'show', { taskId: 'T001' });

      expect(response.success).toBe(true);
      expect(response.data).toEqual({ id: 'T001', title: 'Test' });
      expect(cliOutput).not.toHaveBeenCalled();
    });

    it('returns error response for invalid operations', async () => {
      const response = await dispatchRaw('query', 'tasks', 'nonexistent');

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('E_INVALID_OPERATION');
    });
  });
});
