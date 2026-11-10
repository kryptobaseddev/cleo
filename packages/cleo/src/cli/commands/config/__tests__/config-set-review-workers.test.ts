/**
 * `cleo config set review.workers.counted` through the real CLI command
 * (T14403): the owner-only path that seals the value outside config.json. An
 * agent session is refused and audited; the owner's set is sealed, audited
 * with its session, and leaves config.json valid against the config schema.
 *
 * The renderer is live: the LAFS envelope is read from stdout, and
 * `process.exit` is stubbed so a refusal surfaces as its exit code.
 *
 * @task T14403
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandDef } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFormatContext } from '../../../format-context.js';

/**
 * T14403: the owner path of `cleo config set review.workers.counted` asks the
 * bound session's owner-auth password at a TTY. Tests that play the owner set
 * `owner.session`; every other test runs the real session lookup.
 */
const owner = vi.hoisted(() => ({
  session: null as null | { id: string; name: string; token: string },
  password: '',
}));
vi.mock('../../../lib/owner-password.js', () => ({
  readOwnerPassword: async () => owner.password,
}));
vi.mock('@cleocode/core/internal', async (importOriginal) => {
  const real = await importOriginal<typeof import('@cleocode/core/internal')>();
  return {
    ...real,
    resolveBoundSessionId: async (...a: Parameters<typeof real.resolveBoundSessionId>) =>
      owner.session?.id ?? real.resolveBoundSessionId(...a),
    getSessionOwnerAuth: async (...a: Parameters<typeof real.getSessionOwnerAuth>) =>
      owner.session ?? real.getSessionOwnerAuth(...a),
  };
});

import { configSetCommand } from '../set.js';

const ENV_KEYS = [
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'CLEO_HOME',
  'CLEO_CONFIG_HOME',
  'CLEO_DIR',
  'CLEO_FORMAT',
  'CLEO_ROOT',
  'CLEO_PROJECT_ROOT',
  'CLEO_SESSION_ID',
  'CLEO_AGENT_ID',
  'CLEO_AGENT_ROLE',
  'HOME',
];
const savedEnv: Record<string, string | undefined> = {};
let projectRoot = '';
let scratch = '';

type RunArgs = Record<string, unknown>;

/** Run a citty command with a live renderer; return the last stdout envelope and the exit code. */
async function invokeCli(
  cmd: CommandDef,
  args: RunArgs,
): Promise<{ envelope: Record<string, unknown>; exitCode: number | null }> {
  const runFn = (cmd as { run?: (ctx: { args: RunArgs; rawArgs: string[] }) => Promise<void> }).run;
  if (!runFn) throw new Error('command has no run function');
  let exitCode: number | null = null;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    exitCode = typeof code === 'number' ? code : code == null ? 0 : Number(code);
    throw new Error(`__EXIT__:${exitCode}`);
  }) as never);
  const lines: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    lines.push(String(s));
    return true;
  });
  try {
    await runFn({ args, rawArgs: [] }).catch((err: Error) => {
      if (!err.message.startsWith('__EXIT__:')) throw err;
    });
  } finally {
    out.mockRestore();
    exitSpy.mockRestore();
  }
  const last = lines.at(-1);
  if (last === undefined) throw new Error('no stdout output captured from CLI run');
  return { envelope: JSON.parse(last.trim()) as Record<string, unknown>, exitCode };
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  scratch = mkdtempSync(join(tmpdir(), 'cleo-review-workers-cli-'));
  projectRoot = join(scratch, 'project');
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  for (const d of ['xdg-data', 'xdg-config', 'home']) mkdirSync(join(scratch, d));
  process.env['XDG_DATA_HOME'] = join(scratch, 'xdg-data');
  process.env['XDG_CONFIG_HOME'] = join(scratch, 'xdg-config');
  process.env['HOME'] = join(scratch, 'home');
  process.env['CLEO_HOME'] = join(scratch, 'cleo-home');
  process.env['CLEO_PROJECT_ROOT'] = projectRoot;
  setFormatContext({ format: 'json', source: 'default', quiet: false });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe('cleo config set review.workers.counted — owner-only (T14403)', () => {
  const ttys = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };
  const setTty = (on: boolean): void => {
    Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: on, configurable: true });
  };
  const auditRows = (): Array<Record<string, unknown>> => {
    const path = join(projectRoot, '.cleo', 'audit', 'force-bypass.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const configJson = (): Record<string, unknown> => {
    const path = join(projectRoot, '.cleo', 'config.json');
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      : {};
  };

  afterEach(() => {
    owner.session = null;
    owner.password = '';
    Object.defineProperty(process.stdin, 'isTTY', { value: ttys.stdin, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: ttys.stderr, configurable: true });
  });

  it('an agent session is refused, audited, and config.json is never written', async () => {
    setTty(false);
    const res = await invokeCli(configSetCommand as CommandDef, {
      key: 'review.workers.counted',
      value: 'true',
      scope: 'project',
    });
    expect(res.exitCode).not.toBeNull();
    expect(res.exitCode).not.toBe(0);
    expect(res.envelope['success']).toBe(false);
    const error = res.envelope['error'] as { message?: string };
    expect(error.message).toMatch(/Only the owner can change it/);
    expect(configJson()).not.toHaveProperty('review');
    expect(auditRows().at(-1)).toMatchObject({
      action: 'review-workers-counted-set-refused',
      setting: 'review.workers.counted',
      token_validated: false,
    });
    const core = await import('@cleocode/core/internal');
    expect(await core.resolveReviewWorkersCounted(projectRoot)).toBe(false);
  });

  it('AC3: the owner sets it through the CLI: sealed, audited with the session, config.json schema-valid', async () => {
    const core = await import('@cleocode/core/internal');
    setTty(true);
    const enrol = {
      id: 'ses_owner_enrol',
      name: 'owner',
      token: core.createOwnerAuthVerifier('pw'),
    };
    expect(await core.enrollOwner(projectRoot, { password: 'pw', session: enrol })).toMatchObject({
      ok: true,
    });
    owner.session = {
      id: 'ses_owner_set',
      name: 'owner',
      token: core.createOwnerAuthVerifier('pw'),
    };
    owner.password = 'pw';
    const res = await invokeCli(configSetCommand as CommandDef, {
      key: 'review.workers.counted',
      value: 'true',
      scope: 'project',
    });
    expect(res.exitCode).toBeNull();
    expect(res.envelope['success']).toBe(true);
    expect(res.envelope['data']).toMatchObject({
      key: 'review.workers.counted',
      value: true,
      previous: false,
      sealed: true,
    });
    expect(await core.resolveReviewWorkersCounted(projectRoot)).toBe(true);
    expect(auditRows().at(-1)).toMatchObject({
      action: 'review-workers-counted-set',
      session_id: 'ses_owner_set',
      token_validated: true,
      old_value: 0,
      new_value: 1,
    });
    // config.json is untouched and still passes the config schema.
    const config = { version: '2.11.0', ...configJson() };
    expect(config).not.toHaveProperty('review');
    const { checkSchema } = await import('@cleocode/core');
    const schemaPath = fileURLToPath(
      new URL('../../../../../../core/schemas/config.schema.json', import.meta.url),
    );
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
    expect(checkSchema(config, schema)).toEqual([]);
  });
});
