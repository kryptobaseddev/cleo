/**
 * AgentMBX adapter against a fake `agentmbx` CLI (T14379).
 *
 * @task T14379
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';
import { getProjectRoot } from '../../paths.js';
import { validateSchema } from '../../validation/schema-validator.js';
import {
  createAgentMbxClient,
  ensureLeadMailbox,
  leadMailboxName,
  MBX_NAME,
  type MbxRunner,
  resolveLeadMailbox,
  runAgentMbx,
} from '../agentmbx.js';

const { mailboxWarning } = vi.hoisted(() => ({ mailboxWarning: vi.fn() }));
vi.mock('../../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger.js')>();
  return {
    ...actual,
    getLogger: (subsystem: string) => {
      const logger = actual.getLogger(subsystem);
      logger.warn = mailboxWarning;
      return logger;
    },
  };
});

/** A fake CLI that delivers each idempotency key once, like agentmbx does. */
function fakeCli(): { runner: MbxRunner; calls: string[][]; delivered: string[] } {
  const calls: string[][] = [];
  const delivered: string[] = [];
  const byKey = new Map<string, string>();
  const runner: MbxRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === '--version')
      return { missing: false, exitCode: 0, stdout: '0.5.58', stderr: '' };
    if (args[0] === 'send') {
      const key = args[args.indexOf('--idempotency-key') + 1] ?? '';
      let id = byKey.get(key);
      if (!id) {
        id = `msg-${byKey.size + 1}`;
        byKey.set(key, id);
        delivered.push(args[args.indexOf('-m') + 1] ?? '');
      }
      return { missing: false, exitCode: 0, stdout: JSON.stringify({ id }), stderr: '' };
    }
    return { missing: false, exitCode: 2, stdout: '', stderr: 'unknown command\n' };
  };
  return { runner, calls, delivered };
}

const absent: MbxRunner = async () => ({ missing: true, exitCode: null, stdout: '', stderr: '' });

/** The actual configured project's mailbox for the real parent epic. */
async function liveEpicMailbox(): Promise<string> {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  const base = (await loadConfig(getProjectRoot())).orchestrate?.leadMailbox;
  if (!base) throw new Error('The live project needs a recorded lead mailbox');
  return leadMailboxName(base.name, base.projectId, 'T14351');
}

describe('createAgentMbxClient.send', () => {
  it('passes argv and the caller key; a retried send is delivered once', async () => {
    const cli = fakeCli();
    const mbx = createAgentMbxClient(cli.runner);
    const msg = {
      as: 'w1',
      to: 'proj-lead',
      subject: 'done',
      body: 'T1 done',
      idempotencyKey: 'k1',
    };
    const first = await mbx.send(msg);
    const retry = await mbx.send(msg);
    expect(first).toEqual({ ok: true, value: { id: 'msg-1' } });
    expect(retry).toEqual(first);
    expect(cli.delivered).toEqual(['T1 done']);
    expect(cli.calls[0]?.slice(0, 5)).toEqual(['send', '--as', 'w1', '--to', 'proj-lead']);
    expect(cli.calls[0]).toContain('k1');
  });

  it('sends no key unless given, so legitimate repeats are delivered', async () => {
    const cli = fakeCli();
    const mbx = createAgentMbxClient(cli.runner);
    const msg = { as: 'a', to: 'b', subject: 'stuck', body: 'again' };
    await mbx.send(msg);
    await mbx.send(msg);
    expect(cli.calls[0]).not.toContain('--idempotency-key');
  });

  it('fails closed with a warning', async () => {
    const missing = await createAgentMbxClient(absent).send({
      as: 'a',
      to: 'b',
      subject: 's',
      body: 'm',
    });
    expect(missing).toEqual({ ok: false, warning: 'agentmbx is not installed (not on PATH)' });
    const failed = await createAgentMbxClient(fakeCli().runner).status({ cli: 'claude' });
    expect(failed.ok ? '' : failed.warning).toBe(
      'agentmbx status failed (exit 2): unknown command',
    );
  });

  it('refuses a claim name that would parse as a flag', async () => {
    const cli = fakeCli();
    const r = await createAgentMbxClient(cli.runner).claim('--all', {
      cli: 'claude',
      session: 's',
    });
    expect(r.ok).toBe(false);
    expect(cli.calls).toHaveLength(0);
  });

  it('the default client never reaches a real install under vitest', async () => {
    expect(process.env['CLEO_AGENTMBX_DISABLE']).toBe('1');
    expect(await createAgentMbxClient().available()).toBe(false);
  });
});

describe('runAgentMbx', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.skipIf(!process.env['CLEO_MBX_LIVE_PACKAGE'])(
    'pins the installed AgentMBX rule and generates the real epic mailbox (T14477)',
    async () => {
      const packageRoot = process.env['CLEO_MBX_LIVE_PACKAGE'];
      if (!packageRoot)
        throw new Error('Set CLEO_MBX_LIVE_PACKAGE to the installed AgentMBX package');
      expect(await readFile(join(packageRoot, 'dist', 'envelope.js'), 'utf-8')).toContain(
        `export const NAME_RE = ${MBX_NAME.toString()};`,
      );
      const name = await liveEpicMailbox();
      expect(name).toMatch(MBX_NAME);
      process.stderr.write(`Generated T14351 mailbox: ${name}\n`);
    },
  );
  it.skipIf(!process.env['CLEO_MBX_LIVE_SESSION'])(
    'verifies a real MCP-registered lead and its exact provider holder (T14477)',
    async () => {
      const session = process.env['CLEO_MBX_LIVE_SESSION'];
      const packageRoot = process.env['CLEO_MBX_LIVE_PACKAGE'];
      if (!session || !packageRoot)
        throw new Error(
          'Set CLEO_MBX_LIVE_SESSION and CLEO_MBX_LIVE_PACKAGE after registering the generated T14351 mailbox through mbx_identity with role lead',
        );
      const name = await liveEpicMailbox();
      const projectRoot = getProjectRoot();
      expect(await readFile(join(packageRoot, 'dist', 'envelope.js'), 'utf-8')).toContain(
        `export const NAME_RE = ${MBX_NAME.toString()};`,
      );
      const client = createAgentMbxClient(runAgentMbx);
      const selector = { cli: 'codex', session };
      expect(await client.status(selector)).toMatchObject({
        ok: true,
        value: { name, state: 'bound', role: 'lead' },
      });
      expect(await client.status({ ...selector, session: `${session}-missing` })).toMatchObject({
        ok: true,
        value: { name: null, state: 'unbound' },
      });
      expect(await client.holder(name, projectRoot)).toEqual({ ok: true, value: selector });
      expect(await resolveLeadMailbox(projectRoot, name, client)).toBe(name);
    },
  );

  it('reports a missing binary instead of throwing', async () => {
    vi.stubEnv('PATH', '');
    expect(await runAgentMbx(['--version'])).toMatchObject({ missing: true, exitCode: null });
  });
});

describe('lead mailbox config', () => {
  let root: string;
  const configPath = () => join(root, '.cleo', 'config.json');
  const writeConfig = (v1: boolean) =>
    writeFile(configPath(), JSON.stringify({ orchestrate: { leadWorker: { v1 } } }));
  beforeEach(async () => {
    // The config path must resolve to this temp project, not the fork's pin.
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    root = await mkdtemp(join(tmpdir(), 'cleo-t14379-'));
    await mkdir(join(root, '.cleo'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  const project = { projectName: 'My Project', projectId: 'pid-1' };

  it('with leadWorker.v1 on, records a schema-valid <project>-<hash>-lead, then keeps it', async () => {
    await writeConfig(true);
    const result = await ensureLeadMailbox(root, project, createAgentMbxClient(fakeCli().runner), {
      CLEO_HOOK_PROVIDER: 'codex',
    });
    const expected = {
      name: leadMailboxName(project.projectName, project.projectId),
      projectId: 'pid-1',
      cli: 'codex',
    };
    expect(result).toEqual({ action: 'recorded', leadMailbox: expected });
    const config = JSON.parse(await readFile(configPath(), 'utf-8'));
    expect(config.orchestrate.leadMailbox).toEqual(expected);
    expect(validateSchema('config', { version: '2.0.0', ...config }).errors).toEqual([]);
    // Recording is not registration or proof of a live holder.
    expect(await resolveLeadMailbox(root)).toBeUndefined();
    await expect(resolveLeadMailbox(root, 'explicit')).rejects.toThrow('live holder');

    const again = await ensureLeadMailbox(root, project, createAgentMbxClient(absent));
    expect(again.action).toBe('kept');
  });

  it('with leadWorker.v1 on and no agentmbx, warns and writes nothing', async () => {
    await writeConfig(true);
    const result = await ensureLeadMailbox(root, project, createAgentMbxClient(absent));
    expect(result).toMatchObject({
      action: 'skipped',
      warning: expect.stringContaining('`cleo upgrade`'),
    });
    expect(
      JSON.parse(await readFile(configPath(), 'utf-8')).orchestrate.leadMailbox,
    ).toBeUndefined();
    expect(await resolveLeadMailbox(root)).toBeUndefined();
  });

  it('with leadWorker.v1 off, never probes agentmbx and spawns name no mailbox', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({
        orchestrate: { leadMailbox: { name: 'old-lead', projectId: 'pid-1', cli: 'claude' } },
      }),
    );
    const cli = fakeCli();
    const result = await ensureLeadMailbox(root, project, createAgentMbxClient(cli.runner));
    expect(result).toEqual({ action: 'disabled' });
    expect(cli.calls).toHaveLength(0);
    expect(await resolveLeadMailbox(root)).toBeUndefined();
    await expect(resolveLeadMailbox(root, 'explicit')).rejects.toThrow('live holder');
  });
});

describe('AgentMBX registration names (T14477)', () => {
  it('pins the adapter and config schema to AgentMBX 0.5.58 NAME_RE', async () => {
    const oracle = /^[a-z0-9][a-z0-9-]{1,39}$/;
    expect(MBX_NAME.toString()).toBe(oracle.toString());
    const schema = JSON.parse(
      await readFile(new URL('../../../schemas/config.schema.json', import.meta.url), 'utf-8'),
    );
    expect(schema.properties.orchestrate.properties.leadMailbox.properties.name.pattern).toBe(
      oracle.source,
    );
    for (const name of [
      'aa',
      'a-',
      'a'.repeat(40),
      'a',
      '-a',
      'Lead',
      'a_b',
      'a.b',
      'a@b',
      'a:b',
      'a'.repeat(41),
    ]) {
      expect(MBX_NAME.test(name)).toBe(oracle.test(name));
    }
  });

  it.each([
    'Uppercase',
    'a',
    'a_b',
    'a.b',
    'a@b',
    'a'.repeat(41),
  ])('refuses an unregistrable explicit destination: %s', async (name) => {
    const cli = fakeCli();
    await expect(
      resolveLeadMailbox(getProjectRoot(), name, createAgentMbxClient(cli.runner)),
    ).rejects.toMatchObject({
      codeName: 'E_LEAD_MAILBOX_INVALID',
      fix: expect.stringContaining('2–40'),
    });
    expect(cli.calls).toHaveLength(0);
  });

  it.each([
    'cleocode',
    '--',
    'CAPS.With_Underscores@host',
    'a'.repeat(200),
  ])('generates registerable project and real epic names from %s', (project) => {
    for (const epicId of [undefined, 'T14351', `T${'1'.repeat(63)}`]) {
      const name = leadMailboxName(project, 'project-id', epicId);
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]{1,39}$/);
      expect(leadMailboxName(project, 'project-id', epicId)).toBe(name);
    }
  });

  it('retains full-input identity across normalization and truncation', () => {
    const prefix = 'project'.repeat(20);
    const names = [
      leadMailboxName(`${prefix}-one`, 'id', 'T14351'),
      leadMailboxName(`${prefix}-two`, 'id', 'T14351'),
      leadMailboxName(`${prefix}-one`, 'other-id', 'T14351'),
      leadMailboxName(`${prefix}-one`, 'id', 'T14352'),
      leadMailboxName('project.a', 'id', 'T14351'),
      leadMailboxName('project-a', 'id', 'T14351'),
      leadMailboxName(prefix, 'id', `${'T'.repeat(30)}1`),
      leadMailboxName(prefix, 'id', `${'T'.repeat(30)}2`),
    ];
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('live report destinations (T14477)', () => {
  beforeEach(() => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    mailboxWarning.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    { held: true, state: 'bound', actual: 'epic-lead', expected: 'epic-lead' },
    { held: false, state: 'bound', actual: 'epic-lead', expected: undefined },
    { held: true, state: 'unbound', actual: 'epic-lead', expected: undefined },
    { held: true, state: 'bound', actual: 'other-lead', expected: undefined },
  ])('requires a registered live holder and matching session status: %j', async ({
    held,
    state,
    actual,
    expected,
  }) => {
    const runner: MbxRunner = async (args) => ({
      missing: false,
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify(
        args[0] === 'identity'
          ? {
              identities: [
                {
                  name: 'epic-lead',
                  registered: true,
                  retired: false,
                  state: held ? 'held' : 'available',
                  holder: { cli: 'codex', session_id: 's1' },
                },
              ],
            }
          : { identity: { name: actual, state, role: 'lead' }, unread: 0 },
      ),
    });
    const client = createAgentMbxClient(runner);
    const root = await mkdtemp(join(tmpdir(), 'cleo-mbx-held-'));
    try {
      await mkdir(join(root, '.cleo'));
      await mkdir(join(root, '.git'));
      await writeFile(
        join(root, '.cleo', 'config.json'),
        JSON.stringify({
          orchestrate: {
            leadWorker: { v1: true },
            leadMailbox: { name: 'epic-lead', projectId: 'p1', cli: 'codex' },
          },
        }),
      );
      expect(await resolveLeadMailbox(root, undefined, client)).toBe(expected);
      if (!expected)
        expect(mailboxWarning).toHaveBeenCalledWith(
          { mailbox: 'epic-lead' },
          expect.stringContaining('omitted from worker prompts'),
        );
      if (expected) expect(await resolveLeadMailbox(root, expected, client)).toBe(expected);
      else
        await expect(resolveLeadMailbox(root, 'epic-lead', client)).rejects.toThrow('live holder');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
