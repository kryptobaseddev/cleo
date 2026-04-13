/**
 * Tests for observer-reflector.ts — LLM-driven session compression.
 *
 * Tests cover:
 * - runObserver: gates (no API key, disabled, below threshold), happy path, LLM failure graceful degradation
 * - runReflector: gates (no API key, disabled, insufficient observations), happy path, LLM failure graceful degradation
 * - Markdown code fence stripping from LLM responses
 * - Invalid entry skipping
 * - Confidence clamping
 *
 * Uses mocked Anthropic fetch and mocked brain-sqlite / store functions.
 *
 * @task T554
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Hoisted mock factories — must use vi.hoisted() so variables are available
// inside vi.mock() factory functions before import resolution.
// ============================================================================

const {
  mockGetBrainDb,
  mockGetBrainNativeDb,
  mockStoreLearning,
  mockStorePattern,
  mockLoadConfig,
} = vi.hoisted(() => ({
  mockGetBrainDb: vi.fn().mockResolvedValue({}),
  mockGetBrainNativeDb: vi.fn(),
  mockStoreLearning: vi.fn().mockResolvedValue({ id: 'L-test-001' }),
  mockStorePattern: vi.fn().mockResolvedValue({ id: 'P-test-001' }),
  mockLoadConfig: vi.fn(),
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

// ============================================================================
// Import module under test (after all mocks)
// ============================================================================

import { runObserver, runReflector } from '../observer-reflector.js';

// ============================================================================
// Helpers
// ============================================================================

const FAKE_API_KEY = 'sk-ant-test-key';

function setApiKey(key: string | undefined): void {
  if (key === undefined) {
    delete process.env['ANTHROPIC_API_KEY'];
  } else {
    process.env['ANTHROPIC_API_KEY'] = key;
  }
}

type RawObs = {
  id: string;
  type: string;
  title: string;
  narrative: string;
  created_at: string;
  source_type: string | null;
  source_session_id: string | null;
};

/** Build a mock native SQLite DB with configurable .all() / .get() / .prepare() behavior. */
function buildMockNativeDb(options: {
  observationCount?: number;
  observations?: RawObs[];
  insertSucceeds?: boolean;
}) {
  const { observationCount = 0, observations = [], insertSucceeds = true } = options;

  const mockRun = vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 0 });
  const mockAll = vi.fn().mockReturnValue(observations);
  const mockGet = vi.fn().mockReturnValue({ cnt: observationCount });

  const stmtMock = {
    run: mockRun,
    all: mockAll,
    get: mockGet,
  };

  if (!insertSucceeds) {
    mockRun.mockImplementation(() => {
      throw new Error('DB write error');
    });
  }

  return {
    prepare: vi.fn().mockReturnValue(stmtMock),
    _stmtMock: stmtMock,
  };
}

function makeObs(n: number, sessionId: string | null = null): RawObs[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `O-${String(i + 1).padStart(3, '0')}`,
    type: 'change',
    title: `Observation ${i + 1}`,
    narrative: `Narrative for observation ${i + 1}`,
    created_at: `2026-04-13 10:${String(i % 60).padStart(2, '0')}:00`,
    source_type: 'agent',
    source_session_id: sessionId,
  }));
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

// ============================================================================
// Tests: runObserver
// ============================================================================

describe('runObserver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue({
      brain: { observer: { enabled: true, threshold: 10 } },
    });
    setApiKey(undefined);
  });

  afterEach(() => {
    setApiKey(undefined);
    vi.restoreAllMocks();
  });

  it('returns empty result when ANTHROPIC_API_KEY is not set', async () => {
    mockGetBrainNativeDb.mockReturnValue(buildMockNativeDb({ observationCount: 20 }));
    const result = await runObserver('/tmp/project');

    expect(result.ran).toBe(false);
    expect(result.stored).toBe(0);
    expect(result.notes).toHaveLength(0);
  });

  it('returns empty result when observer is disabled in config', async () => {
    setApiKey(FAKE_API_KEY);
    mockLoadConfig.mockResolvedValue({
      brain: { observer: { enabled: false, threshold: 10 } },
    });
    mockGetBrainNativeDb.mockReturnValue(buildMockNativeDb({ observationCount: 20 }));

    const result = await runObserver('/tmp/project');
    expect(result.ran).toBe(false);
  });

  it('returns empty result when observation count is below threshold', async () => {
    setApiKey(FAKE_API_KEY);
    // count = 5, threshold = 10 → should not run
    mockGetBrainNativeDb.mockReturnValue(
      buildMockNativeDb({ observationCount: 5, observations: makeObs(5) }),
    );

    const result = await runObserver('/tmp/project', 'ses_test');
    expect(result.ran).toBe(false);
  });

  it('returns empty result when fetch fails (graceful degradation)', async () => {
    setApiKey(FAKE_API_KEY);
    mockGetBrainNativeDb.mockReturnValue(
      buildMockNativeDb({ observationCount: 12, observations: makeObs(12, 'ses_abc') }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const result = await runObserver('/tmp/project', 'ses_abc');
    expect(result.ran).toBe(false);
    expect(result.stored).toBe(0);

    fetchSpy.mockRestore();
  });

  it('stores observer notes when LLM returns valid JSON', async () => {
    setApiKey(FAKE_API_KEY);
    mockGetBrainNativeDb.mockReturnValue(
      buildMockNativeDb({ observationCount: 12, observations: makeObs(12, 'ses_abc') }),
    );

    const notes = [
      {
        date: '2026-04-13',
        priority: 1,
        observation:
          'Architectural decision: use SQLite for brain.db because WAL mode prevents corruption',
        source_ids: ['O-001', 'O-002', 'O-003'],
      },
      {
        date: '2026-04-13',
        priority: 3,
        observation: 'Fixed: task-hooks.ts missing observer call — added setImmediate wrapper',
        source_ids: ['O-004', 'O-005'],
      },
    ];

    const fetchSpy = mockFetchOk(JSON.stringify(notes));
    const result = await runObserver('/tmp/project', 'ses_abc');

    expect(result.ran).toBe(true);
    expect(result.stored).toBe(2);
    expect(result.notes).toHaveLength(2);
    expect(result.compressedIds).toContain('O-001');
    expect(result.compressedIds).toContain('O-004');

    fetchSpy.mockRestore();
  });

  it('returns empty result when LLM response is malformed JSON', async () => {
    setApiKey(FAKE_API_KEY);
    mockGetBrainNativeDb.mockReturnValue(
      buildMockNativeDb({ observationCount: 12, observations: makeObs(12) }),
    );
    const fetchSpy = mockFetchOk('not json at all {broken');

    const result = await runObserver('/tmp/project');
    expect(result.ran).toBe(false);
    expect(result.stored).toBe(0);

    fetchSpy.mockRestore();
  });

  it('strips markdown code fences from LLM response', async () => {
    setApiKey(FAKE_API_KEY);
    mockGetBrainNativeDb.mockReturnValue(
      buildMockNativeDb({ observationCount: 12, observations: makeObs(12) }),
    );

    const noteWithFence =
      '```json\n[{"date":"2026-04-13","priority":2,"observation":"Test note","source_ids":["O-001"]}]\n```';
    const fetchSpy = mockFetchOk(noteWithFence);

    const result = await runObserver('/tmp/project');
    expect(result.ran).toBe(true);
    expect(result.stored).toBe(1);
    expect(result.notes[0]?.observation).toBe('Test note');

    fetchSpy.mockRestore();
  });

  it('handles Anthropic API HTTP error gracefully', async () => {
    setApiKey(FAKE_API_KEY);
    mockGetBrainNativeDb.mockReturnValue(
      buildMockNativeDb({ observationCount: 15, observations: makeObs(15) }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    } as unknown as Response);

    const result = await runObserver('/tmp/project');
    expect(result.ran).toBe(false);

    fetchSpy.mockRestore();
  });
});

// ============================================================================
// Tests: runReflector
// ============================================================================

describe('runReflector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue({
      brain: { reflector: { enabled: true } },
    });
    setApiKey(undefined);
  });

  afterEach(() => {
    setApiKey(undefined);
    vi.restoreAllMocks();
  });

  it('returns empty result when ANTHROPIC_API_KEY is not set', async () => {
    const result = await runReflector('/tmp/project', 'ses_test');
    expect(result.ran).toBe(false);
    expect(result.patternsStored).toBe(0);
    expect(result.learningsStored).toBe(0);
  });

  it('returns empty result when reflector is disabled in config', async () => {
    setApiKey(FAKE_API_KEY);
    mockLoadConfig.mockResolvedValue({
      brain: { reflector: { enabled: false } },
    });
    mockGetBrainNativeDb.mockReturnValue(buildMockNativeDb({ observations: [] }));

    const result = await runReflector('/tmp/project', 'ses_test');
    expect(result.ran).toBe(false);
  });

  it('returns empty result when fewer than 3 observations exist', async () => {
    setApiKey(FAKE_API_KEY);
    mockGetBrainNativeDb.mockReturnValue(
      buildMockNativeDb({ observations: makeObs(2, 'ses_test') }),
    );

    const result = await runReflector('/tmp/project', 'ses_test');
    expect(result.ran).toBe(false);
  });

  it('stores patterns and learnings from valid LLM response', async () => {
    setApiKey(FAKE_API_KEY);
    mockGetBrainNativeDb.mockReturnValue(
      buildMockNativeDb({ observations: makeObs(8, 'ses_test') }),
    );

    const reflectorOutput = {
      patterns: [
        {
          pattern: 'When implementing hooks, always use setImmediate for async operations',
          context: 'task-hooks.ts',
        },
        {
          pattern: 'Observer threshold of 10 prevents excessive LLM calls per session',
          context: 'observer config',
        },
      ],
      learnings: [
        { insight: 'Observer/reflector adds 3-6x compression without data loss', confidence: 0.85 },
        { insight: 'SQLite INSERT OR IGNORE prevents observer infinite loops', confidence: 0.9 },
      ],
      superseded: ['O-001', 'O-002'],
    };

    const fetchSpy = mockFetchOk(JSON.stringify(reflectorOutput));
    const result = await runReflector('/tmp/project', 'ses_test');

    expect(result.ran).toBe(true);
    expect(result.patternsStored).toBe(2);
    expect(result.learningsStored).toBe(2);
    expect(result.supersededIds).toContain('O-001');
    expect(result.supersededIds).toContain('O-002');

    expect(mockStorePattern).toHaveBeenCalledTimes(2);
    expect(mockStorePattern).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({ source: 'reflector-synthesized' }),
    );
    expect(mockStoreLearning).toHaveBeenCalledTimes(2);
    expect(mockStoreLearning).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({ source: 'reflector-synthesized', confidence: 0.85 }),
    );

    fetchSpy.mockRestore();
  });

  it('clamps confidence to [0.1, 1.0] range', async () => {
    setApiKey(FAKE_API_KEY);
    mockGetBrainNativeDb.mockReturnValue(buildMockNativeDb({ observations: makeObs(5) }));

    const reflectorOutput = {
      patterns: [],
      learnings: [
        { insight: 'Something useful', confidence: -5.0 }, // clamp → 0.1
        { insight: 'Very certain fact', confidence: 99.0 }, // clamp → 1.0
      ],
      superseded: [],
    };

    const fetchSpy = mockFetchOk(JSON.stringify(reflectorOutput));
    await runReflector('/tmp/project');

    expect(mockStoreLearning).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({ confidence: 0.1 }),
    );
    expect(mockStoreLearning).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({ confidence: 1.0 }),
    );

    fetchSpy.mockRestore();
  });

  it('handles fetch failure gracefully', async () => {
    setApiKey(FAKE_API_KEY);
    mockGetBrainNativeDb.mockReturnValue(buildMockNativeDb({ observations: makeObs(5) }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));

    const result = await runReflector('/tmp/project');
    expect(result.ran).toBe(false);
    expect(result.patternsStored).toBe(0);
    expect(result.learningsStored).toBe(0);

    fetchSpy.mockRestore();
  });

  it('handles malformed LLM response gracefully', async () => {
    setApiKey(FAKE_API_KEY);
    mockGetBrainNativeDb.mockReturnValue(buildMockNativeDb({ observations: makeObs(5) }));
    const fetchSpy = mockFetchOk('{ this is not valid json ]');

    const result = await runReflector('/tmp/project');
    expect(result.ran).toBe(false);

    fetchSpy.mockRestore();
  });

  it('skips invalid pattern/learning entries without crashing', async () => {
    setApiKey(FAKE_API_KEY);
    mockGetBrainNativeDb.mockReturnValue(buildMockNativeDb({ observations: makeObs(5) }));

    const reflectorOutput = {
      patterns: [
        { pattern: '', context: 'empty — skip' },
        { pattern: 123, context: 'non-string — skip' },
        { pattern: 'Valid pattern here', context: 'good' },
      ],
      learnings: [
        { insight: null, confidence: 0.8 }, // null → skip
        { insight: 'Valid learning', confidence: 0.75 },
      ],
      superseded: [],
    };

    const fetchSpy = mockFetchOk(JSON.stringify(reflectorOutput));
    const result = await runReflector('/tmp/project');

    expect(result.ran).toBe(true);
    expect(result.patternsStored).toBe(1); // only the valid one
    expect(result.learningsStored).toBe(1); // only the valid one

    fetchSpy.mockRestore();
  });
});

// ============================================================================
// Tests: hook integration — verify exported handler functions exist
// ============================================================================

describe('hook wiring', () => {
  it('session-hooks exports handleSessionEndReflector', async () => {
    const mod = await import('../../hooks/handlers/session-hooks.js');
    expect(typeof mod.handleSessionEndReflector).toBe('function');
  });

  it('task-hooks exports handleToolComplete with observer wiring', async () => {
    const mod = await import('../../hooks/handlers/task-hooks.js');
    expect(typeof mod.handleToolComplete).toBe('function');
  });
});
