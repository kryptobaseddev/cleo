/**
 * Tests for sleep-consolidation.ts — LLM-driven background memory hygiene.
 *
 * Tests cover:
 * - runSleepConsolidation: config gate (disabled), no-API-key graceful no-op
 * - stepMergeDuplicates: structural merge fallback, LLM merge decision
 * - stepPruneStale: no candidates, LLM preserve decision, structural prune
 * - stepStrengthenPatterns: no candidates, LLM synthesis, pattern stored
 * - stepGenerateInsights: too few observations, cluster + insight stored
 * - All LLM call failures are caught and result in graceful degradation
 *
 * Uses mocked Anthropic fetch and mocked brain-sqlite / store functions.
 *
 * @task T555
 * @epic T549
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Hoisted mock factories
// ============================================================================

const {
  mockGetBrainDb,
  mockGetBrainNativeDb,
  mockStoreLearning,
  mockStorePattern,
  mockLoadConfig,
  mockResolveKey,
} = vi.hoisted(() => ({
  mockGetBrainDb: vi.fn().mockResolvedValue({}),
  mockGetBrainNativeDb: vi.fn(),
  mockStoreLearning: vi.fn().mockResolvedValue({ id: 'L-test-001' }),
  mockStorePattern: vi.fn().mockResolvedValue({ id: 'P-test-001' }),
  mockLoadConfig: vi.fn(),
  mockResolveKey: vi.fn().mockReturnValue(null),
}));

vi.mock('../../store/brain-sqlite.js', () => ({
  getBrainDb: mockGetBrainDb,
  getBrainNativeDb: mockGetBrainNativeDb,
}));

vi.mock('../learnings.js', () => ({
  storeLearning: mockStoreLearning,
}));

vi.mock('../patterns.js', () => ({
  storePattern: mockStorePattern,
}));

vi.mock('../graph-auto-populate.js', () => ({
  addGraphEdge: vi.fn().mockResolvedValue(undefined),
  upsertGraphNode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', () => ({
  loadConfig: mockLoadConfig,
}));

// Mock the key resolver so tests don't depend on filesystem state
// (~/.claude/.credentials.json, ~/.local/share/cleo/anthropic-key).
vi.mock('../anthropic-key-resolver.js', () => ({
  resolveAnthropicApiKey: (...args: unknown[]) => mockResolveKey(...args),
  clearAnthropicKeyCache: vi.fn(),
}));

// ============================================================================
// Import module under test (after all mocks)
// ============================================================================

import { runSleepConsolidation } from '../sleep-consolidation.js';

// ============================================================================
// Helpers
// ============================================================================

const FAKE_API_KEY = 'sk-ant-test-key';

function setApiKey(key: string | undefined): void {
  if (key === undefined) {
    delete process.env['ANTHROPIC_API_KEY'];
    mockResolveKey.mockReturnValue(null);
  } else {
    process.env['ANTHROPIC_API_KEY'] = key;
    mockResolveKey.mockReturnValue(key);
  }
}

/** Build a Float32 embedding buffer with the given cosine direction (unit vector in first dim). */
function makeEmbedding(val: number): Buffer {
  const buf = Buffer.alloc(16); // 4 floats
  buf.writeFloatLE(val, 0);
  buf.writeFloatLE(0, 4);
  buf.writeFloatLE(0, 8);
  buf.writeFloatLE(0, 12);
  return buf;
}

type ObsRow = {
  id: string;
  title: string;
  narrative: string;
  quality_score: number;
  citation_count: number;
  memory_tier: string;
  created_at: string;
  embedding: Buffer | null;
};

type LearningRow = {
  id: string;
  insight: string;
  confidence: number;
  citation_count: number;
  source: string | null;
  memory_tier: string;
};

type PatternRow = {
  id: string;
  pattern: string;
  context: string;
  impact: string;
  frequency: number;
  memory_tier: string;
};

type TextRow = {
  id: string;
  text: string;
};

/** Build a mock native SQLite DB with per-table configurable behavior. */
function buildMockNativeDb(options: {
  obsRows?: ObsRow[];
  learningRows?: LearningRow[];
  patternRows?: PatternRow[];
  obsTextRows?: TextRow[];
  insertSucceeds?: boolean;
}) {
  const {
    obsRows = [],
    learningRows = [],
    patternRows = [],
    obsTextRows = [],
    insertSucceeds = true,
  } = options;

  const mockRun = vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 0 });

  if (!insertSucceeds) {
    mockRun.mockImplementation(() => {
      throw new Error('DB write error');
    });
  }

  // The prepare() mock captures the SQL and returns a statement mock whose
  // .all() returns rows routed by the SQL content. This correctly mirrors the
  // prepare(sql).all(params) call pattern used in sleep-consolidation.ts.
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const mockAll = vi.fn().mockImplementation((..._args: unknown[]) => {
      if (sql.includes('brain_learnings')) return learningRows;
      if (sql.includes('brain_patterns')) return patternRows;
      if (sql.includes('brain_observations') && sql.includes("memory_tier = 'short'"))
        return obsRows;
      if (sql.includes('brain_observations')) return obsTextRows;
      return [];
    });
    return { run: mockRun, all: mockAll, get: vi.fn().mockReturnValue({ cnt: 0 }) };
  });

  const stmtMock = {
    run: mockRun,
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue({ cnt: 0 }),
  };
  return { prepare, _stmtMock: stmtMock };
}

function mockFetchOk(responseBody: string): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: responseBody }],
      stop_reason: 'end_turn',
    }),
  } as unknown as Response);
}

function mockFetchError(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
}

// ============================================================================
// Tests: runSleepConsolidation (top-level gates)
// ============================================================================

describe('runSleepConsolidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue({ brain: { sleepConsolidation: { enabled: true } } });
    setApiKey(undefined);
  });

  afterEach(() => {
    setApiKey(undefined);
    vi.restoreAllMocks();
  });

  it('returns ran=false when sleepConsolidation is disabled in config', async () => {
    mockLoadConfig.mockResolvedValue({
      brain: { sleepConsolidation: { enabled: false } },
    });
    mockGetBrainNativeDb.mockReturnValue(buildMockNativeDb({}));

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.ran).toBe(false);
  });

  it('returns ran=true and all-zero counts when no API key and no DB entries', async () => {
    mockGetBrainNativeDb.mockReturnValue(buildMockNativeDb({}));

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.ran).toBe(true);
    expect(result.mergeDuplicates.merged).toBe(0);
    expect(result.pruneStale.pruned).toBe(0);
    expect(result.strengthenPatterns.synthesized).toBe(0);
    expect(result.generateInsights.insightsStored).toBe(0);
  });

  it('returns ran=true even when DB is unavailable (null nativeDb)', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.ran).toBe(true);
    expect(result.mergeDuplicates.merged).toBe(0);
  });

  it('never throws even when all LLM calls fail', async () => {
    setApiKey(FAKE_API_KEY);
    mockFetchError();
    mockGetBrainNativeDb.mockReturnValue(
      buildMockNativeDb({
        obsRows: [
          {
            id: 'O-001',
            title: 'Test',
            narrative: 'Some text',
            quality_score: 0.3,
            citation_count: 0,
            memory_tier: 'short',
            created_at: '2026-01-01 00:00:00',
            embedding: makeEmbedding(1.0),
          },
        ],
      }),
    );

    await expect(runSleepConsolidation('/tmp/project')).resolves.not.toThrow();
  });

  it('defaults to enabled=true when config load fails', async () => {
    mockLoadConfig.mockRejectedValue(new Error('Config unavailable'));
    mockGetBrainNativeDb.mockReturnValue(buildMockNativeDb({}));

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.ran).toBe(true);
  });
});

// ============================================================================
// Tests: Merge Duplicates (Step 1)
// ============================================================================

describe('runSleepConsolidation — merge duplicates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue({ brain: { sleepConsolidation: { enabled: true } } });
  });

  afterEach(() => {
    setApiKey(undefined);
    vi.restoreAllMocks();
  });

  it('merges two observations with high embedding similarity (structural fallback, no key)', async () => {
    setApiKey(undefined);
    const embedding = makeEmbedding(1.0); // identical embeddings → similarity 1.0

    const mockDb = buildMockNativeDb({
      obsRows: [
        {
          id: 'O-001',
          title: 'First',
          narrative: 'Same content',
          quality_score: 0.8,
          citation_count: 2,
          memory_tier: 'short',
          created_at: '2026-04-10 10:00:00',
          embedding,
        },
        {
          id: 'O-002',
          title: 'Second',
          narrative: 'Same content duplicate',
          quality_score: 0.5,
          citation_count: 1,
          memory_tier: 'short',
          created_at: '2026-04-10 11:00:00',
          embedding,
        },
      ],
    });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.mergeDuplicates.merged).toBeGreaterThanOrEqual(1);
    // Should UPDATE the evicted entry's invalid_at
    expect(mockDb._stmtMock.run).toHaveBeenCalled();
  });

  it('skips merge when LLM says merge=false', async () => {
    setApiKey(FAKE_API_KEY);
    const embedding = makeEmbedding(1.0);

    const mockDb = buildMockNativeDb({
      obsRows: [
        {
          id: 'O-001',
          title: 'First',
          narrative: 'Content A',
          quality_score: 0.8,
          citation_count: 1,
          memory_tier: 'short',
          created_at: '2026-04-10 10:00:00',
          embedding,
        },
        {
          id: 'O-002',
          title: 'Second',
          narrative: 'Content B',
          quality_score: 0.7,
          citation_count: 1,
          memory_tier: 'short',
          created_at: '2026-04-10 11:00:00',
          embedding,
        },
      ],
    });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    // LLM says: do not merge
    mockFetchOk(JSON.stringify([{ pair: 0, merge: false, keep: 'O-001' }]));

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.mergeDuplicates.merged).toBe(0);
    expect(result.mergeDuplicates.llmDecisions).toBe(0);
  });

  it('skips entries with no embeddings (none to merge)', async () => {
    const mockDb = buildMockNativeDb({
      obsRows: [], // no embeddings available
    });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.mergeDuplicates.merged).toBe(0);
  });
});

// ============================================================================
// Tests: Prune Stale (Step 2)
// ============================================================================

describe('runSleepConsolidation — prune stale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue({ brain: { sleepConsolidation: { enabled: true } } });
  });

  afterEach(() => {
    setApiKey(undefined);
    vi.restoreAllMocks();
  });

  it('prunes stale entries (structural path, no API key)', async () => {
    setApiKey(undefined);
    const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const staleObs: ObsRow = {
      id: 'O-stale-001',
      title: 'Stale',
      narrative: 'Old low quality',
      quality_score: 0.2,
      citation_count: 0,
      memory_tier: 'short',
      created_at: staleDate,
      embedding: null,
    };

    // obsRows is returned for short-tier queries (prune step), obsTextRows for text queries
    const mockDb = buildMockNativeDb({ obsRows: [staleObs], obsTextRows: [] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.pruneStale.pruned).toBeGreaterThanOrEqual(1);
  });

  it('preserves entries the LLM marks as worth keeping', async () => {
    setApiKey(FAKE_API_KEY);
    const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const obsRow: ObsRow = {
      id: 'O-keep-001',
      title: 'Unique decision',
      narrative: 'Contains irreplaceable context',
      quality_score: 0.3,
      citation_count: 0,
      memory_tier: 'short',
      created_at: staleDate,
      embedding: null,
    };

    const mockDb = buildMockNativeDb({ obsRows: [obsRow], obsTextRows: [] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    // LLM says: preserve this entry
    mockFetchOk(JSON.stringify({ preserve: ['O-keep-001'] }));

    const result = await runSleepConsolidation('/tmp/project');
    // pruned=0 because the only candidate was preserved
    expect(result.pruneStale.preserved).toBe(1);
    expect(result.pruneStale.pruned).toBe(0);
  });

  it('handles LLM failure gracefully (falls back to prune all candidates)', async () => {
    setApiKey(FAKE_API_KEY);
    mockFetchError();

    const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const obsRow: ObsRow = {
      id: 'O-fallback-001',
      title: 'Low quality',
      narrative: 'Should be pruned',
      quality_score: 0.1,
      citation_count: 0,
      memory_tier: 'short',
      created_at: staleDate,
      embedding: null,
    };

    const mockDb = buildMockNativeDb({ obsRows: [obsRow], obsTextRows: [] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.pruneStale.pruned).toBe(1);
    expect(result.pruneStale.preserved).toBe(0);
  });

  it('returns zero counts when no stale candidates', async () => {
    const mockDb = buildMockNativeDb({ obsRows: [], obsTextRows: [] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.pruneStale.pruned).toBe(0);
    expect(result.pruneStale.preserved).toBe(0);
  });
});

// ============================================================================
// Tests: Strengthen Patterns (Step 3)
// ============================================================================

describe('runSleepConsolidation — strengthen patterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue({ brain: { sleepConsolidation: { enabled: true } } });
    setApiKey(FAKE_API_KEY);
  });

  afterEach(() => {
    setApiKey(undefined);
    vi.restoreAllMocks();
  });

  it('synthesizes high-citation learnings into a new pattern', async () => {
    const learnings: LearningRow[] = [
      {
        id: 'L-001',
        insight: 'Always run biome before committing',
        confidence: 0.9,
        citation_count: 5,
        source: 'agent',
        memory_tier: 'medium',
      },
      {
        id: 'L-002',
        insight: 'Run pnpm build after major changes',
        confidence: 0.85,
        citation_count: 4,
        source: 'agent',
        memory_tier: 'medium',
      },
    ];

    const mockDb = buildMockNativeDb({ learningRows: learnings, patternRows: [] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    mockFetchOk(
      JSON.stringify({
        patterns: [
          {
            pattern: 'Run quality gates (biome + build) before every commit',
            context: 'Derived from repeated learnings about pre-commit hygiene',
            impact: 'high',
          },
        ],
      }),
    );

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.strengthenPatterns.synthesized).toBe(2);
    expect(result.strengthenPatterns.patternsGenerated).toBe(1);
    expect(mockStorePattern).toHaveBeenCalledOnce();
    expect(mockStorePattern).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        type: 'optimization',
        source: 'sleep-consolidation',
      }),
    );
  });

  it('returns zero synthesized when no high-citation learnings exist', async () => {
    const mockDb = buildMockNativeDb({ learningRows: [], patternRows: [] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.strengthenPatterns.synthesized).toBe(0);
    expect(result.strengthenPatterns.patternsGenerated).toBe(0);
    expect(mockStorePattern).not.toHaveBeenCalled();
  });

  it('handles LLM returning empty patterns array gracefully', async () => {
    const learnings: LearningRow[] = [
      {
        id: 'L-001',
        insight: 'Some insight',
        confidence: 0.9,
        citation_count: 3,
        source: 'agent',
        memory_tier: 'medium',
      },
    ];
    const mockDb = buildMockNativeDb({ learningRows: learnings, patternRows: [] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    mockFetchOk(JSON.stringify({ patterns: [] }));

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.strengthenPatterns.synthesized).toBe(1);
    expect(result.strengthenPatterns.patternsGenerated).toBe(0);
    expect(mockStorePattern).not.toHaveBeenCalled();
  });

  it('skips patterns with empty or missing pattern text', async () => {
    const learnings: LearningRow[] = [
      {
        id: 'L-001',
        insight: 'Some insight',
        confidence: 0.9,
        citation_count: 3,
        source: 'agent',
        memory_tier: 'medium',
      },
    ];
    const mockDb = buildMockNativeDb({ learningRows: learnings, patternRows: [] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    mockFetchOk(JSON.stringify({ patterns: [{ pattern: '', context: 'No text', impact: 'low' }] }));

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.strengthenPatterns.patternsGenerated).toBe(0);
  });

  it('degrades gracefully when no API key is set', async () => {
    setApiKey(undefined);

    const learnings: LearningRow[] = [
      {
        id: 'L-001',
        insight: 'Some insight',
        confidence: 0.9,
        citation_count: 5,
        source: 'agent',
        memory_tier: 'medium',
      },
    ];
    const mockDb = buildMockNativeDb({ learningRows: learnings, patternRows: [] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await runSleepConsolidation('/tmp/project');
    // synthesized count is still reported (candidates found), but no patterns stored
    expect(result.strengthenPatterns.synthesized).toBe(1);
    expect(result.strengthenPatterns.patternsGenerated).toBe(0);
    expect(mockStorePattern).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Tests: Generate Insights (Step 4)
// ============================================================================

describe('runSleepConsolidation — generate insights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue({ brain: { sleepConsolidation: { enabled: true } } });
    setApiKey(FAKE_API_KEY);
  });

  afterEach(() => {
    setApiKey(undefined);
    vi.restoreAllMocks();
  });

  it('stores a cross-cutting insight from a valid cluster', async () => {
    // Need >= 5 observations to trigger clustering
    const obsTextRows: TextRow[] = Array.from({ length: 8 }, (_, i) => ({
      id: `O-${String(i + 1).padStart(3, '0')}`,
      // Intentionally share tokens "brain memory consolidation" so they cluster together
      text: `brain memory consolidation step ${i} dedup quality short tier entry update`,
    }));

    const mockDb = buildMockNativeDb({ obsRows: [], obsTextRows });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    mockFetchOk(
      JSON.stringify({
        insights: [
          {
            cluster: 0,
            insight: 'Brain consolidation runs best when short-tier entries are deduplicated first',
            confidence: 0.85,
          },
        ],
      }),
    );

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.generateInsights.clustersProcessed).toBeGreaterThanOrEqual(1);
    expect(result.generateInsights.insightsStored).toBe(1);
    expect(mockStoreLearning).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        source: 'sleep-consolidation',
        actionable: true,
      }),
    );
  });

  it('returns zero when fewer than 5 observations available', async () => {
    const obsTextRows: TextRow[] = [
      { id: 'O-001', text: 'only three entries' },
      { id: 'O-002', text: 'second entry' },
      { id: 'O-003', text: 'third entry' },
    ];

    const mockDb = buildMockNativeDb({ obsRows: [], obsTextRows });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.generateInsights.clustersProcessed).toBe(0);
    expect(result.generateInsights.insightsStored).toBe(0);
  });

  it('skips insights with confidence below 0.7', async () => {
    const obsTextRows: TextRow[] = Array.from({ length: 8 }, (_, i) => ({
      id: `O-${String(i + 1).padStart(3, '0')}`,
      text: `brain memory consolidation step ${i} dedup quality short tier entry update`,
    }));
    const mockDb = buildMockNativeDb({ obsRows: [], obsTextRows });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    mockFetchOk(
      JSON.stringify({
        insights: [{ cluster: 0, insight: 'Low confidence insight', confidence: 0.5 }],
      }),
    );

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.generateInsights.insightsStored).toBe(0);
    expect(mockStoreLearning).not.toHaveBeenCalled();
  });

  it('handles LLM failure gracefully', async () => {
    mockFetchError();

    const obsTextRows: TextRow[] = Array.from({ length: 8 }, (_, i) => ({
      id: `O-${String(i + 1).padStart(3, '0')}`,
      text: `brain memory consolidation step ${i} dedup quality short tier entry update`,
    }));
    const mockDb = buildMockNativeDb({ obsRows: [], obsTextRows });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.generateInsights.clustersProcessed).toBeGreaterThanOrEqual(0);
    expect(result.generateInsights.insightsStored).toBe(0);
    expect(mockStoreLearning).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Tests: JSON parse helper (via LLM response path)
// ============================================================================

describe('runSleepConsolidation — JSON response handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue({ brain: { sleepConsolidation: { enabled: true } } });
    setApiKey(FAKE_API_KEY);
  });

  afterEach(() => {
    setApiKey(undefined);
    vi.restoreAllMocks();
  });

  it('handles markdown-fenced JSON responses from LLM', async () => {
    const learnings: LearningRow[] = [
      {
        id: 'L-001',
        insight: 'Some insight',
        confidence: 0.9,
        citation_count: 3,
        source: 'agent',
        memory_tier: 'medium',
      },
    ];
    const mockDb = buildMockNativeDb({ learningRows: learnings, patternRows: [] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    // Simulate LLM wrapping JSON in markdown code fences
    const fencedJson =
      '```json\n' +
      JSON.stringify({
        patterns: [
          {
            pattern: 'Fenced pattern test',
            context: 'From markdown-wrapped response',
            impact: 'medium',
          },
        ],
      }) +
      '\n```';

    mockFetchOk(fencedJson);

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.strengthenPatterns.patternsGenerated).toBe(1);
  });

  it('gracefully handles invalid (non-JSON) LLM responses', async () => {
    const learnings: LearningRow[] = [
      {
        id: 'L-001',
        insight: 'Some insight',
        confidence: 0.9,
        citation_count: 3,
        source: 'agent',
        memory_tier: 'medium',
      },
    ];
    const mockDb = buildMockNativeDb({ learningRows: learnings, patternRows: [] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    mockFetchOk('This is not JSON at all, just plain text.');

    const result = await runSleepConsolidation('/tmp/project');
    expect(result.strengthenPatterns.synthesized).toBe(1);
    expect(result.strengthenPatterns.patternsGenerated).toBe(0);
  });
});
