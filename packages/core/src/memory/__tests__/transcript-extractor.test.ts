/**
 * Unit tests for the TranscriptExtractor pipeline.
 *
 * Tests cover:
 *   - JSONL decoding (`decodeJsonlTranscript`)
 *   - Backend resolver integration (mocked)
 *   - Extraction pipeline with mocked LLM
 *   - Tombstone idempotency
 *   - Dry-run mode
 *
 * No real LLM calls are made. Network and filesystem operations are mocked
 * or skipped in CI (controlled by `OLLAMA_AVAILABLE` env var).
 *
 * @task T730
 * @epic T726
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before imports
// ---------------------------------------------------------------------------

vi.mock('../llm-backend-resolver.js', () => ({
  resolveLlmBackend: vi.fn(),
  isOllamaAvailable: vi.fn().mockResolvedValue(false),
}));

vi.mock('../decisions.js', () => ({
  storeDecision: vi.fn().mockResolvedValue({ id: 'D-mock' }),
}));

vi.mock('../patterns.js', () => ({
  storePattern: vi.fn().mockResolvedValue({ id: 'P-mock' }),
}));

vi.mock('../learnings.js', () => ({
  storeLearning: vi.fn().mockResolvedValue({ id: 'L-mock' }),
}));

vi.mock('../brain-retrieval.js', () => ({
  observeBrain: vi
    .fn()
    .mockResolvedValue({ id: 'O-mock', type: 'discovery', createdAt: '2026-04-15' }),
}));

vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainDb: vi.fn().mockResolvedValue({}),
  getBrainNativeDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
    }),
  }),
}));

// Mock Vercel AI SDK generateObject
vi.mock('ai', () => ({
  generateObject: vi.fn(),
}));

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { readFile, stat } from 'node:fs/promises';
import { generateObject } from 'ai';
import { observeBrain } from '../brain-retrieval.js';
import { storeDecision } from '../decisions.js';
import { storeLearning } from '../learnings.js';
import type { ResolvedBackend } from '../llm-backend-resolver.js';
import { resolveLlmBackend } from '../llm-backend-resolver.js';
import { storePattern } from '../patterns.js';
import type { ExtractionResult } from '../transcript-extractor.js';
import { decodeJsonlTranscript, extractTranscript } from '../transcript-extractor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_BACKEND: ResolvedBackend = {
  model: {} as ResolvedBackend['model'],
  name: 'anthropic',
  modelId: 'claude-sonnet-4-6',
};

const FIXTURE_JSONL = `{"type":"file-history-snapshot","messageId":"abc123"}
{"type":"user","message":{"role":"user","content":"What is the best way to handle migrations in CLEO?"},"sessionId":"test-session-001"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Use incremental migrations with rollback support. Always test on a copy first."}]},"sessionId":"test-session-001"}
{"type":"user","message":{"role":"user","content":"Should we use Drizzle or raw SQL?"},"sessionId":"test-session-001"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Drizzle v1 beta is the mandated ORM for CLEO. Raw SQL only for performance-critical queries."}]},"sessionId":"test-session-001"}
`;

const MOCK_EXTRACTION_RESPONSE = {
  memories: [
    {
      type: 'decision' as const,
      content: 'Use Drizzle v1 beta as the ORM for CLEO because it provides type-safe queries',
      importance: 0.85,
      entities: ['drizzle-orm', 'CLEO'],
      justification: 'Owner-mandated choice with type safety rationale',
    },
    {
      type: 'pattern' as const,
      content: 'Always test migrations on a copy before applying to live database',
      importance: 0.75,
      entities: ['migrations'],
      justification: 'Prevents data loss during schema changes',
    },
    {
      type: 'learning' as const,
      content: 'Drizzle v1 beta is the standard ORM for CLEO projects',
      importance: 0.7,
      entities: ['drizzle-orm'],
      justification: 'Team decision captured from session',
    },
  ],
};

// ---------------------------------------------------------------------------
// decodeJsonlTranscript tests
// ---------------------------------------------------------------------------

describe('decodeJsonlTranscript', () => {
  it('extracts user and assistant turns from valid JSONL', () => {
    const result = decodeJsonlTranscript(FIXTURE_JSONL);

    expect(result).toContain('[user]: What is the best way to handle migrations');
    expect(result).toContain('[assistant]: Use incremental migrations');
    expect(result).toContain('[user]: Should we use Drizzle or raw SQL?');
    expect(result).toContain('[assistant]: Drizzle v1 beta is the mandated ORM');
  });

  it('skips file-history-snapshot entries', () => {
    const result = decodeJsonlTranscript(FIXTURE_JSONL);
    expect(result).not.toContain('file-history-snapshot');
    expect(result).not.toContain('abc123');
  });

  it('handles string content', () => {
    const jsonl = `{"type":"user","message":{"role":"user","content":"Simple string content"},"sessionId":"s1"}`;
    const result = decodeJsonlTranscript(jsonl);
    expect(result).toBe('[user]: Simple string content');
  });

  it('handles array content blocks including tool_use (T1002: full-fidelity)', () => {
    // T1002: tool_use blocks are now included alongside text blocks.
    const jsonl = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Block 1"},{"type":"tool_use","id":"t1"},{"type":"text","text":"Block 2"}]}}`;
    const result = decodeJsonlTranscript(jsonl);
    // All blocks appear in the output
    expect(result).toContain('Block 1');
    expect(result).toContain('Block 2');
    expect(result).toContain('tool_use');
  });

  it('returns empty string for empty input', () => {
    expect(decodeJsonlTranscript('')).toBe('');
    expect(decodeJsonlTranscript('\n\n\n')).toBe('');
  });

  it('skips malformed JSON lines without throwing', () => {
    const jsonl = `{"type":"user","message":{"role":"user","content":"Valid line"}}\nNOT JSON\n{"type":"user","message":{"role":"user","content":"Another valid"}}`;
    const result = decodeJsonlTranscript(jsonl);
    expect(result).toContain('Valid line');
    expect(result).toContain('Another valid');
  });

  it('includes thinking blocks (T1002: full-fidelity — filter removed)', () => {
    // T1002 removed the `.filter(b => b.type === 'text')` from decodeJsonlTranscript.
    // Thinking blocks are now included in the decoded output alongside text blocks.
    const jsonl = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Internal thought"},{"type":"text","text":"Visible response"}]}}`;
    const result = decodeJsonlTranscript(jsonl);
    // Post-fix: both thinking and text content must appear
    expect(result).toContain('Visible response');
    expect(result).toContain('Internal thought');
  });
});

// ---------------------------------------------------------------------------
// extractTranscript tests
// ---------------------------------------------------------------------------

describe('extractTranscript', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Default: backend available + successful extraction
    vi.mocked(resolveLlmBackend).mockResolvedValue(MOCK_BACKEND);
    vi.mocked(readFile).mockResolvedValue(FIXTURE_JSONL);
    vi.mocked(stat).mockResolvedValue({ size: 1024, mtimeMs: Date.now() } as Parameters<
      typeof stat
    >[0] extends string
      ? never
      : Awaited<ReturnType<typeof stat>>);
    vi.mocked(generateObject).mockResolvedValue({
      object: MOCK_EXTRACTION_RESPONSE,
      usage: { promptTokens: 100, completionTokens: 200 },
      finishReason: 'stop',
      warnings: [],
    } as Awaited<ReturnType<typeof generateObject>>);

    // Default: no tombstone present (allow extraction to proceed)
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    vi.mocked(getBrainNativeDb).mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]), // empty = no existing tombstone
      }),
    } as ReturnType<typeof getBrainNativeDb>);
  });

  it('returns extraction result with correct counts', async () => {
    const result: ExtractionResult = await extractTranscript({
      transcriptPath: '/tmp/test-session.jsonl',
      projectRoot: '/test/project',
      sessionId: 'test-session-001',
      tier: 'cold',
    });

    expect(result.sessionId).toBe('test-session-001');
    expect(result.backend).toBe('anthropic');
    expect(result.extractedCount).toBe(3);
    expect(result.storedCount).toBe(3);
    expect(result.rejectedCount).toBe(0);
    expect(result.deleted).toBe(true);
  });

  it('routes decisions to storeDecision', async () => {
    await extractTranscript({
      transcriptPath: '/tmp/test-session.jsonl',
      projectRoot: '/test/project',
      sessionId: 'test-session-001',
    });

    expect(storeDecision).toHaveBeenCalledOnce();
    const decisionCall = vi.mocked(storeDecision).mock.calls[0];
    expect(decisionCall[1]).toMatchObject({
      type: 'technical',
      confidence: 'high', // importance 0.85 → high
    });
  });

  it('routes patterns to storePattern', async () => {
    await extractTranscript({
      transcriptPath: '/tmp/test-session.jsonl',
      projectRoot: '/test/project',
      sessionId: 'test-session-001',
    });

    expect(storePattern).toHaveBeenCalledOnce();
    expect(vi.mocked(storePattern).mock.calls[0][1]).toMatchObject({
      type: 'workflow',
    });
  });

  it('routes learnings to storeLearning', async () => {
    await extractTranscript({
      transcriptPath: '/tmp/test-session.jsonl',
      projectRoot: '/test/project',
      sessionId: 'test-session-001',
    });

    expect(storeLearning).toHaveBeenCalledOnce();
  });

  it('writes tombstone observation after extraction', async () => {
    await extractTranscript({
      transcriptPath: '/tmp/test-session.jsonl',
      projectRoot: '/test/project',
      sessionId: 'test-session-001',
    });

    expect(observeBrain).toHaveBeenCalledWith(
      '/test/project',
      expect.objectContaining({
        title: 'transcript-extracted:test-session-001',
        type: 'discovery',
        sourceSessionId: 'test-session-001',
      }),
    );
  });

  it('tags extracted memories with transcript source', async () => {
    await extractTranscript({
      transcriptPath: '/tmp/test-session.jsonl',
      projectRoot: '/test/project',
      sessionId: 'test-session-001',
    });

    // Verify source tag on pattern call
    expect(vi.mocked(storePattern).mock.calls[0][1]).toMatchObject({
      source: 'transcript-warm-extract:test-session-001',
    });
  });

  it('dry-run: does not store memories or delete file', async () => {
    const result = await extractTranscript({
      transcriptPath: '/tmp/test-session.jsonl',
      projectRoot: '/test/project',
      sessionId: 'test-session-001',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.storedCount).toBe(0);
    expect(result.deleted).toBe(false);
    expect(storeDecision).not.toHaveBeenCalled();
    expect(storeLearning).not.toHaveBeenCalled();
    expect(storePattern).not.toHaveBeenCalled();
    expect(observeBrain).not.toHaveBeenCalled();
  });

  it('dry-run: still returns extracted count', async () => {
    const result = await extractTranscript({
      transcriptPath: '/tmp/test-session.jsonl',
      projectRoot: '/test/project',
      sessionId: 'test-session-001',
      dryRun: true,
    });

    expect(result.extractedCount).toBe(3);
  });

  it('filters memories below importance threshold', async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        memories: [
          {
            type: 'learning' as const,
            content: 'Low importance item',
            importance: 0.3, // below 0.6 threshold
            entities: [],
            justification: 'Not very important',
          },
          {
            type: 'decision' as const,
            content: 'High importance decision because it changes architecture',
            importance: 0.9,
            entities: ['architecture'],
            justification: 'Critical design choice',
          },
        ],
      },
      usage: { promptTokens: 50, completionTokens: 100 },
      finishReason: 'stop',
      warnings: [],
    } as Awaited<ReturnType<typeof generateObject>>);

    const result = await extractTranscript({
      transcriptPath: '/tmp/test-session.jsonl',
      projectRoot: '/test/project',
      sessionId: 'test-session-001',
    });

    expect(result.extractedCount).toBe(2);
    expect(result.storedCount).toBe(1); // only the 0.9 importance one
    expect(result.rejectedCount).toBe(1); // the 0.3 one was filtered
  });

  it('returns null backend warning when no backend available', async () => {
    vi.mocked(resolveLlmBackend).mockResolvedValue(null);

    const result = await extractTranscript({
      transcriptPath: '/tmp/test-session.jsonl',
      projectRoot: '/test/project',
      sessionId: 'test-session-001',
    });

    expect(result.backend).toBe('none');
    expect(result.extractedCount).toBe(0);
    expect(result.warnings.some((w) => w.includes('No LLM backend'))).toBe(true);
  });

  it('skips already-extracted sessions (tombstone check)', async () => {
    // Mock tombstone check to return existing record
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    vi.mocked(getBrainNativeDb).mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([{ id: 'O-existing' }]),
      }),
    } as ReturnType<typeof getBrainNativeDb>);

    const result = await extractTranscript({
      transcriptPath: '/tmp/test-session.jsonl',
      projectRoot: '/test/project',
      sessionId: 'test-session-001',
    });

    expect(result.extractedCount).toBe(0);
    expect(result.warnings.some((w) => w.includes('Already extracted'))).toBe(true);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('handles LLM call failure gracefully', async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error('API rate limit'));

    const result = await extractTranscript({
      transcriptPath: '/tmp/test-session.jsonl',
      projectRoot: '/test/project',
      sessionId: 'test-session-001',
    });

    expect(result.extractedCount).toBe(0);
    expect(result.warnings.some((w) => w.includes('LLM extraction call failed'))).toBe(true);
    // Should not throw
  });

  it('handles JSONL read failure gracefully', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('File not found'));

    const result = await extractTranscript({
      transcriptPath: '/tmp/nonexistent.jsonl',
      projectRoot: '/test/project',
      sessionId: 'missing-session',
    });

    expect(result.warnings.some((w) => w.includes('Failed to read JSONL'))).toBe(true);
    expect(result.extractedCount).toBe(0);
  });

  it('derives sessionId from filename if not provided', async () => {
    const result = await extractTranscript({
      transcriptPath: '/tmp/abc-123-def.jsonl',
      projectRoot: '/test/project',
    });

    expect(result.sessionId).toBe('abc-123-def');
  });

  it('cold tier uses Sonnet model identifier', async () => {
    // Verify resolveLlmBackend is called with 'cold' tier
    await extractTranscript({
      transcriptPath: '/tmp/test-session.jsonl',
      projectRoot: '/test/project',
      sessionId: 'test-session-001',
      tier: 'cold',
    });

    expect(resolveLlmBackend).toHaveBeenCalledWith('cold');
  });
});
