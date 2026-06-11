/**
 * Tests for the vision / media agent-tool family (T11951 · M7 · epic T11456).
 *
 * Every model call MUST route through the E9 `resolveLLMForSystem` chokepoint +
 * sealed-credential handle and the single `ModelRunner` — never a raw provider
 * call (Gate-13). These tests mock BOTH the resolver and the runner (no real
 * credential, no real network) and assert:
 *   - AC1 register vision_analyze / image_generate / text_to_speech in the 'media'
 *     toolset via the self-registering marker + the built-in catalog;
 *   - AC2 the call routes through resolveLLMForSystem → ModelRunner, sending a
 *     multimodal turn; the sealed credential is fetch()-materialized only at the wire;
 *   - AC3 hidden when egress is denied or no multimodal capability; visible otherwise;
 *   - AC4 Zod schema validation (missing prompt → invalid-args);
 *   - AC5 graceful degradation (aiUnavailable, runner never built) when no credential.
 *
 * @task T11951
 * @epic T11456
 */

import type { TransportMessage } from '@cleocode/contracts/llm/normalized-response.js';
import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaModelResult } from '../media-agent-tools.js';

let sentMessages: TransportMessage[] | undefined;
let sealedFetched = false;

const resolveLLMForSystem = vi.fn();
const modelRunnerBuild = vi.fn();

vi.mock('../../llm/system-resolver.js', () => ({
  resolveLLMForSystem: (...args: unknown[]) => resolveLLMForSystem(...args),
}));

vi.mock('../../llm/model-runner.js', () => ({
  ModelRunner: {
    build: (...args: unknown[]) => modelRunnerBuild(...args),
  },
}));

// Imported AFTER the mocks so the executable's dynamic imports bind to them.
const { AgentToolRegistry } = await import('../agent-registry.js');
const { registerBuiltinAgentTools } = await import('../builtin-agent-tools.js');
const { ToolDispatchEngine } = await import('../dispatch.js');
const { createToolGuard } = await import('../guard.js');
const { multimodalAvailable, registerMediaAgentTools } = await import('../media-agent-tools.js');

const noopSurface = {} as GuardedToolSurface;
const MULTIMODAL_CTX = { networkEgressAllowed: true, capabilities: { multimodal: true } };

afterEach(() => {
  sentMessages = undefined;
  sealedFetched = false;
  vi.clearAllMocks();
});

/** Mock a resolved credential + a session that records the turn it received. */
function mockResolvedWithSession(content: string): void {
  resolveLLMForSystem.mockResolvedValue({
    provider: 'anthropic',
    model: 'mock-multimodal-model',
    client: null,
    credential: { provider: 'anthropic', source: 'env', authType: 'api_key' },
    sealedCredential: {
      provider: 'anthropic',
      account: 'mock',
      tokenPreview: '…mock',
      fetch: async () => {
        sealedFetched = true;
        return { value: 'sk-mock' };
      },
    },
    source: 'role-config',
    apiMode: 'anthropic_messages',
    baseUrl: null,
    authType: 'api_key',
  });
  modelRunnerBuild.mockResolvedValue({
    languageModel: null,
    session: {
      async send(messages: TransportMessage[]) {
        sentMessages = messages;
        return { content, toolCalls: null };
      },
    },
  });
}

/** Build a media registry with an injected image reader (no real file). */
async function mediaRegistry(): Promise<InstanceType<typeof AgentToolRegistry>> {
  const r = new AgentToolRegistry();
  registerMediaAgentTools(r, {
    readImage: async () => ({ base64: 'AAAA', mediaType: 'image/png' }),
  });
  await r.init({ skipBuiltins: true });
  return r;
}

// ===========================================================================
// AC1 — registration in the 'media' toolset
// ===========================================================================

describe('media-agent-tools — registration (AC1)', () => {
  it('exports a self-registering marker that registers the three media tools', async () => {
    const mod = await import('../media-agent-tools.js');
    expect(typeof mod.registerAgentTools).toBe('function');
    const registry = new AgentToolRegistry();
    mod.registerAgentTools(registry);
    for (const name of ['vision_analyze', 'image_generate', 'text_to_speech']) {
      expect(registry.get(name)?.toolset).toBe('media');
    }
  });

  it('the built-in catalog populates the previously-empty media toolset', async () => {
    const registry = new AgentToolRegistry();
    registerBuiltinAgentTools(registry);
    await registry.init({ skipBuiltins: true });
    const mediaNames = registry.byToolset('media').map((t) => t.name);
    expect(mediaNames).toEqual(
      expect.arrayContaining(['vision_analyze', 'image_generate', 'text_to_speech']),
    );
  });
});

// ===========================================================================
// AC3 — availability gates on egress + multimodal capability
// ===========================================================================

describe('media-agent-tools — availability (AC3)', () => {
  it('multimodalAvailable requires egress AND a multimodal capability', () => {
    expect(multimodalAvailable({})).toBe(false);
    expect(
      multimodalAvailable({ networkEgressAllowed: false, capabilities: { multimodal: true } }),
    ).toBe(false);
    expect(multimodalAvailable({ capabilities: { multimodal: true } })).toBe(true);
    expect(
      multimodalAvailable({ networkEgressAllowed: true, capabilities: { multimodal: true } }),
    ).toBe(true);
  });

  it('is hidden credential-OFF / egress-OFF and visible with the capability', async () => {
    const r = await mediaRegistry();
    expect(
      r.available({ networkEgressAllowed: false }).some((t) => t.name === 'vision_analyze'),
    ).toBe(false);
    expect(r.available(MULTIMODAL_CTX).some((t) => t.name === 'vision_analyze')).toBe(true);
  });
});

// ===========================================================================
// AC2 — routes through the E9 chokepoint
// ===========================================================================

describe('media-agent-tools — E9 chokepoint routing (AC2)', () => {
  it('vision_analyze sends image + prompt as a multimodal turn via ModelRunner', async () => {
    mockResolvedWithSession('A red square.');
    const r = await mediaRegistry();
    const out = (await r.getExecutable('vision_analyze')?.(
      { imagePath: '/tmp/x.png', prompt: 'What is this?' },
      noopSurface,
    )) as MediaModelResult;

    expect(resolveLLMForSystem).toHaveBeenCalledWith('task-executor', expect.any(Object));
    expect(sealedFetched).toBe(true);
    expect(sentMessages).toHaveLength(1);
    const content = sentMessages?.[0]?.content as ReadonlyArray<{
      type: string;
      source?: { mediaType: string };
    }>;
    expect(content.find((b) => b.type === 'text')).toBeDefined();
    expect(content.find((b) => b.type === 'image')?.source?.mediaType).toBe('image/png');
    expect(out.ok).toBe(true);
    expect(out.content).toBe('A red square.');
    expect(out.model).toBe('mock-multimodal-model');
  });

  it('image_generate routes through the chokepoint and flags unsupported synthesis', async () => {
    mockResolvedWithSession('I cannot create images.');
    const r = await mediaRegistry();
    const out = (await r.getExecutable('image_generate')?.(
      { prompt: 'a cat' },
      noopSurface,
    )) as MediaModelResult;
    expect(resolveLLMForSystem).toHaveBeenCalled();
    expect(out.ok).toBe(true);
    expect(out.unsupported).toBe(true);
  });

  it('text_to_speech routes through the chokepoint and flags unsupported audio', async () => {
    mockResolvedWithSession('I cannot produce audio.');
    const r = await mediaRegistry();
    const out = (await r.getExecutable('text_to_speech')?.(
      { text: 'hello' },
      noopSurface,
    )) as MediaModelResult;
    expect(resolveLLMForSystem).toHaveBeenCalled();
    expect(out.ok).toBe(true);
    expect(out.unsupported).toBe(true);
  });
});

// ===========================================================================
// AC5 — graceful degradation when no credential resolves
// ===========================================================================

describe('media-agent-tools — graceful degradation (AC5)', () => {
  it('vision_analyze returns aiUnavailable and never builds the runner when no credential', async () => {
    resolveLLMForSystem.mockResolvedValue({
      provider: 'anthropic',
      model: 'unknown',
      client: null,
      credential: null,
      sealedCredential: null,
      source: 'implicit-fallback',
      apiMode: 'anthropic_messages',
      baseUrl: null,
      authType: null,
    });
    const r = await mediaRegistry();
    const out = (await r.getExecutable('vision_analyze')?.(
      { imagePath: '/tmp/x.png', prompt: 'What is this?' },
      noopSurface,
    )) as MediaModelResult;
    expect(modelRunnerBuild).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.aiUnavailable).toBe(true);
  });

  it('vision_analyze surfaces a typed image-read failure (no throw)', async () => {
    const r = new AgentToolRegistry();
    registerMediaAgentTools(r, {
      readImage: async () => {
        throw new Error('ENOENT');
      },
    });
    await r.init({ skipBuiltins: true });
    const out = (await r.getExecutable('vision_analyze')?.(
      { imagePath: '/nope.png', prompt: 'x' },
      noopSurface,
    )) as MediaModelResult;
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('E_IMAGE_READ_FAILED');
  });
});

// ===========================================================================
// AC4 — Zod schema validation through the frozen dispatch engine
// ===========================================================================

describe('media-agent-tools — schema validation (AC4)', () => {
  async function engine() {
    const r = await mediaRegistry();
    return new ToolDispatchEngine({
      registry: r,
      tools: createToolGuard({ mode: 'enforce' }),
      availability: MULTIMODAL_CTX,
    });
  }

  it('rejects image_generate without a prompt as invalid-args', async () => {
    const res = await (await engine()).dispatch({
      id: 'c1',
      name: 'image_generate',
      arguments: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('invalid-args');
  });

  it('is guard-denied when the media capability is absent', async () => {
    const r = await mediaRegistry();
    const eng = new ToolDispatchEngine({
      registry: r,
      tools: createToolGuard({ mode: 'enforce' }),
      availability: { networkEgressAllowed: false },
    });
    const res = await eng.dispatch({
      id: 'c2',
      name: 'text_to_speech',
      arguments: { text: 'hi' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('guard-denied');
  });
});
