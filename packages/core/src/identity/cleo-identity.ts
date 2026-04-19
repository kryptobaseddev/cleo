/**
 * CLEO signing identity — adapter over `llmtxt/identity` for audit-trail signing.
 *
 * This module owns the CLEO-specific persistence of an Ed25519 keypair used to
 * sign `.cleo/audit/*.jsonl` entries and `cleo bug` severity attestations. It
 * reuses every cryptographic primitive from {@link module:llmtxt/identity} so
 * there is **zero duplication of signing primitives** (T947 Constraint #4).
 *
 * ## Key storage
 *
 * Unlike `llmtxt/identity` (which persists to `~/.llmtxt/identity.key`), the
 * CLEO identity persists to the **project's** `.cleo/keys/cleo-identity.json`
 * so each project has its own signing key by default. This prevents a single
 * compromised key from invalidating audit trails across unrelated projects.
 *
 * - File path: `<projectRoot>/.cleo/keys/cleo-identity.json`
 * - File mode: `0o600` (owner read/write only) — enforced programmatically.
 * - File format: `{ "sk": "<64-char hex>", "pk": "<64-char hex>" }`
 *
 * ## Deterministic dev/test mode
 *
 * When `CLEO_IDENTITY_SEED` env var is set to a 64-char hex string, the
 * identity is derived deterministically from that seed and **not persisted**.
 * This is intended for test harnesses and reproducible CI signing.
 *
 * @task T947
 * @adr ADR-054 (draft)
 * @see {@link module:llmtxt/identity}
 */

import { chmod, constants, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AgentIdentity, identityFromSeed, verifySignature } from 'llmtxt/identity';
import { getCleoDirAbsolute } from '../paths.js';

/**
 * Re-export the {@link AgentIdentity} class so callers can import everything
 * identity-related from `@cleocode/core/identity` without reaching into the
 * `llmtxt` subpath directly.
 */
export { AgentIdentity };

/**
 * On-disk shape of `.cleo/keys/cleo-identity.json`.
 *
 * Both `sk` (secret key seed) and `pk` (public key) are 64-char lowercase
 * hexadecimal strings. The secret key MUST be treated as sensitive data —
 * never log it, never commit it, and always store the file with mode `0o600`.
 *
 * @task T947
 */
export interface CleoIdentityFile {
  /** 64-char lowercase hex of the 32-byte Ed25519 secret key seed. */
  sk: string;
  /** 64-char lowercase hex of the 32-byte Ed25519 public key. */
  pk: string;
}

/**
 * Signed audit envelope attached to a JSONL line.
 *
 * The `sig` field is a 128-char lowercase hex encoding of the 64-byte Ed25519
 * signature over the UTF-8 bytes of the unsigned canonical JSON line.
 * The `pub` field is the 64-char lowercase hex public key used to verify it.
 *
 * @task T947
 */
export interface AuditSignature {
  /** Hex-encoded 64-byte Ed25519 signature (128 chars). */
  sig: string;
  /** Hex-encoded 32-byte Ed25519 public key (64 chars). */
  pub: string;
}

/** Environment variable that overrides the identity with a deterministic seed. */
const SEED_ENV = 'CLEO_IDENTITY_SEED';

/** Relative path to the identity key file under the project `.cleo/` dir. */
const KEY_RELATIVE_PATH = join('keys', 'cleo-identity.json');

/**
 * Resolve the absolute path to the CLEO identity key file.
 *
 * @param cwd - Optional working directory; defaults to `process.cwd()`.
 * @returns Absolute path to `<projectRoot>/.cleo/keys/cleo-identity.json`.
 *
 * @task T947
 */
export function getCleoIdentityPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), KEY_RELATIVE_PATH);
}

/**
 * Decode a lowercase-hex string into a `Uint8Array`.
 * Throws `TypeError` on invalid input (odd length or non-hex chars).
 *
 * @internal
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new TypeError(`invalid hex length: ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new TypeError(`invalid hex at offset ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}

/**
 * Encode a `Uint8Array` as lowercase hex.
 *
 * @internal
 */
function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Try to load a persisted identity. Returns `null` when the file is missing
 * or malformed; never throws. Callers should fall back to
 * {@link generateAndPersistIdentity} on `null`.
 *
 * @internal
 */
async function loadPersistedIdentity(keyPath: string): Promise<AgentIdentity | null> {
  let raw: string;
  try {
    raw = await readFile(keyPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { sk?: unknown }).sk !== 'string' ||
    typeof (parsed as { pk?: unknown }).pk !== 'string'
  ) {
    return null;
  }

  const file = parsed as CleoIdentityFile;
  if (file.sk.length !== 64 || file.pk.length !== 64) {
    return null;
  }

  try {
    const seed = hexToBytes(file.sk);
    return await identityFromSeed(seed);
  } catch {
    return null;
  }
}

/**
 * Generate a fresh Ed25519 keypair, persist it to `keyPath` with mode 0600,
 * and return the resulting {@link AgentIdentity}.
 *
 * The secret-key seed is generated through the llmtxt identity factory to
 * inherit its `@noble/ed25519` RNG — we only customise the storage location.
 *
 * @internal
 */
async function generateAndPersistIdentity(keyPath: string): Promise<AgentIdentity> {
  // Generate a random 32-byte seed via WebCrypto (available in Node ≥19 and browsers).
  const seed = new Uint8Array(32);
  globalThis.crypto.getRandomValues(seed);

  const identity = await identityFromSeed(seed);
  const file: CleoIdentityFile = {
    sk: bytesToHex(seed),
    pk: identity.pubkeyHex,
  };

  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, JSON.stringify(file), { mode: 0o600 });
  // writeFile's `mode` is advisory on some platforms (umask may intervene);
  // enforce 0600 explicitly so automated tests can assert the property.
  try {
    await chmod(keyPath, constants.S_IRUSR | constants.S_IWUSR);
  } catch {
    // chmod may fail on Windows; the mode argument above is best-effort there.
  }

  return identity;
}

/**
 * Load-or-generate the persistent CLEO signing identity.
 *
 * Resolution order:
 * 1. `CLEO_IDENTITY_SEED` env var (64-char hex) → derive deterministically,
 *    do NOT persist. Intended for tests and CI.
 * 2. Persisted file at `<cleoDir>/keys/cleo-identity.json` → load.
 * 3. No file present → generate a fresh keypair and persist it with mode 0600.
 *
 * @param cwd - Optional working directory for project-root resolution.
 * @returns A ready-to-use {@link AgentIdentity}.
 *
 * @example
 * ```ts
 * const id = await getCleoIdentity();
 * const { signature, pubkey } = await signAuditLine(id, lineJson);
 * ```
 *
 * @task T947
 */
export async function getCleoIdentity(cwd?: string): Promise<AgentIdentity> {
  const seedEnv = process.env[SEED_ENV];
  if (seedEnv !== undefined && seedEnv.length === 64) {
    const seed = hexToBytes(seedEnv);
    return identityFromSeed(seed);
  }

  const keyPath = getCleoIdentityPath(cwd);
  const existing = await loadPersistedIdentity(keyPath);
  if (existing !== null) {
    return existing;
  }

  return generateAndPersistIdentity(keyPath);
}

/**
 * Sign an audit JSONL line with the supplied identity.
 *
 * The canonical bytes are the UTF-8 encoding of the raw `line` string (with
 * no trailing newline). Callers MUST pass the exact line they intend to
 * persist — the verifier re-hashes the same bytes.
 *
 * @param identity - CLEO signing identity (from {@link getCleoIdentity}).
 * @param line - JSONL line to sign (no trailing newline).
 * @returns Hex-encoded signature and pubkey.
 *
 * @task T947
 */
export async function signAuditLine(
  identity: AgentIdentity,
  line: string,
): Promise<AuditSignature> {
  const bytes = new TextEncoder().encode(line);
  const rawSig = await identity.sign(bytes);
  return {
    sig: bytesToHex(rawSig),
    pub: identity.pubkeyHex,
  };
}

/**
 * Verify an audit line's signature against a given pubkey.
 *
 * @param line - The original JSONL line that was signed (no trailing newline).
 * @param signature - Hex-encoded 64-byte Ed25519 signature.
 * @param pubkey - Hex-encoded 32-byte Ed25519 public key.
 * @returns `true` iff the signature is valid for (line, pubkey).
 *
 * @task T947
 */
export async function verifyAuditLine(
  line: string,
  signature: string,
  pubkey: string,
): Promise<boolean> {
  if (signature.length !== 128 || pubkey.length !== 64) {
    return false;
  }
  const bytes = new TextEncoder().encode(line);
  return verifySignature(bytes, signature, pubkey);
}
