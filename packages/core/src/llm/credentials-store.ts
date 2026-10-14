/**
 * Multi-credential pool storage for the CLEO LLM layer (T-LLM-CRED Phase 2).
 *
 * The pool lives in the global `accounts` table (T13715), written through
 * the encrypting accessor `store/llm-accounts-accessor.ts`: secrets are
 * stored under the machine key and the pool syncs on the home stream.
 *
 * `~/.cleo/llm-credentials.json` (resolved via `getCleoHome()`) is a LEGACY
 * source only: {@link migrateLegacyCredentialsFile} moves its entries into
 * `accounts` once, idempotently, and removes the plaintext file after reading
 * every entry back. Until then the sync reader also serves the file's entries
 * that `accounts` lacks, so resolution stays correct mid-migration.
 *
 * ## Goals
 *
 * - Multiple credentials per provider (label → entry), each with priority,
 *   disabled-flag, expiry, and a free-form `metadata` bag.
 * - Secrets encrypted at rest; never written in plaintext (T13715).
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

import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
// Note: `credentials.ts` already depends on `credentials-store.ts`
// (`pickCredentialForProviderSync`). The reverse arrow here closes a
// cycle, but every imported symbol is a function reference read at
// call-time — ESM's late binding makes the cycle safe.
import { getCleoHome } from '@cleocode/paths';
import { getLogger } from '../logger.js';
import {
  deleteLlmAccount,
  listLlmAccountRowsSync,
  llmAccountToCredentialSync,
  upsertLlmAccount,
} from '../store/llm-accounts-accessor.js';
import { clearAnthropicKeyCache } from './credentials.js';
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
  /**
   * OAuth refresh token.
   *
   * Stored alongside the access token when an OAuth device-code or PKCE
   * flow provides one. The refresh flow (T9266 / Phase 3) consumes this
   * field to obtain a new `accessToken` when the current one expires.
   *
   * The writer (`addCredential`) preserves this value through upserts so
   * that a re-add of the same `(provider, label)` pair does not silently
   * drop an existing refresh token.
   *
   * Security: encrypted at rest in `accounts.refresh_enc` under the same
   * machine-key id as `accessToken` (T13715).
   *
   * @task T9266
   */
  refreshToken?: string;
}

/**
 * S-07 (CWE-256) — resolution history: Phase 2 removed `refreshToken`
 * because no code consumed it (dead secret on disk = blast radius for zero
 * benefit). Phase 3 reintroduced it together with the refresh flow that
 * consumes it (`credential-pool.ts` `_refreshViaPkce` / `proactiveRefresh`
 * and the kimi-code device-code refresh), which is why the field exists on
 * {@link StoredCredential} above and is persisted by `addCredential`. The
 * 0600 file permission protecting `accessToken` covers it.
 *
 * @task T9257 — security review S-07 (Phase-2 removal)
 * @task T9260 — Phase-3 reintroduction with the refresh flow
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
 * Absolute path of the LEGACY credential store file (migrated into the
 * `accounts` table by {@link migrateLegacyCredentialsFile}, T13715).
 *
 * Resolved through `getCleoHome()` so XDG overrides apply uniformly with
 * `credentials.ts`'s global-config tier.
 *
 * @task T9257
 */
export function credentialsStorePath(): string {
  return join(getCleoHome(), 'llm-credentials.json');
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
 * Synchronous read + parse of the LEGACY file. Never throws.
 *
 * Returns an empty store when the file is missing or blank, and `null` when
 * it is unreadable, malformed, or has the wrong `version` — such a file is
 * never migrated away.
 *
 * @task T9257
 */
function readLegacyFileSync(): CredentialsStoreData | null {
  const path = credentialsStorePath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? emptyStore() : null;
  }
  checkPermsOnRead(path);
  if (!raw.trim()) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as Partial<CredentialsStoreData>;
    if (parsed.version !== 1 || !Array.isArray(parsed.credentials)) {
      return null;
    }
    return {
      version: 1,
      defaultStrategy: parsed.defaultStrategy ?? 'priorityWithFallback',
      credentials: parsed.credentials.filter((c): c is StoredCredential => isStoredCredential(c)),
    };
  } catch {
    return null;
  }
}

/** The `(provider, label)` key of a credential. */
function keyOf(c: Pick<StoredCredential, 'provider' | 'label'>): string {
  return `${c.provider}\u0000${c.label}`;
}

/**
 * The pool's credentials in the `accounts` table, decrypted. Never throws: a
 * row this machine's key cannot decrypt (a restored or copied store) is left
 * out and logged by `(provider, label)` only.
 *
 * @task T13715
 */
function readAccountsSync(): StoredCredential[] {
  let rows: ReturnType<typeof listLlmAccountRowsSync>;
  try {
    rows = listLlmAccountRowsSync();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'llm-credentials-store: accounts unreadable');
    return [];
  }
  const out: StoredCredential[] = [];
  for (const row of rows) {
    try {
      const credential = llmAccountToCredentialSync(row);
      if (credential !== null) out.push(credential);
    } catch {
      logger.warn(
        { provider: row.provider, label: row.label },
        "llm-credentials-store: this machine's key cannot decrypt the credential; re-add it",
      );
    }
  }
  return out;
}

/**
 * The pool: every `accounts` credential, plus legacy-file entries `accounts`
 * does not hold yet (an unmigrated file). Never throws.
 *
 * @task T13715
 */
function readStoreSync(): CredentialsStoreData {
  const accounts = readAccountsSync();
  const legacy = readLegacyFileSync() ?? emptyStore();
  const have = new Set(accounts.map(keyOf));
  return {
    version: 1,
    defaultStrategy: legacy.defaultStrategy,
    credentials: [...accounts, ...legacy.credentials.filter((c) => !have.has(keyOf(c)))],
  };
}

/**
 * Move the LEGACY `llm-credentials.json` entries into the `accounts` table,
 * once. Idempotent: an entry `accounts` already holds is kept as it is, and
 * a missing file is a no-op. The plaintext file is removed only after every
 * entry reads back from `accounts`; a malformed file is left in place.
 *
 * @returns How many entries were moved.
 * @task T13715
 */
export async function migrateLegacyCredentialsFile(): Promise<number> {
  const path = credentialsStorePath();
  if (!existsSync(path)) return 0;
  const legacy = readLegacyFileSync();
  if (legacy === null) {
    logger.warn({ path }, 'llm-credentials-store: legacy file unreadable; left in place');
    return 0;
  }
  const have = new Set(readAccountsSync().map(keyOf));
  const missing = legacy.credentials.filter((c) => !have.has(keyOf(c)));
  for (const credential of missing) await upsertLlmAccount(credential);
  const after = new Set(readAccountsSync().map(keyOf));
  if (!legacy.credentials.every((c) => after.has(keyOf(c)))) {
    logger.warn({ path }, 'llm-credentials-store: migration incomplete; legacy file kept');
    return missing.length;
  }
  try {
    unlinkSync(path);
  } catch (err) {
    // Another process finished the same migration first.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (missing.length > 0) clearAnthropicKeyCache();
  return missing.length;
}

/**
 * Type-narrow check used during read to drop malformed entries silently.
 *
 * Exported so the credential transfer path (T12326) validates unsealed
 * entries with the SAME rule the store applies on read.
 *
 * @param value - Candidate entry.
 * @returns `true` when `value` is a well-formed {@link StoredCredential}.
 */
export function isStoredCredential(value: unknown): value is StoredCredential {
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
    provider === 'moonshot' ||
    provider === 'kimi-code' ||
    provider === 'openrouter' ||
    provider === 'bedrock' ||
    provider === 'deepseek' ||
    provider === 'xai' ||
    provider === 'groq';
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
  await migrateLegacyCredentialsFile();
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
  await migrateLegacyCredentialsFile();
  const data = readStoreSync();
  return data.credentials.find((c) => c.provider === provider && c.label === label) ?? null;
}

/**
 * Upsert a credential — replaces any existing `(provider, label)` pair.
 *
 * - When `input.priority` is omitted, the new entry receives
 *   `max(existing priorities) + 10` so it ranks lowest by default.
 * - Stored in the `accounts` table with its secrets encrypted under the
 *   machine key (T13715).
 *
 * Returns the inserted (or replaced) entry as it now lives in the pool.
 *
 * @task T9257
 * @task T13715
 */
export async function addCredential(
  input: Omit<StoredCredential, 'priority'> & { priority?: number },
): Promise<StoredCredential> {
  await migrateLegacyCredentialsFile();
  const remaining = readStoreSync().credentials.filter(
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
    ...(input.refreshToken !== undefined && { refreshToken: input.refreshToken }),
  };
  await upsertLlmAccount(next);
  clearAnthropicKeyCache();
  return next;
}

/**
 * Remove a credential by `(provider, label)`.
 *
 * Returns `true` when a matching entry was found and removed, `false`
 * otherwise. A legacy-file entry is migrated first, so it cannot reappear.
 *
 * @task T9257
 */
export async function removeCredential(provider: ModelTransport, label: string): Promise<boolean> {
  await migrateLegacyCredentialsFile();
  const removed = await deleteLlmAccount(provider, label);
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
  await migrateLegacyCredentialsFile();
  return pickCredentialForProviderSync(provider, opts);
}
