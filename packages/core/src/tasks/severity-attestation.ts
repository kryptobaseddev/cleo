/**
 * System-wide severity attestation primitive (T9071 / ADR-054 draft).
 *
 * Severity attestation fires for ANY task that carries a `--severity` flag,
 * not only `cleo bug` entries. This module extracts the attestation logic
 * that previously lived only in `packages/cleo/src/cli/commands/bug.ts` into
 * a shared core helper so any command — bug, task-add, sprint-add, etc. —
 * can produce a signed audit line without duplicating logic.
 *
 * ## Audit log
 *
 * Signed attestation lines are appended to
 * `.cleo/audit/severity-attestation.jsonl` (one JSON object per line).  The
 * previous path `.cleo/audit/bug-severity.jsonl` was bug-command-specific;
 * callers that still write to the old path will see a one-time deprecation
 * notice emitted to stderr — migration to the new path is separate cleanup.
 *
 * ## Owner-pubkey allowlist
 *
 * If `.cleo/config.json` declares an `ownerPubkeys` array, only identities
 * whose Ed25519 public key (hex) appears in that list may assert a severity.
 * Signers outside the allowlist receive an error with `code: 'E_OWNER_ONLY'`.
 * When the allowlist is absent or empty, any identity may sign (opt-in policy).
 *
 * @task T9071
 * @adr ADR-054 (draft)
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { SeverityAttestation } from '@cleocode/contracts';
import { getCleoIdentity, signAuditLine } from '../identity/cleo-identity.js';
import { getCleoDirAbsolute, getConfigPath } from '../paths.js';

export type { SeverityAttestation };

/**
 * Audit log path for severity attestations.
 *
 * Changed from the earlier `bug-severity.jsonl` (which was scoped to
 * `cleo bug`) to the generic `severity-attestation.jsonl` so any command
 * that carries `--severity` contributes to the same audit trail.
 *
 * @internal
 */
export const SEVERITY_ATTESTATION_AUDIT_FILE = 'severity-attestation.jsonl';

/**
 * Legacy audit log path (bug.ts era). Callers that still write here will
 * see a deprecation notice. Do NOT write new entries to this path.
 *
 * @internal
 */
export const LEGACY_BUG_SEVERITY_AUDIT_FILE = 'bug-severity.jsonl';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Load the owner-pubkey allowlist from `.cleo/config.json`. Returns an empty
 * array when the file is missing, malformed, or does not declare the field.
 *
 * @param cwd - Optional working directory override (defaults to `process.cwd()`).
 * @internal
 */
export async function loadOwnerPubkeys(cwd?: string): Promise<string[]> {
  const configPath = getConfigPath(cwd);
  if (!existsSync(configPath)) {
    return [];
  }
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return [];
    }
    const list = (parsed as { ownerPubkeys?: unknown }).ownerPubkeys;
    if (!Array.isArray(list)) {
      return [];
    }
    return list.filter((v): v is string => typeof v === 'string' && v.length === 64);
  } catch {
    return [];
  }
}

/**
 * Produce a stable JSON serialisation of the attestation (sorted keys) so
 * the bytes passed to the signer match what a verifier re-serialises.
 *
 * @param record - The full attestation record including `signerPub`.
 * @returns Deterministic JSON string with keys sorted alphabetically.
 * @internal
 */
export function canonicalAttestationJson(record: SeverityAttestation): string {
  const sortedKeys = (Object.keys(record) as Array<keyof SeverityAttestation>).sort();
  const ordered: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    ordered[key] = record[key];
  }
  return JSON.stringify(ordered);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for {@link appendSignedSeverityAttestation}.
 */
export interface AppendSeverityAttestationOptions {
  /**
   * Optional working directory override. Determines which `.cleo/` directory
   * receives the audit line and which `config.json` is checked for the
   * `ownerPubkeys` allowlist.
   *
   * Defaults to `process.cwd()`.
   */
  cwd?: string;
}

/**
 * Append a signed severity attestation to
 * `.cleo/audit/severity-attestation.jsonl`.
 *
 * Throws a shaped error with `code: 'E_OWNER_ONLY'` when the signer's pubkey
 * is not in the configured `ownerPubkeys` allowlist (allowlist enforcement is
 * only active when the list is non-empty).
 *
 * @param taskId  - Task ID, if already assigned at attestation time.
 * @param record  - Attestation fields (excluding `signerPub` which is derived
 *                  from the local CLEO identity).
 * @param options - Optional overrides (e.g. `cwd`).
 *
 * @throws `Error` with `code: 'E_OWNER_ONLY'` when the allowlist rejects the
 *   signer.
 *
 * @example
 * ```ts
 * await appendSignedSeverityAttestation(
 *   {
 *     timestamp: new Date().toISOString(),
 *     title: 'Fix crash on login',
 *     severity: 'P1',
 *     epic: 'T100',
 *   },
 * );
 * ```
 */
export async function appendSignedSeverityAttestation(
  record: Omit<SeverityAttestation, 'signerPub'>,
  options?: AppendSeverityAttestationOptions,
): Promise<void> {
  const cwd = options?.cwd;
  const id = await getCleoIdentity();
  const owners = await loadOwnerPubkeys(cwd);

  if (owners.length > 0 && !owners.includes(id.pubkeyHex)) {
    const err = new Error(
      `E_OWNER_ONLY: severity attestation requires an owner-allowlisted identity (pub=${id.pubkeyHex.slice(0, 8)}…). Add your public key to .cleo/config.json "ownerPubkeys" array to authorise.`,
    );
    (err as Error & { code?: string }).code = 'E_OWNER_ONLY';
    throw err;
  }

  const full: SeverityAttestation = { ...record, signerPub: id.pubkeyHex };
  const canonical = canonicalAttestationJson(full);
  const sig = await signAuditLine(id, canonical);

  const line = `${JSON.stringify({ ...full, _sig: sig })}\n`;
  const auditPath = join(getCleoDirAbsolute(cwd), 'audit', SEVERITY_ATTESTATION_AUDIT_FILE);
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(auditPath, line, { encoding: 'utf-8' });
}
