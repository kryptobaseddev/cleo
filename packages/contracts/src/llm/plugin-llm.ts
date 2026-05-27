/**
 * Plugin LLM access types for the CLEO trust-gating layer.
 *
 * Defines the context, completion signature, and error types that the plugin
 * LLM facade exposes to plugin consumers. Phase 5 (T9313) adds full
 * sandboxing: permissions descriptor, filesystem ACL, and per-plugin
 * in-memory token-bucket rate limiting.
 *
 * @module llm/plugin-llm
 * @task T9305
 * @task T9313
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see ADR-072 §6 plugin facade
 */

import type { SendOptions } from './interfaces.js';
import type { NormalizedResponse, TransportMessage } from './normalized-response.js';

// ---------------------------------------------------------------------------
// Plugin context
// ---------------------------------------------------------------------------

/**
 * Context describing a plugin's identity and LLM access constraints.
 *
 * `allowedModels` and `allowedProviders` are additive allow-lists. When both
 * are supplied the request must satisfy BOTH. When a list is omitted (or
 * empty) that axis is unconstrained.
 */
export interface PluginLlmContext {
  /** Unique plugin identifier registered in the plugin manifest. */
  readonly pluginId: string;
  /**
   * Optional list of model identifiers the plugin is permitted to call.
   *
   * Values are matched against the `model` field on the resolved role config.
   * When omitted or empty any model is allowed.
   */
  readonly allowedModels?: readonly string[];
  /**
   * Optional list of provider identifiers the plugin is permitted to use.
   *
   * Values are matched against the `ModelTransport` union members
   * (e.g. `'anthropic'`, `'openai'`). When omitted or empty any provider is
   * allowed.
   */
  readonly allowedProviders?: readonly string[];
}

// ---------------------------------------------------------------------------
// Completion signature
// ---------------------------------------------------------------------------

/**
 * Single-turn plugin LLM completion function.
 *
 * Implementations MUST:
 * - Validate `ctx.allowedModels` / `ctx.allowedProviders` before dispatching.
 * - Redact credential patterns from errors before re-throwing.
 * - NOT append messages to the underlying session history.
 *
 * @param ctx - Plugin identity and access constraints.
 * @param messages - Conversation messages in provider-neutral form.
 * @param opts - Optional per-call send options forwarded to the executor.
 * @returns A promise resolving to a {@link NormalizedResponse}.
 */
export type PluginLlmComplete = (
  ctx: PluginLlmContext,
  messages: TransportMessage[],
  opts?: SendOptions,
) => Promise<NormalizedResponse>;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when a plugin requests a model or provider not in its allow-list.
 *
 * Consumers can `instanceof PluginModelGateError` to distinguish trust-gating
 * failures from general executor errors.
 */
export class PluginModelGateError extends Error {
  /** Plugin that triggered the gate. */
  readonly pluginId: string;
  /** The model or provider identifier that was denied. */
  readonly denied: string;
  /** Which axis triggered the gate: model or provider. */
  readonly axis: 'model' | 'provider';

  /**
   * @param pluginId - Plugin whose request was denied.
   * @param denied - The specific value that was not in the allow-list.
   * @param axis - Whether the denial was on the `model` or `provider` axis.
   */
  constructor(pluginId: string, denied: string, axis: 'model' | 'provider') {
    super(
      `Plugin "${pluginId}" is not permitted to use ${axis} "${denied}". ` +
        `Check the plugin manifest's allowed${axis === 'model' ? 'Models' : 'Providers'} list.`,
    );
    this.name = 'PluginModelGateError';
    this.pluginId = pluginId;
    this.denied = denied;
    this.axis = axis;
  }
}

/**
 * Wraps an underlying executor error after credential patterns have been
 * redacted from its message and stack.
 *
 * The original cause is preserved in `Error.cause` for internal logging but
 * the message and stack exposed to the plugin are sanitised.
 */
export class PluginLlmError extends Error {
  /** Plugin on whose behalf the call was made. */
  readonly pluginId: string;

  /**
   * @param pluginId - Plugin on whose behalf the failing call was made.
   * @param redactedMessage - Credential-scrubbed error message.
   * @param cause - Original unscrubbed error (for internal diagnostics).
   */
  constructor(pluginId: string, redactedMessage: string, cause: unknown) {
    super(redactedMessage, { cause });
    this.name = 'PluginLlmError';
    this.pluginId = pluginId;
  }
}

/**
 * Thrown when a plugin call is denied by the permissions descriptor.
 *
 * Covers violations of `maxTokens`, `maxCostUsd`, `allowedRoles`, and other
 * call-site constraints declared in {@link PluginPermissionDescriptor}.
 *
 * Error code: `E_PLUGIN_DENIED`
 */
export class PluginDeniedError extends Error {
  /** Plugin whose request was denied. */
  readonly pluginId: string;
  /** Human-readable reason for the denial. */
  readonly reason: string;
  /** Machine-readable error code. */
  readonly code = 'E_PLUGIN_DENIED' as const;

  /**
   * @param pluginId - Plugin whose request was denied.
   * @param reason - Reason the request was denied.
   */
  constructor(pluginId: string, reason: string) {
    super(`Plugin "${pluginId}" was denied: ${reason}`);
    this.name = 'PluginDeniedError';
    this.pluginId = pluginId;
    this.reason = reason;
  }
}

/**
 * Thrown when a plugin has exhausted its in-memory token-bucket rate limit.
 *
 * The `retryAfterMs` field indicates how many milliseconds until the bucket
 * refills enough for one token. Callers should surface this as a
 * `Retry-After` header or equivalent.
 *
 * Error code: `E_PLUGIN_RATE_LIMITED`
 */
export class PluginRateLimitedError extends Error {
  /** Plugin that triggered the rate limit. */
  readonly pluginId: string;
  /** Milliseconds until the bucket refills enough for one token. */
  readonly retryAfterMs: number;
  /** Machine-readable error code. */
  readonly code = 'E_PLUGIN_RATE_LIMITED' as const;

  /**
   * @param pluginId - Plugin that was rate-limited.
   * @param retryAfterMs - Milliseconds until capacity is available.
   */
  constructor(pluginId: string, retryAfterMs: number) {
    super(`Plugin "${pluginId}" is rate-limited. Retry after ${retryAfterMs}ms.`);
    this.name = 'PluginRateLimitedError';
    this.pluginId = pluginId;
    this.retryAfterMs = retryAfterMs;
  }
}
