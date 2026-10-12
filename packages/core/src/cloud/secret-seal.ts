/**
 * Portable-secret values on the home stream (journal spec §2.5 phase A and
 * §2.7; T13467, owner design `cleo docs fetch t13467-global-secrets-sync-design`).
 *
 * Everything here awaits (the machine-key decrypt and re-encrypt are async), so
 * it runs only inside `cloud sync`, which holds the master key, and never inside
 * a transaction or on the store-open path:
 *
 * - {@link prepareSecretSeals} (sender, phase A): reads each live secret value
 *   of a {@link SEALED_SECRET_TABLES} row with pending captures, decrypts a
 *   machine-key credential column to its plaintext, and seals it under
 *   `deriveKey(masterKey, 'secret-values')` with the AAD `table\nuid\ncolumn`.
 *   The sealer's phase B swaps each `<changed>` marker for its sealed value.
 * - {@link prepareSecretOpens} (receiver): opens each staged sealed value and
 *   re-encrypts a credential column under THIS machine's key before the apply
 *   frame opens; the applier writes the finished value.
 *
 * A device that is not logged in never reaches either step: its captures stay
 * pending and its inbox holds the sealed ops.
 *
 * @task T13467
 */

import type { DatabaseSync } from 'node:sqlite';
import type { CloudWarning, TableScope } from '@cleocode/contracts';
import type { LedgerWireValue } from '@cleocode/contracts/ledger';
import { decryptGlobal, encryptGlobal } from '../crypto/credentials.js';
import { openedSecretKey } from '../store/sync/apply/applier.js';
import { captureTableDef } from '../store/sync/capture.js';
import { stagedTxns } from '../store/sync/inbox.js';
import {
  canonicalJson,
  pendingSecretRows,
  SEALED_SECRET_TABLES,
  type SecretSeal,
  type SecretSeals,
  secretSealKey,
} from '../store/sync/sealer.js';
import { deriveKey, open, seal } from './crypto.js';

/** The HKDF purpose of the secret-values key (§2.7). */
const SECRET_VALUES_PURPOSE = 'secret-values';

/** The AEAD purpose a secret value is sealed under (§2.7). */
const SECRET_SEAL_PURPOSE = 'secret';

/**
 * The `encryptGlobal` id of each machine-key credential column, from the row's
 * natural key. These columns hold machine-key ciphertext at rest, so they
 * travel as their plaintext (sealed) and are re-encrypted on arrival; every
 * other secret column travels as its sealed wire value.
 */
const CREDENTIAL_IDS: Readonly<
  Record<string, Readonly<Record<string, (key: Readonly<Record<string, unknown>>) => string>>>
> = {
  // shortcut: no writer encrypts accounts yet, so this id is defined here (and
  // in the accounts schema doc); a future pool writer must use the same id.
  accounts: {
    secret_enc: (k) => `account:${String(k.provider)}:${String(k.label)}`,
    refresh_enc: (k) => `account:${String(k.provider)}:${String(k.label)}`,
  },
  service_connections: {
    credentials_enc: (k) => `service:${String(k.provider)}:${String(k.label)}`,
  },
  service_configs: {
    client_secret_enc: (k) => `service-config:${String(k.provider)}`,
  },
};

/**
 * The secret-values key (§2.7), derived from the account master key.
 *
 * @param masterKey - The account master key (32 bytes).
 * @returns The key secret values are sealed under.
 */
export function secretValuesKey(masterKey: Uint8Array): Buffer {
  return deriveKey(masterKey, SECRET_VALUES_PURPOSE);
}

/** Options for both phases. */
export interface SecretSealOptions {
  /** The CLEO home whose machine key encrypts credentials. @defaultValue the current home */
  readonly cleoHome?: string;
  /** Receives a warning for each value phase A could not read (T13532). */
  readonly warn?: (warning: CloudWarning) => void;
}

/**
 * Phase A (§2.5): seal every live secret value the pending captures of
 * {@link SEALED_SECRET_TABLES} rows will send. Read-only on the store. A value
 * this machine's key cannot decrypt (a restored or copied store, a rotated key)
 * is left out with a `W_SYNC_SECRET_UNREADABLE` warning: its group stays
 * pending, and every other row still seals (T13532).
 *
 * @param db - The store.
 * @param scope - Its scope.
 * @param secretKey - {@link secretValuesKey} of the account master key.
 * @param opts - Machine-key options.
 * @returns The sealed values, for `sealPending({ secrets })`.
 */
export async function prepareSecretSeals(
  db: DatabaseSync,
  scope: TableScope,
  secretKey: Uint8Array,
  opts: SecretSealOptions = {},
): Promise<SecretSeals> {
  const out = new Map<string, SecretSeal>();
  for (const row of pendingSecretRows(db, scope)) {
    // T13534: one warning per row per call, naming the credential.
    let warned = false;
    for (const [col, value] of Object.entries(row.values)) {
      const live = canonicalJson(value);
      if (value === null) {
        for (const uid of [row.uid, ...row.capturedUids])
          out.set(secretSealKey(row.table, uid, col), { live, sealed: null });
        continue;
      }
      const id = CREDENTIAL_IDS[row.table]?.[col]?.(row.key);
      let plaintext = live;
      if (id !== undefined) {
        try {
          plaintext = await decryptGlobal(String(value), id, { cleoHome: opts.cleoHome });
        } catch {
          // The cause is not echoed: a warning never carries secret material.
          if (!warned) {
            warned = true;
            opts.warn?.({
              code: 'W_SYNC_SECRET_UNREADABLE',
              message: `credential ${id} (${row.table} ${row.uid}): this machine's key cannot decrypt the stored secret, so the row stays unsent until it is re-entered; every other change still syncs`,
            });
          }
          continue;
        }
      }
      // Under the live uid, and under any older uid a held capture still carries (T13603).
      for (const uid of [row.uid, ...row.capturedUids]) {
        const sealed = seal(
          secretKey,
          Buffer.from(plaintext, 'utf8'),
          SECRET_SEAL_PURPOSE,
          secretSealKey(row.table, uid, col),
        ).toString('base64');
        out.set(secretSealKey(row.table, uid, col), { live, sealed });
      }
    }
  }
  return out;
}

/**
 * The receiver's half (§2.7): open every sealed secret value staged on
 * `stream` and re-encrypt each credential column under this machine's key.
 * A value that does not open (another account's key) is left out, so its op
 * holds.
 *
 * @param db - The store.
 * @param scope - Its scope.
 * @param stream - The stream whose staged transactions to open.
 * @param secretKey - {@link secretValuesKey} of the account master key.
 * @param opts - Machine-key options.
 * @returns The opened values, for `applyStagedTxns({ secrets })`.
 */
export async function prepareSecretOpens(
  db: DatabaseSync,
  scope: TableScope,
  stream: string,
  secretKey: Uint8Array,
  opts: SecretSealOptions = {},
): Promise<ReadonlyMap<string, LedgerWireValue>> {
  const out = new Map<string, LedgerWireValue>();
  for (const st of stagedTxns(db, stream)) {
    for (const op of st.txn.ops) {
      if (!op.a || !SEALED_SECRET_TABLES.has(op.t)) continue;
      const def = captureTableDef(db, scope, op.t);
      if (!def) continue;
      for (const [col, v] of Object.entries(op.a)) {
        if (typeof v !== 'string' || !def.secret.has(col)) continue;
        let plaintext: string;
        try {
          plaintext = open(
            secretKey,
            Buffer.from(v, 'base64'),
            SECRET_SEAL_PURPOSE,
            secretSealKey(op.t, op.u, col),
          ).toString('utf8');
        } catch {
          continue;
        }
        const key = { ...op.a, ...(op.k ?? {}) };
        const id = CREDENTIAL_IDS[op.t]?.[col]?.(key);
        const local: LedgerWireValue =
          id !== undefined
            ? await encryptGlobal(plaintext, id, { cleoHome: opts.cleoHome })
            : (JSON.parse(plaintext) as LedgerWireValue);
        out.set(openedSecretKey(op.t, op.u, col, v), local);
      }
    }
  }
  return out;
}
