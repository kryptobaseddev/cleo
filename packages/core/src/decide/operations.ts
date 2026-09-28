/**
 * Operator-facing decision operations behind `cleo decide config|status|ask`.
 *
 * All logic lives here (the CLI handlers are thin, arch gate 6). Every value
 * these functions return is secret-free: the API key appears only as a masked
 * last-4 preview.
 *
 * @task T12491
 * @epic T12486
 */

import type { DecisionAnswer } from '@cleocode/contracts';
import { getProjectRoot } from '../paths.js';
import {
  createJsonlDecisionAudit,
  type DecisionAuditEntry,
  type DecisionAuditSink,
} from './audit.js';
import { decide } from './client.js';
import {
  clearDecideCredentials,
  DecideCredentialsError,
  type DecideCredentialsSummary,
  describeDecideCredentials,
  loadDecideConnection,
  type SealedDecideConnection,
  sameDecideHost,
  saveDecideCredentials,
} from './credentials.js';
import { listJevModels } from './jev-wire.js';
import { DecisionProviderError } from './provider.js';

/** Default deadline for the `GET /v1/models` probe, ms. */
export const DEFAULT_DECIDE_PROBE_TIMEOUT_MS = 3_000;

/** Default deadline for `cleo decide ask`, ms (generous: it is a debug tool). */
export const DEFAULT_DECIDE_ASK_TIMEOUT_MS = 10_000;

/**
 * Reachability of the configured provider.
 *
 * - `reachable`    — `GET /v1/models` answered 2xx.
 * - `unauthorized` — the provider rejected the key (401/403).
 * - `unconfigured` — no valid base URL + key stored.
 * - `unreachable`  — network failure, timeout, or any other HTTP status.
 */
export type DecideProviderState = 'reachable' | 'unauthorized' | 'unconfigured' | 'unreachable';

/** Result of {@link probeDecideProvider}. */
export interface DecideProbeResult {
  /** Reachability verdict. */
  readonly state: DecideProviderState;
  /** Configured base URL. */
  readonly baseUrl?: string;
  /** Masked key preview. */
  readonly keyPreview?: string;
  /** Configured default model, when set. */
  readonly model?: string;
  /** Whether `GET /v1/models` succeeded (`skipped` when unconfigured). */
  readonly modelsEndpoint: 'ok' | 'failed' | 'skipped';
  /** Model names the key may use, when listed. */
  readonly models?: readonly string[];
  /** HTTP status of the probe, when one was received. */
  readonly httpStatus?: number;
  /** Probe latency, ms. */
  readonly latencyMs?: number;
  /** Secret-free explanation or warning. */
  readonly detail?: string;
}

/** Options for {@link probeDecideProvider}. */
export interface DecideProbeOptions {
  /** Connection to probe. Default: the stored connection. */
  readonly connection?: SealedDecideConnection | null;
  /** `fetch` implementation; tests inject a stub. */
  readonly fetch?: typeof fetch;
  /** Deadline, ms. Default {@link DEFAULT_DECIDE_PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

const NO_MODEL_WARNING =
  'No default model is configured. The Jev /v1/systemone endpoint requires a model; set one with `cleo decide config --model <name>` (see `models`).';

function stateForError(err: unknown): { state: DecideProviderState; httpStatus?: number } {
  if (err instanceof DecisionProviderError) {
    if (err.kind === 'unauthorized') return { state: 'unauthorized', httpStatus: err.status };
    if (err.kind === 'invalid_response') return { state: 'reachable', httpStatus: err.status };
    return {
      state: 'unreachable',
      ...(err.status !== undefined ? { httpStatus: err.status } : {}),
    };
  }
  return { state: 'unreachable' };
}

/**
 * Probe the provider with `GET {baseUrl}/v1/models` under a short deadline.
 * Never throws.
 *
 * @param opts - Connection, `fetch` and deadline.
 * @returns The reachability verdict and, when listed, the available models.
 */
export async function probeDecideProvider(
  opts: DecideProbeOptions = {},
): Promise<DecideProbeResult> {
  const sealed = opts.connection === undefined ? loadDecideConnection() : opts.connection;
  if (!sealed) {
    return {
      state: 'unconfigured',
      modelsEndpoint: 'skipped',
      detail: 'Run `cleo decide config`.',
    };
  }
  const base = {
    baseUrl: sealed.baseUrl,
    keyPreview: sealed.keyPreview,
    ...(sealed.model ? { model: sealed.model } : {}),
  };
  const started = performance.now();
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_DECIDE_PROBE_TIMEOUT_MS);
  try {
    const models = await listJevModels(sealed.connection(), signal, { fetch: opts.fetch });
    return {
      ...base,
      state: 'reachable',
      modelsEndpoint: 'ok',
      models,
      httpStatus: 200,
      latencyMs: Math.round(performance.now() - started),
      ...(sealed.model ? {} : { detail: NO_MODEL_WARNING }),
    };
  } catch (err) {
    const verdict = stateForError(err);
    return {
      ...base,
      ...verdict,
      modelsEndpoint: 'failed',
      latencyMs: Math.round(performance.now() - started),
      detail: err instanceof Error ? err.message : 'probe failed',
    };
  }
}

/** Input for {@link configureDecide}. */
export interface DecideConfigureInput {
  /** Provider base URL. Omitted → the stored URL is kept. */
  readonly baseUrl?: string;
  /** API key. Omitted → the stored key is kept. */
  readonly apiKey?: string;
  /**
   * Default model. Omitted → the stored model is kept when the URL is
   * unchanged; otherwise resolved from the provider's model listing.
   */
  readonly model?: string;
  /** `fetch` for the model lookup; tests inject a stub. */
  readonly fetch?: typeof fetch;
  /** Deadline for the model lookup, ms. */
  readonly timeoutMs?: number;
}

/** Result of {@link configureDecide}. */
export interface DecideConfigureResult extends DecideCredentialsSummary {
  /** Where the stored model came from. */
  readonly modelSource: 'flag' | 'stored' | 'provider-listing' | 'none';
  /** Secret-free warning, e.g. when no model could be resolved. */
  readonly warning?: string;
}

/**
 * Store the provider settings, merging omitted values with the stored ones.
 *
 * The Jev `/v1/systemone` endpoint requires a `model`, and no model literal
 * may be hard-coded in core (arch gate 13). So when no model is given (and
 * none is stored for the same URL), this asks the provider (`GET /v1/models`)
 * and stores the FIRST model it lists — the provider's own ordering; layahost
 * lists its routing default first. When that lookup fails the settings are
 * still stored, without a model, and a warning says how to set one.
 *
 * @param input - URL, key, optional model.
 * @returns Secret-free summary plus the model's provenance.
 * A URL whose host differs from the stored one must come with a fresh key:
 * the stored key is never re-used (or sent in the model probe) for a new host.
 *
 * @throws {DecideCredentialsError} On an invalid URL, blank key, invalid model
 *   name, or a host change without a fresh key.
 */
export async function configureDecide(input: DecideConfigureInput): Promise<DecideConfigureResult> {
  const stored = loadDecideConnection();
  const baseUrl = input.baseUrl?.trim() || stored?.baseUrl || '';
  const freshKey = input.apiKey?.trim();
  if (!freshKey && stored && !sameDecideHost(stored.baseUrl, baseUrl)) {
    throw new DecideCredentialsError(
      'changing the provider host requires a fresh key; pass --key-stdin (the stored key is never sent to a new host)',
    );
  }
  const apiKey = freshKey || stored?.connection().apiKey || '';
  const explicit = input.model?.trim();
  if (explicit) {
    return {
      ...(await saveDecideCredentials({ baseUrl, apiKey, model: explicit })),
      modelSource: 'flag',
    };
  }
  if (stored?.model && stored.baseUrl === baseUrl) {
    const kept = await saveDecideCredentials({ baseUrl, apiKey, model: stored.model });
    return { ...kept, modelSource: 'stored' };
  }
  const saved = await saveDecideCredentials({ baseUrl, apiKey });
  const probe = await probeDecideProvider({
    connection: loadDecideConnection(),
    fetch: input.fetch,
    timeoutMs: input.timeoutMs,
  });
  const first = probe.models?.[0];
  if (!first) {
    const why =
      probe.state === 'reachable' ? 'the provider listed no models' : `probe ${probe.state}`;
    return {
      ...saved,
      modelSource: 'none',
      warning: `No model stored (${why}). ${NO_MODEL_WARNING}`,
    };
  }
  const withModel = await saveDecideCredentials({ baseUrl, apiKey, model: first });
  return { ...withModel, modelSource: 'provider-listing' };
}

/**
 * Remove the stored settings (and rotated backups of them).
 *
 * @returns Whether anything was stored, plus the (now empty) summary.
 */
export async function clearDecideConfig(): Promise<
  DecideCredentialsSummary & { cleared: boolean }
> {
  const cleared = await clearDecideCredentials();
  return { ...describeDecideCredentials(), cleared };
}

/** Input for {@link askDecideDebug}. */
export interface DecideAskInput {
  /** The state to judge. */
  readonly state: string;
  /** The yes/no question (becomes the `noul` criteria). */
  readonly question: string;
  /** Deadline, ms. Default {@link DEFAULT_DECIDE_ASK_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Project root for the audit line. Default: the resolved project root. */
  readonly projectRoot?: string;
}

/** Result of {@link askDecideDebug}. */
export interface DecideAskResult {
  /** The typed answer. */
  readonly answer: DecisionAnswer;
  /** `provider`, `cache` or `fallback`. */
  readonly source: 'provider' | 'cache' | 'fallback';
  /** Why the heuristic answered, when it did. */
  readonly fallbackReason?: string;
  /** End-to-end latency, ms. */
  readonly latencyMs: number;
  /** Provider-reported cost, USD. */
  readonly costUsd?: number;
  /** Provider request id. */
  readonly requestId?: string;
  /** Configured default model, when set. */
  readonly model?: string;
  /** Masked key preview, when configured. */
  readonly keyPreview?: string;
}

/** Neutral heuristic for the debug question: 50/50 with zero confidence. */
const NEUTRAL_NOUL: DecisionAnswer = {
  type: 'noul',
  value: false,
  probability: 0.5,
  confidence: 0,
};

function teeAudit(projectRoot: string | undefined): {
  sink: DecisionAuditSink;
  last: () => DecisionAuditEntry | undefined;
} {
  let last: DecisionAuditEntry | undefined;
  let file: DecisionAuditSink | null = null;
  try {
    file = createJsonlDecisionAudit(projectRoot ?? getProjectRoot());
  } catch {
    file = null;
  }
  return {
    sink: {
      write: (e) => {
        last = e;
        file?.write(e);
      },
    },
    last: () => last,
  };
}

/**
 * Ask one yes/no question through the configured provider (debug surface).
 * Uses no cache, so a repeat is a real round trip. Never throws.
 *
 * @param input - State, question and deadline.
 * @returns The typed answer with source, fallback reason, latency and cost.
 */
export async function askDecideDebug(input: DecideAskInput): Promise<DecideAskResult> {
  const sealed = loadDecideConnection();
  const audit = teeAudit(input.projectRoot);
  const outcome = await decide(
    'cli.decide-ask',
    { state: input.state, questions: { answer: { type: 'noul', criteria: input.question } } },
    () => ({ answer: NEUTRAL_NOUL }),
    {
      connection: sealed?.connection() ?? null,
      cache: null,
      audit: audit.sink,
      timeoutMs: input.timeoutMs ?? DEFAULT_DECIDE_ASK_TIMEOUT_MS,
    },
  );
  const reason = audit.last()?.fallbackReason;
  return {
    answer: outcome.answers['answer'] ?? NEUTRAL_NOUL,
    source: outcome.source,
    ...(reason ? { fallbackReason: reason } : {}),
    latencyMs: Math.round(outcome.latencyMs),
    ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
    ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
    ...(sealed?.model ? { model: sealed.model } : {}),
    ...(sealed ? { keyPreview: sealed.keyPreview } : {}),
  };
}
