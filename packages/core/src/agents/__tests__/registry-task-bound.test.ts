/**
 * The agent registry on a store whose tasks live in `tasks_tasks`, with
 * foreign keys ON (T14387).
 *
 * The bare `agent_instances` table carries FKs to the bare `tasks` and
 * `sessions` decoys, so a task- or session-bound registration there failed
 * `FOREIGN KEY constraint failed`. The registry now reads and writes only the
 * prefixed `tasks_agent_instances`, so this file deliberately does NOT opt out
 * of foreign keys.
 *
 * @module agents/__tests__/registry-task-bound.test
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAllDatabases, getDb } from '../../store/sqlite.js';
import { sessions, tasks } from '../../store/tasks-schema.js';
import {
  deregisterAgent,
  getAgentErrorHistory,
  getAgentInstance,
  listAgentInstances,
  registerAgent,
  updateAgentStatus,
} from '../registry.js';

/** Row count of `table` in the project store at `cwd`. */
async function countRows(cwd: string, table: string): Promise<number> {
  const db = await getDb(cwd);
  const row = db.get<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM ${table}`));
  return row.n;
}

describe('agent registry, task-bound rows (T14387)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-agent-fk-test-'));
    await mkdir(join(tempDir, '.cleo', 'backups', 'operational'), { recursive: true });
  });

  afterEach(async () => {
    await closeAllDatabases();
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  });

  it('registers an agent bound to a tasks_tasks task and a tasks_sessions session', async () => {
    const db = await getDb(tempDir);
    expect(db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`).foreign_keys).toBe(1);
    db.insert(sessions)
      .values({
        id: 'ses_fk_1',
        name: 'FK session',
        status: 'active',
        scopeJson: '{"type":"global"}',
        startedAt: new Date().toISOString(),
      })
      .run();
    db.insert(tasks)
      .values({
        id: 'T001',
        title: 'FK task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      })
      .run();
    expect(await countRows(tempDir, 'tasks_tasks')).toBe(1);

    const agent = await registerAgent(
      { agentType: 'executor', taskId: 'T001', sessionId: 'ses_fk_1' },
      tempDir,
    );

    expect(agent.taskId).toBe('T001');
    expect(agent.sessionId).toBe('ses_fk_1');
    expect((await getAgentInstance(agent.id, tempDir))?.taskId).toBe('T001');
    expect((await listAgentInstances({ sessionId: 'ses_fk_1' }, tempDir)).map((a) => a.id)).toEqual(
      [agent.id],
    );
  });

  it('reads and writes only tasks_agent_instances and tasks_agent_error_log', async () => {
    const agent = await registerAgent({ agentType: 'executor', taskId: 'T404' }, tempDir);
    await updateAgentStatus(agent.id, { status: 'error', error: 'boom' }, tempDir);
    await deregisterAgent(agent.id, tempDir);

    expect(await countRows(tempDir, 'tasks_agent_instances')).toBe(1);
    expect(await countRows(tempDir, 'tasks_agent_error_log')).toBe(1);
    expect(await countRows(tempDir, 'agent_instances')).toBe(0);
    expect(await countRows(tempDir, 'agent_error_log')).toBe(0);
    expect((await getAgentInstance(agent.id, tempDir))?.status).toBe('stopped');
    expect(await getAgentErrorHistory(agent.id, tempDir)).toHaveLength(1);
  });
});
