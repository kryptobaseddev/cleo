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
 *    check the monthly spend cap (`./spend.ts`, D11159), take a token from the
 *    machine-wide request budget, then call the provider. Spend cap reached
 *    (`budget`), key monthly limit (`key_limit_exceeded`), budget denial,
 *    timeout, 401/402/403/429/5xx, network failure or a malformed answer →
 *    fallback. A 429 empties the shared budget for its `retry-after`; a
 *    503/529 trips it as a short circuit breaker; a 403 key limit stops
 *    decisions until the UTC month ends. Reported cost is added to the spend
 *    ledger. A call aborted AFTER it was sent (deadline or caller) may still be
 *    billed, so its reserved estimate is committed; only a failure before send
 *    or an error response releases the reservation.
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
  type DecisionBatchItem,
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
import { loadDecideConnection } from './credentials.js';
import { createJevProvider, JEV_ADAPTER_VERSION } from './jev-wire.js';
import {
  type DecisionProvider,
  type DecisionProviderConnection,
  DecisionProviderError,
  type DecisionProviderErrorKind,
} from './provider.js';
import { cachedCapabilities, refreshProviderState } from './provider-state.js';
import {
  createFileSpendLedger,
  DEFAULT_MONTHLY_SPEND_CAP_MICROS,
  MONTHLY_SPEND_CAP_KEY,
  type SpendLedger,
} from './spend.js';
import type { DecideFetch } from './transport.js';

/** Default per-site deadline for the budget + provider round trip, in ms. */
export const DEFAULT_DECISION_TIMEOUT_MS = 300;

/**
 * Default deadline for a whole {@link decideBatch} call, in ms (T12715).
 *
 * `POST /v1/systemone/batch` answers its items serially (2–5 s per 64
 * requests), so the System One integration spec (§1, batch row) requires an
 * HTTP timeout of at least 30 s. Batch callers are background sites (sweeps,
 * the T12495 harness replay), never a latency-critical write path, so the
 * 300 ms single-decision default would time out every real batch.
 */
export const DEFAULT_BATCH_DECISION_TIMEOUT_MS = 30_000;

/**
 * Upper bound on the lazy capability detection {@link decideBatch} runs
 * before its first batch, in ms (T12715). Also bounded by the batch deadline.
 */
export const CAPABILITY_DETECTION_TIMEOUT_MS = 5_000;

/** Circuit-breaker trip after a 503/529 that carried no `retry-after`, ms. */
export const OVERLOADED_COOLDOWN_MS = 30_000;

/**
 * A call site's local heuristic. It must be total and fast: it answers every
 * question in the request whenever no provider answer is available.
 */
export type DecisionHeuristic = (req: DecisionRequest) => Readonly<Record<string, DecisionAnswer>>;

/** Options for {@link decide}. */
export interface DecideOptions {
  /**
   * Provider connection (base URL + API key + optional default model).
   * Absent (`undefined`) → the connection stored by `cleo decide config`
   * (`./credentials.ts`) is loaded. `null`, a blank key or an invalid URL →
   * unconfigured, and every call returns the fallback.
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
  /** Monthly spend ledger; `null` disables the cap. Default: the machine-wide file ledger. */
  readonly spend?: SpendLedger | null;
  /** Monthly cap in micro-dollars. Default: `decide.budget.monthlyMicros`, else $1. */
  readonly spendCapMicros?: number;
  /** Audit sink; `null` disables. Default: `<projectRoot>/.cleo/audit/decisions.jsonl`. */
  readonly audit?: DecisionAuditSink | null;
  /** Project root for the default audit sink. Default: the resolved CLEO project root. */
  readonly projectRoot?: string;
  /** Cache-key namespace. Default: the Jev adapter version. */
  readonly adapterVersion?: string;
  /** Caller cancellation; treated like a timeout (fallback, no throw). */
  readonly signal?: AbortSignal;
  /** Transport for a provider built from `connection`. Default: the abort-complete `decideFetch`. */
  readonly fetch?: DecideFetch;
  /** Provider-state file (detected capabilities). Default: `<cleoHome>/decide/provider-state.json`. */
  readonly providerStatePath?: string;
}

let defaultCache: DecisionCache | null = null;
let defaultBudget: DecisionBudget | null = null;
let defaultSpend: SpendLedger | null = null;
let defaultSpendCap: Promise<number> | null = null;

function processCache(): DecisionCache {
  defaultCache ??= createDecisionCache();
  return defaultCache;
}

function processBudget(): DecisionBudget {
  defaultBudget ??= createFileTokenBucket();
  return defaultBudget;
}

function processSpend(): SpendLedger {
  defaultSpend ??= createFileSpendLedger();
  return defaultSpend;
}

/** The configured monthly cap, read once per process; the $1 default when unset or unreadable. */
function processSpendCap(projectRoot: string | undefined): Promise<number> {
  defaultSpendCap ??= (async (): Promise<number> => {
    try {
      const { getConfigValue } = await import('../config/registry.js');
      const value: unknown = await getConfigValue(MONTHLY_SPEND_CAP_KEY, {
        projectRoot: projectRoot ?? getProjectRoot(),
      });
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : DEFAULT_MONTHLY_SPEND_CAP_MICROS;
    } catch {
      return DEFAULT_MONTHLY_SPEND_CAP_MICROS;
    }
  })();
  return defaultSpendCap;
}

/**
 * Reset the process-default cache and budget. Tests only.
 *
 * @internal
 */
export function _resetDecideDefaultsForTest(): void {
  defaultCache = null;
  defaultBudget = null;
  defaultSpend = null;
  defaultSpendCap = null;
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

/** Whether `connection` is usable: a non-blank key and an allowed base URL. */
function usableConnection(
  connection: DecisionProviderConnection | null,
): connection is DecisionProviderConnection {
  return (
    connection !== null &&
    connection.apiKey.trim() !== '' &&
    decisionProviderConfigSchema.safeParse({ baseUrl: connection.baseUrl }).success
  );
}

/** The explicit connection, or — when none was passed — the stored one. */
function resolveConnection(opts: DecideOptions): DecisionProviderConnection | null {
  if (opts.connection !== undefined) return opts.connection;
  if (opts.provider) return null;
  return loadDecideConnection()?.connection() ?? null;
}

function resolveProvider(
  opts: DecideOptions,
  connection: DecisionProviderConnection | null,
): DecisionProvider | null {
  if (opts.provider) return opts.provider;
  if (!usableConnection(connection)) return null;
  const capabilities = cachedCapabilities(connection, Date.now(), opts.providerStatePath);
  return createJevProvider(connection, {
    ...(capabilities ? { capabilities } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

/**
 * Lazy capability detection (T12715), run by {@link decideBatch} only: when
 * the cached provider state is absent or stale, detect it before building the
 * provider, within `budgetMs` (at most {@link CAPABILITY_DETECTION_TIMEOUT_MS}).
 * {@link refreshProviderState} limits this to one detection per identity per
 * refresh interval. Never throws; an injected provider is never probed.
 *
 * A single {@link decide} never calls this (see `provider-state.ts`).
 */
async function detectLazily(
  opts: DecideOptions,
  connection: DecisionProviderConnection | null,
  budgetMs: number,
): Promise<void> {
  if (opts.provider || !usableConnection(connection)) return;
  const timeout = AbortSignal.timeout(
    Math.max(0, Math.min(budgetMs, CAPABILITY_DETECTION_TIMEOUT_MS)),
  );
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  try {
    await refreshProviderState(connection, signal, {
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.providerStatePath !== undefined ? { path: opts.providerStatePath } : {}),
    });
  } catch {
    /* detection is best effort: the Jev minimum still answers */
  }
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

/**
 * The gates for a call. The configured cap is read BEFORE the deadline
 * starts (a cold config read is not provider wait), once per process.
 */
async function resolveGates(opts: DecideOptions): Promise<Gates> {
  const budget = opts.budget === undefined ? processBudget() : opts.budget;
  const spend = opts.spend === undefined ? processSpend() : opts.spend;
  const capMicros =
    opts.spendCapMicros ??
    (spend ? await processSpendCap(opts.projectRoot) : Number.POSITIVE_INFINITY);
  return { budget, spend, capMicros };
}

/** True when `outcome` is contract-valid and answers every question with the right type. */
function coversRequest(outcome: DecisionOutcome, req: DecisionRequest): boolean {
  if (!decisionOutcomeSchema.safeParse(outcome).success) return false;
  return Object.entries(req.questions).every(([name, q]) => outcome.answers[name]?.type === q.type);
}

type Attempt =
  | { readonly ok: true; readonly outcome: DecisionOutcome }
  | { readonly ok: false; readonly reason: DecisionFallbackReason };

/** The spend and request gates one provider call passes through. */
interface Gates {
  readonly budget: DecisionBudget | null;
  readonly spend: SpendLedger | null;
  readonly capMicros: number;
}

/**
 * Cost reserved per question before a call, micro-dollars. Only a
 * reservation: the provider-reported cost replaces it on commit, so this is
 * never what is recorded (layahost bills 5–15 µ$ per decision, 2026-09).
 */
export const DECISION_COST_ESTIMATE_MICROS_PER_QUESTION = 15;

/** Estimated cost of asking `reqs`. */
function estimateMicros(reqs: readonly DecisionRequest[]): number {
  return reqs.reduce(
    (n, r) => n + Object.keys(r.questions).length * DECISION_COST_ESTIMATE_MICROS_PER_QUESTION,
    0,
  );
}

type GateResult =
  | { readonly ok: true; readonly reservation?: string }
  | { readonly ok: false; readonly reason: DecisionFallbackReason };

/**
 * Spend cap (check and reserve, atomically) then request budget. A
 * reservation is released again when the budget refuses.
 */
async function passGates(gates: Gates, estimate: number): Promise<GateResult> {
  let reservation: string | undefined;
  if (gates.spend) {
    const r = await gates.spend.reserve(gates.capMicros, estimate);
    if (r.verdict === 'over_budget') return { ok: false, reason: 'budget' };
    if (r.verdict === 'key_limited') return { ok: false, reason: 'key_limit_exceeded' };
    if (r.verdict === 'unavailable') return { ok: false, reason: 'budget_unavailable' };
    reservation = r.id;
  }
  if (gates.budget) {
    const grant = await gates.budget.tryAcquire();
    if (!grant.granted) {
      if (reservation !== undefined) await gates.spend?.release(reservation);
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
  return { ok: true, ...(reservation !== undefined ? { reservation } : {}) };
}

/** Commit the reported cost against a reservation (or record it when there is none). */
async function settle(
  gates: Gates,
  reservation: string | undefined,
  micros: number,
): Promise<void> {
  if (!gates.spend) return;
  if (reservation !== undefined) await gates.spend.commit(reservation, micros);
  else await gates.spend.record(micros);
}

/** Side effects of a provider error on the shared gates; the fallback reason. */
async function onProviderError(
  err: DecisionProviderError,
  gates: Gates,
): Promise<DecisionFallbackReason> {
  if (err.kind === 'rate_limited' && gates.budget) await gates.budget.penalize(err.retryAfterMs);
  if (err.kind === 'overloaded' && gates.budget) {
    await gates.budget.penalize(err.retryAfterMs ?? OVERLOADED_COOLDOWN_MS);
  }
  if (err.kind === 'key_limit_exceeded' && gates.spend) await gates.spend.markKeyLimited();
  return reasonForError(err);
}

/**
 * Whether a failed call may still have been billed: it was aborted (deadline
 * or caller) AFTER the request was handed to the provider. The server may
 * have answered and billed it, so its reservation is committed at the
 * estimate rather than released. Every other failure is an error response or
 * a transport failure, which the provider does not bill.
 */
function abortedAfterSend(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof DecisionProviderError && err.kind === 'aborted');
}

/**
 * Settle a reservation after a failed call: commit the estimate when the
 * call was aborted after send ({@link abortedAfterSend}), else release it.
 */
async function settleFailure(
  gates: Gates,
  reservation: string | undefined,
  estimate: number,
  err: unknown,
  signal: AbortSignal,
): Promise<void> {
  if (reservation === undefined || !gates.spend) return;
  if (abortedAfterSend(err, signal)) await gates.spend.commit(reservation, estimate);
  else await gates.spend.release(reservation);
}

/** Micro-dollars an outcome reported, preferring the exact integer. */
function reportedMicros(outcome: DecisionOutcome): number {
  if (outcome.costMicros !== undefined) return outcome.costMicros;
  return outcome.costUsd !== undefined ? Math.round(outcome.costUsd * 1e6) : 0;
}

/** Spend gate + budget + provider call; never rejects. */
async function attempt(
  provider: DecisionProvider,
  gates: Gates,
  req: DecisionRequest,
  signal: AbortSignal,
): Promise<Attempt> {
  const estimate = estimateMicros([req]);
  const gate = await passGates(gates, estimate);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  if (signal.aborted) {
    // Pre-send: nothing left the machine, so nothing can be billed.
    if (gate.reservation !== undefined) await gates.spend?.release(gate.reservation);
    return { ok: false, reason: 'timeout' };
  }
  try {
    const outcome = await provider.decide(req, signal);
    // A 2xx is billed even when its body is unusable.
    await settle(gates, gate.reservation, reportedMicros(outcome));
    if (!coversRequest(outcome, req)) return { ok: false, reason: 'invalid_response' };
    return { ok: true, outcome };
  } catch (err) {
    // Failed requests are not billed (provider docs), but one aborted after
    // send may have been answered and billed: charge its estimate.
    await settleFailure(gates, gate.reservation, estimate, err, signal);
    if (err instanceof DecisionProviderError) {
      return { ok: false, reason: await onProviderError(err, gates) };
    }
    return { ok: false, reason: signal.aborted ? 'timeout' : 'provider_error' };
  }
}

/**
 * Run `attempt` under a hard deadline. Resolves at the latest when the
 * deadline or the caller's signal fires, even if the provider ignores its
 * abort signal.
 */
function withDeadline<T extends { readonly ok: boolean }>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  timedOut: T,
  crashed: T,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (result: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
      resolve(result);
    };
    const onTimeout = (): void => {
      controller.abort();
      finish(timedOut);
    };
    const onCallerAbort = (): void => onTimeout();
    const timer = setTimeout(onTimeout, Math.max(0, timeoutMs));
    if (callerSignal?.aborted) {
      onTimeout();
      return;
    }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    run(controller.signal).then(finish, () => finish(crashed));
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
  const audit = resolveAudit(opts);
  const connection = resolveConnection(opts);
  const item = prepare(siteId, req, fallback, opts, audit, connection);

  const provider = resolveProvider(opts, connection);
  if (!provider) return item.useFallback('unconfigured');
  if (!item.valid) return item.useFallback('invalid_request');

  const cache = opts.cache === undefined ? processCache() : opts.cache;
  const hit = cache?.get(item.key);
  if (hit) return item.finish({ ...hit, source: 'cache', latencyMs: item.elapsed() });

  const gates = await resolveGates(opts);
  const result = await withDeadline<Attempt>(
    (signal) => attempt(provider, gates, item.sent, signal),
    opts.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS,
    opts.signal,
    { ok: false, reason: 'timeout' },
    { ok: false, reason: 'provider_error' },
  );
  if (!result.ok) return item.useFallback(result.reason);

  cache?.set(item.key, result.outcome);
  return item.finish({ ...result.outcome, source: 'provider', latencyMs: item.elapsed() });
}

/** One request made ready to send: redacted, validated, keyed, with its audit closures. */
interface PreparedDecision {
  /** The redacted request (default model applied). */
  readonly sent: DecisionRequest;
  /** Whether `sent` passes the contract schema. */
  readonly valid: boolean;
  /** Cache key of `sent`. */
  readonly key: string;
  /** Milliseconds since preparation. */
  readonly elapsed: () => number;
  /** Audit and return an outcome. */
  readonly finish: (outcome: DecisionOutcome, reason?: DecisionFallbackReason) => DecisionOutcome;
  /** Audit and return the heuristic's answer. */
  readonly useFallback: (reason: DecisionFallbackReason) => DecisionOutcome;
}

/** Redact, validate, key and wire the audit for one request. */
function prepare(
  siteId: string,
  req: DecisionRequest,
  fallback: DecisionHeuristic,
  opts: DecideOptions,
  audit: DecisionAuditSink | null,
  connection: DecisionProviderConnection | null,
): PreparedDecision {
  const started = performance.now();
  const elapsed = (): number => Math.max(0, performance.now() - started);
  const defaultModel = req.model === undefined ? connection?.model : undefined;
  const sent: DecisionRequest = {
    ...req,
    ...(defaultModel ? { model: defaultModel } : {}),
    state: redactDecisionState(req.state),
  };
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
      ...(outcome.costMicros !== undefined ? { costMicros: outcome.costMicros } : {}),
      ...(outcome.balanceMicros !== undefined ? { balanceMicros: outcome.balanceMicros } : {}),
      ...(outcome.checkpoint !== undefined ? { checkpoint: outcome.checkpoint } : {}),
      ...(sent.model !== undefined ? { model: sent.model } : {}),
    });
    return outcome;
  };
  return {
    sent,
    valid: decisionRequestSchema.safeParse(sent).success,
    key: decisionCacheKey(opts.adapterVersion ?? JEV_ADAPTER_VERSION, sent),
    elapsed,
    finish,
    useFallback: (reason) =>
      finish({ answers: fallback(req), source: 'fallback', latencyMs: elapsed() }, reason),
  };
}

/** One request of a {@link decideBatch} call, with its own heuristic. */
export interface DecisionBatchEntry {
  /** Questions and state. */
  readonly req: DecisionRequest;
  /** The heuristic for this request. */
  readonly fallback: DecisionHeuristic;
}

/**
 * Ask several typed decisions at call site `siteId` under ONE deadline.
 *
 * When the provider reports a batch capability (`capabilities().batch`) and
 * the entries fit its limits, the uncached ones go out as a single batch call
 * (one spend check, one budget token). Otherwise it degrades to sequential
 * {@link decide} calls that share the remaining deadline; entries the
 * deadline cannot reach fall back with reason `timeout`. Never rejects; each
 * entry is audited like a single decision.
 *
 * The whole-batch deadline defaults to {@link DEFAULT_BATCH_DECISION_TIMEOUT_MS}
 * (30 s), not the 300 ms single-decision default. In the sequential
 * degradation each call is additionally capped at
 * {@link DEFAULT_DECISION_TIMEOUT_MS} unless the caller set `timeoutMs`, so a
 * slow provider without the batch capability cannot hold one entry for 30 s.
 *
 * @param siteId - Stable call-site identifier.
 * @param entries - Requests with their heuristics.
 * @param opts - Same wiring as {@link decide}; `timeoutMs` covers the whole batch
 *   (default {@link DEFAULT_BATCH_DECISION_TIMEOUT_MS}).
 * @returns One outcome per entry, in order.
 */
export async function decideBatch(
  siteId: string,
  entries: readonly DecisionBatchEntry[],
  opts: DecideOptions = {},
): Promise<DecisionOutcome[]> {
  if (entries.length === 0) return [];
  const started = performance.now();
  const deadlineMs = opts.timeoutMs ?? DEFAULT_BATCH_DECISION_TIMEOUT_MS;
  const remaining = (): number => Math.max(0, deadlineMs - (performance.now() - started));

  const connection = resolveConnection(opts);
  // Batch is the non-latency-critical path, so it may detect capabilities
  // lazily before its first call; the detection time counts against its deadline.
  await detectLazily(opts, connection, remaining());
  const provider = resolveProvider(opts, connection);
  const limits = provider?.capabilities?.().batch;
  const questions = entries.reduce((n, e) => n + Object.keys(e.req.questions).length, 0);
  const batchable =
    provider !== null &&
    provider.decideBatch !== undefined &&
    limits !== undefined &&
    entries.length > 1 &&
    entries.length <= limits.maxRequests &&
    questions <= limits.maxQuestions;

  if (!batchable || !provider?.decideBatch) {
    const out: DecisionOutcome[] = [];
    for (const entry of entries) {
      const timeoutMs =
        opts.timeoutMs === undefined
          ? Math.min(remaining(), DEFAULT_DECISION_TIMEOUT_MS)
          : remaining();
      // model-site-allowed: plumbing — the caller's siteId is checked at its decideBatch call (gate 35)
      const outcome = await decide(siteId, entry.req, entry.fallback, { ...opts, timeoutMs });
      out.push(outcome);
    }
    return out;
  }

  const audit = resolveAudit(opts);
  const cache = opts.cache === undefined ? processCache() : opts.cache;
  const items = entries.map((e) => prepare(siteId, e.req, e.fallback, opts, audit, connection));
  const out: Array<DecisionOutcome | undefined> = items.map((item) => {
    if (!item.valid) return item.useFallback('invalid_request');
    const hit = cache?.get(item.key);
    return hit ? item.finish({ ...hit, source: 'cache', latencyMs: item.elapsed() }) : undefined;
  });
  const pending = items.flatMap((item, i) => (out[i] === undefined ? [{ item, i }] : []));
  if (pending.length > 0) {
    const gates = await resolveGates(opts);
    const batch = provider.decideBatch.bind(provider);
    type BatchResult =
      | { readonly ok: true; readonly items: readonly DecisionBatchItem[] }
      | { readonly ok: false; readonly reason: DecisionFallbackReason };
    const result = await withDeadline<BatchResult>(
      async (signal) => {
        const sent = pending.map((p) => p.item.sent);
        const estimate = estimateMicros(sent);
        const gate = await passGates(gates, estimate);
        if (!gate.ok) return { ok: false, reason: gate.reason };
        if (signal.aborted) {
          if (gate.reservation !== undefined) await gates.spend?.release(gate.reservation);
          return { ok: false, reason: 'timeout' };
        }
        try {
          const answered = await batch(sent, signal);
          const billed = answered.reduce((n, a) => n + (a.ok ? reportedMicros(a.outcome) : 0), 0);
          await settle(gates, gate.reservation, billed);
          return { ok: true, items: answered };
        } catch (err) {
          await settleFailure(gates, gate.reservation, estimate, err, signal);
          if (err instanceof DecisionProviderError) {
            return { ok: false, reason: await onProviderError(err, gates) };
          }
          return { ok: false, reason: signal.aborted ? 'timeout' : 'provider_error' };
        }
      },
      remaining(),
      opts.signal,
      { ok: false, reason: 'timeout' },
      { ok: false, reason: 'provider_error' },
    );
    if (result.ok) await applyBatchItemErrors(result.items, gates);
    for (const [k, { item, i }] of pending.entries()) {
      if (!result.ok) {
        out[i] = item.useFallback(result.reason);
        continue;
      }
      const answered = result.items[k];
      if (answered?.ok && coversRequest(answered.outcome, item.sent)) {
        cache?.set(item.key, answered.outcome);
        out[i] = item.finish({
          ...answered.outcome,
          source: 'provider',
          latencyMs: item.elapsed(),
        });
      } else {
        out[i] = item.useFallback(
          answered && !answered.ok ? batchItemReason(answered.errorKind) : 'invalid_response',
        );
      }
    }
  }
  return items.map((item, i) => out[i] ?? item.useFallback('provider_error'));
}

/** Fallback reason for a failed batch item. */
function batchItemReason(kind: string): DecisionFallbackReason {
  switch (kind) {
    case 'unauthorized':
    case 'insufficient_credits':
    case 'key_limit_exceeded':
    case 'rate_limited':
    case 'overloaded':
    case 'server_error':
    case 'invalid_request':
    case 'invalid_response':
      return kind;
    default:
      return 'provider_error';
  }
}

/** Batch item error kinds with a side effect on the shared gates. */
const GATE_ERROR_KINDS: ReadonlySet<DecisionProviderErrorKind> = new Set<DecisionProviderErrorKind>(
  ['key_limit_exceeded', 'rate_limited', 'overloaded'],
);

/** The gate-affecting provider error kind named by a batch item, if any. */
function gateErrorKind(kind: string): DecisionProviderErrorKind | null {
  for (const k of GATE_ERROR_KINDS) if (k === kind) return k;
  return null;
}

/**
 * Give failed batch items the same gate side effects as a failed single
 * call (key-limit stop, rate-limit and overload back-off), once per kind.
 */
async function applyBatchItemErrors(
  items: readonly DecisionBatchItem[],
  gates: Gates,
): Promise<void> {
  const seen = new Set<DecisionProviderErrorKind>();
  for (const item of items) {
    if (item.ok) continue;
    const kind = gateErrorKind(item.errorKind);
    if (kind === null || seen.has(kind)) continue;
    seen.add(kind);
    await onProviderError(
      new DecisionProviderError(kind, `batch item failed: ${kind}`, {
        ...(item.status !== undefined ? { status: item.status } : {}),
      }),
      gates,
    );
  }
}
