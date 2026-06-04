/**
 * `ModelRunner` — the single SSoT factory for LLM transports + language models.
 *
 * ## Why this exists (E9 · T11745 step 1 · T11761)
 *
 * CLEO previously constructed transports/SDK clients in FOUR places, each a
 * near-duplicate of the others:
 *
 *  - `session-factory.transportForProvider` (the canonical one)
 *  - `api.ts:_transportForConfig`
 *  - `tool-loop.ts:_transportForProvider`
 *  - the inline codex block in `role-executor.ts` (`:241`)
 *
 * plus the Vercel-AI-SDK `LanguageModel` construction duplicated in
 * `memory/llm-backend-resolver.ts` and the provider adapters.
 *
 * `ModelRunner.build(descriptor)` is the ONE place `new *Transport` /
 * `createAnthropic` / `createOpenAICompatible` may appear for the resolver
 * path. It consumes a {@link ResolvedLLMDescriptor} (carrying `apiMode`,
 * `baseUrl`, `authType`) and returns BOTH surfaces off the same sealed
 * credential:
 *
 *  - `session`       — a transport-backed {@link LlmSession} for the
 *                      cantbook/CLI/executor path (streaming, tool loops).
 *  - `languageModel` — a Vercel AI SDK {@link LanguageModel} for the
 *                      sentient/adapters path (`generateText`/`generateObject`),
 *                      or `null` when the provider has no Vercel binding here.
 *
 * Because the descriptor carries `apiMode`, codex "just works": a
 * `codex_responses` descriptor builds a {@link CodexResponsesTransport} with
 * the OAuth Cloudflare headers — no inline branch at the call-site.
 *
 * @module llm/model-runner
 * @task T11745
 * @task T11761
 * @epic T11745
 */

import type { ApiMode, ResolvedLLMDescriptor } from '@cleocode/contracts';
import type { LlmSession } from '@cleocode/contracts/llm/interfaces.js';
import type { LlmTransport } from '@cleocode/contracts/llm/normalized-response.js';
import type { ResolvedCredential } from '@cleocode/contracts/llm/resolved-credential.js';
import type { LanguageModel } from 'ai';
import { getLogger } from '../logger.js';
import { ConcreteSession } from './concrete-session.js';
import { getKimiCodeMshHeaders } from './provider-registry/builtin/kimi-code.js';
import { AnthropicTransport } from './transports/anthropic.js';
import { BedrockTransport } from './transports/bedrock.js';
import { ChatCompletionsTransport } from './transports/chat-completions.js';
import { buildCodexOAuthHeaders } from './transports/codex-oauth-headers.js';
import { CodexResponsesTransport } from './transports/codex-responses.js';
import { GeminiTransport } from './transports/gemini.js';
import { OllamaTransport } from './transports/ollama.js';
import type { ModelTransport } from './types-config.js';

const logger = getLogger('llm-model-runner');

/** Kimi Code chat endpoint — speaks the Anthropic Messages protocol. */
const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding';

/** Ollama's OpenAI-compatible `/v1` shim base URL (Vercel `LanguageModel` path). */
const OLLAMA_OPENAI_COMPAT_BASE_URL = 'http://localhost:11434/v1';

/**
 * Both runtime surfaces produced from a single {@link ResolvedLLMDescriptor}.
 *
 * @task T11745
 */
export interface BuiltModel {
  /**
   * Transport-backed session for the cantbook / CLI / executor path.
   * Always present (a transport is always constructible from the descriptor).
   */
  readonly session: LlmSession;
  /**
   * Vercel AI SDK language model for the sentient / adapters path.
   *
   * `null` when the provider has no Vercel binding in core (e.g. bedrock,
   * codex's ChatGPT backend, gemini-native) — those callers use {@link session}
   * instead. The descriptor's `apiMode` determines which binding is built.
   */
  readonly languageModel: LanguageModel | null;
}

/**
 * Convert the descriptor's wire credential into a {@link ResolvedCredential}
 * ready for a transport constructor.
 *
 * The descriptor carries the partial wire credential (`provider`, `apiKey`,
 * `authType`); the transport needs the fuller {@link ResolvedCredential}. Safe
 * defaults are supplied for fields the descriptor does not track (`refreshToken`,
 * `extraHeaders`, `expiresAt`, `awsProfile`). The descriptor's top-level
 * `baseUrl` wins so codex/ollama endpoints flow through.
 */
function descriptorToCredential(d: ResolvedLLMDescriptor): ResolvedCredential {
  const authType: 'api_key' | 'oauth' | 'aws_sdk' =
    d.authType === 'oauth' ? 'oauth' : d.authType === 'aws_sdk' ? 'aws_sdk' : 'api_key';
  return {
    provider: d.provider,
    label: d.credentialLabel ?? 'default',
    token: d.credential?.apiKey ?? '',
    authType,
    expiresAt: null,
    refreshToken: null,
    extraHeaders: {},
    baseUrl: d.baseUrl ?? null,
    awsProfile: null,
  };
}

/**
 * The single SSoT model factory (E9 · T11745).
 *
 * Stateless: every method takes a fully-resolved {@link ResolvedLLMDescriptor}
 * and constructs fresh transports / language models. No credential I/O, no
 * resolution — that happens upstream in `resolveLLMForRole` /
 * `resolveLLMForSystem`.
 */
export const ModelRunner = {
  /**
   * Construct the transport for a descriptor. This is the ONLY home for
   * `new *Transport` on the resolver path — the three legacy transport
   * factories delegate here (via {@link ModelRunner.buildTransportFromCredential}).
   *
   * Branches on `apiMode` (the descriptor's load-bearing field), falling back
   * to provider name for the anthropic/gemini/bedrock/ollama families.
   *
   * @param d - Fully-resolved descriptor.
   * @returns A wire-level transport bound to the descriptor's credential.
   */
  buildTransport(d: ResolvedLLMDescriptor): LlmTransport {
    return this.buildTransportFromCredential(
      d.provider as ModelTransport,
      descriptorToCredential(d),
      d.apiMode,
    );
  },

  /**
   * Lower-level transport factory: the single home for `new *Transport`.
   *
   * Accepts a fully-formed {@link ResolvedCredential} (so callers that already
   * hold one — `session-factory`, `api.ts`, `tool-loop.ts` — preserve their
   * `extraHeaders`/`baseUrl` verbatim) plus an optional explicit `apiMode`.
   * When `apiMode === 'codex_responses'` it builds the codex transport
   * regardless of provider name (xAI grok-via-responses, openai-oauth).
   *
   * @param provider - Resolved provider transport.
   * @param credential - Fully-resolved credential to wire in.
   * @param apiMode - Optional wire-protocol override (codex routing).
   * @returns A wire-level transport.
   */
  buildTransportFromCredential(
    provider: ModelTransport,
    credential: ResolvedCredential,
    apiMode?: ApiMode,
  ): LlmTransport {
    // Codex ChatGPT-backend path — keyed purely on apiMode (the whole point of
    // carrying apiMode in the descriptor). OAuth tokens authenticate against the
    // ChatGPT backend via the Responses API with the Cloudflare-bypass headers;
    // an api_key codex credential carries only its own extra headers.
    if (apiMode === 'codex_responses') {
      const defaultHeaders: Record<string, string> =
        credential.authType === 'oauth'
          ? { ...credential.extraHeaders, ...buildCodexOAuthHeaders(credential.token) }
          : { ...credential.extraHeaders };
      return new CodexResponsesTransport({
        apiKey: credential.token,
        baseUrl: credential.baseUrl ?? undefined,
        defaultHeaders: Object.keys(defaultHeaders).length ? defaultHeaders : undefined,
        provider,
      });
    }

    if (provider === 'anthropic') {
      // Mirrors the canonical `session-factory.transportForProvider` exactly:
      // OAuth → authToken slot; api_key → apiKey slot + any extra headers.
      const opts =
        credential.authType === 'oauth'
          ? {
              authToken: credential.token,
              baseUrl: credential.baseUrl ?? undefined,
              defaultHeaders: Object.keys(credential.extraHeaders).length
                ? credential.extraHeaders
                : undefined,
            }
          : {
              apiKey: credential.token,
              baseUrl: credential.baseUrl ?? undefined,
              defaultHeaders: Object.keys(credential.extraHeaders).length
                ? credential.extraHeaders
                : undefined,
            };
      return new AnthropicTransport(opts);
    }

    if (provider === 'kimi-code') {
      // Kimi Code speaks the Anthropic Messages protocol against its own endpoint.
      return new AnthropicTransport({
        authToken: credential.token,
        baseUrl: credential.baseUrl ?? KIMI_CODE_BASE_URL,
        defaultHeaders: getKimiCodeMshHeaders(),
      });
    }

    if (provider === 'bedrock') {
      return new BedrockTransport({
        awsProfile: credential.awsProfile ?? undefined,
      });
    }

    if (provider === 'gemini') {
      return new GeminiTransport({
        apiKey: credential.token,
        baseUrl: credential.baseUrl ?? undefined,
      });
    }

    if (provider === 'ollama') {
      return new OllamaTransport({
        baseUrl: credential.baseUrl ?? undefined,
        apiKey: credential.token || undefined,
        defaultHeaders: Object.keys(credential.extraHeaders).length
          ? credential.extraHeaders
          : undefined,
      });
    }

    // openai (api_key), openrouter, deepseek, xai, groq, moonshot → OpenAI-compat.
    const defaultHeaders: Record<string, string> = { ...credential.extraHeaders };
    if (credential.authType === 'oauth') {
      defaultHeaders['Authorization'] = `Bearer ${credential.token}`;
    }
    return new ChatCompletionsTransport({
      apiKey: credential.token,
      baseUrl: credential.baseUrl ?? undefined,
      defaultHeaders: Object.keys(defaultHeaders).length ? defaultHeaders : undefined,
      provider,
    });
  },

  /**
   * Construct a Vercel AI SDK {@link LanguageModel} for the sentient/adapters
   * path, or `null` when core has no Vercel binding for the descriptor's
   * provider/apiMode.
   *
   * - `anthropic_messages` → `createAnthropic`
   * - `chat_completions` / `ollama_native` → `createOpenAICompatible`
   * - everything else (codex_responses, bedrock_converse) → `null`
   *
   * Returns `null` (rather than throwing) on any binding failure so the caller
   * degrades to the transport path. Async because the AI-SDK provider modules
   * are dynamically imported (keeps them out of the module-init chain).
   *
   * @param d - Fully-resolved descriptor.
   * @returns A Vercel `LanguageModel`, or `null` when unsupported here.
   */
  async buildLanguageModel(d: ResolvedLLMDescriptor): Promise<LanguageModel | null> {
    const apiKey = d.credential?.apiKey ?? null;
    try {
      if (d.apiMode === 'anthropic_messages' && d.provider === 'anthropic') {
        if (!apiKey) return null;
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        return createAnthropic({ apiKey })(d.model);
      }

      if (d.apiMode === 'chat_completions' || d.apiMode === 'ollama_native') {
        // The Vercel openai-compatible provider REQUIRES a base URL. Use the
        // descriptor's override, the ollama localhost shim, or the canonical
        // OpenAI endpoint; otherwise the caller falls back to the transport.
        const baseURL =
          d.baseUrl ??
          (d.provider === 'ollama'
            ? OLLAMA_OPENAI_COMPAT_BASE_URL
            : d.provider === 'openai'
              ? 'https://api.openai.com/v1'
              : null);
        if (!baseURL) return null;
        // ollama needs no key; remote openai-compatible servers do.
        if (!apiKey && d.provider !== 'ollama') return null;
        const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
        const provider = createOpenAICompatible({
          name: d.provider,
          baseURL,
          ...(apiKey ? { apiKey } : {}),
        });
        return provider(d.model);
      }

      // codex_responses / bedrock_converse have no core Vercel binding — the
      // caller uses the transport session instead.
      return null;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), provider: d.provider },
        'model-runner: languageModel construction failed; returning null (caller falls back to transport)',
      );
      return null;
    }
  },

  /**
   * Build BOTH surfaces (transport session + Vercel language model) from one
   * descriptor. The transport session is always present; `languageModel` is
   * `null` for providers without a core Vercel binding.
   *
   * @param d - Fully-resolved descriptor.
   * @returns The {@link BuiltModel} pair.
   */
  async build(d: ResolvedLLMDescriptor): Promise<BuiltModel> {
    const transport = this.buildTransport(d);
    const credential = descriptorToCredential(d);
    const session = new ConcreteSession({
      transport,
      model: d.model,
      credential,
    });
    const languageModel = await this.buildLanguageModel(d);
    return { session, languageModel };
  },
} as const;
