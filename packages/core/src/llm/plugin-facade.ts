/**
 * Plugin LLM facade — trust-gating and credential redaction.
 *
 * Exposes {@link pluginLlmComplete} as the single entry point for plugins
 * that need LLM access. Before dispatching, the facade:
 *   1. Resolves the plugin manifest to obtain its access constraints.
 *   2. Validates the resolved role config against `allowedModels` /
 *      `allowedProviders` allow-lists and throws {@link PluginModelGateError}
 *      on denial.
 *   3. Delegates to `getLlmExecutor('plugin').auxiliary(...)`.
 *   4. On error: redacts credential patterns from message + stack before
 *      re-throwing as {@link PluginLlmError}.
 *
 * Full sandboxing (filesystem/network isolation) is deferred to Phase 5
 * (T9313). This module covers trust-gating + redaction only.
 *
 * @module llm/plugin-facade
 * @task T9305
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see ADR-072 §6 plugin facade
 */

import { PluginLlmError, PluginModelGateError } from '@cleocode/contracts';
import type { SendOptions } from '@cleocode/contracts/llm/interfaces.js';
import type {
  NormalizedResponse,
  TransportMessage,
} from '@cleocode/contracts/llm/normalized-response.js';
import { getLlmExecutor } from './executor-factory.js';

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
}

/**
 * In-process plugin manifest registry.
 *
 * This is a stub implementation for Phase 4. Phase 5 will replace this with
 * a persistent plugin registry that loads manifests from the plugin store.
 *
 * Callers can pre-populate via {@link registerPluginManifest} for testing or
 * early integration. Unknown plugins default to unconstrained access with a
 * console warning.
 */
const _pluginRegistry = new Map<string, PluginManifestEntry>();

/**
 * Register a plugin manifest entry in the in-process registry.
 *
 * Overwrites any existing entry for the same `pluginId`. Useful for tests
 * and for early integration before the persistent registry ships.
 *
 * @param entry - The plugin manifest entry to register.
 */
export function registerPluginManifest(entry: PluginManifestEntry): void {
  _pluginRegistry.set(entry.pluginId, entry);
}

/**
 * Clear all plugin manifest entries from the in-process registry.
 *
 * Useful in test teardown to reset inter-test state.
 */
export function clearPluginRegistry(): void {
  _pluginRegistry.clear();
}

// ---------------------------------------------------------------------------
// Credential redaction
// ---------------------------------------------------------------------------

/** Regex patterns that match common credential tokens in error strings. */
const REDACTION_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/g,
  /xoxb-[A-Za-z0-9_-]+/g,
];

const REDACTION_REPLACEMENT = '[REDACTED]';

/**
 * Scrub known credential patterns from a string.
 *
 * Applied to both `err.message` and `err.stack` before the sanitised error is
 * surfaced to plugin callers.
 *
 * @param value - String to scrub (may be undefined).
 * @returns Scrubbed string, or the original value if undefined.
 */
function redactCredentials(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let result = value;
  for (const pattern of REDACTION_PATTERNS) {
    result = result.replace(pattern, REDACTION_REPLACEMENT);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Gate validation
// ---------------------------------------------------------------------------

/**
 * Resolve the plugin manifest for a given plugin ID.
 *
 * Falls back to an unconstrained stub when the plugin is not yet registered
 * (Phase 5 will replace this with a hard failure once the registry is stable).
 */
function _resolveManifest(pluginId: string): PluginManifestEntry {
  const entry = _pluginRegistry.get(pluginId);
  if (entry !== undefined) return entry;
  // Stub: unknown plugins are unconstrained. Phase 5 will harden this.
  return { pluginId, allowedModels: [], allowedProviders: [] };
}

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
// Public facade
// ---------------------------------------------------------------------------

/**
 * Execute a single-turn LLM completion on behalf of a plugin.
 *
 * This is the sole sanctioned LLM entry point for plugin code. It:
 *   1. Resolves the plugin manifest from the in-process registry.
 *   2. Validates `opts.model` / `opts.providerFlags.provider` against the
 *      manifest allow-lists when supplied. Throws {@link PluginModelGateError}
 *      on denial.
 *   3. Forwards to `getLlmExecutor('plugin').auxiliary(messages, opts)`.
 *   4. Catches all errors, redacts credential patterns from `message` and
 *      `stack`, then re-throws as {@link PluginLlmError}.
 *
 * @param pluginId - Unique identifier of the calling plugin.
 * @param messages - Conversation messages in provider-neutral form.
 * @param opts - Optional per-call send options forwarded to the executor.
 * @returns A promise resolving to a {@link NormalizedResponse}.
 * @throws {@link PluginModelGateError} when the requested model/provider is
 *   not in the plugin's allow-list.
 * @throws {@link PluginLlmError} for all other executor failures (credentials
 *   are redacted from the error message before re-throwing).
 */
export async function pluginLlmComplete(
  pluginId: string,
  messages: TransportMessage[],
  opts?: SendOptions & {
    /** Model override — validated against the plugin's allowedModels list. */
    readonly model?: string;
    /** Provider override — validated against the plugin's allowedProviders list. */
    readonly provider?: string;
  },
): Promise<NormalizedResponse> {
  const manifest = _resolveManifest(pluginId);

  // Gate: model — check requested model against manifest allow-list.
  if (opts?.model !== undefined) {
    _assertModelAllowed(pluginId, manifest, opts.model);
  }

  // Gate: provider — check requested provider against manifest allow-list.
  if (opts?.provider !== undefined) {
    _assertProviderAllowed(pluginId, manifest, opts.provider);
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
    // Re-throw PluginModelGateError without wrapping (gate failures, not executor failures).
    if (err instanceof PluginModelGateError) throw err;
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
      // Overwrite the stack on the wrapper with a redacted copy.
      wrapped.stack = redactCredentials(err.stack);
    }
    return wrapped;
  }
  return new PluginLlmError(pluginId, String(err), err);
}
