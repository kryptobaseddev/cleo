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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createAgentMbxClient,
  type MbxIdentityStatus,
  type MbxOutcome,
  type MbxSession,
} from '../../orchestrate/agentmbx.js';
import { writeLeadRecord } from '../../orchestrate/lead-records.js';
import { createTestDb, seedTasks } from '../../store/__tests__/test-db-helper.js';
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
  writeFileSync(
    fake,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${marker}"\nprintf 'fake-cleo %s\\n' "$*"\n`,
  );
  chmodSync(fake, 0o755);
  env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` };
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('lead command runner (T14374)', () => {
  it('blocks dispatch until its own provider holds the epic mailbox with role lead (T14477)', async () => {
    writeLeadRecord(dir, {
      epicId: 'T100',
      processes: [],
      mode: 'detached',
      cleoSessionId: 'test-lead-session',
      providerCli: 'claude',
      providerSessionId: 'provider-lead-session',
      mailbox: 'test-epic-lead',
      tempDir: null,
      startedAt: new Date().toISOString(),
    });
    let status: MbxOutcome<MbxIdentityStatus> = { ok: false, warning: 'unregistered' };
    const sessions: string[] = [];
    const mbxClient = {
      ...createAgentMbxClient(),
      status: async (session: MbxSession) => {
        sessions.push(`${session.cli}:${session.session}`);
        return status;
      },
    };
    const options = { cwd: dir, env: { ...env, CLEO_SESSION_ID: 'test-lead-session' }, mbxClient };
    for (const verb of ['spawn', 'spawn-execute', 'fanout', 'handoff']) {
      const result = await runLeadCommand(['cleo', 'orchestrate', verb, 'T101'], options);
      expect(result).toMatchObject({
        allowed: false,
        reason: expect.stringContaining('"action":"register"'),
      });
    }
    for (const value of [
      { name: null, state: 'unbound', role: null, unread: 0 },
      { name: 'other-lead', state: 'bound', role: 'lead', unread: 0 },
      { name: 'test-epic-lead', state: 'bound', role: 'worker', unread: 0 },
      { name: 'test-epic-lead', state: 'unknown', role: 'lead', unread: 0 },
    ]) {
      status = { ok: true, value };
      expect(
        await runLeadCommand(['cleo', 'orchestrate', 'fanout', 'T100'], options),
      ).toMatchObject({ allowed: false });
    }
    status = {
      ok: true,
      value: { name: 'test-epic-lead', state: 'bound', role: 'lead', unread: 0 },
    };
    expect(
      await runLeadCommand(
        ['cleo', 'orchestrate', 'spawn', 'T101', '--lead-mbx', 'other'],
        options,
      ),
    ).toMatchObject({ allowed: false });
    expect(await runLeadCommand(['cleo', 'orchestrate', 'fanout', 'T100'], options)).toMatchObject({
      allowed: true,
      exitCode: 0,
    });
    expect(new Set(sessions)).toEqual(new Set(['claude:provider-lead-session']));
    status = { ok: false, warning: 'released' };
    expect(await runLeadCommand(['cleo', 'orchestrate', 'fanout', 'T100'], options)).toMatchObject({
      allowed: false,
    });
  });

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
    // No value reaches a shell, so `$` and `\` pass through verbatim.
    const literal = await runLeadCommand(['cleo', 'find', '$HOME a\\b $(id)'], { env });
    expect(literal).toMatchObject({ allowed: true, stdout: 'fake-cleo find $HOME a\\b $(id)\n' });
  });

  it('files a finding only under the lead epic subtree (T14533)', async () => {
    // The runner resolves the store from its cwd; drop the sandbox CLEO_ROOT pin.
    vi.stubEnv('CLEO_ROOT', undefined);
    const db = await createTestDb();
    try {
      await seedTasks(db.accessor, [
        { id: 'T300', type: 'epic' },
        { id: 'T301', type: 'task', parentId: 'T300' },
        { id: 'T302', type: 'subtask', parentId: 'T301' },
        { id: 'T400', type: 'epic' },
        { id: 'T401', type: 'task', parentId: 'T400' },
      ]);
      writeLeadRecord(db.tempDir, {
        epicId: 'T300',
        processes: [],
        mode: 'detached',
        cleoSessionId: 'finding-lead-session',
        providerCli: 'claude',
        providerSessionId: 'finding-provider-session',
        mailbox: null,
        tempDir: null,
        startedAt: new Date().toISOString(),
      });
      const options = { cwd: db.tempDir, env: { ...env, CLEO_SESSION_ID: 'finding-lead-session' } };
      const add = (parent: string, opts = options) =>
        runLeadCommand(
          [
            'cleo',
            'add',
            'Finding',
            '--type',
            'task',
            `--parent=${parent}`,
            '--acceptance',
            'Fixed',
          ],
          opts,
        );
      for (const parent of ['T300', 'T301', 'T302']) {
        expect(await add(parent)).toMatchObject({ allowed: true, exitCode: 0 });
      }
      for (const parent of ['T400', 'T401', 'T999', 'none', 'None']) {
        expect(await add(parent)).toMatchObject({
          allowed: false,
          reason: expect.stringMatching(/T300|none/),
        });
      }
      // A session with no lead record files nothing, even under a real epic.
      expect(
        await add('T300', { cwd: db.tempDir, env: { ...env, CLEO_SESSION_ID: 'not-a-lead' } }),
      ).toMatchObject({ allowed: false, reason: expect.stringContaining('lead record') });
    } finally {
      await db.cleanup();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    [['git', 'push', 'origin', 'main']],
    [['sh', '-c', 'cleo show T1']],
    [['/usr/local/bin/cleo', 'show', 'T1']],
    [['cleo', 'add', 'X']],
    [['cleo', 'add', 'Finding', '--parent', 'T1', '--acceptance', 'Fixed']],
    [['cleo', 'add', 'Finding', '--type', 'task', '--acceptance', 'Fixed']],
    [['cleo', 'add', 'Finding', '--type', 'task', '--parent', 'T1']],
    [['cleo', 'add', 'Finding', '--type', 'epic', '--parent', 'T1', '--acceptance', 'Fixed']],
    [['cleo', 'add', 'Finding', '--type=saga', '--parent=T1', '--acceptance=Fixed']],
    [['cleo', 'add', 'Finding', '--type=subtask', '--parent=T1', '--acceptance=Fixed']],
    [['cleo', 'add', 'Finding', '--type=', '--parent=T1', '--acceptance=Fixed']],
    [['cleo', 'add', 'Finding', '--type=task', '--parent=T1', '--acceptance=']],
    [['cleo', 'add', 'Finding', '--type', 'task', '--parent', 'none', '--acceptance', 'Fixed']],
    [['cleo', 'add', 'Finding', '--type=task', '--parent=NONE', '--acceptance=Fixed']],
    [
      [
        'cleo',
        'add',
        'Finding',
        '--type=task',
        '--parent=T1',
        '--acceptance=Fixed',
        '--status=done',
      ],
    ],
    [
      [
        'cleo',
        'add',
        'Finding',
        '--type=task',
        '--parent=T1',
        '--acceptance=Fixed',
        '--params={"type":"epic"}',
      ],
    ],
    [
      [
        'cleo',
        'add',
        'Finding',
        '--type=task',
        '--parent=T1',
        '--acceptance=Fixed',
        '--params-file=/tmp/finding.json',
      ],
    ],
    [
      [
        'cleo',
        'add',
        'Finding',
        '--type=task',
        '--parent=T1',
        '--acceptance=Fixed',
        '--force-duplicate',
      ],
    ],
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
    // A flag before the subcommand cannot change which one runs (review of #2757).
    [['cleo', 'orchestrate', '--json', 'worktree-complete', 'T1']],
    [['cleo', 'orchestrate', '--json', 'approve', 'tok']],
    [['cleo', 'orchestrate', '--quiet', 'reject', 'tok']],
    [['cleo', 'orchestrate', '--json', 'lead-runner']],
    [['cleo', 'orchestrate', 'prune', 'T1']],
    [['cleo', 'orchestrate', 'ivtr', 'T1']],
    [['cleo', 'orchestrate', 'bootstrap']],
    [['cleo', 'orchestrate', 'conduit-send', 'x']],
    [['cleo', 'orchestrate', 'reject', 'tok']],
    // The required dry run cannot be negated or swallowed.
    [['cleo', 'done', '--from-merge', '12', '--no-dryRun', '--dry-run']],
    [['cleo', 'done', '--from-merge', '12', '--dry-run', '--no-dry-run']],
    [['cleo', 'done', '--from-merge', '12', '--since', '--dry-run']],
    [['cleo', 'done', '--from-merge', '12', '--dryRun']],
    [['cleo', 'done', '--from-merge', '12', '--dry-run=false']],
    [['cleo', 'done', '--from-merge', '--dry-run']],
    [['cleo', 'done', 'T1', '--from-merge', '12', '--dry-run']],
    // Unknown flags, a word after a boolean flag, short flags, repeats.
    [['cleo', 'show', 'T1', '--unknown']],
    [['cleo', 'show', '--full', 'T1']],
    [['cleo', 'briefing', 'inject']],
    [['cleo', 'briefing', '--scope', 'inject']],
    [['cleo', 'merge', 'train', '--execute', '--execute']],
    [['cleo', 'merge', 'train', '--', 'x']],
    [['cleo', 'show', 'T1', '-v']],
    // gh: no other repo, browser, watch, body file or last-comment edits.
    [['gh', 'pr', 'view', '12', '-R', 'other/repo']],
    [['gh', 'pr', 'view', '12', '--repo', 'other/repo']],
    [['gh', 'pr', 'view', '12', '--web']],
    [['gh', 'pr', 'checks', '12', '--watch']],
    [['gh', 'pr', 'comment', '12', '--body-file', '/etc/passwd']],
    [['gh', 'pr', 'comment', '12', '--edit-last', '--body', 'x']],
    [['gh', 'pr', 'comment', '12', '--delete-last']],
    [['gh', 'pr', 'comment', '12']],
    [['gh', 'pr', '--repo', 'x/y', 'view', '12']],
  ])('refuses %j and starts no process', async (argv) => {
    const result = await runLeadCommand(argv, { env });
    expect(result.allowed).toBe(false);
  });

  it.each([
    [['cleo; rm -rf ~', 'show', 'T1']],
    [['cleo', 'show;id', 'T1']],
    [['cleo', '`id`']],
    [['cleo', 'review', 'verdict|x', '12']],
    [['gh', 'pr&&id', 'view', '12']],
    [['gh', 'pr', 'view>/tmp/x', '12']],
    [['cleo', 'show\nid', 'T1']],
  ])('refuses shell metacharacters in the binary or command words: %j', async (argv) => {
    const result = await runLeadCommand(argv, { env });
    expect(result).toMatchObject({ allowed: false, reason: expect.stringMatching(/metachar/) });
  });

  it('passes metacharacters in values and positionals verbatim (no shell)', () => {
    for (const argv of [
      ['cleo', 'review', 'verdict', '12', '--task', 'T1', '--reason', 'A & B; x > y'],
      ['cleo', 'find', 'a|b `c` $(d)'],
      ['gh', 'pr', 'comment', '12', '--body', 'line one\nline two -> ok; done & <more>'],
    ]) {
      expect(checkLeadCommand(argv)).toEqual({ allowed: true });
    }
  });

  it.each([
    [['gh', 'pr', 'comment', 'https://github.com/other/repo/pull/1', '--body', 'x']],
    [['gh', 'pr', 'view', 'https://github.com/other/repo/pull/1']],
    [['gh', 'pr', 'checks', 'other/repo#1']],
    [['gh', 'pr', 'diff', 'some-branch']],
    [['gh', 'run', 'view', 'https://github.com/other/repo/actions/runs/1']],
    [['gh', 'run', 'view', '99abc']],
  ])('gh takes only a numeric PR or run id: refuses %j', (argv) => {
    expect(checkLeadCommand(argv)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/only a number/),
    });
  });

  it('never ran the fake for a refused call', () => {
    const runs = existsSync(marker) ? readFileSync(marker, 'utf-8').trim().split('\n') : [];
    expect(runs).toEqual([
      'orchestrate fanout T100',
      'show T1 --full',
      'done --from-merge 12 --dry-run',
      'find $HOME a\\b $(id)',
      'add Finding --type task --parent=T300 --acceptance Fixed',
      'add Finding --type task --parent=T301 --acceptance Fixed',
      'add Finding --type task --parent=T302 --acceptance Fixed',
    ]);
  });

  it('allows every legitimate lead call', () => {
    for (const argv of [
      ['gh', 'pr', 'checks', '12'],
      ['gh', 'run', 'view', '99', '--log-failed'],
      ['cleo', 'orchestrate', 'ready', 'T1'],
      ['cleo', 'orchestrate', 'status'],
      ['cleo', 'orchestrate', 'status', 'T1'],
      ['cleo', 'orchestrate', 'status', '--epic', 'T1'],
      [
        'cleo',
        'add',
        'Finding',
        '--type=task',
        '--parent=T1',
        '--acceptance=AC1|AC2',
        '--description',
        'A & B; $(id)',
      ],
      ['cleo', 'review', 'verdict', 'T1'],
      ['cleo', 'memory', 'find', 'x'],
      ['cleo', 'session', 'status'],
      ['cleo', 'merge', 'train'],
      ['cleo', 'merge', 'train', '--execute'],
      ['cleo', 'merge', 'train', '--dry-run', '--json'],
      ['cleo', 'show', 'T1', 'T2', '--full', '--field', '/data/task/status'],
      ['cleo', 'find', 'lead runner', '--limit', '0', '--status=pending'],
      ['cleo', 'list', '--parent', 'T1', '--status', 'pending', '--limit', '0'],
      ['cleo', 'orchestrate', 'spawn', 'T1', '--lead-mbx', 'cleocode-orch', '--tier', '1'],
      ['cleo', 'orchestrate', 'waves', 'T1', '--hide-completed'],
      ['cleo', 'orchestrate', 'parallel', 'start', 'T1', '--wave', '2'],
      ['cleo', 'orchestrate', 'pending'],
      ['cleo', 'review', 'packet', '12', '--task', 'T1'],
      ['cleo', 'review', 'verdict', '12', '--task', 'T1', '--ac', 'AC1', '--met', '--reason', 'ok'],
      ['cleo', 'review', 'verdict', '12', '--task', 'T1', '--reason=- dash first'],
      ['cleo', 'done', '--from-merge', '12', '--dry-run'],
      ['cleo', 'done', '--dry-run', '--from-merge=12'],
      ['cleo', 'memory', 'fetch', 'O-1', 'D-2'],
      ['cleo', 'decide', 'ask', '--question', 'merge?', '--state', '{"a":1}'],
      ['gh', 'pr', 'view', '12', '--json', 'state,headRefOid', '--jq', '.state'],
      ['gh', 'pr', 'list', '--state', 'open', '--json', 'number'],
      ['gh', 'pr', 'diff', '12', '--name-only'],
      ['gh', 'pr', 'comment', '12', '--body', 'Verdict: AC1 met, see $SHA'],
      ['gh', 'run', 'list', '--branch', 'main', '--limit', '5'],
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
