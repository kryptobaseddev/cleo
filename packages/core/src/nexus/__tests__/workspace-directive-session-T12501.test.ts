/**
 * Conduit directive routing runs focus writes in the directive agent's own
 * session (T12501 · epic T12497).
 *
 * `tasks.start` / `tasks.stop` directives run in a process that is bound to no
 * session of the target project. Since T12501 an unbound focus write is refused
 * (the shared legacy focus key is never written), so a directive acts in the
 * single active session its agent holds in that project, and otherwise refuses
 * with directive-specific text.
 *
 * @task T12501
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const projects: Array<{ name: string; path: string }> = [];
vi.mock('../registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registry.js')>();
  return { ...actual, nexusList: vi.fn(async () => projects) };
});

import { focusStateKey, LEGACY_FOCUS_STATE_KEY } from '../../sessions/focus-state-store.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { type ParsedDirective, routeDirective } from '../workspace.js';

let env: TestDbEnv;
let n = 0;

/** A directive from `agentId`; a fresh message id keeps the rate limiter per test. */
function directive(verb: string, agentId: string): ParsedDirective {
  n += 1;
  return {
    verb,
    taskRefs: ['T001'],
    agentId,
    messageId: `msg-${n}`,
    timestamp: new Date().toISOString(),
  };
}

beforeEach(async () => {
  env = await createTestDb();
  const configPath = join(env.cleoDir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, authorizedAgents: ['*'] }));
  projects.length = 0;
  projects.push({ name: 'proj-directive', path: env.tempDir });
  await seedTasks(env.accessor, [
    { id: 'T001', title: 'Routed', status: 'pending', priority: 'medium' },
  ]);
  vi.stubEnv('CLEO_SESSION_ID', undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await env.cleanup();
});

async function addSession(id: string, agentHandle: string): Promise<void> {
  const now = new Date().toISOString();
  await env.accessor.upsertSingleSession({
    id,
    name: id,
    status: 'active',
    scope: { type: 'global' },
    taskWork: { taskId: null, setAt: null },
    startedAt: now,
    lastActivity: now,
    agentHandle,
  });
}

describe('directive tasks.start / tasks.stop (T12501)', () => {
  it("runs in the directive agent's own session and never writes the legacy key", async () => {
    await addSession('ses_20260930000000_a1a1a1', 'agent-dir-a');
    await addSession('ses_20260930000000_b2b2b2', 'agent-dir-b');

    const [started] = await routeDirective(directive('start', 'agent-dir-a'));
    expect(started?.error).toBeUndefined();
    expect(started?.success).toBe(true);
    expect(
      await env.accessor.getMetaValue(focusStateKey('ses_20260930000000_a1a1a1')),
    ).toMatchObject({ currentTask: 'T001' });
    expect(await env.accessor.getMetaValue(focusStateKey('ses_20260930000000_b2b2b2'))).toBeNull();
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.sessionId).toBe(
      'ses_20260930000000_a1a1a1',
    );

    const [stopped] = await routeDirective(directive('stop', 'agent-dir-a'));
    expect(stopped?.success).toBe(true);
    expect(
      await env.accessor.getMetaValue(focusStateKey('ses_20260930000000_a1a1a1')),
    ).toMatchObject({ currentTask: null });
    expect(await env.accessor.getMetaValue(LEGACY_FOCUS_STATE_KEY)).toBeNull();
  });

  it('refuses with directive-specific text when the agent has no session there', async () => {
    await addSession('ses_20260930000000_b2b2b2', 'someone-else');
    const [res] = await routeDirective(directive('start', 'agent-dir-none'));
    expect(res?.success).toBe(false);
    expect(res?.error).toContain('directive tasks.start needs a session in proj-directive');
    expect(res?.error).toContain("agent 'agent-dir-none' has no active session there");
    expect(await env.accessor.getMetaValue(LEGACY_FOCUS_STATE_KEY)).toBeNull();
    expect((await env.accessor.loadSingleTask('T001'))?.claim).toBeUndefined();
  });

  it('refuses when the agent has more than one active session (ambiguous)', async () => {
    await addSession('ses_20260930000000_c3c3c3', 'agent-dir-dup');
    await addSession('ses_20260930000000_d4d4d4', 'agent-dir-dup');
    const [res] = await routeDirective(directive('stop', 'agent-dir-dup'));
    expect(res?.success).toBe(false);
    expect(res?.error).toContain('directive tasks.stop needs a session in proj-directive');
    expect(res?.error).toContain('2 active sessions');
  });
});
