/**
 * Multi-provider auxiliary fallback chain for CLEO LLM auxiliary calls.
 *
 * When the configured provider's credential pool is exhausted (all credentials
 * on cooldown due to 401/429/connection errors), {@link runAuxiliaryWithFallback}
 * advances to the next provider in the chain and retries. This prevents auxiliary
 * calls (context compression, brain dream cycles, hygiene scans) from failing
 * silently when the primary provider is temporarily unavailable.
 *
 * ## Configuration
 *
 * Set via `cleo config set llm.auxiliaryFallback "anthropic,openrouter,groq"`.
 *
 * The default chain when no config is present: `['anthropic', 'openrouter', 'groq']`.
 *
 * @module llm/auxiliary-fallback
 * @task T9319
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import type { SendOptions } from '@cleocode/contracts/llm/interfaces.js';
import type {
  NormalizedResponse,
  TransportMessage,
} from '@cleocode/contracts/llm/normalized-response.js';
import type { ResolvedCredential } from '@cleocode/contracts/llm/resolved-credential.js';
import { PoolExhaustedError } from './credential-pool.js';
import { classifyError } from './error-classifier.js';
import type { ModelTransport } from './types-config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default auxiliary fallback chain used when `llm.auxiliaryFallback` is not
 * configured. Anthropic first (most capable for auxiliary tasks), then
 * OpenRouter (aggregates many providers), then Groq (fast inference).
 */
export const DEFAULT_AUXILIARY_FALLBACK_CHAIN: readonly AuxiliaryFallbackEntry[] = [
  { provider: 'anthropic' },
  { provider: 'openrouter' },
  { provider: 'groq' },
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single entry in an {@link AuxiliaryFallbackChain}.
 *
 * @task T9319
 */
export interface AuxiliaryFallbackEntry {
  /** Provider transport identifier. */
  readonly provider: ModelTransport;
  /**
   * Optional model override for this provider.
   *
   * When omitted, the session factory resolves the model from config
   * (via role-resolver's implicit-fallback chain).
   */
  readonly model?: string;
}

/**
 * Ordered list of providers to try for auxiliary LLM calls.
 *
 * The chain is tried front-to-back. The first provider whose credential pool
 * yields a successful response wins. The chain short-circuits immediately on
 * success — if provider 1 succeeds, providers 2..N are never contacted.
 *
 * @task T9319
 */
export type AuxiliaryFallbackChain = readonly AuxiliaryFallbackEntry[];

/**
 * Successful result returned by {@link runAuxiliaryWithFallback}.
 *
 * Extends {@link NormalizedResponse} with `meta.fallbackChain` that records
 * which providers were tried (in order) and which one ultimately succeeded.
 *
 * @task T9319
 */
export interface AuxiliaryFallbackResult extends NormalizedResponse {
  /**
   * Fallback metadata populated when at least one provider was attempted.
   *
   * Stored in `providerData['__fallbackMeta']` on the response so the shape
   * is preserved through existing NormalizedResponse consumers. Access via the
   * `.meta` shortcut on this interface.
   */
  readonly meta: AuxiliaryFallbackMeta;
}

/**
 * Fallback path metadata attached to {@link AuxiliaryFallbackResult}.
 *
 * @task T9319
 */
export interface AuxiliaryFallbackMeta {
  /**
   * Ordered list of all providers in the chain that were tried.
   *
   * Includes both failed providers (pool-exhausted) and the final successful
   * provider. The last entry is always the one that produced the response.
   */
  readonly fallbackChain: readonly FallbackChainStep[];
}

/**
 * A single step in the recorded fallback chain.
 *
 * @task T9319
 */
export interface FallbackChainStep {
  /** Provider transport identifier. */
  readonly provider: ModelTransport;
  /** Outcome for this provider attempt. */
  readonly outcome: 'success' | 'pool_exhausted' | 'error';
  /**
   * Human-readable error message when `outcome !== 'success'`.
   *
   * Omitted on success to avoid leaking unnecessary detail.
   */
  readonly errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link runAuxiliaryWithFallback} when every provider in the chain
 * has been tried and all have exhausted their credential pools or returned errors.
 *
 * `steps` records the full fallback path taken so callers can surface a
 * structured diagnostic to the user or log it for analysis.
 *
 * @task T9319
 */
export class AllProvidersExhaustedError extends Error {
  /** Stable LAFS error code. */
  readonly code = 'E_LLM_ALL_PROVIDERS_EXHAUSTED';

  /**
   * @param steps - Ordered record of every provider attempt made, with outcome.
   */
  constructor(public readonly steps: readonly FallbackChainStep[]) {
    const providers = steps.map((s) => s.provider).join(', ');
    super(
      `E_LLM_ALL_PROVIDERS_EXHAUSTED: auxiliary call failed on all providers in chain [${providers}]. ` +
        `Add credentials via 'cleo llm add <provider> <apiKey>' or extend the fallback chain.`,
    );
    this.name = 'AllProvidersExhaustedError';
  }
}

// ---------------------------------------------------------------------------
// Exhaustion detection
// ---------------------------------------------------------------------------

/**
 * Determine whether an error represents pool exhaustion (all credentials for
 * a provider are on cooldown) or a connection-level failure that justifies
 * falling through to the next provider in the chain.
 *
 * Exhaustion conditions:
 * - `PoolExhaustedError` — thrown directly by `CredentialPool.pick()`.
 * - `classifyError().shouldRotateCredential === true` — 401/429 after the pool
 *   has already been fully rotated (ConcreteSession propagates this).
 *
 * Non-exhaustion errors (transient, model-level, etc.) are NOT re-thrown here
 * because auxiliary calls are best-effort: a timeout or 500 from provider 1
 * should still fall through to provider 2 so the call has a chance to succeed.
 *
 * @param err - The caught error value.
 * @returns `true` when the chain should advance to the next provider.
 *
 * @task T9319
 */
function isProviderExhausted(err: unknown): boolean {
  if (err instanceof PoolExhaustedError) return true;
  const classified = classifyError(err);
  return classified.shouldRotateCredential || classified.shouldFallback;
}

// ---------------------------------------------------------------------------
// Session provider (injectable for testing)
// ---------------------------------------------------------------------------

/**
 * Function signature for providing a single-turn auxiliary response from a
 * specific provider.
 *
 * Production code uses the DefaultLlmSessionFactory-based implementation.
 * Tests inject a mock to control per-provider behaviour.
 *
 * @internal
 */
export type AuxiliaryProvider = (
  entry: AuxiliaryFallbackEntry,
  messages: TransportMessage[],
  opts: SendOptions | undefined,
) => Promise<NormalizedResponse>;

// ---------------------------------------------------------------------------
// Core fallback logic
// ---------------------------------------------------------------------------

/**
 * Execute an auxiliary LLM call with multi-provider fallback.
 *
 * Iterates through `chain` front-to-back:
 * 1. Tries provider N's full credential pool (via `provider` fn).
 * 2. If the pool is exhausted or the call returns a fallback-triggering error,
 *    records the step as `'pool_exhausted'` and advances to N+1.
 * 3. On non-exhaustion error (network blip, 500, timeout), records as `'error'`
 *    and also advances — auxiliary calls are best-effort.
 * 4. Returns on the first success, attaching `meta.fallbackChain` to the result.
 * 5. When all providers are tried, throws {@link AllProvidersExhaustedError}.
 *
 * @param chain    - Ordered list of providers to try.
 * @param messages - Messages to pass to the LLM.
 * @param opts     - Per-call send options forwarded as-is to each provider.
 * @param provider - Injectable provider function (defaults to session-factory impl).
 * @returns The first successful {@link AuxiliaryFallbackResult}.
 * @throws {AllProvidersExhaustedError} When every provider in the chain fails.
 *
 * @task T9319
 */
export async function runAuxiliaryWithFallback(
  chain: AuxiliaryFallbackChain,
  messages: TransportMessage[],
  opts?: SendOptions,
  provider?: AuxiliaryProvider,
): Promise<AuxiliaryFallbackResult> {
  if (chain.length === 0) {
    throw new AllProvidersExhaustedError([]);
  }

  const resolvedProvider = provider ?? _defaultAuxiliaryProvider;
  const steps: FallbackChainStep[] = [];

  for (const entry of chain) {
    try {
      const response = await resolvedProvider(entry, messages, opts);
      steps.push({ provider: entry.provider, outcome: 'success' });
      const meta: AuxiliaryFallbackMeta = { fallbackChain: steps };
      const result: AuxiliaryFallbackResult = {
        ...response,
        providerData: { ...(response.providerData ?? {}), __fallbackMeta: meta },
        meta,
      };
      return result;
    } catch (err: unknown) {
      const outcome = isProviderExhausted(err) ? 'pool_exhausted' : 'error';
      const errorMessage = err instanceof Error ? err.message : String(err);
      steps.push({ provider: entry.provider, outcome, errorMessage });
    }
  }

  throw new AllProvidersExhaustedError(steps);
}

// ---------------------------------------------------------------------------
// Config reader
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated provider string (as stored in `llm.auxiliaryFallback`)
 * into an {@link AuxiliaryFallbackChain}.
 *
 * Invalid/empty entries are silently dropped. If parsing results in an empty
 * array, returns {@link DEFAULT_AUXILIARY_FALLBACK_CHAIN} as a safety fallback.
 *
 * Supports optional `provider:model` syntax per entry (e.g.
 * `"anthropic:claude-haiku-4-5-20251001,openrouter,groq:llama-3.1-8b"`)
 * for callers that want to pin specific models per provider.
 *
 * @param raw - Raw config string from `llm.auxiliaryFallback`.
 * @returns Parsed chain, or the default chain when `raw` is empty/invalid.
 *
 * @task T9319
 */
export function parseAuxiliaryFallbackChain(raw: string): AuxiliaryFallbackChain {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s): AuxiliaryFallbackEntry | null => {
      const colonIdx = s.indexOf(':');
      if (colonIdx === -1) {
        return { provider: s as ModelTransport };
      }
      const providerPart = s.slice(0, colonIdx).trim();
      const modelPart = s.slice(colonIdx + 1).trim();
      if (!providerPart) return null;
      return {
        provider: providerPart as ModelTransport,
        ...(modelPart ? { model: modelPart } : {}),
      };
    })
    .filter((e): e is AuxiliaryFallbackEntry => e !== null);

  return entries.length > 0 ? entries : DEFAULT_AUXILIARY_FALLBACK_CHAIN;
}

/**
 * Resolve the active auxiliary fallback chain from project config.
 *
 * Reads `llm.auxiliaryFallback` from the CLEO config. Falls back to
 * {@link DEFAULT_AUXILIARY_FALLBACK_CHAIN} when the key is absent.
 *
 * @param projectRoot - Optional project root for config resolution.
 * @returns The resolved chain (never empty — always at least the default).
 *
 * @task T9319
 */
export async function resolveAuxiliaryFallbackChain(
  projectRoot?: string,
): Promise<AuxiliaryFallbackChain> {
  try {
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig(projectRoot);
    const raw = (config.llm as Record<string, unknown> | undefined)?.['auxiliaryFallback'];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return parseAuxiliaryFallbackChain(raw);
    }
  } catch {
    // Config load failure is non-fatal — fall through to default.
  }
  return DEFAULT_AUXILIARY_FALLBACK_CHAIN;
}

// ---------------------------------------------------------------------------
// Default auxiliary provider (uses session factory)
// ---------------------------------------------------------------------------

/**
 * Production {@link AuxiliaryProvider} implementation.
 *
 * Lazily imports `DefaultLlmSessionFactory` to avoid circular dependency at
 * module load time (session-factory → concrete-session → this module path
 * would form a cycle via concrete-executor).
 *
 * @internal
 */
async function _defaultAuxiliaryProvider(
  entry: AuxiliaryFallbackEntry,
  messages: TransportMessage[],
  opts: SendOptions | undefined,
): Promise<NormalizedResponse> {
  const { DefaultLlmSessionFactory } = await import('./session-factory.js');
  const { resolveLLMForRole } = await import('./role-resolver.js');

  // Resolve credential for the requested provider by probing the 'hygiene'
  // role's credential store, then override the provider. This gives us a valid
  // credential while still honouring the per-provider credential pool.
  //
  // For the fallback chain the role is always 'hygiene' (auxiliary work).
  const resolved = await resolveLLMForRole('hygiene');

  // If the requested provider differs from what role-resolver chose, try to
  // build a session directly for the target provider. We use the session factory
  // to drive the full credential-pool → transport wiring.
  const factory = new DefaultLlmSessionFactory();

  // Build session: use the resolved provider from the chain entry.
  // Fall back to the role-resolved provider if the chain provider matches.
  const targetProvider = entry.provider;

  if (targetProvider === resolved.provider && resolved.sealedCredential) {
    const session = await factory.createForRole('hygiene');
    return session.send(messages, opts);
  }

  // For a different provider, try createForRole with a provider-matching role.
  // If no credential exists for this provider, the factory will throw and the
  // outer loop will catch it as a pool-exhaustion signal.
  //
  // We synthesise a temporary session via the single SSoT transport factory.
  const { resolveCredentials } = await import('./credentials.js');
  const { ConcreteSession } = await import('./concrete-session.js');
  const { ModelRunner } = await import('./model-runner.js');
  const { deriveApiWire } = await import('./api-mode.js');

  const credResult = await resolveCredentials(targetProvider, {});
  if (!credResult.apiKey) {
    // No credential for this provider — signal exhaustion to the outer loop.
    throw new PoolExhaustedError(targetProvider, 0, 0);
  }

  // Single SSoT transport construction (E9 · T11745): `deriveApiWire` stamps the
  // wire protocol + implied base URL; the one {@link ModelRunner} builds the
  // transport for ANY provider. This replaces the inline anthropic/gemini/
  // openai-compat branches that had drifted from `session-factory` — notably the
  // anthropic-OAuth branch here OMITTED the required `anthropic-beta` header,
  // which the ModelRunner now injects centrally.
  const authType: 'api_key' | 'oauth' = credResult.authType === 'oauth' ? 'oauth' : 'api_key';
  const wire = deriveApiWire(targetProvider, authType);
  const resolvedCredential: ResolvedCredential = {
    provider: targetProvider,
    label: 'fallback',
    token: credResult.apiKey,
    authType,
    expiresAt: null,
    refreshToken: null,
    extraHeaders: {},
    baseUrl: wire.baseUrl,
    awsProfile: null,
  };
  const transport = ModelRunner.buildTransportFromCredential(
    targetProvider,
    resolvedCredential,
    wire.apiMode,
  );

  const model = entry.model ?? resolved.model;
  const session = new ConcreteSession({
    transport,
    model,
    credential: resolvedCredential,
  });

  return session.send(messages, opts);
}
