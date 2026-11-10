/**
 * State and behaviour of the CLEO Tasks panel, without Orca (T14462).
 *
 * `panel.tsx` draws what this module holds and binds it to Orca: cells become
 * atoms, requests become `plugin.request`. Keeping every decision here (what
 * is read when, which answer may still be drawn, what a cancel drops) lets the
 * vitest suite in `packages/adapters` prove it in CI, where Orca's own test
 * kit does not exist.
 *
 * Three values survive a panel run: the workspace choice, the status filter
 * and the open task. Everything else is the last answer, held in memory.
 */

import type {
  CleoFailure,
  TaskDetail,
  TaskDetailRequest,
  TaskListRequest,
  TaskPage,
  TaskRow,
  TaskStatusFilter,
  WorkspaceList,
  WorkspaceSelection,
} from './protocol.ts';

/** One piece of panel state. `panel.tsx` backs it with an Orca atom. */
export type Cell<T> = {
  get(): T;
  set(value: T): void;
};

/** Makes a cell; a `persistKey` asks the host to keep its value between panel runs. */
export type CellFactory = <T>(initial: T, persistKey?: string) => Cell<T>;

/** The worker requests the panel makes. Each may reject, as `plugin.request` does. */
export type PanelRequests = {
  workspaces(signal: AbortSignal): Promise<WorkspaceList | CleoFailure>;
  tasks(input: TaskListRequest, signal: AbortSignal): Promise<TaskPage | CleoFailure>;
  task(input: TaskDetailRequest, signal: AbortSignal): Promise<TaskDetail | CleoFailure>;
};

/** Loaded children of one task, as the last `cleo list --parent` page gave them. */
export type ChildPage = {
  tasks: TaskRow[];
  matched: number;
  truncated: boolean;
};

/** The panel's cells and actions, as {@link createPanelState} returns them. */
export type PanelState = ReturnType<typeof createPanelState>;

/** Epic status filter choices, in picker order. */
export const STATUS_OPTIONS: readonly { value: TaskStatusFilter; label: string }[] = [
  { value: 'active', label: 'Active epics' },
  { value: 'pending', label: 'Pending epics' },
  { value: 'blocked', label: 'Blocked epics' },
  { value: 'done', label: 'Done epics' },
  { value: 'all', label: 'All epics' },
];

/** Separates the task ids in a tree key, so one task may sit under two parents. */
export const KEY_SEPARATOR = '>';

/** What a read that was stopped, or whose answer came too late, resolves to. */
const CANCELLED: CleoFailure = { ok: false, code: 'cancelled', message: 'The read was cancelled.' };

/**
 * The task id a tree key ends with.
 *
 * @param key - A tree key: task ids from the root down, joined by {@link KEY_SEPARATOR}.
 */
export function taskIdOf(key: string): string {
  return key.slice(key.lastIndexOf(KEY_SEPARATOR) + 1);
}

/**
 * Builds the panel's state and the actions that change it.
 *
 * @param cell - Makes each piece of state.
 * @param requests - Asks the plugin worker.
 */
export function createPanelState(cell: CellFactory, requests: PanelRequests) {
  const selection = cell<WorkspaceSelection | null>(null, 'selection');
  const statusFilter = cell<TaskStatusFilter>('active', 'status');
  const selectedKey = cell<string | null>(null, 'task');

  const workspaceList = cell<WorkspaceList | null>(null);
  const workspaceFailure = cell<CleoFailure | null>(null);
  const epics = cell<TaskRow[] | null>(null);
  const epicPage = cell<{ matched: number; truncated: boolean } | null>(null);
  const taskFailure = cell<CleoFailure | null>(null);
  const children = cell<Record<string, ChildPage>>({});
  const parents = cell<string[]>([]);
  const expanded = cell<string[]>([]);
  const detail = cell<TaskDetail | null>(null);
  const detailFailure = cell<CleoFailure | null>(null);
  const pending = cell(0);
  const notice = cell<string | null>(null);

  /** Covers every read of the current workspace, filter and refresh. */
  let generation = new AbortController();
  /** Covers the one detail read in flight; a newer selection replaces it. */
  let detailRead = new AbortController();

  /** Stops every read in flight. Their answers are dropped, never drawn. */
  function abortReads(): void {
    generation.abort();
    detailRead.abort();
    generation = new AbortController();
    detailRead = new AbortController();
  }

  /**
   * Runs one worker request under a signal and counts it as in flight. A
   * rejection becomes a failure value; an answer that arrives after its signal
   * aborted is `cancelled`, so callers leave the drawn state alone.
   */
  async function ask<T extends { ok: true }>(
    signal: AbortSignal,
    request: (signal: AbortSignal) => Promise<T | CleoFailure>,
  ): Promise<T | CleoFailure> {
    pending.set(pending.get() + 1);
    try {
      const answer = await request(signal);
      return signal.aborted ? CANCELLED : answer;
    } catch (error) {
      if (signal.aborted) return CANCELLED;
      const timedOut = error instanceof Error && 'code' in error && error.code === 'timeout';
      return {
        ok: false,
        code: timedOut ? 'timeout' : 'host-error',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      pending.set(pending.get() - 1);
    }
  }

  /** Loads the detail of the task a tree key names. The newest call wins. */
  async function loadDetail(key: string): Promise<void> {
    const chosen = selection.get();
    if (chosen === null) return;
    detailRead.abort();
    detailRead = new AbortController();
    const taskId = taskIdOf(key);
    const answer = await ask(detailRead.signal, (signal) =>
      requests.task({ selection: chosen, taskId }, signal),
    );
    if (!answer.ok) {
      if (answer.code !== 'cancelled') detailFailure.set(answer);
      return;
    }
    detailFailure.set(null);
    detail.set(answer);
    // CLEO's relation count is how a plain task is known to have children to expand.
    if (answer.task.children > 0 && !parents.get().includes(taskId)) {
      parents.set([...parents.get(), taskId]);
    }
  }

  /** Loads the direct children of one task into the tree. */
  async function loadChildren(parentId: string): Promise<void> {
    const chosen = selection.get();
    if (chosen === null) return;
    const answer = await ask(generation.signal, (signal) =>
      requests.tasks({ selection: chosen, parentId }, signal),
    );
    if (!answer.ok) {
      if (answer.code !== 'cancelled') taskFailure.set(answer);
      return;
    }
    taskFailure.set(null);
    children.set({
      ...children.get(),
      [parentId]: { tasks: answer.tasks, matched: answer.matched, truncated: answer.truncated },
    });
  }

  /** Loads one page of epics; `offset` above 0 appends to the rows already held. */
  async function loadEpics(offset: number): Promise<boolean> {
    const chosen = selection.get();
    if (chosen === null) return false;
    const answer = await ask(generation.signal, (signal) =>
      requests.tasks({ selection: chosen, status: statusFilter.get(), offset }, signal),
    );
    if (!answer.ok) {
      if (answer.code !== 'cancelled') taskFailure.set(answer);
      return false;
    }
    taskFailure.set(null);
    const held = epics.get();
    epics.set(offset > 0 && held ? [...held, ...answer.tasks] : answer.tasks);
    epicPage.set({ matched: answer.matched, truncated: answer.truncated });
    return true;
  }

  /** Reloads the tree of the chosen workspace: epics, open branches, then the open task. */
  async function loadTasks(): Promise<void> {
    // A cancel or a new choice replaces the generation: this run then stops between reads.
    const { signal } = generation;
    if (!(await loadEpics(0))) return;
    for (const key of expanded.get()) {
      if (signal.aborted) return;
      await loadChildren(taskIdOf(key));
    }
    const open = selectedKey.get();
    if (open !== null && !signal.aborted) await loadDetail(open);
  }

  /** Forgets every loaded task. Used when the workspace or the filter changes. */
  function clearTasks(): void {
    epics.set(null);
    epicPage.set(null);
    taskFailure.set(null);
    children.set({});
    parents.set([]);
    expanded.set([]);
    selectedKey.set(null);
    detail.set(null);
    detailFailure.set(null);
  }

  /**
   * Reloads everything: the workspace list first, then the tasks of the chosen
   * workspace. A stored choice Orca no longer lists the same way is dropped
   * with a notice, so a stale choice can never read another folder.
   */
  async function refresh(): Promise<void> {
    abortReads();
    notice.set(null);
    const answer = await ask(generation.signal, (signal) => requests.workspaces(signal));
    if (!answer.ok) {
      if (answer.code !== 'cancelled') workspaceFailure.set(answer);
      return;
    }
    workspaceFailure.set(null);
    workspaceList.set(answer);
    const chosen = selection.get();
    if (chosen === null) return;
    const listed = answer.workspaces.find((workspace) => workspace.id === chosen.id);
    const same = listed?.hostId === chosen.hostId && listed.path === chosen.path;
    if (!listed || !same || listed.blocked !== null) {
      selection.set(null);
      clearTasks();
      notice.set('The saved workspace is no longer available as chosen. Choose a workspace.');
      return;
    }
    await loadTasks();
  }

  /** The person stopped the reads in flight; what was drawn before stays. */
  function cancel(): void {
    abortReads();
    notice.set('Read cancelled. Refresh to load again.');
  }

  /** The person picked a workspace. A blocked or unlisted one changes nothing. */
  function chooseWorkspace(id: string): Promise<void> {
    const option = workspaceList.get()?.workspaces.find((workspace) => workspace.id === id);
    if (!option || option.blocked !== null) return Promise.resolve();
    abortReads();
    notice.set(null);
    selection.set({ id: option.id, hostId: option.hostId, path: option.path });
    clearTasks();
    return loadTasks();
  }

  /** The person changed the epic status filter. */
  function chooseStatus(value: string): Promise<void> {
    const option = STATUS_OPTIONS.find((status) => status.value === value);
    if (!option) return Promise.resolve();
    abortReads();
    notice.set(null);
    statusFilter.set(option.value);
    clearTasks();
    return loadTasks();
  }

  /** A tree branch was opened or closed; an opened one loads its children once. */
  function toggle(item: { key: string; expanded: boolean }): Promise<void> {
    const others = expanded.get().filter((key) => key !== item.key);
    expanded.set(item.expanded ? [...others, item.key] : others);
    const taskId = taskIdOf(item.key);
    if (!item.expanded || children.get()[taskId] !== undefined) return Promise.resolve();
    return loadChildren(taskId);
  }

  /** A tree row was selected: show that task, and only that task. */
  function selectTask(item: { key: string }): Promise<void> {
    selectedKey.set(item.key);
    detail.set(null);
    detailFailure.set(null);
    return loadDetail(item.key);
  }

  /**
   * Loads the page after the epics already held. Nothing calls it on scroll or on a timer:
   * the panel's "Load more" button is its only caller, and the "Showing N of M" text beside
   * that button changes when the page arrives.
   */
  async function loadMore(): Promise<void> {
    const held = epics.get();
    if (held !== null) await loadEpics(held.length);
  }

  return {
    selection,
    statusFilter,
    selectedKey,
    workspaceList,
    workspaceFailure,
    epics,
    epicPage,
    taskFailure,
    children,
    parents,
    expanded,
    detail,
    detailFailure,
    pending,
    notice,
    refresh,
    cancel,
    chooseWorkspace,
    chooseStatus,
    toggle,
    selectTask,
    loadMore,
    /** Stops every read in flight; called when the panel closes. */
    dispose: abortReads,
  };
}
