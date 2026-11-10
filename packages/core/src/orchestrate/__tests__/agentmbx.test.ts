/**
 * AgentMBX adapter against a fake `agentmbx` CLI (T14379).
 *
 * @task T14379
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateSchema } from '../../validation/schema-validator.js';
import {
  claimLeadMailbox,
  createAgentMbxClient,
  ensureLeadMailbox,
  leadMailboxName,
  type MbxRunner,
  resolveLeadMailbox,
  runAgentMbx,
} from '../agentmbx.js';

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
    const expected = { name: 'my-project-9a7b43-lead', projectId: 'pid-1', cli: 'codex' };
    expect(result).toEqual({ action: 'recorded', leadMailbox: expected });
    const config = JSON.parse(await readFile(configPath(), 'utf-8'));
    expect(config.orchestrate.leadMailbox).toEqual(expected);
    expect(validateSchema('config', { version: '2.0.0', ...config }).errors).toEqual([]);
    expect(await resolveLeadMailbox(root)).toBe('my-project-9a7b43-lead');
    expect(await resolveLeadMailbox(root, 'explicit')).toBe('explicit');

    const again = await ensureLeadMailbox(root, project, createAgentMbxClient(absent));
    expect(again.action).toBe('kept');

    const cli = fakeCli();
    await claimLeadMailbox(
      root,
      { cli: 'claude', session: 's1' },
      createAgentMbxClient(cli.runner),
    );
    expect(cli.calls[0]?.slice(0, 3)).toEqual(['identity', 'claim', 'my-project-9a7b43-lead']);
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

  it('with leadWorker.v1 on and no recorded mailbox, the lead claim refuses naming `cleo upgrade` (T14448)', async () => {
    await writeConfig(true);
    const cli = fakeCli();
    const claim = await claimLeadMailbox(
      root,
      { cli: 'claude', session: 's1' },
      createAgentMbxClient(cli.runner),
    );
    expect(claim.ok).toBe(false);
    if (claim.ok) throw new Error('expected a refused claim');
    expect(claim.warning).toContain('`cleo upgrade`');
    expect(claim.warning).toContain('cleo config set orchestrate.leadWorker.v1 true');
    expect(cli.calls).toHaveLength(0);
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
    expect(await resolveLeadMailbox(root, 'explicit')).toBe('explicit');
  });

  it('derives a valid, project-qualified mailbox name', () => {
    expect(leadMailboxName('cleocode', 'x')).toBe('cleocode-2d7116-lead');
    expect(leadMailboxName('--', 'x')).toBe('project-2d7116-lead');
  });
});
