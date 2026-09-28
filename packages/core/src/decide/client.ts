/**
 * Typed-decision client — the one entry point CLEO call sites use for
 * "System One" decisions.
 *
 * `decide(siteId, req, fallback, opts)` ALWAYS resolves with a
 * {@link DecisionOutcome}; it never rejects because of the provider. The
 * pipeline is:
 *
 * 1. No provider configured → the site's heuristic (`source: 'fallback'`).
 * 2. Redact the state through the memory redaction module, then validate the
 *    request with the contract schema (invalid → fallback).
 * 3. In-memory LRU cache hit → `source: 'cache'`.
 * 4. Within ONE per-site deadline (default {@link DEFAULT_DECISION_TIMEOUT_MS}):
 *    take a token from the machine-wide budget, then call the provider.
 *    Budget denial, timeout, 401/402/429/5xx, network failure or a malformed
 *    answer → fallback. A 429 also empties the shared budget for its
 *    `retry-after` so no other process piles on.
 * 5. Append one audit line (never containing the key or raw state).
 *
 * Provider-specific knowledge (endpoints, wire JSON) lives only in
 * `./jev-wire.ts`; this module sees the {@link DecisionProvider} port.
 *
 * @task T12490
 * @epic T12486
 */

import {
  type DecisionAnswer,
  type DecisionJsonValue,
  type DecisionOutcome,
  type DecisionRequest,
  type DecisionState,
  decisionOutcomeSchema,
  decisionProviderConfigSchema,
  decisionRequestSchema,
} from '@cleocode/contracts';
import { redactContent } from '../memory/redaction.js';
import { getProjectRoot } from '../paths.js';
import {
  auditAnswers,
  createJsonlDecisionAudit,
  type DecisionAuditSink,
  type DecisionFallbackReason,
} from './audit.js';
import { createFileTokenBucket, type DecisionBudget } from './budget.js';
import {
  createDecisionCache,
  type DecisionCache,
  decisionCacheKey,
  hashCanonical,
} from './cache.js';
import { createJevProvider, JEV_ADAPTER_VERSION } from './jev-wire.js';
import {
  type DecisionProvider,
  type DecisionProviderConnection,
  DecisionProviderError,
} from './provider.js';

/** Default per-site deadline for the budget + provider round trip, in ms. */
export const DEFAULT_DECISION_TIMEOUT_MS = 300;

/**
 * A call site's local heuristic. It must be total and fast: it answers every
 * question in the request whenever no provider answer is available.
 */
export type DecisionHeuristic = (req: DecisionRequest) => Readonly<Record<string, DecisionAnswer>>;

/** Options for {@link decide}. */
export interface DecideOptions {
  /**
   * Provider connection (base URL + API key). Absent, null, or with a blank
   * key / invalid URL → unconfigured, and every call returns the fallback.
   */
  readonly connection?: DecisionProviderConnection | null;
  /** Explicit provider; overrides `connection`. Tests inject a fake here. */
  readonly provider?: DecisionProvider;
  /** Deadline for budget + provider, ms. Default {@link DEFAULT_DECISION_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Outcome cache; `null` disables. Default: one per-process LRU. */
  readonly cache?: DecisionCache | null;
  /** Request budget; `null` disables. Default: the machine-wide file bucket. */
  readonly budget?: DecisionBudget | null;
  /** Audit sink; `null` disables. Default: `<projectRoot>/.cleo/audit/decisions.jsonl`. */
  readonly audit?: DecisionAuditSink | null;
  /** Project root for the default audit sink. Default: the resolved CLEO project root. */
  readonly projectRoot?: string;
  /** Cache-key namespace. Default: the Jev adapter version. */
  readonly adapterVersion?: string;
  /** Caller cancellation; treated like a timeout (fallback, no throw). */
  readonly signal?: AbortSignal;
}

let defaultCache: DecisionCache | null = null;
let defaultBudget: DecisionBudget | null = null;

function processCache(): DecisionCache {
  defaultCache ??= createDecisionCache();
  return defaultCache;
}

function processBudget(): DecisionBudget {
  defaultBudget ??= createFileTokenBucket();
  return defaultBudget;
}

/**
 * Reset the process-default cache and budget. Tests only.
 *
 * @internal
 */
export function _resetDecideDefaultsForTest(): void {
  defaultCache = null;
  defaultBudget = null;
}

function redactJson(value: DecisionJsonValue): DecisionJsonValue {
  if (typeof value === 'string') return redactContent(value).content;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactJson);
  const out: Record<string, DecisionJsonValue> = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactJson(v);
  return out;
}

/**
 * Scrub secrets from a decision state before it leaves the machine, using the
 * shared memory redaction patterns. Strings are redacted in place; structured
 * state is redacted leaf by leaf so it stays valid JSON.
 *
 * @param state - Raw state.
 * @returns Redacted state of the same shape.
 */
export function redactDecisionState(state: DecisionState): DecisionState {
  if (typeof state === 'string') return redactContent(state).content;
  if (Array.isArray(state)) return state.map(redactJson);
  const out: Record<string, DecisionJsonValue> = {};
  for (const [k, v] of Object.entries(state)) out[k] = redactJson(v);
  return out;
}

function resolveProvider(opts: DecideOptions): DecisionProvider | null {
  if (opts.provider) return opts.provider;
  const connection = opts.connection;
  if (!connection || connection.apiKey.trim() === '') return null;
  if (!decisionProviderConfigSchema.safeParse({ baseUrl: connection.baseUrl }).success) return null;
  return createJevProvider(connection);
}

function resolveAudit(opts: DecideOptions): DecisionAuditSink | null {
  if (opts.audit !== undefined) return opts.audit;
  try {
    return createJsonlDecisionAudit(opts.projectRoot ?? getProjectRoot());
  } catch {
    return null;
  }
}

function reasonForError(err: DecisionProviderError): DecisionFallbackReason {
  switch (err.kind) {
    case 'aborted':
      return 'timeout';
    case 'invalid_request':
      return 'invalid_request';
    default:
      return err.kind;
  }
}

/** True when `outcome` is contract-valid and answers every question with the right type. */
function coversRequest(outcome: DecisionOutcome, req: DecisionRequest): boolean {
  if (!decisionOutcomeSchema.safeParse(outcome).success) return false;
  return Object.entries(req.questions).every(([name, q]) => outcome.answers[name]?.type === q.type);
}

type Attempt =
  | { readonly ok: true; readonly outcome: DecisionOutcome }
  | { readonly ok: false; readonly reason: DecisionFallbackReason };

/** Budget + provider call; never rejects. */
async function attempt(
  provider: DecisionProvider,
  budget: DecisionBudget | null,
  req: DecisionRequest,
  signal: AbortSignal,
): Promise<Attempt> {
  if (budget) {
    const grant = await budget.tryAcquire();
    if (!grant.granted) {
      return {
        ok: false,
        reason:
          grant.reason === 'exhausted'
            ? 'budget_exhausted'
            : grant.reason === 'cooling_down'
              ? 'budget_cooling_down'
              : 'budget_unavailable',
      };
    }
  }
  if (signal.aborted) return { ok: false, reason: 'timeout' };
  try {
    const outcome = await provider.decide(req, signal);
    if (!coversRequest(outcome, req)) return { ok: false, reason: 'invalid_response' };
    return { ok: true, outcome };
  } catch (err) {
    if (err instanceof DecisionProviderError) {
      if (err.kind === 'rate_limited' && budget) await budget.penalize(err.retryAfterMs);
      return { ok: false, reason: reasonForError(err) };
    }
    return { ok: false, reason: signal.aborted ? 'timeout' : 'provider_error' };
  }
}

/**
 * Run `attempt` under a hard deadline. Resolves at the latest when the
 * deadline or the caller's signal fires, even if the provider ignores its
 * abort signal.
 */
function withDeadline(
  run: (signal: AbortSignal) => Promise<Attempt>,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<Attempt> {
  const controller = new AbortController();
  return new Promise<Attempt>((resolve) => {
    let settled = false;
    const finish = (result: Attempt): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
      resolve(result);
    };
    const onTimeout = (): void => {
      controller.abort();
      finish({ ok: false, reason: 'timeout' });
    };
    const onCallerAbort = (): void => onTimeout();
    const timer = setTimeout(onTimeout, Math.max(0, timeoutMs));
    if (callerSignal?.aborted) {
      onTimeout();
      return;
    }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    run(controller.signal).then(finish, () => finish({ ok: false, reason: 'provider_error' }));
  });
}

/**
 * Ask a typed decision at call site `siteId`.
 *
 * Never rejects on provider trouble: when the provider is unconfigured,
 * over budget, slow, failing or wrong, the site's `fallback` heuristic answers
 * and the outcome carries `source: 'fallback'`.
 *
 * @param siteId - Stable call-site identifier (audited; used for per-site tuning).
 * @param req - Questions and state.
 * @param fallback - The site's heuristic; receives the original (unredacted) request.
 * @param opts - Provider, deadline, cache, budget and audit wiring.
 * @returns The decision outcome.
 *
 * @example
 * ```ts
 * const outcome = await decide(
 *   'tasks.duplicate-check',
 *   { state: text, questions: { dup: { type: 'noul', criteria: 'The two tasks describe the same work' } } },
 *   () => ({ dup: { type: 'noul', value: false, probability: 0.2, confidence: 0.5 } }),
 *   { connection, timeoutMs: 250 },
 * );
 * ```
 */
export async function decide(
  siteId: string,
  req: DecisionRequest,
  fallback: DecisionHeuristic,
  opts: DecideOptions = {},
): Promise<DecisionOutcome> {
  const started = performance.now();
  const elapsed = (): number => Math.max(0, performance.now() - started);
  const audit = resolveAudit(opts);

  const sent: DecisionRequest = { ...req, state: redactDecisionState(req.state) };
  const questionsHash = hashCanonical(req.questions);
  const stateHash = hashCanonical(sent.state);

  const finish = (outcome: DecisionOutcome, reason?: DecisionFallbackReason): DecisionOutcome => {
    audit?.write({
      timestamp: new Date().toISOString(),
      site: siteId,
      ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
      questionsHash,
      stateHash,
      answers: auditAnswers(outcome),
      source: outcome.source,
      ...(reason ? { fallbackReason: reason } : {}),
      latencyMs: outcome.latencyMs,
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
    });
    return outcome;
  };
  const useFallback = (reason: DecisionFallbackReason): DecisionOutcome =>
    finish({ answers: fallback(req), source: 'fallback', latencyMs: elapsed() }, reason);

  const provider = resolveProvider(opts);
  if (!provider) return useFallback('unconfigured');
  if (!decisionRequestSchema.safeParse(sent).success) return useFallback('invalid_request');

  const cache = opts.cache === undefined ? processCache() : opts.cache;
  const key = decisionCacheKey(opts.adapterVersion ?? JEV_ADAPTER_VERSION, sent);
  const hit = cache?.get(key);
  if (hit) return finish({ ...hit, source: 'cache', latencyMs: elapsed() });

  const budget = opts.budget === undefined ? processBudget() : opts.budget;
  const result = await withDeadline(
    (signal) => attempt(provider, budget, sent, signal),
    opts.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS,
    opts.signal,
  );
  if (!result.ok) return useFallback(result.reason);

  cache?.set(key, result.outcome);
  return finish({ ...result.outcome, source: 'provider', latencyMs: elapsed() });
}
