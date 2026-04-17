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
 * @task T832
 * @adr ADR-051 §6
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';

import type { GateEvidence } from '@cleocode/contracts';

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
 */
export interface ForceBypassRecord extends GateAuditRecord {
  /** Reason supplied via CLEO_OWNER_OVERRIDE_REASON env. */
  overrideReason: string;
  /** Process ID that performed the bypass. */
  pid: number;
  /** CLI command line invocation (best-effort). */
  command: string;
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
