/**
 * T726 Wave 1A — Dedup gate tests.
 *
 * Verifies:
 *   T736 — LLM extraction storeExtracted() routes through dedup gate.
 *   T737 — checkHashDedup extended to all 4 brain tables.
 *   T741/T743 — tier_promoted_at + tier_promotion_reason columns in Drizzle schema
 *               and written by runTierPromotion.
 *   T746 — brain_decisions + brain_patterns Drizzle DEFAULT is 'medium'.
 *
 * Mock architecture follows vitest hoisting rules — all vi.hoisted() and
 * vi.mock() calls are at the top level of the file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Hoisted mock factories
// ============================================================================

const {
  mockGetBrainDb,
  mockGetBrainNativeDb,
  mockStoreDecision,
  mockStorePattern,
  mockStoreLearning,
  mockVerifyAndStore,
  mockCheckHashDedup,
  mockLoadConfig,
  mockResolveKey,
  mockZodOutputFormat,
  mockGetBrainDbPromo,
  mockGetBrainNativeDbPromo,
} = vi.hoisted(() => ({
  mockGetBrainDb: vi.fn().mockResolvedValue({}),
  mockGetBrainNativeDb: vi.fn(),
  mockStoreDecision: vi.fn().mockResolvedValue({ id: 'D001' }),
  mockStorePattern: vi.fn().mockResolvedValue({ id: 'P-mock' }),
  mockStoreLearning: vi.fn().mockResolvedValue({ id: 'L-mock' }),
  mockVerifyAndStore: vi
    .fn()
    .mockResolvedValue({ action: 'stored', id: 'L-new', reason: 'verified-new' }),
  mockCheckHashDedup: vi.fn().mockResolvedValue({ matched: false }),
  mockLoadConfig: vi.fn().mockResolvedValue({
    brain: {
      llmExtraction: {
        enabled: true,
        model: 'claude-haiku-4-5-20251001',
        minImportance: 0.6,
        maxExtractions: 7,
        maxTranscriptChars: 60000,
      },
    },
  }),
  mockResolveKey: vi.fn().mockReturnValue(null),
  mockZodOutputFormat: vi.fn().mockReturnValue({ _mock: 'zodOutputFormat' }),
  mockGetBrainDbPromo: vi.fn().mockResolvedValue({}),
  mockGetBrainNativeDbPromo: vi.fn(),
}));

// ============================================================================
// Module mocks (top-level, hoisted by vitest)
// ============================================================================

vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainDb: mockGetBrainDb,
  getBrainNativeDb: mockGetBrainNativeDb,
}));

vi.mock('../decisions.js', () => ({
  storeDecision: mockStoreDecision,
}));

vi.mock('../patterns.js', () => ({
  storePattern: mockStorePattern,
}));

vi.mock('../learnings.js', () => ({
  storeLearning: mockStoreLearning,
}));

vi.mock('../extraction-gate.js', () => ({
  verifyAndStore: mockVerifyAndStore,
  checkHashDedup: mockCheckHashDedup,
  verifyCandidate: vi
    .fn()
    .mockResolvedValue({ action: 'stored', id: null, reason: 'verified-new' }),
  verifyBatch: vi.fn().mockResolvedValue([]),
  verifyAndStoreBatch: vi.fn().mockResolvedValue([]),
  storeVerifiedCandidate: vi.fn().mockResolvedValue('L-mock'),
}));

vi.mock('../../config.js', () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock('@anthropic-ai/sdk/helpers/zod', () => ({
  zodOutputFormat: mockZodOutputFormat,
}));

vi.mock('../../llm/credentials.js', () => ({
  resolveAnthropicApiKey: mockResolveKey,
}));

// ============================================================================
// Constants
// ============================================================================

const PROJECT_ROOT = '/fake/project';

// ============================================================================
// T746 — Schema DEFAULT values
// ============================================================================

describe('T746 — Drizzle schema DEFAULT values', () => {
  it('brain_decisions.memoryTier has Drizzle DEFAULT medium', async () => {
    const { brainDecisions } = await import('../../store/memory-schema.js');
    const col = (brainDecisions as unknown as Record<string, { default?: unknown }>).memoryTier;
    expect(col?.default).toBe('medium');
  });

  it('brain_patterns.memoryTier has Drizzle DEFAULT medium', async () => {
    const { brainPatterns } = await import('../../store/memory-schema.js');
    const col = (brainPatterns as unknown as Record<string, { default?: unknown }>).memoryTier;
    expect(col?.default).toBe('medium');
  });

  it('brain_learnings.memoryTier retains DEFAULT short (learnings start short)', async () => {
    const { brainLearnings } = await import('../../store/memory-schema.js');
    const col = (brainLearnings as unknown as Record<string, { default?: unknown }>).memoryTier;
    // learnings legitimately start at 'short' — only decisions/patterns are fixed to 'medium'
    expect(col?.default).toBe('short');
  });
});

// ============================================================================
// T741 — tier_promoted_at + tier_promotion_reason columns exist in schema
// ============================================================================

describe('T741 — tier_promoted_at + tier_promotion_reason columns exist in schema', () => {
  it('brain_decisions has tierPromotedAt column', async () => {
    const { brainDecisions } = await import('../../store/memory-schema.js');
    expect(brainDecisions.tierPromotedAt).toBeDefined();
  });

  it('brain_decisions has tierPromotionReason column', async () => {
    const { brainDecisions } = await import('../../store/memory-schema.js');
    expect(brainDecisions.tierPromotionReason).toBeDefined();
  });

  it('brain_patterns has tierPromotedAt column', async () => {
    const { brainPatterns } = await import('../../store/memory-schema.js');
    expect(brainPatterns.tierPromotedAt).toBeDefined();
  });

  it('brain_patterns has tierPromotionReason column', async () => {
    const { brainPatterns } = await import('../../store/memory-schema.js');
    expect(brainPatterns.tierPromotionReason).toBeDefined();
  });

  it('brain_learnings has tierPromotedAt column', async () => {
    const { brainLearnings } = await import('../../store/memory-schema.js');
    expect(brainLearnings.tierPromotedAt).toBeDefined();
  });

  it('brain_observations has tierPromotedAt column', async () => {
    const { brainObservations } = await import('../../store/memory-schema.js');
    expect(brainObservations.tierPromotedAt).toBeDefined();
  });
});

// ============================================================================
// T737 — checkHashDedup probes the correct table
//
// We test extraction-gate.ts directly without mocking it (the module mock
// above mocks it for llm-extraction tests only; we need the real function here).
// Use a separate describe with vi.doUnmock to get the real implementation.
// ============================================================================

describe('T737 — checkHashDedup probes the correct table', () => {
  const mockNativeDb = {
    prepare: vi.fn(),
  };
  const mockPrepare = {
    all: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBrainDb.mockResolvedValue({});
    mockGetBrainNativeDb.mockReturnValue(mockNativeDb);
    mockNativeDb.prepare.mockReturnValue(mockPrepare);
    mockPrepare.all.mockReturnValue([]);
  });

  it('probes brain_observations when table=brain_observations', async () => {
    // We need the real extraction-gate — use vi.importActual to bypass the mock
    const { checkHashDedup } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    await checkHashDedup(PROJECT_ROOT, 'some text', 'brain_observations');
    expect(mockNativeDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining('brain_observations'),
    );
  });

  it('probes brain_decisions when table=brain_decisions', async () => {
    const { checkHashDedup } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    await checkHashDedup(PROJECT_ROOT, 'some text', 'brain_decisions');
    expect(mockNativeDb.prepare).toHaveBeenCalledWith(expect.stringContaining('brain_decisions'));
  });

  it('probes brain_patterns when table=brain_patterns', async () => {
    const { checkHashDedup } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    await checkHashDedup(PROJECT_ROOT, 'some text', 'brain_patterns');
    expect(mockNativeDb.prepare).toHaveBeenCalledWith(expect.stringContaining('brain_patterns'));
  });

  it('probes brain_learnings when table=brain_learnings', async () => {
    const { checkHashDedup } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    await checkHashDedup(PROJECT_ROOT, 'some text', 'brain_learnings');
    expect(mockNativeDb.prepare).toHaveBeenCalledWith(expect.stringContaining('brain_learnings'));
  });

  it('returns matched=true when the query returns a row', async () => {
    mockPrepare.all.mockReturnValue([{ id: 'L-abc123' }]);
    const { checkHashDedup } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    const result = await checkHashDedup(PROJECT_ROOT, 'test content', 'brain_learnings');
    expect(result).toEqual({ matched: true, id: 'L-abc123' });
  });

  it('returns matched=false when no row found', async () => {
    mockPrepare.all.mockReturnValue([]);
    const { checkHashDedup } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    const result = await checkHashDedup(PROJECT_ROOT, 'test content', 'brain_learnings');
    expect(result).toEqual({ matched: false });
  });
});

// ============================================================================
// T736 — LLM extraction routes through dedup gate
// ============================================================================

describe('T736 — storeExtracted routes all types through dedup gate', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Build a mock Anthropic client that returns one extraction. */
  function makeMockClient(
    type: 'decision' | 'pattern' | 'learning' | 'constraint' | 'correction',
    content: string,
  ) {
    const memories = [
      {
        type,
        content,
        importance: 0.75,
        entities: [],
        justification: 'Test justification',
      },
    ];
    // `parse` is the preferred path when zodOutputFormat is available (mocked above).
    // `create` is the degraded path used when format is null.
    // Both must return the expected shape so tests pass regardless of which path runs.
    return {
      messages: {
        parse: vi.fn().mockResolvedValue({
          parsed_output: { memories },
        }),
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'text',
              text: JSON.stringify({ memories }),
            },
          ],
        }),
      },
    };
  }

  it('decision type runs checkHashDedup on brain_decisions before calling storeDecision', async () => {
    mockResolveKey.mockReturnValue('fake-key');
    mockCheckHashDedup.mockResolvedValue({ matched: false });

    const { extractFromTranscript } = await import('../llm-extraction.js');
    await extractFromTranscript({
      projectRoot: PROJECT_ROOT,
      sessionId: 'ses_test',
      transcript: 'We decided to use TypeScript strict mode.',
      client: makeMockClient('decision', 'Use TypeScript strict mode because it catches more bugs'),
    });

    expect(mockCheckHashDedup).toHaveBeenCalledWith(
      PROJECT_ROOT,
      expect.any(String),
      'brain_decisions',
    );
  });

  it('decision type skips storeDecision when hash dedup returns matched=true', async () => {
    mockResolveKey.mockReturnValue('fake-key');
    mockCheckHashDedup.mockResolvedValue({ matched: true, id: 'D001' });

    const { extractFromTranscript } = await import('../llm-extraction.js');
    const report = await extractFromTranscript({
      projectRoot: PROJECT_ROOT,
      sessionId: 'ses_test_dedup',
      transcript: 'We decided to use TypeScript strict mode.',
      client: makeMockClient('decision', 'Use TypeScript strict mode because it catches more bugs'),
    });

    expect(mockStoreDecision).not.toHaveBeenCalled();
    expect(report.mergedCount).toBe(1);
    expect(report.storedCount).toBe(0);
  });

  it('learning type routes through verifyAndStore gate', async () => {
    mockResolveKey.mockReturnValue('fake-key');
    mockVerifyAndStore.mockResolvedValue({ action: 'stored', id: 'L-new', reason: 'verified-new' });

    const { extractFromTranscript } = await import('../llm-extraction.js');
    const report = await extractFromTranscript({
      projectRoot: PROJECT_ROOT,
      sessionId: 'ses_test_learning',
      transcript: 'SQLite WAL mode improved performance.',
      client: makeMockClient('learning', 'SQLite WAL mode improves concurrent read performance'),
    });

    expect(mockVerifyAndStore).toHaveBeenCalledOnce();
    expect(report.storedCount).toBe(1);
    // storeLearning must NOT have been called directly
    expect(mockStoreLearning).not.toHaveBeenCalled();
  });

  it('pattern type routes through verifyAndStore with procedural memoryType', async () => {
    mockResolveKey.mockReturnValue('fake-key');
    mockVerifyAndStore.mockResolvedValue({ action: 'stored', id: 'P-new', reason: 'verified-new' });

    const { extractFromTranscript } = await import('../llm-extraction.js');
    await extractFromTranscript({
      projectRoot: PROJECT_ROOT,
      sessionId: 'ses_test_pattern',
      transcript: 'Always run biome before commit.',
      client: makeMockClient('pattern', 'Always run biome check before committing'),
    });

    expect(mockVerifyAndStore).toHaveBeenCalledWith(
      PROJECT_ROOT,
      expect.objectContaining({ memoryType: 'procedural' }),
    );
    expect(mockStorePattern).not.toHaveBeenCalled();
  });

  it('duplicate learning via verifyAndStore returns merged', async () => {
    mockResolveKey.mockReturnValue('fake-key');
    mockVerifyAndStore.mockResolvedValue({
      action: 'merged',
      id: 'L-existing',
      reason: 'hash match',
    });

    const { extractFromTranscript } = await import('../llm-extraction.js');
    const report = await extractFromTranscript({
      projectRoot: PROJECT_ROOT,
      sessionId: 'ses_test_dup',
      transcript: 'SQLite WAL mode improved performance.',
      client: makeMockClient('learning', 'SQLite WAL mode improves concurrent read performance'),
    });

    expect(report.mergedCount).toBe(1);
    expect(report.storedCount).toBe(0);
    expect(mockStoreLearning).not.toHaveBeenCalled();
  });
});

// ============================================================================
// T743 — runTierPromotion persists tier_promoted_at + tier_promotion_reason
// ============================================================================

describe('T743 — runTierPromotion persists tier_promoted_at + tier_promotion_reason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function daysAgo(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
  }

  it('UPDATE statement for short→medium includes tier_promoted_at and tier_promotion_reason', async () => {
    const capturedSqls: string[] = [];
    const mockDb = {
      prepare: vi.fn((sql: string) => {
        capturedSqls.push(sql);
        return {
          run: vi.fn().mockReturnValue({ changes: 1 }),
          all: vi.fn().mockImplementation(() => {
            // First SELECT for short→medium returns one promotable row
            if (sql.includes("memory_tier = 'short'") && sql.includes('SELECT')) {
              return [{ id: 'O-test001', citation_count: 4, quality_score: 0.5, verified: 0 }];
            }
            return [];
          }),
        };
      }),
    };

    mockGetBrainNativeDbPromo.mockReturnValue(mockDb);
    mockGetBrainDbPromo.mockResolvedValue({});

    // Use memory-sqlite mock with promo-specific mocks
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    vi.mocked(getBrainDb).mockResolvedValue(
      {} as ReturnType<typeof getBrainDb> extends Promise<infer T> ? T : never,
    );
    vi.mocked(getBrainNativeDb).mockReturnValue(mockDb as ReturnType<typeof getBrainNativeDb>);

    const { runTierPromotion } = await import('../brain-lifecycle.js');
    await runTierPromotion(PROJECT_ROOT);

    // The UPDATE SQL for promotion must include tier_promoted_at
    const updateSqls = capturedSqls.filter(
      (s) => s.includes('UPDATE') && s.includes("memory_tier = 'medium'"),
    );
    expect(updateSqls.length).toBeGreaterThan(0);
    for (const sql of updateSqls) {
      expect(sql).toMatch(/tier_promoted_at/);
      expect(sql).toMatch(/tier_promotion_reason/);
    }
  });

  it('promoted record includes non-empty reason string', async () => {
    const mockDb = {
      prepare: vi.fn((sql: string) => ({
        run: vi.fn().mockReturnValue({ changes: 1 }),
        all: vi.fn().mockImplementation(() => {
          if (sql.includes("memory_tier = 'short'") && sql.includes('SELECT')) {
            return [{ id: 'O-test002', citation_count: 4, quality_score: 0.5, verified: 0 }];
          }
          return [];
        }),
      })),
    };

    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    vi.mocked(getBrainDb).mockResolvedValue(
      {} as ReturnType<typeof getBrainDb> extends Promise<infer T> ? T : never,
    );
    vi.mocked(getBrainNativeDb).mockReturnValue(mockDb as ReturnType<typeof getBrainNativeDb>);

    const { runTierPromotion } = await import('../brain-lifecycle.js');
    const result = await runTierPromotion(PROJECT_ROOT);

    for (const record of result.promoted) {
      expect(record.reason).toBeTruthy();
      expect(typeof record.reason).toBe('string');
    }
  });
});

// ============================================================================
// T993 — Check A0: title-prefix blocklist in verifyCandidate
//
// Uses vi.importActual to bypass the module-level mock of extraction-gate.js
// and exercise the real verifyCandidate implementation.
// ============================================================================

describe('T993 — Check A0 title-prefix blocklist in verifyCandidate', () => {
  const mockNativeDb = { prepare: vi.fn() };
  const mockPrepare = { all: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    // hash-dedup DB calls (Check A) — return no match so A0 is the only gate
    mockGetBrainDb.mockResolvedValue({});
    mockGetBrainNativeDb.mockReturnValue(mockNativeDb);
    mockNativeDb.prepare.mockReturnValue(mockPrepare);
    mockPrepare.all.mockReturnValue([]);
  });

  /** Minimal valid MemoryCandidate for the real verifyCandidate. */
  function makeCandidate(title: string) {
    return {
      text: 'Some non-empty content that does not match any hash.',
      title,
      memoryType: 'episodic' as const,
      tier: 'short' as const,
      confidence: 0.9,
      source: 'manual' as const,
      trusted: true,
    };
  }

  it('rejects "Task start: T123" — Check A0 noise-prefix', async () => {
    const { verifyCandidate } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    const result = await verifyCandidate(PROJECT_ROOT, makeCandidate('Task start: T123'));
    expect(result.action).toBe('rejected');
    expect(result.reason).toBe('noise-prefix');
  });

  it('rejects "Session note: handoff summary"', async () => {
    const { verifyCandidate } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    const result = await verifyCandidate(
      PROJECT_ROOT,
      makeCandidate('Session note: handoff summary'),
    );
    expect(result.action).toBe('rejected');
    expect(result.reason).toBe('noise-prefix');
  });

  it('rejects "Started work on: new feature"', async () => {
    const { verifyCandidate } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    const result = await verifyCandidate(
      PROJECT_ROOT,
      makeCandidate('Started work on: new feature'),
    );
    expect(result.action).toBe('rejected');
    expect(result.reason).toBe('noise-prefix');
  });

  it('rejects "Fix evidence: commit abc123"', async () => {
    const { verifyCandidate } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    const result = await verifyCandidate(
      PROJECT_ROOT,
      makeCandidate('Fix evidence: commit abc123'),
    );
    expect(result.action).toBe('rejected');
    expect(result.reason).toBe('noise-prefix');
  });

  it('rejects "Verified: T993 gates passed"', async () => {
    const { verifyCandidate } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    const result = await verifyCandidate(
      PROJECT_ROOT,
      makeCandidate('Verified: T993 gates passed'),
    );
    expect(result.action).toBe('rejected');
    expect(result.reason).toBe('noise-prefix');
  });

  it('passes "Hebbian plasticity insight" — legitimate title', async () => {
    const { verifyCandidate } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    const result = await verifyCandidate(PROJECT_ROOT, makeCandidate('Hebbian plasticity insight'));
    // A0 must NOT reject — action will be 'stored' or 'merged' depending on hash
    expect(result.action).not.toBe('rejected');
  });

  it('passes "Decision: SQLite over Y.js" — legitimate title', async () => {
    const { verifyCandidate } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    const result = await verifyCandidate(PROJECT_ROOT, makeCandidate('Decision: SQLite over Y.js'));
    expect(result.action).not.toBe('rejected');
  });

  it('BRAIN_NOISE_PREFIXES is exported and has at least 7 entries', async () => {
    const { BRAIN_NOISE_PREFIXES } =
      await vi.importActual<typeof import('../extraction-gate.js')>('../extraction-gate.js');
    expect(Array.isArray(BRAIN_NOISE_PREFIXES)).toBe(true);
    expect(BRAIN_NOISE_PREFIXES.length).toBeGreaterThanOrEqual(7);
  });
});
