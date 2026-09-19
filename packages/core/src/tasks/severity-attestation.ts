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
 * Task mutations persist signed assertions atomically in the task audit instead.
 * Standalone JSONL assertions do not prove a task mutation committed. The
 * previous path `.cleo/audit/bug-severity.jsonl` was bug-command-specific;
 * callers that still write to the old path will see a one-time deprecation
 * notice emitted to stderr — migration to the new path is separate cleanup.
 *
 * ## Owner-pubkey allowlist
 *
 * If `.cleo/config.json` declares an `ownerPubkeys` array, only identities
 * whose Ed25519 public key (hex) appears in that list may assert a severity.
 * Signers outside the allowlist receive a permission error naming `E_OWNER_ONLY`.
 * When the allowlist is absent or empty, any identity may sign (opt-in policy).
 *
 * @task T9071
 * @adr ADR-054 (draft)
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ExitCode,
  type SeverityAttestation,
  type SignedSeverityAttestation,
} from '@cleocode/contracts';
import { z } from 'zod';
import { CleoError } from '../errors.js';
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

const authorityConfigSchema = z.object({
  ownerPubkeys: z.array(z.string().regex(/^[a-fA-F0-9]{64}$/)).optional(),
});

/**
 * Read the project's opt-in severity signer allowlist.
 *
 * @param cwd - Explicit project root, otherwise the current project.
 * @returns Authorized keys; absent config or an absent/empty field returns an empty list.
 * @throws CleoError when configured authority cannot be read or validated.
 * @remarks An unreadable or malformed authority is not permission for every signer.
 * @example
 * ```ts
 * const owners = await loadOwnerPubkeys(projectRoot);
 * ```
 */
export async function loadOwnerPubkeys(cwd?: string): Promise<string[]> {
  const configPath = getConfigPath(cwd);
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw new CleoError(ExitCode.CONFIG_ERROR, 'Cannot read project severity authority', {
      details: { field: 'ownerPubkeys' },
      cause: error,
      fix: 'Restore readable project authority before changing task severity.',
    });
  }
  try {
    return authorityConfigSchema.parse(JSON.parse(raw)).ownerPubkeys ?? [];
  } catch (error) {
    throw new CleoError(ExitCode.CONFIG_ERROR, 'Invalid project severity authority configuration', {
      details: { field: 'ownerPubkeys' },
      cause: error,
      fix: 'Restore valid project configuration and an array of Ed25519 public keys.',
    });
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
  const ordered: Record<string, string | undefined> = {};
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
 * Throws a permission error naming `E_OWNER_ONLY` when the signer's pubkey
 * is not in the configured `ownerPubkeys` allowlist (allowlist enforcement is
 * only active when the list is non-empty).
 *
 * @param record  - Attestation fields (excluding `signerPub` which is derived
 *                  from the local CLEO identity).
 * @param options - Optional overrides (e.g. `cwd`).
 *
 * @throws CleoError with permission exit code when the allowlist rejects the signer.
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
  const signed = await prepareSignedSeverityAttestation(record, options);
  const line = `${JSON.stringify(signed)}\n`;
  const auditPath = join(getCleoDirAbsolute(cwd), 'audit', SEVERITY_ATTESTATION_AUDIT_FILE);
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(auditPath, line, { encoding: 'utf-8' });
}

/**
 * Authorize and sign a severity assertion without appending a filesystem log.
 *
 * Task mutations persist this result in their task transaction, binding the
 * signature to the assigned task ID. The established owner allowlist is opt-in:
 * absent or empty lists permit the local identity; nonempty lists restrict it.
 *
 * @param record - Assertion to bind to the project identity.
 * @param options - Explicit project used for both identity and owner policy.
 * @returns Signed assertion ready for atomic audit persistence.
 * @remarks Preparation creates no committed task evidence; persist in the task transaction.
 * @example
 * ```ts
 * const assertion = await prepareSignedSeverityAttestation({
 *   timestamp: new Date().toISOString(), taskId: 'T001',
 *   title: 'Restore service', severity: 'P1',
 * }, { cwd: projectRoot });
 * ```
 * @throws CleoError with permission exit code when the signer is not allowed.
 */
export async function prepareSignedSeverityAttestation(
  record: Omit<SeverityAttestation, 'signerPub'>,
  options?: AppendSeverityAttestationOptions,
): Promise<SignedSeverityAttestation> {
  const cwd = options?.cwd;
  const owners = await loadOwnerPubkeys(cwd);
  const id = await getCleoIdentity(cwd);
  if (owners.length > 0 && !owners.includes(id.pubkeyHex)) {
    throw new CleoError(
      ExitCode.NEXUS_PERMISSION_DENIED,
      `E_OWNER_ONLY: severity attestation requires an owner-allowlisted identity (pub=${id.pubkeyHex.slice(0, 8)}…).`,
      { details: { field: 'severity' }, fix: 'Use an identity authorized by the project owner.' },
    );
  }
  const full: SeverityAttestation = { ...record, signerPub: id.pubkeyHex };
  return { ...full, _sig: await signAuditLine(id, canonicalAttestationJson(full)) };
}
