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
import {
  createSession,
  getSessionOwnerAuth,
  setSessionOwnerAuthToken,
} from '../../store/session-store.js';
import { resetDbState } from '../../store/sqlite.js';
import {
  createOwnerAuthVerifier,
  deriveOwnerAuthToken,
  OWNER_SESSION_MARK,
} from '../owner-override-auth.js';
import { ownerMarkRefusal, resolveOwnerOverride } from '../owner-override-authority.js';

let env: TestDbEnv;
const tty = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };

function setTty(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: on, configurable: true });
}

async function session(id: string, owner: boolean | 'owner-auth-only'): Promise<string> {
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
  if (owner === 'owner-auth-only')
    await setSessionOwnerAuthToken(id, createOwnerAuthVerifier('pw'), env.tempDir);
  else if (owner) await setSessionOwnerAuthToken(id, OWNER_SESSION_MARK, env.tempDir);
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
      message: expect.stringMatching(/not owner-marked.*--owner\)/),
    });
    expect(lastAudit()).toMatchObject({ action: 'override-refused', session_id: id });
    // With no session at all, likewise.
    expect(await judge(null)).toMatchObject({ allowed: false, code: 'E_OVERRIDE_NOT_OWNER' });
  });

  it('red: a session started with --owner-auth only (the cap password) is not owner-marked', async () => {
    const id = await session('ses_cap_only', 'owner-auth-only');
    expect(await judge(id)).toMatchObject({ allowed: false, code: 'E_OVERRIDE_NOT_OWNER' });
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

describe('cleo session start --owner: password-free, interactive only (T13790)', () => {
  it('is allowed on a terminal with no CLEO_AGENT_ROLE', () => {
    expect(ownerMarkRefusal({})).toBeNull();
  });

  it('is refused without a terminal (an agent shell)', () => {
    setTty(false);
    expect(ownerMarkRefusal({})).toMatch(/interactive terminal/);
  });

  it.each([
    'worker',
    'lead',
    'subagent',
    'reviewer',
  ])('is refused when CLEO_AGENT_ROLE=%s is set, even on a terminal', (role) => {
    expect(ownerMarkRefusal({ CLEO_AGENT_ROLE: role })).toMatch(/CLEO_AGENT_ROLE is set/);
  });
});

describe('the core write path guards owner credentials (review-2253 round 2)', () => {
  it('refuses the owner mark without a terminal, so an in-process caller cannot plant it', async () => {
    const id = await session('ses_inproc', false);
    setTty(false);
    await expect(setSessionOwnerAuthToken(id, OWNER_SESSION_MARK, env.tempDir)).rejects.toThrow(
      /interactive terminal/,
    );
    expect((await getSessionOwnerAuth(id, env.tempDir))?.token).toBeNull();
  });

  it('refuses the owner mark when CLEO_AGENT_ROLE is set', async () => {
    const id = await session('ses_role', false);
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    await expect(setSessionOwnerAuthToken(id, OWNER_SESSION_MARK, env.tempDir)).rejects.toThrow(
      /CLEO_AGENT_ROLE is set/,
    );
  });

  it('clears legacy HMAC owner tokens proactively, at the next session start on this build', async () => {
    const old = await session('ses_old_start', false);
    await setSessionOwnerAuthToken(old, deriveOwnerAuthToken(old, 'pw'), env.tempDir);
    const { countLegacyOwnerTokens } = await import('../../store/session-store.js');
    expect(await countLegacyOwnerTokens(env.tempDir)).toBe(1);
    await session('ses_next_start', false);
    expect(await countLegacyOwnerTokens(env.tempDir)).toBe(0);
    expect((await getSessionOwnerAuth(old, env.tempDir))?.token).toBeNull();
  });

  it('clears legacy HMAC owner tokens at the next owner credential write', async () => {
    const old = await session('ses_old', false);
    await setSessionOwnerAuthToken(old, deriveOwnerAuthToken(old, 'pw'), env.tempDir);
    const fresh = await session('ses_fresh', false);
    await setSessionOwnerAuthToken(fresh, createOwnerAuthVerifier('pw'), env.tempDir);
    expect((await getSessionOwnerAuth(old, env.tempDir))?.token).toBeNull();
    expect((await getSessionOwnerAuth(fresh, env.tempDir))?.token).toMatch(/^scrypt\$v1\$/);
  });
});
