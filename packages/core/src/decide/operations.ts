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

import {
  DECIDE_DEFAULT_PROFILE_NAME,
  DECIDE_PROFILE_DEFAULT_URL,
  type DecideProfileListResult,
  type DecideProfileProbe,
  type DecideProfileSummary,
  type DecideProviderState as DecideProviderStateContract,
  type DecisionAnswer,
  type DecisionProviderCapabilities,
  type DecisionProviderKind,
  type DecisionProviderUsage,
  JEV_MINIMUM_CAPABILITIES,
} from '@cleocode/contracts';
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
  type DecideProfileRef,
  decideProfileId,
  describeDecideCredentials,
  describeDecideProfile,
  isValidDecideProfileName,
  listDecideProfiles,
  loadDecideConnection,
  loadDecideProfile,
  parseDecideProfileRef,
  type SealedDecideConnection,
  sameDecideHost,
  saveDecideCredentials,
} from './credentials.js';
import { listJevModels } from './jev-wire.js';
import { DecisionProviderError } from './provider.js';
import { refreshProviderState } from './provider-state.js';
import {
  DECISION_PROVIDER_PRESETS,
  inferDecisionProviderKind,
  presetBaseUrl,
} from './providers.js';
import { DECIDE_ASK_DECISION_SITE, DECISION_SITES } from './sites/registry.js';
import {
  createFileSpendLedger,
  DEFAULT_MONTHLY_SPEND_CAP_MICROS,
  inspectSpendLedger,
  MONTHLY_SPEND_CAP_KEY,
  resetSpendLedger,
  type SpendLedger,
  type SpendLedgerHealth,
  type SpendResetOptions,
  type SpendResetReceipt,
} from './spend.js';

/** Default deadline for the `GET /v1/models` probe, ms. */
export const DEFAULT_DECIDE_PROBE_TIMEOUT_MS = 3_000;

/** Default deadline for `cleo decide ask`, ms (generous: it is a debug tool). */
export const DEFAULT_DECIDE_ASK_TIMEOUT_MS = 10_000;

/**
 * Reachability of the configured provider.
 *
 * - `reachable`    — `GET /v1/models` answered 2xx.
 * - `unauthorized` — the provider rejected the key (401, or a 403 that is not a key limit).
 * - `key_limit_reached` — the key's monthly decision limit is reached (403
 *   `key_limit_exceeded`); decisions resume when the UTC month rolls over.
 * - `unconfigured` — no valid base URL + key stored.
 * - `unreachable`  — network failure, timeout, or any other HTTP status.
 */
export type DecideProviderState = DecideProviderStateContract;

/** Month-to-date spend against the CLEO cap (D11159). */
export interface DecideSpendSummary {
  /** UTC month, `YYYY-MM`. */
  readonly month: string;
  /** Micro-dollars recorded this month. */
  readonly spentMicros: number;
  /** Micro-dollars reserved by calls in flight. */
  readonly reservedMicros: number;
  /** The cap, micro-dollars (`decide.budget.monthlyMicros`). */
  readonly capMicros: number;
  /** Whether sites are degraded to their heuristics because the cap is reached. */
  readonly capReached: boolean;
  /** ISO time until which the key's monthly limit stops decisions, when set. */
  readonly keyLimitedUntil?: string;
}

/** Result of {@link probeDecideProvider}. */
export interface DecideProbeResult {
  /** Reachability verdict. */
  readonly state: DecideProviderState;
  /** Profile id probed (`<provider>/<name>`, T12733), when known. */
  readonly profile?: string;
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
  /** Registered decision sites (T12662). */
  readonly sites: number;
  /** What the provider supports beyond the Jev minimum (T12664). */
  readonly capabilities?: DecisionProviderCapabilities;
  /** Last usage/balance read (refreshed at most every 10 minutes). */
  readonly usage?: DecisionProviderUsage & { readonly fetchedAt: string };
  /** Month-to-date spend against the cap. */
  readonly spend?: DecideSpendSummary;
  /** Spend-ledger health; `corrupt` or `unavailable` means every site falls back. */
  readonly spendLedger?: SpendLedgerHealth;
}

/** Options for {@link probeDecideProvider}. */
export interface DecideProbeOptions {
  /** Connection to probe. Default: the stored connection. */
  readonly connection?: SealedDecideConnection | null;
  /** `fetch` implementation; tests inject a stub. */
  readonly fetch?: typeof fetch;
  /** Deadline, ms. Default {@link DEFAULT_DECIDE_PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Spend ledger; `null` omits spend. Default: the machine-wide ledger. */
  readonly spend?: SpendLedger | null;
  /** Monthly cap, micro-dollars. Default: `decide.budget.monthlyMicros`, else $1. */
  readonly capMicros?: number;
  /** Spend-ledger path to inspect. Default: `<cleoHome>/decide/spend.json`. */
  readonly spendStatePath?: string;
  /** Provider-state file (capabilities + usage cache). Default: `<cleoHome>/decide/provider-state.json`. */
  readonly providerStatePath?: string;
  /** Wall clock, epoch ms. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * Re-detect capabilities even when the cached read is fresh. Set after the
   * settings change so the provider's extensions apply immediately (T12713).
   */
  readonly refreshCapabilities?: boolean;
}

const KEY_LIMIT_DETAIL =
  "The key's monthly decision limit is reached (403 key_limit_exceeded). The key itself is fine: decisions resume when the UTC month rolls over, or raise the limit in the provider console.";

/** Message naming the repair for a ledger that cannot be read. */
export const SPEND_LEDGER_REPAIR_HINT =
  'The System One spend ledger cannot be read, so every site uses its heuristic (the cap fails closed). Run `cleo decide budget reset` to start a fresh ledger; the old file is kept as a receipt.';

/** `{ detail }` when there is one, else nothing. */
function optionalDetail(detail: string | undefined): { detail?: string } {
  return detail ? { detail } : {};
}

/** Month-to-date spend, or undefined when the ledger is disabled or unreadable. */
async function spendSummary(opts: DecideProbeOptions): Promise<DecideSpendSummary | undefined> {
  const ledger = opts.spend === undefined ? createFileSpendLedger() : opts.spend;
  if (!ledger) return undefined;
  const status = await ledger.status();
  if (!status) return undefined;
  let capMicros = opts.capMicros;
  if (capMicros === undefined) {
    try {
      const { getConfigValue } = await import('../config/registry.js');
      const value: unknown = await getConfigValue(MONTHLY_SPEND_CAP_KEY, {
        projectRoot: getProjectRoot(),
      });
      capMicros =
        typeof value === 'number' && value >= 0 ? value : DEFAULT_MONTHLY_SPEND_CAP_MICROS;
    } catch {
      capMicros = DEFAULT_MONTHLY_SPEND_CAP_MICROS;
    }
  }
  return {
    month: status.month,
    spentMicros: status.spentMicros,
    reservedMicros: status.reservedMicros,
    capMicros,
    capReached: status.spentMicros >= capMicros,
    ...(status.keyLimitedUntil !== undefined
      ? { keyLimitedUntil: new Date(status.keyLimitedUntil).toISOString() }
      : {}),
  };
}

const NO_MODEL_WARNING =
  'No default model is configured. The Jev /v1/systemone endpoint requires a model; set one with `cleo decide config --model <name>` (see `models`).';

function stateForError(err: unknown): { state: DecideProviderState; httpStatus?: number } {
  if (err instanceof DecisionProviderError) {
    if (err.kind === 'unauthorized') return { state: 'unauthorized', httpStatus: err.status };
    if (err.kind === 'key_limit_exceeded') {
      return { state: 'key_limit_reached', httpStatus: err.status };
    }
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
  const sites = DECISION_SITES.length;
  const sealed = opts.connection === undefined ? loadDecideConnection() : opts.connection;
  const spend = await spendSummary(opts);
  const spendLedger = opts.spend === null ? undefined : inspectSpendLedger(opts.spendStatePath);
  const ledgerBroken = spendLedger === 'corrupt' || spendLedger === 'unavailable';
  const withHint = (detail: string | undefined): string | undefined =>
    ledgerBroken ? [detail, SPEND_LEDGER_REPAIR_HINT].filter(Boolean).join(' ') : detail;
  if (!sealed) {
    return {
      state: 'unconfigured',
      modelsEndpoint: 'skipped',
      detail: withHint('Run `cleo decide config`.'),
      sites,
      ...(spend ? { spend } : {}),
      ...(spendLedger ? { spendLedger } : {}),
    };
  }
  const base = {
    ...(sealed.profile ? { profile: sealed.profile } : {}),
    baseUrl: sealed.baseUrl,
    keyPreview: sealed.keyPreview,
    ...(sealed.model ? { model: sealed.model } : {}),
    sites,
    ...(spend ? { spend } : {}),
    ...(spendLedger ? { spendLedger } : {}),
  };
  const now = opts.now ?? Date.now;
  const started = performance.now();
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_DECIDE_PROBE_TIMEOUT_MS);

  // Capabilities + usage: reuse the cached read unless it is older than 10 minutes.
  // Shared with decideBatch's lazy detection: at most one detection per
  // identity per USAGE_REFRESH_MS, transient failures keep the old state.
  const state = await refreshProviderState(sealed.connection(), signal, {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    now,
    ...(opts.providerStatePath !== undefined ? { path: opts.providerStatePath } : {}),
    force: opts.refreshCapabilities === true,
  });
  const extras = {
    capabilities: state?.capabilities ?? JEV_MINIMUM_CAPABILITIES,
    ...(state?.usage
      ? { usage: { ...state.usage, fetchedAt: new Date(state.detectedAt).toISOString() } }
      : {}),
  };

  try {
    const models = await listJevModels(sealed.connection(), signal, { fetch: opts.fetch });
    const keyLimited = spend?.keyLimitedUntil !== undefined;
    return {
      ...base,
      ...extras,
      state: keyLimited ? 'key_limit_reached' : 'reachable',
      modelsEndpoint: 'ok',
      models,
      httpStatus: 200,
      latencyMs: Math.round(performance.now() - started),
      ...optionalDetail(
        withHint(keyLimited ? KEY_LIMIT_DETAIL : sealed.model ? undefined : NO_MODEL_WARNING),
      ),
    };
  } catch (err) {
    const verdict = stateForError(err);
    return {
      ...base,
      ...extras,
      ...verdict,
      modelsEndpoint: 'failed',
      latencyMs: Math.round(performance.now() - started),
      ...optionalDetail(
        withHint(
          verdict.state === 'key_limit_reached'
            ? KEY_LIMIT_DETAIL
            : err instanceof Error
              ? err.message
              : 'probe failed',
        ),
      ),
    };
  }
}

/** Input for {@link configureDecide}. */
export interface DecideConfigureInput {
  /**
   * Provider kind. Omitted → the provider of a `<provider>/<name>` profile,
   * else inferred from an override `baseUrl` (the layahost origin →
   * `layahost`, any other → `jev`), else the active profile's provider, else
   * `layahost`.
   */
  readonly provider?: DecisionProviderKind;
  /**
   * `default` (the provider's preset URL, resolved at call time) or an
   * override URL. Omitted → the profile's stored setting, else `default`.
   */
  readonly baseUrl?: string;
  /** API key. Omitted → the profile's stored key is kept. */
  readonly apiKey?: string;
  /**
   * Profile to add or update (T12733): `<provider>/<name>` or a bare name;
   * other profiles are kept. Omitted → the active profile when it has the
   * same provider, else `<provider>/default`.
   */
  readonly profile?: string;
  /**
   * Make the profile active. Omitted → true for the first profile or one that
   * is already active, else false (adding a second key never silently
   * switches everyday decisions).
   */
  readonly activate?: boolean;
  /**
   * Default model. Omitted → the stored model when the URL is unchanged;
   * otherwise the preset default (`layahost`), else the first model the
   * provider lists (`jev`).
   */
  readonly model?: string;
  /** `fetch` for the model lookup and the post-save probe; tests inject a stub. */
  readonly fetch?: typeof fetch;
  /** Deadline for the model lookup and the probe, ms. */
  readonly timeoutMs?: number;
}

/** Result of {@link configureDecide}. */
export interface DecideConfigureResult extends DecideCredentialsSummary {
  /** Whether the configured profile is now the active one. */
  readonly active: boolean;
  /** Where the stored model came from. */
  readonly modelSource: 'flag' | 'stored' | 'preset' | 'provider-listing' | 'none';
  /** Reachability verdict of the probe run after saving. */
  readonly providerState: DecideProviderState;
  /** Capabilities detected after saving (the provider's extensions are active from now on). */
  readonly capabilities?: DecisionProviderCapabilities;
  /** Secret-free warning, e.g. when no model could be resolved. */
  readonly warning?: string;
}

/** The profile {@link configureDecide} writes. */
function configureTarget(input: DecideConfigureInput): DecideProfileRef {
  const raw = input.profile?.trim();
  if (raw?.includes('/')) {
    const ref = parseDecideProfileRef(raw);
    if (!ref) {
      throw new DecideCredentialsError(
        `invalid profile '${raw}' (use <provider>/<name>, e.g. layahost/work)`,
      );
    }
    if (input.provider && input.provider !== ref.provider) {
      throw new DecideCredentialsError(
        `profile '${ref.id}' belongs to ${ref.provider}, not ${input.provider}`,
      );
    }
    return ref;
  }
  const active = listDecideProfiles().active;
  const activeRef = active ? parseDecideProfileRef(active) : null;
  const url = input.baseUrl?.trim();
  const provider =
    input.provider ??
    (url && url !== DECIDE_PROFILE_DEFAULT_URL
      ? inferDecisionProviderKind(url)
      : (activeRef?.provider ?? 'layahost'));
  const name =
    raw || (activeRef?.provider === provider ? activeRef.name : DECIDE_DEFAULT_PROFILE_NAME);
  if (!isValidDecideProfileName(name)) {
    throw new DecideCredentialsError(
      `invalid profile name '${name}' (use 1-32 lowercase letters, digits or -, starting and ending with a letter or digit)`,
    );
  }
  return { provider, name, id: decideProfileId(provider, name) };
}

/**
 * Store a profile's settings, merging omitted values with the stored ones,
 * then probe the provider and re-detect its capabilities so its extensions
 * apply immediately.
 *
 * A model is always stored when one can be known, because the Jev
 * `/v1/systemone` endpoint rejects a request without one (422, and every
 * site silently falls back). The model comes from, in order: the flag; the
 * stored model (same URL); the provider preset (`layahost` →
 * `LAYAHOST_DEFAULT_MODEL`); the first model the provider lists. Only a
 * `jev` provider whose listing fails can end with no model, and then a
 * warning says how to set one.
 *
 * A URL whose host differs from the stored one must come with a fresh key:
 * the stored key is never re-used (or sent in the model probe) for a new host.
 *
 * Profiles (T12733): the settings go to one profile, `<provider>/<name>`
 * (see {@link DecideConfigureInput.profile}); every other profile is kept,
 * and a new profile needs its own key. The URL is stored as `default` unless
 * overridden. The post-save probe targets that profile, active or not.
 *
 * @param input - Provider, URL, key, optional model, profile and activation.
 * @returns Secret-free summary plus the model's provenance and the probe verdict.
 * @throws {DecideCredentialsError} On an invalid URL or profile, a provider
 *   without a preset URL and no override, a blank key, an invalid model name,
 *   a new profile without a key, or a host change without a fresh key.
 */
export async function configureDecide(input: DecideConfigureInput): Promise<DecideConfigureResult> {
  const target = configureTarget(input);
  const stored = loadDecideProfile(target.id);
  const storedSetting =
    stored && describeDecideProfile(target.id).urlSource === 'override'
      ? stored.baseUrl
      : DECIDE_PROFILE_DEFAULT_URL;
  const urlSetting = input.baseUrl?.trim() || storedSetting;
  const baseUrl =
    urlSetting === DECIDE_PROFILE_DEFAULT_URL ? presetBaseUrl(target.provider) : urlSetting;
  if (!baseUrl) {
    throw new DecideCredentialsError(
      `the ${target.provider} provider has no default URL: pass --url https://your-provider.example (https, or http only for localhost)`,
    );
  }
  const freshKey = input.apiKey?.trim();
  if (!freshKey && !stored) {
    throw new DecideCredentialsError(
      `profile '${target.id}' has no stored key; pass --key-stdin (keys are never copied between profiles)`,
    );
  }
  if (!freshKey && stored && !sameDecideHost(stored.baseUrl, baseUrl)) {
    throw new DecideCredentialsError(
      'changing the provider host requires a fresh key; pass --key-stdin (the stored key is never sent to a new host)',
    );
  }
  const apiKey = freshKey || stored?.connection().apiKey || '';
  const preset = DECISION_PROVIDER_PRESETS[target.provider];
  const explicit = input.model?.trim();
  let model: string | undefined;
  let modelSource: DecideConfigureResult['modelSource'] = 'none';
  if (explicit) {
    model = explicit;
    modelSource = 'flag';
  } else if (stored?.model && stored.baseUrl === baseUrl) {
    model = stored.model;
    modelSource = 'stored';
  } else if (preset.defaultModel) {
    model = preset.defaultModel;
    modelSource = 'preset';
  }

  const settings = {
    provider: target.provider,
    profile: target.id,
    baseUrl: urlSetting,
    apiKey,
  };
  const saved = await saveDecideCredentials({
    ...settings,
    ...(model ? { model } : {}),
    ...(input.activate !== undefined ? { activate: input.activate } : {}),
  });
  const probe = await probeDecideProvider({
    connection: loadDecideProfile(target.id),
    fetch: input.fetch,
    timeoutMs: input.timeoutMs,
    refreshCapabilities: true,
  });
  const verdict = {
    active: saved.activeProfile === target.id,
    providerState: probe.state,
    ...(probe.capabilities ? { capabilities: probe.capabilities } : {}),
  };
  if (model) return { ...saved, modelSource, ...verdict };

  const first = probe.models?.[0];
  if (!first) {
    const why =
      probe.state === 'reachable' ? 'the provider listed no models' : `probe ${probe.state}`;
    return {
      ...saved,
      modelSource: 'none',
      ...verdict,
      warning: `No model stored (${why}). ${NO_MODEL_WARNING}`,
    };
  }
  const withModel = await saveDecideCredentials({
    ...settings,
    model: first,
    activate: verdict.active,
  });
  return { ...withModel, modelSource: 'provider-listing', ...verdict };
}

/** Options for {@link listDecideProfilesReport}. */
export interface DecideProfilesReportOptions {
  /** Probe each profile's `GET /v1/models`. Default false (no network). */
  readonly probe?: boolean;
  /** `fetch` for the probes; tests inject a stub. */
  readonly fetch?: typeof fetch;
  /** Deadline per probe, ms. Default {@link DEFAULT_DECIDE_PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Provider-state file for the probes. Default: `<cleoHome>/decide/provider-state.json`. */
  readonly providerStatePath?: string;
}

/**
 * `cleo decide profiles`: every stored profile with the active one marked and
 * keys masked; with `probe`, each profile's reachability (probed in parallel).
 * Never throws.
 *
 * @param opts - Whether to probe, plus the injectable `fetch` and deadline.
 * @returns The secret-free profile list.
 */
export async function listDecideProfilesReport(
  opts: DecideProfilesReportOptions = {},
): Promise<DecideProfileListResult> {
  const list = listDecideProfiles();
  if (opts.probe !== true) return list;
  const profiles = await Promise.all(
    list.profiles.map(async (summary): Promise<DecideProfileSummary> => {
      const result = await probeDecideProvider({
        connection: loadDecideProfile(summary.id),
        spend: null,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.providerStatePath !== undefined
          ? { providerStatePath: opts.providerStatePath }
          : {}),
      });
      const probe: DecideProfileProbe = {
        state: result.state,
        ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
        ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
      };
      return { ...summary, probe };
    }),
  );
  return { ...list, profiles };
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
  /** Profile to ask through (T12733), `<provider>/<name>`. Default: the active profile. */
  readonly profile?: string;
}

/** Result of {@link askDecideDebug}. */
export interface DecideAskResult {
  /** The yes/no question that was asked (so a human render can show it). */
  readonly question?: string;
  /** The state that was judged (echoed for the human render). */
  readonly state?: string;
  /** Id of the profile asked through, when one was configured (T12733). */
  readonly profile?: string;
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
  const sealed = input.profile ? loadDecideProfile(input.profile) : loadDecideConnection();
  const profile = input.profile
    ? parseDecideProfileRef(input.profile)?.id
    : (listDecideProfiles().active ?? undefined);
  const audit = teeAudit(input.projectRoot);
  const outcome = await decide(
    DECIDE_ASK_DECISION_SITE.id,
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
    question: input.question,
    state: input.state,
    ...(sealed && profile ? { profile } : {}),
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

/**
 * `cleo decide budget reset`: start a fresh spend ledger for this month,
 * moving the old file aside as a receipt. The repair for a corrupt ledger,
 * which otherwise keeps every site on its heuristic. A readable ledger is
 * refused unless `opts.force`, and its month-to-date spend is carried over,
 * so a reset never lifts a reached cap.
 *
 * @param statePath - Ledger path. Default: `<cleoHome>/decide/spend.json`.
 * @param opts - `force` resets a ledger that is not corrupt.
 * @returns The receipt: previous health, carried spend and where the old file went.
 * @throws {SpendResetRefusedError} When the ledger is not corrupt and `force` is not set.
 */
export async function resetDecideBudget(
  statePath?: string,
  opts: SpendResetOptions = {},
): Promise<SpendResetReceipt> {
  return resetSpendLedger(statePath, Date.now(), opts);
}
