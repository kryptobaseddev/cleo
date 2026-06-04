/**
 * ModelRunner + ResolvedLLMDescriptor unit tests (E9 · T11745 step 0 + step 1).
 *
 * Asserts:
 *  - the descriptor carries `apiMode` / `baseUrl` (the SSoT foundation fields);
 *  - the single {@link ModelRunner} builds BOTH surfaces (transport session +
 *    Vercel language model) for anthropic, openai-compatible, and
 *    codex_responses descriptors;
 *  - apiMode-keyed dispatch picks the correct transport class.
 *
 * @task T11745
 * @task T11761
 * @epic T11745
 */

import type { ResolvedLLMDescriptor } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { deriveApiWire } from '../api-mode.js';
import { type BuiltModel, ModelRunner } from '../model-runner.js';
import { AnthropicTransport } from '../transports/anthropic.js';
import { ChatCompletionsTransport } from '../transports/chat-completions.js';
import { CODEX_OAUTH_BASE_URL } from '../transports/codex-oauth-headers.js';
import { CodexResponsesTransport } from '../transports/codex-responses.js';

/**
 * Build a minimal {@link ResolvedLLMDescriptor} for a test, supplying the
 * SSoT wire facts a real resolver would stamp.
 */
function makeDescriptor(
  overrides: Partial<ResolvedLLMDescriptor> & Pick<ResolvedLLMDescriptor, 'provider' | 'apiMode'>,
): ResolvedLLMDescriptor {
  return {
    model: 'test-model',
    credential: {
      provider: overrides.provider,
      apiKey: 'sk-test',
      source: 'env',
      authType: 'api_key',
    },
    source: 'role',
    baseUrl: null,
    authType: 'api_key',
    ...overrides,
  };
}

describe('deriveApiWire (T11745 step 0)', () => {
  it('maps anthropic → anthropic_messages with no baseUrl override', () => {
    expect(deriveApiWire('anthropic', 'api_key')).toEqual({
      apiMode: 'anthropic_messages',
      baseUrl: null,
    });
  });

  it('maps openai + oauth → codex_responses with the ChatGPT backend baseUrl', () => {
    expect(deriveApiWire('openai', 'oauth')).toEqual({
      apiMode: 'codex_responses',
      baseUrl: CODEX_OAUTH_BASE_URL,
    });
  });

  it('maps openai + api_key → chat_completions', () => {
    expect(deriveApiWire('openai', 'api_key')).toEqual({
      apiMode: 'chat_completions',
      baseUrl: null,
    });
  });

  it('maps ollama → ollama_native and bedrock → bedrock_converse', () => {
    expect(deriveApiWire('ollama', null).apiMode).toBe('ollama_native');
    expect(deriveApiWire('bedrock', 'aws_sdk').apiMode).toBe('bedrock_converse');
  });
});

describe('ResolvedLLMDescriptor carries the SSoT wire fields (T11745 step 0)', () => {
  it('exposes apiMode + baseUrl on the descriptor surface', () => {
    const d = makeDescriptor({
      provider: 'openai',
      apiMode: 'codex_responses',
      authType: 'oauth',
      baseUrl: CODEX_OAUTH_BASE_URL,
    });
    expect(d.apiMode).toBe('codex_responses');
    expect(d.baseUrl).toBe(CODEX_OAUTH_BASE_URL);
    expect(d.authType).toBe('oauth');
  });
});

describe('ModelRunner.build — both surfaces from one descriptor (T11745 step 1)', () => {
  it('anthropic_messages → AnthropicTransport session + Vercel languageModel', async () => {
    const d = makeDescriptor({ provider: 'anthropic', apiMode: 'anthropic_messages' });
    const built: BuiltModel = await ModelRunner.build(d);

    // Transport session always present.
    expect(built.session).toBeDefined();
    expect(ModelRunner.buildTransport(d)).toBeInstanceOf(AnthropicTransport);
    // Vercel languageModel present for anthropic.
    expect(built.languageModel).not.toBeNull();
  });

  it('chat_completions (openai-compat) → ChatCompletionsTransport session + Vercel languageModel', async () => {
    const d = makeDescriptor({
      provider: 'openai',
      apiMode: 'chat_completions',
      baseUrl: 'https://api.openai.com/v1',
    });
    const built = await ModelRunner.build(d);

    expect(built.session).toBeDefined();
    expect(ModelRunner.buildTransport(d)).toBeInstanceOf(ChatCompletionsTransport);
    // openai-compatible with a baseUrl wires a Vercel languageModel.
    expect(built.languageModel).not.toBeNull();
  });

  it('codex_responses → CodexResponsesTransport session (transport-only, no Vercel binding)', async () => {
    const d = makeDescriptor({
      provider: 'openai',
      apiMode: 'codex_responses',
      authType: 'oauth',
      baseUrl: CODEX_OAUTH_BASE_URL,
      credential: {
        provider: 'openai',
        apiKey: 'oauth-token',
        source: 'cred-file',
        authType: 'oauth',
      },
    });
    const built = await ModelRunner.build(d);

    const transport = ModelRunner.buildTransport(d);
    expect(transport).toBeInstanceOf(CodexResponsesTransport);
    expect(transport.apiMode).toBe('codex_responses');
    // codex has no core Vercel binding — caller uses the transport session.
    expect(built.session).toBeDefined();
    expect(built.languageModel).toBeNull();
  });
});
