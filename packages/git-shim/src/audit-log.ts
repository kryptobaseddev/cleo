/**
 * Append-only audit log for git-shim boundary events (T1591).
 *
 * Every block (refusal) and every bypass (`CLEO_ALLOW_GIT=1`) is recorded as
 * one JSON line at:
 *
 *   `<XDG_DATA_HOME ?? ~/.local/share>/cleo/audit/git-shim.jsonl`
 *
 * Tests override the path via `CLEO_AUDIT_LOG_PATH`.
 *
 * Records use a stable, project-agnostic shape so downstream tooling
 * (`cleo audit show`, dashboards) can consume them without parsing knowledge
 * of any particular project.
 *
 * @task T1591
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Outcome of a shim invocation that warrants an audit entry.
 *
 * @task T1591
 */
export type AuditOutcome = 'blocked' | 'bypassed-allow-git' | 'bypassed-orchestrate-merge';

/**
 * Single JSONL record written to the audit log.
 *
 * @task T1591
 */
export interface AuditRecord {
  /** ISO 8601 UTC timestamp. */
  ts: string;
  /** What happened. */
  outcome: AuditOutcome;
  /**
   * Boundary letter (a-d), "denylist" for legacy denylist hits, or
   * "isolation" for the T1761 cwd-outside-worktree check.
   */
  boundary: 'a' | 'b' | 'c' | 'd' | 'denylist' | 'isolation';
  /** CLEO error code, when blocked. */
  code: string;
  /** Git subcommand. */
  subcommand: string;
  /** Argv tail after subcommand. */
  args: string[];
  /** Working directory at invocation time. */
  cwd: string;
  /** Active worktree, when resolvable. */
  worktree_path: string | null;
  /** Task ID extracted from the worktree, when resolvable. */
  task_id: string | null;
  /** Agent role from CLEO_AGENT_ROLE. */
  role: string | null;
  /** Free-form context from the boundary predicate. */
  context: Record<string, string>;
}

/**
 * Resolve the audit log file path.
 *
 * Honours `CLEO_AUDIT_LOG_PATH` (test/owner override), otherwise defaults
 * to the XDG-conformant location.
 *
 * @returns Absolute path to the jsonl file.
 *
 * @task T1591
 */
export function resolveAuditLogPath(): string {
  const override = process.env['CLEO_AUDIT_LOG_PATH'];
  if (override) return override;
  const xdgData = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  return join(xdgData, 'cleo', 'audit', 'git-shim.jsonl');
}

/**
 * Append a single record to the audit log.
 *
 * Best-effort: failures are swallowed so the shim can never wedge a git
 * invocation. The record is also echoed to stderr so operators see it
 * even if the file write fails.
 *
 * @param record - The audit record to persist.
 *
 * @task T1591
 */
export function writeAuditRecord(record: AuditRecord): void {
  const line = `${JSON.stringify(record)}\n`;
  const path = resolveAuditLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line, { encoding: 'utf-8' });
  } catch {
    // Best-effort — shim must never block on log failure.
  }
  // Always echo to stderr for human visibility.
  if (record.outcome === 'blocked') {
    process.stderr.write(
      `[git-shim] AUDIT block boundary=${record.boundary} code=${record.code}\n`,
    );
  } else {
    process.stderr.write(
      `[git-shim] AUDIT bypass boundary=${record.boundary} via=${record.outcome}\n`,
    );
  }
}
