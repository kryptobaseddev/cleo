/**
 * Registry-Handler Parity Test
 *
 * Verifies that every operation in the OPERATIONS registry has a matching
 * handler case in the corresponding domain handler. An operation that returns
 * E_INVALID_OPERATION means the handler switch/case is missing that op.
 *
 * This test does NOT verify correctness of handler results -- only that each
 * registered operation is recognized by its domain handler (no "unsupported
 * operation" error).
 *
 * @task T5671
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// Mocks — all engine and external dependencies
// ===========================================================================

// dispatch/lib/engine.js — massive barrel of all engine functions
vi.mock('../../lib/engine.js', () => {
  const mockFn = () => vi.fn().mockResolvedValue({ success: true, data: {} });
  const mockSync = () => vi.fn().mockReturnValue({ success: true, data: {} });
  return {
    // Task engine
    taskShow: mockFn(),
    taskList: mockFn(),
    taskFind: mockFn(),
    taskExists: mockFn(),
    taskCreate: mockFn(),
    taskUpdate: mockFn(),
    taskComplete: mockFn(),
    taskDelete: mockFn(),
    taskArchive: mockFn(),
    taskNext: mockFn(),
    taskPlan: mockFn(),
    taskBlockers: mockFn(),
    taskTree: mockFn(),
    taskRelates: mockFn(),
    taskRelatesAdd: mockFn(),
    taskAnalyze: mockFn(),
    taskRestore: mockFn(),
    taskReopen: mockFn(),
    taskCancel: mockFn(),
    taskUnarchive: mockFn(),
    taskReorder: mockFn(),
    taskReparent: mockFn(),
    taskPromote: mockFn(),
    taskComplexityEstimate: mockFn(),
    taskDepends: mockFn(),
    taskDepsOverview: mockFn(),
    taskDepsCycles: mockFn(),
    taskCurrentGet: mockFn(),
    taskStart: mockFn(),
    taskStop: mockFn(),
    taskWorkHistory: mockFn(),
    taskHistory: mockFn(),
    taskRelatesFind: mockFn(),
    taskLabelList: mockFn(),
    taskLabelShow: mockFn(),
    // Session engine
    sessionStatus: mockFn(),
    sessionList: mockFn(),
    sessionShow: mockFn(),
    sessionStart: mockFn(),
    sessionEnd: mockFn(),
    sessionResume: mockFn(),
    sessionSuspend: mockFn(),
    sessionGc: mockFn(),
    sessionHistory: mockFn(),
    sessionRecordDecision: mockFn(),
    sessionDecisionLog: mockFn(),
    sessionContextDrift: mockFn(),
    sessionRecordAssumption: mockFn(),
    sessionHandoff: mockFn(),
    sessionComputeHandoff: mockFn(),
    sessionBriefing: mockFn(),
    sessionComputeDebrief: mockFn(),
    sessionDebriefShow: mockFn(),
    sessionChainShow: mockFn(),
    sessionFind: mockFn(),
    sessionContextInject: mockSync(),
    // System engine
    systemDash: mockFn(),
    systemStats: mockFn(),
    systemLog: mockFn(),
    systemContext: mockSync(),
    systemRuntime: mockFn(),
    systemSequence: mockFn(),
    systemHealth: mockSync(),
    systemDoctor: mockFn(),
    systemFix: mockFn(),
    systemInjectGenerate: mockFn(),
    systemBackup: mockSync(),
    systemRestore: mockSync(),
    backupRestore: mockFn(),
    systemMigrate: mockFn(),
    systemCleanup: mockFn(),
    systemSafestop: mockSync(),
    systemSync: mockSync(),
    systemArchiveStats: mockFn(),
    // Config engine
    configGet: mockFn(),
    configSet: mockFn(),
    // Init engine
    getVersion: mockFn(),
    initProject: mockFn(),
    isAutoInitEnabled: vi.fn(() => false),
    ensureInitialized: vi.fn(() => ({ success: true, data: { initialized: true } })),
    // Lifecycle engine
    lifecycleStatus: mockFn(),
    lifecycleHistory: mockFn(),
    lifecycleGates: mockFn(),
    lifecyclePrerequisites: mockFn(),
    lifecycleCheck: mockFn(),
    lifecycleProgress: mockFn(),
    lifecycleSkip: mockFn(),
    lifecycleReset: mockFn(),
    lifecycleGatePass: mockFn(),
    lifecycleGateFail: mockFn(),
    // Validate engine
    validateSchemaOp: mockSync(),
    validateTaskOp: mockFn(),
    validateProtocol: mockFn(),
    validateManifestOp: mockSync(),
    validateOutput: mockSync(),
    validateComplianceSummary: mockSync(),
    validateComplianceViolations: mockSync(),
    validateComplianceRecord: mockSync(),
    validateTestStatus: mockSync(),
    validateTestCoverage: mockSync(),
    validateCoherenceCheck: mockFn(),
    validateTestRun: mockSync(),
    validateBatchValidate: mockFn(),
    validateProtocolConsensus: mockFn(),
    validateProtocolContribution: mockFn(),
    validateProtocolDecomposition: mockFn(),
    validateProtocolImplementation: mockFn(),
    validateProtocolSpecification: mockFn(),
    validateGateVerify: mockFn(),
    // Orchestrate engine
    orchestrateStatus: mockFn(),
    orchestrateAnalyze: mockFn(),
    orchestrateReady: mockFn(),
    orchestrateNext: mockFn(),
    orchestrateWaves: mockFn(),
    orchestrateContext: mockFn(),
    orchestrateValidate: mockFn(),
    orchestrateSpawn: mockFn(),
    orchestrateHandoff: mockFn(),
    orchestrateSpawnExecute: mockFn(),
    orchestrateStartup: mockFn(),
    orchestrateBootstrap: mockFn(),
    orchestrateCriticalPath: mockFn(),
    orchestrateUnblockOpportunities: mockFn(),
    orchestrateParallelStart: mockFn(),
    orchestrateParallelEnd: mockSync(),
    orchestrateCheck: mockFn(),
    orchestrateSkillInject: mockFn(),
    // Memory engine
    memoryShow: mockFn(),
    memoryBrainStats: mockFn(),
    memoryFind: mockFn(),
    memoryTimeline: mockFn(),
    memoryFetch: mockFn(),
    memoryObserve: mockFn(),
    memoryDecisionFind: mockFn(),
    memoryDecisionStore: mockFn(),
    memoryPatternFind: mockFn(),
    memoryPatternStore: mockFn(),
    memoryPatternStats: mockFn(),
    memoryLearningFind: mockFn(),
    memoryLearningStore: mockFn(),
    memoryLearningStats: mockFn(),
    memoryLink: mockFn(),
    memoryUnlink: mockFn(),
    memoryGraphAdd: mockFn(),
    memoryGraphShow: mockFn(),
    memoryGraphNeighbors: mockFn(),
    memoryGraphRemove: mockFn(),
    memoryReasonWhy: mockFn(),
    memoryReasonSimilar: mockFn(),
    memorySearchHybrid: mockFn(),
    memoryContradictions: mockFn(),
    memorySuperseded: mockFn(),
    // Pipeline manifest
    pipelineManifestShow: mockFn(),
    pipelineManifestList: mockFn(),
    pipelineManifestFind: mockFn(),
    pipelineManifestStats: mockFn(),
    pipelineManifestAppend: mockFn(),
    pipelineManifestArchive: mockFn(),
    pipelineManifestPending: mockFn(),
    readManifestEntries: mockFn(),
    filterEntries: mockFn(),
    // Phase engine
    phaseList: vi
      .fn()
      .mockResolvedValue({ success: true, data: { phases: [], summary: { total: 0 } } }),
    phaseShow: mockFn(),
    phaseSet: mockFn(),
    phaseStart: mockFn(),
    phaseComplete: mockFn(),
    phaseAdvance: mockFn(),
    phaseRename: mockFn(),
    phaseDelete: mockFn(),
    // Release engine
    releasePrepare: mockFn(),
    releaseChangelog: mockFn(),
    releaseList: mockFn(),
    releaseShow: mockFn(),
    releaseCommit: mockFn(),
    releaseTag: mockFn(),
    releaseGatesRun: mockFn(),
    releaseRollback: mockFn(),
    releaseCancel: mockFn(),
    releasePush: mockFn(),
    releaseShip: mockFn(),
    // Template parser
    parseIssueTemplates: mockFn(),
    getTemplateForSubcommand: mockFn(),
    generateTemplateConfig: mockFn(),
    validateLabels: mockFn(),
  };
});

// Session context binding
vi.mock('../../context/session-context.js', () => ({
  bindSession: vi.fn(),
  unbindSession: vi.fn(),
}));

// Core paths
vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

// Core logger
vi.mock('../../../core/logger.js', () => ({
  getLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Core pagination
vi.mock('../../../core/pagination.js', () => ({
  paginate: vi.fn((items: unknown[], _limit?: number, _offset?: number) => ({
    items: items ?? [],
    page: { mode: 'none' as const },
  })),
}));

// ADR operations
vi.mock('../../../core/adrs/index.js', () => ({
  showAdr: vi.fn().mockResolvedValue({ id: 'ADR-001', title: 'Test' }),
  syncAdrsToDb: vi.fn().mockResolvedValue({ synced: 0 }),
  validateAllAdrs: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
  findAdrs: vi.fn().mockResolvedValue({ results: [], total: 0 }),
  listAdrs: vi.fn().mockResolvedValue({ adrs: [], total: 0, filtered: 0 }),
}));

// Admin export/import
vi.mock('../../../core/admin/export.js', () => ({
  exportTasks: vi.fn().mockResolvedValue({ tasks: [], count: 0 }),
}));
vi.mock('../../../core/admin/import.js', () => ({
  importTasks: vi.fn().mockResolvedValue({ imported: 0 }),
}));
vi.mock('../../../core/admin/export-tasks.js', () => ({
  exportTasksPackage: vi.fn().mockResolvedValue({ tasks: [] }),
}));
vi.mock('../../../core/admin/import-tasks.js', () => ({
  importTasksPackage: vi.fn().mockResolvedValue({ imported: 0 }),
}));
vi.mock('../../../core/admin/sync.js', () => ({
  getSyncStatus: vi.fn().mockResolvedValue({ success: true, data: {} }),
  clearSyncState: vi.fn().mockResolvedValue({ success: true, data: {} }),
}));

// Snapshot
vi.mock('../../../core/snapshot/index.js', () => ({
  exportSnapshot: vi.fn().mockResolvedValue({
    _meta: { taskCount: 0, checksum: 'abc', createdAt: '2026-01-01', source: 'test' },
    tasks: [],
  }),
  writeSnapshot: vi.fn().mockResolvedValue(undefined),
  readSnapshot: vi.fn().mockResolvedValue({
    _meta: { taskCount: 0, checksum: 'abc', createdAt: '2026-01-01', source: 'test' },
    tasks: [],
  }),
  importSnapshot: vi.fn().mockResolvedValue({ added: 0, updated: 0, skipped: 0, conflicts: [] }),
  getDefaultSnapshotPath: vi.fn(() => '/mock/snapshot.json'),
}));

// Token service
vi.mock('../../../core/metrics/token-service.js', () => ({
  clearTokenUsage: vi.fn().mockResolvedValue({ cleared: 0 }),
  deleteTokenUsage: vi.fn().mockResolvedValue({ deleted: true }),
  listTokenUsage: vi.fn().mockResolvedValue({ records: [], total: 0, filtered: 0 }),
  recordTokenExchange: vi.fn().mockResolvedValue({ id: 'tok_1' }),
  showTokenUsage: vi.fn().mockResolvedValue({ id: 'tok_1' }),
  summarizeTokenUsage: vi.fn().mockResolvedValue({ total: 0 }),
}));

// Scaffold
vi.mock('../../../core/scaffold.js', () => ({
  ensureProjectContext: vi.fn().mockResolvedValue({ created: false }),
  ensureContributorMcp: vi.fn().mockResolvedValue({ updated: false }),
  ensureGlobalScaffold: vi.fn().mockResolvedValue({ created: false }),
  ensureGlobalTemplates: vi.fn().mockResolvedValue({ created: false }),
}));

// Issue diagnostics
vi.mock('../../../core/issue/diagnostics.js', () => ({
  collectDiagnostics: vi.fn(() => ({ cleo: {}, node: {} })),
}));

// CAAMP skills & providers
vi.mock('@cleocode/caamp', () => ({
  catalog: {
    getDispatchMatrix: vi.fn(() => ({ by_task_type: {}, by_keyword: {}, by_protocol: {} })),
    getSkill: vi.fn(),
    getSkillDependencies: vi.fn(() => []),
    resolveDependencyTree: vi.fn(() => []),
    listProtocols: vi.fn(() => []),
    getProtocolPath: vi.fn(),
    listProfiles: vi.fn(() => []),
    getProfile: vi.fn(),
    listSharedResources: vi.fn(() => []),
    getSharedResourcePath: vi.fn(),
    isCatalogAvailable: vi.fn(() => true),
    getVersion: vi.fn(() => '1.0.0'),
    getLibraryRoot: vi.fn(() => '/mock/lib'),
    getSkills: vi.fn(() => []),
  },
  discoverSkill: vi.fn().mockResolvedValue(null),
  discoverSkills: vi.fn().mockResolvedValue([]),
  getCanonicalSkillsDir: vi.fn(() => '/mock/skills'),
  installSkill: vi.fn().mockResolvedValue({ success: true, errors: [] }),
  removeSkill: vi.fn().mockResolvedValue({ removed: [], errors: [] }),
  getInstalledProviders: vi.fn(() => []),
  getAllProviders: vi.fn(() => []),
  detectAllProviders: vi.fn(() => []),
  getTrackedSkills: vi.fn().mockResolvedValue({}),
  checkAllSkillUpdates: vi.fn().mockResolvedValue({}),
  checkAllInjections: vi.fn().mockResolvedValue([]),
  injectAll: vi.fn().mockResolvedValue(new Map()),
  buildInjectionContent: vi.fn(() => ''),
  getProvidersBySpawnCapability: vi.fn(() => []),
  providerSupportsById: vi.fn(() => false),
}));

// Precedence integration
vi.mock('../../../core/skills/precedence-integration.js', () => ({
  getSkillsMapWithPrecedence: vi.fn(() => ({})),
  resolveSkillPathsForProvider: vi.fn().mockResolvedValue([]),
  determineInstallationTargets: vi.fn().mockResolvedValue([]),
}));

// Session grade
vi.mock('../../../core/sessions/session-grade.js', () => ({
  gradeSession: vi.fn().mockResolvedValue({ grade: 'A', score: 95 }),
  readGrades: vi.fn().mockResolvedValue([]),
}));

// Chain validation
vi.mock('../../../core/validation/chain-validation.js', () => ({
  validateChain: vi.fn(() => ({ errors: [], warnings: [] })),
}));

// Chain store
vi.mock('../../../core/lifecycle/chain-store.js', () => ({
  showChain: vi.fn().mockResolvedValue({ id: 'chain1', stages: [] }),
  listChains: vi.fn().mockResolvedValue([]),
  addChain: vi.fn().mockResolvedValue(undefined),
  createInstance: vi.fn().mockResolvedValue({ id: 'inst1' }),
  advanceInstance: vi.fn().mockResolvedValue({ id: 'inst1' }),
}));

// Release channel
vi.mock('../../../core/release/channel.js', () => ({
  resolveChannelFromBranch: vi.fn(() => 'latest'),
  channelToDistTag: vi.fn(() => 'latest'),
  describeChannel: vi.fn(() => 'Stable releases'),
}));

// Tessera engine
vi.mock('../../../core/lifecycle/tessera-engine.js', () => ({
  showTessera: vi.fn(() => ({ id: 'tpl1', name: 'test', stages: [] })),
  listTesseraTemplates: vi.fn(() => []),
  instantiateTessera: vi.fn().mockResolvedValue({ id: 'inst1' }),
}));

// Session memory
vi.mock('../../../core/sessions/session-memory.js', () => ({
  persistSessionMemory: vi.fn().mockResolvedValue(undefined),
}));

// Nexus registry
vi.mock('../../../core/nexus/registry.js', () => ({
  nexusInit: vi.fn().mockResolvedValue(undefined),
  nexusRegister: vi.fn().mockResolvedValue('hash123'),
  nexusUnregister: vi.fn().mockResolvedValue(undefined),
  nexusList: vi.fn().mockResolvedValue([]),
  nexusSync: vi.fn().mockResolvedValue(undefined),
  nexusSyncAll: vi.fn().mockResolvedValue({ synced: [] }),
  nexusGetProject: vi.fn().mockResolvedValue({ name: 'test', path: '/mock' }),
  nexusReconcile: vi.fn().mockResolvedValue({ reconciled: 0 }),
  readRegistry: vi.fn().mockResolvedValue({ projects: {}, lastUpdated: '2026-01-01' }),
  type: undefined,
}));

// Nexus query
vi.mock('../../../core/nexus/query.js', () => ({
  resolveTask: vi
    .fn()
    .mockResolvedValue({ id: 'T001', title: 'Test', status: 'pending', _project: 'test' }),
  parseQuery: vi.fn(() => ({ project: 'test', taskId: 'T001' })),
  validateSyntax: vi.fn(() => true),
}));

// Nexus deps
vi.mock('../../../core/nexus/deps.js', () => ({
  nexusDeps: vi.fn().mockResolvedValue({ deps: [] }),
  buildGlobalGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
  criticalPath: vi.fn().mockResolvedValue({ path: [] }),
  blockingAnalysis: vi.fn().mockResolvedValue({ blockers: [] }),
  orphanDetection: vi.fn().mockResolvedValue([]),
}));

// Nexus permissions
vi.mock('../../../core/nexus/permissions.js', () => ({
  setPermission: vi.fn().mockResolvedValue(undefined),
}));

// Data accessor
vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn().mockResolvedValue({
    loadTaskFile: vi.fn().mockResolvedValue({ tasks: [] }),
  }),
}));

// Nexus sharing
vi.mock('../../../core/nexus/sharing/index.js', () => ({
  getSharingStatus: vi.fn().mockResolvedValue({ sharing: false }),
}));

// Sticky engine
vi.mock('../../engines/sticky-engine.js', () => ({
  stickyAdd: vi.fn().mockResolvedValue({ success: true, data: { id: 'stk1' } }),
  stickyList: vi.fn().mockResolvedValue({ success: true, data: { stickies: [], total: 0 } }),
  stickyShow: vi.fn().mockResolvedValue({ success: true, data: { id: 'stk1' } }),
  stickyConvertToTask: vi.fn().mockResolvedValue({ success: true, data: {} }),
  stickyConvertToMemory: vi.fn().mockResolvedValue({ success: true, data: {} }),
  stickyConvertToTaskNote: vi.fn().mockResolvedValue({ success: true, data: {} }),
  stickyConvertToSessionNote: vi.fn().mockResolvedValue({ success: true, data: {} }),
  stickyArchive: vi.fn().mockResolvedValue({ success: true, data: {} }),
  stickyPurge: vi.fn().mockResolvedValue({ success: true, data: {} }),
}));

// System engine (direct import for tools domain)
vi.mock('../../engines/system-engine.js', () => ({
  systemSync: vi.fn().mockReturnValue({ success: true, data: {} }),
}));

// Hooks engine
vi.mock('../../engines/hooks-engine.js', () => ({
  queryHookProviders: vi.fn().mockResolvedValue({ success: true, data: { providers: [] } }),
}));

// Job manager
vi.mock('../../../mcp/lib/job-manager-accessor.js', () => ({
  getJobManager: vi.fn(() => ({
    getJob: vi.fn(() => ({ id: 'job1', status: 'running' })),
    listJobs: vi.fn(() => []),
    cancelJob: vi.fn(() => true),
  })),
}));

// child_process (for pipeline release.channel.show)
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => 'main\n'),
}));

// ===========================================================================
// Imports (AFTER mocks)
// ===========================================================================

import { OPERATIONS, type OperationDef } from '../../registry.js';
import { createDomainHandlers } from '../index.js';

// ===========================================================================
// Test configuration
// ===========================================================================

/**
 * Minimal params to satisfy required-parameter checks so the handler
 * reaches the engine call rather than returning E_INVALID_INPUT.
 * We only need enough to avoid early validation bail-out.
 */
const MINIMAL_PARAMS: Record<string, Record<string, Record<string, unknown>>> = {
  tasks: {
    show: { taskId: 'T001' },
    exists: { taskId: 'T001' },
    depends: { taskId: 'T001' },
    relates: { taskId: 'T001' },
    'relates.find': { taskId: 'T001' },
    'complexity.estimate': { taskId: 'T001' },
    'label.show': { label: 'bug' },
    add: { title: 'Test task' },
    update: { taskId: 'T001' },
    complete: { taskId: 'T001' },
    delete: { taskId: 'T001' },
    restore: { taskId: 'T001' },
    cancel: { taskId: 'T001' },
    reopen: { taskId: 'T001' },
    unarchive: { taskId: 'T001' },
    reparent: { taskId: 'T001' },
    promote: { taskId: 'T001' },
    reorder: { taskId: 'T001', position: 1 },
    'relates.add': { taskId: 'T001', relatedId: 'T002', type: 'blocks' },
    start: { taskId: 'T001' },
  },
  session: {
    show: { sessionId: 'sess1' },
    start: { scope: 'global' },
    resume: { sessionId: 'sess1' },
    suspend: { sessionId: 'sess1' },
    'record.decision': { decision: 'x', rationale: 'y' },
    'record.assumption': { assumption: 'x', confidence: 'high' },
    'context.inject': { protocolType: 'research' },
  },
  check: {
    schema: { type: 'task', data: {} },
    task: { taskId: 'T001' },
    output: { filePath: '/mock/file.ts' },
    protocol: { taskId: 'T001' },
    'gate.status': { taskId: 'T001' },
    grade: { sessionId: 'sess1' },
    'chain.validate': { chain: { id: 'c1', stages: [] } },
    'compliance.record': { taskId: 'T001', result: 'pass' },
    'gate.set': { taskId: 'T001' },
  },
  admin: {
    'adr.show': { adrId: 'ADR-001' },
    token: { action: 'summary' },
    config: { action: 'show' },
    'config.set': { key: 'test' },
    cleanup: { target: 'backups' },
    'job.cancel': { jobId: 'job1' },
    'context.inject': { protocolType: 'research' },
    import: { file: '/mock/import.json' },
    safestop: {},
  },
  memory: {
    find: { query: 'test' },
    timeline: { anchor: 'obs_1' },
    fetch: { ids: ['obs_1'] },
    observe: { text: 'test observation' },
    'decision.store': { decision: 'x', rationale: 'y' },
    'pattern.store': { pattern: 'x', context: 'y' },
    'learning.store': { insight: 'x', source: 'y' },
    link: { taskId: 'T001', entryId: 'obs_1' },
    'graph.show': { nodeId: 'n1' },
    'graph.neighbors': { nodeId: 'n1' },
    'reason.why': { taskId: 'T001' },
    'reason.similar': { entryId: 'obs_1' },
    'search.hybrid': { query: 'test' },
  },
  pipeline: {
    'stage.validate': { epicId: 'T001', targetStage: 'research' },
    'stage.status': { epicId: 'T001' },
    'stage.history': { taskId: 'T001' },
    'stage.record': { taskId: 'T001', stage: 'research', status: 'complete' },
    'stage.skip': { taskId: 'T001', stage: 'research', reason: 'test' },
    'stage.reset': { taskId: 'T001', stage: 'research', reason: 'test' },
    'stage.gate': { taskId: 'T001', gateName: 'g1', action: 'pass' },
    'release.show': { version: '1.0.0' },
    'release.ship': { version: '1.0.0', epicId: 'T001' },
    'release.rollback': { version: '1.0.0' },
    'release.cancel': { version: '1.0.0' },
    'manifest.show': { entryId: 'e1' },
    'manifest.find': { query: 'test' },
    'manifest.append': { entry: { id: 'e1', type: 'finding', content: 'x' } },
    'manifest.archive': { beforeDate: '2026-01-01' },
    'phase.show': { phaseId: 'p1' },
    'phase.set': { phaseId: 'p1' },
    'phase.rename': { oldName: 'old', newName: 'new' },
    'phase.delete': { phaseId: 'p1' },
    'chain.show': { chainId: 'c1' },
    'chain.add': { chain: { id: 'c1', stages: [] } },
    'chain.instantiate': { chainId: 'c1', epicId: 'T001' },
    'chain.advance': { instanceId: 'i1', nextStage: 's1' },
  },
  orchestrate: {
    next: { epicId: 'T001' },
    ready: { epicId: 'T001' },
    analyze: { epicId: 'T001' },
    waves: { epicId: 'T001' },
    start: { epicId: 'T001' },
    spawn: { taskId: 'T001' },
    handoff: { taskId: 'T001', protocolType: 'impl' },
    'spawn.execute': { taskId: 'T001' },
    validate: { taskId: 'T001' },
    parallel: { action: 'start', epicId: 'T001', wave: 1 },
    'tessera.instantiate': { templateId: 'tpl1', epicId: 'T001' },
  },
  tools: {
    'skill.show': { name: 'test' },
    'skill.dispatch': { name: 'test' },
    'skill.verify': { name: 'test' },
    'skill.dependencies': { name: 'test' },
    'provider.supports': { providerId: 'claude-code', capability: 'mcp' },
    'provider.hooks': { event: 'SessionStart' },
  },
  nexus: {
    show: { name: 'test' },
    resolve: { query: 'T001' },
    deps: { query: 'T001' },
    'path.show': {},
    'blockers.show': { query: 'T001' },
    discover: { query: 'T001' },
    search: { pattern: 'test' },
    register: { path: '/mock/project' },
    unregister: { name: 'test' },
    'permission.set': { name: 'test', level: 'read' },
    share: { action: 'status' },
  },
  sticky: {
    show: { stickyId: 'stk1' },
    add: { content: 'test note' },
    convert: { stickyId: 'stk1', targetType: 'task' },
    archive: { stickyId: 'stk1' },
    purge: { stickyId: 'stk1' },
  },
};

// ===========================================================================
// Tests
// ===========================================================================

describe('Registry-Handler Parity (T5671)', () => {
  let handlers: Map<string, import('../../types.js').DomainHandler>;

  beforeAll(() => {
    handlers = createDomainHandlers();
  });

  // Group operations by domain
  const opsByDomain = new Map<string, OperationDef[]>();
  for (const op of OPERATIONS) {
    const list = opsByDomain.get(op.domain) ?? [];
    list.push(op);
    opsByDomain.set(op.domain, list);
  }

  for (const [domain, ops] of opsByDomain) {
    describe(`${domain} domain (${ops.length} ops)`, () => {
      for (const op of ops) {
        it(`${op.gateway} ${domain}.${op.operation}`, async () => {
          const handler = handlers.get(domain);
          expect(handler, `No handler registered for domain: ${domain}`).toBeDefined();

          const params = MINIMAL_PARAMS[domain]?.[op.operation] ?? {};

          const result =
            op.gateway === 'query'
              ? await handler.query(op.operation, params)
              : await handler.mutate(op.operation, params);

          // The handler MUST NOT return E_INVALID_OPERATION.
          // Other errors (E_INVALID_INPUT, E_INTERNAL, etc.) are acceptable
          // because we may not have provided the right params.
          if (result.error?.code === 'E_INVALID_OPERATION') {
            expect.fail(
              `Handler for ${domain}.${op.operation} (${op.gateway}) returned E_INVALID_OPERATION. ` +
                `This means the ${domain} domain handler is missing a case for "${op.operation}".`,
            );
          }
        });
      }
    });
  }

  // Verify all 10 domains have handlers
  it('should have handlers for all 10 canonical domains', () => {
    const expectedDomains = [
      'tasks',
      'session',
      'memory',
      'check',
      'pipeline',
      'orchestrate',
      'tools',
      'admin',
      'nexus',
      'sticky',
    ];
    for (const domain of expectedDomains) {
      expect(handlers.has(domain), `Missing handler for domain: ${domain}`).toBe(true);
    }
  });

  // Summary assertion
  it('should cover all registered operations', () => {
    expect(OPERATIONS.length).toBeGreaterThan(0);
    // Sanity: verify we checked a reasonable number
    let totalOps = 0;
    for (const [, ops] of opsByDomain) {
      totalOps += ops.length;
    }
    expect(totalOps).toBe(OPERATIONS.length);
  });
});
