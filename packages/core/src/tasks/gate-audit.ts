/**
 * Append-only gate audit trail for evidence-based verification (T832 / ADR-051).
 *
 * Every `cleo verify` write appends a single JSON line to
 * `.cleo/audit/gates.jsonl`.  Emergency overrides (`CLEO_OWNER_OVERRIDE=1`)
 * additionally append to `.cleo/audit/force-bypass.jsonl`.
 *
 * Writers MUST use {@link appendGateAuditLine} or
 * {@link appendForceBypassLine} — direct file writes are forbidden.
 *
 * Signed variants ({@link appendSignedGateAuditLine},
 * {@link verifyAuditHistory}) were added in T947 / ADR-054 (draft) and attach
 * an Ed25519 `_sig` field produced by `llmtxt/identity`. Unsigned entries
 * remain valid for backwards compatibility.
 *
 * @task T832
 * @task T947
 * @adr ADR-051 §6
 * @adr ADR-054 (draft)
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';

import type { GateEvidence } from '@cleocode/contracts';
import {
  type AgentIdentity,
  type AuditSignature,
  getCleoIdentity,
  signAuditLine,
  verifyAuditLine,
} from '../identity/cleo-identity.js';

/**
 * One record appended to `.cleo/audit/gates.jsonl`.
 *
 * The record schema is append-only — new fields MAY be added, existing
 * field semantics MUST NOT change.
 *
 * @task T832
 */
export interface GateAuditRecord {
  /** ISO 8601 timestamp of the write. */
  timestamp: string;
  /** Task ID being verified. */
  taskId: string;
  /** Gate name, or "*all*" for a multi-gate set. */
  gate: string;
  /** Write action. */
  action: 'set' | 'reset' | 'all';
  /** Evidence backing this write (undefined for reset). */
  evidence?: GateEvidence;
  /** Agent identifier. */
  agent: string;
  /** Session identifier. */
  sessionId: string | null;
  /** True when the gate is now passed. */
  passed: boolean;
  /** True when CLEO_OWNER_OVERRIDE was set. */
  override: boolean;
}

/**
 * Extended record appended to `.cleo/audit/force-bypass.jsonl` when an
 * override was used.
 *
 * @task T832
 * @task T1501
 * @task T1502
 */
export interface ForceBypassRecord extends GateAuditRecord {
  /** Reason supplied via CLEO_OWNER_OVERRIDE_REASON env. */
  overrideReason: string;
  /** Process ID that performed the bypass. */
  pid: number;
  /** CLI command line invocation (best-effort). */
  command: string;
  /**
   * 1-based ordinal of this override within the current session (T1501 / P0-5).
   * Enables post-hoc audit of escalation patterns within a single session.
   */
  sessionOverrideOrdinal?: number;
  /**
   * True when the same evidence atom was applied to >3 distinct tasks and
   * `--shared-evidence` was passed to acknowledge the reuse (T1502 / P0-6).
   */
  sharedEvidence?: boolean;
  /**
   * True when the same evidence atom was applied to >3 distinct tasks but
   * `--shared-evidence` was NOT passed — a warning was emitted instead of
   * a hard reject (non-strict mode, T1502 / P0-6).
   */
  sharedAtomWarning?: boolean;
  /**
   * True when the override originated from a worktree-orchestrate workflow and
   * was exempt from the per-session cap counter (T1504 / ADR-059 §D3).
   *
   * The entry is still logged in force-bypass.jsonl for full audit coverage.
   */
  workTreeContext?: boolean;
}

/**
 * Resolve the project-relative path of the gates audit log.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns Absolute path to `.cleo/audit/gates.jsonl`
 *
 * @task T832
 */
export function getGateAuditPath(projectRoot: string): string {
  return resolvePath(projectRoot, '.cleo', 'audit', 'gates.jsonl');
}

/**
 * Resolve the project-relative path of the force-bypass audit log.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns Absolute path to `.cleo/audit/force-bypass.jsonl`
 *
 * @task T832
 */
export function getForceBypassPath(projectRoot: string): string {
  return resolvePath(projectRoot, '.cleo', 'audit', 'force-bypass.jsonl');
}

/**
 * Append a single line to `.cleo/audit/gates.jsonl`.
 *
 * Creates the audit directory on first use.  Serialises as a single line
 * with no trailing whitespace other than the final newline so the file
 * remains valid JSON-lines (`.jsonl`).
 *
 * @param projectRoot - Absolute path to the project root
 * @param record - Audit record to append
 *
 * @example
 * ```ts
 * await appendGateAuditLine('/project', {
 *   timestamp: new Date().toISOString(),
 *   taskId: 'T832',
 *   gate: 'implemented',
 *   action: 'set',
 *   evidence,
 *   agent: 'opus-lead',
 *   sessionId: 'ses_xxx',
 *   passed: true,
 *   override: false,
 * });
 * ```
 *
 * @task T832
 * @adr ADR-051 §6.1
 */
export async function appendGateAuditLine(
  projectRoot: string,
  record: GateAuditRecord,
): Promise<void> {
  const path = getGateAuditPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  await appendFile(path, line, { encoding: 'utf-8' });
}

/**
 * Append a single line to `.cleo/audit/force-bypass.jsonl`.
 *
 * @param projectRoot - Absolute path to the project root
 * @param record - Override record to append
 *
 * @task T832
 * @adr ADR-051 §6.2
 */
export async function appendForceBypassLine(
  projectRoot: string,
  record: ForceBypassRecord,
): Promise<void> {
  const path = getForceBypassPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  await appendFile(path, line, { encoding: 'utf-8' });
}

// ---------------------------------------------------------------------------
// Signed audit variants (T947 / ADR-054 draft)
// ---------------------------------------------------------------------------

/**
 * A {@link GateAuditRecord} that carries an optional Ed25519 signature.
 *
 * When present, `_sig` is computed over the UTF-8 bytes of the canonical
 * JSON line **without** the `_sig` field. Unsigned entries (pre-T947 or
 * opt-out writers) omit the field entirely.
 *
 * @task T947
 */
export interface SignedGateAuditRecord extends GateAuditRecord {
  /** Optional signature envelope attached to signed entries. */
  _sig?: AuditSignature;
}

/**
 * Stable-order serialization helper — ensures the unsigned canonical bytes
 * used for signing match the bytes used for verification regardless of key
 * insertion order.
 *
 * Matches `JSON.stringify` default semantics (insertion order) because
 * verifiers strip `_sig` and re-serialise the remaining object with
 * `JSON.stringify(record)` — so producers and consumers must agree on a
 * single serialisation. We canonicalise by sorting keys.
 *
 * @internal
 */
function canonicalJson(record: GateAuditRecord): string {
  // Sort top-level keys alphabetically for deterministic serialisation.
  // Nested objects (e.g. `evidence`) are stringified with default ordering —
  // this matches how they are produced by the verifier and avoids a deep
  // rewrite of existing GateEvidence shapes.
  const sortedKeys = Object.keys(record).sort();
  const ordered: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    ordered[key] = record[key as keyof GateAuditRecord];
  }
  return JSON.stringify(ordered);
}

/**
 * Append a cryptographically-signed line to `.cleo/audit/gates.jsonl`.
 *
 * The on-disk line contains the same fields as {@link appendGateAuditLine}
 * plus a `_sig: { sig, pub }` envelope. The signature covers the canonical
 * (alphabetically-sorted) JSON bytes of the record **before** `_sig` is
 * attached — call {@link verifyAuditHistory} to validate a file after
 * writing.
 *
 * Backwards compatibility: consumers that encounter entries without `_sig`
 * MUST treat them as valid-but-unsigned (pre-T947 migration).
 *
 * @param projectRoot - Absolute path to the project root.
 * @param record - Audit record to sign and append.
 * @param identity - Optional pre-loaded identity (avoids repeated disk I/O).
 * @returns The signature envelope that was attached.
 *
 * @task T947
 * @adr ADR-054 (draft)
 */
export async function appendSignedGateAuditLine(
  projectRoot: string,
  record: GateAuditRecord,
  identity?: AgentIdentity,
): Promise<AuditSignature> {
  const id = identity ?? (await getCleoIdentity(projectRoot));
  const canonical = canonicalJson(record);
  const signature = await signAuditLine(id, canonical);
  const signed: SignedGateAuditRecord = { ...record, _sig: signature };

  const path = getGateAuditPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify(signed)}\n`;
  await appendFile(path, line, { encoding: 'utf-8' });
  return signature;
}

/**
 * Counts returned by {@link verifyAuditHistory}.
 *
 * @task T947
 */
export interface AuditHistoryReport {
  /** Total parsed lines (invalid JSON lines are skipped silently). */
  total: number;
  /** Entries that carried a `_sig` field (valid or not). */
  signed: number;
  /** Signed entries whose signature validated against the embedded `pub`. */
  verified: number;
  /** Entries with no `_sig` field (legacy / backwards-compat). */
  unsigned: number;
}

/**
 * Read `.cleo/audit/gates.jsonl` and report signature integrity.
 *
 * For every line:
 * - Lines without `_sig` increment `unsigned`.
 * - Lines with `_sig` increment `signed`; if the signature validates against
 *   the embedded `pub`, they additionally increment `verified`.
 * - Malformed JSON is silently skipped (neither signed nor unsigned).
 *
 * This helper is intentionally permissive: it is a **read-only report**, not
 * an enforcement gate. Policy enforcement (e.g. refuse to boot with unsigned
 * entries after a cutoff date) is the caller's responsibility.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Aggregate counts across the entire file.
 *
 * @task T947
 * @adr ADR-054 (draft)
 */
export async function verifyAuditHistory(projectRoot: string): Promise<AuditHistoryReport> {
  const path = getGateAuditPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return { total: 0, signed: 0, verified: 0, unsigned: 0 };
  }

  const report: AuditHistoryReport = { total: 0, signed: 0, verified: 0, unsigned: 0 };
  const lines = raw.split('\n').filter((l) => l.length > 0);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      continue;
    }
    report.total += 1;

    const sigHolder = parsed as { _sig?: unknown };
    if (
      typeof sigHolder._sig === 'object' &&
      sigHolder._sig !== null &&
      typeof (sigHolder._sig as { sig?: unknown }).sig === 'string' &&
      typeof (sigHolder._sig as { pub?: unknown }).pub === 'string'
    ) {
      report.signed += 1;
      // Reconstruct the unsigned canonical bytes.
      const { _sig, ...rest } = parsed as SignedGateAuditRecord;
      const canonical = canonicalJson(rest as GateAuditRecord);
      const ok = await verifyAuditLine(canonical, _sig!.sig, _sig!.pub);
      if (ok) {
        report.verified += 1;
      }
    } else {
      report.unsigned += 1;
    }
  }

  return report;
}
