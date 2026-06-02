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
import { CredentialPool } from './credential-pool.js';
import { classifyError } from './error-classifier.js';
import { getKimiCodeMshHeaders, isKimiCodeApiKey } from './provider-registry/builtin/kimi-code.js';
import { resolveLLMForRole } from './role-resolver.js';
import { AnthropicTransport } from './transports/anthropic.js';
import { ChatCompletionsTransport } from './transports/chat-completions.js';
import { buildCodexOAuthHeaders, CODEX_OAUTH_BASE_URL } from './transports/codex-oauth-headers.js';
import { CodexResponsesTransport } from './transports/codex-responses.js';
import type { ModelTransport } from './types-config.js';

/** Kimi Code chat endpoint — speaks Anthropic Messages protocol. */
const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding';

/**
 * Process-lifetime latch set of `role|provider|label` keys that have already
 * emitted a credential-failure warning. Prevents a dead/rejected credential
 * from spamming the log on every background tick (e.g. every `cleo briefing`).
 * Cleared only by process restart — once a credential is fixed and re-picked,
 * a fresh `(role, provider, label)` tuple is logged again.
 *
 * @task T11617
 */
const WARNED_ROLE_FAILURES = new Set<string>();

/**
 * Emit a role-failure warning AT MOST ONCE per `(role, provider, label)` tuple
 * for the lifetime of the process. Subsequent identical failures are silent.
 *
 * @param key     - The `role|provider|label` latch key.
 * @param message - The full warning line to emit on first occurrence.
 * @task T11617
 */
function warnOnceForRole(key: string, message: string): void {
  if (WARNED_ROLE_FAILURES.has(key)) return;
  WARNED_ROLE_FAILURES.add(key);
  console.warn(message);
}

/**
 * Test-only: clear the role-failure warning latch so a fresh test run starts
 * from a clean slate. Production callers MUST NOT use this.
 *
 * @internal
 * @task T11617
 */
export function _resetRoleWarnLatchForTests(): void {
  WARNED_ROLE_FAILURES.clear();
}

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
    // No usable credential for this role's resolved provider. Surface ONE
    // actionable re-auth hint per (role, provider) tuple instead of a silent
    // skip — the caller still degrades gracefully via the null return.
    warnOnceForRole(
      `${role}|${llm.provider}|<none>`,
      `[role-executor] role=${role} provider=${llm.provider}: no usable credential. ` +
        `Run 'cleo llm login' (or 'cleo llm add ${llm.provider}') to authenticate, ` +
        `or 'cleo llm profile ${role} <provider>' to bind this role to a configured provider.`,
    );
    return null;
  }

  const credentialLabel = llm.credentialLabel ?? '<default>';
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

    if (llm.provider === 'openai' && llm.credential.authType === 'oauth') {
      // OpenAI Codex OAuth path. A ChatGPT-issued OAuth bearer token is NOT
      // accepted at `api.openai.com`; it authenticates against the Codex
      // backend (`chatgpt.com/backend-api/codex`) via the Responses API, with
      // the Cloudflare-bypass headers hermes-agent documented (originator +
      // ChatGPT-Account-ID). This is the branch the RCA found missing — it lets
      // a background role be fulfilled by the live `openai/codex-cli` OAuth
      // credential in the pool. (api_key OpenAI keeps the chat_completions
      // path below.)
      const transport = new CodexResponsesTransport({
        provider: llm.provider,
        apiKey: llm.credential.apiKey,
        baseUrl: CODEX_OAUTH_BASE_URL,
        defaultHeaders: buildCodexOAuthHeaders(llm.credential.apiKey),
      });
      const resp = await transport.complete(request);
      return {
        content: resp.content ?? '',
        usage: resp.usage,
        provider: llm.provider,
        model: resp.model,
      };
    }

    // openai (api_key) / openrouter / deepseek / xai / groq / moonshot /
    // gemini-via-shim — all speak OpenAI chat_completions. ChatCompletionsTransport
    // routes through the OpenAI SDK which sets Authorization: Bearer from apiKey.
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
    const classified = classifyError(err, { provider: llm.provider, model });
    const latchKey = `${role}|${llm.provider}|${credentialLabel}`;

    // Self-heal: a rejected (401/403) credential is quarantined so the resolver
    // stops re-picking the dead key on the next tick. `markExhausted` persists
    // a cooldown + `lastStatus` so `eligibleForProvider` skips it. We only
    // quarantine when we know the concrete credential label (a `<default>`
    // resolution has no addressable pool entry to mark).
    if (classified.reason === 'auth' && llm.credentialLabel) {
      // Fire-and-forget: quarantine MUST NOT block the graceful-degradation
      // return, and a write failure here is non-fatal (next tick retries).
      void new CredentialPool(llm.provider)
        .markExhausted(llm.credentialLabel, classified.statusCode ?? 401)
        .catch(() => {
          /* non-fatal: persistence error is retried next tick */
        });
      warnOnceForRole(
        latchKey,
        `[role-executor] role=${role} provider=${llm.provider} model=${model} ` +
          `credential '${credentialLabel}' rejected (${classified.statusCode ?? 401} auth). ` +
          `Quarantined this credential. Run 'cleo llm login' to re-authenticate, ` +
          `or 'cleo llm profile ${role} <provider>' to bind this role elsewhere.`,
      );
    } else {
      // Non-auth failure (network, 5xx, timeout). Log once per tuple so a
      // persistently-failing backend does not spam every background tick.
      warnOnceForRole(
        latchKey,
        `[role-executor] role=${role} provider=${llm.provider} model=${model} call failed: ${message}`,
      );
    }
    return null;
  }
}
