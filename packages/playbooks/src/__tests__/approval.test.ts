/**
 * W4-16 approval / resume-token real-sqlite tests (no mocks).
 *
 * All tests run against an in-memory sqlite DB with the T889 migration
 * applied — zero fakes, zero stubs, zero mocks of `createHmac`.
 *
 * @task T889 / T908 / W4-16
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approveGate,
  createApprovalGate,
  E_APPROVAL_ALREADY_DECIDED,
  E_APPROVAL_NOT_FOUND,
  generateResumeToken,
  getPendingApprovals,
  getPlaybookSecret,
  rejectGate,
} from '../approval.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = resolve(
  __dirname,
  '../../../core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/migration.sql',
);

function applyMigration(db: DatabaseSync, sql: string): void {
  const statements = sql
    .split(/--> statement-breakpoint/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    const lines = stmt.split('\n');
    const hasSql = lines.some((l) => l.trim().length > 0 && !l.trim().startsWith('--'));
    if (hasSql) db.exec(stmt);
  }
}

function seedRun(db: DatabaseSync, runId: string): void {
  db.prepare(
    `INSERT INTO playbook_runs (run_id, playbook_name, playbook_hash)
     VALUES (?, 'rcasd', 'hash')`,
  ).run(runId);
}

describe('W4-16: Resume-token generation', () => {
  it('is deterministic for identical inputs', () => {
    const t1 = generateResumeToken('r1', 'n1', { a: 1, b: 2 }, 'secret');
    const t2 = generateResumeToken('r1', 'n1', { a: 1, b: 2 }, 'secret');
    expect(t1).toBe(t2);
    expect(t1).toHaveLength(32);
    expect(t1).toMatch(/^[0-9a-f]{32}$/);
  });

  it('differs for different runIds', () => {
    const a = generateResumeToken('r1', 'n1', {}, 'secret');
    const b = generateResumeToken('r2', 'n1', {}, 'secret');
    expect(a).not.toBe(b);
  });

  it('differs for different bindings', () => {
    const a = generateResumeToken('r1', 'n1', { x: 1 }, 'secret');
    const b = generateResumeToken('r1', 'n1', { x: 2 }, 'secret');
    expect(a).not.toBe(b);
  });

  it('is binding-key-order invariant via canonical JSON', () => {
    const a = generateResumeToken('r1', 'n1', { alpha: 1, beta: 2 }, 'secret');
    const b = generateResumeToken('r1', 'n1', { beta: 2, alpha: 1 }, 'secret');
    expect(a).toBe(b);
  });

  it('differs when secret rotates', () => {
    const a = generateResumeToken('r1', 'n1', {}, 'secretA');
    const b = generateResumeToken('r1', 'n1', {}, 'secretB');
    expect(a).not.toBe(b);
  });

  it('getPlaybookSecret reads CLEO_PLAYBOOK_SECRET from env override', () => {
    const s = getPlaybookSecret({ CLEO_PLAYBOOK_SECRET: 'prod-secret' } as NodeJS.ProcessEnv);
    expect(s).toBe('prod-secret');
    const fallback = getPlaybookSecret({} as NodeJS.ProcessEnv);
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback).not.toBe('prod-secret');
  });
});

describe('W4-16: Approval DB operations', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigration(db, readFileSync(MIGRATION_SQL, 'utf8'));
    seedRun(db, 'run-1');
  });

  afterEach(() => db.close());

  it('createApprovalGate writes row with generated token and status=pending', () => {
    const approval = createApprovalGate(db, {
      runId: 'run-1',
      nodeId: 'node-a',
      bindings: { x: 1 },
      secret: 'test-secret',
    });
    const expectedToken = generateResumeToken('run-1', 'node-a', { x: 1 }, 'test-secret');
    expect(approval.token).toBe(expectedToken);
    expect(approval.status).toBe('pending');
    expect(approval.autoPassed).toBe(false);
    expect(approval.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(approval.requestedAt).toBeTruthy();
    expect(approval.approvedAt).toBeUndefined();
    expect(approval.approver).toBeUndefined();
    expect(approval.reason).toBeUndefined();
  });

  it('createApprovalGate with autoPassed=true records status=approved + auto_passed=1', () => {
    const approval = createApprovalGate(db, {
      runId: 'run-1',
      nodeId: 'node-auto',
      bindings: {},
      autoPassed: true,
      approver: 'policy:conservative',
      reason: 'auto-approve low-risk deterministic step',
      secret: 'test-secret',
    });
    expect(approval.status).toBe('approved');
    expect(approval.autoPassed).toBe(true);
    expect(approval.approver).toBe('policy:conservative');
    expect(approval.reason).toBe('auto-approve low-risk deterministic step');

    const row = db
      .prepare('SELECT auto_passed FROM playbook_approvals WHERE approval_id = ?')
      .get(approval.approvalId) as { auto_passed: number };
    expect(row.auto_passed).toBe(1);
  });

  it('approveGate sets status=approved, approvedAt, approver, reason', () => {
    const gate = createApprovalGate(db, {
      runId: 'run-1',
      nodeId: 'node-b',
      bindings: { y: 'hello' },
      secret: 'test-secret',
    });
    const updated = approveGate(db, gate.token, 'keaton@cleo', 'reviewed RCASD plan');
    expect(updated.status).toBe('approved');
    expect(updated.approver).toBe('keaton@cleo');
    expect(updated.reason).toBe('reviewed RCASD plan');
    expect(updated.approvedAt).toBeTruthy();
    expect(updated.autoPassed).toBe(false);
    expect(updated.approvalId).toBe(gate.approvalId);
  });

  it('approveGate throws E_APPROVAL_NOT_FOUND for unknown token', () => {
    expect(() => approveGate(db, 'deadbeef'.repeat(4), 'who', 'why')).toThrowError(
      new RegExp(E_APPROVAL_NOT_FOUND),
    );
  });

  it('approveGate throws E_APPROVAL_ALREADY_DECIDED for already-approved gate', () => {
    const gate = createApprovalGate(db, {
      runId: 'run-1',
      nodeId: 'node-c',
      bindings: {},
      secret: 'test-secret',
    });
    approveGate(db, gate.token, 'user1');
    expect(() => approveGate(db, gate.token, 'user2')).toThrowError(
      new RegExp(E_APPROVAL_ALREADY_DECIDED),
    );
  });

  it('rejectGate sets status=rejected with approver + reason', () => {
    const gate = createApprovalGate(db, {
      runId: 'run-1',
      nodeId: 'node-d',
      bindings: {},
      secret: 'test-secret',
    });
    const updated = rejectGate(db, gate.token, 'auditor', 'contract violation');
    expect(updated.status).toBe('rejected');
    expect(updated.approver).toBe('auditor');
    expect(updated.reason).toBe('contract violation');
    expect(updated.approvedAt).toBeTruthy();
  });

  it('rejectGate throws E_APPROVAL_ALREADY_DECIDED for already-rejected gate', () => {
    const gate = createApprovalGate(db, {
      runId: 'run-1',
      nodeId: 'node-e',
      bindings: {},
      secret: 'test-secret',
    });
    rejectGate(db, gate.token, 'user1');
    expect(() => rejectGate(db, gate.token, 'user2')).toThrowError(
      new RegExp(E_APPROVAL_ALREADY_DECIDED),
    );
    expect(() => approveGate(db, gate.token, 'user3')).toThrowError(
      new RegExp(E_APPROVAL_ALREADY_DECIDED),
    );
  });

  it('getPendingApprovals returns only pending, ordered by requestedAt', () => {
    const g1 = createApprovalGate(db, {
      runId: 'run-1',
      nodeId: 'node-p1',
      bindings: { k: 1 },
      secret: 'test-secret',
    });
    const g2 = createApprovalGate(db, {
      runId: 'run-1',
      nodeId: 'node-p2',
      bindings: { k: 2 },
      secret: 'test-secret',
    });
    const g3 = createApprovalGate(db, {
      runId: 'run-1',
      nodeId: 'node-p3',
      bindings: { k: 3 },
      autoPassed: true,
      secret: 'test-secret',
    });

    const pending = getPendingApprovals(db);
    expect(pending).toHaveLength(2);
    const ids = pending.map((p) => p.approvalId);
    expect(ids).toContain(g1.approvalId);
    expect(ids).toContain(g2.approvalId);
    expect(ids).not.toContain(g3.approvalId);
    // Ordering: requested_at ASC, then approval_id ASC as tiebreaker
    // since both inserts happened in the same second under datetime('now').
    const sorted = [...pending].sort((a, b) => {
      const t = a.requestedAt.localeCompare(b.requestedAt);
      return t !== 0 ? t : a.approvalId.localeCompare(b.approvalId);
    });
    expect(pending.map((p) => p.approvalId)).toEqual(sorted.map((p) => p.approvalId));
  });

  it('full flow: create -> approve -> pending list shrinks', () => {
    const a = createApprovalGate(db, {
      runId: 'run-1',
      nodeId: 'node-x',
      bindings: { a: 1 },
      secret: 'test-secret',
    });
    const b = createApprovalGate(db, {
      runId: 'run-1',
      nodeId: 'node-y',
      bindings: { b: 2 },
      secret: 'test-secret',
    });
    expect(getPendingApprovals(db)).toHaveLength(2);

    // Query by token round-trips the same approvalId
    const lookup = db
      .prepare('SELECT approval_id FROM playbook_approvals WHERE token = ?')
      .get(a.token) as { approval_id: string };
    expect(lookup.approval_id).toBe(a.approvalId);

    approveGate(db, a.token, 'reviewer');

    const remaining = getPendingApprovals(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.approvalId).toBe(b.approvalId);
  });

  it('rowToApproval handles null approver/reason correctly (fields omitted)', () => {
    const gate = createApprovalGate(db, {
      runId: 'run-1',
      nodeId: 'node-null',
      bindings: {},
      secret: 'test-secret',
    });
    // Never approved — approver/reason/approvedAt should all be absent
    expect(gate.approver).toBeUndefined();
    expect(gate.reason).toBeUndefined();
    expect(gate.approvedAt).toBeUndefined();
    expect('approver' in gate).toBe(false);
    expect('reason' in gate).toBe(false);
    expect('approvedAt' in gate).toBe(false);
  });
});
