/**
 * LLM credential pool accessor — the encrypting writer and reader of the
 * global `accounts` table (T13715 · T13528).
 *
 * `cleo llm add` and every other pool writer store credentials here, so the
 * pool syncs on the home stream: the secret columns hold {@link encryptGlobal}
 * ciphertext under `account:<provider>:<label>` ({@link llmAccountSecretId}),
 * the id the sync sealer (`cloud/secret-seal.ts`) decrypts, seals and
 * re-encrypts under the receiving machine's key. No plaintext secret is ever
 * written to the store, the same way `service-connections-accessor.ts`
 * stores service credentials.
 *
 * Writes go through {@link openDualScopeDb}`('global')` (migrated, captured).
 * Reads are synchronous — the LLM resolver (`resolveCredentials`) cannot
 * await — so they open the global `cleo.db` read-only and decrypt with
 * {@link decryptGlobalSync}. A missing store or table reads as empty.
 *
 * The non-secret fields of a {@link StoredCredential} without a column of
 * their own (`baseUrl`, `extraHeaders`, `metadata`, `disabled`, `lastStatus`)
 * live in the row's `metadata` JSON.
 *
 * @module store/llm-accounts-accessor
 * @task T13715
 * @task T13528
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { decryptGlobalSync, encryptGlobal } from '../crypto/credentials.js';
import {
  isStoredCredential,
  type StoredAuthType,
  type StoredCredential,
} from '../llm/credentials-store.js';
import { getCleoHome } from '../paths.js';
import type { CleoGlobalDb } from './dual-scope-db.js';

const _require = createRequire(import.meta.url);

/**
 * Where the pool lives. Both fields default to the ambient global store.
 *
 * @task T13715
 */
export interface LlmAccountsOptions {
  /** CLEO home whose machine key encrypts the secrets. */
  readonly cleoHome?: string;
  /** Global `cleo.db` to use instead of `<cleoHome>/cleo.db` (a restore target or a test store). */
  readonly dbPath?: string;
}

/**
 * One `accounts` row as stored: secrets still encrypted.
 *
 * @task T13715
 */
export type LlmAccountRow = {
  readonly provider: string;
  readonly label: string;
  readonly auth_type: string;
  readonly secret_enc: string | null;
  readonly refresh_enc: string | null;
  readonly expires_at: string | null;
  readonly priority: number;
  readonly source: string | null;
  readonly last_error_code: string | null;
  readonly cooldown_reset_at: string | null;
  readonly request_count: number;
  readonly metadata: string;
};

/** The `metadata` JSON of a pool row. */
interface AccountExtras {
  baseUrl?: string | null;
  extraHeaders?: Record<string, string>;
  metadata?: Record<string, unknown>;
  disabled?: boolean;
  lastStatus?: StoredCredential['lastStatus'];
}

/**
 * The {@link encryptGlobal} id of a pool credential's secret columns. The sync
 * sealer derives the same id from the row's natural key.
 *
 * @param provider - The credential's provider.
 * @param label - Its label.
 * @returns `account:<provider>:<label>`.
 * @task T13715
 */
export function llmAccountSecretId(provider: string, label: string): string {
  return `account:${provider}:${label}`;
}

/** The global store's path. */
function dbPathOf(opts: LlmAccountsOptions): string {
  return opts.dbPath ?? join(opts.cleoHome ?? getCleoHome(), 'cleo.db');
}

/**
 * List the pool's rows, still encrypted, ordered by provider and label. A
 * missing store, or one not yet migrated to carry `accounts`, holds none.
 *
 * @param opts - Which store.
 * @returns The rows.
 * @task T13715
 */
export function listLlmAccountRowsSync(opts: LlmAccountsOptions = {}): LlmAccountRow[] {
  const path = dbPathOf(opts);
  if (!existsSync(path)) return [];
  const { DatabaseSync } = _require('node:sqlite') as {
    DatabaseSync: new (
      ...args: ConstructorParameters<typeof _DatabaseSyncType>
    ) => _DatabaseSyncType;
  };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
      .get();
    if (table === undefined) return [];
    return db
      .prepare(
        `SELECT provider, label, auth_type, secret_enc, refresh_enc, expires_at, priority, source,
                last_error_code, cooldown_reset_at, request_count, metadata
           FROM accounts ORDER BY provider, label`,
      )
      .all() as LlmAccountRow[];
  } finally {
    db.close();
  }
}

/** ISO text to epoch ms, or `undefined`. */
function msOf(iso: string | null): number | undefined {
  if (iso === null) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Parse the row's `metadata` JSON; malformed reads as empty. */
function extrasOf(json: string): AccountExtras {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as AccountExtras) : {};
  } catch {
    return {};
  }
}

/**
 * Decrypt one row into a {@link StoredCredential}.
 *
 * @param row - The row.
 * @param opts - Whose machine key decrypts it.
 * @returns The credential, or `null` for a row without a secret (redacted by an
 *   unencrypted backup) or with an unknown provider or auth type.
 * @throws When this machine's key cannot decrypt the secret.
 * @task T13715
 */
export function llmAccountToCredentialSync(
  row: LlmAccountRow,
  opts: LlmAccountsOptions = {},
): StoredCredential | null {
  if (row.secret_enc === null) return null;
  const id = llmAccountSecretId(row.provider, row.label);
  const keyOpts = opts.cleoHome === undefined ? {} : { cleoHome: opts.cleoHome };
  const extras = extrasOf(row.metadata);
  const errorCode = row.last_error_code === null ? Number.NaN : Number(row.last_error_code);
  const candidate = {
    provider: row.provider,
    label: row.label,
    authType: row.auth_type.replace('-', '_') as StoredAuthType,
    accessToken: decryptGlobalSync(row.secret_enc, id, keyOpts),
    expiresAt: msOf(row.expires_at) ?? null,
    priority: row.priority,
    ...(row.source !== null ? { source: row.source } : {}),
    baseUrl: extras.baseUrl ?? null,
    ...(extras.extraHeaders !== undefined ? { extraHeaders: extras.extraHeaders } : {}),
    ...(extras.metadata !== undefined ? { metadata: extras.metadata } : {}),
    ...(extras.lastStatus !== undefined ? { lastStatus: extras.lastStatus } : {}),
    ...(Number.isNaN(errorCode) ? {} : { lastErrorCode: errorCode }),
    ...(row.cooldown_reset_at !== null ? { lastErrorResetAt: msOf(row.cooldown_reset_at) } : {}),
    requestCount: row.request_count,
    disabled: extras.disabled ?? false,
    ...(row.refresh_enc !== null
      ? { refreshToken: decryptGlobalSync(row.refresh_enc, id, keyOpts) }
      : {}),
  };
  return isStoredCredential(candidate) ? candidate : null;
}

/** Resolve the global Drizzle handle for `opts` (lazy: keeps drizzle off the read path). */
async function openGlobal(opts: LlmAccountsOptions): Promise<CleoGlobalDb> {
  const { openDualScopeDb, openDualScopeDbAtPath } = await import('./dual-scope-db.js');
  const handle =
    opts.dbPath === undefined
      ? await openDualScopeDb('global')
      : await openDualScopeDbAtPath('global', opts.dbPath);
  return handle.db;
}

/** Keep the stored ciphertext when it already holds `plaintext`, so an unchanged secret is not re-sent. */
async function sealUnchanged(
  current: string | null | undefined,
  plaintext: string,
  id: string,
  opts: LlmAccountsOptions,
): Promise<string> {
  const keyOpts = opts.cleoHome === undefined ? {} : { cleoHome: opts.cleoHome };
  if (current !== null && current !== undefined) {
    try {
      if (decryptGlobalSync(current, id, keyOpts) === plaintext) return current;
    } catch {
      // Unreadable here (another machine's key): replace it.
    }
  }
  return encryptGlobal(plaintext, id, keyOpts);
}

/**
 * Upsert a credential into the pool, encrypting its secrets under this
 * machine's key. The `(provider, label)` pair is the key.
 *
 * @param credential - The credential.
 * @param opts - Which store and machine key.
 * @task T13715
 */
export async function upsertLlmAccount(
  credential: StoredCredential,
  opts: LlmAccountsOptions = {},
): Promise<void> {
  const db = await openGlobal(opts);
  const { accounts } = await import('./schema/cleo-global/accounts.js');
  const { and, eq } = await import('drizzle-orm');
  const id = llmAccountSecretId(credential.provider, credential.label);
  const current = (
    await db
      .select({ secretEnc: accounts.secretEnc, refreshEnc: accounts.refreshEnc })
      .from(accounts)
      .where(and(eq(accounts.provider, credential.provider), eq(accounts.label, credential.label)))
      .limit(1)
  )[0];
  const extras: AccountExtras = {
    ...(credential.baseUrl != null ? { baseUrl: credential.baseUrl } : {}),
    ...(credential.extraHeaders !== undefined ? { extraHeaders: credential.extraHeaders } : {}),
    ...(credential.metadata !== undefined ? { metadata: credential.metadata } : {}),
    ...(credential.disabled === true ? { disabled: true } : {}),
    ...(credential.lastStatus !== undefined ? { lastStatus: credential.lastStatus } : {}),
  };
  const iso = (ms: number | null | undefined): string | null =>
    typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null;
  const fields = {
    authType: credential.authType.replace('_', '-'),
    secretEnc: await sealUnchanged(current?.secretEnc, credential.accessToken, id, opts),
    refreshEnc:
      credential.refreshToken === undefined
        ? null
        : await sealUnchanged(current?.refreshEnc, credential.refreshToken, id, opts),
    expiresAt: iso(credential.expiresAt),
    priority: credential.priority,
    source: credential.source ?? null,
    status:
      credential.lastStatus === 'invalid' ? ('dead' as const) : (credential.lastStatus ?? 'ok'),
    lastErrorCode: credential.lastErrorCode === undefined ? null : String(credential.lastErrorCode),
    cooldownResetAt: iso(credential.lastErrorResetAt),
    requestCount: credential.requestCount ?? 0,
    metadata: JSON.stringify(extras),
    updatedAt: new Date().toISOString(),
  };
  await db
    .insert(accounts)
    .values({ provider: credential.provider, label: credential.label, ...fields })
    .onConflictDoUpdate({ target: [accounts.provider, accounts.label], set: fields });
}

/**
 * Delete a credential from the pool.
 *
 * @param provider - Its provider.
 * @param label - Its label.
 * @param opts - Which store.
 * @returns Whether a row was deleted.
 * @task T13715
 */
export async function deleteLlmAccount(
  provider: string,
  label: string,
  opts: LlmAccountsOptions = {},
): Promise<boolean> {
  const db = await openGlobal(opts);
  const { accounts } = await import('./schema/cleo-global/accounts.js');
  const { and, eq } = await import('drizzle-orm');
  const deleted = await db
    .delete(accounts)
    .where(and(eq(accounts.provider, provider), eq(accounts.label, label)))
    .returning({ id: accounts.id });
  return deleted.length > 0;
}
