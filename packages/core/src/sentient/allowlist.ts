/**
 * Owner pubkey allowlist for Tier 3 sentient operations.
 *
 * Reads `.cleo/config.json.ownerPubkeys` (array of base64-encoded Ed25519
 * public keys). Used by {@link verifyEventChain} and the revert-executor to
 * reject operations signed by non-owner keys.
 *
 * ## Cache
 *
 * Results are cached for {@link CACHE_TTL_MS} milliseconds (60 s by default).
 * Pass `{ noCache: true }` to force a reload from disk.
 *
 * ## Strict mode
 *
 * Set the environment variable `CLEO_STRICT_ALLOWLIST=1` to make
 * {@link isOwnerSigner} throw an error rather than log a warning when the
 * signer is not in the allowlist.
 *
 * @task T1027
 * @see packages/core/src/sentient/chain-walker.ts
 * @see packages/core/src/sentient/revert-executor.ts
 */

import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cache lifetime in milliseconds (60 seconds). */
export const CACHE_TTL_MS = 60_000;

/** Relative path to the CLEO config file from the project root. */
const CONFIG_PATH = '.cleo/config.json';

// ---------------------------------------------------------------------------
// Internal cache
// ---------------------------------------------------------------------------

/** In-process cache entry. Module-level so it survives across calls. */
let cache: { pubkeys: Uint8Array[]; expiresAt: number } | null = null;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Shape of the relevant fields in `.cleo/config.json` for the allowlist.
 */
export interface OwnerAllowlistConfig {
  /** Array of base64-encoded Ed25519 public keys (32 bytes each). */
  ownerPubkeys?: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the current owner pubkey allowlist as raw `Uint8Array` values.
 *
 * Reads `.cleo/config.json` and base64-decodes each entry in
 * `ownerPubkeys`. Results are cached for {@link CACHE_TTL_MS} ms.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param opts - Optional flags.
 * @param opts.noCache - When `true`, bypass the in-process cache and read from
 *   disk unconditionally.
 * @returns Array of Ed25519 public keys (Uint8Array, 32 bytes each). Empty
 *   array when the config file is absent or `ownerPubkeys` is not set.
 *
 * @example
 * ```ts
 * import { getOwnerPubkeys } from '@cleocode/core/sentient/allowlist.js';
 *
 * const keys = await getOwnerPubkeys('/home/user/project');
 * console.log(`${keys.length} owner keys configured`);
 * ```
 */
export async function getOwnerPubkeys(
  projectRoot: string,
  opts?: { noCache?: boolean },
): Promise<Uint8Array[]> {
  const now = Date.now();

  // Return from cache if still fresh and not bypassed.
  if (!opts?.noCache && cache !== null && now < cache.expiresAt) {
    return cache.pubkeys;
  }

  const configPath = join(projectRoot, CONFIG_PATH);
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch {
    // Config absent → empty allowlist.
    cache = { pubkeys: [], expiresAt: now + CACHE_TTL_MS };
    return [];
  }

  let config: OwnerAllowlistConfig;
  try {
    config = JSON.parse(raw) as OwnerAllowlistConfig;
  } catch {
    // Malformed config → empty allowlist (fail open, log warning).
    process.stderr.write(
      `[allowlist] Warning: failed to parse ${configPath} — treating ownerPubkeys as empty\n`,
    );
    cache = { pubkeys: [], expiresAt: now + CACHE_TTL_MS };
    return [];
  }

  const b64List: string[] = Array.isArray(config.ownerPubkeys) ? config.ownerPubkeys : [];
  const pubkeys: Uint8Array[] = b64List.map((b64) => new Uint8Array(Buffer.from(b64, 'base64')));

  cache = { pubkeys, expiresAt: now + CACHE_TTL_MS };
  return pubkeys;
}

/**
 * Check whether a given public key is in the owner allowlist.
 *
 * Comparison uses `crypto.timingSafeEqual` to prevent timing-oracle attacks.
 * Keys of different lengths are automatically rejected without leaking
 * comparison information.
 *
 * When the allowlist is empty **and** `CLEO_STRICT_ALLOWLIST=1` is not set,
 * this function returns `true` (permissive / bootstrapping mode) and writes
 * a warning to stderr so the owner knows they should populate the allowlist.
 *
 * When `CLEO_STRICT_ALLOWLIST=1` is set:
 * - An empty allowlist causes the function to return `false` immediately.
 * - A non-matching key causes the function to return `false`.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param pubkey - The raw Ed25519 public key to test (32-byte Uint8Array).
 * @returns `true` if the key is in the allowlist (or allowlist is empty and
 *   strict mode is off).
 *
 * @example
 * ```ts
 * import { isOwnerSigner } from '@cleocode/core/sentient/allowlist.js';
 *
 * const allowed = await isOwnerSigner(projectRoot, Buffer.from(event.pub, 'hex'));
 * if (!allowed) {
 *   process.stderr.write(`Warning: signer not in allowlist\n`);
 * }
 * ```
 */
export async function isOwnerSigner(projectRoot: string, pubkey: Uint8Array): Promise<boolean> {
  const strict = process.env['CLEO_STRICT_ALLOWLIST'] === '1';
  const allowlist = await getOwnerPubkeys(projectRoot);

  if (allowlist.length === 0) {
    if (strict) {
      // Hard reject — no keys are trusted when allowlist is empty in strict mode.
      return false;
    }
    // Bootstrapping mode: emit a warning but allow.
    process.stderr.write(
      '[allowlist] Warning: ownerPubkeys is empty — accepting all signers. ' +
        'Run `cleo sentient allowlist add <base64>` to populate the allowlist.\n',
    );
    return true;
  }

  for (const allowed of allowlist) {
    if (constantTimeCompare(pubkey, allowed)) {
      return true;
    }
  }

  return false;
}

/**
 * Add an Ed25519 public key (base64-encoded) to the owner allowlist.
 *
 * Reads `config.json`, appends the key (deduplicating if already present),
 * and writes back atomically via tmp-then-rename. Invalidates the in-process
 * cache.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param pubkeyBase64 - Base64-encoded Ed25519 public key (32 bytes).
 * @throws `Error` if the base64 string does not decode to exactly 32 bytes.
 *
 * @example
 * ```ts
 * import { addOwnerPubkey } from '@cleocode/core/sentient/allowlist.js';
 *
 * await addOwnerPubkey('/home/user/project', 'AAEC...==');
 * ```
 */
export async function addOwnerPubkey(projectRoot: string, pubkeyBase64: string): Promise<void> {
  validatePubkeyBase64(pubkeyBase64);

  const config = await readConfig(projectRoot);
  const existing: string[] = Array.isArray(config.ownerPubkeys) ? config.ownerPubkeys : [];

  // Deduplicate: skip if already present.
  if (!existing.includes(pubkeyBase64)) {
    config.ownerPubkeys = [...existing, pubkeyBase64];
    await writeConfig(projectRoot, config);
  }

  // Invalidate cache.
  cache = null;
}

/**
 * Remove an Ed25519 public key (base64-encoded) from the owner allowlist.
 *
 * Reads `config.json`, removes the matching entry, and writes back atomically.
 * Invalidates the in-process cache.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param pubkeyBase64 - Base64-encoded Ed25519 public key to remove.
 * @throws `Error` with code `E_ALLOWLIST_KEY_NOT_FOUND` if the key is not
 *   present in the allowlist.
 *
 * @example
 * ```ts
 * import { removeOwnerPubkey } from '@cleocode/core/sentient/allowlist.js';
 *
 * await removeOwnerPubkey('/home/user/project', 'AAEC...==');
 * ```
 */
export async function removeOwnerPubkey(projectRoot: string, pubkeyBase64: string): Promise<void> {
  const config = await readConfig(projectRoot);
  const existing: string[] = Array.isArray(config.ownerPubkeys) ? config.ownerPubkeys : [];

  const idx = existing.indexOf(pubkeyBase64);
  if (idx === -1) {
    const err = new Error(
      `E_ALLOWLIST_KEY_NOT_FOUND: pubkey not found in ownerPubkeys: ${pubkeyBase64}`,
    );
    (err as NodeJS.ErrnoException).code = 'E_ALLOWLIST_KEY_NOT_FOUND';
    throw err;
  }

  config.ownerPubkeys = existing.filter((_, i) => i !== idx);
  await writeConfig(projectRoot, config);

  // Invalidate cache.
  cache = null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compare two byte arrays in constant time.
 *
 * Arrays of unequal length immediately return `false` without leaking timing
 * information about the content. Uses `crypto.timingSafeEqual` for same-length
 * inputs.
 *
 * @internal
 */
function constantTimeCompare(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Validate that a base64 string decodes to exactly 32 bytes (Ed25519 pubkey).
 *
 * @param b64 - The base64 string to validate.
 * @throws `Error` if the decoded length is not 32 bytes.
 * @internal
 */
function validatePubkeyBase64(b64: string): void {
  const decoded = Buffer.from(b64, 'base64');
  if (decoded.byteLength !== 32) {
    throw new Error(
      `Invalid pubkey: expected 32 bytes after base64 decode, got ${decoded.byteLength}`,
    );
  }
}

/**
 * Read `.cleo/config.json` from disk, returning an empty object if absent.
 *
 * @internal
 */
async function readConfig(projectRoot: string): Promise<Record<string, unknown>> {
  const configPath = join(projectRoot, CONFIG_PATH);
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Write `.cleo/config.json` atomically via tmp-then-rename.
 *
 * @internal
 */
async function writeConfig(projectRoot: string, config: Record<string, unknown>): Promise<void> {
  const configPath = join(projectRoot, CONFIG_PATH);
  const tmpPath = `${configPath}.tmp`;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  await rename(tmpPath, configPath);
}
