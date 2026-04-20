/**
 * CLEO KMS Adapter — `CLEO_KMS_ADAPTER` key-backend selector.
 *
 * Exports {@link loadSigningIdentity} which returns an `AgentIdentity`
 * from `llmtxt/identity` using the backend selected by the
 * `CLEO_KMS_ADAPTER` environment variable.
 *
 * Supported backends:
 *
 * | Adapter | Env var value | Key source |
 * |---------|---------------|------------|
 * | `env`   | `"env"`       | `CLEO_SIGNING_SEED` (64-char hex) |
 * | `file`  | `"file"` (default) | `.cleo/keys/sentient.ed25519` (mode 0600) |
 * | `vault` | `"vault"`     | HashiCorp Vault `transit/` engine (stub) |
 * | `aws`   | `"aws"`       | AWS KMS Ed25519 key (stub) |
 *
 * Dev/CI: use `env` adapter. Production: use `vault` or `aws`.
 *
 * The daemon process owns the signing context. The experiment agent
 * container NEVER receives the key material directly (closes Round 2
 * attack #3 — mode-0600 keyfile is accessible to the host OS user).
 *
 * @see DESIGN.md §4.2 — KMS adapter abstraction
 * @task T1021
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentIdentity } from 'llmtxt/identity';
import { identityFromSeed } from 'llmtxt/identity';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Supported CLEO KMS adapter backends.
 *
 * Selected by the `CLEO_KMS_ADAPTER` environment variable.
 * Defaults to `"file"` for backward compatibility with ADR-054.
 */
export type KmsAdapterKind = 'env' | 'file' | 'vault' | 'aws';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default path for the file-backed Ed25519 seed (relative to projectRoot). */
const FILE_KEY_PATH = '.cleo/keys/sentient.ed25519';

/** Required file permission mode for the file-backend keyfile. */
const REQUIRED_FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a signing identity using the backend selected by `CLEO_KMS_ADAPTER`.
 *
 * The returned `AgentIdentity` from `llmtxt/identity` provides `sign()`,
 * `verify()`, and `pubkeyHex` without exposing raw private-key bytes to
 * callers. The private key is only read once per call; caching is the
 * caller's responsibility.
 *
 * @param projectRoot - Absolute path to the CLEO project root. Used by the
 *   `file` adapter to locate `.cleo/keys/sentient.ed25519`.
 * @returns An `AgentIdentity` constructed from the selected backend.
 * @throws If the selected backend cannot load key material (missing env var,
 *   wrong file permissions, network error, etc.).
 *
 * @example
 * ```ts
 * import { loadSigningIdentity } from '@cleocode/core/sentient/kms.js';
 *
 * const identity = await loadSigningIdentity(projectRoot);
 * const sig = await identity.sign(Buffer.from('hello'));
 * ```
 */
export async function loadSigningIdentity(projectRoot: string): Promise<AgentIdentity> {
  const adapter = resolveAdapterKind();

  switch (adapter) {
    case 'env':
      return loadEnvIdentity();
    case 'file':
      return loadFileIdentity(projectRoot);
    case 'vault':
      return loadVaultIdentity();
    case 'aws':
      return loadAwsIdentity();
    default: {
      // Exhaustive check — TypeScript will catch unhandled variants.
      const _exhaustive: never = adapter;
      throw new Error(`Unknown CLEO_KMS_ADAPTER: ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter kind resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the adapter kind from `CLEO_KMS_ADAPTER` environment variable.
 *
 * Defaults to `"file"` when the variable is absent or empty.
 *
 * @throws If the value is set but not one of the valid adapter kinds.
 */
export function resolveAdapterKind(): KmsAdapterKind {
  const raw = process.env['CLEO_KMS_ADAPTER'];
  if (!raw || raw.trim() === '') {
    return 'file';
  }
  const value = raw.trim().toLowerCase();
  if (value === 'env' || value === 'file' || value === 'vault' || value === 'aws') {
    return value as KmsAdapterKind;
  }
  throw new Error(`Invalid CLEO_KMS_ADAPTER="${raw}". Valid values: env, file, vault, aws.`);
}

// ---------------------------------------------------------------------------
// env adapter
// ---------------------------------------------------------------------------

/**
 * Load an `AgentIdentity` from the `CLEO_SIGNING_SEED` environment variable.
 *
 * `CLEO_SIGNING_SEED` must be a 64-character lowercase hex string encoding
 * a 32-byte Ed25519 seed. Suitable for development and CI pipelines where
 * secrets are injected as environment variables.
 *
 * @throws If `CLEO_SIGNING_SEED` is absent, malformed, or not exactly 64 hex chars.
 */
export async function loadEnvIdentity(): Promise<AgentIdentity> {
  const seedHex = process.env['CLEO_SIGNING_SEED'];
  if (!seedHex || seedHex.trim() === '') {
    throw new Error(
      'CLEO_KMS_ADAPTER=env requires CLEO_SIGNING_SEED to be set ' +
        '(64-char hex-encoded Ed25519 seed).',
    );
  }
  const trimmed = seedHex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      `CLEO_SIGNING_SEED must be exactly 64 hex characters (32-byte Ed25519 seed). ` +
        `Got ${trimmed.length} characters.`,
    );
  }
  const seed = hexToBytes(trimmed);
  return identityFromSeed(seed);
}

// ---------------------------------------------------------------------------
// file adapter
// ---------------------------------------------------------------------------

/**
 * Load an `AgentIdentity` from a keyfile on disk.
 *
 * The keyfile must be located at `<projectRoot>/.cleo/keys/sentient.ed25519`
 * and must have UNIX permissions `0600` (owner read+write only).
 * The file must contain exactly 32 raw bytes (the Ed25519 seed).
 *
 * Refuses to load if permissions are wider than 0600 — this closes the
 * Round 2 attack surface where a prompt-injected agent running as the same
 * OS user could read the key.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @throws If the keyfile is missing, has wrong permissions, or wrong size.
 */
export async function loadFileIdentity(projectRoot: string): Promise<AgentIdentity> {
  const keyPath = join(projectRoot, FILE_KEY_PATH);

  // Check file permissions before reading.
  let fileStat: { mode: number; size: number };
  try {
    fileStat = await stat(keyPath);
  } catch {
    throw new Error(
      `CLEO_KMS_ADAPTER=file: keyfile not found at ${keyPath}. ` +
        `Create it with: node -e "require('node:crypto').randomBytes(32)" > ${keyPath} && chmod 600 ${keyPath}`,
    );
  }

  const fileMode = fileStat.mode & 0o777;
  if (fileMode !== REQUIRED_FILE_MODE) {
    throw new Error(
      `CLEO_KMS_ADAPTER=file: keyfile ${keyPath} must have mode 0600 ` +
        `(current: 0${fileMode.toString(8)}). ` +
        `Run: chmod 600 ${keyPath}`,
    );
  }

  // Read the raw 32-byte seed.
  let bytes: Buffer;
  try {
    bytes = await readFile(keyPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`CLEO_KMS_ADAPTER=file: failed to read ${keyPath}: ${message}`);
  }

  if (bytes.length !== 32) {
    throw new Error(
      `CLEO_KMS_ADAPTER=file: keyfile ${keyPath} must contain exactly 32 bytes ` +
        `(Ed25519 seed). Got ${bytes.length} bytes.`,
    );
  }

  return identityFromSeed(new Uint8Array(bytes));
}

// ---------------------------------------------------------------------------
// vault adapter (stub)
// ---------------------------------------------------------------------------

/**
 * Load an `AgentIdentity` backed by HashiCorp Vault's Transit Engine.
 *
 * **STUB implementation** — this adapter is an interface-compliance skeleton.
 * Full implementation requires a Vault SDK or direct HTTP calls to the
 * Transit Engine API endpoints:
 *
 * - `POST /v1/transit/sign/<key-name>` — sign a payload
 * - `POST /v1/transit/verify/<key-name>` — verify a signature
 * - `GET /v1/transit/keys/<key-name>` — retrieve public key
 *
 * Required environment variables:
 * - `VAULT_ADDR` — Vault server address (e.g. `https://vault.example.com`)
 * - `VAULT_TOKEN` — authentication token
 * - `CLEO_KMS_VAULT_KEY` — Transit key name (default: `cleo-sentient`)
 *
 * @throws Always throws with a descriptive message indicating this is a stub.
 */
export async function loadVaultIdentity(): Promise<AgentIdentity> {
  const vaultAddr = process.env['VAULT_ADDR'];
  const vaultToken = process.env['VAULT_TOKEN'];

  if (!vaultAddr || !vaultToken) {
    throw new Error(
      'CLEO_KMS_ADAPTER=vault requires VAULT_ADDR and VAULT_TOKEN to be set. ' +
        'Vault adapter is not yet fully implemented — provide a seed via ' +
        'CLEO_KMS_ADAPTER=env + CLEO_SIGNING_SEED for development.',
    );
  }

  // Stub: the production implementation would call the Vault Transit Engine.
  // Transit API reference:
  //   POST ${VAULT_ADDR}/v1/transit/sign/${keyName}
  //     Headers: X-Vault-Token: ${VAULT_TOKEN}
  //     Body: { "input": "<base64-payload>" }
  //     Response: { "data": { "signature": "vault:v1:<base64-sig>" } }
  //
  //   GET ${VAULT_ADDR}/v1/transit/keys/${keyName}
  //     Headers: X-Vault-Token: ${VAULT_TOKEN}
  //     Response: { "data": { "keys": { "1": { "public_key": "<base64-pub>" } } } }
  //
  // For now, throw to force explicit adapter selection.
  throw new Error(
    'CLEO_KMS_ADAPTER=vault is not yet fully implemented. ' +
      'Vault Transit Engine integration is planned for production deployment. ' +
      'Use CLEO_KMS_ADAPTER=env for development or CLEO_KMS_ADAPTER=aws for cloud.',
  );
}

// ---------------------------------------------------------------------------
// aws adapter (stub)
// ---------------------------------------------------------------------------

/**
 * Load an `AgentIdentity` backed by AWS KMS.
 *
 * **STUB implementation** — this adapter is an interface-compliance skeleton.
 * Full implementation requires `@aws-sdk/client-kms` or direct calls to the
 * AWS KMS API:
 *
 * - `Sign` — sign a message digest with the KMS key
 * - `Verify` — verify a signature
 * - `GetPublicKey` — retrieve the public key bytes
 *
 * Required environment variables:
 * - `CLEO_KMS_AWS_KEY_ID` — AWS KMS Key ARN or alias
 * - Standard AWS credentials: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
 *   `AWS_REGION` (or IAM role via instance metadata)
 *
 * AWS KMS Sign API (Ed25519):
 * ```
 * POST https://kms.<region>.amazonaws.com/
 *   Action: Sign
 *   KeyId: <CLEO_KMS_AWS_KEY_ID>
 *   Message: <base64-payload>
 *   MessageType: RAW
 *   SigningAlgorithm: ECDSA_SHA_256  (Ed25519 uses EdDSA; use KEY_SPEC: ECC_NIST_P256 or SM2)
 * ```
 *
 * @throws Always throws with a descriptive message indicating this is a stub.
 */
export async function loadAwsIdentity(): Promise<AgentIdentity> {
  const keyId = process.env['CLEO_KMS_AWS_KEY_ID'];

  if (!keyId) {
    throw new Error(
      'CLEO_KMS_ADAPTER=aws requires CLEO_KMS_AWS_KEY_ID to be set. ' +
        'AWS adapter is not yet fully implemented — provide a seed via ' +
        'CLEO_KMS_ADAPTER=env + CLEO_SIGNING_SEED for development.',
    );
  }

  // Stub: the production implementation would use @aws-sdk/client-kms.
  // KmsClient.send(new SignCommand({ KeyId, Message, SigningAlgorithm }))
  // KmsClient.send(new VerifyCommand({ KeyId, Message, Signature, SigningAlgorithm }))
  // KmsClient.send(new GetPublicKeyCommand({ KeyId }))
  throw new Error(
    'CLEO_KMS_ADAPTER=aws is not yet fully implemented. ' +
      'AWS KMS integration is planned for cloud deployment. ' +
      'Use CLEO_KMS_ADAPTER=env for development.',
  );
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Convert a hex string to a `Uint8Array`.
 *
 * @param hex - Lowercase or uppercase hex string (must be even-length).
 * @returns Byte array.
 * @internal
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/** Re-export AgentIdentity type for callers who import from this module. */
export type { AgentIdentity };
