/**
 * Role-based LLM executor — Phase 4 W2 mini-prototype.
 *
 * Issues a single text-completion call for a logical role
 * (`consolidation`, `extraction`, `derivation`, `hygiene`, `judgement`) and
 * returns the normalized response. Internally:
 *
 *   1. {@link resolveLLMForRole}(role) — picks provider + model + credential
 *      from the standard config chain (roles → default → daemon → fallback).
 *   2. Selects the correct transport based on the resolved provider:
 *        - `'anthropic'` → {@link AnthropicTransport} (anthropic_messages mode)
 *        - everything else → {@link ChatCompletionsTransport} (OpenAI-compat)
 *   3. Maps `cred.authType` to the right SDK auth slot (`apiKey` vs
 *      `authToken` for Anthropic OAuth; Bearer header for OpenAI-compat OAuth).
 *
 * Replaces the hardcoded `fetch('https://api.anthropic.com/v1/messages')`
 * in {@link memory/sleep-consolidation.ts} and {@link memory/observer-reflector.ts}
 * so the brain layer respects per-role provider config and the T9261 Phase 3
 * unified credential/transport stack.
 *
 * This is intentionally narrow: text-only, no tools, no streaming, no batch.
 * The full {@link LlmExecutor} (W2, with multi-turn sessions, tool routing,
 * caching, and rotation) is a separate epic — this helper just unblocks the
 * brain's dream/compression layer in the meantime.
 *
 * @module llm/role-executor
 * @task T9320
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see ADR-072 §Type lock-in
 */

import type { RoleName } from '@cleocode/contracts';
import type {
  NormalizedUsage,
  TransportRequest,
} from '@cleocode/contracts/llm/normalized-response.js';

import type { ModelTransport } from './types-config.js';
import { resolveLLMForRole } from './role-resolver.js';
import {
  getKimiCodeMshHeaders,
  isKimiCodeApiKey,
} from './provider-registry/builtin/kimi-code.js';
import { AnthropicTransport } from './transports/anthropic.js';
import { ChatCompletionsTransport } from './transports/chat-completions.js';

/** Kimi Code chat endpoint — speaks Anthropic Messages protocol. */
const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding';

/**
 * Options accepted by {@link executeForRole}.
 *
 * Every field is optional — callers that want defaults can pass `{}`.
 */
export interface ExecuteForRoleOptions {
  /**
   * Absolute path to the project root. Forwarded to
   * {@link resolveLLMForRole} for tier-5 (project-config) credential lookup.
   */
  projectRoot?: string;
  /** Maximum tokens to generate. Default {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number;
  /** Optional abort signal forwarded to the SDK fetch. */
  signal?: AbortSignal;
  /** Optional model override — bypasses the role-resolved model. */
  modelOverride?: string;
  /** Sampling temperature in 0.0–1.0 range. Default left to the transport. */
  temperature?: number;
}

/**
 * Successful result of {@link executeForRole}.
 *
 * `null` is returned when no credential is configured or the transport call
 * fails — callers MUST handle the null path as a no-op (graceful degradation
 * preserves the previous structural-fallback behaviour in sleep-consolidation
 * and observer-reflector).
 */
export interface ExecuteForRoleResult {
  /** Assistant text content (may be the empty string but never null). */
  content: string;
  /** Token usage reported by the provider. */
  usage: NormalizedUsage;
  /** Provider transport identifier that was selected. */
  provider: ModelTransport;
  /** Model identifier as reported by the provider response. */
  model: string;
}

/** Default {@link TransportRequest.maxTokens} when caller omits it. */
const DEFAULT_MAX_TOKENS = 1024;

/**
 * Execute a single text-completion call for the given semantic role.
 *
 * Returns `null` on graceful-degradation paths:
 *   - No credential resolved for the configured provider.
 *   - Transport `complete()` throws (network error, 4xx, 5xx, abort).
 *
 * Errors are scrubbed via the same `console.warn` pattern the legacy
 * call-sites used, so log discipline is unchanged.
 *
 * @param role - Semantic role declared by the caller.
 * @param systemPrompt - System instruction for the LLM.
 * @param userContent - User message content.
 * @param opts - Optional max tokens, abort signal, model override.
 * @returns Normalized result or `null` on no-credential / transport error.
 *
 * @task T9320
 */
export async function executeForRole(
  role: RoleName,
  systemPrompt: string,
  userContent: string,
  opts: ExecuteForRoleOptions = {},
): Promise<ExecuteForRoleResult | null> {
  const llm = await resolveLLMForRole(role, { projectRoot: opts.projectRoot });
  if (!llm.credential?.apiKey) {
    return null;
  }

  const model = opts.modelOverride ?? llm.model;

  const request: TransportRequest = {
    model,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };

  try {
    if (llm.provider === 'anthropic') {
      // Anthropic supports two auth schemes — API key vs OAuth bearer.
      // Pass the credential through the matching SDK slot so the SDK sends
      // exactly one auth header (avoid x-api-key + Authorization collision).
      const transport =
        llm.credential.authType === 'oauth'
          ? new AnthropicTransport({
              authToken: llm.credential.apiKey,
              defaultHeaders: {
                'anthropic-beta': 'oauth-2025-04-20',
              },
            })
          : new AnthropicTransport({ apiKey: llm.credential.apiKey });

      const resp = await transport.complete(request);
      return {
        content: resp.content ?? '',
        usage: resp.usage,
        provider: llm.provider,
        model: resp.model,
      };
    }

    if (llm.provider === 'kimi-code') {
      // Kimi Code speaks Anthropic Messages protocol against
      // api.kimi.com/coding. Both `sk-kimi-*` API keys and OAuth bearer
      // tokens authenticate via `Authorization: Bearer …` — the legacy
      // Moonshot `mk-*` API-key path lives on the separate `moonshot`
      // provider, not here. Mandatory `X-Msh-*` headers are merged in.
      // (Defensive: also check the key prefix in case a misconfigured key
      // routed to kimi-code despite being a legacy moonshot key.)
      if (!isKimiCodeApiKey(llm.credential.apiKey) && llm.credential.authType !== 'oauth') {
        console.warn(
          `[role-executor] kimi-code credential is not sk-kimi- prefixed and not OAuth; ` +
            `the request may fail. Configure a coding-plan key from kimi.com/code or ` +
            `switch the provider to 'moonshot' for legacy mk- keys.`,
        );
      }
      const transport = new AnthropicTransport({
        authToken: llm.credential.apiKey,
        baseUrl: KIMI_CODE_BASE_URL,
        defaultHeaders: getKimiCodeMshHeaders(),
      });
      const resp = await transport.complete(request);
      return {
        content: resp.content ?? '',
        usage: resp.usage,
        provider: llm.provider,
        model: resp.model,
      };
    }

    // openai / openrouter / deepseek / xai / groq / moonshot / gemini-via-shim
    // — all speak OpenAI chat_completions. ChatCompletionsTransport routes
    // through the OpenAI SDK which sets Authorization: Bearer from apiKey.
    const transport = new ChatCompletionsTransport({
      provider: llm.provider,
      apiKey: llm.credential.apiKey,
    });
    const resp = await transport.complete(request);
    return {
      content: resp.content ?? '',
      usage: resp.usage,
      provider: llm.provider,
      model: resp.model,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[role-executor] role=${role} provider=${llm.provider} model=${model} call failed: ${message}`,
    );
    return null;
  }
}
