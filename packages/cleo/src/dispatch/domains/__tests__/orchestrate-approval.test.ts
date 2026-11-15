/**
 * Integration tests for the HITL approval operations added to the
 * `orchestrate` dispatch domain: `approve`, `reject`, and `pending`.
 *
 * Exercises against a real in-memory `node:sqlite` DB with the playbook twin
 * tables applied; zero `@cleocode/*` module mocks.
 *
 * @task T935
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { OWNER_SESSION_MARK } from '@cleocode/core/security/owner-override-auth';
import { createTestDb, type TestDbEnv } from '@cleocode/core/store/__tests__/test-db-helper';
import { createSession, setSessionOwnerAuthToken } from '@cleocode/core/store/session-store';
import { createApprovalGate, createPlaybookRun, getPendingApprovals } from '@cleocode/playbooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestrateHandler } from '../orchestrate.js';
import { __playbookRuntimeOverrides } from '../playbook.js';

// Simulate owner and agent callers in this isolated test process, not the worker running vitest.
vi.hoisted(() => {
  delete process.env['CLEO_AGENT_ROLE'];
});

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_MIGRATIONS = resolve(
  __dirname,
  '../../../../../core/migrations/drizzle-cleo-project',
);

/** The playbook twins the state layer writes, as a project store creates them (T12535). */
function playbookTwinSql(): string {
  const consolidation = readFileSync(
    resolve(PROJECT_MIGRATIONS, '20260531000001_t11363-consolidation-cleo-project/migration.sql'),
    'utf8',
  );
  const tables = ['tasks_playbook_runs', 'tasks_playbook_approvals'].map(
    (t) => consolidation.match(new RegExp(`CREATE TABLE \`${t}\` \\([\\s\\S]*?\\n\\);`))?.[0] ?? '',
  );
  const uids = readFileSync(
    resolve(PROJECT_MIGRATIONS, '20261016120000_t12535-playbook-row-uids/migration.sql'),
    'utf8',
  );
  return [...tables, uids].join('\n--> statement-breakpoint\n');
}

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

/**
 * Create a run+pending-gate pair used by approve/reject tests. Returns the
 * resume token attached to the fresh approval row.
 */
function seedPendingGate(
  db: DatabaseSync,
  opts: { runId?: string; nodeId?: string } = {},
): { token: string; runId: string; nodeId: string } {
  const run = createPlaybookRun(db, {
    playbookName: opts.runId ?? 'test-playbook',
    playbookHash: 'deadbeef',
    initialBindings: {},
  });
  const approval = createApprovalGate(db, {
    runId: run.runId,
    nodeId: opts.nodeId ?? 'gate',
    bindings: { foo: 'bar' },
    secret: 'unit-test-secret',
  });
  return { token: approval.token, runId: run.runId, nodeId: approval.nodeId };
}

describe('T935 OrchestrateHandler — HITL approval gate operations', () => {
  let db: DatabaseSync;
  let handler: OrchestrateHandler;
  let env: TestDbEnv;
  const tty = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };

  async function callerSession(id: string, owner: boolean): Promise<void> {
    await createSession(
      {
        id,
        name: id,
        status: 'active',
        scope: { type: 'global' },
        taskWork: { taskId: null, setAt: null },
        startedAt: new Date().toISOString(),
      },
      env.tempDir,
    );
    if (owner) await setSessionOwnerAuthToken(id, OWNER_SESSION_MARK, env.tempDir);
    vi.stubEnv('CLEO_SESSION_ID', id);
  }

  beforeEach(async () => {
    env = await createTestDb();
    vi.stubEnv('CLEO_DIR', env.cleoDir);
    vi.stubEnv('CLEO_ROOT', env.tempDir);
    vi.stubEnv('CLEO_AGENT_ROLE', undefined);
    vi.stubEnv('CLEO_OWNER_OVERRIDE', undefined);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    await callerSession('ses_approval_owner', true);
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigration(db, playbookTwinSql());

    __playbookRuntimeOverrides.db = db;
    handler = new OrchestrateHandler();
  });

  afterEach(async () => {
    db.close();
    delete __playbookRuntimeOverrides.db;
    Object.defineProperty(process.stdin, 'isTTY', { value: tty.stdin, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: tty.stderr, configurable: true });
    await env.cleanup();
    vi.unstubAllEnvs();
  });

  // -------------------------------------------------------------------------
  // orchestrate.pending
  // -------------------------------------------------------------------------

  it('orchestrate.pending — returns empty list when no gates are pending', async () => {
    const result = await handler.query('pending', {});
    expect(result.success).toBe(true);
    const data = result.data as { approvals: unknown[]; count: number; total: number };
    expect(data.count).toBe(0);
    expect(data.approvals).toEqual([]);
  });

  it('orchestrate.pending — enumerates every pending gate across runs', async () => {
    seedPendingGate(db, { runId: 'run-a' });
    seedPendingGate(db, { runId: 'run-b' });

    const result = await handler.query('pending', {});
    expect(result.success).toBe(true);
    const data = result.data as {
      approvals: Array<{ status: string }>;
      count: number;
      total: number;
    };
    expect(data.count).toBe(2);
    for (const a of data.approvals) expect(a.status).toBe('pending');
  });

  it('orchestrate.pending — exposes tokens only to the owner on their own terminal', async () => {
    const { token } = seedPendingGate(db);
    expect((await handler.query('pending', {})).data).toMatchObject({
      approvals: [expect.objectContaining({ token })],
      count: 1,
    });
    await callerSession('ses_approval_agent', false);
    const agent = await handler.query('pending', {});
    expect(agent.success).toBe(true);
    expect(agent.data).toMatchObject({
      approvals: [expect.objectContaining({ status: 'pending' })],
      count: 1,
    });
    expect(JSON.stringify(agent.data)).not.toContain(token);
    vi.stubEnv('CLEO_SESSION_ID', 'ses_approval_owner');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    expect(JSON.stringify((await handler.query('pending', {})).data)).not.toContain(token);
  });

  it.each([
    'approve',
    'reject',
  ])('orchestrate.%s — refuses an agent session even with a valid token and an owner label', async (operation) => {
    const { token } = seedPendingGate(db);
    await callerSession('ses_unlabelled_agent', false);
    const result = await handler.mutate(operation, {
      resumeToken: token,
      approver: 'owner',
      reason: 'agent says yes',
    });
    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'E_OVERRIDE_NOT_OWNER',
        fix: expect.stringContaining('cleo session start --scope global --name owner --owner'),
      },
    });
    expect(getPendingApprovals(db)).toEqual([
      expect.objectContaining({ token, status: 'pending' }),
    ]);
  });

  it.each([
    'worker',
    'lead',
    'subagent',
  ])('refuses role %s even in an owner-marked session with a terminal', async (role) => {
    const { token } = seedPendingGate(db);
    vi.stubEnv('CLEO_AGENT_ROLE', role);
    for (const operation of ['approve', 'reject']) {
      expect(
        await handler.mutate(operation, { resumeToken: token, reason: 'reviewed' }),
      ).toMatchObject({
        success: false,
        error: { code: 'E_OVERRIDE_FORBIDDEN_AGENT_ROLE', fix: expect.any(String) },
      });
    }
    expect(JSON.stringify((await handler.query('pending', {})).data)).not.toContain(token);
    expect(getPendingApprovals(db)).toHaveLength(1);
  });

  it('refuses an owner-session agent without a terminal, including idempotent approval', async () => {
    const { token } = seedPendingGate(db);
    expect((await handler.mutate('approve', { resumeToken: token })).success).toBe(true);
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    for (const operation of ['approve', 'reject']) {
      expect(
        await handler.mutate(operation, { resumeToken: token, reason: 'reviewed' }),
      ).toMatchObject({
        success: false,
        error: { code: 'E_OVERRIDE_NOT_OWNER', fix: expect.any(String) },
      });
    }
  });

  it.each([
    'approve',
    'reject',
  ])('orchestrate.%s — refuses a legacy gate with a re-request fix', async (operation) => {
    const { token } = seedPendingGate(db);
    const legacy = 'a'.repeat(32);
    db.prepare('UPDATE tasks_playbook_approvals SET token = ? WHERE token = ?').run(legacy, token);
    expect(
      await handler.mutate(operation, { resumeToken: legacy, reason: 'reviewed' }),
    ).toMatchObject({
      success: false,
      error: {
        code: 'E_APPROVAL_TOKEN_LEGACY',
        fix: expect.stringContaining('cleo playbook run <name>'),
      },
    });
    expect(getPendingApprovals(db)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // orchestrate.approve
  // -------------------------------------------------------------------------

  it('orchestrate.approve — transitions a pending gate to approved and writes audit row', async () => {
    const { token } = seedPendingGate(db);

    const result = await handler.mutate('approve', {
      resumeToken: token,
      approver: 'owner',
      reason: 'ship it',
    });
    expect(result.success).toBe(true);
    const data = result.data as { status: string; approver?: string; reason?: string };
    expect(data.status).toBe('approved');
    expect(data.approver).toBe('owner');
    expect(data.reason).toBe('ship it');

    // Audit trail: the row in playbook_approvals is now approved.
    const row = db
      .prepare('SELECT status, approver, reason FROM tasks_playbook_approvals WHERE token = ?')
      .get(token) as { status: string; approver: string; reason: string } | undefined;
    expect(row?.status).toBe('approved');
    expect(row?.approver).toBe('owner');
    expect(row?.reason).toBe('ship it');
  });

  it('orchestrate.approve — missing resumeToken returns E_VALIDATION', async () => {
    const result = await handler.mutate('approve', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_VALIDATION');
  });

  it('orchestrate.approve — unknown token returns E_APPROVAL_NOT_FOUND', async () => {
    const result = await handler.mutate('approve', { resumeToken: 'not-a-real-token' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_APPROVAL_NOT_FOUND');
  });

  it('orchestrate.approve — is idempotent for double approval', async () => {
    const { token } = seedPendingGate(db);

    const first = await handler.mutate('approve', { resumeToken: token, approver: 'owner' });
    expect(first.success).toBe(true);

    const second = await handler.mutate('approve', {
      resumeToken: token,
      approver: 'second-caller',
    });
    expect(second.success).toBe(true);
    const data = second.data as Record<string, unknown>;
    expect(data.status).toBe('approved');
    expect(data.idempotent).toBe(true);
    // Double-approve MUST NOT overwrite the original approver.
    expect(data.approver).toBe('owner');
  });

  it('orchestrate.approve — rejects when gate was previously rejected', async () => {
    const { token } = seedPendingGate(db);
    await handler.mutate('reject', {
      resumeToken: token,
      reason: 'security concern',
    });

    const result = await handler.mutate('approve', { resumeToken: token });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_APPROVAL_ALREADY_DECIDED');
  });

  // -------------------------------------------------------------------------
  // orchestrate.reject
  // -------------------------------------------------------------------------

  it('orchestrate.reject — transitions a pending gate to rejected with the mandatory reason', async () => {
    const { token } = seedPendingGate(db);

    const result = await handler.mutate('reject', {
      resumeToken: token,
      reason: 'blocked pending security review',
      approver: 'owner',
    });
    expect(result.success).toBe(true);
    const data = result.data as { status: string; reason?: string };
    expect(data.status).toBe('rejected');
    expect(data.reason).toBe('blocked pending security review');
  });

  it('orchestrate.reject — missing reason returns E_VALIDATION', async () => {
    const { token } = seedPendingGate(db);
    const result = await handler.mutate('reject', { resumeToken: token });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_VALIDATION');
    expect(result.error?.message).toMatch(/reason/i);
  });

  it('orchestrate.reject — empty reason returns E_VALIDATION', async () => {
    const { token } = seedPendingGate(db);
    const result = await handler.mutate('reject', { resumeToken: token, reason: '   ' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_VALIDATION');
  });

  it('orchestrate.reject — missing resumeToken returns E_VALIDATION', async () => {
    const result = await handler.mutate('reject', { reason: 'because' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_VALIDATION');
  });

  it('orchestrate.reject — unknown token returns E_APPROVAL_NOT_FOUND', async () => {
    const result = await handler.mutate('reject', {
      resumeToken: 'no-such-token',
      reason: 'because',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_APPROVAL_NOT_FOUND');
  });

  it('orchestrate.reject — is idempotent for double rejection', async () => {
    const { token } = seedPendingGate(db);

    const first = await handler.mutate('reject', {
      resumeToken: token,
      reason: 'reason-1',
    });
    expect(first.success).toBe(true);

    const second = await handler.mutate('reject', {
      resumeToken: token,
      reason: 'reason-2',
    });
    expect(second.success).toBe(true);
    const data = second.data as Record<string, unknown>;
    expect(data.status).toBe('rejected');
    expect(data.idempotent).toBe(true);
    // Original reason preserved (no overwrite on idempotent replay).
    expect(data.reason).toBe('reason-1');
  });

  it('orchestrate.reject — rejects when gate was previously approved', async () => {
    const { token } = seedPendingGate(db);
    await handler.mutate('approve', { resumeToken: token, approver: 'owner' });

    const result = await handler.mutate('reject', {
      resumeToken: token,
      reason: 'changed my mind',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_APPROVAL_ALREADY_DECIDED');
  });

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  it('getSupportedOperations — exposes approve/reject/pending in the right gateways', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.mutate).toContain('approve');
    expect(ops.mutate).toContain('reject');
    expect(ops.query).toContain('pending');
  });
});
