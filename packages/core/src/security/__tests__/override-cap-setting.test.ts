/**
 * The owner override cap setting (T13787, owner decision 2026-10-16): a
 * per-project `evidence.overrideCapPerSession`, default 10, that only the
 * owner path (T1118 L4: role fence, TTY, owner-auth password) may change.
 *
 * @task T13787
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConfigValue } from '../../config.js';
import { checkAndIncrementOverrideCap, OVERRIDE_CAP_SETTING } from '../override-cap.js';
import { resolveOverrideCap, setOwnerOverrideCap } from '../override-cap-setting.js';
import { deriveOwnerAuthToken } from '../owner-override-auth.js';

let root: string;
const tty = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };

/** Simulate (or remove) an interactive terminal for the L4c check. */
function setTty(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: on, configurable: true });
}

let sessions = 0;

/**
 * A session started with `--owner-auth` and `password`; a fresh id each time,
 * since T1118 L4d rate-limits overrides per session within one process.
 */
function ownerSession(password: string, id = `ses_owner_${++sessions}`) {
  return { id, name: 'owner', token: deriveOwnerAuthToken('owner', password) };
}

function auditLines(): Array<Record<string, unknown>> {
  const path = join(root, '.cleo', 'audit', 'force-bypass.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'override-cap-setting-'));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  delete process.env['CLEO_AGENT_ROLE'];
  setTty(true);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['CLEO_AGENT_ROLE'];
  delete process.env['CLEO_OWNER_OVERRIDE_WAIVER'];
  Object.defineProperty(process.stdin, 'isTTY', { value: tty.stdin, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: tty.stderr, configurable: true });
});

describe('resolveOverrideCap', () => {
  it('defaults to 10 when the owner has set nothing', async () => {
    expect(await resolveOverrideCap(root)).toEqual({ cap: 10, source: 'default' });
  });
});

describe('the owner sets the cap (L4: role fence, TTY, owner-auth password)', () => {
  it('green: the owner raises it; it is sealed, survives the session, and is audited with old and new', async () => {
    const r = await setOwnerOverrideCap(root, {
      value: 25,
      password: 'pw',
      session: ownerSession('pw'),
    });
    expect(r).toEqual({ ok: true, value: 25, previous: 10, clamped: false });
    // A later process (no session at all) still reads the sealed value.
    expect(await resolveOverrideCap(root)).toEqual({ cap: 25, source: 'owner-setting' });
    expect(auditLines().at(-1)).toMatchObject({
      action: 'override-cap-set',
      setting: OVERRIDE_CAP_SETTING,
      old_value: 10,
      new_value: 25,
      token_validated: true,
    });
  });

  it('clamps a value above 100', async () => {
    const r = await setOwnerOverrideCap(root, {
      value: 500,
      password: 'pw',
      session: ownerSession('pw'),
    });
    expect(r).toMatchObject({ ok: true, value: 100, clamped: true });
  });

  it('a later set in a new owner-auth session with the same password keeps the enrolled key', async () => {
    await setOwnerOverrideCap(root, { value: 20, password: 'pw', session: ownerSession('pw') });
    const r = await setOwnerOverrideCap(root, {
      value: 30,
      password: 'pw',
      session: ownerSession('pw', 'ses_next'),
    });
    expect(r).toMatchObject({ ok: true, value: 30, previous: 20 });
  });
});

describe('an agent cannot raise it: refused and audited', () => {
  const refused = async (
    input: Parameters<typeof setOwnerOverrideCap>[1],
    code: string,
  ): Promise<void> => {
    const r = await setOwnerOverrideCap(root, input);
    expect(r).toMatchObject({ ok: false, code });
    expect(!r.ok && r.message).toMatch(/Only the owner can change evidence\.overrideCapPerSession/);
    expect(await resolveOverrideCap(root)).toMatchObject({ cap: 10 });
    expect(auditLines().at(-1)).toMatchObject({
      action: 'override-cap-set-refused',
      setting: OVERRIDE_CAP_SETTING,
      old_value: 10,
    });
  };

  it('without a TTY (an agent shell)', async () => {
    setTty(false);
    await refused(
      { value: 50, password: 'pw', session: ownerSession('pw') },
      'E_OVERRIDE_NEEDS_TTY',
    );
  });

  it('with the wrong password', async () => {
    await refused(
      { value: 50, password: 'guess', session: ownerSession('pw') },
      'E_OVERRIDE_TOKEN_INVALID',
    );
  });

  it('from a session started without --owner-auth', async () => {
    await refused(
      { value: 50, password: 'pw', session: { id: 's', name: 'owner', token: null } },
      'E_OVERRIDE_TOKEN_INVALID',
    );
  });

  it('from a restricted agent role (CLEO_AGENT_ROLE changed after bootstrap)', async () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    await refused(
      { value: 50, password: 'pw', session: ownerSession('pw') },
      'E_OVERRIDE_FORBIDDEN_AGENT_ROLE',
    );
  });

  it('with a different password than the enrolled owner key', async () => {
    await setOwnerOverrideCap(root, { value: 10, password: 'pw', session: ownerSession('pw') });
    const r = await setOwnerOverrideCap(root, {
      value: 99,
      password: 'other',
      session: ownerSession('other', 'ses_agent'),
    });
    expect(r).toMatchObject({ ok: false, code: 'E_OVERRIDE_TOKEN_INVALID' });
    expect(!r.ok && r.message).toMatch(/does not match the owner key enrolled/);
  });

  it('through a plain config write (cleo config set / setConfigValue)', async () => {
    await expect(setConfigValue(OVERRIDE_CAP_SETTING, 50, root)).rejects.toThrow(
      /owner-only and is never written to config\.json/,
    );
    expect(existsSync(join(root, '.cleo', 'config.json'))).toBe(false);
    expect(auditLines().at(-1)).toMatchObject({
      action: 'override-cap-set-refused',
      new_value: 50,
    });
  });

  it('by editing the sealed file by hand: the value falls back to 10, warned and audited', async () => {
    await setOwnerOverrideCap(root, { value: 20, password: 'pw', session: ownerSession('pw') });
    const path = join(root, '.cleo', 'owner-settings.json');
    const file = JSON.parse(readFileSync(path, 'utf-8'));
    file.settings[OVERRIDE_CAP_SETTING].value = 99;
    writeFileSync(path, JSON.stringify(file));
    const r = await resolveOverrideCap(root);
    expect(r).toMatchObject({ cap: 10, source: 'default' });
    expect(r.warning).toMatch(/not sealed by the enrolled owner key/);
    expect(auditLines().at(-1)).toMatchObject({ action: 'override-cap-seal-invalid' });
  });
});

describe('E_OVERRIDE_CAP_EXCEEDED names the setting and the owner command', () => {
  it('the refusal names evidence.overrideCapPerSession and cleo config set', () => {
    expect(checkAndIncrementOverrideCap(root, 'ses_x', 1).allowed).toBe(true);
    const over = checkAndIncrementOverrideCap(root, 'ses_x', 1);
    expect(over).toMatchObject({ allowed: false, errorCode: 'E_OVERRIDE_CAP_EXCEEDED' });
    expect(over.errorMessage).toMatch(
      /1 of 1 overrides used \(evidence\.overrideCapPerSession = 1\).*cleo config set evidence\.overrideCapPerSession <n>.*--owner-auth/,
    );
  });
});

describe('cleo verify enforces the owner setting (engine wiring)', () => {
  it('an owner cap of 2 refuses the third override, naming the setting', async () => {
    const { createTestDb } = await import('../../store/__tests__/test-db-helper.js');
    const { resetDbState } = await import('../../store/sqlite.js');
    const { addTask } = await import('../../tasks/add.js');
    const { validateGateVerify } = await import('../../validation/engine-ops.js');
    const env = await createTestDb();
    process.env['CLEO_DIR'] = env.cleoDir;
    try {
      const set = await setOwnerOverrideCap(env.tempDir, {
        value: 2,
        password: 'pw',
        session: ownerSession('pw'),
      });
      expect(set.ok).toBe(true);
      const { task } = await addTask(
        {
          title: 'override cap wiring fixture',
          description: 'fixture for the owner override cap wiring test',
          acceptance: ['Record cleanupDone'],
          skipContainmentInvariant: true,
        },
        env.tempDir,
        env.accessor,
      );
      process.env['CLEO_OWNER_OVERRIDE'] = '1';
      process.env['CLEO_OWNER_OVERRIDE_REASON'] = 'T13787 wiring test';
      const verify = () =>
        validateGateVerify(env.tempDir, {
          taskId: task.id,
          gate: 'cleanupDone',
          evidence: 'note:owner-approved cleanup',
          sessionId: 'ses_cap_wiring',
        });
      expect((await verify()).success).toBe(true);
      expect((await verify()).success).toBe(true);
      const third = await verify();
      expect(third.success).toBe(false);
      expect(!third.success && third.error.code).toBe('E_OVERRIDE_CAP_EXCEEDED');
      expect(!third.success && third.error.message).toMatch(
        /2 of 2 overrides used \(evidence\.overrideCapPerSession = 2\)/,
      );
    } finally {
      delete process.env['CLEO_OWNER_OVERRIDE'];
      delete process.env['CLEO_OWNER_OVERRIDE_REASON'];
      delete process.env['CLEO_DIR'];
      resetDbState();
      await env.cleanup();
    }
  });
});
