/**
 * LLM operations contract types for the CLEO LLM abstraction layer.
 *
 * These are the wire-format types for the new `cleoLlmCall()` API surface
 * ported from PSYCHE's llm/ layer. They live in contracts so that packages
 * outside core can reference them without importing the full SDK.
 *
 * @task T1399 (T1386-W13)
 * @epic T1386
 */

import type { BuiltinProviderId, ProviderId } from '../llm/provider-id.js';

/**
 * @deprecated since Phase 4 (ADR-072). Use {@link ProviderId} from
 * `@cleocode/contracts/llm/provider-id.js` for new code. This alias remains
 * for one release cycle to ease migration of legacy callers, then is removed.
 *
 * The alias resolves to {@link BuiltinProviderId} — a superset of the previous
 * closed literal union (`'anthropic' | 'openai' | 'gemini' | 'moonshot'`).
 * All existing consumers that pattern-match on the previous four values continue
 * to compile without changes.
 *
 * @see ADR-072 §Type lock-in — ModelTransport deprecation cycle
 */
export type ModelTransport = Extract<ProviderId, BuiltinProviderId>;

/** Cache policy mode for prompt prefix caching. */
export type PromptCachePolicyMode = 'gemini_cached_content';

/** Prompt caching policy descriptor. */
export interface PromptCachePolicy {
  /** Cache mode — only 'gemini_cached_content' currently supported. */
  mode: PromptCachePolicyMode;
  /** TTL in seconds for the cached content (default: 300). */
  ttlSeconds?: number;
  /** Key version for cache invalidation. */
  keyVersion?: string;
}

/** Model configuration for a single provider. */
export interface ModelConfig {
  /** Provider SDK transport. */
  transport: ModelTransport;
  /** Full model identifier string (e.g. 'claude-sonnet-4-6', 'gpt-4o', 'gemini-pro'). */
  model: string;
  /** Override API key (uses env defaults if null). */
  apiKey?: string | null;
  /** Override base URL for proxy providers. */
  baseUrl?: string | null;
  /** Sampling temperature. */
  temperature?: number | null;
  top_p?: number | null;
  top_k?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  seed?: number | null;
  /** OpenAI reasoning effort level. */
  thinkingEffort?: string | null;
  /** Anthropic extended thinking budget tokens. */
  thinkingBudgetTokens?: number | null;
  /** Provider-specific passthrough params. */
  providerParams?: Record<string, unknown> | null;
  /** Override max output tokens (null = use per-call maxTokens). */
  maxOutputTokens?: number | null;
  /** Stop sequences. */
  stopSequences?: string[] | null;
  /** Prompt caching policy. */
  cachePolicy?: PromptCachePolicy | null;
  /** Fallback model config used on final retry attempt. */
  fallback?: Omit<ModelConfig, 'fallback'> | null;
  /**
   * Extra HTTP headers to attach to the provider client (merged into the SDK's
   * `defaultHeaders`). Populated from `authHeaders(cred)` when a credential is
   * resolved with `authType: 'oauth'` so the provider client uses the
   * `Authorization: Bearer …` scheme instead of `x-api-key`.
   *
   * @task T-LLM-CRED-CENTRALIZATION Phase 1
   */
  extraHeaders?: Record<string, string> | null;
}

/** Parameters for a single LLM call. */
export interface LLMCallParams {
  modelConfig: ModelConfig;
  prompt: string;
  maxTokens: number;
  /** Optional pre-built message list (overrides prompt string). */
  messages?: Array<Record<string, unknown>> | null;
  temperature?: number | null;
  stopSeqs?: string[] | null;
  jsonMode?: boolean;
  reasoningEffort?: string | null;
  verbosity?: 'low' | 'medium' | 'high' | null;
  thinkingBudgetTokens?: number | null;
  enableRetry?: boolean;
  retryAttempts?: number;
  stream?: boolean;
  streamFinalOnly?: boolean;
  tools?: Array<Record<string, unknown>> | null;
  toolChoice?: string | Record<string, unknown> | null;
  maxToolIterations?: number;
  maxInputTokens?: number | null;
  traceName?: string | null;
  trackName?: string | null;
}

/** Tool call parameters from the LLM. */
export interface ToolCallParams {
  id: string;
  name: string;
  input: Record<string, unknown>;
  thoughtSignature?: string | null;
}

/** Tool execution result to feed back to the LLM. */
export interface ToolResult {
  toolId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
}

/** Result of a completed LLM call. */
export interface LLMCallResult<T = string> {
  content: T;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  finishReasons: string[];
  toolCallsMade: ToolCallParams[];
  iterations: number;
  thinkingContent: string | null;
  thinkingBlocks: Array<Record<string, unknown>>;
  reasoningDetails: Array<Record<string, unknown>>;
}

// ============================================================================
// Credential resolution wire types (T-LLM-CRED-CENTRALIZATION Phase 1/2)
//
// These mirror the runtime types declared in `@cleocode/core/llm/credentials.ts`
// but live here so packages outside `core` (CLI, harness, studio) can speak
// the same wire vocabulary without taking a dependency on core internals.
// The runtime module re-exports compatible aliases so existing imports keep
// working.
// ============================================================================

/**
 * Which credential-resolution tier produced a {@link CredentialResultWire}.
 *
 * Mirrors `CredentialSource` in `@cleocode/core/llm/credentials.ts`. The set is
 * append-only; new tiers (e.g. `aws-sdk`, `gcp-sdk` in Phase 3) extend this
 * union.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 1
 * @task T9255
 */
export type CredentialSourceWire =
  | 'explicit'
  | 'env'
  | 'cred-file'
  | 'claude-creds'
  | 'global-config'
  | 'project-config';

/**
 * Authentication scheme used when sending the credential to the provider.
 *
 * - `api_key` — provider-issued long-lived key sent as `x-api-key` (Anthropic)
 *   or `Authorization: Bearer …` (OpenAI, Gemini, Moonshot).
 * - `oauth` — short-lived OAuth bearer token sent as `Authorization: Bearer …`
 *   with the matching beta header.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 1
 * @task T9255
 */
export type AuthTypeWire = 'api_key' | 'oauth';

/**
 * Resolved credential as returned by `resolveCredentials()` /
 * `resolveLLMForRole()`. Mirrors `CredentialResult` in core. Compatible by
 * structural typing.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 1
 * @task T9255
 */
export interface CredentialResultWire {
  /** Provider transport this credential is for. */
  provider: ModelTransport;
  /** API key or OAuth bearer token. `null` only when no credential was found. */
  apiKey: string | null;
  /** Which tier produced this credential. `undefined` when `apiKey` is `null`. */
  source: CredentialSourceWire | undefined;
  /** Scheme used to present the credential to the provider. */
  authType: AuthTypeWire;
}

// ============================================================================
// Role-based LLM resolution wire types (T9255 — Phase 2 T-llm-1)
// ============================================================================

/**
 * Which configuration tier produced a {@link ResolvedLLM}.
 *
 * Resolution chain order:
 *   1. `role`               — `config.llm.roles[role]` (explicit override)
 *   2. `profile`            — `config.llm.profiles[roles[role].profile]`
 *   3. `default`            — `config.llm.default` (canonical default)
 *   4. `default-profile`    — `config.llm.profiles[config.llm.defaultProfile]`
 *   5. `implicit-fallback`  — hard-coded fallback inside the resolver
 *
 * Useful for `cleo llm whoami` diagnostics.
 *
 * @task T9306
 * @task T11617 (`profile`, `default-profile`)
 */
export type ResolutionSource =
  | 'role'
  | 'profile'
  | 'default'
  | 'default-profile'
  | 'implicit-fallback';

/**
 * Result envelope returned by `resolveLLMForRole(role)`.
 *
 * Carries the fully-wired SDK client plus the {@link CredentialResultWire}
 * so raw-fetch callers (sleep-consolidation, observer-reflector, hygiene-scan)
 * can call `authHeaders(credential)` themselves when bypassing the SDK
 * client (e.g. to call the Anthropic Messages REST API directly).
 *
 * `client` is `null` only when `credential.apiKey` is also `null` — in which
 * case the caller MUST fall back to its graceful-degradation path
 * (`return null` / skip / log warn).
 *
 * `client` is typed as `unknown` here because the concrete SDK classes
 * (Anthropic, OpenAI, GoogleGenerativeAI) are not referenced from contracts
 * to preserve its zero-dependency footprint. Consumers MUST narrow via the
 * typed helpers in `@cleocode/core/llm/role-resolver` (e.g.
 * `resolveAnthropicForRole`) rather than casting with `as unknown as X`.
 *
 * @task T9255
 */
export interface ResolvedLLM {
  /** LLM provider transport that was resolved. */
  provider: ModelTransport;
  /** Full model identifier. */
  model: string;
  /**
   * Fully-wired SDK client constructed via `clientForModelConfig`. `null`
   * when no credential is available. Typed as `unknown` — consumers MUST
   * narrow via a provider-specific helper (e.g. `resolveAnthropicForRole`
   * in `@cleocode/core/llm/role-resolver`), NEVER via an `as unknown as X`
   * cast.
   */
  client: unknown;
  /**
   * Resolved credential. `null` when no tier produced a token. Callers
   * MUST handle this case.
   */
  credential: CredentialResultWire | null;
  /** Which config path produced this resolution. */
  source: ResolutionSource;
  /** When `roles[role].credentialLabel` was set, the label that was used. */
  credentialLabel?: string;
}

/**
 * Options accepted by `resolveLLMForRole()`.
 *
 * @task T9255
 */
export interface ResolveLLMForRoleOptions {
  /**
   * Absolute path to the project root. Forwarded to `loadConfig()` and to
   * `resolveCredentials({ projectRoot })` for tier-5 project-config lookup.
   * Defaults to `process.cwd()`.
   */
  projectRoot?: string;
}

// ============================================================================
// `cleo llm` CLI / dispatch operation contracts (T9258 — Phase 2 T-llm-4)
//
// Wire types backing the `cleo llm` CLI subcommands and the `llm` dispatch
// domain. Provider-redacted views of `StoredCredential` (defined in
// `@cleocode/core/llm/credentials-store`) plus the dispatch param/result
// shapes for add / list / remove / use / profile / test / whoami.
//
// Tokens are NEVER returned in raw form by these envelopes — `tokenPreview`
// surfaces only the last 4 characters so the wire vocabulary is safe for
// JSON output, logs, and remote dispatch consumers.
// ============================================================================

/**
 * Storage-level authentication scheme as persisted in the credentials store.
 *
 * Wider than the wire-level {@link AuthTypeWire}: includes `'aws_sdk'` for
 * Bedrock / Vertex entries where the AWS SDK supplies the credential
 * out-of-band. The runtime resolver narrows `'aws_sdk' → 'api_key'` for
 * wire-level use until Phase 3 widens {@link AuthTypeWire}.
 *
 * Mirrors `StoredAuthType` in `@cleocode/core/llm/credentials-store`.
 *
 * @task T9258
 */
export type StoredAuthTypeWire = 'api_key' | 'oauth' | 'aws_sdk';

/**
 * Strategy used by the credentials-store picker.
 *
 * Mirrors `CredentialsStoreStrategy` in
 * `@cleocode/core/llm/credentials-store`. Held here so callers outside
 * `core` can render UI without taking a dependency on the storage module.
 *
 * @task T9258
 */
export type CredentialsStoreStrategyWire = 'priorityWithFallback' | 'roundRobin' | 'priorityOnly';

/**
 * Token-redacted view of a single stored credential.
 *
 * `tokenPreview` is the last 4 characters of `accessToken` prefixed by
 * `'…'` (e.g. `'…aB7q'`). The full token is NEVER returned by any
 * `cleo llm` operation — callers that need the live token must resolve it
 * through `resolveLLMForRole()`.
 *
 * @task T9258
 */
export interface LlmStoredCredentialView {
  /** LLM transport this credential is for. */
  provider: ModelTransport;
  /** Human-readable identifier, unique within `provider`. */
  label: string;
  /** Storage-level auth scheme. */
  authType: StoredAuthTypeWire;
  /** Redacted token preview — last 4 chars, prefixed by `'…'`. */
  tokenPreview: string;
  /** Whether the entry carried a non-empty refresh token. */
  hasRefreshToken: boolean;
  /** Unix epoch ms; `null` means "never expires". */
  expiresAt: number | null;
  /** Lower wins. */
  priority: number;
  /** Free-form provenance label (`claude-code`, `cli-input`, etc.). */
  source: string | undefined;
  /** Optional override for provider base URL. */
  baseUrl: string | null;
  /** When `true`, the picker skips this entry. */
  disabled: boolean;
}

/**
 * Parameters for `llm.add` (mutate).
 *
 * Mirrors the `cleo llm add <provider> --api-key <k>` CLI surface. When
 * `authType` is omitted, the dispatcher auto-detects from the token
 * prefix: tokens beginning with `sk-ant-oat-` are stored as `'oauth'`,
 * everything else as `'api_key'`.
 *
 * @task T9258
 */
export interface LlmAddParams {
  /** Target provider transport. */
  provider: ModelTransport;
  /** API key or OAuth bearer token to persist. */
  apiKey: string;
  /** Human-readable label, unique within `provider`. Defaults to `'default'`. */
  label?: string;
  /** Optional override for the provider base URL. */
  baseUrl?: string;
  /** Optional explicit auth type override (skips prefix auto-detect). */
  authType?: StoredAuthTypeWire;
  /** Optional priority override (lower wins). */
  priority?: number;
}

/**
 * Result envelope for `llm.add`.
 *
 * @task T9258
 */
export interface LlmAddResult {
  /** Token-redacted view of the newly stored entry. */
  credential: LlmStoredCredentialView;
  /** Detected auth type (`'oauth'` for `sk-ant-oat-*`, else `'api_key'`). */
  detectedAuthType: StoredAuthTypeWire;
}

/**
 * Parameters for `llm.list` (query).
 *
 * @task T9258
 */
export interface LlmListParams {
  /** Optional provider filter — when set, only entries for that provider. */
  provider?: ModelTransport;
}

/**
 * Result envelope for `llm.list`.
 *
 * @task T9258
 */
export interface LlmListResult {
  /** Token-redacted credentials, in store order (priority asc). */
  credentials: LlmStoredCredentialView[];
}

/**
 * Parameters for `llm.remove` (mutate).
 *
 * @task T9258
 */
export interface LlmRemoveParams {
  /** Target provider transport. */
  provider: ModelTransport;
  /** Label of the credential to remove. */
  label: string;
}

/**
 * Result envelope for `llm.remove`.
 *
 * @task T9258
 */
export interface LlmRemoveResult {
  /** `true` when a matching entry was deleted. */
  removed: boolean;
  /** Echo of the targeted `(provider, label)` pair. */
  provider: ModelTransport;
  /** Echo of the targeted label. */
  label: string;
}

/**
 * Parameters for `llm.use` (mutate) — set `llm.default.{provider,model}`.
 *
 * @task T9258
 */
export interface LlmUseParams {
  /** Provider transport to mark as the default. */
  provider: ModelTransport;
  /** Optional default model identifier. When omitted, `default.model` is left untouched. */
  model?: string;
}

/**
 * Result envelope for `llm.use`.
 *
 * @task T9258
 */
export interface LlmUseResult {
  /** Provider written to `llm.default.provider`. */
  provider: ModelTransport;
  /** Model written to `llm.default.model` — `null` when not provided. */
  model: string | null;
  /** Config scope the write landed in (`'global'` for `cleo llm use`). */
  scope: 'project' | 'global';
}

/**
 * Parameters for `llm.profile` (mutate) — set `llm.roles[role]`.
 *
 * @task T9258
 */
export interface LlmProfileParams {
  /** Logical role name. */
  role: string;
  /** Provider transport for this role. */
  provider: ModelTransport;
  /** Optional model identifier for this role. */
  model?: string;
  /** Optional credential label to pin this role to a specific store entry. */
  credentialLabel?: string;
}

/**
 * Result envelope for `llm.profile`.
 *
 * @task T9258
 */
export interface LlmProfileResult {
  /** Role name written to `llm.roles[role]`. */
  role: string;
  /** Provider written for the role. */
  provider: ModelTransport;
  /** Model written for the role (or `null` when not supplied). */
  model: string | null;
  /** Credential label written for the role (or `null` when not supplied). */
  credentialLabel: string | null;
  /** Config scope the write landed in. */
  scope: 'project' | 'global';
}

/**
 * Parameters for `llm.test` (query).
 *
 * @task T9258
 */
export interface LlmTestParams {
  /** Provider transport to test. */
  provider: ModelTransport;
  /** Optional credential label to pin the test to a specific store entry. */
  label?: string;
  /** Optional model override. Defaults to the provider's implicit fallback. */
  model?: string;
}

/**
 * Result envelope for `llm.test`. Tokens are NEVER included.
 *
 * @task T9258
 */
export interface LlmTestResult {
  /** Provider transport that was probed. */
  provider: ModelTransport;
  /** Model identifier used for the probe. */
  model: string;
  /** End-to-end round-trip latency in ms. */
  latencyMs: number;
  /** Provider response identifier (e.g. Anthropic `msg_…`). `null` when unavailable. */
  providerResponseId: string | null;
  /** Redacted credential preview (last 4 chars) — confirms which entry was used. */
  credentialPreview: string;
  /** Resolution tier that produced the credential (`env`, `cred-file`, etc.). */
  credentialSource: CredentialSourceWire;
}

/**
 * Single `whoami` row — one entry per `RoleName`.
 *
 * @task T9258
 */
export interface LlmWhoamiEntry {
  /** Role name (`'extraction' | 'consolidation' | ...`). */
  role: string;
  /** Provider that would be picked for this role. */
  provider: ModelTransport;
  /** Model that would be used. */
  model: string;
  /** Which config tier produced the resolution. */
  source: ResolutionSource;
  /** Credential label, when the role pinned a specific store entry. */
  credentialLabel: string | undefined;
  /** Resolution tier of the eventual credential, when one was reachable. */
  credentialSource: CredentialSourceWire | undefined;
  /** Whether a usable credential exists for this role. */
  hasCredential: boolean;
}

/**
 * Parameters for `llm.whoami` (query). Reserved for future filters.
 *
 * @task T9258
 */
export interface LlmWhoamiParams {
  /** Optional role filter — when set, only that role is resolved. */
  role?: string;
}

/**
 * Result envelope for `llm.whoami`.
 *
 * @task T9258
 */
export interface LlmWhoamiResult {
  /** One entry per role resolved (filtered by `params.role` when set). */
  entries: LlmWhoamiEntry[];
}

// ProviderProfile interface lives in ./llm/provider-profile.ts (T9262).
// The generated catalog (packages/core/src/llm/generated/provider-profiles.ts)
// imports the canonical type from the contracts package and emits each
// generated entry as a plain ProviderProfile literal.

// ---------------------------------------------------------------------------
// llm auxiliary-status types (T9319)
// ---------------------------------------------------------------------------

/**
 * A single entry in the auxiliary fallback chain as surfaced by
 * `cleo llm auxiliary-status`.
 *
 * @task T9319
 */
export interface LlmAuxiliaryChainEntry {
  /** Provider transport identifier (e.g. `'anthropic'`, `'openrouter'`). */
  provider: ModelTransport;
  /** Optional pinned model for this provider. Omitted when using role-resolved default. */
  model?: string;
}

/**
 * Parameters for `llm.auxiliary-status` (query).
 *
 * @task T9319
 */
export interface LlmAuxiliaryStatusParams {
  /** Optional project root for config resolution. */
  projectRoot?: string;
}

/**
 * Result envelope for `llm.auxiliary-status` (query).
 *
 * @task T9319
 */
export interface LlmAuxiliaryStatusResult {
  /**
   * The active auxiliary fallback chain.
   *
   * When `source === 'config'`, reflects `llm.auxiliaryFallback` in config.
   * When `source === 'default'`, the built-in default chain is active.
   */
  chain: LlmAuxiliaryChainEntry[];
  /**
   * How the chain was resolved.
   *
   * - `'config'` — explicitly configured via `cleo config set llm.auxiliaryFallback`.
   * - `'default'` — no config found; built-in default chain in use.
   */
  source: 'config' | 'default';
  /** Human-readable config path users can set to change the chain. */
  configKey: string;
  /** Example value for the config key. */
  configExample: string;
}

// ---------------------------------------------------------------------------
// llm-status types (T9323)
// ---------------------------------------------------------------------------

/**
 * Resolved credential source for a single LLM provider.
 *
 * Mirrors the subset of `CredentialSource` relevant for human-facing status
 * output. `'none'` means no credential was found at any tier.
 *
 * @task T9323
 */
export type LlmProviderSourceWire = 'env' | 'cred-file' | 'claude-creds' | 'config' | 'none';

/**
 * Per-provider status entry emitted by `cleo memory llm-status`.
 *
 * @task T9323
 */
export interface LlmProviderStatusEntry {
  /** Provider identifier (e.g. `'anthropic'`, `'kimi-code'`). */
  provider: string;
  /** Which credential tier resolved the key, or `'none'` if unavailable. */
  resolvedSource: LlmProviderSourceWire;
  /** `true` when a usable credential was found. */
  hasCredential: boolean;
}

/**
 * Result envelope for `memory.llm-status` (query).
 *
 * @task T9323
 */
export interface LlmStatusResult {
  /** Legacy anthropic-only resolved source (kept for backward compat). */
  resolvedSource: string;
  /** `true` when an Anthropic credential is available (legacy compat field). */
  extractionEnabled: boolean;
  /** ISO timestamp of the most recent extraction run, or `null`. */
  lastExtractionRun: string | null;
  /** Suggested test command. */
  testCommand: string;
  /** Per-provider status for all known OAuth providers. */
  providers: LlmProviderStatusEntry[];
}
