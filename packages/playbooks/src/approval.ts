/**
 * HMAC-SHA256 resume tokens for HITL approval gates.
 *
 * Tokens bind `{runId, nodeId, bindings}` so they cannot be forged or replayed
 * across different executions. The secret defaults to a well-known dev value —
 * production deployments MUST set the `CLEO_PLAYBOOK_SECRET` env var to a
 * high-entropy secret. If the secret rotates, existing tokens are invalidated
 * because the HMAC output changes.
 *
 * Binding canonicalization uses sorted-keys JSON so that `{a:1,b:2}` and
 * `{b:2,a:1}` produce the same token — semantically identical payloads
 * should always yield the same gate identity.
 *
 * @task T889 / T908 / W4-16
 */

import { createHmac, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PlaybookApproval, PlaybookApprovalStatus } from '@cleocode/contracts';

/**
 * Dev-only fallback secret. Surfaced through {@link getPlaybookSecret} so
 * production code paths can override via `CLEO_PLAYBOOK_SECRET`.
 */
const DEFAULT_SECRET = 'cleo-playbook-dev-secret-do-not-use-in-production';

/**
 * Token length (hex chars). 32 hex chars = 128 bits of HMAC output — enough
 * for collision resistance while keeping tokens URL-safe and log-friendly.
 */
const TOKEN_LENGTH = 32;

/**
 * Error code: approval token not found in the DB.
 * Raised by {@link approveGate} / {@link rejectGate}.
 */
export const E_APPROVAL_NOT_FOUND = 'E_APPROVAL_NOT_FOUND' as const;

/**
 * Error code: approval has already transitioned out of `pending`.
 * Raised by {@link approveGate} / {@link rejectGate} to prevent re-decisions.
 */
export const E_APPROVAL_ALREADY_DECIDED = 'E_APPROVAL_ALREADY_DECIDED' as const;

/**
 * Resolve the HMAC secret for resume-token generation.
 *
 * @param env - Override env source (defaults to `process.env`). Used in tests.
 * @returns The configured secret, or a dev-only fallback if unset.
 */
export function getPlaybookSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env['CLEO_PLAYBOOK_SECRET'] ?? DEFAULT_SECRET;
}

/**
 * Generate a deterministic 32-char hex HMAC-SHA256 resume token.
 *
 * The token is derived from `HMAC(secret, "runId:nodeId:canonicalBindings")`
 * and truncated to 32 hex chars (128 bits). Determinism is an intentional
 * design choice: the same (runId, nodeId, bindings, secret) tuple always
 * produces the same token, preventing duplicate gates for the same step.
 *
 * @param runId - Playbook run identifier.
 * @param nodeId - Node identifier within the run graph.
 * @param bindings - Current runtime bindings (canonicalized via sorted-keys JSON).
 * @param secret - HMAC secret (defaults to {@link getPlaybookSecret}).
 * @returns A 32-char lowercase hex string.
 */
export function generateResumeToken(
  runId: string,
  nodeId: string,
  bindings: Record<string, unknown>,
  secret: string = getPlaybookSecret(),
): string {
  // Canonicalize bindings via sorted-keys JSON for determinism.
  const canonical = JSON.stringify(bindings, Object.keys(bindings).sort());
  const payload = `${runId}:${nodeId}:${canonical}`;
  return createHmac('sha256', secret).update(payload).digest('hex').slice(0, TOKEN_LENGTH);
}

/**
 * Input for {@link createApprovalGate}.
 */
export interface CreateApprovalGateInput {
  /** Run identifier (FK to `playbook_runs.run_id`). */
  runId: string;
  /** Node identifier within the run graph. */
  nodeId: string;
  /** Runtime bindings at gate creation time. */
  bindings: Record<string, unknown>;
  /** If true, gate is created pre-approved (policy auto-pass). Default false. */
  autoPassed?: boolean;
  /** Optional approver identity (required if `autoPassed=true` recorded by policy). */
  approver?: string;
  /** Optional human-readable reason (policy name, approval note, etc.). */
  reason?: string;
  /** Override secret for token generation. Defaults to env-resolved secret. */
  secret?: string;
}

/**
 * Narrow a raw status string to {@link PlaybookApprovalStatus}, guarding
 * against unexpected DB values that would otherwise poison downstream types.
 *
 * @internal
 */
function narrowStatus(s: string): PlaybookApprovalStatus {
  if (s === 'pending' || s === 'approved' || s === 'rejected') return s;
  throw new Error(`invariant: unknown playbook_approvals.status '${s}'`);
}

/**
 * Read a required string column from a raw sqlite row.
 *
 * @internal
 */
function readString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v !== 'string') {
    throw new Error(`invariant: expected string for column ${key}, got ${typeof v}`);
  }
  return v;
}

/**
 * Read a required integer column from a raw sqlite row.
 *
 * @internal
 */
function readInt(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new Error(`invariant: expected integer for column ${key}, got ${typeof v}`);
}

/**
 * Read an optional string column. Returns `undefined` for both `null`
 * (SQL NULL) and missing keys.
 *
 * @internal
 */
function readOptionalString(row: Record<string, unknown>, key: string): string | undefined {
  const v = row[key];
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new Error(`invariant: expected string|null for column ${key}, got ${typeof v}`);
  }
  return v;
}

/**
 * Map a raw `playbook_approvals` row to the camelCase {@link PlaybookApproval}
 * contract shape. Validates types, converts the `auto_passed` 0/1 integer to
 * a boolean, and strips nullable fields rather than emitting `null`.
 *
 * @internal
 */
function rowToApproval(row: Record<string, unknown>): PlaybookApproval {
  const approval: PlaybookApproval = {
    approvalId: readString(row, 'approval_id'),
    runId: readString(row, 'run_id'),
    nodeId: readString(row, 'node_id'),
    token: readString(row, 'token'),
    requestedAt: readString(row, 'requested_at'),
    status: narrowStatus(readString(row, 'status')),
    autoPassed: readInt(row, 'auto_passed') === 1,
  };
  const approvedAt = readOptionalString(row, 'approved_at');
  const approver = readOptionalString(row, 'approver');
  const reason = readOptionalString(row, 'reason');
  if (approvedAt !== undefined) approval.approvedAt = approvedAt;
  if (approver !== undefined) approval.approver = approver;
  if (reason !== undefined) approval.reason = reason;
  return approval;
}

/**
 * Create an HITL approval gate row in `playbook_approvals`.
 *
 * If `autoPassed` is true, the gate is written with `status='approved'`
 * and `auto_passed=1` — used by the policy engine to short-circuit gates
 * that match auto-pass rules. Otherwise status is `'pending'` and the
 * runtime blocks until {@link approveGate} or {@link rejectGate} is called.
 *
 * @param db - Open `node:sqlite` handle with the T889 migration applied.
 * @param input - Gate parameters.
 * @returns The inserted {@link PlaybookApproval}, round-tripped from the DB.
 */
export function createApprovalGate(
  db: DatabaseSync,
  input: CreateApprovalGateInput,
): PlaybookApproval {
  const token = generateResumeToken(input.runId, input.nodeId, input.bindings, input.secret);
  const approvalId = randomUUID();
  const autoPassed = input.autoPassed ?? false;
  const status: PlaybookApprovalStatus = autoPassed ? 'approved' : 'pending';
  const stmt = db.prepare(`
    INSERT INTO playbook_approvals
      (approval_id, run_id, node_id, token, status, auto_passed, approver, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    approvalId,
    input.runId,
    input.nodeId,
    token,
    status,
    autoPassed ? 1 : 0,
    input.approver ?? null,
    input.reason ?? null,
  );
  const row = db
    .prepare('SELECT * FROM playbook_approvals WHERE approval_id = ?')
    .get(approvalId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new Error(
      `${E_APPROVAL_NOT_FOUND}: insert did not round-trip (approval_id=${approvalId})`,
    );
  }
  return rowToApproval(row);
}

/**
 * Transition an approval gate to `approved` state.
 *
 * @param db - Open sqlite handle.
 * @param token - The resume token returned from {@link createApprovalGate}.
 * @param approver - Identity of the approver (agent id, user email, etc.).
 * @param reason - Optional justification note.
 * @returns The updated {@link PlaybookApproval} record.
 * @throws Error with `E_APPROVAL_NOT_FOUND` code if no gate matches the token.
 * @throws Error with `E_APPROVAL_ALREADY_DECIDED` code if the gate is not pending.
 */
export function approveGate(
  db: DatabaseSync,
  token: string,
  approver: string,
  reason?: string,
): PlaybookApproval {
  return transitionGate(db, token, 'approved', approver, reason);
}

/**
 * Transition an approval gate to `rejected` state. Same semantics as
 * {@link approveGate} but records a rejection — runtime will halt the run.
 *
 * @param db - Open sqlite handle.
 * @param token - The resume token.
 * @param approver - Identity of the rejector.
 * @param reason - Optional justification.
 * @returns The updated {@link PlaybookApproval} record.
 * @throws Error with `E_APPROVAL_NOT_FOUND` if the token is unknown.
 * @throws Error with `E_APPROVAL_ALREADY_DECIDED` if the gate is not pending.
 */
export function rejectGate(
  db: DatabaseSync,
  token: string,
  approver: string,
  reason?: string,
): PlaybookApproval {
  return transitionGate(db, token, 'rejected', approver, reason);
}

/**
 * Internal shared transition logic for approve/reject. Performs row lookup,
 * state validation, update, and round-trip fetch in a single atomic flow.
 *
 * @internal
 */
function transitionGate(
  db: DatabaseSync,
  token: string,
  next: Exclude<PlaybookApprovalStatus, 'pending'>,
  approver: string,
  reason?: string,
): PlaybookApproval {
  const existing = db.prepare('SELECT * FROM playbook_approvals WHERE token = ?').get(token) as
    | Record<string, unknown>
    | undefined;
  if (existing === undefined) {
    throw new Error(`${E_APPROVAL_NOT_FOUND}: no approval gate for token`);
  }
  const existingStatus = narrowStatus(readString(existing, 'status'));
  if (existingStatus !== 'pending') {
    const approvalId = readString(existing, 'approval_id');
    throw new Error(
      `${E_APPROVAL_ALREADY_DECIDED}: gate ${approvalId} is already ${existingStatus}`,
    );
  }
  db.prepare(
    `UPDATE playbook_approvals
       SET status = ?, approved_at = datetime('now'), approver = ?, reason = ?
     WHERE token = ?`,
  ).run(next, approver, reason ?? null, token);
  const row = db.prepare('SELECT * FROM playbook_approvals WHERE token = ?').get(token) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) {
    // Unreachable: UPDATE just succeeded on this token.
    throw new Error(`${E_APPROVAL_NOT_FOUND}: row vanished after update (token=${token})`);
  }
  return rowToApproval(row);
}

/**
 * List all gates that are still awaiting a decision, oldest first.
 *
 * @param db - Open sqlite handle.
 * @returns Pending {@link PlaybookApproval} records ordered by `requested_at`.
 */
export function getPendingApprovals(db: DatabaseSync): PlaybookApproval[] {
  const rows = db
    .prepare(
      `SELECT * FROM playbook_approvals
        WHERE status = 'pending'
        ORDER BY requested_at ASC, approval_id ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToApproval);
}
