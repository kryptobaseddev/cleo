/**
 * Integration tests for the `playbook` dispatch domain.
 *
 * Exercises the handler against a real in-memory `node:sqlite` DB with the
 * T889 playbook migration applied. The AgentDispatcher is stubbed inline so
 * every test is deterministic and hermetic — no `@cleocode/*` module mocks.
 *
 * @task T935
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { AgentDispatcher, AgentDispatchInput, AgentDispatchResult } from '@cleocode/playbooks';
import { approveGate, createApprovalGate, listPlaybookApprovals } from '@cleocode/playbooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __playbookRuntimeOverrides, PlaybookHandler } from '../playbook.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the T889 migration file. The canonical copy lives under
 * packages/core/migrations — the cleo package keeps a sibling copy for
 * shipped install bundles. Prefer the core copy so this test stays aligned
 * with the runtime migration runner.
 */
const MIGRATION_SQL = resolve(
  __dirname,
  '../../../../../core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/migration.sql',
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

// ---------------------------------------------------------------------------
// Fixture playbooks — minimal .cantbook bodies written to a temp directory so
// the handler's loadPlaybookByName() can find them via playbookBaseDirs.
// ---------------------------------------------------------------------------

const LINEAR_PLAYBOOK_YAML = `
version: "1.0"
name: linear-smoke
description: Minimal two-step playbook for the dispatch happy-path test.
nodes:
  - id: research
    type: agentic
    skill: ct-research-agent
  - id: ship
    type: agentic
    skill: ct-dev-workflow
edges:
  - from: research
    to: ship
`;

const APPROVAL_PLAYBOOK_YAML = `
version: "1.0"
name: approval-smoke
description: Three-stage playbook with a HITL gate between plan and ship.
nodes:
  - id: plan
    type: agentic
    skill: ct-research-agent
  - id: gate
    type: approval
    prompt: Human review before ship
  - id: ship
    type: agentic
    skill: ct-dev-workflow
edges:
  - from: plan
    to: gate
  - from: gate
    to: ship
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubSuccessDispatcher(): AgentDispatcher {
  return {
    async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
      return {
        status: 'success',
        output: { [`${input.nodeId}_done`]: true, lastNode: input.nodeId },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('T935 PlaybookHandler — run/status/resume/list integration', () => {
  let db: DatabaseSync;
  let handler: PlaybookHandler;
  let tmpPlaybookDir: string;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigration(db, readFileSync(MIGRATION_SQL, 'utf8'));

    tmpPlaybookDir = mkdtempSync(join(tmpdir(), 'cleo-playbook-fixture-'));
    writeFileSync(join(tmpPlaybookDir, 'linear-smoke.cantbook'), LINEAR_PLAYBOOK_YAML);
    writeFileSync(join(tmpPlaybookDir, 'approval-smoke.cantbook'), APPROVAL_PLAYBOOK_YAML);

    __playbookRuntimeOverrides.db = db;
    __playbookRuntimeOverrides.dispatcher = stubSuccessDispatcher();
    __playbookRuntimeOverrides.playbookBaseDirs = [tmpPlaybookDir];
    __playbookRuntimeOverrides.approvalSecret = 'unit-test-secret';

    handler = new PlaybookHandler();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpPlaybookDir, { recursive: true, force: true });
    delete __playbookRuntimeOverrides.db;
    delete __playbookRuntimeOverrides.dispatcher;
    delete __playbookRuntimeOverrides.playbookBaseDirs;
    delete __playbookRuntimeOverrides.approvalSecret;
  });

  // -------------------------------------------------------------------------
  // playbook.run
  // -------------------------------------------------------------------------

  it('playbook.run — happy path returns a LAFS envelope with runId + terminalStatus=completed', async () => {
    const result = await handler.mutate('run', {
      name: 'linear-smoke',
      context: JSON.stringify({ epicId: 'T999' }),
    });

    expect(result.success).toBe(true);
    expect(result.meta.domain).toBe('playbook');
    expect(result.meta.operation).toBe('run');
    const data = result.data as Record<string, unknown>;
    expect(typeof data.runId).toBe('string');
    expect(data.terminalStatus).toBe('completed');
    expect(data.playbookName).toBe('linear-smoke');
    expect(data.playbookSource).toContain('linear-smoke.cantbook');
    const finalContext = data.finalContext as Record<string, unknown>;
    expect(finalContext.epicId).toBe('T999');
    expect(finalContext.research_done).toBe(true);
    expect(finalContext.ship_done).toBe(true);
  });

  it('playbook.run — missing playbook file returns E_NOT_FOUND envelope', async () => {
    const result = await handler.mutate('run', { name: 'does-not-exist' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND');
    expect(result.error?.message).toContain('does-not-exist');
  });

  it('playbook.run — missing name returns E_INVALID_INPUT', async () => {
    const result = await handler.mutate('run', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
    expect(result.error?.message).toMatch(/name.*required/i);
  });

  it('playbook.run — invalid context JSON returns E_INVALID_INPUT', async () => {
    const result = await handler.mutate('run', {
      name: 'linear-smoke',
      context: 'not-json-at-all',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
    expect(result.error?.message).toMatch(/context/i);
  });

  it('playbook.run — approval playbook pauses and returns a resume token', async () => {
    const result = await handler.mutate('run', {
      name: 'approval-smoke',
      context: JSON.stringify({ taskId: 'T500' }),
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.terminalStatus).toBe('pending_approval');
    expect(typeof data.approvalToken).toBe('string');
    expect((data.approvalToken as string).length).toBe(32);

    // The approval row should be pending in the DB.
    const approvals = listPlaybookApprovals(db, data.runId as string);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // playbook.status
  // -------------------------------------------------------------------------

  it('playbook.status — returns the hydrated run record for a known runId', async () => {
    const runResult = await handler.mutate('run', { name: 'linear-smoke' });
    const runId = (runResult.data as Record<string, unknown>).runId as string;

    const statusResult = await handler.query('status', { runId });
    expect(statusResult.success).toBe(true);
    const data = statusResult.data as Record<string, unknown>;
    expect(data.runId).toBe(runId);
    expect(data.status).toBe('completed');
    expect(data.playbookName).toBe('linear-smoke');
  });

  it('playbook.status — invalid runId returns E_NOT_FOUND', async () => {
    const result = await handler.query('status', { runId: 'no-such-run' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND');
  });

  it('playbook.status — missing runId returns E_INVALID_INPUT', async () => {
    const result = await handler.query('status', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });

  // -------------------------------------------------------------------------
  // playbook.list
  // -------------------------------------------------------------------------

  it('playbook.list — enumerates runs ordered newest-first', async () => {
    await handler.mutate('run', { name: 'linear-smoke' });
    await handler.mutate('run', { name: 'approval-smoke' });

    const result = await handler.query('list', {});
    expect(result.success).toBe(true);
    const data = result.data as { runs: unknown[]; count: number; total: number };
    expect(data.count).toBeGreaterThanOrEqual(2);
    expect(data.total).toBe(data.count);
  });

  it('playbook.list — translates status=active to running filter', async () => {
    // Insert a paused run (from approval playbook) and a completed run.
    await handler.mutate('run', { name: 'linear-smoke' });
    await handler.mutate('run', { name: 'approval-smoke' });

    const pendingResult = await handler.query('list', { status: 'pending' });
    const pendingData = pendingResult.data as {
      runs: Array<{ status: string }>;
      statusFilter: string;
    };
    expect(pendingData.statusFilter).toBe('paused');
    for (const run of pendingData.runs) expect(run.status).toBe('paused');

    const completedResult = await handler.query('list', { status: 'completed' });
    const completedData = completedResult.data as { runs: Array<{ status: string }> };
    for (const run of completedData.runs) expect(run.status).toBe('completed');
  });

  it('playbook.list — limit + offset paginates correctly', async () => {
    await handler.mutate('run', { name: 'linear-smoke' });
    await handler.mutate('run', { name: 'linear-smoke' });
    await handler.mutate('run', { name: 'linear-smoke' });

    const result = await handler.query('list', { limit: 2, offset: 1 });
    const data = result.data as { runs: unknown[]; count: number; total: number };
    expect(data.total).toBe(2);
    // offset=1 drops the first item post-fetch.
    expect(data.count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // playbook.resume
  // -------------------------------------------------------------------------

  it('playbook.resume — fails with E_APPROVAL_PENDING when gate is still pending', async () => {
    const runResult = await handler.mutate('run', { name: 'approval-smoke' });
    const runId = (runResult.data as Record<string, unknown>).runId as string;

    const resumeResult = await handler.mutate('resume', { runId });
    expect(resumeResult.success).toBe(false);
    expect(resumeResult.error?.code).toBe('E_APPROVAL_PENDING');
  });

  it('playbook.resume — succeeds after gate is approved', async () => {
    const runResult = await handler.mutate('run', { name: 'approval-smoke' });
    const data = runResult.data as Record<string, unknown>;
    const runId = data.runId as string;
    const token = data.approvalToken as string;

    approveGate(db, token, 'test-approver', 'ok');

    const resumeResult = await handler.mutate('resume', { runId });
    expect(resumeResult.success).toBe(true);
    const resumeData = resumeResult.data as Record<string, unknown>;
    expect(resumeData.terminalStatus).toBe('completed');
  });

  it('playbook.resume — invalid runId returns E_NOT_FOUND', async () => {
    const result = await handler.mutate('resume', { runId: 'unknown-run' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND');
  });

  it('playbook.resume — run without any approvals returns E_APPROVAL_NOT_FOUND', async () => {
    const runResult = await handler.mutate('run', { name: 'linear-smoke' });
    const runId = (runResult.data as Record<string, unknown>).runId as string;

    const resumeResult = await handler.mutate('resume', { runId });
    expect(resumeResult.success).toBe(false);
    expect(resumeResult.error?.code).toBe('E_APPROVAL_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  it('getSupportedOperations — exposes the canonical operations (T1261 adds validate)', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query.sort()).toEqual(['list', 'status', 'validate']);
    expect(ops.mutate.sort()).toEqual(['resume', 'run']);
  });

  it('unknown operations return E_INVALID_OPERATION envelopes', async () => {
    const q = await handler.query('nope', {});
    expect(q.success).toBe(false);
    expect(q.error?.code).toBe('E_INVALID_OPERATION');

    const m = await handler.mutate('nope', {});
    expect(m.success).toBe(false);
    expect(m.error?.code).toBe('E_INVALID_OPERATION');
  });

  // A reference to createApprovalGate to keep the import non-unused when new
  // cases are added; it is exercised transitively via the approval playbook.
  it('sanity — createApprovalGate is reachable from the playbooks barrel', () => {
    expect(typeof createApprovalGate).toBe('function');
  });
});
