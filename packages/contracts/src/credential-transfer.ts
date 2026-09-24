/**
 * Credential transfer contracts — moving stored secrets between devices
 * without moving the device key.
 *
 * CLEO encrypts stored credentials under a key derived from the local
 * `machine-key`. That key never leaves the device (it is excluded from every
 * backup bundle, encrypted or not). A credential therefore crosses devices in
 * one of two ways:
 *
 * - **Sealed** — an encrypted backup carries the credentials re-sealed under a
 *   key derived from the user's passphrase; the importing device unseals them
 *   and re-encrypts each one under ITS OWN machine-key.
 * - **Re-entered** — an unencrypted backup carries no usable credential
 *   material; the import lists every credential to re-enter, each with the
 *   exact command that re-enters it.
 *
 * @task T12326
 * @module credential-transfer
 */

/**
 * The store a credential lives in.
 *
 * - `project-agent` — `tasks_agent_credentials.api_key_encrypted` in the
 *   project `cleo.db` (project KDF).
 * - `service-connection` — `service_connections.credentials_enc` in the global
 *   `cleo.db` (global KDF, id `service:<provider>:<label>`).
 * - `llm-pool` — an entry in `<cleoHome>/llm-credentials.json`.
 * - `agent-registry` — `agent_registry_agents.api_key_encrypted` in the global
 *   `cleo.db` (global KDF, id `agent:<agentId>`, `gk1:` prefix — T12352).
 *
 * @task T12326
 * @task T12352
 */
export type CredentialStoreKind =
  | 'project-agent'
  | 'service-connection'
  | 'llm-pool'
  | 'agent-registry';

/**
 * A credential identified WITHOUT its value — safe to print, log, or write
 * into a bundle manifest.
 *
 * @task T12326
 */
export interface CredentialDescriptor {
  /** Which store holds the credential. */
  readonly store: CredentialStoreKind;
  /**
   * Stable identity within the store: the agent id (`project-agent`,
   * `agent-registry`),
   * `<provider>:<label>` (`service-connection`, `llm-pool`).
   */
  readonly id: string;
  /** Human-readable description of the credential. */
  readonly label: string;
}

/**
 * A credential the target device must re-enter, with the one command that
 * re-enters it.
 *
 * @task T12326
 */
export interface CredentialReentry extends CredentialDescriptor {
  /** Why the credential could not be carried over. */
  readonly reason: string;
  /** The exact CLI command that re-enters this credential (secret shown as a placeholder). */
  readonly reentryCommand: string;
}

/**
 * Outcome of sealing the local credentials under a passphrase.
 *
 * @task T12326
 */
export interface SealCredentialsResult {
  /** Sealed payload bytes (passphrase-encrypted). Never contains machine-key material. */
  readonly sealed: Uint8Array;
  /** Credentials carried in the sealed payload. */
  readonly sealedCredentials: readonly CredentialDescriptor[];
  /** Credentials that could not be decrypted locally and must be re-entered after restore. */
  readonly reentry: readonly CredentialReentry[];
}

/**
 * Outcome of unsealing a payload into the local stores.
 *
 * @task T12326
 */
export interface UnsealCredentialsResult {
  /** Credentials re-encrypted under the local machine-key and written. */
  readonly restored: readonly CredentialDescriptor[];
  /** Credentials the operator must re-enter, each with its command. */
  readonly reentry: readonly CredentialReentry[];
}

/**
 * Outcome of migrating project credentials from the legacy path-bound KDF to
 * the project-identity KDF.
 *
 * @task T12326
 */
export interface ProjectCredentialMigrationResult {
  /** Credentials re-encrypted from the legacy path KDF to the project-id KDF. */
  readonly migrated: readonly CredentialDescriptor[];
  /** Credentials already under the project-id KDF (untouched). */
  readonly current: readonly CredentialDescriptor[];
  /** Credentials no candidate key could decrypt — ciphertext left untouched. */
  readonly reentry: readonly CredentialReentry[];
}
