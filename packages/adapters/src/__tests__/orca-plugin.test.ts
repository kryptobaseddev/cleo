/**
 * T14462 — the CLEO Orca plugin's Node-only modules, run in CI.
 *
 * The plugin folder (`packages/adapters/orca-plugin`) is loaded by Orca as
 * written and its panel/worker fixtures need Orca's own test kit, which CI
 * does not have. Everything that decides what a local `cleo` subprocess may
 * run, and how its envelope is read, has no Orca import, so it is proven
 * here against real subprocesses: `process.execPath` stands in for `cleo`.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  listArgv,
  parseEnvelope,
  runCleo,
  showArgv,
  TASK_PAGE_SIZE,
} from '../../orca-plugin/src/cleo-cli.ts';
import { toTaskDetail, toTaskPage } from '../../orca-plugin/src/views.ts';
import {
  buildWorkspaceOptions,
  type HostWorkspace,
  isLocalHost,
  resolveSelection,
} from '../../orca-plugin/src/workspaces.ts';

const cwd = mkdtempSync(join(tmpdir(), 'cleo-orca-plugin-'));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

/** Runs a Node one-liner in place of `cleo`, under the runner's real bounds. */
function runScript(script: string, options: Partial<Parameters<typeof runCleo>[1]> = {}) {
  return runCleo(['-e', script], { cwd, bin: process.execPath, ...options });
}

const print = (value: unknown, exitCode = 0) =>
  `process.stdout.write(${JSON.stringify(JSON.stringify(value))} + "\\n"); process.exitCode = ${exitCode};`;

describe('runCleo', () => {
  it('returns the data of a successful envelope', async () => {
    const result = await runScript(print({ success: true, data: { tasks: [] } }));
    expect(result).toEqual({ ok: true, data: { tasks: [] } });
  });

  it('trusts the envelope over the exit code (an empty list exits 100)', async () => {
    const result = await runScript(print({ success: true, data: { tasks: [] } }, 100));
    expect(result).toEqual({ ok: true, data: { tasks: [] } });
  });

  it('reports a missing CLEO executable', async () => {
    const result = await runCleo(['list'], { cwd, bin: join(cwd, 'no-such-cleo') });
    expect(result).toMatchObject({ ok: false, code: 'cleo-missing' });
  });

  it('reports a workspace folder that is not on this machine, without starting anything', async () => {
    const result = await runScript(print({ success: true, data: {} }), {
      cwd: join(cwd, 'not-here'),
    });
    expect(result).toMatchObject({ ok: false, code: 'workspace-unavailable' });
  });

  it('stops a read that outlives its deadline', async () => {
    const result = await runScript('setTimeout(() => {}, 60_000);', { timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('stops a read that prints more than the output cap', async () => {
    const result = await runScript('process.stdout.write("x".repeat(200_000));', {
      maxOutputBytes: 1024,
    });
    expect(result).toMatchObject({ ok: false, code: 'output-too-large' });
  });

  it('stops a read when the caller cancels', async () => {
    const controller = new AbortController();
    const pending = runScript('setTimeout(() => {}, 60_000);', { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('reports output that is not one JSON envelope', async () => {
    const result = await runScript('process.stdout.write("Loading...\\n{\\"success\\":true}");');
    expect(result).toMatchObject({ ok: false, code: 'malformed-envelope' });
  });

  it('reads a folder that is not a CLEO project from the error envelope', async () => {
    const result = await runScript(
      print(
        {
          success: false,
          error: { code: 4, codeName: 'E_CLEO_NOT_FOUND', message: 'Not inside a CLEO project.' },
        },
        4,
      ),
    );
    expect(result).toEqual({
      ok: false,
      code: 'not-a-project',
      message: 'Not inside a CLEO project.',
    });
  });

  it('never hands an agent identity to the read', async () => {
    const names = ['CLEO_SESSION_ID', 'CLEO_AGENT_ID', 'CLEO_AGENT_ROLE'] as const;
    const before = names.map((name) => process.env[name]);
    for (const name of names) process.env[name] = 'leaked';
    try {
      const result = await runScript(
        'const e = process.env; process.stdout.write(JSON.stringify({ success: true, data: ' +
          '{ session: e.CLEO_SESSION_ID ?? null, agent: e.CLEO_AGENT_ID ?? null, role: e.CLEO_AGENT_ROLE ?? null } }));',
      );
      expect(result).toEqual({ ok: true, data: { session: null, agent: null, role: null } });
    } finally {
      names.forEach((name, index) => {
        if (before[index] === undefined) delete process.env[name];
        else process.env[name] = before[index];
      });
    }
  });
});

describe('parseEnvelope', () => {
  it.each([
    ['', 'no output'],
    ['[]', 'an array'],
    ['{"data":{}}', 'no success flag'],
    ['{"success":true}', 'success without data'],
    ['{"success":true,"data":[]}', 'data that is not an object'],
    ['{"success":false}', 'failure without an error'],
  ])('rejects %j (%s) as malformed', (stdout) => {
    expect(parseEnvelope(stdout)).toMatchObject({ ok: false, code: 'malformed-envelope' });
  });

  it('keeps CLEO’s own error code and message', () => {
    const stdout = '{"success":false,"error":{"codeName":"E_NOT_FOUND","message":"No such task"}}';
    expect(parseEnvelope(stdout)).toEqual({
      ok: false,
      code: 'cli-error',
      message: 'E_NOT_FOUND: No such task',
    });
  });
});

describe('argv builders', () => {
  it('builds only bounded read commands', () => {
    const page = ['--limit', String(TASK_PAGE_SIZE), '--offset'];
    expect(listArgv({})).toEqual(['list', '--type', 'epic', '--status', 'active', ...page, '0']);
    expect(listArgv({ status: 'all', offset: 50 })).toEqual([
      'list',
      '--type',
      'epic',
      ...page,
      '50',
    ]);
    expect(listArgv({ parentId: 'T14451' })).toEqual(['list', '--parent', 'T14451', ...page, '0']);
    expect(showArgv('T932EP')).toEqual(['show', 'T932EP', '--full']);
  });

  it.each([
    [{ parentId: '--all' }],
    [{ parentId: 'T1; rm -rf /' }],
    [{ parentId: 14451 }],
    [{ status: 'active,pending' }],
    [{ offset: -1 }],
    [{ offset: 1.5 }],
    [{ offset: '0' }],
  ])('refuses the list request %j', (request) => {
    expect(listArgv(request)).toBeNull();
  });

  it.each([
    '--force',
    'complete',
    'T',
    't100',
    'T100 --full',
    '',
    null,
    100,
  ])('refuses %j as a task id', (taskId) => {
    expect(showArgv(taskId)).toBeNull();
  });
});

describe('workspace selection', () => {
  const local: HostWorkspace = {
    id: 'ws-app',
    kind: 'worktree',
    name: 'app',
    path: '/work/app',
    branch: 'main',
    hostId: 'local',
  };
  const twin: HostWorkspace = { ...local, id: 'ws-twin', path: '/work/app-2' };
  const remote: HostWorkspace = { ...local, id: 'ws-ssh', name: 'server', hostId: 'ssh:build' };
  const folder: HostWorkspace = {
    ...local,
    id: 'ws-dir',
    kind: 'folder',
    branch: null,
    hostId: null,
  };

  it('treats only Orca’s own machine as local', () => {
    expect([
      isLocalHost('local'),
      isLocalHost(null),
      isLocalHost('ssh:build'),
      isLocalHost(''),
    ]).toEqual([true, true, false, false]);
  });

  it('tells workspaces that share a name apart by path and blocks remote ones', () => {
    const { workspaces } = buildWorkspaceOptions([local, twin, remote], null);
    expect(workspaces.map(({ label, blocked }) => [label, blocked])).toEqual([
      ['app — /work/app', null],
      ['app — /work/app-2', null],
      ['server (remote: ssh:build)', 'remote'],
    ]);
  });

  it('marks the focused workspace only when exactly one matches', () => {
    const focus = { displayName: 'app', branch: 'main' };
    const ambiguous = buildWorkspaceOptions([local, twin], focus);
    expect(ambiguous.focus).toEqual({ name: 'app', matches: 2 });
    expect(ambiguous.workspaces.map((workspace) => workspace.focused)).toEqual([false, false]);
    const unique = buildWorkspaceOptions([local, remote], focus);
    expect(unique.workspaces.map((workspace) => workspace.focused)).toEqual([true, false]);
  });

  it('collapses an id that names two workspaces into one blocked row', () => {
    const { workspaces } = buildWorkspaceOptions([local, { ...twin, id: 'ws-app' }], null);
    expect(workspaces.map((workspace) => workspace.blocked)).toEqual(['duplicate-id']);
  });

  it('resolves a selection only while id, host and path all still agree', () => {
    const listed = [local, twin, remote, folder];
    const pick = (selection: unknown) => {
      const resolved = resolveSelection(listed, selection);
      return resolved.ok ? resolved.path : resolved.code;
    };
    expect(pick({ id: 'ws-app', hostId: 'local', path: '/work/app' })).toBe('/work/app');
    expect(pick({ id: 'ws-dir', hostId: null, path: '/work/app' })).toBe('/work/app');
    expect(pick({ id: 'ws-app', hostId: 'local', path: '/work/app-2' })).toBe('workspace-changed');
    expect(pick({ id: 'ws-ssh', hostId: 'local', path: '/work/app' })).toBe('workspace-changed');
    expect(pick({ id: 'ws-ssh', hostId: 'ssh:build', path: '/work/app' })).toBe('workspace-remote');
    expect(pick({ id: 'ws-gone', hostId: 'local', path: '/work/app' })).toBe(
      'workspace-unavailable',
    );
    expect(pick({ id: 'ws-app', path: '/work/app' })).toBe('invalid-request');
    expect(pick('ws-app')).toBe('invalid-request');
    expect(resolveSelection([local, { ...twin, id: 'ws-app' }], { ...local })).toMatchObject({
      code: 'workspace-changed',
    });
    expect(
      resolveSelection([{ ...local, path: 'relative/app' }], { ...local, path: 'relative/app' }),
    ).toMatchObject({ code: 'workspace-unavailable' });
  });
});

describe('view mapping', () => {
  it('reports a truncated page from CLEO’s population block', () => {
    const page = toTaskPage(
      {
        tasks: [{ id: 'T1', title: 'One', status: 'pending', type: 'epic' }],
        population: { matched: 275, truncated: true },
      },
      0,
    );
    expect(page).toMatchObject({ ok: true, matched: 275, truncated: true });
  });

  it.each([
    [{ tasks: 'none' }],
    [{ tasks: [{ title: 'no id' }] }],
    [{}],
  ])('rejects the list data %j as malformed', (data) => {
    expect(toTaskPage(data, 0)).toMatchObject({ ok: false, code: 'malformed-envelope' });
  });

  it('clips long text and ignores evidence aimed at another task', () => {
    const detail = toTaskDetail({
      task: {
        id: 'T2',
        title: 'x'.repeat(1000),
        description: 'y'.repeat(10_000),
        acceptance: ['First', 'Second'],
        verification: {
          gates: { implemented: true },
          evidence: {
            implemented: {
              atoms: [{ kind: 'satisfies', targetTaskId: 'T9', targetAcAlias: 'AC1' }],
            },
          },
        },
      },
    });
    if (!detail.ok) throw new Error(detail.message);
    expect(detail.task.title.length).toBeLessThan(400);
    expect(detail.task.description.length).toBeLessThan(4100);
    expect(detail.acceptance).toEqual([
      { alias: 'AC1', text: 'First', gates: [] },
      { alias: 'AC2', text: 'Second', gates: [] },
    ]);
    expect(detail.claim).toBeNull();
    expect(toTaskDetail({ task: { title: 'no id' } })).toMatchObject({
      code: 'malformed-envelope',
    });
  });
});

describe('plugin manifest', () => {
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../orca-plugin/orca-plugin.json', import.meta.url)),
      'utf8',
    ),
  );

  it('asks Orca for workspace:read only and contributes one panel and one command', () => {
    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.execution).toBe('trusted-worker');
    expect(manifest.engines.orca).toBe('>=1.4.255');
    expect(manifest.capabilities).toEqual([{ kind: 'workspace:read' }]);
    expect(Object.keys(manifest.contributes).sort()).toEqual(['commands', 'panels']);
    expect(manifest.contributes.panels).toHaveLength(1);
    expect(manifest.contributes.panels[0].ui).toBe('components');
    expect(manifest.contributes.commands).toEqual([
      { id: 'cleo.refresh', title: 'CLEO: Refresh Tasks' },
    ]);
  });
});
