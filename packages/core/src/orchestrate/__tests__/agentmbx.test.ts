/**
 * AgentMBX adapter against a fake `agentmbx` CLI (T14379).
 *
 * @task T14379
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
  it('passes argv and an idempotency key; a retried send is delivered once', async () => {
    const cli = fakeCli();
    const mbx = createAgentMbxClient(cli.runner);
    const msg = { as: 'w1', to: 'proj-lead', subject: 'done', body: 'T1 done' };
    const first = await mbx.send(msg);
    const retry = await mbx.send(msg);
    expect(first).toEqual(retry);
    expect(first.ok && first.value.id).toBe('msg-1');
    expect(cli.delivered).toEqual(['T1 done']);
    expect(cli.calls[0]).toContain('--idempotency-key');
    expect(cli.calls[0]?.slice(0, 5)).toEqual(['send', '--as', 'w1', '--to', 'proj-lead']);
  });

  it('honours an explicit key and fails closed with a warning', async () => {
    const cli = fakeCli();
    const sent = await createAgentMbxClient(cli.runner).send({
      as: 'a',
      to: 'b',
      subject: 's',
      body: 'm',
      idempotencyKey: 'k1',
    });
    expect(sent.ok && sent.value.idempotencyKey).toBe('k1');

    const missing = await createAgentMbxClient(absent).send({
      as: 'a',
      to: 'b',
      subject: 's',
      body: 'm',
    });
    expect(missing).toEqual({ ok: false, warning: 'agentmbx is not installed (not on PATH)' });
    const failed = await createAgentMbxClient(cli.runner).status({ cli: 'claude' });
    expect(failed.ok ? '' : failed.warning).toBe(
      'agentmbx status failed (exit 2): unknown command',
    );
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

  it('records <project>-lead when agentmbx is installed, then keeps it', async () => {
    const result = await ensureLeadMailbox(root, project, createAgentMbxClient(fakeCli().runner), {
      CLEO_HOOK_PROVIDER: 'codex',
    });
    const expected = { name: 'my-project-lead', projectId: 'pid-1', cli: 'codex' };
    expect(result).toEqual({ action: 'recorded', leadMailbox: expected });
    const config = JSON.parse(await readFile(join(root, '.cleo', 'config.json'), 'utf-8'));
    expect(config.orchestrate.leadMailbox).toEqual(expected);
    expect(await resolveLeadMailbox(root)).toBe('my-project-lead');
    expect(await resolveLeadMailbox(root, 'explicit')).toBe('explicit');

    const again = await ensureLeadMailbox(root, project, createAgentMbxClient(absent));
    expect(again.action).toBe('kept');
  });

  it('warns and writes nothing without agentmbx', async () => {
    const result = await ensureLeadMailbox(root, project, createAgentMbxClient(absent));
    expect(result.action).toBe('skipped');
    await expect(readFile(join(root, '.cleo', 'config.json'), 'utf-8')).rejects.toThrow();
    expect(await resolveLeadMailbox(root)).toBeUndefined();
  });

  it('derives a valid mailbox name', () => {
    expect(leadMailboxName('cleocode')).toBe('cleocode-lead');
    expect(leadMailboxName('--')).toBe('project-lead');
  });
});
