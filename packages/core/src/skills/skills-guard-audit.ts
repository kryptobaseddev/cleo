/**
 * Skills-guard audit log writer — appends a structured entry to
 * `.cleo/audit/skill-trust-bypass.jsonl` every time the operator overrides
 * a `block` install decision with `--force`.
 *
 * Mirrors the {@link https://github.com/kryptobaseddev/cleocode/blob/main/.cleo/audit/force-bypass.jsonl `.cleo/audit/force-bypass.jsonl`}
 * pattern used by ADR-051 evidence overrides — same JSONL shape, separate
 * file so security audits can grep for trust-related bypasses without
 * noise from completion overrides.
 *
 * @task T9730
 * @epic T9564
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getProjectRoot } from '../paths.js';
import type { ScanResult } from './skills-guard.js';

/**
 * Wire shape of one audit entry. Stored as one JSON object per line so the
 * file is appendable without a re-write.
 */
export interface SkillTrustBypassEntry {
  /** ISO-8601 timestamp at the moment of bypass. */
  readonly timestamp: string;
  /** Skill name (basename of the scanned path). */
  readonly skillName: string;
  /** Original source identifier (URL, repo). */
  readonly source: string;
  /** Trust level resolved by the scanner. */
  readonly trustLevel: ScanResult['trustLevel'];
  /** Original verdict the scanner produced before override. */
  readonly verdict: ScanResult['verdict'];
  /** Number of findings present at bypass time. */
  readonly findingsCount: number;
  /** Optional operator-supplied justification. */
  readonly reason: string | null;
}

/**
 * Resolve the canonical audit-log path.
 *
 * Defaults to `<projectRoot>/.cleo/audit/skill-trust-bypass.jsonl`. Tests
 * inject an explicit `cleoRoot` so they never touch the user's audit log.
 */
function resolveAuditPath(cleoRoot?: string): string {
  const root = cleoRoot ?? join(getProjectRoot(), '.cleo');
  return join(root, 'audit', 'skill-trust-bypass.jsonl');
}

/**
 * Append a trust-bypass audit row.
 *
 * Idempotency note: the writer always appends — duplicate bypass calls
 * produce duplicate rows by design, since the operator may force-install
 * the same skill multiple times across the lifecycle.
 *
 * @param result - The scan result that was overridden.
 * @param reason - Optional operator-supplied justification.
 * @param cleoRoot - Optional `.cleo` directory override (test hook).
 * @returns The persisted entry (echo of what was written).
 *
 * @task T9730
 */
export function recordTrustBypass(
  result: ScanResult,
  reason: string | null = null,
  cleoRoot?: string,
): SkillTrustBypassEntry {
  const entry: SkillTrustBypassEntry = {
    timestamp: new Date().toISOString(),
    skillName: result.skillName,
    source: result.source,
    trustLevel: result.trustLevel,
    verdict: result.verdict,
    findingsCount: result.findings.length,
    reason,
  };
  const path = resolveAuditPath(cleoRoot);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
  return entry;
}

/**
 * Resolve the audit-log path for callers that need to display the location
 * (e.g. CLI messages: "logged to <path>").
 *
 * @param cleoRoot - Optional `.cleo` directory override.
 */
export function getTrustBypassLogPath(cleoRoot?: string): string {
  return resolveAuditPath(cleoRoot);
}
