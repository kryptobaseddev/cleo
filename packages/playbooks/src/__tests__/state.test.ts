/**
 * W4-8 state layer real-sqlite tests (no mocks).
 * Uses an in-memory DatabaseSync with the T889 migration applied.
 *
 * @task T889 / T904 / W4-8
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPlaybookApproval,
  createPlaybookRun,
  deletePlaybookRun,
  getPlaybookApprovalByToken,
  getPlaybookRun,
  listPlaybookApprovals,
  listPlaybookRuns,
  updatePlaybookApproval,
  updatePlaybookRun,
} from '../state.js';

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

describe('W4-8: playbook state CRUD', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigration(db, readFileSync(MIGRATION_SQL, 'utf8'));
  });
  afterEach(() => db.close());

  describe('playbook runs', () => {
    it('createPlaybookRun returns row with UUID + running status + empty bindings', () => {
      const run = createPlaybookRun(db, {
        playbookName: 'rcasd',
        playbookHash: 'sha-1',
      });
      expect(run.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(run.playbookName).toBe('rcasd');
      expect(run.playbookHash).toBe('sha-1');
      expect(run.status).toBe('running');
      expect(run.bindings).toEqual({});
      expect(run.iterationCounts).toEqual({});
      expect(run.currentNode).toBeNull();
      expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('createPlaybookRun serializes initialBindings into JSON column', () => {
      const run = createPlaybookRun(db, {
        playbookName: 'rcasd',
        playbookHash: 'sha-2',
        initialBindings: { taskId: 'T123', attempt: 1 },
      });
      expect(run.bindings).toEqual({ taskId: 'T123', attempt: 1 });

      const fetched = getPlaybookRun(db, run.runId);
      expect(fetched?.bindings).toEqual({ taskId: 'T123', attempt: 1 });
    });

    it('getPlaybookRun returns null for unknown runId', () => {
      expect(getPlaybookRun(db, 'does-not-exist')).toBeNull();
    });

    it('updatePlaybookRun patches currentNode, bindings, and status atomically', () => {
      const run = createPlaybookRun(db, {
        playbookName: 'rcasd',
        playbookHash: 'sha-3',
      });
      const updated = updatePlaybookRun(db, run.runId, {
        currentNode: 'approval-publish',
        status: 'paused',
        bindings: { resumeToken: 'tok-abc' },
        iterationCounts: { 'agentic-assess': 2 },
      });
      expect(updated.currentNode).toBe('approval-publish');
      expect(updated.status).toBe('paused');
      expect(updated.bindings).toEqual({ resumeToken: 'tok-abc' });
      expect(updated.iterationCounts).toEqual({ 'agentic-assess': 2 });
    });

    it('updatePlaybookRun rejects unknown run id', () => {
      expect(() => updatePlaybookRun(db, 'missing', { status: 'completed' })).toThrow(
        /not found for update/,
      );
    });

    it('listPlaybookRuns filters by status', () => {
      const a = createPlaybookRun(db, { playbookName: 'p', playbookHash: 'h' });
      const b = createPlaybookRun(db, { playbookName: 'p', playbookHash: 'h' });
      updatePlaybookRun(db, a.runId, { status: 'completed' });

      const completed = listPlaybookRuns(db, { status: 'completed' });
      expect(completed.map((r) => r.runId)).toEqual([a.runId]);
      const running = listPlaybookRuns(db, { status: 'running' });
      expect(running.map((r) => r.runId)).toEqual([b.runId]);
    });

    it('listPlaybookRuns filters by epicId', () => {
      const a = createPlaybookRun(db, {
        playbookName: 'p',
        playbookHash: 'h',
        epicId: 'T889',
      });
      createPlaybookRun(db, {
        playbookName: 'p',
        playbookHash: 'h',
        epicId: 'T900',
      });
      const t889 = listPlaybookRuns(db, { epicId: 'T889' });
      expect(t889.map((r) => r.runId)).toEqual([a.runId]);
    });

    it('deletePlaybookRun CASCADE removes associated approvals', () => {
      const run = createPlaybookRun(db, {
        playbookName: 'p',
        playbookHash: 'h',
      });
      createPlaybookApproval(db, {
        runId: run.runId,
        nodeId: 'approval-1',
        token: 'tok-cascade-test-000000000000000',
      });
      expect(listPlaybookApprovals(db, run.runId)).toHaveLength(1);

      const removed = deletePlaybookRun(db, run.runId);
      expect(removed).toBe(true);
      expect(getPlaybookRun(db, run.runId)).toBeNull();
      expect(listPlaybookApprovals(db, run.runId)).toHaveLength(0);
    });

    it('deletePlaybookRun returns false when nothing was removed', () => {
      expect(deletePlaybookRun(db, 'no-such-run')).toBe(false);
    });
  });

  describe('playbook approvals', () => {
    it('createPlaybookApproval generates approvalId UUID + pending status', () => {
      const run = createPlaybookRun(db, {
        playbookName: 'p',
        playbookHash: 'h',
      });
      const approval = createPlaybookApproval(db, {
        runId: run.runId,
        nodeId: 'approval-publish',
        token: 'tok-approval-create-00000000000',
      });
      expect(approval.approvalId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(approval.status).toBe('pending');
      expect(approval.autoPassed).toBe(false);
      expect(approval.nodeId).toBe('approval-publish');
    });

    it('getPlaybookApprovalByToken finds approval by exact token', () => {
      const run = createPlaybookRun(db, {
        playbookName: 'p',
        playbookHash: 'h',
      });
      const approval = createPlaybookApproval(db, {
        runId: run.runId,
        nodeId: 'approval-publish',
        token: 'tok-lookup-exact-0000000000000000',
      });
      const fetched = getPlaybookApprovalByToken(db, 'tok-lookup-exact-0000000000000000');
      expect(fetched?.approvalId).toBe(approval.approvalId);
      expect(getPlaybookApprovalByToken(db, 'tok-lookup-exact-DIFFERENT-00000')).toBeNull();
    });

    it('updatePlaybookApproval sets approvedAt, approver, and status', () => {
      const run = createPlaybookRun(db, {
        playbookName: 'p',
        playbookHash: 'h',
      });
      const approval = createPlaybookApproval(db, {
        runId: run.runId,
        nodeId: 'approval-publish',
        token: 'tok-update-target-0000000000000',
      });
      const approvedAt = '2026-04-17T22:00:00Z';
      const updated = updatePlaybookApproval(db, approval.approvalId, {
        approvedAt,
        approver: 'kryptokeaton',
        status: 'approved',
        reason: 'explicit human approval',
      });
      expect(updated.approvedAt).toBe(approvedAt);
      expect(updated.approver).toBe('kryptokeaton');
      expect(updated.status).toBe('approved');
      expect(updated.reason).toBe('explicit human approval');
    });

    it('listPlaybookApprovals returns rows in requestedAt order with stable secondary key', () => {
      const run = createPlaybookRun(db, {
        playbookName: 'p',
        playbookHash: 'h',
      });
      const a = createPlaybookApproval(db, {
        runId: run.runId,
        nodeId: 'approval-1',
        token: 'tok-order-first-000000000000000',
      });
      const b = createPlaybookApproval(db, {
        runId: run.runId,
        nodeId: 'approval-2',
        token: 'tok-order-second-000000000000000',
      });
      const rows = listPlaybookApprovals(db, run.runId);
      // Second-resolution datetime('now') means requested_at ties are common;
      // secondary sort is approval_id ASC, so compare against that canonical order.
      const expected = [a.approvalId, b.approvalId].sort();
      expect(rows.map((r) => r.approvalId)).toEqual(expected);
      expect(rows).toHaveLength(2);
    });
  });

  describe('JSON column parse failure', () => {
    it('throws descriptive error on malformed bindings column', () => {
      const run = createPlaybookRun(db, {
        playbookName: 'p',
        playbookHash: 'h',
      });
      db.prepare('UPDATE playbook_runs SET bindings = ? WHERE run_id = ?').run(
        '{not-json',
        run.runId,
      );
      expect(() => getPlaybookRun(db, run.runId)).toThrow(/failed to parse JSON column "bindings"/);
    });
  });
});
