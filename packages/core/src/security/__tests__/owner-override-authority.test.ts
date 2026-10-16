/**
 * Who may use `CLEO_OWNER_OVERRIDE=1` (T13790, owner decision 2026-10-16):
 * only an owner-marked session (`cleo session start … --owner-auth`) on the
 * owner's own terminal. An agent with no `CLEO_AGENT_ROLE` is fenced like a
 * worker, restricted roles stay refused, and an agent spawned from the owner's
 * session (same session, no terminal) is not the owner.
 *
 * @task T13790
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { createSession, setSessionOwnerAuthToken } from '../../store/session-store.js';
import { resetDbState } from '../../store/sqlite.js';
import { deriveOwnerAuthToken } from '../owner-override-auth.js';
import { resolveOwnerOverride } from '../owner-override-authority.js';

let env: TestDbEnv;
const tty = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };

function setTty(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: on, configurable: true });
}

async function session(id: string, owner: boolean): Promise<string> {
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
  if (owner) await setSessionOwnerAuthToken(id, deriveOwnerAuthToken(id, 'pw'), env.tempDir);
  return id;
}

function lastAudit(): Record<string, unknown> | undefined {
  const path = join(env.tempDir, '.cleo', 'audit', 'force-bypass.jsonl');
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, 'utf-8').trim().split('\n');
  return JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
}

const judge = (sessionId: string | null) =>
  resolveOwnerOverride(env.tempDir, { surface: 'test', taskId: 'T1', sessionId });

beforeEach(async () => {
  env = await createTestDb();
  process.env['CLEO_DIR'] = env.cleoDir;
  process.env['CLEO_OWNER_OVERRIDE'] = '1';
  process.env['CLEO_OWNER_OVERRIDE_REASON'] = 'T13790 test';
  delete process.env['CLEO_AGENT_ROLE'];
  setTty(true);
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  delete process.env['CLEO_OWNER_OVERRIDE'];
  delete process.env['CLEO_OWNER_OVERRIDE_REASON'];
  delete process.env['CLEO_AGENT_ROLE'];
  Object.defineProperty(process.stdin, 'isTTY', { value: tty.stdin, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: tty.stderr, configurable: true });
  resetDbState();
  await env.cleanup();
});

describe('resolveOwnerOverride (T13790)', () => {
  it('not requested without CLEO_OWNER_OVERRIDE', async () => {
    delete process.env['CLEO_OWNER_OVERRIDE'];
    expect(await judge(null)).toEqual({ requested: false });
  });

  it('green: an owner-marked session on its own terminal may override', async () => {
    const id = await session('ses_owner', true);
    expect(await judge(id)).toEqual({
      requested: true,
      allowed: true,
      reason: 'T13790 test',
      sessionId: id,
    });
  });

  it('red: an unlabelled agent (no CLEO_AGENT_ROLE, session not owner-marked) is refused and audited', async () => {
    const id = await session('ses_agent', false);
    expect(await judge(id)).toMatchObject({
      requested: true,
      allowed: false,
      code: 'E_OVERRIDE_NOT_OWNER',
      message: expect.stringMatching(/not owner-marked.*--owner-auth/),
    });
    expect(lastAudit()).toMatchObject({ action: 'override-refused', session_id: id });
    // With no session at all, likewise.
    expect(await judge(null)).toMatchObject({ allowed: false, code: 'E_OVERRIDE_NOT_OWNER' });
  });

  it.each([
    'worker',
    'lead',
    'subagent',
  ])('red: CLEO_AGENT_ROLE=%s is refused even inside an owner-marked session', async (role) => {
    const id = await session(`ses_${role}`, true);
    process.env['CLEO_AGENT_ROLE'] = role;
    expect(await judge(id)).toMatchObject({
      allowed: false,
      code: 'E_OVERRIDE_FORBIDDEN_AGENT_ROLE',
    });
    expect(lastAudit()).toMatchObject({ action: 'override-refused' });
  });

  it("red: an agent spawned from the owner's session (same session, no terminal) is not the owner", async () => {
    const id = await session('ses_owner_tab', true);
    setTty(false);
    expect(await judge(id)).toMatchObject({
      allowed: false,
      code: 'E_OVERRIDE_NOT_OWNER',
      message: expect.stringMatching(/no terminal.*not the owner/),
    });
    expect(lastAudit()).toMatchObject({ action: 'override-refused', tty_present: false });
  });
});

describe('cleo verify refuses a non-owner override instead of honouring it (engine wiring)', () => {
  it('an unlabelled agent gets E_OVERRIDE_NOT_OWNER; the owner records the override', async () => {
    const { addTask } = await import('../../tasks/add.js');
    const { validateGateVerify } = await import('../../validation/engine-ops.js');
    const { task } = await addTask(
      {
        title: 'owner override authority fixture',
        description: 'fixture for the owner override authority wiring test',
        acceptance: ['Record cleanupDone'],
        skipContainmentInvariant: true,
      },
      env.tempDir,
      env.accessor,
    );
    const verify = (sessionId: string) =>
      validateGateVerify(env.tempDir, {
        taskId: task.id,
        gate: 'cleanupDone',
        evidence: 'note:owner-approved cleanup',
        sessionId,
      });
    const agent = await verify(await session('ses_unlabelled', false));
    expect(!agent.success && agent.error.code).toBe('E_OVERRIDE_NOT_OWNER');
    const owner = await verify(await session('ses_owner_verify', true));
    expect(owner.success, JSON.stringify(owner)).toBe(true);
    expect(owner.success && owner.data.override).toBe(true);
  });
});
