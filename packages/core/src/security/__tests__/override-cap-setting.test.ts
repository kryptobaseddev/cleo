/**
 * The owner override cap setting (T13787, owner decision 2026-10-16): a
 * per-project `evidence.overrideCapPerSession`, default 10, that only the
 * owner may change, after an explicit enrollment anchored in the git-tracked
 * project file and the global store. Every probe from review-2253 of #2296 is
 * a test here: rm-then-set, garbage, a forged file, a global mismatch, and an
 * agent-written waiver.
 *
 * @task T13787
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConfigValue } from '../../config.js';
import { AgentIdentity, signAuditLine } from '../../identity/cleo-identity.js';
import { checkAndIncrementOverrideCap, OVERRIDE_CAP_SETTING } from '../override-cap.js';
import {
  enrollOwner,
  ownerEnrollmentStatus,
  resolveOverrideCap,
  setOwnerOverrideCap,
} from '../override-cap-setting.js';
import { createOwnerAuthVerifier, deriveOwnerAuthToken } from '../owner-override-auth.js';

let root: string;
let home: string;
const saved = {
  stdin: process.stdin.isTTY,
  stderr: process.stderr.isTTY,
  cleoHome: process.env['CLEO_HOME'],
};
let sessions = 0;

function setTty(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: on, configurable: true });
}

/**
 * The owner caller: a session started with `--owner-auth` and `password` (a
 * fresh id each time — T1118 L4d rate-limits per session within a process).
 */
function owner(password = 'pw') {
  const id = `ses_owner_${++sessions}`;
  return { password, session: { id, name: id, token: createOwnerAuthVerifier(password) } };
}

const settingsFile = (): string => join(root, '.cleo', 'owner-settings.json');

function audit(): Array<Record<string, unknown>> {
  const path = join(root, '.cleo', 'audit', 'force-bypass.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A forged project file: a self-made key and a valid seal over `value`. */
async function forge(value: number): Promise<void> {
  const key = await AgentIdentity.fromSeed(new Uint8Array(32).fill(7));
  const salt = '00'.repeat(16);
  const setAt = new Date().toISOString();
  const payload = JSON.stringify({
    key: OVERRIDE_CAP_SETTING,
    value,
    setAt,
    salt,
    ownerPubkey: key.pubkeyHex,
  });
  const { sig } = await signAuditLine(key, payload);
  writeFileSync(
    settingsFile(),
    JSON.stringify({
      schemaVersion: 1,
      ownerPubkey: key.pubkeyHex,
      salt,
      settings: { [OVERRIDE_CAP_SETTING]: { value, setAt, sig } },
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'override-cap-setting-'));
  home = mkdtempSync(join(tmpdir(), 'override-cap-home-'));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  process.env['CLEO_HOME'] = home;
  delete process.env['CLEO_AGENT_ROLE'];
  setTty(true);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env['CLEO_AGENT_ROLE'];
  delete process.env['CLEO_OWNER_OVERRIDE_WAIVER'];
  if (saved.cleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = saved.cleoHome;
  Object.defineProperty(process.stdin, 'isTTY', { value: saved.stdin, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: saved.stderr, configurable: true });
});

describe('enrollment is explicit and anchored twice', () => {
  it('defaults to 10 with nothing enrolled', async () => {
    expect(await resolveOverrideCap(root)).toEqual({ cap: 10, source: 'default' });
    expect((await ownerEnrollmentStatus(root)).status).toBe('none');
  });

  it('a set never enrolls: before enrollment it is refused and audited', async () => {
    const r = await setOwnerOverrideCap(root, { ...owner(), value: 25 });
    expect(r).toMatchObject({ ok: false, code: 'E_OWNER_NOT_ENROLLED' });
    expect(existsSync(settingsFile())).toBe(false);
    expect(audit().at(-1)).toMatchObject({ action: 'override-cap-set-refused' });
  });

  it('green: explicit enroll, then the owner sets 25; sealed, anchored, audited with old and new', async () => {
    const e = await enrollOwner(root, owner());
    expect(e).toMatchObject({ ok: true, reset: false });
    expect(readFileSync(join(home, 'owner-enrollments.json'), 'utf-8')).toContain(
      e.ok ? e.fingerprint : 'x',
    );
    const r = await setOwnerOverrideCap(root, { ...owner(), value: 25 });
    expect(r).toEqual({ ok: true, value: 25, previous: 10, clamped: false });
    expect(await resolveOverrideCap(root)).toEqual({ cap: 25, source: 'owner-setting' });
    expect(audit().at(-1)).toMatchObject({
      action: 'override-cap-set',
      setting: OVERRIDE_CAP_SETTING,
      old_value: 10,
      new_value: 25,
    });
    const status = await ownerEnrollmentStatus(root);
    expect(status).toMatchObject({ status: 'enrolled', cap: 25 });
    expect(status.message).toMatch(/Owner key [0-9a-f]{16} enrolled .* by session ses_owner_/);
  });

  it('clamps a value above 100', async () => {
    await enrollOwner(root, owner());
    const r = await setOwnerOverrideCap(root, { ...owner(), value: 500 });
    expect(r).toMatchObject({ ok: true, value: 100, clamped: true });
  });

  it('re-enrolling needs --reset, which is audited and drops earlier seals', async () => {
    await enrollOwner(root, owner());
    await setOwnerOverrideCap(root, { ...owner(), value: 30 });
    const again = await enrollOwner(root, owner('other'));
    expect(again).toMatchObject({ ok: false, code: 'E_OWNER_ALREADY_ENROLLED' });
    const reset = await enrollOwner(root, owner('other'), { reset: true });
    expect(reset).toMatchObject({ ok: true, reset: true });
    expect(audit().at(-1)).toMatchObject({ action: 'owner-enroll-reset' });
    expect(await resolveOverrideCap(root)).toMatchObject({ cap: 10 });
  });

  it('a session started before T13787 (legacy HMAC token) still verifies', async () => {
    const id = `ses_legacy_${++sessions}`;
    const legacy = {
      password: 'pw',
      session: { id, name: id, token: deriveOwnerAuthToken(id, 'pw') },
    };
    expect(await enrollOwner(root, legacy)).toMatchObject({ ok: true });
  });
});

describe('review-2253 probes: tampering is refused, loud and audited', () => {
  it('HIGH 1: rm owner-settings.json, then set: refused; the cap falls back to 10 with a warning', async () => {
    await enrollOwner(root, owner());
    await setOwnerOverrideCap(root, { ...owner(), value: 40 });
    rmSync(settingsFile());
    const cap = await resolveOverrideCap(root);
    expect(cap).toMatchObject({ cap: 10, source: 'default' });
    expect(cap.warning).toMatch(/missing, but the global store records owner key/);
    expect(audit().at(-1)).toMatchObject({ action: 'owner-settings-invalid' });
    const set = await setOwnerOverrideCap(root, { ...owner('agent'), value: 100 });
    expect(set).toMatchObject({ ok: false, code: 'E_OWNER_SETTINGS_TAMPERED' });
    // ... and it cannot re-enroll implicitly either.
    expect(await enrollOwner(root, owner('agent'))).toMatchObject({
      ok: false,
      code: 'E_OWNER_ALREADY_ENROLLED',
    });
    expect((await ownerEnrollmentStatus(root)).status).toBe('tampered');
  });

  it('HIGH 1: a garbage owner-settings.json is refused, never re-enrolled', async () => {
    await enrollOwner(root, owner());
    writeFileSync(settingsFile(), '{not json');
    expect((await resolveOverrideCap(root)).warning).toMatch(/unreadable/);
    expect(await setOwnerOverrideCap(root, { ...owner(), value: 100 })).toMatchObject({
      ok: false,
      code: 'E_OWNER_SETTINGS_TAMPERED',
    });
  });

  it('MEDIUM 3: a hand-forged file (self-made key + valid seal) with no global record is refused and audited', async () => {
    await forge(100);
    const cap = await resolveOverrideCap(root);
    expect(cap).toMatchObject({ cap: 10, source: 'default' });
    expect(cap.warning).toMatch(/global store never enrolled/);
    expect(audit().at(-1)).toMatchObject({ action: 'owner-settings-invalid' });
  });

  it('2b: a project file whose key does not match the global record is refused and audited', async () => {
    await enrollOwner(root, owner());
    await forge(100);
    const cap = await resolveOverrideCap(root);
    expect(cap).toMatchObject({ cap: 10 });
    expect(cap.warning).toMatch(/but the global store enrolled [0-9a-f]{16}/);
    expect(audit().at(-1)).toMatchObject({ action: 'owner-settings-invalid' });
    expect(await setOwnerOverrideCap(root, { ...owner(), value: 50 })).toMatchObject({
      ok: false,
      code: 'E_OWNER_SETTINGS_TAMPERED',
    });
  });

  it('a hand-edited value fails its seal and falls back to 10', async () => {
    await enrollOwner(root, owner());
    await setOwnerOverrideCap(root, { ...owner(), value: 20 });
    const file = JSON.parse(readFileSync(settingsFile(), 'utf-8'));
    file.settings[OVERRIDE_CAP_SETTING].value = 99;
    writeFileSync(settingsFile(), JSON.stringify(file));
    expect((await resolveOverrideCap(root)).warning).toMatch(
      /not sealed by the enrolled owner key/,
    );
  });

  it('an agent-written CLEO_OWNER_OVERRIDE_WAIVER no longer lifts the cap, and is audited', () => {
    const waiver = join(root, 'waiver.md');
    writeFileSync(waiver, '---\ncap-waiver: true\n---\n');
    process.env['CLEO_OWNER_OVERRIDE_WAIVER'] = waiver;
    expect(checkAndIncrementOverrideCap(root, 'ses_w', 1).allowed).toBe(true);
    const over = checkAndIncrementOverrideCap(root, 'ses_w', 1);
    expect(over).toMatchObject({ allowed: false, errorCode: 'E_OVERRIDE_CAP_EXCEEDED' });
    expect(over.errorMessage).toMatch(/CLEO_OWNER_OVERRIDE_WAIVER no longer lifts the cap/);
    expect(audit().at(-1)).toMatchObject({ action: 'override-waiver-ignored' });
  });
});

describe('an agent cannot enroll or set through the supported path: refused and audited', () => {
  const refusedBoth = async (caller: ReturnType<typeof owner>, code: string): Promise<void> => {
    const e = await enrollOwner(root, caller);
    expect(e).toMatchObject({ ok: false, code });
    expect(audit().at(-1)).toMatchObject({ action: 'owner-enroll-refused' });
    expect(existsSync(settingsFile())).toBe(false);
  };

  it('without a TTY (an agent shell)', async () => {
    setTty(false);
    await refusedBoth(owner(), 'E_OVERRIDE_NEEDS_TTY');
  });

  it("with a password that does not match the session's owner-auth verifier", async () => {
    await refusedBoth({ ...owner('pw'), password: 'guess' }, 'E_OVERRIDE_TOKEN_INVALID');
  });

  it('from a session started without --owner-auth', async () => {
    await refusedBoth(
      { password: 'pw', session: { id: 's', name: 's', token: null } },
      'E_OVERRIDE_TOKEN_INVALID',
    );
  });

  it('from a restricted agent role', async () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    await refusedBoth(owner(), 'E_OVERRIDE_FORBIDDEN_AGENT_ROLE');
  });

  it('with a different password than the enrolled owner key', async () => {
    await enrollOwner(root, owner('pw'));
    const r = await setOwnerOverrideCap(root, { ...owner('other'), value: 99 });
    expect(r).toMatchObject({ ok: false, code: 'E_OVERRIDE_TOKEN_INVALID' });
    expect(!r.ok && r.message).toMatch(/does not match the owner key enrolled/);
  });

  it('through a plain config write (cleo config set / setConfigValue)', async () => {
    await expect(setConfigValue(OVERRIDE_CAP_SETTING, 50, root)).rejects.toThrow(
      /owner-only and is never written to config\.json/,
    );
    expect(existsSync(join(root, '.cleo', 'config.json'))).toBe(false);
    expect(audit().at(-1)).toMatchObject({ action: 'override-cap-set-refused', new_value: 50 });
  });
});

describe('E_OVERRIDE_CAP_EXCEEDED names the setting and the owner command', () => {
  it('the refusal names evidence.overrideCapPerSession and cleo config set', () => {
    expect(checkAndIncrementOverrideCap(root, 'ses_x', 1).allowed).toBe(true);
    const over = checkAndIncrementOverrideCap(root, 'ses_x', 1);
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
    const { actAsOwner } = await import('./owner-session.js');
    const env = await createTestDb();
    process.env['CLEO_DIR'] = env.cleoDir;
    let restoreOwner: () => void = () => {};
    try {
      expect((await enrollOwner(env.tempDir, owner())).ok).toBe(true);
      expect((await setOwnerOverrideCap(env.tempDir, { ...owner(), value: 2 })).ok).toBe(true);
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
      // T13790: the override itself needs the owner (owner-marked session).
      restoreOwner = await actAsOwner(env.tempDir);
      const verify = () =>
        validateGateVerify(env.tempDir, {
          taskId: task.id,
          gate: 'cleanupDone',
          evidence: 'note:owner-approved cleanup',
        });
      expect((await verify()).success).toBe(true);
      expect((await verify()).success).toBe(true);
      const third = await verify();
      expect(!third.success && third.error.code).toBe('E_OVERRIDE_CAP_EXCEEDED');
      expect(!third.success && third.error.message).toMatch(
        /2 of 2 overrides used \(evidence\.overrideCapPerSession = 2\)/,
      );
    } finally {
      restoreOwner();
      delete process.env['CLEO_OWNER_OVERRIDE'];
      delete process.env['CLEO_OWNER_OVERRIDE_REASON'];
      delete process.env['CLEO_DIR'];
      resetDbState();
      await env.cleanup();
    }
  });
});
