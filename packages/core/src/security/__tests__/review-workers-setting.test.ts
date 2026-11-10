/**
 * `review.workers.counted` is owner-only (T14403), sealed the way T13787 seals
 * `evidence.overrideCapPerSession`: a plain config write and an agent session
 * are refused and audited, the owner's set is sealed outside config.json and
 * audited with who made it, and config.json stays valid against its schema.
 *
 * @task T14403
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConfigValue } from '../../config.js';
import { checkSchema } from '../../json-schema-validator.js';
import { resolveSchemaPath } from '../../schema-management.js';
import { enrollOwner } from '../override-cap-setting.js';
import { createOwnerAuthVerifier } from '../owner-override-auth.js';
import {
  REVIEW_WORKERS_COUNTED_KEY,
  resolveReviewWorkersCounted,
  setOwnerReviewWorkersCounted,
} from '../review-workers-setting.js';

let root: string;
let home: string;
let sessions = 0;
const saved = {
  stdin: process.stdin.isTTY,
  stderr: process.stderr.isTTY,
  cleoHome: process.env['CLEO_HOME'],
  agent: process.env['CLEO_AGENT_ID'],
};

function setTty(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: on, configurable: true });
}

/** The owner: a fresh `--owner-auth` session per call (L4d rate-limits per session). */
function owner(password = 'pw') {
  const id = `ses_owner_${++sessions}`;
  return { password, session: { id, name: id, token: createOwnerAuthVerifier(password) } };
}

function audit(): Array<Record<string, unknown>> {
  const path = join(root, '.cleo', 'audit', 'force-bypass.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const configFile = (): string => join(root, '.cleo', 'config.json');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-workers-setting-'));
  home = mkdtempSync(join(tmpdir(), 'review-workers-home-'));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  writeFileSync(configFile(), `${JSON.stringify({ version: '2.11.0' })}\n`);
  process.env['CLEO_HOME'] = home;
  delete process.env['CLEO_AGENT_ROLE'];
  setTty(true);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env['CLEO_AGENT_ROLE'];
  if (saved.cleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = saved.cleoHome;
  if (saved.agent === undefined) delete process.env['CLEO_AGENT_ID'];
  else process.env['CLEO_AGENT_ID'] = saved.agent;
  Object.defineProperty(process.stdin, 'isTTY', { value: saved.stdin, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: saved.stderr, configurable: true });
});

describe('review.workers.counted is owner-only (T14403)', () => {
  it('a plain config write is refused, audited, and leaves config.json untouched', async () => {
    const before = readFileSync(configFile(), 'utf-8');
    await expect(setConfigValue(REVIEW_WORKERS_COUNTED_KEY, 'true', root)).rejects.toThrow(
      /owner-only and is never written to config\.json/,
    );
    expect(readFileSync(configFile(), 'utf-8')).toBe(before);
    expect(audit().at(-1)).toMatchObject({
      action: 'review-workers-counted-set-refused',
      setting: REVIEW_WORKERS_COUNTED_KEY,
      old_value: 0,
      new_value: 1,
    });
    expect(await resolveReviewWorkersCounted(root)).toBe(false);
  });

  it('an agent session (no owner-auth verifier) is refused and audited with its session and agent id', async () => {
    await enrollOwner(root, owner());
    process.env['CLEO_AGENT_ID'] = 'agent-worker';
    const r = await setOwnerReviewWorkersCounted(root, {
      password: '',
      session: { id: 'ses_agent', name: 'worker', token: null },
      value: true,
    });
    expect(r).toMatchObject({ ok: false, code: 'E_OVERRIDE_TOKEN_INVALID' });
    expect(audit().at(-1)).toMatchObject({
      action: 'review-workers-counted-set-refused',
      session_id: 'ses_agent',
      agent_id: 'agent-worker',
      token_validated: false,
    });
    expect(await resolveReviewWorkersCounted(root)).toBe(false);
  });

  it('a restricted agent role is refused even with a TTY and the owner password', async () => {
    await enrollOwner(root, owner());
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    const r = await setOwnerReviewWorkersCounted(root, { ...owner(), value: true });
    expect(r.ok).toBe(false);
    expect(await resolveReviewWorkersCounted(root)).toBe(false);
  });

  it('without a TTY (an agent shell) the owner session is refused', async () => {
    await enrollOwner(root, owner());
    setTty(false);
    const r = await setOwnerReviewWorkersCounted(root, { ...owner(), value: true });
    expect(r.ok).toBe(false);
    expect(await resolveReviewWorkersCounted(root)).toBe(false);
  });

  it('the wrong password and an unenrolled project are refused', async () => {
    expect(await setOwnerReviewWorkersCounted(root, { ...owner(), value: true })).toMatchObject({
      ok: false,
      code: 'E_OWNER_NOT_ENROLLED',
    });
    await enrollOwner(root, owner('pw'));
    expect(
      await setOwnerReviewWorkersCounted(root, { ...owner('other'), value: true }),
    ).toMatchObject({ ok: false, code: 'E_OVERRIDE_TOKEN_INVALID' });
    expect(await resolveReviewWorkersCounted(root)).toBe(false);
  });

  it('AC3: the owner sets it: sealed outside config.json, audited with who flipped it, config.json schema-valid', async () => {
    await enrollOwner(root, owner());
    process.env['CLEO_AGENT_ID'] = 'owner-terminal';
    const who = owner();
    expect(await setOwnerReviewWorkersCounted(root, { ...who, value: true })).toEqual({
      ok: true,
      value: true,
      previous: false,
    });
    expect(await resolveReviewWorkersCounted(root)).toBe(true);
    expect(audit().at(-1)).toMatchObject({
      action: 'review-workers-counted-set',
      session_id: who.session.id,
      agent_id: 'owner-terminal',
      token_validated: true,
      old_value: 0,
      new_value: 1,
    });
    const config = JSON.parse(readFileSync(configFile(), 'utf-8')) as Record<string, unknown>;
    expect(config).toEqual({ version: '2.11.0' });
    const schema = JSON.parse(
      readFileSync(String(resolveSchemaPath('config.schema.json')), 'utf-8'),
    ) as Record<string, unknown>;
    expect(checkSchema(config, schema)).toEqual([]);

    // A hand edit of the sealed value is not trusted.
    const settings = join(root, '.cleo', 'owner-settings.json');
    const file = JSON.parse(readFileSync(settings, 'utf-8')) as {
      settings: Record<string, { value: number }>;
    };
    const entry = file.settings[REVIEW_WORKERS_COUNTED_KEY];
    if (entry) entry.value = 0;
    writeFileSync(settings, JSON.stringify(file));
    expect(await resolveReviewWorkersCounted(root)).toBe(false);
  });
});
