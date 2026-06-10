/**
 * T11702 — `ProviderDef` declarative contract shape.
 *
 * Type-level + value-level assertions that the contract is a closed, discriminated,
 * serializable shape (the endpoint union is keyed on the `transport` literal, no
 * `any`/`unknown` shortcut). No DB, no network.
 *
 * @task T11702
 * @epic T11667
 */

import { describe, expect, it } from 'vitest';
import {
  PROVIDER_TRANSPORTS,
  type ProviderDef,
  type ProviderEndpoint,
  REQUEST_QUIRK_KINDS,
} from '../llm/provider-def.js';

describe('ProviderDef contract (T11702)', () => {
  it('exposes the closed transport discriminant set', () => {
    expect([...PROVIDER_TRANSPORTS]).toEqual([
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
      'aisdk',
    ]);
  });

  it('exposes the closed request-quirk-kind set', () => {
    expect(REQUEST_QUIRK_KINDS).toContain('grok-conv-id');
    expect(REQUEST_QUIRK_KINDS).toContain('gemini-thinking-config');
    expect(REQUEST_QUIRK_KINDS).toContain('moonshot-schema-sanitize');
  });

  it('accepts a fully-populated declarative provider def with an OAuth flow + alt endpoint', () => {
    const def: ProviderDef = {
      id: 'openai',
      displayName: 'OpenAI Codex (ChatGPT)',
      aliases: ['codex', 'chatgpt', 'openai-codex'],
      authMethods: ['api_key', 'oauth'],
      endpoint: { transport: 'openai-completions', baseUrl: 'https://api.openai.com/v1' },
      altEndpoints: [{ transport: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }],
      modelsDevId: 'openai',
      oauth: {
        mode: 'pkce',
        clientId: 'app_test',
        tokenEndpoint: 'https://auth.openai.com/oauth/token',
        authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
      },
      requestQuirks: [{ kind: 'openrouter-pareto' }],
    };
    // Round-trips through JSON — the shape is serializable (no closures).
    const roundTripped = JSON.parse(JSON.stringify(def)) as ProviderDef;
    expect(roundTripped.id).toBe('openai');
    expect(roundTripped.endpoint.transport).toBe('openai-completions');
    expect(roundTripped.altEndpoints?.[0]?.transport).toBe('openai-responses');
    expect(roundTripped.oauth?.mode).toBe('pkce');
  });

  it('narrows the endpoint discriminated union on the transport literal', () => {
    const endpoints: ProviderEndpoint[] = [
      { transport: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
      { transport: 'aisdk', baseUrl: 'https://example.com', aiSdkProvider: 'google' },
    ];
    for (const ep of endpoints) {
      if (ep.transport === 'aisdk') {
        // Only the aisdk variant carries aiSdkProvider — narrowing proves the union.
        expect(ep.aiSdkProvider).toBe('google');
      } else {
        expect(ep.baseUrl.startsWith('https://')).toBe(true);
      }
    }
  });

  it('accepts a minimal def (no optional fields)', () => {
    const def: ProviderDef = {
      id: 'bedrock',
      displayName: 'AWS Bedrock',
      aliases: ['aws-bedrock'],
      authMethods: ['aws_sdk'],
      endpoint: {
        transport: 'aisdk',
        baseUrl: 'https://bedrock.example',
        aiSdkProvider: 'bedrock',
      },
      modelsDevId: 'bedrock',
    };
    expect(def.oauth).toBeUndefined();
    expect(def.requestQuirks).toBeUndefined();
    expect(def.altEndpoints).toBeUndefined();
  });
});
