/**
 * Unit tests for the LLM-driven extraction gate.
 *
 * The tests inject a mocked Anthropic client via the `client` option so no
 * real network calls or API keys are required. All downstream stores are
 * mocked so assertions target only the extraction routing logic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mocks ----------------------------------------------------------------

vi.mock('../../config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
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
}));

vi.mock('../learnings.js', () => ({
  storeLearning: vi.fn().mockResolvedValue({ id: 'L-mocked' }),
}));

vi.mock('../patterns.js', () => ({
  storePattern: vi.fn().mockResolvedValue({ id: 'P-mocked' }),
}));

vi.mock('../decisions.js', () => ({
  storeDecision: vi.fn().mockResolvedValue({ id: 'D-mocked' }),
}));

// T736: learnings, patterns, constraints, and corrections now route through
// the extraction gate (verifyAndStore) rather than calling store functions
// directly. Mock it so tests remain unit tests without touching the real gate.
vi.mock('../extraction-gate.js', () => ({
  verifyAndStore: vi
    .fn()
    .mockResolvedValue({ action: 'stored', id: 'VAS-mock', reason: 'test-new' }),
  checkHashDedup: vi.fn().mockResolvedValue({ matched: false }),
  verifyCandidate: vi
    .fn()
    .mockResolvedValue({ action: 'stored', id: null, reason: 'verified-new' }),
  verifyBatch: vi.fn().mockResolvedValue([]),
  verifyAndStoreBatch: vi.fn().mockResolvedValue([]),
  storeVerifiedCandidate: vi.fn().mockResolvedValue('VAS-mock'),
}));

// The zod helper is dynamically imported by the module; mock the subpath so
// we can control whether structured output is available.
vi.mock('@anthropic-ai/sdk/helpers/zod', () => ({
  // Return a sentinel object — the mock messages.parse below accepts any format.
  zodOutputFormat: vi.fn().mockReturnValue({ _mock: 'zodOutputFormat' }),
}));

// Mock the key resolver so tests don't depend on filesystem state
// (~/.claude/.credentials.json, ~/.local/share/cleo/anthropic-key).
// Default: no key. Tests that inject a client bypass this anyway.
const mockResolveKey = vi.fn().mockReturnValue(null);
vi.mock('../anthropic-key-resolver.js', () => ({
  resolveAnthropicApiKey: (...args: unknown[]) => mockResolveKey(...args),
  clearAnthropicKeyCache: vi.fn(),
}));

// Mock the SDK entry point so buildAnthropicClient doesn't touch the network.
// Tests that need this will inject a custom client via options.client instead.
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { parse: vi.fn(), create: vi.fn() };
  }
  return { default: MockAnthropic };
});

// Mock the key resolver so tests don't depend on filesystem state
// (~/.claude/.credentials.json, ~/.local/share/cleo/anthropic-key).
// Default: no key. Tests that inject a client via options.client bypass this.
vi.mock('../anthropic-key-resolver.js', () => ({
  resolveAnthropicApiKey: vi.fn().mockReturnValue(null),
  clearAnthropicKeyCache: vi.fn(),
}));

// ---- imports after mocks --------------------------------------------------

import { storeDecision } from '../decisions.js';
import { checkHashDedup, verifyAndStore } from '../extraction-gate.js';
import { storeLearning } from '../learnings.js';
import type { ExtractedMemory } from '../llm-extraction.js';
import { extractFromTranscript } from '../llm-extraction.js';
import { storePattern } from '../patterns.js';

// ---- helpers --------------------------------------------------------------

function makeClient(memories: ExtractedMemory[]) {
  const parse = vi.fn().mockResolvedValue({
    parsed_output: { memories },
  });
  const create = vi.fn();
  return {
    parse,
    create,
    client: {
      messages: { parse, create },
    } as unknown as Parameters<typeof extractFromTranscript>[0]['client'],
  };
}

// ---- tests ----------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Ensure the buildAnthropicClient path is not reached when we inject clients.
  delete process.env.ANTHROPIC_API_KEY;
});

describe('extractFromTranscript (LLM gate)', () => {
  it('returns an empty report when transcript is empty', async () => {
    const report = await extractFromTranscript({
      projectRoot: '/mock/root',
      sessionId: 'S-empty',
      transcript: '',
    });

    expect(report.extractedCount).toBe(0);
    expect(report.storedCount).toBe(0);
    expect(storeLearning).not.toHaveBeenCalled();
  });

  it('returns a warning and does not store when API key and client are absent', async () => {
    const report = await extractFromTranscript({
      projectRoot: '/mock/root',
      sessionId: 'S-no-key',
      transcript: 'assistant: I implemented a feature',
    });

    expect(report.storedCount).toBe(0);
    expect(report.warnings.some((w) => w.includes('ANTHROPIC_API_KEY'))).toBe(true);
    expect(storeLearning).not.toHaveBeenCalled();
  });

  it('routes a learning extraction through verifyAndStore (T736)', async () => {
    const { client } = makeClient([
      {
        type: 'learning',
        content: 'Brain.db uses SQLite WAL mode',
        importance: 0.75,
        entities: ['brain.db', 'WAL'],
        justification: 'Architectural fact worth retaining',
      },
    ]);

    const report = await extractFromTranscript({
      projectRoot: '/mock/root',
      sessionId: 'S-learn',
      transcript: 'assistant: The brain uses WAL mode',
      client,
    });

    expect(report.extractedCount).toBe(1);
    expect(report.storedCount).toBe(1);
    // T736: learnings route through verifyAndStore, NOT directly to storeLearning
    expect(verifyAndStore).toHaveBeenCalledTimes(1);
    expect(verifyAndStore).toHaveBeenCalledWith(
      '/mock/root',
      expect.objectContaining({
        text: 'Brain.db uses SQLite WAL mode',
        memoryType: 'semantic',
      }),
    );
    expect(storeLearning).not.toHaveBeenCalled();
  });

  it('routes a pattern extraction through verifyAndStore with procedural memoryType (T736)', async () => {
    const { client } = makeClient([
      {
        type: 'pattern',
        content: 'When writing migrations, add ensureColumns as safety net',
        importance: 0.82,
        entities: ['migrations', 'ensureColumns'],
        justification: 'Pattern seen in T528/T531/T549',
      },
    ]);

    const report = await extractFromTranscript({
      projectRoot: '/mock/root',
      sessionId: 'S-pat',
      transcript: 'assistant: We add ensureColumns as a safety net',
      client,
    });

    expect(report.storedCount).toBe(1);
    // T736: patterns route through verifyAndStore, NOT directly to storePattern
    expect(verifyAndStore).toHaveBeenCalledTimes(1);
    expect(verifyAndStore).toHaveBeenCalledWith(
      '/mock/root',
      expect.objectContaining({
        text: 'When writing migrations, add ensureColumns as safety net',
        memoryType: 'procedural',
      }),
    );
    expect(storePattern).not.toHaveBeenCalled();
  });

  it('routes a decision extraction to storeDecision with split rationale', async () => {
    const { client } = makeClient([
      {
        type: 'decision',
        content: 'Use SQLite because WAL mode prevents corruption during concurrent reads',
        importance: 0.9,
        entities: ['SQLite', 'WAL'],
        justification: 'Architectural choice',
      },
    ]);

    const report = await extractFromTranscript({
      projectRoot: '/mock/root',
      sessionId: 'S-dec',
      transcript: 'assistant: We chose SQLite',
      client,
    });

    expect(report.storedCount).toBe(1);
    expect(storeDecision).toHaveBeenCalledTimes(1);
    expect(storeDecision).toHaveBeenCalledWith(
      '/mock/root',
      expect.objectContaining({
        type: 'technical',
        decision: 'Use SQLite',
        confidence: 'high',
      }),
    );
  });

  it('routes a correction extraction through verifyAndStore as procedural memory (T736)', async () => {
    const { client } = makeClient([
      {
        type: 'correction',
        content: 'Avoid using any type; find root cause and wire proper types',
        importance: 0.85,
        entities: ['TypeScript'],
        justification: 'Anti-pattern documented in code-quality-rules.md',
      },
    ]);

    const report = await extractFromTranscript({
      projectRoot: '/mock/root',
      sessionId: 'S-corr',
      transcript: 'assistant: Avoid any type',
      client,
    });

    expect(report.storedCount).toBe(1);
    // T736: corrections route through verifyAndStore as procedural memory
    expect(verifyAndStore).toHaveBeenCalledTimes(1);
    expect(verifyAndStore).toHaveBeenCalledWith(
      '/mock/root',
      expect.objectContaining({
        text: 'Avoid using any type; find root cause and wire proper types',
        memoryType: 'procedural',
      }),
    );
    expect(storePattern).not.toHaveBeenCalled();
  });

  it('routes a constraint extraction through verifyAndStore with high confidence (T736)', async () => {
    const { client } = makeClient([
      {
        type: 'constraint',
        content: 'All quality gates must pass before marking a task complete',
        importance: 0.7,
        entities: ['quality gates'],
        justification: 'Required by AGENTS.md',
      },
    ]);

    const report = await extractFromTranscript({
      projectRoot: '/mock/root',
      sessionId: 'S-cons',
      transcript: 'assistant: gates must pass',
      client,
    });

    expect(report.storedCount).toBe(1);
    // T736: constraints route through verifyAndStore with semantic memory type
    expect(verifyAndStore).toHaveBeenCalledTimes(1);
    const call = (verifyAndStore as ReturnType<typeof vi.fn>).mock.calls[0];
    // Constraint confidence must be at least 0.8 even if importance is 0.7.
    expect(call[1].confidence).toBeGreaterThanOrEqual(0.8);
    expect(call[1].memoryType).toBe('semantic');
    expect(storeLearning).not.toHaveBeenCalled();
  });

  it('filters out extractions below minImportance', async () => {
    const { client } = makeClient([
      {
        type: 'learning',
        content: 'High importance fact',
        importance: 0.85,
        entities: [],
        justification: 'Keep me',
      },
      {
        type: 'learning',
        content: 'Low importance fact',
        importance: 0.3,
        entities: [],
        justification: 'Drop me',
      },
    ]);

    const report = await extractFromTranscript({
      projectRoot: '/mock/root',
      sessionId: 'S-filter',
      transcript: 'assistant: some content',
      client,
    });

    expect(report.extractedCount).toBe(2);
    expect(report.storedCount).toBe(1);
    expect(report.rejectedCount).toBe(1);
    // T736: high-importance learning routes through verifyAndStore, low-importance is filtered
    expect(verifyAndStore).toHaveBeenCalledTimes(1);
    expect(storeLearning).not.toHaveBeenCalled();
  });

  it('returns empty report when LLM returns no extractions', async () => {
    const { client } = makeClient([]);

    const report = await extractFromTranscript({
      projectRoot: '/mock/root',
      sessionId: 'S-empty',
      transcript: 'assistant: just greetings and chatter',
      client,
    });

    expect(report.extractedCount).toBe(0);
    expect(report.storedCount).toBe(0);
    expect(storeLearning).not.toHaveBeenCalled();
    expect(storePattern).not.toHaveBeenCalled();
    expect(storeDecision).not.toHaveBeenCalled();
  });

  it('handles LLM call failures without throwing', async () => {
    const parse = vi.fn().mockRejectedValue(new Error('rate limited'));
    const client = {
      messages: { parse, create: vi.fn() },
    } as unknown as Parameters<typeof extractFromTranscript>[0]['client'];

    const report = await extractFromTranscript({
      projectRoot: '/mock/root',
      sessionId: 'S-error',
      transcript: 'assistant: content',
      client,
    });

    expect(report.storedCount).toBe(0);
    expect(report.warnings.some((w) => w.includes('extraction call failed'))).toBe(true);
  });

  it('respects maxTranscriptChars by clipping long transcripts', async () => {
    const { client, parse } = makeClient([]);
    const longTranscript = 'a'.repeat(120000);

    await extractFromTranscript({
      projectRoot: '/mock/root',
      sessionId: 'S-clip',
      transcript: longTranscript,
      client,
    });

    expect(parse).toHaveBeenCalledTimes(1);
    const body = parse.mock.calls[0][0] as {
      messages: Array<{ content: string }>;
    };
    const userContent = body.messages[0].content;
    // The clipper inserts a "[... N chars omitted ...]" marker.
    expect(userContent).toContain('chars omitted');
  });
});
