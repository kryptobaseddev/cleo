/**
 * Detected provider capabilities and the last usage read, cached PER PROFILE
 * in `<cleoHome>/decide/provider-state.json` (T12664, T12733). The file maps
 * a state key (the profile id `<provider>/<name>`, or `<baseUrl>#<keyHash>`
 * for a connection without a profile) to that identity's state, so two
 * profiles on the same URL (two layahost accounts) or a benchmark alternating
 * profiles never overwrite each other's detection. The key is never stored:
 * each state carries a truncated sha256 of it ({@link providerKeyHash}) as a
 * guard, so a different key on the same profile or URL (another account or
 * plan, with other capabilities) never reuses the cached state. A file in the
 * pre-T12733 single-state shape is still read (guarded the same way) and is
 * replaced by the map on the next write.
 *
 * Detection (`detectJevCapabilities`) calls `GET /v1/usage` and
 * `GET /v1/templates`, both of which count toward the provider's rate limit,
 * so {@link refreshProviderState} re-detects at most once every
 * {@link USAGE_REFRESH_MS} per provider identity: a failed detection is
 * written too (keeping the previous capabilities on a transient failure; with
 * nothing cached, a transient failure is not written and is retried after
 * {@link TRANSIENT_DETECTION_RETRY_MS}), and an in-process attempt memo covers
 * an unwritable state file. The client
 * reads the file (memoised per process) to know which extensions the
 * configured provider supports; with no file, or a file for another base URL
 * or key, the provider is treated as the Jev minimum.
 *
 * Who detects (T12715): `cleo decide config` (forced), `cleo decide status`,
 * and — lazily, on first use — `decideBatch`, whose 30 s deadline is not
 * latency-critical. A single 300 ms `decide()` NEVER detects: it neither
 * waits for detection nor starts one in the background, because a pending
 * detection request would keep a one-shot CLI process alive past its work
 * (the CLI's success path relies on the event loop draining, T12492). A single
 * decision therefore uses the Jev minimum until one of the paths above has
 * written the state; the minimum only omits the optional `lang`/`cache` body
 * fields, so the answer itself is unaffected.
 *
 * @task T12664
 * @task T12733
 * @epic T12486
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DecisionProviderCapabilities, DecisionProviderUsage } from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import { detectJevCapabilities, TRANSIENT_DETECTION_ERRORS } from './jev-wire.js';
import type { DecideFetch } from './transport.js';

/** Minimum interval between usage/capability refreshes: 10 minutes. */
export const USAGE_REFRESH_MS = 10 * 60 * 1000;

/** How long the client trusts its in-process copy of the file. */
const MEMO_MS = 60_000;

/** Hex characters of the key's sha256 kept in the state (64 bits). */
const KEY_HASH_CHARS = 16;

/** The provider identity a cached state belongs to. */
export interface ProviderStateIdentity {
  /** Provider base URL. */
  readonly baseUrl: string;
  /** API key; only its truncated hash is ever compared or stored. */
  readonly apiKey: string;
  /** Profile id (`<provider>/<name>`, T12733); keys the state when present. */
  readonly profile?: string;
}

/**
 * Non-reversible short identifier of an API key: the first
 * {@link KEY_HASH_CHARS} hex characters of its sha256. Enough to tell keys
 * apart in the state file; useless for recovering the key.
 *
 * @param apiKey - The API key.
 * @returns Truncated hex sha256.
 */
export function providerKeyHash(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, KEY_HASH_CHARS);
}

/** One cached provider state. */
export interface ProviderState {
  /** Base URL the state was detected for. */
  readonly baseUrl: string;
  /** {@link providerKeyHash} of the API key the state was detected with. */
  readonly keyHash: string;
  /** Epoch ms of the detection. */
  readonly detectedAt: number;
  /** Detected capabilities. */
  readonly capabilities: DecisionProviderCapabilities;
  /** Usage read at detection time, when the provider has a usage endpoint. */
  readonly usage?: DecisionProviderUsage;
}

/**
 * Default location: `<cleoHome>/decide/provider-state.json`.
 *
 * @returns Absolute path.
 */
export function defaultProviderStatePath(): string {
  return join(getCleoHome(), 'decide', 'provider-state.json');
}

/**
 * The key a state is filed under: the profile id, or `<baseUrl>#<keyHash>`
 * for a connection without one.
 *
 * @param identity - Base URL, key and optional profile.
 * @returns The state key.
 */
export function providerStateKey(identity: ProviderStateIdentity): string {
  return identity.profile ?? `${identity.baseUrl}#${providerKeyHash(identity.apiKey)}`;
}

/** Structural check of a parsed state; anything else is ignored. */
function isProviderState(value: unknown): value is ProviderState {
  if (value === null || typeof value !== 'object') return false;
  const baseUrl: unknown = Reflect.get(value, 'baseUrl');
  const keyHash: unknown = Reflect.get(value, 'keyHash');
  const detectedAt: unknown = Reflect.get(value, 'detectedAt');
  const capabilities: unknown = Reflect.get(value, 'capabilities');
  return (
    typeof baseUrl === 'string' &&
    typeof keyHash === 'string' &&
    typeof detectedAt === 'number' &&
    capabilities !== null &&
    typeof capabilities === 'object' &&
    typeof Reflect.get(capabilities, 'wire') === 'string' &&
    typeof Reflect.get(capabilities, 'maxQuestionsPerRequest') === 'number' &&
    typeof Reflect.get(capabilities, 'maxStateChars') === 'number'
  );
}

/**
 * Read the cached state for a provider URL and key.
 *
 * @param identity - The configured base URL and API key.
 * @param path - State file. Default {@link defaultProviderStatePath}.
 * @returns The state, or `null` when absent, unreadable, or for another URL
 *   or key (a state written before keys were recorded counts as another key).
 */
export function readProviderState(
  identity: ProviderStateIdentity,
  path = defaultProviderStatePath(),
): ProviderState | null {
  const file = readStateFile(path);
  const candidate = file.states[providerStateKey(identity)] ?? file.legacy;
  return candidate &&
    candidate.baseUrl === identity.baseUrl &&
    candidate.keyHash === providerKeyHash(identity.apiKey)
    ? candidate
    : null;
}

/** The state file: states keyed by {@link providerStateKey}, plus a pre-T12733 single state. */
interface ProviderStateFile {
  readonly states: Readonly<Record<string, ProviderState>>;
  readonly legacy?: ProviderState;
}

/** Read the state file. Never throws; anything unreadable is empty. */
function readStateFile(path: string): ProviderStateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { states: {} };
  }
  if (isProviderState(parsed)) return { states: {}, legacy: parsed };
  const raw: unknown =
    parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'states') : undefined;
  const states: Record<string, ProviderState> = {};
  if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (isProviderState(value)) states[key] = value;
    }
  }
  return { states };
}

/**
 * Write one identity's cached state (atomic rename), keeping every other
 * identity's state. Never throws.
 *
 * @param state - State to store.
 * @param path - State file. Default {@link defaultProviderStatePath}.
 * @param key - State key ({@link providerStateKey}). Default: `<baseUrl>#<keyHash>`.
 */
export function writeProviderState(
  state: ProviderState,
  path = defaultProviderStatePath(),
  key = `${state.baseUrl}#${state.keyHash}`,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    const states = { ...readStateFile(path).states, [key]: state };
    writeFileSync(tmp, JSON.stringify({ states }), 'utf-8');
    renameSync(tmp, path);
    memo = null;
  } catch {
    /* best effort: the next status run detects again */
  }
}

let memo: {
  readonly stateKey: string;
  readonly keyHash: string;
  readonly baseUrl: string;
  readonly at: number;
  readonly caps: DecisionProviderCapabilities | null;
} | null = null;

/**
 * Capabilities the client may use for a provider URL and key, memoised per
 * process for a minute so the hot path does not read the file on every
 * decision.
 *
 * @param identity - The configured base URL and API key.
 * @param now - Clock, epoch ms.
 * @param path - State file. Default {@link defaultProviderStatePath}.
 * @returns Detected capabilities, or `null` (→ the Jev minimum).
 */
export function cachedCapabilities(
  identity: ProviderStateIdentity,
  now: number = Date.now(),
  path = defaultProviderStatePath(),
): DecisionProviderCapabilities | null {
  const keyHash = providerKeyHash(identity.apiKey);
  const stateKey = providerStateKey(identity);
  if (
    memo &&
    memo.stateKey === stateKey &&
    memo.baseUrl === identity.baseUrl &&
    memo.keyHash === keyHash &&
    now - memo.at < MEMO_MS
  ) {
    return memo.caps;
  }
  const caps = readProviderState(identity, path)?.capabilities ?? null;
  memo = { stateKey, baseUrl: identity.baseUrl, keyHash, at: now, caps };
  return caps;
}

/**
 * Retry interval after a transient detection failure with nothing cached
 * (T12715): the result is not written (it would pin a partial or failed
 * detection for {@link USAGE_REFRESH_MS}), so only this in-process wait
 * spaces out the retries.
 */
export const TRANSIENT_DETECTION_RETRY_MS = 30_000;

/** Epoch ms before which this process does not re-detect, per identity. */
const retryAt = new Map<string, number>();

/** Options for {@link refreshProviderState}. */
export interface RefreshProviderStateOptions {
  /** Transport for the detection probes; tests inject a stub. */
  readonly fetch?: DecideFetch;
  /** Wall clock, epoch ms. Default `Date.now`. */
  readonly now?: () => number;
  /** State file. Default {@link defaultProviderStatePath}. */
  readonly path?: string;
  /** Detect even when the cached state is fresh (after a settings change). */
  readonly force?: boolean;
}

/**
 * Return the cached provider state, re-detecting it first when it is absent
 * or older than {@link USAGE_REFRESH_MS} (or when `force` is set).
 *
 * At most one detection runs per identity per {@link USAGE_REFRESH_MS}: the
 * result is written even when detection failed, and a per-process attempt
 * memo stops a retry loop when the file cannot be written. A transient
 * failure (network, timeout, 5xx, 429 — of either probe) keeps the previous
 * capabilities and usage instead of downgrading them. With nothing cached, a
 * transient failure is NOT written: its result serves this process (via the
 * in-process memo) and detection is retried after
 * {@link TRANSIENT_DETECTION_RETRY_MS}. Never throws.
 *
 * @param connection - Base URL and API key of the configured provider.
 * @param signal - Aborts the detection probes.
 * @param opts - Transport, clock, state path, force.
 * @returns The fresh or cached state, or `null` when detection was skipped
 *   (attempted recently in this process) and nothing is cached.
 */
export async function refreshProviderState(
  connection: ProviderStateIdentity,
  signal: AbortSignal,
  opts: RefreshProviderStateOptions = {},
): Promise<ProviderState | null> {
  const now = opts.now ?? Date.now;
  const cached = readProviderState(connection, opts.path);
  if (opts.force !== true && cached && now() - cached.detectedAt < USAGE_REFRESH_MS) {
    return cached;
  }
  const keyHash = providerKeyHash(connection.apiKey);
  const stateKey = providerStateKey(connection);
  const attemptKey = `${stateKey}\u0000${connection.baseUrl}\u0000${keyHash}`;
  const notBefore = retryAt.get(attemptKey);
  if (opts.force !== true && notBefore !== undefined && now() < notBefore) {
    return cached;
  }
  retryAt.set(attemptKey, now() + USAGE_REFRESH_MS);
  const detected = await detectJevCapabilities(connection, signal, {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const transient =
    detected.error !== undefined && TRANSIENT_DETECTION_ERRORS.has(detected.error.kind);
  if (transient && !cached) {
    // Nothing to keep, and a failed or partial detection (e.g. /v1/usage
    // answered but /v1/templates timed out) is not "capability absent": do not
    // write it for 10 minutes. Use it in this process only, and retry soon.
    retryAt.set(attemptKey, now() + TRANSIENT_DETECTION_RETRY_MS);
    memo = {
      stateKey,
      baseUrl: connection.baseUrl,
      keyHash,
      at: now(),
      caps: detected.capabilities,
    };
    return {
      baseUrl: connection.baseUrl,
      keyHash,
      detectedAt: now(),
      capabilities: detected.capabilities,
      ...(detected.usage ? { usage: detected.usage } : {}),
    };
  }
  const kept = transient ? cached : undefined;
  const state: ProviderState = {
    baseUrl: connection.baseUrl,
    keyHash,
    detectedAt: now(),
    capabilities: kept?.capabilities ?? detected.capabilities,
    ...(detected.usage ? { usage: detected.usage } : kept?.usage ? { usage: kept.usage } : {}),
  };
  writeProviderState(state, opts.path, stateKey);
  return state;
}

/**
 * Clear the in-process memo and detection-attempt memo. Tests only.
 *
 * @internal
 */
export function _resetProviderStateMemoForTest(): void {
  memo = null;
  retryAt.clear();
}
