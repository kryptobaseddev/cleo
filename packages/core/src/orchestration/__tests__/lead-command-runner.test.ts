/**
 * Lead command runner (T14374): allow-listed cleo/gh argv runs with no shell;
 * everything else, and any shell metacharacter, is refused before a process
 * starts. A fake `cleo` on PATH records each run.
 *
 * @task T14374
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkLeadCommand,
  runLeadCommand,
  serveLeadCommandRunner,
} from '../lead-command-runner.js';

let dir: string;
let marker: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-lead-runner-'));
  marker = join(dir, 'ran.log');
  const fake = join(dir, 'cleo');
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${marker}"\necho "fake-cleo $@"\n`);
  chmodSync(fake, 0o755);
  env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` };
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('lead command runner (T14374)', () => {
  it('runs an allow-listed cleo verb through execFile', async () => {
    const result = await runLeadCommand(['cleo', 'show', 'T1', '--full'], { env });
    expect(result).toEqual({
      allowed: true,
      exitCode: 0,
      stdout: 'fake-cleo show T1 --full\n',
      stderr: '',
    });
    const dryRun = await runLeadCommand(['cleo', 'done', '--from-merge', '12', '--dry-run'], {
      env,
    });
    expect(dryRun).toMatchObject({ allowed: true, exitCode: 0 });
  });

  it.each([
    [['git', 'push', 'origin', 'main']],
    [['sh', '-c', 'cleo show T1']],
    [['/usr/local/bin/cleo', 'show', 'T1']],
    [['cleo', 'add', 'X']],
    [['cleo', 'update', 'T1', '--status', 'done']],
    [['cleo', 'complete', 'T1']],
    [['cleo', 'orchestrate', 'worktree-complete', 'T1']],
    [['cleo', 'orchestrate', 'approve', 'tok']],
    [['cleo', 'done', '--from-merge', '12']],
    [['cleo', 'done', '--from-merge', '12', '--dry-run', '--no-dry-run']],
    [['cleo', '--cwd', '/tmp', 'show', 'T1']],
    [['gh', 'pr', 'merge', '12']],
    [['cleo', 'merge']],
    [['cleo', 'merge', 'pr', '12']],
    [['gh', 'api', 'repos/x/y']],
    [['gh', 'pr']],
    [[]],
  ])('refuses %j and starts no process', async (argv) => {
    const result = await runLeadCommand(argv, { env });
    expect(result.allowed).toBe(false);
  });

  it.each([
    ['T1; rm -rf ~'],
    ['$(id)'],
    ['`id`'],
    ['a|b'],
    ['a && b'],
    ['a > /tmp/x'],
    ['a\nb'],
  ])('refuses shell metacharacters in %j', async (word) => {
    const result = await runLeadCommand(['cleo', 'find', word], { env });
    expect(result).toMatchObject({ allowed: false, reason: expect.stringMatching(/metachar/) });
  });

  it('never ran the fake for a refused call', () => {
    const runs = existsSync(marker) ? readFileSync(marker, 'utf-8').trim().split('\n') : [];
    expect(runs).toEqual(['show T1 --full', 'done --from-merge 12 --dry-run']);
  });

  it('allows the listed gh verbs and orchestrate subcommands', () => {
    for (const argv of [
      ['gh', 'pr', 'checks', '12'],
      ['gh', 'run', 'view', '99', '--log-failed'],
      ['cleo', 'orchestrate', 'ready', 'T1'],
      ['cleo', 'review', 'verdict', 'T1'],
      ['cleo', 'memory', 'find', 'x'],
      ['cleo', 'session', 'status'],
      ['cleo', 'merge', 'train'],
      ['cleo', 'merge', 'train', '--execute'],
    ]) {
      expect(checkLeadCommand(argv)).toEqual({ allowed: true });
    }
  });

  it('serves one MCP tool that takes argv and refuses a shell string', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    const done = serveLeadCommandRunner({ input, output }, { env });
    const send = (msg: object) => input.write(`${JSON.stringify(msg)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'cleo_run', arguments: { argv: ['cleo', 'list', '--parent', 'T1'] } },
    });
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'cleo_run', arguments: { argv: 'cleo show T1; rm -rf ~' } },
    });
    input.end();
    await done;

    const byId = new Map(
      text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> })
        .map((r) => [r.id, r.result]),
    );
    expect([...byId.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(byId.get(2)).toMatchObject({ tools: [{ name: 'cleo_run' }] });
    expect(byId.get(3)).toMatchObject({ isError: false });
    expect(JSON.stringify(byId.get(3))).toContain('fake-cleo list --parent T1');
    expect(byId.get(4)).toMatchObject({ isError: true });
    expect(JSON.stringify(byId.get(4))).toContain('argv must be an array');
  });
});
