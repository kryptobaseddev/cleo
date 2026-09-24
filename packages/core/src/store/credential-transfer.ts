/**
 * credential-transfer.ts — move stored credentials between devices without
 * moving the device key.
 *
 * Every stored credential is encrypted under a key derived from the local
 * `machine-key` (`crypto/credentials.ts`). Copying that key to another device
 * would make the two devices one trust domain, so it is never exported. A
 * credential crosses devices one of two ways instead:
 *
 * - **Sealed** (encrypted backups) — {@link sealCredentials} decrypts every
 *   local credential and seals the plaintexts under a passphrase-derived key
 *   (scrypt + AES-256-GCM, the same envelope as encrypted bundles).
 *   {@link unsealCredentials} on the target device opens that payload and
 *   re-encrypts each credential under the TARGET machine-key.
 * - **Re-entered** (unencrypted backups) — {@link redactCredentialCiphertexts}
 *   blanks the device-bound ciphertexts in the STAGED snapshot (they are
 *   useless elsewhere) and {@link listCredentialsForReentry} names every
 *   credential with the one command that re-enters it.
 *
 * This module also migrates project credentials from the legacy path-bound
 * KDF to the project-identity KDF ({@link migrateProjectCredentials}), so a
 * moved project directory keeps its credentials.
 *
 * Stores covered:
 *
 * | Store | Location | Encryption |
 * |-------|----------|------------|
 * | `project-agent` | project `cleo.db` → `tasks_agent_credentials.api_key_encrypted` | project KDF |
 * | `service-connection` | global `cleo.db` → `service_connections.credentials_enc` | global KDF, id `service:<provider>:<label>` |
 * | `llm-pool` | `<cleoHome>/llm-credentials.json` | none (0600 plaintext file) |
 *
 * The LLM pool stays a plaintext 0600 file on purpose (T12326 decision).
 * Encrypting it under the machine-key would add little on-device protection,
 * because the key sits in the same directory with the same mode. It would also
 * force a key read into the synchronous resolver hot path
 * (`pickCredentialForProviderSync`) and break the tools that read the file
 * directly. What matters is that the pool never enters an unencrypted bundle,
 * and this module guarantees that: the pool is either sealed or listed for
 * re-entry.
 *
 * Callers pass FILE PATHS (live stores, or a backup's staged snapshots); the
 * module opens short-lived raw handles and closes them before returning.
 *
 * @task T12326
 * @module store/credential-transfer
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type {
  CredentialDescriptor,
  CredentialReentry,
  ProjectCredentialMigrationResult,
  SealCredentialsResult,
  UnsealCredentialsResult,
} from '@cleocode/contracts';
import {
  decryptGlobal,
  decryptProjectSecret,
  encryptGlobal,
  encryptProjectSecret,
} from '../crypto/credentials.js';
import {
  addCredential,
  credentialsStorePath,
  isStoredCredential,
  type StoredCredential,
} from '../llm/credentials-store.js';
import { getCleoHome } from '../paths.js';
import { decryptBundle, encryptBundle } from './backup-crypto.js';

// ---------------------------------------------------------------------------
// node:sqlite interop (createRequire — Vitest strips `node:` prefix)
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Where to read credentials from. Every field is optional; an omitted store is
 * skipped.
 *
 * @task T12326
 */
export interface CredentialSources {
  /** Project `cleo.db` (live, or a staged snapshot). */
  readonly projectDbPath?: string;
  /** Project identity keying the project KDF. Required when the project store has rows. */
  readonly projectId?: string;
  /** Candidate paths for legacy path-bound project ciphertexts (usually the project root). */
  readonly legacyProjectPaths?: readonly string[];
  /** Global `cleo.db` (live, or a staged snapshot). */
  readonly globalDbPath?: string;
  /** LLM credential pool file. Defaults to none; pass `credentialsStorePath()` for the live pool. */
  readonly llmStorePath?: string;
  /** CLEO home whose machine-key (and global-salt) decrypt the stores. Defaults to the ambient home. */
  readonly cleoHome?: string;
}

/**
 * Where {@link unsealCredentials} writes. The restored database files must
 * already be in place — rows are updated, never created.
 *
 * @task T12326
 */
export interface CredentialTargets {
  /** Restored project `cleo.db`. */
  readonly projectDbPath?: string;
  /** Identity of the restored project (its `.cleo/project-info.json` `projectId`). */
  readonly projectId?: string;
  /** Restored global `cleo.db`. */
  readonly globalDbPath?: string;
  /**
   * Write `llm-pool` entries into the local pool (`<cleoHome>/llm-credentials.json`).
   * Default `true`. Only the AMBIENT home's pool can be written; with a
   * different `cleoHome` the entries are reported for re-entry instead.
   */
  readonly restoreLlmPool?: boolean;
  /**
   * CLEO home whose machine-key (and global-salt) re-encrypt the credentials —
   * the home being restored INTO. Defaults to the ambient home.
   */
  readonly cleoHome?: string;
}

/**
 * Error codes raised by this module.
 *
 * - `E_CREDENTIAL_PASSPHRASE` — the passphrase did not open the sealed payload.
 * - `E_CREDENTIAL_PAYLOAD` — the payload opened but is not a credential payload.
 * - `E_CREDENTIAL_PROJECT_ID` — a project store has credentials but no project id was given.
 * - `E_CREDENTIAL_LIVE_STORE` — {@link redactCredentialCiphertexts} was pointed at a live store.
 *
 * @task T12326
 */
export type CredentialTransferErrorCode =
  | 'E_CREDENTIAL_PASSPHRASE'
  | 'E_CREDENTIAL_PAYLOAD'
  | 'E_CREDENTIAL_PROJECT_ID'
  | 'E_CREDENTIAL_LIVE_STORE';

/**
 * Error thrown by credential transfer. Raised BEFORE any write, so a caller
 * that catches it knows no store was modified.
 *
 * @task T12326
 */
export class CredentialTransferError extends Error {
  /** Machine-readable failure code. */
  readonly code: CredentialTransferErrorCode;

  /**
   * @param code - Failure code.
   * @param message - Human-readable explanation, including the remedy.
   */
  constructor(code: CredentialTransferErrorCode, message: string) {
    super(message);
    this.name = 'CredentialTransferError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Sealed payload shape
// ---------------------------------------------------------------------------

/** Discriminator written into every sealed payload. */
const PAYLOAD_FORMAT = 'cleo-credential-transfer';

/** Payload schema version. */
const PAYLOAD_VERSION = 1;

/** One sealed credential: its descriptor plus the plaintext secret. */
interface SealedEntry extends CredentialDescriptor {
  /** Plaintext secret (`llm-pool`: the JSON-serialized pool entry). */
  readonly secret: string;
}

/** Plaintext of the sealed payload (only ever held in memory). */
interface SealedPayload {
  readonly format: typeof PAYLOAD_FORMAT;
  readonly version: typeof PAYLOAD_VERSION;
  readonly createdAt: string;
  readonly entries: readonly SealedEntry[];
  readonly reentry: readonly CredentialReentry[];
}

// ---------------------------------------------------------------------------
// Re-entry commands
// ---------------------------------------------------------------------------

/** Quote a shell argument only when it needs quoting. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the re-entry record for a credential: its identity, why it must be
 * re-entered, and the one command that re-enters it.
 *
 * @param descriptor - The credential.
 * @param reason - Why it could not be carried over.
 * @returns The re-entry record.
 * @task T12326
 */
export function reentryFor(descriptor: CredentialDescriptor, reason: string): CredentialReentry {
  return { ...descriptor, reason, reentryCommand: reentryCommandFor(descriptor) };
}

/**
 * The one command that re-enters a credential. Secrets appear as a
 * placeholder, never a value.
 */
function reentryCommandFor(descriptor: CredentialDescriptor): string {
  switch (descriptor.store) {
    case 'project-agent':
      return `cleo agent register --id ${shellArg(descriptor.id)} --name ${shellArg(descriptor.label)} --api-key <API_KEY>`;
    case 'service-connection': {
      const { provider, label } = splitProviderLabel(descriptor.id);
      return `cleo service connect ${shellArg(provider)} --label ${shellArg(label)} --token <TOKEN>`;
    }
    case 'llm-pool': {
      const { provider, label } = splitProviderLabel(descriptor.id);
      return `printf '%s' "$API_KEY" | cleo llm add ${shellArg(provider)} --label ${shellArg(label)} --api-key-stdin`;
    }
  }
}

/** Split a `<provider>:<label>` id (labels may contain `:`). */
function splitProviderLabel(id: string): { provider: string; label: string } {
  const idx = id.indexOf(':');
  return idx < 0
    ? { provider: id, label: 'default' }
    : { provider: id.slice(0, idx), label: id.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// Store readers (no decryption)
// ---------------------------------------------------------------------------

/** A credential row as read from a store, still encrypted. */
interface StoredRow {
  readonly descriptor: CredentialDescriptor;
  /** Ciphertext (DB stores) or the serialized entry (`llm-pool`). */
  readonly material: string;
}

/** Open a database file, run `fn`, always close. Returns `fallback` when the file is absent. */
function withDb<T>(dbPath: string | undefined, fallback: T, fn: (db: DatabaseSync) => T): T {
  if (dbPath === undefined || !fs.existsSync(dbPath)) return fallback;
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** True when `table` exists in `db`. */
function hasTable(db: DatabaseSync, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

/** Read `tasks_agent_credentials` rows that carry ciphertext. */
function readProjectAgentRows(dbPath: string | undefined): StoredRow[] {
  return withDb(dbPath, [], (db) => {
    if (!hasTable(db, 'tasks_agent_credentials')) return [];
    const rows = db
      .prepare(
        "SELECT agent_id, display_name, api_key_encrypted FROM tasks_agent_credentials WHERE api_key_encrypted <> '' ORDER BY agent_id",
      )
      .all() as Array<{ agent_id: string; display_name: string; api_key_encrypted: string }>;
    return rows.map((r) => ({
      descriptor: { store: 'project-agent', id: r.agent_id, label: r.display_name },
      material: r.api_key_encrypted,
    }));
  });
}

/** Read `service_connections` rows that carry ciphertext. */
function readServiceConnectionRows(dbPath: string | undefined): StoredRow[] {
  return withDb(dbPath, [], (db) => {
    if (!hasTable(db, 'service_connections')) return [];
    const rows = db
      .prepare(
        "SELECT provider, label, credentials_enc FROM service_connections WHERE credentials_enc IS NOT NULL AND credentials_enc <> '' ORDER BY provider, label",
      )
      .all() as Array<{ provider: string; label: string; credentials_enc: string }>;
    return rows.map((r) => ({
      descriptor: {
        store: 'service-connection',
        id: `${r.provider}:${r.label}`,
        label: `${r.provider} service connection "${r.label}"`,
      },
      material: r.credentials_enc,
    }));
  });
}

/** Read the LLM pool file's entries. A missing or malformed file yields none. */
function readLlmPoolRows(storePath: string | undefined): StoredRow[] {
  if (storePath === undefined || !fs.existsSync(storePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || !('credentials' in parsed)) return [];
  const credentials = parsed.credentials;
  if (!Array.isArray(credentials)) return [];
  return credentials.filter(isStoredCredential).map((c) => ({
    descriptor: {
      store: 'llm-pool',
      id: `${c.provider}:${c.label}`,
      label: `${c.provider} LLM credential "${c.label}"`,
    },
    material: JSON.stringify(c),
  }));
}

/** Every credential row across the given sources, still encrypted. */
function readAllRows(sources: CredentialSources): StoredRow[] {
  return [
    ...readProjectAgentRows(sources.projectDbPath),
    ...readServiceConnectionRows(sources.globalDbPath),
    ...readLlmPoolRows(sources.llmStorePath),
  ];
}

// ---------------------------------------------------------------------------
// Unencrypted-bundle path: list + redact
// ---------------------------------------------------------------------------

/**
 * List every credential in `sources` with the command that re-enters it.
 * Reads identities only — nothing is decrypted.
 *
 * Use for an UNENCRYPTED backup: its import cannot carry credentials, so the
 * import report prints this list.
 *
 * @param sources - Stores to enumerate.
 * @param reason - Why the credentials must be re-entered (shown per entry).
 * @returns One re-entry record per credential.
 * @task T12326
 */
export function listCredentialsForReentry(
  sources: CredentialSources,
  reason = 'unencrypted backups do not carry credentials',
): CredentialReentry[] {
  return readAllRows(sources).map((row) => reentryFor(row.descriptor, reason));
}

/** Resolve a path for comparison, following symlinks when the file exists. */
function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Refuse to redact anything that looks like a live store: the global
 * `cleo.db`, or any database directly inside a `.cleo/` directory.
 */
function assertStagedCopy(dbPath: string): void {
  const resolved = canonicalPath(dbPath);
  const liveGlobal = canonicalPath(path.join(getCleoHome(), 'cleo.db'));
  if (resolved === liveGlobal || path.basename(path.dirname(resolved)) === '.cleo') {
    throw new CredentialTransferError(
      'E_CREDENTIAL_LIVE_STORE',
      `Refusing to redact credentials in a live store (${resolved}). ` +
        'Redaction applies only to staged backup snapshots.',
    );
  }
}

/**
 * Blank the device-bound ciphertexts in STAGED snapshot databases and report
 * what was removed.
 *
 * An unencrypted bundle must not carry credential ciphertext: it cannot be
 * decrypted on another device, and it would be decryptable by anyone who
 * later obtains this device's machine-key. Sets
 * `tasks_agent_credentials.api_key_encrypted = ''` (the column is NOT NULL)
 * and `service_connections.credentials_enc = NULL`; every non-secret column
 * is kept. The LLM pool FILE is not touched — the bundle writer must exclude
 * it, and can take its entries from the returned list.
 *
 * @param sources - Staged snapshot paths (`projectDbPath` / `globalDbPath`);
 *   `llmStorePath` is listed, not modified.
 * @returns Re-entry records for every redacted or excluded credential.
 * @throws {CredentialTransferError} `E_CREDENTIAL_LIVE_STORE` when a path is
 *   a live store.
 * @task T12326
 */
export function redactCredentialCiphertexts(sources: CredentialSources): CredentialReentry[] {
  if (sources.projectDbPath !== undefined) assertStagedCopy(sources.projectDbPath);
  if (sources.globalDbPath !== undefined) assertStagedCopy(sources.globalDbPath);

  const listed = listCredentialsForReentry(sources);
  withDb(sources.projectDbPath, undefined, (db) => {
    if (hasTable(db, 'tasks_agent_credentials')) {
      db.prepare("UPDATE tasks_agent_credentials SET api_key_encrypted = ''").run();
    }
  });
  withDb(sources.globalDbPath, undefined, (db) => {
    if (hasTable(db, 'service_connections')) {
      db.prepare(
        'UPDATE service_connections SET credentials_enc = NULL WHERE credentials_enc IS NOT NULL',
      ).run();
    }
  });
  return listed;
}

// ---------------------------------------------------------------------------
// Encrypted-bundle path: seal + unseal
// ---------------------------------------------------------------------------

/** Require a project id when project credentials are present. */
function requireProjectId(projectId: string | undefined, action: string): string {
  if (projectId === undefined || projectId.length === 0) {
    throw new CredentialTransferError(
      'E_CREDENTIAL_PROJECT_ID',
      `Cannot ${action} project credentials without the project's id ` +
        '(the projectId in .cleo/project-info.json).',
    );
  }
  return projectId;
}

/** Decrypt one stored row with the LOCAL keys. */
async function openRow(row: StoredRow, sources: CredentialSources): Promise<string> {
  switch (row.descriptor.store) {
    case 'project-agent': {
      const projectId = requireProjectId(sources.projectId, 'seal');
      const result = await decryptProjectSecret(row.material, {
        projectId,
        legacyProjectPaths: sources.legacyProjectPaths,
        cleoHome: sources.cleoHome,
      });
      return result.plaintext;
    }
    case 'service-connection':
      return decryptGlobal(row.material, `service:${row.descriptor.id}`, {
        cleoHome: sources.cleoHome,
      });
    case 'llm-pool':
      return row.material;
  }
}

/**
 * Seal every credential in `sources` under a passphrase.
 *
 * Each credential is decrypted with THIS device's keys and the plaintexts are
 * sealed together (scrypt-derived key, AES-256-GCM — {@link encryptBundle}).
 * The payload carries credentials, never key material: the machine-key and
 * global-salt stay on this device. A credential this device cannot decrypt is
 * not sealed; it is reported in `reentry` (and carried into the payload so
 * the importing device reports it too).
 *
 * @param sources - Stores to read (live stores or staged snapshots).
 * @param passphrase - User passphrase; the same one opens the payload.
 * @returns Sealed bytes plus what was sealed and what needs re-entry. A
 *   project credential with no `sources.projectId` is reported for re-entry.
 * @task T12326
 */
export async function sealCredentials(
  sources: CredentialSources,
  passphrase: string,
): Promise<SealCredentialsResult> {
  const rows = readAllRows(sources);

  const entries: SealedEntry[] = [];
  const reentry: CredentialReentry[] = [];
  for (const row of rows) {
    try {
      entries.push({ ...row.descriptor, secret: await openRow(row, sources) });
    } catch (err) {
      reentry.push(
        reentryFor(
          row.descriptor,
          `not decryptable on the exporting device: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  const payload: SealedPayload = {
    format: PAYLOAD_FORMAT,
    version: PAYLOAD_VERSION,
    createdAt: new Date().toISOString(),
    entries,
    reentry,
  };
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  try {
    return {
      sealed: encryptBundle(plaintext, passphrase),
      sealedCredentials: entries.map(({ store, id, label }) => ({ store, id, label })),
      reentry,
    };
  } finally {
    plaintext.fill(0);
  }
}

/** Type guard for a credential descriptor field set. */
function isDescriptor(value: unknown): value is CredentialDescriptor {
  if (typeof value !== 'object' || value === null) return false;
  const store = 'store' in value ? value.store : undefined;
  return (
    (store === 'project-agent' || store === 'service-connection' || store === 'llm-pool') &&
    'id' in value &&
    typeof value.id === 'string' &&
    'label' in value &&
    typeof value.label === 'string'
  );
}

/** Type guard for a sealed entry. */
function isSealedEntry(value: unknown): value is SealedEntry {
  return isDescriptor(value) && 'secret' in value && typeof value.secret === 'string';
}

/** Type guard for a carried re-entry record. */
function isReentry(value: unknown): value is CredentialReentry {
  return (
    isDescriptor(value) &&
    'reason' in value &&
    typeof value.reason === 'string' &&
    'reentryCommand' in value &&
    typeof value.reentryCommand === 'string'
  );
}

/** Parse and validate a decrypted payload. */
function parsePayload(bytes: Buffer): SealedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    parsed = undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('format' in parsed) ||
    parsed.format !== PAYLOAD_FORMAT ||
    !('version' in parsed) ||
    parsed.version !== PAYLOAD_VERSION ||
    !('entries' in parsed) ||
    !Array.isArray(parsed.entries) ||
    !parsed.entries.every(isSealedEntry) ||
    !('reentry' in parsed) ||
    !Array.isArray(parsed.reentry) ||
    !parsed.reentry.every(isReentry)
  ) {
    throw new CredentialTransferError(
      'E_CREDENTIAL_PAYLOAD',
      'The sealed credential payload opened but is not a supported credential payload.',
    );
  }
  return {
    format: PAYLOAD_FORMAT,
    version: PAYLOAD_VERSION,
    createdAt:
      'createdAt' in parsed && typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    entries: parsed.entries,
    reentry: parsed.reentry,
  };
}

/** Update one ciphertext cell in `table`; returns whether a row matched. */
function updateCell(dbPath: string, table: string, sql: string, params: string[]): boolean {
  return withDb(dbPath, false, (db) => {
    if (!hasTable(db, table)) return false;
    return Number(db.prepare(sql).run(...params).changes) > 0;
  });
}

/**
 * Open a sealed payload and write every credential into the local stores,
 * re-encrypted under THIS device's machine-key.
 *
 * Order of operations: the passphrase is checked and the payload validated
 * BEFORE anything is written — a wrong passphrase leaves every store
 * untouched. Database rows are updated in place (the restore must already
 * have put the rows there); a credential whose row is absent, or whose store
 * has no target, is reported for re-entry instead of being dropped silently.
 *
 * Call after the restored database files and any restored `global-salt` are in
 * place: the global KDF reads the salt. Pass `targets.cleoHome` so the salt is
 * read fresh from that home rather than from the process memo.
 *
 * @param sealed - Bytes from {@link sealCredentials}.
 * @param passphrase - The passphrase used to seal.
 * @param targets - Restored stores to write into.
 * @returns What was restored and what must be re-entered (with commands).
 * @throws {CredentialTransferError} `E_CREDENTIAL_PASSPHRASE` (wrong
 *   passphrase or corrupted payload) or `E_CREDENTIAL_PAYLOAD` — nothing written.
 * @task T12326
 */
export async function unsealCredentials(
  sealed: Uint8Array,
  passphrase: string,
  targets: CredentialTargets,
): Promise<UnsealCredentialsResult> {
  let opened: Buffer;
  try {
    opened = decryptBundle(Buffer.from(sealed), passphrase);
  } catch {
    throw new CredentialTransferError(
      'E_CREDENTIAL_PASSPHRASE',
      'Cannot open the sealed credentials: wrong passphrase, or the payload is corrupted. ' +
        'Nothing was written. Re-run the import with the passphrase used for the export.',
    );
  }

  let payload: SealedPayload;
  try {
    payload = parsePayload(opened);
  } finally {
    opened.fill(0);
  }

  // Phase 1 — encrypt everything under the local keys (no writes yet).
  const writes: Array<{ entry: SealedEntry; apply: () => Promise<boolean> }> = [];
  const reentry: CredentialReentry[] = [...payload.reentry];
  for (const entry of payload.entries) {
    const descriptor: CredentialDescriptor = {
      store: entry.store,
      id: entry.id,
      label: entry.label,
    };
    switch (entry.store) {
      case 'project-agent': {
        const { projectDbPath, projectId } = targets;
        if (projectDbPath === undefined || projectId === undefined || projectId === '') {
          reentry.push(reentryFor(descriptor, 'no project store to restore into'));
          break;
        }
        const ciphertext = await encryptProjectSecret(entry.secret, projectId, {
          cleoHome: targets.cleoHome,
        });
        writes.push({
          entry,
          apply: async () =>
            updateCell(
              projectDbPath,
              'tasks_agent_credentials',
              'UPDATE tasks_agent_credentials SET api_key_encrypted = ? WHERE agent_id = ?',
              [ciphertext, entry.id],
            ),
        });
        break;
      }
      case 'service-connection': {
        const { globalDbPath } = targets;
        if (globalDbPath === undefined) {
          reentry.push(reentryFor(descriptor, 'no global store to restore into'));
          break;
        }
        const ciphertext = await encryptGlobal(entry.secret, `service:${entry.id}`, {
          cleoHome: targets.cleoHome,
        });
        const { provider, label } = splitProviderLabel(entry.id);
        writes.push({
          entry,
          apply: async () =>
            updateCell(
              globalDbPath,
              'service_connections',
              'UPDATE service_connections SET credentials_enc = ? WHERE provider = ? AND label = ?',
              [ciphertext, provider, label],
            ),
        });
        break;
      }
      case 'llm-pool': {
        if (targets.restoreLlmPool === false) {
          reentry.push(reentryFor(descriptor, 'LLM pool restore was not requested'));
          break;
        }
        if (
          targets.cleoHome !== undefined &&
          canonicalPath(targets.cleoHome) !== canonicalPath(getCleoHome())
        ) {
          reentry.push(
            reentryFor(descriptor, 'the LLM pool of a non-active CLEO home cannot be written'),
          );
          break;
        }
        let credential: unknown;
        try {
          credential = JSON.parse(entry.secret);
        } catch {
          credential = undefined;
        }
        if (!isStoredCredential(credential)) {
          reentry.push(reentryFor(descriptor, 'sealed LLM entry is malformed'));
          break;
        }
        const stored: StoredCredential = credential;
        writes.push({
          entry,
          apply: async () => {
            await addCredential(stored);
            return true;
          },
        });
        break;
      }
    }
  }

  // Phase 2 — write.
  const restored: CredentialDescriptor[] = [];
  for (const { entry, apply } of writes) {
    const descriptor: CredentialDescriptor = {
      store: entry.store,
      id: entry.id,
      label: entry.label,
    };
    if (await apply()) restored.push(descriptor);
    else reentry.push(reentryFor(descriptor, 'the restored store has no row for it'));
  }
  return { restored, reentry };
}

// ---------------------------------------------------------------------------
// Project KDF migration (path-bound → project identity)
// ---------------------------------------------------------------------------

/**
 * Re-encrypt project credentials from the legacy path-bound KDF to the
 * project-identity KDF, in place.
 *
 * Each ciphertext is opened with {@link decryptProjectSecret}; a legacy one is
 * rewritten with the re-wrapped ciphertext it returns. Current ciphertexts are
 * left alone. A credential no candidate key opens is left UNTOUCHED (never
 * deleted) and reported with its re-entry command — typically because it was
 * encrypted at a path not in `legacyProjectPaths`, or on another device.
 * Idempotent: a second run reports everything as `current`. With `dryRun`
 * nothing is written and `migrated` lists what WOULD be migrated.
 *
 * @param sources - `projectDbPath`, `projectId`, and `legacyProjectPaths`.
 * @param options - `dryRun` to report without writing.
 * @returns Migrated, already-current, and unrecoverable credentials.
 * @throws {CredentialTransferError} `E_CREDENTIAL_PROJECT_ID` when rows exist
 *   and `projectId` is missing.
 * @task T12326
 */
export async function migrateProjectCredentials(
  sources: Pick<
    CredentialSources,
    'projectDbPath' | 'projectId' | 'legacyProjectPaths' | 'cleoHome'
  >,
  options: { readonly dryRun?: boolean } = {},
): Promise<ProjectCredentialMigrationResult> {
  const rows = readProjectAgentRows(sources.projectDbPath);
  const migrated: CredentialDescriptor[] = [];
  const current: CredentialDescriptor[] = [];
  const reentry: CredentialReentry[] = [];
  if (rows.length === 0 || sources.projectDbPath === undefined) {
    return { migrated, current, reentry };
  }
  const projectId = requireProjectId(sources.projectId, 'migrate');
  const dbPath = sources.projectDbPath;

  for (const row of rows) {
    let result: Awaited<ReturnType<typeof decryptProjectSecret>>;
    try {
      result = await decryptProjectSecret(row.material, {
        projectId,
        legacyProjectPaths: sources.legacyProjectPaths,
        cleoHome: sources.cleoHome,
      });
    } catch (err) {
      reentry.push(reentryFor(row.descriptor, err instanceof Error ? err.message : String(err)));
      continue;
    }
    if (result.rewrapped === null) {
      current.push(row.descriptor);
      continue;
    }
    if (options.dryRun === true) {
      migrated.push(row.descriptor);
      continue;
    }
    // Compare-and-swap on the old ciphertext: a concurrent writer wins.
    const swapped = updateCell(
      dbPath,
      'tasks_agent_credentials',
      'UPDATE tasks_agent_credentials SET api_key_encrypted = ? WHERE agent_id = ? AND api_key_encrypted = ?',
      [result.rewrapped, row.descriptor.id, row.material],
    );
    (swapped ? migrated : current).push(row.descriptor);
  }
  return { migrated, current, reentry };
}

/**
 * Outcome of {@link migrateProjectCredentialsAtRoot}.
 *
 * @task T12326
 */
export interface ProjectRootCredentialMigration extends ProjectCredentialMigrationResult {
  /** Project store examined. */
  readonly projectDbPath: string;
  /** Project identity keying the new KDF (null when project-info.json has none). */
  readonly projectId: string | null;
  /** Whether this was a dry run (nothing written). */
  readonly dryRun: boolean;
}

/**
 * Migrate a project's stored credentials off the path-bound KDF, resolving
 * everything from the project root: the store is `<root>/.cleo/cleo.db`, the
 * identity is `projectId` from `.cleo/project-info.json`, and the legacy
 * candidates are the root as given and its real path.
 *
 * This is the trigger used by `cleo upgrade` and `cleo doctor credentials`.
 * It is idempotent and never deletes; unrecoverable rows come back in
 * `reentry` with the command that re-enters each one. A project with no
 * credential rows returns empty lists without opening anything for write.
 *
 * @param projectRoot - Absolute project root.
 * @param options - `dryRun` to report without writing; `cleoHome` to key with another home.
 * @returns What was (or would be) migrated, what is current, and what must be re-entered.
 * @throws {CredentialTransferError} `E_CREDENTIAL_PROJECT_ID` when credential
 *   rows exist but project-info.json has no `projectId`.
 * @task T12326
 */
export async function migrateProjectCredentialsAtRoot(
  projectRoot: string,
  options: { readonly dryRun?: boolean; readonly cleoHome?: string } = {},
): Promise<ProjectRootCredentialMigration> {
  const root = path.resolve(projectRoot);
  const cleoDir = path.join(root, '.cleo');
  const projectDbPath = path.join(cleoDir, 'cleo.db');
  let projectId: string | null = null;
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(cleoDir, 'project-info.json'), 'utf-8'),
    );
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'projectId' in parsed &&
      typeof parsed.projectId === 'string' &&
      parsed.projectId.length > 0
    ) {
      projectId = parsed.projectId;
    }
  } catch {
    projectId = null;
  }
  const result = await migrateProjectCredentials(
    {
      projectDbPath,
      ...(projectId !== null ? { projectId } : {}),
      legacyProjectPaths: [root, canonicalPath(root)],
      ...(options.cleoHome !== undefined ? { cleoHome: options.cleoHome } : {}),
    },
    { dryRun: options.dryRun === true },
  );
  return { ...result, projectDbPath, projectId, dryRun: options.dryRun === true };
}

/**
 * The live LLM pool path, re-exported so a bundle writer need not import the
 * LLM module to fill {@link CredentialSources.llmStorePath}.
 *
 * @returns `<cleoHome>/llm-credentials.json`.
 * @task T12326
 */
export function liveLlmCredentialStorePath(): string {
  return credentialsStorePath();
}
