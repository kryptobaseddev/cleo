/**
 * Attention CRUD core-module tests (T11372 · Epic T11288).
 *
 * Exercises the real `addAttention` / `listAttention` / `expireAttention`
 * code paths against a SQLite-backed brain.db (via {@link createTestDb}), with
 * env-first identity and per-session focus_state seeded so the narrowest-default
 * scope hierarchy resolves through the SAME path production uses.
 *
 * Coverage:
 *  - row-per-item storage (each jot is its own row, independently scoped);
 *  - narrowest-default scope resolution (agent > task > epic > saga > session);
 *  - add → list (open only) → expire transition;
 *  - multi-tag json_each filter returns EXACTLY the matching rows (no
 *    load-all-then-JS-filter; "contains ALL" semantics);
 *  - SQL-side filtering (a tag filter still honors the LIMIT).
 *
 * @task T11372
 * @epic T11288
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFocusState } from '../../sessions/focus-state-store.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import {
  addAttention,
  expireAttention,
  listAttention,
  resolveAttentionIdentity,
} from '../attention.js';

const ENV_KEYS = ['CLEO_SESSION_ID', 'CLEO_SESSION', 'CLEO_AGENT_ID'];

/** Run `fn` with the given session + agent identity in the environment. */
async function asAgent<T>(
  ids: { sessionId?: string; agentId?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  if (ids.sessionId) process.env['CLEO_SESSION_ID'] = ids.sessionId;
  else delete process.env['CLEO_SESSION_ID'];
  if (ids.agentId) process.env['CLEO_AGENT_ID'] = ids.agentId;
  else delete process.env['CLEO_AGENT_ID'];
  delete process.env['CLEO_SESSION'];
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('attention CRUD (T11372 · Epic T11288)', () => {
  let env: TestDbEnv;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    env = await createTestDb();
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();

    // Hierarchy: saga T900 -> epic T100 -> task T001.
    await seedTasks(env.accessor, [
      { id: 'T900', title: 'Saga', type: 'saga' },
      { id: 'T100', title: 'Epic', type: 'epic', parentId: 'T900' },
      { id: 'T001', title: 'Task A', type: 'task', parentId: 'T100' },
    ]);
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();
    await env.cleanup();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('resolves the narrowest-default scope chain via E0 identity + parent walk', async () => {
    const sessionId = 'ses_20260530000010_aaaaaa';
    await writeFocusState(env.accessor, sessionId, { currentTask: 'T001' });

    const identity = await asAgent({ sessionId, agentId: 'agent-x' }, () =>
      resolveAttentionIdentity(env.tempDir),
    );

    // Chain ordered narrowest -> broadest: agent, task, epic, saga, session, global.
    expect(identity.chain.map((s) => `${s.kind}:${s.id}`)).toEqual([
      'agent:agent-x',
      'task:T001',
      'epic:T100',
      'saga:T900',
      `session:${sessionId}`,
      'global:global',
    ]);
  });

  it('keys a jot to the NARROWEST scope (agent) by default', async () => {
    const sessionId = 'ses_20260530000011_bbbbbb';
    await writeFocusState(env.accessor, sessionId, { currentTask: 'T001' });

    const item = await asAgent({ sessionId, agentId: 'agent-x' }, () =>
      addAttention(env.tempDir, { content: 'remember the WAL reset' }),
    );
    expect(item.scopeKind).toBe('agent');
    expect(item.scopeId).toBe('agent-x');
    expect(item.status).toBe('open');
    expect(item.sessionId).toBe(sessionId);
  });

  it('escalates scope on explicit --scope override (epic)', async () => {
    const sessionId = 'ses_20260530000012_cccccc';
    await writeFocusState(env.accessor, sessionId, { currentTask: 'T001' });

    const item = await asAgent({ sessionId, agentId: 'agent-x' }, () =>
      addAttention(env.tempDir, { content: 'epic-wide note', scope: 'epic' }),
    );
    expect(item.scopeKind).toBe('epic');
    expect(item.scopeId).toBe('T100');
  });

  it('stores one row per jot (independent items, not a blob aggregate)', async () => {
    const sessionId = 'ses_20260530000013_dddddd';
    await writeFocusState(env.accessor, sessionId, { currentTask: 'T001' });

    await asAgent({ sessionId, agentId: 'agent-x' }, async () => {
      await addAttention(env.tempDir, { content: 'first' });
      await addAttention(env.tempDir, { content: 'second' });
      const listed = await listAttention(env.tempDir, {});
      expect(listed.items.map((i) => i.content).sort()).toEqual(['first', 'second']);
      expect(listed.items.every((i) => i.id.startsWith('att_'))).toBe(true);
      // Distinct ids — not one aggregate row.
      expect(new Set(listed.items.map((i) => i.id)).size).toBe(2);
    });
  });

  it('add -> list(open only) -> expire transition (TTL sweep)', async () => {
    const sessionId = 'ses_20260530000014_eeeeee';
    await writeFocusState(env.accessor, sessionId, { currentTask: 'T001' });

    await asAgent({ sessionId, agentId: 'agent-x' }, async () => {
      // One item with a 1-second TTL, one without.
      await addAttention(env.tempDir, { content: 'ephemeral', ttlSeconds: 1 });
      await addAttention(env.tempDir, { content: 'durable' });

      // Both live now.
      const live = await listAttention(env.tempDir, {});
      expect(live.items.map((i) => i.content).sort()).toEqual(['durable', 'ephemeral']);

      // Advance the clock past the TTL — the ephemeral item drops from the
      // open-items query (excluded by the TTL predicate, BEFORE any sweep).
      const future = Date.now() + 5_000;
      const afterTtl = await listAttention(env.tempDir, { now: future });
      expect(afterTtl.items.map((i) => i.content)).toEqual(['durable']);

      // Sweep flips it to discarded.
      const discarded = await expireAttention(env.tempDir, { now: future });
      expect(discarded).toBe(1);

      // includeAll surfaces the discarded row with its new status.
      const all = await listAttention(env.tempDir, { includeAll: true, now: future });
      const eph = all.items.find((i) => i.content === 'ephemeral');
      expect(eph?.status).toBe('discarded');
    });
  });

  it('multi-tag json_each filter returns EXACTLY the contains-ALL matches', async () => {
    const sessionId = 'ses_20260530000015_ffffff';
    await writeFocusState(env.accessor, sessionId, { currentTask: 'T001' });

    await asAgent({ sessionId, agentId: 'agent-x' }, async () => {
      await addAttention(env.tempDir, { content: 'both', tags: ['bug', 'wal'] });
      await addAttention(env.tempDir, { content: 'bug-only', tags: ['bug'] });
      await addAttention(env.tempDir, { content: 'wal-only', tags: ['wal'] });
      await addAttention(env.tempDir, { content: 'none', tags: [] });

      // Single tag — every item carrying 'bug'.
      const bug = await listAttention(env.tempDir, { tags: ['bug'] });
      expect(bug.items.map((i) => i.content).sort()).toEqual(['both', 'bug-only']);

      // Two tags — contains ALL: only the item with BOTH.
      const both = await listAttention(env.tempDir, { tags: ['bug', 'wal'] });
      expect(both.items.map((i) => i.content)).toEqual(['both']);

      // A tag nobody has — empty, no crash.
      const none = await listAttention(env.tempDir, { tags: ['nonexistent'] });
      expect(none.items).toEqual([]);
    });
  });

  it('honors the SQL LIMIT even with a tag filter active', async () => {
    const sessionId = 'ses_20260530000016_aabbcc';
    await writeFocusState(env.accessor, sessionId, { currentTask: 'T001' });

    await asAgent({ sessionId, agentId: 'agent-x' }, async () => {
      for (let i = 0; i < 5; i++) {
        await addAttention(env.tempDir, { content: `tagged-${i}`, tags: ['x'] });
      }
      const limited = await listAttention(env.tempDir, { tags: ['x'], limit: 2 });
      expect(limited.items.length).toBe(2);
    });
  });
});
