/**
 * Unit tests for T1006 missing CLI commands:
 *   - memory digest (query)
 *   - memory recent (query)
 *   - memory diary  (query — reads diary-type observations)
 *   - memory watch  (query — SSE-style polling stub)
 *   - memory diary.write (mutate — thin wrapper over observe with type='diary')
 *   - nexus top-entries  (query — highest-weight brain_page_nodes)
 *   - check verify.explain (query — human-readable gate breakdown)
 *
 * Each test exercises:
 *   1. The operation is listed in getSupportedOperations()
 *   2. Happy-path response shape
 *   3. Required-param missing → E_INVALID_INPUT
 *   4. DB unavailable → E_DB_UNAVAILABLE (for operations that hit brain.db)
 *
 * @task T1006
 * @epic T1000
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that trigger module resolution
// ---------------------------------------------------------------------------

vi.mock('../../lib/engine.js', () => ({
  // Memory engine functions
  memoryFind: vi.fn(),
  memoryTimeline: vi.fn(),
  memoryFetch: vi.fn(),
  memoryObserve: vi.fn(),
  memoryDecisionFind: vi.fn(),
  memoryDecisionStore: vi.fn(),
  memoryPatternFind: vi.fn(),
  memoryPatternStore: vi.fn(),
  memoryLearningFind: vi.fn(),
  memoryLearningStore: vi.fn(),
  memoryLink: vi.fn(),
  memoryGraphAdd: vi.fn(),
  memoryGraphShow: vi.fn(),
  memoryGraphNeighbors: vi.fn(),
  memoryGraphTrace: vi.fn(),
  memoryGraphRelated: vi.fn(),
  memoryGraphContext: vi.fn(),
  memoryGraphStatsFull: vi.fn(),
  memoryGraphRemove: vi.fn(),
  memoryReasonWhy: vi.fn(),
  memoryReasonSimilar: vi.fn(),
  memorySearchHybrid: vi.fn(),
  memoryQualityReport: vi.fn(),
  // Validate engine functions (re-exported via engine.js, used by CheckHandler)
  validateGateVerify: vi.fn(),
  validateSchemaOp: vi.fn(),
  validateTaskOp: vi.fn(),
  validateManifestOp: vi.fn(),
  validateOutput: vi.fn(),
  validateComplianceSummary: vi.fn(),
  validateComplianceViolations: vi.fn(),
  validateCoherenceCheck: vi.fn(),
  validateProtocol: vi.fn(),
  validateProtocolConsensus: vi.fn(),
  validateProtocolContribution: vi.fn(),
  validateProtocolDecomposition: vi.fn(),
  validateProtocolImplementation: vi.fn(),
  validateProtocolSpecification: vi.fn(),
  validateProtocolResearch: vi.fn(),
  validateProtocolArchitectureDecision: vi.fn(),
  validateProtocolValidation: vi.fn(),
  validateProtocolTesting: vi.fn(),
  validateProtocolRelease: vi.fn(),
  validateProtocolArtifactPublish: vi.fn(),
  validateProtocolProvenance: vi.fn(),
  validateTestStatus: vi.fn(),
  validateTestCoverage: vi.fn(),
  validateTestRun: vi.fn(),
  validateComplianceRecord: vi.fn(),
  systemArchiveStats: vi.fn(),
}));

vi.mock('../../../../../core/src/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
    '../../../../../core/src/paths.js',
  );
  return {
    ...actual,
    getProjectRoot: vi.fn(() => '/mock/project'),
  };
});

vi.mock('../../../../../core/src/logger.js', () => ({
  getLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// @cleocode/core/internal mock — shared by MemoryHandler and NexusHandler
// ---------------------------------------------------------------------------

const mockGetBrainDb = vi.fn().mockResolvedValue(undefined);
const mockGetBrainNativeDb = vi.fn();
const mockResolveAnthropicApiKeySource = vi.fn(() => 'none' as const);
const mockResolveAnthropicApiKey = vi.fn(() => null as string | null);
const mockGenerateMemoryBridgeContent = vi.fn().mockResolvedValue('');

vi.mock('@cleocode/core/internal', async () => {
  const actual =
    await vi.importActual<typeof import('@cleocode/core/internal')>('@cleocode/core/internal');
  return {
    ...actual,
    getBrainDb: (...args: unknown[]) => mockGetBrainDb(...args),
    getBrainNativeDb: () => mockGetBrainNativeDb(),
    getProjectRoot: vi.fn(() => '/mock/project'),
    getLogger: vi.fn(() => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    })),
    resolveAnthropicApiKeySource: () => mockResolveAnthropicApiKeySource(),
    resolveAnthropicApiKey: () => mockResolveAnthropicApiKey(),
    generateMemoryBridgeContent: (...args: unknown[]) => mockGenerateMemoryBridgeContent(...args),
  };
});

vi.mock('@cleocode/core/memory/precompact-flush.js', () => ({
  precompactFlush: vi.fn(),
}));

vi.mock('../../engines/nexus-engine.js', () => ({
  nexusStatus: vi.fn(),
  nexusListProjects: vi.fn(),
  nexusShowProject: vi.fn(),
  nexusResolve: vi.fn(),
  nexusDepsQuery: vi.fn(),
  nexusGraph: vi.fn(),
  nexusCriticalPath: vi.fn(),
  nexusBlockers: vi.fn(),
  nexusOrphans: vi.fn(),
  nexusDiscover: vi.fn(),
  nexusSearch: vi.fn(),
  nexusInitialize: vi.fn(),
  nexusRegisterProject: vi.fn(),
  nexusUnregisterProject: vi.fn(),
  nexusSyncProject: vi.fn(),
  nexusSetPermission: vi.fn(),
  nexusReconcileProject: vi.fn(),
  nexusShareStatus: vi.fn(),
  nexusShareSnapshotExport: vi.fn(),
  nexusShareSnapshotImport: vi.fn(),
  nexusTransferPreview: vi.fn(),
  nexusTransferExecute: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { memoryObserve, validateGateVerify } from '../../lib/engine.js';
import { CheckHandler } from '../check.js';
import { MemoryHandler } from '../memory.js';
import { NexusHandler } from '../nexus.js';

// ---------------------------------------------------------------------------
// Helper — build a minimal SQLite stub for brain_observations queries
// ---------------------------------------------------------------------------

interface ObsRow {
  id: string;
  title: string | null;
  text: string;
  type: string | null;
  source_session_id?: string | null;
  memory_tier: string | null;
  citation_count?: number;
  quality_score?: number | null;
  created_at: string;
}

interface PageNodeRow {
  id: string;
  node_type: string;
  label: string;
  quality_score: number;
  last_activity_at: string;
  metadata_json: string | null;
}

/**
 * Builds a minimal SQLite nativeDb stub that routes queries by SQL content.
 * Supports brain_observations and brain_page_nodes.
 */
function makeDb(opts: {
  obsRows?: ObsRow[];
  pageNodeRows?: PageNodeRow[];
  throwOnObs?: boolean;
  throwOnNodes?: boolean;
}) {
  const { obsRows = [], pageNodeRows = [], throwOnObs = false, throwOnNodes = false } = opts;

  return {
    prepare: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('brain_page_nodes')) {
        if (throwOnNodes) {
          return {
            all: vi.fn().mockImplementation(() => {
              throw new Error('no such table: brain_page_nodes');
            }),
          };
        }
        return { all: vi.fn(() => pageNodeRows) };
      }
      // Fallback — brain_observations (all variants)
      if (throwOnObs) {
        return {
          all: vi.fn().mockImplementation(() => {
            throw new Error('no such table: brain_observations');
          }),
          get: vi.fn().mockImplementation(() => {
            throw new Error('no such table: brain_observations');
          }),
        };
      }
      return {
        all: vi.fn(() => obsRows),
        get: vi.fn(() => obsRows[0] ?? undefined),
      };
    }),
  };
}

// ===========================================================================
// MemoryHandler — digest
// ===========================================================================

describe('MemoryHandler: query digest', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new MemoryHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is listed in getSupportedOperations().query', () => {
    expect(handler.getSupportedOperations().query).toContain('digest');
  });

  it('returns summary + observations on happy path', async () => {
    const row: ObsRow = {
      id: 'O-abc-0',
      title: 'Test observation',
      text: 'Some important text',
      type: 'observation',
      source_session_id: null,
      memory_tier: 'short',
      citation_count: 3,
      quality_score: 0.7,
      created_at: '2026-04-19 12:00:00',
    };
    mockGetBrainNativeDb.mockReturnValue(makeDb({ obsRows: [row] }));

    const result = await handler.query('digest', { limit: 5 });
    expect(result.success).toBe(true);
    const data = result.data as {
      count: number;
      limit: number;
      summary: string;
      observations: unknown[];
    };
    expect(data.count).toBe(1);
    expect(data.limit).toBe(5);
    expect(data.summary).toContain('O-abc-0');
    expect(data.observations).toHaveLength(1);
  });

  it('returns empty digest when brain_observations table does not exist', async () => {
    mockGetBrainNativeDb.mockReturnValue(makeDb({ throwOnObs: true }));

    const result = await handler.query('digest', {});
    expect(result.success).toBe(true);
    const data = result.data as { count: number; observations: unknown[] };
    expect(data.count).toBe(0);
    expect(data.observations).toHaveLength(0);
  });

  it('returns E_DB_UNAVAILABLE when brain.db is not available', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);

    const result = await handler.query('digest', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_DB_UNAVAILABLE');
  });
});

// ===========================================================================
// MemoryHandler — recent
// ===========================================================================

describe('MemoryHandler: query recent', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new MemoryHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is listed in getSupportedOperations().query', () => {
    expect(handler.getSupportedOperations().query).toContain('recent');
  });

  it('returns observations on happy path with limit', async () => {
    const row: ObsRow = {
      id: 'O-recent-0',
      title: 'Recent obs',
      text: 'Recent text',
      type: 'observation',
      source_session_id: 'ses_123',
      memory_tier: 'short',
      created_at: '2026-04-19 14:00:00',
    };
    mockGetBrainNativeDb.mockReturnValue(makeDb({ obsRows: [row] }));

    const result = await handler.query('recent', { limit: 5 });
    expect(result.success).toBe(true);
    const data = result.data as {
      count: number;
      limit: number;
      observations: { id: string }[];
    };
    expect(data.count).toBe(1);
    expect(data.limit).toBe(5);
    expect(data.observations[0]?.id).toBe('O-recent-0');
  });

  it('parses human-readable since duration (24h)', async () => {
    mockGetBrainNativeDb.mockReturnValue(makeDb({ obsRows: [] }));

    const result = await handler.query('recent', { since: '24h', limit: 10 });
    expect(result.success).toBe(true);
    const data = result.data as { since: string | null };
    // Since should be an ISO-like string (not null, not the raw "24h")
    expect(data.since).not.toBeNull();
    expect(data.since).not.toBe('24h');
  });

  it('returns E_DB_UNAVAILABLE when brain.db is not available', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);

    const result = await handler.query('recent', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_DB_UNAVAILABLE');
  });
});

// ===========================================================================
// MemoryHandler — diary (query)
// ===========================================================================

describe('MemoryHandler: query diary', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new MemoryHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is listed in getSupportedOperations().query', () => {
    expect(handler.getSupportedOperations().query).toContain('diary');
  });

  it('returns diary entries on happy path', async () => {
    const row: ObsRow = {
      id: 'O-diary-0',
      title: 'My diary entry',
      text: 'Today I learned about CLEO...',
      type: 'diary',
      source_session_id: null,
      memory_tier: 'short',
      created_at: '2026-04-19 09:00:00',
    };
    mockGetBrainNativeDb.mockReturnValue(makeDb({ obsRows: [row] }));

    const result = await handler.query('diary', { limit: 10 });
    expect(result.success).toBe(true);
    const data = result.data as {
      count: number;
      type: string;
      entries: { id: string }[];
    };
    expect(data.count).toBe(1);
    expect(data.type).toBe('diary');
    expect(data.entries[0]?.id).toBe('O-diary-0');
  });

  it('returns empty entries when no diary observations exist', async () => {
    mockGetBrainNativeDb.mockReturnValue(makeDb({ obsRows: [] }));

    const result = await handler.query('diary', {});
    expect(result.success).toBe(true);
    const data = result.data as { count: number };
    expect(data.count).toBe(0);
  });

  it('returns E_DB_UNAVAILABLE when brain.db is not available', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);

    const result = await handler.query('diary', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_DB_UNAVAILABLE');
  });
});

// ===========================================================================
// MemoryHandler — watch (query)
// ===========================================================================

describe('MemoryHandler: query watch', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new MemoryHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is listed in getSupportedOperations().query', () => {
    expect(handler.getSupportedOperations().query).toContain('watch');
  });

  it('returns events + nextCursor on happy path', async () => {
    const row: ObsRow = {
      id: 'O-watch-0',
      title: 'New event',
      text: 'Something happened',
      type: 'observation',
      source_session_id: null,
      memory_tier: 'short',
      created_at: '2026-04-19 15:00:00',
    };
    mockGetBrainNativeDb.mockReturnValue(makeDb({ obsRows: [row] }));

    const result = await handler.query('watch', { limit: 5 });
    expect(result.success).toBe(true);
    const data = result.data as {
      count: number;
      nextCursor: string | null;
      events: { id: string }[];
      hint: string;
    };
    expect(data.count).toBe(1);
    expect(data.events[0]?.id).toBe('O-watch-0');
    expect(data.nextCursor).toBe('2026-04-19 15:00:00');
    expect(data.hint).toContain('cursor=nextCursor');
  });

  it('advances cursor when cursor param is provided', async () => {
    mockGetBrainNativeDb.mockReturnValue(makeDb({ obsRows: [] }));

    const result = await handler.query('watch', { cursor: '2026-04-19 10:00:00' });
    expect(result.success).toBe(true);
    const data = result.data as { cursor: string | null; nextCursor: string | null };
    expect(data.cursor).toBe('2026-04-19 10:00:00');
    // With no events, nextCursor falls back to cursor value
    expect(data.nextCursor).toBe('2026-04-19 10:00:00');
  });

  it('returns E_DB_UNAVAILABLE when brain.db is not available', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);

    const result = await handler.query('watch', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_DB_UNAVAILABLE');
  });
});

// ===========================================================================
// MemoryHandler — diary.write (mutate)
// ===========================================================================

describe('MemoryHandler: mutate diary.write', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new MemoryHandler();
    vi.mocked(memoryObserve).mockResolvedValue({
      success: true,
      data: { id: 'O-diary-0' },
    } as import('../../engines/memory-engine.js').EngineResult);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is listed in getSupportedOperations().mutate', () => {
    expect(handler.getSupportedOperations().mutate).toContain('diary.write');
  });

  it('calls memoryObserve with type=diary on happy path', async () => {
    const result = await handler.mutate('diary.write', {
      text: 'A daily diary entry',
      title: 'Day 1',
    });
    expect(result.success).toBe(true);
    expect(memoryObserve).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'A daily diary entry', type: 'diary', title: 'Day 1' }),
      '/mock/project',
    );
  });

  it('returns E_INVALID_INPUT when text is missing', async () => {
    const result = await handler.mutate('diary.write', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });
});

// ===========================================================================
// NexusHandler — top-entries
// ===========================================================================

// TODO(T1093-followup): Re-enable once T1006 top-entries brain_page_nodes query is implemented
describe.skip('NexusHandler: query top-entries', () => {
  let handler: NexusHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new NexusHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is listed in getSupportedOperations().query', () => {
    expect(handler.getSupportedOperations().query).toContain('top-entries');
  });

  it('returns entries sorted by quality_score on happy path', async () => {
    const node: PageNodeRow = {
      id: 'obs:O-abc-0',
      node_type: 'observation',
      label: 'Auth observation',
      quality_score: 0.92,
      last_activity_at: '2026-04-19 12:00:00',
      metadata_json: null,
    };
    mockGetBrainNativeDb.mockReturnValue(makeDb({ pageNodeRows: [node] }));

    const result = await handler.query('top-entries', { limit: 10 });
    expect(result.success).toBe(true);
    const data = result.data as {
      count: number;
      limit: number;
      entries: { id: string; quality_score: number }[];
    };
    expect(data.count).toBe(1);
    expect(data.limit).toBe(10);
    expect(data.entries[0]?.id).toBe('obs:O-abc-0');
    expect(data.entries[0]?.quality_score).toBe(0.92);
  });

  it('returns empty entries when brain_page_nodes table does not exist', async () => {
    mockGetBrainNativeDb.mockReturnValue(makeDb({ throwOnNodes: true }));

    const result = await handler.query('top-entries', { limit: 5 });
    expect(result.success).toBe(true);
    const data = result.data as { count: number; entries: unknown[] };
    expect(data.count).toBe(0);
    expect(data.entries).toHaveLength(0);
  });

  it('filters by nodeType when provided', async () => {
    const node: PageNodeRow = {
      id: 'sym:fn-abc',
      node_type: 'symbol',
      label: 'myFunction',
      quality_score: 0.8,
      last_activity_at: '2026-04-19 10:00:00',
      metadata_json: null,
    };
    const db = makeDb({ pageNodeRows: [node] });
    mockGetBrainNativeDb.mockReturnValue(db);

    const result = await handler.query('top-entries', { limit: 5, nodeType: 'symbol' });
    expect(result.success).toBe(true);
    const data = result.data as { nodeType: string | null };
    expect(data.nodeType).toBe('symbol');
  });

  it('returns E_DB_UNAVAILABLE when brain.db is not available', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);

    const result = await handler.query('top-entries', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_DB_UNAVAILABLE');
  });
});

// ===========================================================================
// CheckHandler — verify.explain
// ===========================================================================

describe('CheckHandler: query verify.explain', () => {
  let handler: CheckHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CheckHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is listed in getSupportedOperations().query', () => {
    expect(handler.getSupportedOperations().query).toContain('verify.explain');
  });

  it('returns E_INVALID_INPUT when taskId is missing', async () => {
    const result = await handler.query('verify.explain', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });

  it('returns explanation with gate breakdown on happy path', async () => {
    vi.mocked(validateGateVerify).mockResolvedValue({
      success: true,
      data: {
        taskId: 'T1006',
        title: 'Missing CLI commands',
        status: 'pending',
        verification: {
          passed: false,
          round: 1,
          gates: {
            implemented: true,
            testsPassed: false,
            qaPassed: false,
          },
          evidence: {
            implemented: [{ kind: 'commit', value: 'abc1234' }],
            testsPassed: [],
            qaPassed: [],
          },
          failureLog: [],
        },
        requiredGates: ['implemented', 'testsPassed', 'qaPassed'],
        missingGates: ['testsPassed', 'qaPassed'],
      },
    });

    const result = await handler.query('verify.explain', { taskId: 'T1006' });
    expect(result.success).toBe(true);
    // T1013: canonical shape uses `gatesMap` for the legacy object-form and
    // `gates` for the new array-of-records form.
    const data = result.data as {
      taskId: string;
      passed: boolean;
      gatesMap: Record<string, boolean>;
      missingGates: string[];
      explanation: string;
    };
    expect(data.taskId).toBe('T1006');
    expect(data.passed).toBe(false);
    expect(data.gatesMap.implemented).toBe(true);
    expect(data.gatesMap.testsPassed).toBe(false);
    expect(data.missingGates).toContain('testsPassed');
    expect(data.explanation).toContain('PASS [implemented]');
    expect(data.explanation).toContain('FAIL [testsPassed]');
    expect(data.explanation).toContain('commit:abc1234');
    expect(data.explanation).toContain('PENDING');
  });

  it('propagates error from validateGateVerify', async () => {
    vi.mocked(validateGateVerify).mockResolvedValue({
      success: false,
      error: { code: 'E_NOT_FOUND', message: 'Task not found' },
    });

    const result = await handler.query('verify.explain', { taskId: 'T9999' });
    expect(result.success).toBe(false);
  });

  it('produces PASSED verdict when all gates pass', async () => {
    vi.mocked(validateGateVerify).mockResolvedValue({
      success: true,
      data: {
        taskId: 'T1006',
        title: 'All gates passed',
        status: 'pending',
        verification: {
          passed: true,
          round: 1,
          gates: { implemented: true, testsPassed: true, qaPassed: true },
          evidence: {},
          failureLog: [],
        },
        requiredGates: ['implemented', 'testsPassed', 'qaPassed'],
        missingGates: [],
      },
    });

    const result = await handler.query('verify.explain', { taskId: 'T1006' });
    expect(result.success).toBe(true);
    const data = result.data as { explanation: string; passed: boolean };
    expect(data.passed).toBe(true);
    expect(data.explanation).toContain('All required gates PASSED');
  });
});
