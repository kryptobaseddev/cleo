/**
 * W4-6 schema + contracts real-sqlite tests (no mocks).
 * @task T889 / T904 / W4-6
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type {
  PlaybookApproval,
  PlaybookApprovalStatus,
  PlaybookDefinition,
  PlaybookNode,
  PlaybookRun,
  PlaybookRunStatus,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { playbookApprovals, playbookRuns } from '../schema.js';

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
    // Strip leading comment-only lines but keep SQL bodies
    const lines = stmt.split('\n');
    const hasSql = lines.some((l) => l.trim().length > 0 && !l.trim().startsWith('--'));
    if (hasSql) db.exec(stmt);
  }
}

describe('W4-6: Playbook contracts + Drizzle schema', () => {
  describe('contract types are assignable', () => {
    it('PlaybookRun round-trip type', () => {
      const run: PlaybookRun = {
        runId: 'r1',
        playbookName: 'rcasd',
        playbookHash: 'abc',
        currentNode: null,
        bindings: {},
        errorContext: null,
        status: 'running' satisfies PlaybookRunStatus,
        iterationCounts: {},
        startedAt: new Date().toISOString(),
      };
      expect(run.status).toBe('running');
    });

    it('PlaybookApproval round-trip type', () => {
      const a: PlaybookApproval = {
        approvalId: 'a1',
        runId: 'r1',
        nodeId: 'n1',
        token: 'abcdef0123456789abcdef0123456789',
        requestedAt: new Date().toISOString(),
        status: 'pending' satisfies PlaybookApprovalStatus,
        autoPassed: false,
      };
      expect(a.token).toHaveLength(32);
    });

    it('PlaybookDefinition accepts all three node kinds', () => {
      const nodes: PlaybookNode[] = [
        { id: 'n1', type: 'agentic', skill: 'ct-research-agent', role: 'lead' },
        { id: 'n2', type: 'deterministic', command: 'pnpm', args: ['biome', 'ci', '.'] },
        { id: 'n3', type: 'approval', prompt: 'Approve?' },
      ];
      const def: PlaybookDefinition = { version: '1.0', name: 'test', nodes, edges: [] };
      expect(def.nodes).toHaveLength(3);
    });
  });

  describe('Drizzle table objects', () => {
    it('playbookRuns exposes 12 columns', () => {
      const cols = Object.keys(playbookRuns);
      for (const n of [
        'runId',
        'playbookName',
        'playbookHash',
        'currentNode',
        'bindings',
        'errorContext',
        'status',
        'iterationCounts',
        'epicId',
        'sessionId',
        'startedAt',
        'completedAt',
      ]) {
        expect(cols).toContain(n);
      }
    });

    it('playbookApprovals exposes 10 columns', () => {
      const cols = Object.keys(playbookApprovals);
      for (const n of [
        'approvalId',
        'runId',
        'nodeId',
        'token',
        'requestedAt',
        'approvedAt',
        'approver',
        'reason',
        'status',
        'autoPassed',
      ]) {
        expect(cols).toContain(n);
      }
    });
  });

  describe('migration against in-memory sqlite', () => {
    let db: DatabaseSync;

    beforeEach(() => {
      db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys=ON');
      applyMigration(db, readFileSync(MIGRATION_SQL, 'utf8'));
    });
    afterEach(() => db.close());

    it('playbook_runs has 12 columns with constraints', () => {
      const cols = db.prepare('PRAGMA table_info(playbook_runs)').all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
      const m = new Map(cols.map((c) => [c.name, c]));
      expect(cols).toHaveLength(12);
      expect(m.get('run_id')?.pk).toBe(1);
      expect(m.get('status')?.dflt_value).toBe("'running'");
    });

    it('playbook_approvals has 10 columns', () => {
      const cols = db.prepare('PRAGMA table_info(playbook_approvals)').all() as Array<{
        name: string;
        dflt_value: string | null;
        pk: number;
      }>;
      expect(cols).toHaveLength(10);
    });

    it('CHECK constraint rejects invalid status', () => {
      db.exec(
        "INSERT INTO playbook_runs (run_id, playbook_name, playbook_hash) VALUES ('r1', 'p', 'h')",
      );
      expect(() => {
        db.exec("UPDATE playbook_runs SET status='invalid' WHERE run_id='r1'");
      }).toThrow();
    });

    it('CASCADE DELETE removes approvals with parent run', () => {
      db.exec(
        "INSERT INTO playbook_runs (run_id, playbook_name, playbook_hash) VALUES ('r2', 'p', 'h')",
      );
      db.exec(
        "INSERT INTO playbook_approvals (approval_id, run_id, node_id, token) VALUES ('a2', 'r2', 'n1', 'tok2000000000000000000000000000000')",
      );
      db.exec("DELETE FROM playbook_runs WHERE run_id='r2'");
      const g = db.prepare("SELECT * FROM playbook_approvals WHERE approval_id='a2'").get();
      expect(g).toBeUndefined();
    });

    it('UNIQUE token constraint rejects duplicate', () => {
      db.exec(
        "INSERT INTO playbook_runs (run_id, playbook_name, playbook_hash) VALUES ('r3', 'p', 'h')",
      );
      db.exec(
        "INSERT INTO playbook_approvals (approval_id, run_id, node_id, token) VALUES ('a3a', 'r3', 'n1', 'DUPTOK00000000000000000000000000')",
      );
      expect(() => {
        db.exec(
          "INSERT INTO playbook_approvals (approval_id, run_id, node_id, token) VALUES ('a3b', 'r3', 'n1', 'DUPTOK00000000000000000000000000')",
        );
      }).toThrow();
    });

    it('round-trips a playbook_run', () => {
      db.exec(
        "INSERT INTO playbook_runs (run_id, playbook_name, playbook_hash, status) VALUES ('rt', 'rcasd', 'sha', 'running')",
      );
      const row = db.prepare('SELECT * FROM playbook_runs WHERE run_id=?').get('rt') as {
        run_id: string;
        status: string;
        bindings: string;
      };
      expect(row.run_id).toBe('rt');
      expect(row.status).toBe('running');
      expect(row.bindings).toBe('{}');
    });
  });
});
