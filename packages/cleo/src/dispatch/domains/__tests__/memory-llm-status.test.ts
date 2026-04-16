/**
 * Integration test for the `memory.llm-status` dispatch operation.
 *
 * Verifies that:
 *   1. The handler returns a successful JSON envelope.
 *   2. The envelope contains the required fields: resolvedSource, extractionEnabled,
 *      lastExtractionRun, testCommand.
 *   3. `resolvedSource` is one of the expected union values.
 *   4. The operation is listed in getSupportedOperations().
 *
 * @task T791
 * @epic T770
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock engine.js (MemoryHandler imports from here for all other ops)
vi.mock('../../lib/engine.js', () => ({
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
}));

// Mock getProjectRoot
vi.mock('../../../../../core/src/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
    '../../../../../core/src/paths.js',
  );
  return {
    ...actual,
    getProjectRoot: vi.fn(() => '/mock/project'),
  };
});

// Mock @cleocode/core/internal to control resolveAnthropicApiKeySource and brain.db access
vi.mock('@cleocode/core/internal', async () => {
  const actual =
    await vi.importActual<typeof import('@cleocode/core/internal')>('@cleocode/core/internal');
  return {
    ...actual,
    resolveAnthropicApiKeySource: vi.fn(() => 'env' as const),
    resolveAnthropicApiKey: vi.fn(() => 'sk-test-mocked'),
    getBrainDb: vi.fn().mockResolvedValue(undefined),
    getBrainNativeDb: vi.fn(() => ({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn(() => undefined), // no last extraction run
      }),
    })),
  };
});

import { MemoryHandler } from '../memory.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryHandler: query llm-status', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new MemoryHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a successful envelope with the required shape', async () => {
    const result = await handler.query('llm-status', {});

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    const data = result.data as {
      resolvedSource: string;
      extractionEnabled: boolean;
      lastExtractionRun: string | null;
      testCommand: string;
    };

    expect(['env', 'config', 'oauth', 'none']).toContain(data.resolvedSource);
    expect(typeof data.extractionEnabled).toBe('boolean');
    // lastExtractionRun is null when brain.db has no extraction history
    expect(data.lastExtractionRun === null || typeof data.lastExtractionRun === 'string').toBe(
      true,
    );
    expect(typeof data.testCommand).toBe('string');
    expect(data.testCommand.length).toBeGreaterThan(0);
  });

  it('reflects extractionEnabled=true when resolver returns a key', async () => {
    const { resolveAnthropicApiKey } = await import('@cleocode/core/internal');
    vi.mocked(resolveAnthropicApiKey).mockReturnValue('sk-active-key');

    const result = await handler.query('llm-status', {});
    expect(result.success).toBe(true);
    const data = result.data as { extractionEnabled: boolean };
    expect(data.extractionEnabled).toBe(true);
  });

  it('reflects extractionEnabled=false when resolver returns null', async () => {
    const { resolveAnthropicApiKey, resolveAnthropicApiKeySource } = await import(
      '@cleocode/core/internal'
    );
    vi.mocked(resolveAnthropicApiKey).mockReturnValue(null);
    vi.mocked(resolveAnthropicApiKeySource).mockReturnValue('none');

    const result = await handler.query('llm-status', {});
    expect(result.success).toBe(true);
    const data = result.data as { extractionEnabled: boolean; resolvedSource: string };
    expect(data.extractionEnabled).toBe(false);
    expect(data.resolvedSource).toBe('none');
  });

  it('returns lastExtractionRun as ISO string when brain.db has extraction history', async () => {
    const { getBrainNativeDb } = await import('@cleocode/core/internal');
    vi.mocked(getBrainNativeDb).mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn(() => ({ created_at: '2026-04-15 18:30:00' })),
      }),
    } as unknown as ReturnType<typeof getBrainNativeDb>);

    const result = await handler.query('llm-status', {});
    expect(result.success).toBe(true);
    const data = result.data as { lastExtractionRun: string | null };
    expect(data.lastExtractionRun).not.toBeNull();
    expect(data.lastExtractionRun).toContain('T'); // ISO format
  });

  it('is listed in getSupportedOperations().query', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('llm-status');
  });

  it('returns success:true with no params provided (no required params)', async () => {
    // Must not require any params
    const result = await handler.query('llm-status');
    expect(result.success).toBe(true);
  });
});
