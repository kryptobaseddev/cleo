/**
 * Plugin LLM facade — trust-gating, credential redaction, and full sandboxing.
 *
 * Exposes {@link pluginLlmComplete} as the single entry point for plugins
 * that need LLM access. Before dispatching, the facade:
 *   1. Resolves the plugin manifest to obtain its access constraints.
 *   2. Validates the resolved role config against `allowedModels` /
 *      `allowedProviders` allow-lists and throws {@link PluginModelGateError}
 *      on denial.
 *   3. Validates the request against the plugin's {@link PluginPermissionDescriptor}
 *      (max tokens, allowed roles). Throws {@link PluginDeniedError} on violation.
 *   4. Checks the in-memory token-bucket rate limiter. Throws
 *      {@link PluginRateLimitedError} with `retryAfterMs` when exhausted.
 *   5. Delegates to `getLlmExecutor('plugin').auxiliary(...)`.
 *   6. On error: redacts credential patterns from message + stack before
 *      re-throwing as {@link PluginLlmError}.
 *
 * Filesystem ACL is enforced via {@link validateFsAccess} — call this before
 * executing any file_read / file_write tool requested by a plugin. Returns
 * `true` when the path is within the plugin's declared glob patterns.
 *
 * @module llm/plugin-facade
 * @task T9305
 * @task T9313
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see ADR-072 §6 plugin facade
 */

import { matchesGlob } from 'node:path';
import {
  PluginDeniedError,
  PluginLlmError,
  PluginModelGateError,
  PluginRateLimitedError,
} from '@cleocode/contracts';
import type { SendOptions } from '@cleocode/contracts/llm/interfaces.js';
import type {
  NormalizedResponse,
  TransportMessage,
} from '@cleocode/contracts/llm/normalized-response.js';
import { redact } from '@cleocode/utils';
import { getLlmExecutor } from './executor-factory.js';

// ---------------------------------------------------------------------------
// Permission descriptor types (Phase 5)
// ---------------------------------------------------------------------------

/**
 * Filesystem access control list for a plugin.
 *
 * Default deny — the plugin MUST explicitly declare scope via `read` / `write`
 * glob patterns. Patterns are matched against the path using Node's built-in
 * `path.matchesGlob` (`**` crosses directory boundaries).
 *
 * @example
 * ```ts
 * { read: ['/tmp/plugin-scratch/**'], write: ['/tmp/plugin-scratch/**'] }
 * ```
 */
export interface PluginFsAcl {
  /** Glob patterns the plugin is allowed to read from. */
  readonly read: readonly string[];
  /** Glob patterns the plugin is allowed to write to. */
  readonly write: readonly string[];
}

/**
 * Per-plugin rate-limit configuration for the in-memory token-bucket.
 *
 * The bucket holds up to `burst` tokens. `tokensPerSecond` tokens are added
 * each second (fractionally). Each LLM call costs one token. When the bucket
 * is empty the call is rejected with {@link PluginRateLimitedError}.
 */
export interface PluginRateLimitConfig {
  /**
   * Sustained token refill rate (tokens per second).
   * Must be positive. Example: `2` allows 2 calls/s sustained.
   */
  readonly tokensPerSecond: number;
  /**
   * Maximum burst capacity (tokens).
   * Must be ≥ 1. The bucket starts full at this value.
   */
  readonly burst: number;
}

/**
 * Permission descriptor for a plugin manifest entry (Phase 5).
 *
 * All fields are optional — omitted fields are unconstrained (except
 * `fsAccess` which defaults to full deny when omitted).
 */
export interface PluginPermissionDescriptor {
  /**
   * Maximum number of output tokens allowed per call.
   * Rejected with {@link PluginDeniedError} when `opts.maxTokens` exceeds this.
   */
  readonly maxTokens?: number;
  /**
   * Allow-list of CLEO role names the plugin may invoke under.
   * Empty or omitted = unconstrained.
   */
  readonly allowedRoles?: readonly string[];
  /**
   * Filesystem access control list.
   * Defaults to fully-denied when omitted (`{ read: [], write: [] }`).
   */
  readonly fsAccess?: PluginFsAcl;
  /** In-memory token-bucket rate-limit configuration. */
  readonly rateLimit?: PluginRateLimitConfig;
}

// ---------------------------------------------------------------------------
// Plugin manifest stub registry
// ---------------------------------------------------------------------------

/**
 * Minimal plugin manifest entry used by the facade for access-control checks.
 *
 * The full manifest schema lives in the plugin registry (future work). This
 * shape is intentionally minimal — only the fields the facade reads.
 */
export interface PluginManifestEntry {
  /** Unique plugin identifier. */
  readonly pluginId: string;
  /** Allow-list of model identifiers this plugin may call. Empty = unconstrained. */
  readonly allowedModels: readonly string[];
  /** Allow-list of provider identifiers this plugin may use. Empty = unconstrained. */
  readonly allowedProviders: readonly string[];
  /** Phase 5 permission descriptor (optional). */
  readonly permissions?: PluginPermissionDescriptor;
}

/**
 * In-process plugin manifest registry.
 *
 * This is a stub implementation for Phase 4/5. A persistent plugin registry
 * will replace this in a future phase.
 *
 * Callers can pre-populate via {@link registerPluginManifest} for testing or
 * early integration. Unknown plugins default to unconstrained access.
 */
const _pluginRegistry = new Map<string, PluginManifestEntry>();

/**
 * Register a plugin manifest entry in the in-process registry.
 *
 * Overwrites any existing entry for the same `pluginId` and resets that
 * plugin's rate-limit bucket (config may have changed).
 *
 * @param entry - The plugin manifest entry to register.
 */
export function registerPluginManifest(entry: PluginManifestEntry): void {
  _pluginRegistry.set(entry.pluginId, entry);
  _rateBuckets.delete(entry.pluginId);
}

/**
 * Clear all plugin manifest entries from the in-process registry.
 *
 * Also resets all rate-limit buckets. Useful in test teardown to reset
 * inter-test state.
 */
export function clearPluginRegistry(): void {
  _pluginRegistry.clear();
  _rateBuckets.clear();
}

// ---------------------------------------------------------------------------
// Credential redaction
// ---------------------------------------------------------------------------

/**
 * Scrub known credential patterns from a string before the sanitised error is
 * surfaced to plugin callers.
 *
 * Applied to both `err.message` and `err.stack`. As of E5 (T11414) the
 * credential-pattern set lives once in the pure `@cleocode/utils` leaf; this is
 * a domain-named alias over {@link redact} for readability at the call site.
 * The shared superset additionally covers OpenAI/JWT/env/path/hex/JSON secret
 * forms beyond this path's original four patterns — strictly more scrubbing,
 * never less.
 *
 * @param value - String to scrub (may be undefined).
 * @returns Scrubbed string, or `undefined` when the input was `undefined`.
 */
function redactCredentials(value: string | undefined): string | undefined {
  return redact(value);
}

// ---------------------------------------------------------------------------
// Manifest resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the plugin manifest for a given plugin ID.
 *
 * Falls back to an unconstrained stub when the plugin is not yet registered.
 * A future phase will harden this to a hard failure.
 */
function _resolveManifest(pluginId: string): PluginManifestEntry {
  const entry = _pluginRegistry.get(pluginId);
  if (entry !== undefined) return entry;
  return { pluginId, allowedModels: [], allowedProviders: [] };
}

// ---------------------------------------------------------------------------
// Gate 1 & 2: model / provider allow-list validation
// ---------------------------------------------------------------------------

/**
 * Validate that a model identifier is permitted per the manifest allow-list.
 *
 * @throws {@link PluginModelGateError} when the model is not in the allow-list.
 */
function _assertModelAllowed(pluginId: string, manifest: PluginManifestEntry, model: string): void {
  if (manifest.allowedModels.length > 0 && !manifest.allowedModels.includes(model)) {
    throw new PluginModelGateError(pluginId, model, 'model');
  }
}

/**
 * Validate that a provider identifier is permitted per the manifest allow-list.
 *
 * @throws {@link PluginModelGateError} when the provider is not in the allow-list.
 */
function _assertProviderAllowed(
  pluginId: string,
  manifest: PluginManifestEntry,
  provider: string,
): void {
  if (manifest.allowedProviders.length > 0 && !manifest.allowedProviders.includes(provider)) {
    throw new PluginModelGateError(pluginId, provider, 'provider');
  }
}

// ---------------------------------------------------------------------------
// Gate 3: permission descriptor validation (Phase 5)
// ---------------------------------------------------------------------------

/**
 * Validate the call-site request against the plugin's permission descriptor.
 *
 * Checks `maxTokens` cap and `allowedRoles` allow-list. Returns normally when
 * all constraints are satisfied.
 *
 * @param pluginId - Plugin identifier for error messages.
 * @param perms - Permission descriptor from the manifest (may be undefined).
 * @param opts - Call-site options to validate against the descriptor.
 * @throws {@link PluginDeniedError} when any constraint is violated.
 */
function _assertPermissionsAllowed(
  pluginId: string,
  perms: PluginPermissionDescriptor | undefined,
  opts: { maxTokens?: number; role?: string },
): void {
  if (perms === undefined) return;

  if (
    perms.maxTokens !== undefined &&
    opts.maxTokens !== undefined &&
    opts.maxTokens > perms.maxTokens
  ) {
    throw new PluginDeniedError(
      pluginId,
      `requested maxTokens (${opts.maxTokens}) exceeds permitted cap (${perms.maxTokens})`,
    );
  }

  if (
    perms.allowedRoles !== undefined &&
    perms.allowedRoles.length > 0 &&
    opts.role !== undefined &&
    !perms.allowedRoles.includes(opts.role)
  ) {
    throw new PluginDeniedError(
      pluginId,
      `role "${opts.role}" is not in the plugin's allowedRoles list`,
    );
  }
}

// ---------------------------------------------------------------------------
// Filesystem ACL (Phase 5)
// ---------------------------------------------------------------------------

/**
 * Validate whether a plugin may access a filesystem path for the given operation.
 *
 * Default deny — the plugin must explicitly declare the path via glob patterns
 * in its `permissions.fsAccess` descriptor. An empty glob list means no access
 * on that axis.
 *
 * Patterns are matched using Node's built-in `path.matchesGlob` (Node ≥ 22).
 *
 * @param pluginId - Plugin requesting filesystem access.
 * @param path - Filesystem path being accessed.
 * @param operation - `'read'` or `'write'`.
 * @returns `true` when the path matches at least one declared pattern; `false` otherwise.
 *
 * @example
 * ```ts
 * // Returns true when '/tmp/scratch/out.txt' matches '/tmp/scratch/**'
 * validateFsAccess('my-plugin', '/tmp/scratch/out.txt', 'write');
 * ```
 */
export function validateFsAccess(
  pluginId: string,
  path: string,
  operation: 'read' | 'write',
): boolean {
  const manifest = _resolveManifest(pluginId);
  const acl = manifest.permissions?.fsAccess;

  if (acl === undefined) return false;

  const patterns = operation === 'read' ? acl.read : acl.write;
  if (patterns.length === 0) return false;

  return patterns.some((pattern) => matchesGlob(path, pattern));
}

// ---------------------------------------------------------------------------
// Gate 4: in-memory token-bucket rate limiter (Phase 5)
// ---------------------------------------------------------------------------

/** Internal state for one plugin's token bucket. */
interface TokenBucket {
  /** Current available tokens (fractional). */
  tokens: number;
  /** Epoch milliseconds of the last refill calculation. */
  lastRefillMs: number;
  /** Rate-limit config snapshot at registration time. */
  config: PluginRateLimitConfig;
}

/** In-process token bucket registry, keyed by plugin ID. */
const _rateBuckets = new Map<string, TokenBucket>();

/**
 * Resolve (or lazily create) the token bucket for a plugin.
 */
function _getBucket(pluginId: string, config: PluginRateLimitConfig): TokenBucket {
  const existing = _rateBuckets.get(pluginId);
  if (existing !== undefined) return existing;

  const bucket: TokenBucket = {
    tokens: config.burst,
    lastRefillMs: Date.now(),
    config,
  };
  _rateBuckets.set(pluginId, bucket);
  return bucket;
}

/**
 * Attempt to consume one token from a plugin's bucket.
 *
 * Refills fractional tokens based on elapsed wall-clock time, then deducts
 * one token. Throws {@link PluginRateLimitedError} when the bucket is empty.
 *
 * @param pluginId - Plugin requesting a token.
 * @param config - Rate-limit config from the manifest.
 * @throws {@link PluginRateLimitedError} with `retryAfterMs` when exhausted.
 */
function _consumeToken(pluginId: string, config: PluginRateLimitConfig): void {
  const bucket = _getBucket(pluginId, config);
  const nowMs = Date.now();
  const elapsedSeconds = (nowMs - bucket.lastRefillMs) / 1000;

  bucket.tokens = Math.min(
    bucket.config.burst,
    bucket.tokens + elapsedSeconds * bucket.config.tokensPerSecond,
  );
  bucket.lastRefillMs = nowMs;

  if (bucket.tokens < 1) {
    const deficit = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / bucket.config.tokensPerSecond) * 1000);
    throw new PluginRateLimitedError(pluginId, retryAfterMs);
  }

  bucket.tokens -= 1;
}

// ---------------------------------------------------------------------------
// Public facade
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// File-tool names that require ACL enforcement (T9313)
// ---------------------------------------------------------------------------

/** Tool names treated as file-read operations for ACL enforcement. */
const FILE_READ_TOOLS = new Set(['file_read', 'read_file', 'fs_read']);

/** Tool names treated as file-write operations for ACL enforcement. */
const FILE_WRITE_TOOLS = new Set(['file_write', 'write_file', 'fs_write', 'file_append']);

// ---------------------------------------------------------------------------
// Gate 5: filesystem ACL call-site enforcement (T9313)
// ---------------------------------------------------------------------------

/**
 * Auto-enforce filesystem ACL for a tool invocation.
 *
 * Called automatically by {@link pluginLlmComplete} when `opts.toolCall` is
 * supplied and the tool name is a recognized file-access tool. Returns normally
 * when the path is permitted; throws {@link PluginDeniedError} on denial.
 *
 * @param pluginId - Plugin requesting filesystem access.
 * @param toolName - Tool being invoked (e.g. `'file_read'`, `'file_write'`).
 * @param path - Filesystem path being accessed.
 * @throws {@link PluginDeniedError} when the path is denied by the plugin's ACL.
 */
function _assertFsAccess(pluginId: string, toolName: string, path: string): void {
  let operation: 'read' | 'write' | null = null;
  if (FILE_READ_TOOLS.has(toolName)) {
    operation = 'read';
  } else if (FILE_WRITE_TOOLS.has(toolName)) {
    operation = 'write';
  }

  if (operation === null) return; // Not a file tool — no ACL check needed.

  if (!validateFsAccess(pluginId, path, operation)) {
    throw new PluginDeniedError(
      pluginId,
      `file ${operation} denied for path "${path}" — not in plugin's fsAccess.${operation} allow-list`,
    );
  }
}

/**
 * Execute a single-turn LLM completion on behalf of a plugin.
 *
 * This is the sole sanctioned LLM entry point for plugin code. It enforces
 * five gates in order before dispatching:
 *   1. Model allow-list — {@link PluginModelGateError} on violation.
 *   2. Provider allow-list — {@link PluginModelGateError} on violation.
 *   3. Permission descriptor (maxTokens, allowedRoles) — {@link PluginDeniedError}.
 *   4. Token-bucket rate limit — {@link PluginRateLimitedError} with `retryAfterMs`.
 *   5. Filesystem ACL enforcement — when `opts.toolCall` is a file tool, auto-validates
 *      the path against the plugin's `permissions.fsAccess` allow-list
 *      ({@link PluginDeniedError} on denial). Pass `toolCall` whenever you are
 *      about to dispatch a `file_read` / `file_write` tool on behalf of the plugin.
 *
 * All executor errors are caught and re-thrown as {@link PluginLlmError} with
 * credentials redacted from the message and stack.
 *
 * @param pluginId - Unique identifier of the calling plugin.
 * @param messages - Conversation messages in provider-neutral form.
 * @param opts - Optional per-call send options forwarded to the executor.
 * @returns A promise resolving to a {@link NormalizedResponse}.
 * @throws {@link PluginModelGateError} when the requested model/provider is
 *   not in the plugin's allow-list.
 * @throws {@link PluginDeniedError} when the request violates the plugin's
 *   permission descriptor (`maxTokens` cap, `allowedRoles`, or filesystem ACL).
 * @throws {@link PluginRateLimitedError} when the plugin's token bucket is
 *   exhausted. Check `err.retryAfterMs` for the backoff duration.
 * @throws {@link PluginLlmError} for all other executor failures (credentials
 *   are redacted from the error message before re-throwing).
 *
 * @example
 * ```ts
 * // Enforce fs-ACL when a plugin requests a file_read tool:
 * await pluginLlmComplete('my-plugin', messages, {
 *   toolCall: { name: 'file_read', path: '/tmp/scratch/data.json' },
 * });
 * ```
 */
export async function pluginLlmComplete(
  pluginId: string,
  messages: TransportMessage[],
  opts?: SendOptions & {
    /** Model override — validated against the plugin's allowedModels list. */
    readonly model?: string;
    /** Provider override — validated against the plugin's allowedProviders list. */
    readonly provider?: string;
    /** Max output tokens — validated against the plugin's permissions.maxTokens cap. */
    readonly maxTokens?: number;
    /** Role name — validated against the plugin's permissions.allowedRoles list. */
    readonly role?: string;
    /**
     * Filesystem tool invocation to validate before dispatch (Gate 5, T9313).
     *
     * When supplied and the tool name is a recognised file-access tool
     * (`file_read`, `file_write`, etc.), the path is automatically validated
     * against the plugin's `permissions.fsAccess` allow-list.
     * Throws {@link PluginDeniedError} when denied.
     */
    readonly toolCall?: { readonly name: string; readonly path: string };
  },
): Promise<NormalizedResponse> {
  const manifest = _resolveManifest(pluginId);

  // Gate 1: model allow-list.
  if (opts?.model !== undefined) {
    _assertModelAllowed(pluginId, manifest, opts.model);
  }

  // Gate 2: provider allow-list.
  if (opts?.provider !== undefined) {
    _assertProviderAllowed(pluginId, manifest, opts.provider);
  }

  // Gate 3: permission descriptor (maxTokens, allowedRoles).
  _assertPermissionsAllowed(pluginId, manifest.permissions, {
    maxTokens: opts?.maxTokens,
    role: opts?.role,
  });

  // Gate 4: rate limit — consume one token.
  if (manifest.permissions?.rateLimit !== undefined) {
    _consumeToken(pluginId, manifest.permissions.rateLimit);
  }

  // Gate 5: filesystem ACL enforcement (T9313).
  // Auto-validates file-access tools against the plugin's declared glob patterns.
  if (opts?.toolCall !== undefined) {
    _assertFsAccess(pluginId, opts.toolCall.name, opts.toolCall.path);
  }

  // Dispatch via the 'plugin' role executor.
  let executor: Awaited<ReturnType<typeof getLlmExecutor>>;
  try {
    executor = await getLlmExecutor('plugin');
  } catch (err: unknown) {
    throw _wrapError(pluginId, err);
  }

  try {
    return await executor.auxiliary(messages, opts);
  } catch (err: unknown) {
    // Re-throw gate errors without wrapping.
    if (
      err instanceof PluginModelGateError ||
      err instanceof PluginDeniedError ||
      err instanceof PluginRateLimitedError
    ) {
      throw err;
    }
    throw _wrapError(pluginId, err);
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Wrap an unknown error as a {@link PluginLlmError} with credentials scrubbed.
 */
function _wrapError(pluginId: string, err: unknown): PluginLlmError {
  if (err instanceof Error) {
    const redactedMessage = redactCredentials(err.message) ?? err.message;
    const wrapped = new PluginLlmError(pluginId, redactedMessage, err);
    if (err.stack !== undefined) {
      wrapped.stack = redactCredentials(err.stack);
    }
    return wrapped;
  }
  return new PluginLlmError(pluginId, String(err), err);
}
