/**
 * Dream-cycle LLM resolution fallback chain (T12081 · T12082).
 *
 * Three tiers, in order:
 *   1. a real Anthropic client (supports the structured-output `parse` path);
 *   2. ANY resolvable provider via the provider-agnostic `executeForRole`;
 *   3. a LOCAL inference server detected at runtime.
 *
 * Tier 2 exists because `resolveAnthropicForRole` returns null for every
 * non-anthropic provider — a provider-specific chokepoint inside an otherwise
 * provider-agnostic system. Tier 3 exists because the auxiliary fallback chain
 * is entirely cloud (anthropic → openrouter → groq), so when every cloud
 * credential is unusable the chain is exhausted and consolidation just stops —
 * which is what happened on 2026-08-06, with an Ollama server running the whole
 * time.
 *
 * These tests drive the chain with mocked modules so no network is touched.
 *
 * @task T12082
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above every other statement in the file, so
// the doubles they close over must be created in a hoisted block too.
const {
  resolveAnthropicForRole,
  executeForRole,
  detectLocalInference,
  complete,
  buildTransportFromCredential,
} = vi.hoisted(() => {
  const completeFn = vi.fn();
  return {
    resolveAnthropicForRole: vi.fn(),
    executeForRole: vi.fn(),
    detectLocalInference: vi.fn(),
    complete: completeFn,
    buildTransportFromCredential: vi.fn(() => ({ complete: completeFn })),
  };
});

vi.mock('../../llm/role-resolver.js', () => ({
  IMPLICIT_FALLBACK_MODEL: 'claude-sonnet-5',
  resolveAnthropicForRole,
  resolveLLMForRole: vi.fn().mockResolvedValue({
    provider: 'openai',
    model: 'gpt-5.5-pro',
    sealedCredential: null,
  }),
}));

vi.mock('../../llm/role-executor.js', () => ({ executeForRole }));

vi.mock('../../llm/local-inference-probe.js', () => ({ detectLocalInference }));

vi.mock('../../llm/model-runner.js', () => ({
  ModelRunner: { buildTransportFromCredential },
}));

import { SENTIENT_STATE_FILE } from '../daemon.js';
import { type CollectedObservation, runDreamCycle } from '../dream-cycle.js';
import { DEFAULT_SENTIENT_STATE, writeSentientState } from '../state.js';

/** A local server with two models loaded, newest first. */
const OLLAMA = {
  name: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  openAiBaseUrl: 'http://127.0.0.1:11434/v1',
  models: ['qwen2.5-coder:3b', 'qwen2:0.5b'],
};

/** One memory, shaped as the extractor expects it back from the model. */
const MEMORIES = [
  {
    type: 'learning' as const,
    content: 'Background consolidation should degrade to local inference, not stop.',
    importance: 0.8,
    entities: ['dream-cycle'],
    justification: 'Observed across five hygiene observations.',
  },
];

/**
 * Build a cluster the cycle will actually synthesise: enough observations
 * (>= DREAM_CLUSTER_MIN_SIZE) with enough n-gram overlap to cluster together.
 *
 * @returns the observations.
 */
function makeCluster(): CollectedObservation[] {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `O-local-${i}`,
    title: 'dream cycle local inference fallback',
    narrative: 'dream cycle local inference fallback ollama loopback consolidation degrade',
    createdAt: new Date().toISOString(),
    observationType: 'hygiene:test',
  }));
}

describe('dream-cycle LLM fallback chain (T12081 · T12082)', () => {
  let root: string;
  let statePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-dream-local-'));
    statePath = join(root, SENTIENT_STATE_FILE);
    await writeSentientState(statePath, { ...DEFAULT_SENTIENT_STATE });

    vi.clearAllMocks();
    buildTransportFromCredential.mockReturnValue({ complete });
    complete.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ memories: MEMORIES }) }],
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * Run the cycle with every side effect stubbed except LLM resolution.
   *
   * @returns the outcome.
   */
  async function run() {
    return runDreamCycle({
      projectRoot: root,
      statePath,
      collectObservations: async () => makeCluster(),
      observeMemory: vi.fn().mockResolvedValue({ id: 'O-digest' }),
      verifyAndStoreFn: vi.fn().mockResolvedValue({ action: 'stored' }),
    });
  }

  it('falls through to LOCAL inference when no cloud credential resolves', async () => {
    resolveAnthropicForRole.mockResolvedValue(null);
    executeForRole.mockResolvedValue(null); // dead credential — the 2026-08-06 state
    detectLocalInference.mockResolvedValue(OLLAMA);

    const outcome = await run();

    expect(outcome.kind).toBe('completed');
    expect(detectLocalInference).toHaveBeenCalled();
    // models[0] is the completion model, and the transport is pointed at the
    // detected loopback base URL rather than any cloud endpoint.
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen2.5-coder:3b' }));
    // The compat URL, because this shim speaks `chat_completions`.
    expect(buildTransportFromCredential).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ baseUrl: OLLAMA.openAiBaseUrl }),
      'chat_completions',
    );
  });

  it('records no-api-key when neither cloud NOR local is available', async () => {
    resolveAnthropicForRole.mockResolvedValue(null);
    executeForRole.mockResolvedValue(null);
    detectLocalInference.mockResolvedValue(null);

    expect((await run()).kind).toBe('no-api-key');
  });

  it('does NOT reach the local tier when a non-anthropic provider works', async () => {
    // Tier 2: the provider-agnostic path answers, so nothing local is probed.
    resolveAnthropicForRole.mockResolvedValue(null);
    executeForRole.mockResolvedValue({
      content: JSON.stringify({ memories: MEMORIES }),
      model: 'gpt-5.5-pro',
    });

    const outcome = await run();

    expect(outcome.kind).toBe('completed');
    expect(detectLocalInference).not.toHaveBeenCalled();
  });

  it('bounds the tier-2 probe so a retrying dead credential cannot stall the pass', async () => {
    // A provider with a dead credential does not fail fast — it retries with
    // backoff. Unbounded, that blocks the whole consolidation behind a chain
    // that will never succeed.
    resolveAnthropicForRole.mockResolvedValue(null);
    executeForRole.mockResolvedValue(null);
    detectLocalInference.mockResolvedValue(null);

    await run();

    expect(executeForRole).toHaveBeenCalledWith(
      'consolidation',
      'ping',
      'ping',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('prefers a real Anthropic client over both fallbacks', async () => {
    resolveAnthropicForRole.mockResolvedValue({
      client: {
        messages: {
          parse: vi.fn().mockResolvedValue({ parsed_output: { memories: MEMORIES } }),
          create: vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: JSON.stringify({ memories: MEMORIES }) }],
          }),
        },
      },
      model: 'claude-sonnet-5',
    });

    const outcome = await run();

    expect(outcome.kind).toBe('completed');
    expect(executeForRole).not.toHaveBeenCalled();
    expect(detectLocalInference).not.toHaveBeenCalled();
  });

  it('survives a local tier that throws — degrades to no-api-key, never crashes', async () => {
    resolveAnthropicForRole.mockResolvedValue(null);
    executeForRole.mockResolvedValue(null);
    detectLocalInference.mockRejectedValue(new Error('probe exploded'));

    expect((await run()).kind).toBe('no-api-key');
  });
});
