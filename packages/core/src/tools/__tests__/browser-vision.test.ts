/**
 * Tests for `browser_vision` (T1742 · AC6 · epic T11456).
 *
 * `browser_vision` captures a page screenshot and analyses it with a vision
 * model. The AI call MUST route through the E9 `resolveLLMForSystem` chokepoint +
 * sealed-credential handle and the single `ModelRunner` — never a raw provider
 * call. These tests mock BOTH the resolver and the runner (no real credential, no
 * real network, no real browser launch · AC9) and assert:
 *
 *   1. the screenshot is captured and sent as a multimodal user turn;
 *   2. the resolver's sealed credential is `fetch()`-materialized (only at the
 *      wire) and the model's text is returned;
 *   3. when NO credential resolves, the tool degrades gracefully — the screenshot
 *      is still captured and `aiUnavailable: true` is returned (not an error).
 *
 * The resolver/runner modules are dynamically imported INSIDE the executable, so
 * `vi.mock` of their module paths intercepts them.
 *
 * @task T1742
 * @epic T11456
 */

import type { TransportMessage } from '@cleocode/contracts/llm/normalized-response.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// --- Capture the messages handed to the (mocked) session.send. ---
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
const { BrowserSession } = await import('../browser-driver.js');
const { registerWebAgentTools } = await import('../web-agent-tools.js');

afterEach(() => {
  sentMessages = undefined;
  sealedFetched = false;
  vi.clearAllMocks();
});

/** A fake Playwright that takes screenshots — no real browser. */
function fakeBrowserLoader(): () => Promise<unknown> {
  const page = {
    async goto(): Promise<unknown> {
      return undefined;
    },
    url: () => 'https://shot.io',
    async title(): Promise<string> {
      return 'Shot Page';
    },
    locator() {
      return { click: async () => {}, fill: async () => {}, focus: async () => {} };
    },
    keyboard: { press: async () => {} },
    accessibility: { snapshot: async () => null },
    async screenshot(): Promise<Buffer> {
      return Buffer.from('SCREENSHOTBYTES');
    },
    async evaluate<T>(): Promise<T> {
      return 0 as unknown as T;
    },
  };
  const browser = { newPage: async () => page, close: async () => {} };
  return async () => ({ chromium: { launch: async () => browser } });
}

/** Build a registry with `browser_vision` over a fake browser. */
async function visionRegistry(): Promise<{
  exec: NonNullable<ReturnType<InstanceType<typeof AgentToolRegistry>['getExecutable']>>;
}> {
  const session = new BrowserSession(fakeBrowserLoader() as never);
  const r = new AgentToolRegistry();
  registerWebAgentTools(r, { browser: session });
  await r.init({ skipBuiltins: true });
  // Prime the session by navigating (so screenshot has a page).
  const nav = r.getExecutable('browser_navigate');
  await nav?.({ url: 'https://shot.io' }, undefined as never);
  const exec = r.getExecutable('browser_vision');
  if (exec === undefined) throw new Error('browser_vision missing');
  return { exec };
}

describe('browser_vision (AC6) — AI call routes through the E9 chokepoint', () => {
  it('captures a screenshot and sends it as a multimodal turn; returns the analysis', async () => {
    resolveLLMForSystem.mockResolvedValue({
      provider: 'anthropic',
      model: 'mock-vision-model',
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
          return { content: 'A login form with a blue button.', toolCalls: null };
        },
      },
    });

    const { exec } = await visionRegistry();
    const out = (await exec({ prompt: 'Describe the page' }, undefined as never)) as {
      analysis: string | null;
      aiUnavailable: boolean;
      model?: string;
      url: string;
    };

    // Resolution went through the E9 chokepoint with the task-executor system.
    expect(resolveLLMForSystem).toHaveBeenCalledWith('task-executor', expect.any(Object));
    // The sealed credential was materialized only at the wire.
    expect(sealedFetched).toBe(true);
    // The screenshot rode along as a base64 image block in a single user turn.
    expect(sentMessages).toHaveLength(1);
    const content = sentMessages?.[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as ReadonlyArray<{ type: string; source?: { mediaType: string } }>;
    expect(blocks.find((b) => b.type === 'text')).toBeDefined();
    const image = blocks.find((b) => b.type === 'image');
    expect(image?.source?.mediaType).toBe('image/png');
    // The model's text analysis is returned.
    expect(out.analysis).toBe('A login form with a blue button.');
    expect(out.aiUnavailable).toBe(false);
    expect(out.model).toBe('mock-vision-model');
    expect(out.url).toBe('https://shot.io');
  });

  it('degrades gracefully (aiUnavailable, screenshot still captured) when no credential resolves', async () => {
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

    const { exec } = await visionRegistry();
    const out = (await exec({ prompt: 'Describe the page' }, undefined as never)) as {
      analysis: string | null;
      aiUnavailable: boolean;
      url: string;
      title: string;
    };

    // No raw provider construction; the runner was never built.
    expect(modelRunnerBuild).not.toHaveBeenCalled();
    expect(out.analysis).toBeNull();
    expect(out.aiUnavailable).toBe(true);
    // The screenshot context (url/title) was still captured.
    expect(out.url).toBe('https://shot.io');
    expect(out.title).toBe('Shot Page');
  });
});
