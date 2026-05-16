/**
 * Default LlmSession factory implementation.
 *
 * Resolves the correct transport and credential for a role or explicit
 * provider/credential pair, then wraps them in a {@link ConcreteSession}.
 *
 * @module llm/session-factory
 * @task T9288
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see ADR-072 §2.2
 */

import type {
  LlmSession,
  LlmSessionFactory,
  RetryPolicy,
  SessionFactoryOptions,
} from '@cleocode/contracts/llm/interfaces.js';
import type { LlmTransport } from '@cleocode/contracts/llm/normalized-response.js';
import type { ResolvedCredential } from '@cleocode/contracts/llm/resolved-credential.js';
import { ConcreteSession } from './concrete-session.js';
import { resolveLLMForRole } from './role-resolver.js';
import { AnthropicTransport } from './transports/anthropic.js';
import { BedrockTransport } from './transports/bedrock.js';
import { ChatCompletionsTransport } from './transports/chat-completions.js';
import { GeminiTransport } from './transports/gemini.js';
import type { ModelTransport } from './types-config.js';

// ---------------------------------------------------------------------------
// Transport factory
// ---------------------------------------------------------------------------

/**
 * Instantiate the correct {@link LlmTransport} for a provider/credential pair.
 *
 * Provider mapping:
 * - `'anthropic'` → {@link AnthropicTransport}
 * - `'bedrock'` → {@link BedrockTransport} (AWS credential chain; token unused)
 * - `'gemini'` → {@link GeminiTransport}
 * - everything else → {@link ChatCompletionsTransport} (OpenAI-compatible)
 *
 * @param provider - Provider identifier.
 * @param credential - Resolved credential to wire into the transport.
 * @returns The appropriate transport instance.
 */
function transportForProvider(
  provider: ModelTransport,
  credential: ResolvedCredential,
): LlmTransport {
  if (provider === 'anthropic') {
    const opts =
      credential.authType === 'oauth'
        ? { authToken: credential.token, baseUrl: credential.baseUrl ?? undefined }
        : {
            apiKey: credential.token,
            baseUrl: credential.baseUrl ?? undefined,
            defaultHeaders: Object.keys(credential.extraHeaders).length
              ? credential.extraHeaders
              : undefined,
          };
    return new AnthropicTransport(opts);
  }

  if (provider === 'bedrock') {
    // BedrockTransport resolves credentials via fromNodeProviderChain() internally.
    // The credential.awsProfile field carries the optional profile override.
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

  // All other providers (openai, moonshot, openrouter, deepseek, xai, groq,
  // kimi-code, …) use ChatCompletionsTransport.
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
}

// ---------------------------------------------------------------------------
// Credential bridging helper
// ---------------------------------------------------------------------------

/**
 * Build a {@link ResolvedCredential} from the Phase-2 `CredentialResult`
 * returned by `resolveLLMForRole`.
 *
 * The Phase-2 shape does not carry `label`, `refreshToken`, `extraHeaders`,
 * `baseUrl`, or `awsProfile` — we supply safe defaults for fields that
 * `ConcreteSession` does not strictly require for its lifecycle checks.
 *
 * @internal
 */
function credentialResultToResolved(params: {
  provider: ModelTransport;
  apiKey: string;
  authType: 'api_key' | 'oauth';
  label?: string;
}): ResolvedCredential {
  return {
    provider: params.provider,
    label: params.label ?? 'default',
    token: params.apiKey,
    authType: params.authType,
    expiresAt: null,
    refreshToken: null,
    extraHeaders: {},
    baseUrl: null,
    awsProfile: null,
  };
}

// ---------------------------------------------------------------------------
// DefaultLlmSessionFactory
// ---------------------------------------------------------------------------

/**
 * Default factory for creating {@link LlmSession} instances.
 *
 * Uses the Phase-2 `resolveLLMForRole` resolution chain
 * (roles → default → daemon → implicit fallback) and wraps the result
 * in a {@link ConcreteSession} with the correct transport.
 *
 * @example
 * ```ts
 * const factory = new DefaultLlmSessionFactory();
 * const session = await factory.createForRole('consolidation');
 * const response = await session.send([{ role: 'user', content: 'Hello' }]);
 * ```
 */
export class DefaultLlmSessionFactory implements LlmSessionFactory {
  private readonly _defaultRetryPolicy: RetryPolicy | undefined;

  /**
   * @param opts - Optional factory-level defaults.
   * @param opts.retryPolicy - Default retry policy applied to all created sessions.
   */
  constructor(opts?: { retryPolicy?: RetryPolicy }) {
    this._defaultRetryPolicy = opts?.retryPolicy;
  }

  /**
   * Creates a session resolved from the given role name.
   *
   * Resolution chain: `role → config.llm.roles[role] → config.llm.default
   * → config.llm.daemon → implicit anthropic/haiku fallback`.
   *
   * @param role - CLEO role name (e.g. `'orchestrator'`, `'sentient'`).
   * @returns A promise resolving to an initialized {@link LlmSession}.
   * @throws When no credential is available for the resolved provider.
   */
  async createForRole(role: string): Promise<LlmSession> {
    return this.create({ role });
  }

  /**
   * Creates a session with the given options.
   *
   * When `opts.role` is set, uses `resolveLLMForRole` for provider/credential
   * resolution. When `opts.providerId` + `opts.model` are set, the caller
   * must supply a credential via the `create` path.
   *
   * @param opts - Session construction options.
   * @returns A promise resolving to an initialized {@link LlmSession}.
   * @throws When no credential is available or the provider is unknown.
   */
  async create(opts: SessionFactoryOptions): Promise<LlmSession> {
    if (!opts.role && (!opts.providerId || !opts.model)) {
      throw new Error(
        'DefaultLlmSessionFactory.create: must supply either role or (providerId + model)',
      );
    }

    if (opts.role) {
      const resolved = await resolveLLMForRole(
        opts.role as Parameters<typeof resolveLLMForRole>[0],
      );

      if (!resolved.credential?.apiKey) {
        throw new Error(
          `No credential available for role '${opts.role}' / provider '${resolved.provider}'`,
        );
      }

      const resolvedCredential = credentialResultToResolved({
        provider: resolved.provider,
        apiKey: resolved.credential.apiKey,
        authType: resolved.credential.authType,
        label: resolved.credentialLabel,
      });

      const transport = transportForProvider(resolved.provider, resolvedCredential);

      return new ConcreteSession({
        transport,
        model: resolved.model,
        credential: resolvedCredential,
        retryPolicy: opts.retryPolicy ?? this._defaultRetryPolicy,
      });
    }

    // Explicit provider + model path — caller must have already resolved credential.
    // This path is reserved for future use by the executor layer (W3).
    throw new Error(
      'DefaultLlmSessionFactory.create: providerId+model path requires a resolved credential. ' +
        'Use createForRole() or wire the explicit credential via ConcreteSession directly.',
    );
  }
}
