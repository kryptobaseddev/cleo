/**
 * Declarative `ProviderDef` contract — the DATA shape of one LLM provider.
 *
 * M3 Provider SSoT (epic T11667 · task T11702). `ProviderDef` is the DECLARATIVE,
 * serializable description of a provider: its identity, aliases, auth methods, wire
 * endpoint (a discriminated union keyed on the `transport` literal), models.dev
 * catalog key, default headers, optional OAuth flow, and a single request-quirk hook
 * signature. It is the contract the `providers` global-DB table (T11703) persists and
 * the alias resolver (T11704) reads.
 *
 * ## ProviderDef vs {@link ProviderProfile} — declarative DATA vs runtime BEHAVIOUR
 *
 * The pre-existing {@link ProviderProfile} (T9262 · T11756) is the RUNTIME provider
 * shape carried in the in-process registry: it bundles live hook FUNCTIONS
 * (`prepareMessages`, `buildExtraBody`, `buildApiKwargsExtras`, `fetchModels`) that
 * cannot be serialized into a DB row. `ProviderDef` is the DECLARATIVE projection of
 * the same provider — only serializable DATA — so it can be a `providers` table row,
 * shipped as a seed, diffed, and resolved without importing provider-specific code.
 * The builtin `ProviderProfile` set is the SEED SOURCE for the builtin `ProviderDef`
 * set (the core mapper derives one from the other); the non-serializable hooks stay
 * on `ProviderProfile`, reduced here to the single declarative {@link RequestQuirk}
 * descriptor that records WHICH quirk a provider needs without embedding a closure.
 *
 * ## Endpoint is a discriminated union (AC5)
 *
 * {@link ProviderEndpoint} is a closed discriminated union keyed on the literal
 * `transport` field — one variant per wire protocol CLEO knows how to speak. No
 * `any`/`unknown` shortcut: every variant carries its own typed fields. This is the
 * declarative analog of {@link ApiMode}; the core transport adapter table (T11767)
 * maps a `transport` value to its `Transport` constructor.
 *
 * ## Contracts purity (Gate 10)
 *
 * This module is TYPES ONLY — interfaces, type aliases, and `as const` literal arrays.
 * It exports NO bodied runtime helper. The builtin-set construction and the seed/upsert
 * logic live in `@cleocode/core` (T11703 · T11704), never here.
 *
 * @module llm/provider-def
 * @task T11702
 * @epic T11667
 * @see ./provider-profile.ts — the RUNTIME provider shape (hooks) this projects from
 * @see ./provider-id.ts — {@link ApiMode} / {@link BuiltinProviderId} the transport mirrors
 * @see ./oauth.ts — {@link ProviderOAuthConfig} the OAuth flow placeholder reuses
 * @see ../../../core/src/store/schema/cleo-global/providers.ts — the persisted table (T11703)
 */

import type { StoredAuthTypeWire } from '../operations/llm.js';
import type { ProviderOAuthConfig } from './oauth.js';
import type { ProviderId } from './provider-id.js';

/**
 * Wire-transport discriminant for a {@link ProviderEndpoint} variant.
 *
 * Closed union — one literal per protocol CLEO has a transport for. The
 * declarative analog of {@link import('./provider-id.js').ApiMode}:
 *
 * - `openai-completions` — OpenAI `/chat/completions` shape (OpenAI, OpenRouter,
 *   Moonshot, Kimi, xAI, Gemini-via-OpenAI-compat) — `ApiMode 'chat_completions'`.
 * - `openai-responses` — OpenAI Responses API (Codex backend, xAI-responses) —
 *   `ApiMode 'codex_responses'`.
 * - `anthropic-messages` — native Anthropic Messages API (prompt-cache + thinking) —
 *   `ApiMode 'anthropic_messages'`.
 * - `aisdk` — routed through the Vercel AI-SDK provider factory (the data-driven
 *   `apiMode → provider` adapter, T11767) rather than a bespoke CLEO transport.
 *
 * @task T11702
 */
export const PROVIDER_TRANSPORTS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'aisdk',
] as const;

/** TypeScript union derived from {@link PROVIDER_TRANSPORTS}. */
export type ProviderTransport = (typeof PROVIDER_TRANSPORTS)[number];

/**
 * Endpoint for the `openai-completions` transport — the OpenAI
 * `/chat/completions` wire shape (OpenAI, OpenRouter, Moonshot, Kimi, xAI,
 * Gemini-via-compat). `baseUrl` has NO trailing slash.
 *
 * @task T11702
 */
export interface OpenAICompletionsEndpoint {
  /** Discriminant — the OpenAI chat-completions wire protocol. */
  readonly transport: 'openai-completions';
  /** Base URL for the provider's API — no trailing slash. */
  readonly baseUrl: string;
}

/**
 * Endpoint for the `openai-responses` transport — the OpenAI Responses API
 * (Codex backend, xAI-responses). `baseUrl` has NO trailing slash.
 *
 * @task T11702
 */
export interface OpenAIResponsesEndpoint {
  /** Discriminant — the OpenAI Responses wire protocol. */
  readonly transport: 'openai-responses';
  /** Base URL for the Responses endpoint — no trailing slash. */
  readonly baseUrl: string;
}

/**
 * Endpoint for the `anthropic-messages` transport — the native Anthropic
 * Messages API (full prompt-cache + extended thinking). `baseUrl` has NO
 * trailing slash.
 *
 * @task T11702
 */
export interface AnthropicMessagesEndpoint {
  /** Discriminant — the native Anthropic Messages wire protocol. */
  readonly transport: 'anthropic-messages';
  /** Base URL for the Anthropic API — no trailing slash. */
  readonly baseUrl: string;
}

/**
 * Endpoint for the `aisdk` transport — the provider is reached through the
 * Vercel AI-SDK provider factory (the data-driven adapter table, T11767) keyed
 * by `aiSdkProvider`, rather than a bespoke CLEO transport.
 *
 * @task T11702
 */
export interface AiSdkEndpoint {
  /** Discriminant — routed through the AI-SDK provider factory. */
  readonly transport: 'aisdk';
  /** Base URL passed to the AI-SDK provider factory — no trailing slash. */
  readonly baseUrl: string;
  /**
   * The AI-SDK provider-factory key (e.g. `openai-compatible` | `google` |
   * `bedrock`) the adapter table maps to a `create*` factory. NEVER an inline
   * client construction — the factory call is the LLM chokepoint (T11783).
   */
  readonly aiSdkProvider: string;
}

/**
 * A provider's wire endpoint — a discriminated union keyed on the `transport`
 * literal (AC5). Exactly one variant per {@link ProviderTransport}; each carries
 * its own typed fields, with no `any`/`unknown` shortcut.
 *
 * @task T11702
 */
export type ProviderEndpoint =
  | OpenAICompletionsEndpoint
  | OpenAIResponsesEndpoint
  | AnthropicMessagesEndpoint
  | AiSdkEndpoint;

/**
 * Known request-quirk kinds — the DECLARATIVE record of WHICH provider-specific
 * request adjustment a provider needs, WITHOUT embedding the closure.
 *
 * The live closures stay on {@link ProviderProfile} (`buildExtraBody` /
 * `buildApiKwargsExtras` / `prepareMessages`); a `ProviderDef` row records only
 * the quirk's stable kind so the table/seed stays serializable. The runtime maps
 * a {@link RequestQuirk} `kind` back to its hook implementation.
 *
 * - `grok-conv-id` — inject the process-scoped `x-grok-conv-id` header (xAI).
 * - `gemini-thinking-config` — inject `thinking_config` in `extra_body` (Gemini).
 * - `kimi-reasoning-effort` — top-level `reasoning_effort` kwarg (Kimi Code).
 * - `moonshot-schema-sanitize` — shallow tool-schema sanitization (Moonshot).
 * - `openrouter-pareto` — inject the Pareto price-router plugin (OpenRouter).
 *
 * @task T11702
 */
export const REQUEST_QUIRK_KINDS = [
  'grok-conv-id',
  'gemini-thinking-config',
  'kimi-reasoning-effort',
  'moonshot-schema-sanitize',
  'openrouter-pareto',
] as const;

/** TypeScript union derived from {@link REQUEST_QUIRK_KINDS}. */
export type RequestQuirkKind = (typeof REQUEST_QUIRK_KINDS)[number];

/**
 * A single declarative request-quirk descriptor (AC4 — the "request-quirk hook
 * signature"). Records the quirk's stable {@link RequestQuirkKind} so a
 * `ProviderDef` row stays serializable; the runtime resolves the `kind` to its
 * hook implementation on {@link ProviderProfile}. The signature the hook MUST
 * satisfy is `(model: string) => Record<string, unknown>` (the declarative shape
 * of `buildExtraBody` / `buildApiKwargsExtras`), captured here only as the
 * documented contract — never as an embedded closure.
 *
 * @task T11702
 */
export interface RequestQuirk {
  /** The stable quirk kind this provider needs. */
  readonly kind: RequestQuirkKind;
}

/**
 * OAuth flow placeholder embedded on a {@link ProviderDef} (AC4).
 *
 * For M3 this is the existing {@link ProviderOAuthConfig} shape (PKCE / device-code
 * endpoints + client id), aliased so the M4 vault work (T10409) can widen it without
 * a contract rename. A `ProviderDef` carries `oauth` only when the provider supports
 * an OAuth login flow (anthropic, openai, kimi-code); it is omitted otherwise.
 *
 * @task T11702
 */
export type OAuthFlowDef = ProviderOAuthConfig;

/**
 * Declarative description of one LLM provider — the serializable DATA SSoT.
 *
 * The contract persisted as a `providers` table row (T11703) and read by the alias
 * resolver (T11704). Derived from the runtime {@link ProviderProfile} set: identity
 * + aliases + auth + endpoint + catalog key + headers + optional OAuth + the
 * declarative request quirks. Carries NO closures — only serializable DATA.
 *
 * @task T11702
 */
export interface ProviderDef {
  /**
   * Canonical provider id (lower-cased). For builtins this is a
   * {@link BuiltinProviderId}; plugin providers may use any non-empty string.
   */
  readonly id: ProviderId;

  /** Human-readable display name shown in pickers and diagnostic output. */
  readonly displayName: string;

  /**
   * Alternate names that resolve to this provider (case-insensitive). The SINGLE
   * source the alias resolver (T11704) reads — `codex`/`chatgpt` → `openai`,
   * `claude` → `anthropic`, `google` → `gemini`, … An alias colliding with another
   * provider's primary `id` is a resolution error (T11704 AC2).
   */
  readonly aliases: ReadonlyArray<string>;

  /**
   * Authentication mechanisms this provider supports (`api_key` | `oauth` |
   * `aws_sdk`). The {@link StoredAuthTypeWire} wire enum.
   */
  readonly authMethods: ReadonlyArray<StoredAuthTypeWire>;

  /**
   * The provider's wire endpoint — a discriminated union keyed on `transport`
   * (AC5). A provider that speaks multiple protocols (e.g. xAI completions +
   * responses) carries the multiple variants in {@link altEndpoints}.
   */
  readonly endpoint: ProviderEndpoint;

  /**
   * Additional wire endpoints this provider also speaks, beyond the primary
   * {@link endpoint}. Collapses the prior per-ApiMode profile duplication into ONE
   * row (T11703 AC4 — xAI's completions + responses become one `ProviderDef`).
   * Empty/omitted for single-protocol providers.
   */
  readonly altEndpoints?: ReadonlyArray<ProviderEndpoint>;

  /**
   * The models.dev catalog provider key joining this provider to the
   * `models_catalog` table (T11733). Usually equals {@link id}; carried distinctly
   * because a provider id and its catalog key can differ (e.g. `kimi-code` →
   * `moonshot`).
   */
  readonly modelsDevId: string;

  /**
   * HTTP headers sent with every request to this provider, merged into the
   * client's `defaultHeaders` (e.g. `{ 'anthropic-version': '2023-06-01' }`).
   * Omitted when the provider needs no pinned headers.
   */
  readonly defaultHeaders?: Readonly<Record<string, string>>;

  /**
   * Environment variable names that may supply this provider's API key (e.g.
   * `['ANTHROPIC_API_KEY']`). Resolver chains may check these before the vault.
   * Omitted when the provider has no env-var credential path.
   */
  readonly envVars?: ReadonlyArray<string>;

  /**
   * OAuth flow placeholder (AC4) — present only when the provider supports an
   * OAuth login flow (anthropic, openai, kimi-code). See {@link OAuthFlowDef}.
   */
  readonly oauth?: OAuthFlowDef;

  /**
   * Declarative request quirks this provider needs (AC4) — the stable
   * {@link RequestQuirk} descriptors WITHOUT the closures (those stay on
   * {@link ProviderProfile}). Empty/omitted when the provider needs no quirk.
   */
  readonly requestQuirks?: ReadonlyArray<RequestQuirk>;
}
