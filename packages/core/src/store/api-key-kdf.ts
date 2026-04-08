/**
 * API key derivation functions for the T310 conduit/signaldock separation.
 *
 * New KDF (T310):
 *   HMAC-SHA256(machineKey || globalSalt, utf8(agentId)) → 32 bytes
 *
 * Legacy KDF (pre-T310, migration use only):
 *   HMAC-SHA256(machineKey, utf8(projectPath)) → 32 bytes
 *
 * The new scheme binds each key to machine + per-machine salt + agent identity,
 * replacing the project-path scheme that does not generalise to global-tier identity.
 *
 * T355 will compose these primitives with `getGlobalSalt()` (T348).
 * This module has NO runtime dependency on global-salt.ts.
 *
 * @task T349
 * @epic T310
 * @see ADR-037 §5 — KDF contract
 * @module store/api-key-kdf
 */

import { createHmac } from 'node:crypto';

/**
 * Input parameters for the new T310 KDF.
 *
 * @task T349
 * @epic T310
 */
export interface DeriveApiKeyInput {
  /** Machine-local key from the existing machine-key mechanism (v2026.4.11). */
  machineKey: Buffer;
  /** 32-byte global salt from global-salt.ts (T348). */
  globalSalt: Buffer;
  /** Agent ID that the API key belongs to. */
  agentId: string;
}

/**
 * Derives a 32-byte API key using the new T310 KDF:
 *
 *   HMAC-SHA256(machineKey || globalSalt, utf8(agentId)) → 32 bytes
 *
 * Binds the key to machine + per-machine salt + agent identity. Replaces
 * the pre-T310 `HMAC-SHA256(machineKey, projectPath)` scheme, which does
 * not generalise to global-tier identity.
 *
 * @param input - The derivation input parameters.
 * @returns A 32-byte Buffer containing the derived API key.
 * @throws {Error} If machineKey is empty, globalSalt is not exactly 32 bytes,
 *   or agentId is empty.
 *
 * @task T349
 * @epic T310
 */
export function deriveApiKey(input: DeriveApiKeyInput): Buffer {
  if (input.machineKey.length === 0) {
    throw new Error('deriveApiKey: machineKey cannot be empty');
  }
  if (input.globalSalt.length !== 32) {
    throw new Error(
      `deriveApiKey: globalSalt must be exactly 32 bytes, got ${input.globalSalt.length}`,
    );
  }
  if (input.agentId.length === 0) {
    throw new Error('deriveApiKey: agentId cannot be empty');
  }

  const key = Buffer.concat([input.machineKey, input.globalSalt]);
  const hmac = createHmac('sha256', key);
  hmac.update(input.agentId, 'utf8');
  return hmac.digest();
}

/**
 * Derives the LEGACY pre-T310 API key using the old project-path scheme:
 *
 *   HMAC-SHA256(machineKey, utf8(projectPath)) → 32 bytes
 *
 * Used ONLY by the migration executor (T358) to identify old keys that need
 * invalidation. Not for ongoing use after T310.
 *
 * @param machineKey - Machine-local key from the existing machine-key mechanism.
 * @param projectPath - Project path used as the HMAC message in the old scheme.
 * @returns A 32-byte Buffer containing the derived legacy key.
 * @throws {Error} If machineKey is empty or projectPath is empty.
 *
 * @deprecated Use deriveApiKey() for all new code. This exists for migration
 *   identification only (T358). Any new caller is a bug.
 *
 * @task T349
 * @epic T310
 */
export function deriveLegacyProjectKey(machineKey: Buffer, projectPath: string): Buffer {
  if (machineKey.length === 0) {
    throw new Error('deriveLegacyProjectKey: machineKey cannot be empty');
  }
  if (projectPath.length === 0) {
    throw new Error('deriveLegacyProjectKey: projectPath cannot be empty');
  }
  const hmac = createHmac('sha256', machineKey);
  hmac.update(projectPath, 'utf8');
  return hmac.digest();
}
