/**
 * Release pipeline emergency escape-hatch audit logger.
 *
 * SPEC-T9345 §12.3 / R-440 / R-441 requires that the `cleo release ship`
 * `--workflow=false` compatibility flag append a CRITICAL-level entry to
 * `.cleo/audit/release-workflow-bypass.jsonl` for every invocation. This module
 * provides the single helper used by the CLI shim so the audit shape stays
 * stable across callsites and tests can stub the file path.
 *
 * The audit log is append-only JSONL — one record per line — and follows the
 * same conventions as `contract-violations.jsonl` (see `audit.ts`).
 *
 * @task T9538
 * @epic T9498
 * @spec SPEC-T9345 §12.3
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Relative path (from project root) of the release workflow bypass audit log.
 *
 * Exported so tests can read/inspect the file in fixtures and the dispatch
 * layer can route observability hooks at it.
 */
export const RELEASE_WORKFLOW_BYPASS_FILE = '.cleo/audit/release-workflow-bypass.jsonl';

/**
 * One audit record persisted to {@link RELEASE_WORKFLOW_BYPASS_FILE}.
 *
 * Designed for forward-compatible JSONL parsing: required fields cover the
 * minimum forensic context (when, what, who, why) and optional fields capture
 * the originating epic for cross-reference against the `releases` table.
 *
 * @task T9538
 */
export interface ReleaseWorkflowBypassRecord {
  /** ISO 8601 UTC timestamp of the bypass invocation. */
  timestamp: string;
  /** Release version the operator attempted to ship via the legacy path. */
  version: string;
  /** Operator identity (process.env.USER or override). */
  operator: string;
  /**
   * Severity tier — always `'critical'` per R-441 so log aggregators can
   * surface these events without extra parsing.
   */
  severity: 'critical';
  /** Free-form rationale supplied by the operator. */
  reason: string;
  /** Epic task ID the release is shipping (when supplied via --epic). */
  epicId?: string;
  /** Reason category — `'env-flag'` covers the CLI shim path. */
  source: 'env-flag' | 'cli-flag';
}

/**
 * Options accepted by {@link appendReleaseWorkflowBypass}.
 *
 * @task T9538
 */
export interface AppendReleaseWorkflowBypassOptions {
  /** Project root used to resolve `.cleo/audit/`. */
  projectRoot: string;
  /** Release version that was bypassed. */
  version: string;
  /** Operator-supplied reason for using the escape hatch. */
  reason: string;
  /** Operator identity override (defaults to `process.env.USER` or `unknown`). */
  operator?: string;
  /** Epic ID for cross-reference. */
  epicId?: string;
  /** Originating callsite — `cli-flag` for `--workflow=false` shim. */
  source?: ReleaseWorkflowBypassRecord['source'];
  /** Timestamp override — defaults to `new Date().toISOString()`. */
  timestamp?: string;
}

/**
 * Append a CRITICAL-severity record to the release workflow bypass audit log.
 *
 * Per SPEC-T9345 R-441 every `--workflow=false` invocation MUST land a record
 * here. The write is best-effort: errors are swallowed so the legacy release
 * path is never blocked by a permissions or filesystem fault on the audit log.
 *
 * @example
 * ```ts
 * appendReleaseWorkflowBypass({
 *   projectRoot: process.cwd(),
 *   version: '2026.6.0',
 *   reason: 'GHA workflow is down — hotfix needed',
 *   epicId: 'T9498',
 * });
 * ```
 *
 * @task T9538
 */
export function appendReleaseWorkflowBypass(opts: AppendReleaseWorkflowBypassOptions): void {
  try {
    const filePath = join(opts.projectRoot, RELEASE_WORKFLOW_BYPASS_FILE);
    mkdirSync(dirname(filePath), { recursive: true });
    const record: ReleaseWorkflowBypassRecord = {
      timestamp: opts.timestamp ?? new Date().toISOString(),
      version: opts.version,
      operator: opts.operator ?? process.env.USER ?? 'unknown',
      severity: 'critical',
      reason: opts.reason,
      epicId: opts.epicId,
      source: opts.source ?? 'cli-flag',
    };
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf-8' });
  } catch {
    // non-fatal — audit writes must never block the operation (matches the
    // pattern in audit.appendContractViolation).
  }
}
