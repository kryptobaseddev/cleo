/**
 * Regression tests for gh#1216 — "openrouter LLM transport misroutes to
 * api.openai.com; credential --base-url and llm.providers.<id>.baseUrl
 * overrides are ignored".
 *
 * `deriveApiWire` returned `baseUrl: null` for every OpenAI-compatible
 * provider except Codex, and a null base URL makes the OpenAI SDK fall back to
 * `api.openai.com`. An OpenRouter key was therefore sent to OpenAI, which
 * rejected it with its own canonical 401 pointing at platform.openai.com — an
 * error that blames the credential rather than the routing, which is why it
 * took a packet-level read to spot.
 *
 * The base URLs were never unknown. They were recorded in three places (the
 * hand-written builtin profiles, the generated models.dev catalog, and an
 * inline map in cli-ops.ts) and consumed by none of the one path that decides
 * where a request is sent.
 *
 * @task T12132 (gh#1216)
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_BASE_URLS, defaultBaseUrlFor, deriveApiWire } from '../api-mode.js';

describe('gh#1216 — OpenAI-compatible providers must not default to api.openai.com', () => {
  it.each([
    ['openrouter', 'https://openrouter.ai/api/v1'],
    ['deepseek', 'https://api.deepseek.com/v1'],
    ['xai', 'https://api.x.ai/v1'],
    ['groq', 'https://api.groq.com/openai/v1'],
    ['moonshot', 'https://api.moonshot.cn/v1'],
  ] as const)('%s routes to its own endpoint, not OpenAI', (provider, expected) => {
    const wire = deriveApiWire(provider, 'api_key');
    expect(wire.apiMode).toBe('chat_completions');
    expect(wire.baseUrl).toBe(expected);
  });

  it('no OpenAI-compatible provider silently resolves to an OpenAI host', () => {
    // The failure mode was silent: a null baseUrl looks like "use the default"
    // and the default is somebody else's API.
    for (const [provider, url] of Object.entries(DEFAULT_PROVIDER_BASE_URLS)) {
      expect(url, `${provider} must not point at OpenAI`).not.toContain('api.openai.com');
    }
  });

  it('openai itself still resolves to null so the SDK default applies', () => {
    expect(deriveApiWire('openai', 'api_key').baseUrl).toBeNull();
    expect(defaultBaseUrlFor('openai')).toBeNull();
  });
});

describe('gh#1216 — the fix must not disturb the non-chat-completions providers', () => {
  it('anthropic, bedrock, gemini and ollama keep their existing wire', () => {
    expect(deriveApiWire('anthropic', 'api_key')).toEqual({
      apiMode: 'anthropic_messages',
      baseUrl: null,
    });
    expect(deriveApiWire('bedrock', 'aws_sdk')).toEqual({
      apiMode: 'bedrock_converse',
      baseUrl: null,
    });
    expect(deriveApiWire('gemini', 'api_key')).toEqual({
      apiMode: 'chat_completions',
      baseUrl: null,
    });
    expect(deriveApiWire('ollama', null).apiMode).toBe('ollama_native');
  });

  it('openai + oauth still routes to the Codex backend, not api.openai.com', () => {
    const wire = deriveApiWire('openai', 'oauth');
    expect(wire.apiMode).toBe('codex_responses');
    expect(wire.baseUrl).not.toBeNull();
    expect(wire.baseUrl).not.toContain('api.openai.com');
  });

  it('every default carries an explicit version segment or a full path', () => {
    // The transports pass this straight to the SDK as `baseURL`; a value
    // missing /v1 silently 404s, which is gh#1216's sibling complaint.
    for (const [provider, url] of Object.entries(DEFAULT_PROVIDER_BASE_URLS)) {
      expect(url.startsWith('http'), `${provider}`).toBe(true);
      expect(url.endsWith('/'), `${provider} must not have a trailing slash`).toBe(false);
    }
  });
});
