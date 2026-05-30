/**
 * Attention dispatch handler tests (T11373 · Epic T11288).
 *
 * Drives the REAL {@link AttentionHandler} against a real SQLite-backed
 * brain.db (+ tasks.db) via {@link createTestDb}, with `getProjectRoot` mocked
 * to the temp project and `CLEO_SESSION_ID` / `CLEO_AGENT_ID` set in the
 * environment. Asserts the persisted row carries the ENV-resolved
 * session/agent and the NARROWEST scope — proving identity comes from the
 * caller's env (E0), not "whoever touched the DB last".
 *
 * @task T11373
 * @epic T11288
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const projectRootRef = { current: '/unset' };

vi.mock('../../../../../core/src/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
    '../../../../../core/src/paths.js',
  );
  return {
    ...actual,
    getProjectRoot: vi.fn(() => projectRootRef.current),
  };
});

import { writeFocusState } from '../../../../../core/src/sessions/focus-state-store.js';
import {
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../../../../core/src/store/__tests__/test-db-helper.js';
import { getBrainAccessor } from '../../../../../core/src/store/memory-accessor.js';
import { closeBrainDb } from '../../../../../core/src/store/memory-sqlite.js';
import { AttentionHandler } from '../attention.js';

const ENV_KEYS = ['CLEO_SESSION_ID', 'CLEO_SESSION', 'CLEO_AGENT_ID'];

describe('AttentionHandler dispatch (T11373 · Epic T11288)', () => {
  let env: TestDbEnv;
  let handler: AttentionHandler;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    env = await createTestDb();
    projectRootRef.current = env.tempDir;
    closeBrainDb();
    handler = new AttentionHandler();
    await seedTasks(env.accessor, [
      { id: 'T900', title: 'Saga', type: 'saga' },
      { id: 'T100', title: 'Epic', type: 'epic', parentId: 'T900' },
      { id: 'T001', title: 'Task A', type: 'task', parentId: 'T100' },
    ]);
  });

  afterEach(async () => {
    closeBrainDb();
    await env.cleanup();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('auto-resolves env identity + narrowest scope on attention.add', async () => {
    const sessionId = 'ses_20260530000020_aaaaaa';
    process.env['CLEO_SESSION_ID'] = sessionId;
    process.env['CLEO_AGENT_ID'] = 'agent-alpha';
    await writeFocusState(env.accessor, sessionId, { currentTask: 'T001' });

    const res = await handler.mutate('add', { content: 'wire the digest' });
    expect(res.success).toBe(true);

    // The persisted row carries the ENV-resolved identity + narrowest scope.
    const accessor = await getBrainAccessor(env.tempDir);
    const rows = await accessor.findAttention({});
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.sessionId).toBe(sessionId);
    expect(row.agentId).toBe('agent-alpha');
    expect(row.scopeKind).toBe('agent');
    expect(row.scopeId).toBe('agent-alpha');
    expect(row.content).toBe('wire the digest');
  });

  it('rejects empty content with a typed E_INVALID_INPUT envelope (no console.log)', async () => {
    process.env['CLEO_SESSION_ID'] = 'ses_20260530000021_bbbbbb';
    const res = await handler.mutate('add', { content: '   ' });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_INVALID_INPUT');
  });

  it('attention.show emits open items for the resolved scope as a LAFS envelope', async () => {
    const sessionId = 'ses_20260530000022_cccccc';
    process.env['CLEO_SESSION_ID'] = sessionId;
    process.env['CLEO_AGENT_ID'] = 'agent-beta';
    await writeFocusState(env.accessor, sessionId, { currentTask: 'T001' });

    await handler.mutate('add', { content: 'first jot', tags: ['x'] });
    await handler.mutate('add', { content: 'second jot' });

    const res = await handler.query('show', {});
    expect(res.success).toBe(true);
    const data = res.data as { items: Array<{ content: string }>; total: number };
    expect(data.total).toBe(2);
    expect(data.items.map((i) => i.content).sort()).toEqual(['first jot', 'second jot']);

    // Tag filter narrows in SQL.
    const tagged = await handler.query('show', { tags: ['x'] });
    const tdata = tagged.data as { items: Array<{ content: string }> };
    expect(tdata.items.map((i) => i.content)).toEqual(['first jot']);
  });

  it('honors an explicit --scope escalation through the dispatch op', async () => {
    const sessionId = 'ses_20260530000023_dddddd';
    process.env['CLEO_SESSION_ID'] = sessionId;
    process.env['CLEO_AGENT_ID'] = 'agent-gamma';
    await writeFocusState(env.accessor, sessionId, { currentTask: 'T001' });

    const res = await handler.mutate('add', { content: 'saga-wide', scope: 'saga' });
    expect(res.success).toBe(true);
    const data = res.data as { item: { scopeKind: string; scopeId: string } };
    expect(data.item.scopeKind).toBe('saga');
    expect(data.item.scopeId).toBe('T900');
  });

  it('rejects unknown operations with E_INVALID_OPERATION', async () => {
    const res = await handler.query('bogus', {});
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_INVALID_OPERATION');
  });
});
