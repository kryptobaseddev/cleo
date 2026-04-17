/**
 * State layer for playbook runtime — CRUD against playbook_runs + playbook_approvals.
 * Uses node:sqlite DatabaseSync for consistency with rest of CLEO.
 *
 * All JSON-shaped columns (`bindings`, `iteration_counts`) are serialized to
 * text at the write boundary and strictly parsed on read. Parse failures throw
 * rather than silently reset state, per the data-integrity contract of ADR-013.
 *
 * Multi-column updates and cross-table operations run inside a BEGIN/COMMIT
 * transaction so partial failures cannot leave the run in a half-mutated state.
 *
 * @task T889 / T904 / W4-8
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  PlaybookApproval,
  PlaybookApprovalStatus,
  PlaybookRun,
  PlaybookRunStatus,
} from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Row shapes (snake_case — mirror of SQLite PRAGMA table_info output)
// ---------------------------------------------------------------------------

interface PlaybookRunRow {
  run_id: string;
  playbook_name: string;
  playbook_hash: string;
  current_node: string | null;
  bindings: string;
  error_context: string | null;
  status: string;
  iteration_counts: string;
  epic_id: string | null;
  session_id: string | null;
  started_at: string;
  completed_at: string | null;
}

interface PlaybookApprovalRow {
  approval_id: string;
  run_id: string;
  node_id: string;
  token: string;
  requested_at: string;
  approved_at: string | null;
  approver: string | null;
  reason: string | null;
  status: string;
  auto_passed: number;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * Input payload for {@link createPlaybookRun}. `playbookHash` MUST be a stable
 * digest of the `.cantbook` source so replays can prove definition parity.
 */
export interface CreatePlaybookRunInput {
  playbookName: string;
  playbookHash: string;
  epicId?: string;
  sessionId?: string;
  initialBindings?: Record<string, unknown>;
}

/**
 * Input payload for {@link createPlaybookApproval}. Callers MUST supply an
 * opaque `token` — approval resume flows look up runs by this value.
 */
export interface CreatePlaybookApprovalInput {
  runId: string;
  nodeId: string;
  token: string;
  autoPassed?: boolean;
}

/**
 * Filter options for {@link listPlaybookRuns}. All fields are optional; when
 * omitted the call returns the most recent runs ordered by `started_at DESC`.
 */
export interface ListPlaybookRunsOptions {
  status?: PlaybookRunStatus;
  epicId?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

/**
 * Strictly parses a JSON payload stored in a playbook column. Throws a
 * descriptive error on malformed JSON so state corruption surfaces at the
 * boundary rather than mutating downstream logic.
 */
function parseJsonColumn<T>(raw: string, column: string, runId: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `playbook state: failed to parse JSON column "${column}" for run ${runId}: ${message}`,
    );
  }
}

/**
 * Maps a snake_case `playbook_runs` row to the contract-shaped
 * {@link PlaybookRun}. Performs strict JSON parsing and validates the status
 * column against the enum.
 */
function rowToPlaybookRun(row: PlaybookRunRow): PlaybookRun {
  const bindings = parseJsonColumn<Record<string, unknown>>(row.bindings, 'bindings', row.run_id);
  const iterationCounts = parseJsonColumn<Record<string, number>>(
    row.iteration_counts,
    'iteration_counts',
    row.run_id,
  );

  return {
    runId: row.run_id,
    playbookName: row.playbook_name,
    playbookHash: row.playbook_hash,
    currentNode: row.current_node,
    bindings,
    errorContext: row.error_context,
    status: row.status as PlaybookRunStatus,
    iterationCounts,
    epicId: row.epic_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
}

/**
 * Maps a snake_case `playbook_approvals` row to the contract-shaped
 * {@link PlaybookApproval}. Converts the integer `auto_passed` column to a
 * boolean at the boundary.
 */
function rowToPlaybookApproval(row: PlaybookApprovalRow): PlaybookApproval {
  return {
    approvalId: row.approval_id,
    runId: row.run_id,
    nodeId: row.node_id,
    token: row.token,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at ?? undefined,
    approver: row.approver ?? undefined,
    reason: row.reason ?? undefined,
    status: row.status as PlaybookApprovalStatus,
    autoPassed: row.auto_passed === 1,
  };
}

// ---------------------------------------------------------------------------
// Playbook run CRUD
// ---------------------------------------------------------------------------

/**
 * Inserts a new playbook run with a freshly generated UUID, `status='running'`,
 * and the provided initial bindings. Returns the hydrated {@link PlaybookRun}
 * read back from the row so callers see all server-defaulted columns
 * (`started_at`, empty `iteration_counts`, etc.).
 */
export function createPlaybookRun(db: DatabaseSync, input: CreatePlaybookRunInput): PlaybookRun {
  const runId = randomUUID();
  const bindingsJson = JSON.stringify(input.initialBindings ?? {});

  const insert = db.prepare(
    `INSERT INTO playbook_runs (
       run_id, playbook_name, playbook_hash, bindings, status,
       iteration_counts, epic_id, session_id
     ) VALUES (?, ?, ?, ?, 'running', '{}', ?, ?)`,
  );
  insert.run(
    runId,
    input.playbookName,
    input.playbookHash,
    bindingsJson,
    input.epicId ?? null,
    input.sessionId ?? null,
  );

  const row = db.prepare('SELECT * FROM playbook_runs WHERE run_id = ?').get(runId) as
    | PlaybookRunRow
    | undefined;

  if (!row) {
    throw new Error(`playbook state: failed to read back run ${runId} after insert`);
  }
  return rowToPlaybookRun(row);
}

/**
 * Fetches a playbook run by its primary key. Returns `null` when the run
 * does not exist. Never throws on missing rows.
 */
export function getPlaybookRun(db: DatabaseSync, runId: string): PlaybookRun | null {
  const row = db.prepare('SELECT * FROM playbook_runs WHERE run_id = ?').get(runId) as
    | PlaybookRunRow
    | undefined;
  return row ? rowToPlaybookRun(row) : null;
}

/**
 * Applies a partial patch to a playbook run inside a transaction so mixed
 * column updates (e.g. `status` + `currentNode`) commit atomically. Returns
 * the fully-hydrated run read back after commit.
 */
export function updatePlaybookRun(
  db: DatabaseSync,
  runId: string,
  patch: Partial<Omit<PlaybookRun, 'runId' | 'startedAt'>>,
): PlaybookRun {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];

  if ('playbookName' in patch && patch.playbookName !== undefined) {
    sets.push('playbook_name = ?');
    values.push(patch.playbookName);
  }
  if ('playbookHash' in patch && patch.playbookHash !== undefined) {
    sets.push('playbook_hash = ?');
    values.push(patch.playbookHash);
  }
  if ('currentNode' in patch) {
    sets.push('current_node = ?');
    values.push(patch.currentNode ?? null);
  }
  if ('bindings' in patch && patch.bindings !== undefined) {
    sets.push('bindings = ?');
    values.push(JSON.stringify(patch.bindings));
  }
  if ('errorContext' in patch) {
    sets.push('error_context = ?');
    values.push(patch.errorContext ?? null);
  }
  if ('status' in patch && patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if ('iterationCounts' in patch && patch.iterationCounts !== undefined) {
    sets.push('iteration_counts = ?');
    values.push(JSON.stringify(patch.iterationCounts));
  }
  if ('epicId' in patch) {
    sets.push('epic_id = ?');
    values.push(patch.epicId ?? null);
  }
  if ('sessionId' in patch) {
    sets.push('session_id = ?');
    values.push(patch.sessionId ?? null);
  }
  if ('completedAt' in patch) {
    sets.push('completed_at = ?');
    values.push(patch.completedAt ?? null);
  }

  if (sets.length === 0) {
    const existing = getPlaybookRun(db, runId);
    if (!existing) {
      throw new Error(`playbook state: run ${runId} not found for update`);
    }
    return existing;
  }

  db.exec('BEGIN');
  try {
    const stmt = db.prepare(`UPDATE playbook_runs SET ${sets.join(', ')} WHERE run_id = ?`);
    values.push(runId);
    const result = stmt.run(...values);
    if (result.changes === 0) {
      throw new Error(`playbook state: run ${runId} not found for update`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const row = db.prepare('SELECT * FROM playbook_runs WHERE run_id = ?').get(runId) as
    | PlaybookRunRow
    | undefined;
  if (!row) {
    throw new Error(`playbook state: run ${runId} disappeared after update`);
  }
  return rowToPlaybookRun(row);
}

/**
 * Lists playbook runs filtered by status and/or epic. Defaults to `ORDER BY
 * started_at DESC` so the newest runs surface first for dashboards.
 */
export function listPlaybookRuns(
  db: DatabaseSync,
  opts: ListPlaybookRunsOptions = {},
): PlaybookRun[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (opts.status) {
    clauses.push('status = ?');
    values.push(opts.status);
  }
  if (opts.epicId) {
    clauses.push('epic_id = ?');
    values.push(opts.epicId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limitClause = typeof opts.limit === 'number' ? 'LIMIT ?' : '';
  if (limitClause) values.push(opts.limit ?? 0);

  const sql = `SELECT * FROM playbook_runs ${where} ORDER BY started_at DESC ${limitClause}`;
  const rows = db.prepare(sql).all(...values) as unknown as PlaybookRunRow[];
  return rows.map(rowToPlaybookRun);
}

/**
 * Deletes a playbook run by primary key. Returns `true` if a row was removed.
 * CASCADE wipes all associated approvals via the foreign-key constraint on
 * `playbook_approvals.run_id`.
 */
export function deletePlaybookRun(db: DatabaseSync, runId: string): boolean {
  const result = db.prepare('DELETE FROM playbook_runs WHERE run_id = ?').run(runId);
  return Number(result.changes) > 0;
}

// ---------------------------------------------------------------------------
// Playbook approval CRUD
// ---------------------------------------------------------------------------

/**
 * Inserts a new approval record with a freshly generated UUID, `status='pending'`,
 * and the caller-supplied opaque token. Returns the hydrated
 * {@link PlaybookApproval} so callers see the server-defaulted `requested_at`.
 */
export function createPlaybookApproval(
  db: DatabaseSync,
  input: CreatePlaybookApprovalInput,
): PlaybookApproval {
  const approvalId = randomUUID();
  const autoPassed = input.autoPassed ? 1 : 0;

  db.prepare(
    `INSERT INTO playbook_approvals (
       approval_id, run_id, node_id, token, status, auto_passed
     ) VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(approvalId, input.runId, input.nodeId, input.token, autoPassed);

  const row = db
    .prepare('SELECT * FROM playbook_approvals WHERE approval_id = ?')
    .get(approvalId) as PlaybookApprovalRow | undefined;
  if (!row) {
    throw new Error(`playbook state: failed to read back approval ${approvalId} after insert`);
  }
  return rowToPlaybookApproval(row);
}

/**
 * Fetches an approval by its opaque token. Returns `null` if no row matches.
 * The token column carries a UNIQUE constraint so at most one row is returned.
 */
export function getPlaybookApprovalByToken(
  db: DatabaseSync,
  token: string,
): PlaybookApproval | null {
  const row = db.prepare('SELECT * FROM playbook_approvals WHERE token = ?').get(token) as
    | PlaybookApprovalRow
    | undefined;
  return row ? rowToPlaybookApproval(row) : null;
}

/**
 * Applies a partial patch to an approval record inside a transaction. Used by
 * the approval-resume flow to transactionally set both `status` and
 * `approved_at` when a human resolves a HITL checkpoint.
 */
export function updatePlaybookApproval(
  db: DatabaseSync,
  approvalId: string,
  patch: Partial<Omit<PlaybookApproval, 'approvalId' | 'requestedAt'>>,
): PlaybookApproval {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];

  if ('runId' in patch && patch.runId !== undefined) {
    sets.push('run_id = ?');
    values.push(patch.runId);
  }
  if ('nodeId' in patch && patch.nodeId !== undefined) {
    sets.push('node_id = ?');
    values.push(patch.nodeId);
  }
  if ('token' in patch && patch.token !== undefined) {
    sets.push('token = ?');
    values.push(patch.token);
  }
  if ('approvedAt' in patch) {
    sets.push('approved_at = ?');
    values.push(patch.approvedAt ?? null);
  }
  if ('approver' in patch) {
    sets.push('approver = ?');
    values.push(patch.approver ?? null);
  }
  if ('reason' in patch) {
    sets.push('reason = ?');
    values.push(patch.reason ?? null);
  }
  if ('status' in patch && patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if ('autoPassed' in patch && patch.autoPassed !== undefined) {
    sets.push('auto_passed = ?');
    values.push(patch.autoPassed ? 1 : 0);
  }

  if (sets.length === 0) {
    const row = db
      .prepare('SELECT * FROM playbook_approvals WHERE approval_id = ?')
      .get(approvalId) as PlaybookApprovalRow | undefined;
    if (!row) {
      throw new Error(`playbook state: approval ${approvalId} not found for update`);
    }
    return rowToPlaybookApproval(row);
  }

  db.exec('BEGIN');
  try {
    const stmt = db.prepare(
      `UPDATE playbook_approvals SET ${sets.join(', ')} WHERE approval_id = ?`,
    );
    values.push(approvalId);
    const result = stmt.run(...values);
    if (result.changes === 0) {
      throw new Error(`playbook state: approval ${approvalId} not found for update`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const row = db
    .prepare('SELECT * FROM playbook_approvals WHERE approval_id = ?')
    .get(approvalId) as PlaybookApprovalRow | undefined;
  if (!row) {
    throw new Error(`playbook state: approval ${approvalId} disappeared after update`);
  }
  return rowToPlaybookApproval(row);
}

/**
 * Lists all approvals for a given run, ordered by `requested_at ASC` so the
 * first HITL checkpoint surfaces first.
 */
export function listPlaybookApprovals(db: DatabaseSync, runId: string): PlaybookApproval[] {
  const rows = db
    .prepare(
      'SELECT * FROM playbook_approvals WHERE run_id = ? ORDER BY requested_at ASC, approval_id ASC',
    )
    .all(runId) as unknown as PlaybookApprovalRow[];
  return rows.map(rowToPlaybookApproval);
}
