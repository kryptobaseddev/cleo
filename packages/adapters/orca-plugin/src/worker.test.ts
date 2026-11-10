// `orca plugin test .` runs these in Node: the worker's handlers over Orca's mock host, with a
// stand-in CLEO runner so no `cleo` process starts. The runner itself (missing executable,
// timeout, output cap, cancellation) is covered by the vitest suite in packages/adapters.
import { assert, mockHost, mountWorker, test } from 'orca/testing';
import type { CleoRunOptions, CleoRunResult } from './cleo-cli.ts';
import type { WorkspaceSelection } from './protocol.ts';
import { activateWith } from './worker.ts';

const LOCAL = {
  id: 'ws-app',
  kind: 'worktree',
  name: 'app',
  path: '/work/app',
  branch: 'main',
  hostId: 'local',
};
const TWIN = {
  id: 'ws-twin',
  kind: 'worktree',
  name: 'app',
  path: '/work/app-2',
  branch: 'main',
  hostId: 'local',
};
const REMOTE = {
  id: 'ws-ssh',
  kind: 'worktree',
  name: 'server',
  path: '/srv/app',
  branch: 'main',
  hostId: 'ssh:build',
};
const CHOSEN: WorkspaceSelection = { id: 'ws-app', hostId: 'local', path: '/work/app' };

/** Mounts the worker on listed workspaces and a runner that records each read. */
async function mounted(
  workspaces: readonly object[],
  answer: CleoRunResult = { ok: true, data: { tasks: [] } },
  focus: object | null = null,
) {
  const runs: { argv: readonly string[]; options: CleoRunOptions }[] = [];
  const host = mockHost({
    results: {
      'workspace.list': { workspaces, truncated: false },
      'workspace.readContext': focus,
    },
  });
  const worker = await mountWorker(
    {
      default: (orca) =>
        activateWith(orca, async (argv, options) => {
          runs.push({ argv, options });
          return answer;
        }),
    },
    { host },
  );
  return { worker, runs };
}

test('lists workspaces with remote hosts blocked and shared names told apart', async () => {
  const { worker } = await mounted([LOCAL, TWIN, REMOTE], undefined, {
    displayName: 'server',
    branch: 'main',
    terminals: [],
  });
  const answer = await worker.request('cleo.workspaces');
  assert.ok(answer.ok);
  assert.deepEqual(
    answer.workspaces.map(({ label, blocked, focused }) => ({ label, blocked, focused })),
    [
      { label: 'app — /work/app', blocked: null, focused: false },
      { label: 'app — /work/app-2', blocked: null, focused: false },
      { label: 'server (remote: ssh:build)', blocked: 'remote', focused: true },
    ],
  );
  assert.deepEqual(answer.focus, { name: 'server', matches: 1 });
  assert.deepEqual(worker.refusals, []);
  await worker.deactivate();
});

test('reports an ambiguous focus without marking any workspace', async () => {
  const { worker } = await mounted([LOCAL, TWIN], undefined, {
    displayName: 'app',
    branch: 'main',
    terminals: [],
  });
  const answer = await worker.request('cleo.workspaces');
  assert.ok(answer.ok);
  assert.deepEqual(answer.focus, { name: 'app', matches: 2 });
  assert.equal(
    answer.workspaces.some((workspace) => workspace.focused),
    false,
  );
  await worker.deactivate();
});

test('reads epics with one bounded list call in the chosen local folder', async () => {
  const { worker, runs } = await mounted([LOCAL, REMOTE], {
    ok: true,
    data: {
      tasks: [{ id: 'T100', title: 'Ship it', status: 'active', type: 'epic', priority: 'high' }],
      population: { matched: 120, truncated: true },
    },
  });
  const page = await worker.request('cleo.tasks', { selection: CHOSEN, status: 'active' });
  assert.deepEqual(
    runs.map((run) => [run.argv, run.options.cwd]),
    [
      [
        ['list', '--type', 'epic', '--status', 'active', '--limit', '50', '--offset', '0'],
        '/work/app',
      ],
    ],
  );
  assert.ok(page.ok);
  assert.equal(page.tasks[0]?.id, 'T100');
  assert.equal(page.matched, 120);
  assert.equal(page.truncated, true);
  await worker.deactivate();
});

test('never runs cleo for a remote, moved, unknown or malformed selection', async () => {
  const { worker, runs } = await mounted([LOCAL, REMOTE]);
  const remote = await worker.request('cleo.tasks', {
    selection: { id: 'ws-ssh', hostId: 'ssh:build', path: '/srv/app' },
  });
  const moved = await worker.request('cleo.tasks', {
    selection: { id: 'ws-app', hostId: 'local', path: '/somewhere/else' },
  });
  const rehosted = await worker.request('cleo.task', {
    selection: { id: 'ws-ssh', hostId: 'local', path: '/srv/app' },
    taskId: 'T1',
  });
  const unknown = await worker.request('cleo.tasks', {
    selection: { id: 'ws-gone', hostId: 'local', path: '/work/app' },
  });
  const badId = await worker.request('cleo.task', { selection: CHOSEN, taskId: '--force' });
  assert.deepEqual(
    [remote, moved, rehosted, unknown, badId].map((answer) => (answer.ok ? 'ok' : answer.code)),
    [
      'workspace-remote',
      'workspace-changed',
      'workspace-changed',
      'workspace-unavailable',
      'invalid-request',
    ],
  );
  assert.deepEqual(runs, []);
  await worker.deactivate();
});

test('refuses a workspace id that names two workspaces', async () => {
  const { worker, runs } = await mounted([LOCAL, { ...TWIN, id: 'ws-app' }]);
  const listed = await worker.request('cleo.workspaces');
  assert.ok(listed.ok);
  assert.deepEqual(
    listed.workspaces.map((workspace) => workspace.blocked),
    ['duplicate-id'],
  );
  const page = await worker.request('cleo.tasks', { selection: CHOSEN });
  assert.equal(page.ok ? 'ok' : page.code, 'workspace-changed');
  assert.deepEqual(runs, []);
  await worker.deactivate();
});

for (const code of ['cleo-missing', 'timeout', 'malformed-envelope', 'not-a-project'] as const) {
  test(`hands the panel a ${code} failure as a value`, async () => {
    const { worker } = await mounted([LOCAL], { ok: false, code, message: `fixture ${code}` });
    const page = await worker.request('cleo.tasks', { selection: CHOSEN });
    assert.deepEqual(page, { ok: false, code, message: `fixture ${code}` });
    await worker.deactivate();
  });
}

test('treats a successful envelope without a task list as malformed', async () => {
  const { worker } = await mounted([LOCAL], { ok: true, data: { rows: [] } });
  const page = await worker.request('cleo.tasks', { selection: CHOSEN, parentId: 'T100' });
  assert.equal(page.ok ? 'ok' : page.code, 'malformed-envelope');
  await worker.deactivate();
});

test('reads one task with acceptance, evidence and the worker claim', async () => {
  const { worker, runs } = await mounted([LOCAL], {
    ok: true,
    data: {
      task: {
        id: 'T101',
        title: 'Build the panel',
        status: 'active',
        type: 'task',
        parentId: 'T100',
        verification: {
          passed: false,
          gates: { implemented: true, testsPassed: false },
          evidence: {
            implemented: {
              capturedAt: '2026-11-10T19:00:00.000Z',
              atoms: [
                { kind: 'commit' },
                { kind: 'satisfies', targetTaskId: 'T101', targetAcAlias: 'AC1' },
              ],
            },
          },
        },
        claim: { agentId: 'agent-t101', sessionId: 'ses_1', claimedAt: null, leaseExpiresAt: null },
        relationCounts: { children: 2 },
      },
      acRows: [
        { alias: 'AC1', text: 'The panel renders.' },
        { alias: 'AC2', text: 'The worker is bounded.' },
      ],
      view: { nextAction: 'verify' },
    },
  });
  const detail = await worker.request('cleo.task', { selection: CHOSEN, taskId: 'T101' });
  assert.deepEqual(runs[0]?.argv, ['show', 'T101', '--full']);
  assert.ok(detail.ok);
  assert.deepEqual(detail.acceptance, [
    { alias: 'AC1', text: 'The panel renders.', gates: ['implemented'] },
    { alias: 'AC2', text: 'The worker is bounded.', gates: [] },
  ]);
  assert.deepEqual(detail.gates, [
    {
      gate: 'implemented',
      passed: true,
      atoms: 'commit, satisfies',
      capturedAt: '2026-11-10T19:00:00.000Z',
    },
    { gate: 'testsPassed', passed: false, atoms: '', capturedAt: null },
  ]);
  assert.equal(detail.claim?.agentId, 'agent-t101');
  assert.equal(detail.task.children, 2);
  assert.equal(detail.nextAction, 'verify');
  await worker.deactivate();
});

test('the refresh command tells open panels to reload', async () => {
  const { worker } = await mounted([LOCAL]);
  const shown = await worker.command('cleo.refresh');
  assert.equal(typeof shown, 'string');
  assert.equal(worker.posts.length, 1);
  assert.equal(worker.posts[0]?.event, 'cleo.refresh');
  assert.deepEqual(worker.refusals, []);
  await worker.deactivate();
});
