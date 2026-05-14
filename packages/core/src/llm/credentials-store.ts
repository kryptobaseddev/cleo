/**
 * Multi-credential pool storage for the CLEO LLM layer (T-LLM-CRED Phase 2).
 *
 * Persists a versioned list of provider credentials at
 * `~/.cleo/llm-credentials.json` (XDG-aware, resolved via `cleoHomeDir()` so
 * the test-only `XDG_DATA_HOME` override applies identically to every CLEO
 * global file).
 *
 * ## Goals
 *
 * - Multiple credentials per provider (label → entry), each with priority,
 *   disabled-flag, expiry, and a free-form `metadata` bag.
 * - Strict 0600 perms on every successful write.
 * - Cross-process locking via `proper-lockfile` reused through `withLock`.
 * - Atomic writes via `writeJsonFileAtomic` (temp → rename + numbered backup).
 * - Synchronous read path so the resolver in `credentials.ts` can call it
 *   from its existing sync function.
 *
 * Design lock-in (per plan):
 *   • `provider` MUST be a valid `ModelTransport`.
 *   • `(provider, label)` is the uniqueness key — `addCredential` upserts.
 *   • `priority` defaults to `max(existing) + 10` so new entries lose to all
 *     existing ones unless an explicit priority is supplied.
 *   • Round-robin picker keeps state in-memory per provider — sufficient for
 *     a single-process orchestrator; durable round-robin is a future change.
 *   • Storage-time auth type widens the wire-time `AuthType` to include
 *     `'aws_sdk'` for forward-compat with Bedrock. `credentials.ts` narrows
 *     `'aws_sdk' → 'api_key'` until Phase 3 widens the on-wire union.
 *
 * Reference: Hermes `credential_pool.py:32-33` defined the on-disk schema
 * we mirror here.
 *
 * @module llm/credentials-store
 * @task T9257
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getLogger } from '../logger.js';
// `withLock` already calls `writeJsonFileAtomic` under the hood — we
// piggy-back on it for atomic writes + numbered backups.
import { withLock } from '../store/file-utils.js';
// Note: `credentials.ts` already depends on `credentials-store.ts`
// (`pickCredentialForProviderSync`). The reverse arrow here closes a
// cycle, but every imported symbol is a function reference read at
// call-time — ESM's late binding makes the cycle safe.
import { clearAnthropicKeyCache, cleoHomeDir } from './credentials.js';
import type { ModelTransport } from './types-config.js';

const logger = getLogger('llm-credentials-store');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Authentication scheme as persisted on disk.
 *
 * Wider than `AuthType` in `credentials.ts` (Phase 1 wire-level): adds
 * `'aws_sdk'` so a Bedrock / Vertex credential can be stored today and the
 * resolver can route it once Phase 3 widens the on-wire `AuthType`.
 *
 * @task T9257
 */
export type StoredAuthType = 'api_key' | 'oauth' | 'aws_sdk';

/**
 * Persisted strategy for `pickCredentialForProvider` when the caller does
 * not pass an explicit `strategy` option.
 *
 * - `priorityWithFallback` — sort by priority asc, pick first eligible.
 *   On callers that surface failures, the next eligible entry can be tried.
 * - `priorityOnly`         — only the top-priority entry is returned; no
 *   fallback list. Useful when a caller wants to fail fast on a known role.
 * - `roundRobin`           — rotate across eligible entries (in-memory
 *   index per provider). Best-effort load distribution.
 *
 * @task T9257
 */
export type CredentialsStoreStrategy = 'priorityWithFallback' | 'roundRobin' | 'priorityOnly';

/**
 * One stored credential entry.
 *
 * `(provider, label)` is unique. `accessToken` MAY be the empty string when
 * `authType === 'aws_sdk'` and the AWS SDK provides auth out-of-band.
 *
 * @task T9257
 */
export interface StoredCredential {
  /** LLM transport this credential is for. */
  provider: ModelTransport;
  /** Human-readable identifier, unique within `provider`. */
  label: string;
  /** Storage-level auth scheme; see `StoredAuthType`. */
  authType: StoredAuthType;
  /** Bearer token / API key. May be `""` for `aws_sdk`. */
  accessToken: string;
  /** Unix epoch ms; entries past this time are excluded by the picker. */
  expiresAt?: number | null;
  /** Lower wins. Defaults to file order on read; `max+10` on add. */
  priority: number;
  /** Free-form provenance label (`claude-code`, `cli-input`, etc.). */
  source?: string;
  /** Optional override for provider base URL. */
  baseUrl?: string | null;
  /** Extra HTTP headers carried alongside the credential. */
  extraHeaders?: Record<string, string>;
  /** Free-form metadata bag (e.g. Bedrock region, account id). */
  metadata?: Record<string, unknown>;
  /**
   * Status of last request through this credential.
   *
   * `'ok'` — healthy; `'exhausted'` — in active cooldown (rate-limited /
   * billing / server error); `'invalid'` — auth rejected and credential
   * should be considered permanently broken until operator rotation.
   *
   * `undefined` means no request has been observed yet.
   *
   * @task T9265
   */
  lastStatus?: 'ok' | 'exhausted' | 'invalid';
  /**
   * Last HTTP error code observed (401, 402, 429, 500, etc.).
   *
   * Set by `CredentialPool.markExhausted`; cleared by `markOk`.
   *
   * @task T9265
   */
  lastErrorCode?: number;
  /**
   * Epoch ms when the active cooldown expires.
   *
   * `undefined` (or a value <= `Date.now()`) means no active cooldown.
   * Set by `CredentialPool.markExhausted`; cleared by `markOk`.
   *
   * @task T9265
   */
  lastErrorResetAt?: number;
  /**
   * Cumulative request count via this credential since pool start.
   *
   * Incremented on every successful `CredentialPool.pick()` call. Used by
   * the `least_used` rotation strategy.
   *
   * @task T9265
   */
  requestCount?: number;
  /** When true, the picker skips this entry entirely. */
  disabled?: boolean;
}

/**
 * S-07 (CWE-256 plaintext storage of dead secret): `refreshToken` is
 * intentionally NOT a field on `StoredCredential` in Phase 2. Phase 1
 * stored a refresh token alongside the access token, but no code ever
 * consumed it — the refresh-flow implementation was deferred. Carrying
 * the dead secret on disk increased blast radius for zero benefit, so
 * the field was removed in security review pass 1.
 *
 * Phase 3 (T9260) will reintroduce `refreshToken` together with the
 * actual refresh implementation that consumes it. Until then the read
 * path tolerates a leftover `refreshToken` key on disk (parser is
 * additive — extra keys are dropped silently by the type narrower) but
 * the writer never re-emits it.
 *
 * @task T9257 — security review S-07
 */

/**
 * On-disk shape of `~/.cleo/llm-credentials.json`.
 *
 * `version` is reserved for forward-compatible migrations.
 *
 * @task T9257
 */
export interface CredentialsStoreData {
  version: 1;
  defaultStrategy: CredentialsStoreStrategy;
  credentials: StoredCredential[];
}

// ---------------------------------------------------------------------------
// Paths + chmod
// ---------------------------------------------------------------------------

/**
 * Absolute path of the credential store file.
 *
 * Resolved through `cleoHomeDir()` so XDG overrides apply uniformly with
 * `credentials.ts`'s global-config tier.
 *
 * @task T9257
 */
export function credentialsStorePath(): string {
  return join(cleoHomeDir(), 'llm-credentials.json');
}

/**
 * Ensure the store file exists with a parseable empty-store body.
 *
 * `withLock` (file-utils) writes a zero-byte file when none exists so
 * `proper-lockfile` can hold the lock. The subsequent `readJsonFile` then
 * throws SyntaxError on the empty content. To avoid that, we pre-seed the
 * file with `{"version":1,"defaultStrategy":"priorityWithFallback",
 * "credentials":[]}` BEFORE acquiring the lock. The pre-seed is itself
 * race-tolerant: `writeFileSync({flag:'wx'})` makes creation idempotent
 * across concurrent callers — only the first one writes; the rest get
 * EEXIST and continue.
 *
 * @task T9257
 */
function ensureFileInitialized(path: string): void {
  if (existsSync(path)) return;
  const dir = dirname(path);
  if (!existsSync(dir)) {
    // 0o700 so other UIDs cannot enumerate the .backups/ subdir contents
    // even though every individual file in it is 0o600.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    // Existing dir created at a looser mode (e.g. 0o755 from an earlier
    // CLEO release): tighten on first write. Best-effort; ignore failures
    // (Windows, mount-points, NFS without chmod support).
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* non-fatal */
    }
  }
  try {
    writeFileSync(path, `${JSON.stringify(emptyStore(), null, 2)}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (err) {
    // EEXIST → another caller already initialized it; OK.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

/**
 * S-02 (CWE-367 TOCTOU rename→chmod): the previous `enforce0600(path)`
 * helper used to chmod the live file AFTER `withLock` released its
 * lock. That left a window in which the temp file (default 0o644)
 * was the live file, no lock held, with secrets in it. The window
 * is now closed at the source: `writeJsonFileAtomic({mode: 0o600})`
 * creates the temp file pre-set to 0o600, so the post-rename file
 * is born 0o600 atomically. No follow-up chmod is needed.
 *
 * Kept here as a doc-only stub so a `git log --grep=enforce0600`
 * search points future readers at this rationale; the function and
 * every call-site are removed below.
 *
 * @task T9257 — security review S-02
 */

/**
 * Warn once when the file is loosely permissioned.
 *
 * Read-side check — we never refuse to read, but we surface the risk via
 * the project logger so an operator can investigate.
 *
 * @task T9257
 */
let _warnedLoosePerms = false;
function checkPermsOnRead(path: string): void {
  if (_warnedLoosePerms) return;
  try {
    const stats = statSync(path);
    const mode = stats.mode & 0o777;
    if (mode !== 0o600 && mode !== 0o000 /* Windows */) {
      logger.warn(
        { path, mode: mode.toString(8) },
        'llm-credentials-store: file perms looser than 0600',
      );
      _warnedLoosePerms = true;
    }
  } catch {
    /* missing file or stat error — caller handles */
  }
}

/** Internal test hook: reset the once-warned latch. */
export function _resetPermsWarningForTests(): void {
  _warnedLoosePerms = false;
}

// ---------------------------------------------------------------------------
// Sync read primitives (used by the resolver in credentials.ts)
// ---------------------------------------------------------------------------

/**
 * Default on-disk shape when no file exists yet.
 */
function emptyStore(): CredentialsStoreData {
  return { version: 1, defaultStrategy: 'priorityWithFallback', credentials: [] };
}

/**
 * Synchronous file read + parse. Never throws.
 *
 * Returns an empty store when the file is missing, unreadable, malformed,
 * or has the wrong `version`.
 *
 * @task T9257
 */
function readStoreSync(): CredentialsStoreData {
  const path = credentialsStorePath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return emptyStore();
  }
  checkPermsOnRead(path);
  if (!raw.trim()) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as Partial<CredentialsStoreData>;
    if (parsed.version !== 1 || !Array.isArray(parsed.credentials)) {
      return emptyStore();
    }
    return {
      version: 1,
      defaultStrategy: parsed.defaultStrategy ?? 'priorityWithFallback',
      credentials: parsed.credentials.filter((c): c is StoredCredential => isStoredCredential(c)),
    };
  } catch {
    return emptyStore();
  }
}

/**
 * Type-narrow check used during read to drop malformed entries silently.
 */
function isStoredCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const provider = v['provider'];
  const label = v['label'];
  const authType = v['authType'];
  const accessToken = v['accessToken'];
  const validProvider =
    provider === 'anthropic' ||
    provider === 'openai' ||
    provider === 'gemini' ||
    provider === 'moonshot';
  const validAuth = authType === 'api_key' || authType === 'oauth' || authType === 'aws_sdk';
  if (!validProvider) return false;
  if (typeof label !== 'string' || !label) return false;
  if (!validAuth) return false;
  if (typeof accessToken !== 'string') return false;
  return true;
}

/**
 * Round-robin cursor map (per provider).
 *
 * In-memory by design: the store is single-process for the orchestrator
 * fleet, and durable round-robin would require an additional write-on-pick
 * which is not worth the cost in Phase 2.
 */
const _rrIndex = new Map<ModelTransport, number>();

/** Internal test hook: reset round-robin cursor state. */
export function _resetRoundRobinForTests(): void {
  _rrIndex.clear();
}

/**
 * Filter `credentials` to `(provider, !disabled, !expired)` and apply
 * `preferLabel` when present.
 *
 * Returns `[]` when nothing eligible remains. Otherwise returns entries
 * sorted by priority ascending (stable for equal priorities).
 *
 * @task T9257
 */
function eligibleForProvider(
  data: CredentialsStoreData,
  provider: ModelTransport,
  preferLabel?: string,
): StoredCredential[] {
  const now = Date.now();
  const all = data.credentials.filter((c) => {
    if (c.provider !== provider) return false;
    if (c.disabled === true) return false;
    if (typeof c.expiresAt === 'number' && c.expiresAt > 0 && c.expiresAt <= now) {
      // S-06 (CWE-454): expired entries used to be silently dropped, which
      // turned an actionable "your token expired" diagnostic into a generic
      // "no credential found" downstream. Log on every skip so an operator
      // can see exactly which (provider, label) needs refreshing.
      logger.info(
        { provider: c.provider, label: c.label, expiresAt: c.expiresAt },
        'cred-file: skipping expired entry',
      );
      return false;
    }
    return true;
  });

  if (preferLabel) {
    const exact = all.find((c) => c.label === preferLabel);
    return exact ? [exact] : [];
  }

  // Stable sort by priority asc — Array.prototype.sort is stable in Node 12+.
  return [...all].sort((a, b) => a.priority - b.priority);
}

/**
 * Synchronous variant of `pickCredentialForProvider`. Called from
 * `credentials.ts`'s sync `resolveCredentials()` tier-3 block. See the
 * async wrapper below for the canonical public API.
 *
 * Strategy resolution falls back to the store's `defaultStrategy` when
 * `opts.strategy` is not provided. Empty / disabled / expired pools yield
 * `null`.
 *
 * @task T9257
 */
export function pickCredentialForProviderSync(
  provider: ModelTransport,
  opts: { strategy?: CredentialsStoreStrategy; preferLabel?: string } = {},
): StoredCredential | null {
  const data = readStoreSync();
  const eligible = eligibleForProvider(data, provider, opts.preferLabel);
  if (eligible.length === 0) return null;

  // preferLabel already collapses to a single entry — pass through.
  if (opts.preferLabel) {
    return eligible[0] ?? null;
  }

  const strategy = opts.strategy ?? data.defaultStrategy ?? 'priorityWithFallback';
  switch (strategy) {
    case 'priorityOnly':
    case 'priorityWithFallback':
      return eligible[0] ?? null;
    case 'roundRobin': {
      const cursor = _rrIndex.get(provider) ?? 0;
      const next = cursor % eligible.length;
      _rrIndex.set(provider, next + 1);
      return eligible[next] ?? null;
    }
    default:
      return eligible[0] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Public async API
// ---------------------------------------------------------------------------

/**
 * List credentials in the pool, optionally filtered to a single provider.
 *
 * Returns `[]` when the file does not exist. Never throws.
 *
 * @task T9257
 */
export async function listCredentials(provider?: ModelTransport): Promise<StoredCredential[]> {
  const data = readStoreSync();
  if (!provider) return [...data.credentials];
  return data.credentials.filter((c) => c.provider === provider);
}

/**
 * Look up a single credential by `(provider, label)`. Returns `null` when
 * no match exists.
 *
 * @task T9257
 */
export async function getCredentialByLabel(
  provider: ModelTransport,
  label: string,
): Promise<StoredCredential | null> {
  const data = readStoreSync();
  return data.credentials.find((c) => c.provider === provider && c.label === label) ?? null;
}

/**
 * Upsert a credential — replaces any existing `(provider, label)` pair.
 *
 * - When `input.priority` is omitted, the new entry receives
 *   `max(existing priorities) + 10` so it ranks lowest by default.
 * - Acquires the file lock via `withLock`; safe under concurrent writers.
 * - chmod 0600 is enforced on the written file.
 *
 * Returns the inserted (or replaced) entry as it now lives in the file.
 *
 * @task T9257
 */
export async function addCredential(
  input: Omit<StoredCredential, 'priority'> & { priority?: number },
): Promise<StoredCredential> {
  const path = credentialsStorePath();
  ensureFileInitialized(path);
  let inserted: StoredCredential | null = null;

  await withLock<CredentialsStoreData>(
    path,
    (current) => {
      const data: CredentialsStoreData = current ?? emptyStore();
      if (data.version !== 1) {
        // Fresh / corrupt — rebuild rather than silently propagate bad version.
        data.version = 1;
        data.credentials = [];
      }
      data.defaultStrategy ??= 'priorityWithFallback';

      const remaining = data.credentials.filter(
        (c) => !(c.provider === input.provider && c.label === input.label),
      );
      const maxPriority = remaining.reduce((m, c) => (c.priority > m ? c.priority : m), -10);
      const priority = typeof input.priority === 'number' ? input.priority : maxPriority + 10;

      const next: StoredCredential = {
        provider: input.provider,
        label: input.label,
        authType: input.authType,
        accessToken: input.accessToken,
        expiresAt: input.expiresAt ?? null,
        priority,
        source: input.source,
        baseUrl: input.baseUrl ?? null,
        extraHeaders: input.extraHeaders,
        metadata: input.metadata,
        lastStatus: input.lastStatus,
        lastErrorCode: input.lastErrorCode,
        lastErrorResetAt: input.lastErrorResetAt,
        requestCount: input.requestCount,
        disabled: input.disabled ?? false,
      };

      data.credentials = [...remaining, next];
      inserted = next;
      return data;
    },
    // SECURITY (S-01/S-02): mode is plumbed all the way through to the
    // temp file + rotated backup writes so the file never touches disk
    // at a looser permission, even momentarily, and historical copies
    // under .backups/ are equally locked down.
    { mode: 0o600 },
  );

  // `inserted` is set inside the transform closure before withLock returns.
  if (!inserted) {
    throw new Error('credentials-store: invariant violation — insert was not recorded');
  }
  // S-10 (CWE-200 stale module-global cache): invalidate the in-process
  // Anthropic-key cache so the next resolveAnthropicApiKey() call picks
  // up the new entry without requiring a CLEO restart.
  clearAnthropicKeyCache();
  return inserted;
}

/**
 * Remove a credential by `(provider, label)`.
 *
 * Returns `true` when a matching entry was found and removed, `false`
 * otherwise. Does NOT create the file when it does not yet exist.
 *
 * @task T9257
 */
export async function removeCredential(provider: ModelTransport, label: string): Promise<boolean> {
  const path = credentialsStorePath();
  // Quick-out: avoid acquiring a lock + creating the file when nothing to do.
  const snapshot = readStoreSync();
  if (!snapshot.credentials.some((c) => c.provider === provider && c.label === label)) {
    return false;
  }
  ensureFileInitialized(path);

  let removed = false;
  await withLock<CredentialsStoreData>(
    path,
    (current) => {
      const data: CredentialsStoreData = current ?? emptyStore();
      if (data.version !== 1 || !Array.isArray(data.credentials)) {
        return emptyStore();
      }
      const before = data.credentials.length;
      data.credentials = data.credentials.filter(
        (c) => !(c.provider === provider && c.label === label),
      );
      removed = data.credentials.length < before;
      data.defaultStrategy ??= 'priorityWithFallback';
      return data;
    },
    // SECURITY (S-01/S-02): see addCredential for rationale.
    { mode: 0o600 },
  );

  // S-10: invalidate the Anthropic-key cache so a removed entry stops
  // being served by the resolver in the same process.
  if (removed) clearAnthropicKeyCache();
  return removed;
}

/**
 * Public async picker — thin wrapper over `pickCredentialForProviderSync`.
 *
 * The sync variant exists because the resolver in `credentials.ts` is
 * synchronous; both paths share the same filter + strategy logic.
 *
 * @task T9257
 */
export async function pickCredentialForProvider(
  provider: ModelTransport,
  opts: { strategy?: CredentialsStoreStrategy; preferLabel?: string } = {},
): Promise<StoredCredential | null> {
  return pickCredentialForProviderSync(provider, opts);
}
