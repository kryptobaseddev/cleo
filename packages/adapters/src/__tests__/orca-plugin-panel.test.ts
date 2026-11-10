/**
 * T14462 — the CLEO Tasks panel's state and behaviour, run in CI.
 *
 * `panel.tsx` only draws; every decision (what is read when, which answer may
 * still be drawn, what a cancel drops) lives in `panel-state.ts`, which has no
 * Orca import. Here plain variables stand in for Orca atoms and controllable
 * promises stand in for the plugin worker, so the order answers arrive in is
 * the test's to choose.
 */

import { describe, expect, it } from 'vitest';
import {
  type CellFactory,
  createPanelState,
  type PanelRequests,
} from '../../orca-plugin/src/panel-state.ts';
import type {
  CleoFailure,
  TaskDetail,
  TaskDetailRequest,
  TaskListRequest,
  TaskPage,
  WorkspaceList,
  WorkspaceOption,
  WorkspaceSelection,
} from '../../orca-plugin/src/protocol.ts';

const CHOSEN: WorkspaceSelection = { id: 'ws-app', hostId: 'local', path: '/work/app' };

function option(overrides: Partial<WorkspaceOption> = {}): WorkspaceOption {
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

const OTHER = option({ id: 'ws-other', path: '/work/other', name: 'other', label: 'other' });
const REMOTE = option({ id: 'ws-ssh', hostId: 'ssh:build', path: '/srv/app', blocked: 'remote' });

function listing(workspaces: WorkspaceOption[]): WorkspaceList {
  return { ok: true, workspaces, truncated: false, focus: { name: null, matches: 0 } };
}

function page(ids: string[], overrides: Partial<TaskPage> = {}): TaskPage {
  return {
    ok: true,
    tasks: ids.map((id) => ({
      id,
      title: `Task ${id}`,
      status: 'active',
      type: 'epic',
      priority: null,
      parentId: null,
    })),
    matched: ids.length,
    truncated: false,
    offset: 0,
    ...overrides,
  };
}

function detailOf(id: string, children = 0): TaskDetail {
  return {
    ok: true,
    task: {
      id,
      title: `Task ${id}`,
      status: 'active',
      type: 'task',
      priority: null,
      parentId: null,
      description: '',
      size: null,
      pipelineStage: null,
      children,
      updatedAt: null,
    },
    acceptance: [],
    gates: [],
    verificationPassed: false,
    claim: null,
    nextAction: null,
  };
}

const failed = (code: CleoFailure['code']): CleoFailure => ({ ok: false, code, message: code });

/** A promise the test settles when it chooses. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Answers = {
  workspaces?: () => Promise<WorkspaceList | CleoFailure> | WorkspaceList | CleoFailure;
  tasks?: (input: TaskListRequest) => Promise<TaskPage | CleoFailure> | TaskPage | CleoFailure;
  task?: (input: TaskDetailRequest) => Promise<TaskDetail | CleoFailure> | TaskDetail | CleoFailure;
};

/** A panel state over plain variables, with every worker request recorded. */
function panel(answers: Answers, saved: Record<string, unknown> = {}) {
  const asked: { tasks: TaskListRequest[]; task: TaskDetailRequest[]; workspaces: number } = {
    tasks: [],
    task: [],
    workspaces: 0,
  };
  const persisted: Record<string, unknown> = { ...saved };
  const cell: CellFactory = <T>(initial: T, persistKey?: string) => {
    let value =
      persistKey !== undefined && persistKey in persisted ? (persisted[persistKey] as T) : initial;
    return {
      get: () => value,
      set: (next: T) => {
        value = next;
        if (persistKey !== undefined) persisted[persistKey] = next;
      },
    };
  };
  const requests: PanelRequests = {
    workspaces: async () => {
      asked.workspaces += 1;
      return (answers.workspaces ?? (() => listing([option(), OTHER, REMOTE])))();
    },
    tasks: async (input) => {
      asked.tasks.push(input);
      return (answers.tasks ?? (() => page([])))(input);
    },
    task: async (input) => {
      asked.task.push(input);
      return (answers.task ?? ((request) => detailOf(request.taskId)))(input);
    },
  };
  return { state: createPanelState(cell, requests), asked, persisted };
}

describe('workspace choice', () => {
  it('reads nothing until a workspace is chosen, then asks with its id, host and path', async () => {
    const { state, asked, persisted } = panel({ tasks: () => page(['T100']) });
    await state.refresh();
    expect(asked.tasks).toEqual([]);
    expect(state.epics.get()).toBeNull();

    await state.chooseWorkspace('ws-app');
    expect(asked.tasks).toEqual([{ selection: CHOSEN, status: 'active', offset: 0 }]);
    expect(persisted['selection']).toEqual(CHOSEN);
    expect(state.epics.get()?.map((row) => row.id)).toEqual(['T100']);
    expect(state.pending.get()).toBe(0);
  });

  it('ignores a remote or unlisted workspace', async () => {
    const { state, asked } = panel({});
    await state.refresh();
    await state.chooseWorkspace('ws-ssh');
    await state.chooseWorkspace('ws-unknown');
    expect(state.selection.get()).toBeNull();
    expect(asked.tasks).toEqual([]);
  });

  it.each([
    ['moved to another path', option({ path: '/work/moved' })],
    ['moved to another host', option({ hostId: 'ssh:build' })],
    ['now blocked', option({ blocked: 'duplicate-id' })],
    ['gone', OTHER],
  ])('drops a saved choice that is %s before any read', async (_case, listed) => {
    const { state, asked, persisted } = panel(
      { workspaces: () => listing([listed]), tasks: () => page(['T100']) },
      { selection: CHOSEN, task: 'T100' },
    );
    await state.refresh();
    expect(asked.tasks).toEqual([]);
    expect(asked.task).toEqual([]);
    expect(persisted['selection']).toBeNull();
    expect(persisted['task']).toBeNull();
    expect(state.notice.get()).toMatch(/no longer available/);
  });

  it('drops the answer of the workspace that was left', async () => {
    const slow = deferred<TaskPage>();
    const { state } = panel({
      tasks: (input) => (input.selection.id === 'ws-app' ? slow.promise : page(['T200'])),
    });
    await state.refresh();
    const first = state.chooseWorkspace('ws-app');
    await state.chooseWorkspace('ws-other');
    slow.resolve(page(['T100']));
    await first;
    expect(state.selection.get()?.id).toBe('ws-other');
    expect(state.epics.get()?.map((row) => row.id)).toEqual(['T200']);
    expect(state.pending.get()).toBe(0);
  });
});

describe('task tree', () => {
  it('keeps what was loaded when a later read fails', async () => {
    let fail = false;
    const { state } = panel(
      { tasks: () => (fail ? failed('timeout') : page(['T100'])) },
      { selection: CHOSEN },
    );
    await state.refresh();
    fail = true;
    await state.refresh();
    expect(state.taskFailure.get()).toEqual(failed('timeout'));
    expect(state.epics.get()?.map((row) => row.id)).toEqual(['T100']);
  });

  it('turns a rejected worker request into a failure value', async () => {
    const { state } = panel(
      {
        tasks: () =>
          Promise.reject(Object.assign(new Error('worker took too long'), { code: 'timeout' })),
        workspaces: () => listing([option()]),
      },
      { selection: CHOSEN },
    );
    await state.refresh();
    expect(state.taskFailure.get()).toEqual({
      ok: false,
      code: 'timeout',
      message: 'worker took too long',
    });
    expect(state.pending.get()).toBe(0);
  });

  it('loads further pages on request and stops at the last one', async () => {
    const { state, asked } = panel(
      {
        tasks: (input) =>
          input.offset === 2
            ? page(['T300'], { matched: 3, offset: 2 })
            : page(['T100', 'T200'], { matched: 3, truncated: true }),
      },
      { selection: CHOSEN },
    );
    await state.refresh();
    expect(state.epicPage.get()).toEqual({ matched: 3, truncated: true });
    await state.loadMore();
    expect(asked.tasks.at(-1)?.offset).toBe(2);
    expect(state.epics.get()?.map((row) => row.id)).toEqual(['T100', 'T200', 'T300']);
    expect(state.epicPage.get()).toEqual({ matched: 3, truncated: false });
  });

  it('loads a branch once when it is opened', async () => {
    const { state, asked } = panel(
      { tasks: (input) => (input.parentId ? page(['T101']) : page(['T100'])) },
      { selection: CHOSEN },
    );
    await state.refresh();
    await state.toggle({ key: 'T100', expanded: true });
    await state.toggle({ key: 'T100', expanded: false });
    await state.toggle({ key: 'T100', expanded: true });
    expect(asked.tasks.filter((input) => input.parentId === 'T100')).toHaveLength(1);
    expect(state.children.get()['T100']?.tasks.map((row) => row.id)).toEqual(['T101']);
    expect(state.expanded.get()).toEqual(['T100']);
  });

  it('reloads open branches and the open task on refresh', async () => {
    const { state, asked } = panel(
      { tasks: (input) => (input.parentId ? page(['T101']) : page(['T100'])) },
      { selection: CHOSEN },
    );
    await state.refresh();
    await state.toggle({ key: 'T100', expanded: true });
    await state.selectTask({ key: 'T100>T101' });
    asked.tasks.length = 0;
    asked.task.length = 0;
    await state.refresh();
    expect(asked.tasks.map((input) => input.parentId ?? 'epics')).toEqual(['epics', 'T100']);
    expect(asked.task).toEqual([{ selection: CHOSEN, taskId: 'T101' }]);
  });

  it('forgets loaded tasks when the status filter changes', async () => {
    const { state, asked, persisted } = panel(
      { tasks: () => page(['T100']) },
      { selection: CHOSEN },
    );
    await state.refresh();
    await state.selectTask({ key: 'T100' });
    await state.chooseStatus('done');
    expect(persisted['status']).toBe('done');
    expect(asked.tasks.at(-1)).toEqual({ selection: CHOSEN, status: 'done', offset: 0 });
    expect(state.detail.get()).toBeNull();
    expect(state.selectedKey.get()).toBeNull();
    await state.chooseStatus('not-a-status');
    expect(persisted['status']).toBe('done');
  });
});

describe('task detail', () => {
  it('shows the task that was selected last, whatever order the answers arrive in', async () => {
    const slow = deferred<TaskDetail>();
    const { state } = panel(
      { task: (input) => (input.taskId === 'T1' ? slow.promise : detailOf(input.taskId)) },
      { selection: CHOSEN },
    );
    await state.refresh();
    const first = state.selectTask({ key: 'T1' });
    await state.selectTask({ key: 'T2' });
    expect(state.detail.get()?.task.id).toBe('T2');
    // The answer for T1 arrives after T2 is on screen: it must not replace it.
    slow.resolve(detailOf('T1', 4));
    await first;
    expect(state.selectedKey.get()).toBe('T2');
    expect(state.detail.get()?.task.id).toBe('T2');
    expect(state.parents.get()).toEqual([]);
    expect(state.pending.get()).toBe(0);
  });

  it('marks a task with children as expandable once its detail says so', async () => {
    const { state } = panel({ task: (input) => detailOf(input.taskId, 3) }, { selection: CHOSEN });
    await state.refresh();
    await state.selectTask({ key: 'T100>T101' });
    expect(state.parents.get()).toEqual(['T101']);
  });

  it('keeps the open task between panel runs', async () => {
    const { state, asked, persisted } = panel({}, { selection: CHOSEN });
    await state.refresh();
    await state.selectTask({ key: 'T100>T101' });
    expect(persisted['task']).toBe('T100>T101');
    const reopened = panel({ tasks: () => page(['T100']) }, persisted);
    await reopened.state.refresh();
    expect(reopened.asked.task).toEqual([{ selection: CHOSEN, taskId: 'T101' }]);
    expect(asked.task).toHaveLength(1);
  });

  it('reports a failed detail read without touching the tree', async () => {
    const { state } = panel(
      { tasks: () => page(['T100']), task: () => failed('cli-error') },
      { selection: CHOSEN },
    );
    await state.refresh();
    await state.selectTask({ key: 'T100' });
    expect(state.detailFailure.get()).toEqual(failed('cli-error'));
    expect(state.taskFailure.get()).toBeNull();
    expect(state.epics.get()).toHaveLength(1);
  });
});

describe('cancel', () => {
  it('counts a read in flight and drops its answer once cancelled', async () => {
    const slow = deferred<TaskPage>();
    let hold = false;
    const { state } = panel(
      { tasks: () => (hold ? slow.promise : page(['T100'])) },
      { selection: CHOSEN },
    );
    await state.refresh();
    hold = true;
    const refreshing = state.refresh();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.pending.get()).toBe(1);

    state.cancel();
    slow.resolve(page(['T999']));
    await refreshing;
    expect(state.epics.get()?.map((row) => row.id)).toEqual(['T100']);
    expect(state.taskFailure.get()).toBeNull();
    expect(state.notice.get()).toMatch(/Read cancelled/);
    expect(state.pending.get()).toBe(0);
  });

  it('stops a reload between reads', async () => {
    const slow = deferred<TaskPage>();
    let hold = false;
    const { state, asked } = panel(
      {
        tasks: (input) => {
          if (input.parentId) return page(['T101']);
          return hold ? slow.promise : page(['T100']);
        },
      },
      { selection: CHOSEN },
    );
    await state.refresh();
    await state.toggle({ key: 'T100', expanded: true });
    await state.selectTask({ key: 'T100' });
    asked.tasks.length = 0;
    asked.task.length = 0;
    hold = true;
    const refreshing = state.refresh();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    state.dispose();
    slow.resolve(page(['T100']));
    await refreshing;
    expect(asked.tasks.map((input) => input.parentId ?? 'epics')).toEqual(['epics']);
    expect(asked.task).toEqual([]);
  });
});
