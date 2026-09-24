/**
 * agent-api-key.ts — at-rest storage of agent API keys in
 * `agent_registry_agents.api_key_encrypted` (global `cleo.db`).
 *
 * ## What went wrong (T12352)
 *
 * ADR-037 §5 specified the global KDF as
 * `apiKey = HMAC-SHA256(machine-key ‖ global-salt, agentId)`. That output is an
 * ENCRYPTION KEY: the same section says the migration "MUST decrypt each
 * existing key … and re-encrypt using the new KDF", and the `AgentCredential`
 * contract says the key is "stored encrypted at rest". But the variable was
 * named `apiKey`, and T355 implemented it literally. `createProjectAgent`,
 * `update` and `rotateKey` in `agent-registry-accessor.ts` stored the hex of
 * the HMAC in `api_key_encrypted` and DISCARDED the real key, including the
 * fresh key the cloud returned from `rotate-key`. The reader then returned hex
 * of that hex as `apiKey`. Every consumer sends it as `Authorization: Bearer`
 * to SignalDock (`cleo agent …`, `conduit` dispatch, the HTTP/SSE transports),
 * and every one of them needs the real key.
 *
 * ## What is stored now
 *
 * `api_key_encrypted` holds `gk1:` followed by {@link encryptGlobal}
 * ciphertext of the real key, under the global KDF ADR-037 intended, with
 * credential id `agent:<agentId>`. It is recoverable after a restart. It moves
 * to another device via the passphrase-sealed credential transfer
 * (`store/credential-transfer.ts`), never by copying the machine-key.
 *
 * ## Rows written before the fix
 *
 * They hold 64 hex characters (the HMAC) or an unrecognised legacy value.
 * Neither contains the real key, so neither can be migrated. To avoid changing
 * behaviour for anything that depends on today's value, they are read back
 * exactly as before, but flagged `requiresReauth` with the command that
 * re-registers the agent's real key.
 *
 * @task T12352
 * @module store/agent-api-key
 */

import { type CredentialKeyOptions, decryptGlobal, encryptGlobal } from '../crypto/credentials.js';

/** Prefix marking an `api_key_encrypted` value as a T12352 global-KDF ciphertext. */
export const AGENT_KEY_CIPHERTEXT_PREFIX = 'gk1:';

/** Shape of a pre-T12352 value: the hex HMAC the old code stored instead of the key. */
const LEGACY_DERIVED_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The global-KDF credential id for an agent's API key. The `agent:` prefix
 * separates agent keys from other global credentials (`service:<p>:<l>`).
 *
 * @param agentId - Agent business identifier.
 * @returns The id passed to {@link encryptGlobal} / {@link decryptGlobal}.
 * @task T12352
 */
export function agentKeyCredentialId(agentId: string): string {
  return `agent:${agentId}`;
}

/**
 * How an `api_key_encrypted` value was written.
 *
 * - `none` — empty / NULL.
 * - `ciphertext` — a T12352 `gk1:` global-KDF ciphertext (recoverable).
 * - `legacy-derived` — the pre-T12352 hex HMAC (the real key was discarded).
 * - `legacy-unknown` — anything else (e.g. a pre-T310 path-KDF ciphertext).
 *
 * @task T12352
 */
export type StoredAgentKeyKind = 'none' | 'ciphertext' | 'legacy-derived' | 'legacy-unknown';

/**
 * Classify a stored `api_key_encrypted` value without decrypting it.
 *
 * @param stored - Raw column value.
 * @returns Its kind.
 * @task T12352
 */
export function classifyStoredAgentKey(stored: string | null | undefined): StoredAgentKeyKind {
  if (stored === null || stored === undefined || stored === '') return 'none';
  if (stored.startsWith(AGENT_KEY_CIPHERTEXT_PREFIX)) return 'ciphertext';
  if (LEGACY_DERIVED_PATTERN.test(stored)) return 'legacy-derived';
  return 'legacy-unknown';
}

/**
 * Encrypt an agent API key for `api_key_encrypted`.
 *
 * @param apiKey - The real key (e.g. `sk_live_…`). Empty yields `null`.
 * @param agentId - Agent business identifier (binds the key derivation).
 * @param options - Which CLEO home's machine-key + salt (defaults to ambient).
 * @returns `gk1:<ciphertext>`, or `null` when there is no key to store.
 * @task T12352
 */
export async function sealAgentApiKey(
  apiKey: string,
  agentId: string,
  options: CredentialKeyOptions = {},
): Promise<string | null> {
  if (apiKey.length === 0) return null;
  return (
    AGENT_KEY_CIPHERTEXT_PREFIX +
    (await encryptGlobal(apiKey, agentKeyCredentialId(agentId), options))
  );
}

/**
 * Result of reading a stored agent API key.
 *
 * @task T12352
 */
export interface AgentApiKeyRead {
  /** The value to expose as `AgentCredential.apiKey`. */
  readonly apiKey: string;
  /** Kind of the stored value. */
  readonly kind: StoredAgentKeyKind;
  /**
   * True when the real key is not recoverable from storage and must be
   * re-registered: legacy values, or a ciphertext this device cannot decrypt.
   */
  readonly requiresReauth: boolean;
  /** Why re-registration is needed (absent when not). */
  readonly reason?: string;
}

/**
 * The value pre-T12352 readers returned for a stored string: its UTF-8 bytes
 * as hex. Kept for legacy rows so their observable `apiKey` does not change.
 */
function legacyReadValue(stored: string): string {
  return Buffer.from(stored).toString('hex');
}

/**
 * Read an agent API key from `api_key_encrypted`.
 *
 * A `gk1:` ciphertext is decrypted to the real key. Legacy values are returned
 * exactly as the pre-T12352 reader returned them, so nothing that works today
 * changes, but they are flagged `requiresReauth`. A ciphertext that does not
 * decrypt here (another device's key) is flagged too; it never throws, because
 * a listing must not fail on one bad row.
 *
 * @param stored - Raw column value.
 * @param agentId - Agent business identifier.
 * @param options - Which CLEO home's machine-key + salt (defaults to ambient).
 * @returns The key to expose, its kind, and whether re-registration is needed.
 * @task T12352
 */
export async function openAgentApiKey(
  stored: string | null | undefined,
  agentId: string,
  options: CredentialKeyOptions = {},
): Promise<AgentApiKeyRead> {
  const kind = classifyStoredAgentKey(stored);
  if (kind === 'none' || stored === null || stored === undefined) {
    return { apiKey: '', kind, requiresReauth: false };
  }
  if (kind === 'ciphertext') {
    try {
      const apiKey = await decryptGlobal(
        stored.slice(AGENT_KEY_CIPHERTEXT_PREFIX.length),
        agentKeyCredentialId(agentId),
        options,
      );
      return { apiKey, kind, requiresReauth: false };
    } catch (err) {
      return {
        apiKey: '',
        kind,
        requiresReauth: true,
        reason: `stored key does not decrypt on this device: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return {
    apiKey: legacyReadValue(stored),
    kind,
    requiresReauth: true,
    reason:
      kind === 'legacy-derived'
        ? 'stored before T12352: the column holds a derived HMAC, not the API key, which was discarded'
        : 'stored in an unrecognised legacy format that does not contain a recoverable API key',
  };
}
