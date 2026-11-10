// `orca plugin test .` runs these in Node with the runtime and checks Orca uses. Each fixture
// stands in for the worker (`requests`) and asserts what the person sees in one panel state.
import { afterEach, assert, mockHost, mount, type TestPanel, test } from 'orca/testing';
import * as panelModule from './panel';
import type {
  CleoFailure,
  TaskDetail,
  TaskListRequest,
  TaskPage,
  WorkspaceList,
  WorkspaceOption,
  WorkspaceSelection,
} from './protocol.ts';

const CHOSEN: WorkspaceSelection = { id: 'ws-app', hostId: 'local', path: '/work/app' };

function option(overrides: Partial<WorkspaceOption>): WorkspaceOption {
  return {
    ...CHOSEN,
    name: 'app',
    branch: 'main',
    label: 'app',
    blocked: null,
    focused: false,
    ...overrides,
  };
}

const REMOTE = option({
  id: 'ws-ssh',
  hostId: 'ssh:build',
  path: '/srv/app',
  name: 'server',
  label: 'server (remote: ssh:build)',
  blocked: 'remote',
});

function listing(
  workspaces: WorkspaceOption[],
  overrides: Partial<WorkspaceList> = {},
): WorkspaceList {
  return {
    ok: true,
    workspaces,
    truncated: false,
    focus: { name: null, matches: 0 },
    ...overrides,
  };
}

function page(ids: string[], overrides: Partial<TaskPage> = {}): TaskPage {
  return {
    ok: true,
    tasks: ids.map((id) => ({
      id,
      title: `Epic ${id}`,
      status: 'active',
      type: 'epic',
      priority: 'high',
      parentId: null,
    })),
    matched: ids.length,
    truncated: false,
    offset: 0,
    ...overrides,
  };
}

const DETAIL: TaskDetail = {
  ok: true,
  task: {
    id: 'T101',
    title: 'Build the panel',
    status: 'active',
    type: 'task',
    priority: 'high',
    parentId: 'T100',
    description: 'A read-only view.',
    size: 'medium',
    pipelineStage: 'implementation',
    children: 0,
    updatedAt: null,
  },
  acceptance: [{ alias: 'AC1', text: 'The panel renders.', gates: ['implemented'] }],
  gates: [{ gate: 'implemented', passed: true, atoms: 'commit, files', capturedAt: null }],
  verificationPassed: false,
  claim: { agentId: 'agent-t101', sessionId: 'ses_1', claimedAt: null, leaseExpiresAt: null },
  nextAction: 'verify',
};

const failed = (code: CleoFailure['code'], message: string): CleoFailure => ({
  ok: false,
  code,
  message,
});

let panel: TestPanel | undefined;
afterEach(() => panel?.unmount());

/** Mounts the panel with `ws-app` already chosen and the given task answers. */
async function mountChosen(tasks: (input: TaskListRequest) => TaskPage | CleoFailure) {
  const requested: TaskListRequest[] = [];
  const host = mockHost({
    requests: {
      'cleo.workspaces': listing([option({}), REMOTE]),
      'cleo.tasks': (input) => {
        requested.push(input);
        return tasks(input);
      },
      'cleo.task': DETAIL,
    },
  });
  panel = await mount(panelModule, { host, persisted: { plugin: { selection: CHOSEN } } });
  return { view: panel, requested };
}

test('empty: no workspace listed', async () => {
  const host = mockHost({ requests: { 'cleo.workspaces': listing([]) } });
  panel = await mount(panelModule, { host });
  assert.match(panel.summary().join('\n'), /No workspaces/);
  assert.deepEqual(panel.errors, []);
  assert.deepEqual(panel.refusals, []);
});

test('nothing is read until a workspace is chosen, and the choice is id, host and path', async () => {
  const requested: TaskListRequest[] = [];
  const host = mockHost({
    requests: {
      'cleo.workspaces': listing([option({ focused: true }), REMOTE]),
      'cleo.tasks': (input) => {
        requested.push(input);
        return page(['T100']);
      },
    },
  });
  panel = await mount(panelModule, { host });
  assert.deepEqual(requested, []);
  assert.ok(panel.find({ text: /Choose a workspace to read/ }));
  assert.ok(panel.find({ text: /1 remote workspace\(s\) are listed but cannot be chosen/ }));

  await panel.select({ label: 'Workspace' }, 'ws-app');
  assert.deepEqual(requested, [{ selection: CHOSEN, status: 'active', offset: 0 }]);
  assert.deepEqual(panel.persisted.plugin['selection'], CHOSEN);
  assert.ok(panel.find({ type: 'Tree' }));
  assert.deepEqual(panel.errors, []);
  assert.deepEqual(panel.refusals, []);
});

test('remote: a remote workspace cannot be chosen', async () => {
  const requested: TaskListRequest[] = [];
  const host = mockHost({
    requests: {
      'cleo.workspaces': listing([REMOTE]),
      'cleo.tasks': (input) => {
        requested.push(input);
        return page([]);
      },
    },
  });
  panel = await mount(panelModule, { host });
  await assert.rejects(async () => panel?.select({ label: 'Workspace' }, 'ws-ssh'));
  assert.deepEqual(requested, []);
  assert.equal(panel.persisted.plugin['selection'] ?? null, null);
});

test('ambiguous: a focus matching two workspaces chooses none', async () => {
  const twins = [
    option({ label: 'app — /work/app' }),
    option({ id: 'ws-twin', path: '/work/app-2', label: 'app — /work/app-2' }),
  ];
  const host = mockHost({
    requests: { 'cleo.workspaces': listing(twins, { focus: { name: 'app', matches: 2 } }) },
  });
  panel = await mount(panelModule, { host });
  assert.match(panel.summary().join('\n'), /Focused workspace is ambiguous/);
  assert.ok(panel.find({ text: /"app" matches 2 workspaces/ }));
  assert.equal(panel.persisted.plugin['selection'] ?? null, null);
});

test('a saved choice that now points elsewhere is dropped before any read', async () => {
  const requested: TaskListRequest[] = [];
  const host = mockHost({
    requests: {
      'cleo.workspaces': listing([option({ path: '/work/moved' })]),
      'cleo.tasks': (input) => {
        requested.push(input);
        return page(['T100']);
      },
    },
  });
  panel = await mount(panelModule, { host, persisted: { plugin: { selection: CHOSEN } } });
  assert.deepEqual(requested, []);
  assert.equal(panel.persisted.plugin['selection'], null);
  assert.ok(panel.find({ text: /saved workspace is no longer available/ }));
});

test('empty: a CLEO project with no matching epics', async () => {
  const { view } = await mountChosen(() => page([]));
  assert.match(view.summary().join('\n'), /No epics/);
});

test('truncated: says how much is shown and loads the next page on request', async () => {
  const { view, requested } = await mountChosen((input) =>
    input.offset === 2
      ? page(['T300'], { matched: 3, offset: 2 })
      : page(['T100', 'T200'], { matched: 3, truncated: true }),
  );
  assert.match(view.summary().join('\n'), /Epic list truncated/);
  assert.ok(view.find({ text: 'Showing 2 of 3 epics.' }));
  await view.press({ text: 'Load more' });
  assert.equal(requested.at(-1)?.offset, 2);
  assert.equal(view.find({ text: /Showing 2 of 3/ }), null);
  assert.deepEqual(view.errors, []);
});

for (const [code, title] of [
  ['cleo-missing', 'CLEO CLI not found'],
  ['not-a-project', 'Not a CLEO project'],
  ['timeout', 'CLEO did not answer in time'],
  ['malformed-envelope', 'CLEO answered in an unexpected format'],
] as const) {
  test(`error: ${code} is shown with its reason`, async () => {
    const { view } = await mountChosen(() => failed(code, `fixture ${code}`));
    assert.match(view.summary().join('\n'), new RegExp(title));
    assert.ok(view.find({ text: `fixture ${code}` }));
    assert.equal(view.find({ type: 'Tree' }), null);
    assert.deepEqual(view.errors, []);
  });
}

test('error after data: the last loaded tasks stay, marked as older', async () => {
  let fail = false;
  const { view } = await mountChosen(() =>
    fail ? failed('timeout', 'slow store') : page(['T100']),
  );
  fail = true;
  await view.press({ text: 'Refresh' });
  assert.match(view.summary().join('\n'), /CLEO did not answer in time/);
  assert.ok(view.find({ text: 'Showing what was loaded before.' }));
  assert.ok(view.find({ type: 'Tree' }));
});

test('expanding an epic and selecting a task shows acceptance, evidence and worker', async () => {
  const { view, requested } = await mountChosen((input) =>
    input.parentId === 'T100'
      ? page([], { tasks: [{ ...DETAIL.task, priority: 'high' }], matched: 1 })
      : page(['T100']),
  );
  await view.expand({ type: 'Tree' }, 'T100');
  assert.equal(requested.at(-1)?.parentId, 'T100');
  await view.selectItem({ type: 'Tree' }, 'T100>T101');
  assert.deepEqual(view.host.callsOf('plugin.request').at(-1), {
    name: 'cleo.task',
    input: { selection: CHOSEN, taskId: 'T101' },
  });
  assert.ok(view.find({ text: 'T101 Build the panel' }));
  const drawn = JSON.stringify(view.tree());
  for (const shown of [
    '"description":"The panel renders."',
    '"passed · commit, files"',
    '"value":"agent-t101"',
  ]) {
    assert.ok(drawn.includes(shown), `detail draws ${shown}`);
  }
  assert.equal(view.find({ type: 'Badge' })?.text, 'implemented');
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.warnings, []);
  assert.deepEqual(view.refusals, []);
});

test('the refresh command reloads the open panel', async () => {
  const { view, requested } = await mountChosen(() => page(['T100']));
  const before = requested.length;
  await view.post('cleo.refresh', { requestedAt: 1 });
  assert.equal(requested.length, before + 1);
});

test('loading: shows a spinner, and cancel drops the answer of the read in flight', async () => {
  let release: ((answer: TaskPage) => void) | undefined;
  const { view } = await mountChosen(() => page(['T100']));
  const host = view.host;
  host.respond('plugin.request', (params: { name: string }) =>
    params.name === 'cleo.workspaces'
      ? { output: listing([option({})]) }
      : new Promise((resolve) => {
          release = (answer) => resolve({ output: answer });
        }),
  );
  void view.press({ text: 'Refresh' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(release, 'the task read is in flight');
  assert.ok(view.find({ type: 'Spinner' }), 'loading is shown while a read is in flight');
  const cancelling = view.press({ text: 'Cancel' });
  release(page(['T999']));
  await cancelling;
  await view.settled();
  assert.ok(view.find({ text: /Read cancelled/ }));
  const drawn = JSON.stringify(view.tree());
  assert.equal(drawn.includes('T999'), false);
  assert.ok(drawn.includes('T100 Epic T100'), 'the tasks loaded before stay drawn');
});
