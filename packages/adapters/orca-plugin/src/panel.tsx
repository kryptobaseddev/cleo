/**
 * CLEO Tasks panel of the Orca plugin (T14462): a read-only view of one local
 * workspace's epics, tasks, acceptance criteria, evidence gates and worker claim.
 *
 * The panel never touches CLEO itself. It asks the plugin worker, which runs
 * bounded `cleo` reads, and it keeps only the workspace choice and the status
 * filter between runs; everything it draws is the last answer held in memory,
 * never a second task store. Orca loads this file as written: no build step.
 */

import {
  atom,
  Badge,
  Button,
  Callout,
  EmptyState,
  Heading,
  KeyValue,
  List,
  ListItem,
  type PanelContext,
  plugin,
  RelativeTime,
  Row,
  read,
  Select,
  Spinner,
  Stack,
  set,
  Text,
  Tree,
  type TreeItem,
  update,
} from 'orca';
import type {
  CleoFailure,
  CleoFailureCode,
  TaskDetail,
  TaskPage,
  TaskRow,
  TaskStatusFilter,
  WorkspaceList,
  WorkspaceOption,
  WorkspaceSelection,
} from './protocol.ts';

/** Loaded children of one task, as the last `cleo list --parent` page gave them. */
type ChildPage = { tasks: TaskRow[]; matched: number; truncated: boolean };

/** Heading shown for each failure code. */
const FAILURE_TITLES: Record<CleoFailureCode, string> = {
  'cleo-missing': 'CLEO CLI not found',
  'not-a-project': 'Not a CLEO project',
  timeout: 'CLEO did not answer in time',
  cancelled: 'Read cancelled',
  'malformed-envelope': 'CLEO answered in an unexpected format',
  'output-too-large': 'Answer too large',
  'cli-error': 'CLEO reported an error',
  'workspace-unavailable': 'Workspace not available',
  'workspace-remote': 'Remote workspace',
  'workspace-changed': 'Workspace changed',
  'invalid-request': 'Request refused',
  'host-error': 'Orca could not complete the request',
};

/** Epic status filter choices, in picker order. */
const STATUS_OPTIONS: readonly { value: TaskStatusFilter; label: string }[] = [
  { value: 'active', label: 'Active epics' },
  { value: 'pending', label: 'Pending epics' },
  { value: 'blocked', label: 'Blocked epics' },
  { value: 'done', label: 'Done epics' },
  { value: 'all', label: 'All epics' },
];

/** Separates the task ids in a tree key, so one task may sit under two parents. */
const KEY_SEPARATOR = '>';

// Kept between runs: the explicit workspace choice and the filter. Nothing else is stored.
const selection = atom<WorkspaceSelection | null>('selection', null, { persist: 'plugin' });
const statusFilter = atom<TaskStatusFilter>('status', 'active', { persist: 'plugin' });

// The last answers, held in memory for this panel run only.
const workspaceList = atom<WorkspaceList | null>(null);
const workspaceFailure = atom<CleoFailure | null>(null);
const epics = atom<TaskRow[] | null>(null);
const epicPage = atom<{ matched: number; truncated: boolean } | null>(null);
const taskFailure = atom<CleoFailure | null>(null);
const children = atom<Record<string, ChildPage>>({});
const parents = atom<string[]>([]);
const expanded = atom<string[]>([]);
const selectedKey = atom<string | null>(null);
const detail = atom<TaskDetail | null>(null);
const detailFailure = atom<CleoFailure | null>(null);
const pending = atom(0);
const notice = atom<string | null>(null);

/** Aborts the reads in flight; replaced on every cancel. */
let controller = new AbortController();

/** The task id a tree key ends with. */
function taskIdOf(key: string): string {
  return key.slice(key.lastIndexOf(KEY_SEPARATOR) + 1);
}

/** Stops every read in flight. Their answers are dropped, never drawn. */
function abortReads(): void {
  controller.abort();
  controller = new AbortController();
}

/**
 * Runs one worker request under the current abort signal and counts it as in
 * flight. A rejection becomes a failure value; an answer that arrives after a
 * cancel is reported as `cancelled` so callers leave the drawn state alone.
 */
async function ask<T extends { ok: true }>(
  request: (signal: AbortSignal) => Promise<T | CleoFailure>,
): Promise<T | CleoFailure> {
  const { signal } = controller;
  const cancelled: CleoFailure = {
    ok: false,
    code: 'cancelled',
    message: 'The read was cancelled.',
  };
  update(pending, (count) => count + 1);
  try {
    const answer = await request(signal);
    return signal.aborted ? cancelled : answer;
  } catch (error) {
    if (signal.aborted) return cancelled;
    const timedOut = error instanceof Error && 'code' in error && error.code === 'timeout';
    return {
      ok: false,
      code: timedOut ? 'timeout' : 'host-error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    update(pending, (count) => count - 1);
  }
}

/** Loads one task's detail into the detail pane. */
async function loadDetail(taskId: string): Promise<void> {
  const chosen = read(selection);
  if (chosen === null) return;
  const answer = await ask((signal) =>
    plugin.request('cleo.task', { selection: chosen, taskId }, { signal }),
  );
  if (!answer.ok) {
    if (answer.code !== 'cancelled') set(detailFailure, answer);
    return;
  }
  set(detailFailure, null);
  set(detail, answer);
  // CLEO's relation count is how a plain task is known to have children to expand.
  if (answer.task.children > 0) {
    update(parents, (known) => (known.includes(taskId) ? known : [...known, taskId]));
  }
}

/** Loads the direct children of one task into the tree. */
async function loadChildren(parentId: string): Promise<void> {
  const chosen = read(selection);
  if (chosen === null) return;
  const answer = await ask((signal) =>
    plugin.request('cleo.tasks', { selection: chosen, parentId }, { signal }),
  );
  if (!answer.ok) {
    if (answer.code !== 'cancelled') set(taskFailure, answer);
    return;
  }
  set(taskFailure, null);
  update(children, (loaded) => ({ ...loaded, [parentId]: answer }));
}

/** Loads one page of epics; `offset` above 0 appends to the rows already drawn. */
async function loadEpics(offset: number): Promise<TaskPage | CleoFailure | null> {
  const chosen = read(selection);
  if (chosen === null) return null;
  const answer = await ask((signal) =>
    plugin.request(
      'cleo.tasks',
      { selection: chosen, status: read(statusFilter), offset },
      { signal },
    ),
  );
  if (!answer.ok) {
    if (answer.code !== 'cancelled') set(taskFailure, answer);
    return answer;
  }
  set(taskFailure, null);
  update(epics, (rows) => (offset > 0 && rows ? [...rows, ...answer.tasks] : answer.tasks));
  set(epicPage, { matched: answer.matched, truncated: answer.truncated });
  return answer;
}

/** Reloads the tree of the chosen workspace: epics, open branches, then the open task. */
async function loadTasks(): Promise<void> {
  // A cancel or a new choice replaces the controller: this run then stops between reads.
  const { signal } = controller;
  const page = await loadEpics(0);
  if (!page?.ok) return;
  for (const key of read(expanded)) {
    if (signal.aborted) return;
    await loadChildren(taskIdOf(key));
  }
  const open = read(selectedKey);
  if (open !== null && !signal.aborted) await loadDetail(taskIdOf(open));
}

/** Forgets every loaded task. Used when the workspace or the filter changes. */
function clearTasks(): void {
  set(epics, null);
  set(epicPage, null);
  set(taskFailure, null);
  set(children, {});
  set(parents, []);
  set(expanded, []);
  set(selectedKey, null);
  set(detail, null);
  set(detailFailure, null);
}

/**
 * Reloads everything: the workspace list first, then the tasks of the chosen
 * workspace. A stored choice Orca no longer lists the same way is dropped with
 * a notice, so a stale choice can never read another folder.
 */
async function refresh(): Promise<void> {
  abortReads();
  set(notice, null);
  const answer = await ask((signal) => plugin.request('cleo.workspaces', undefined, { signal }));
  if (!answer.ok) {
    if (answer.code !== 'cancelled') set(workspaceFailure, answer);
    return;
  }
  set(workspaceFailure, null);
  set(workspaceList, answer);
  const chosen = read(selection);
  if (chosen === null) return;
  const listed = answer.workspaces.find((workspace) => workspace.id === chosen.id);
  const same = listed?.hostId === chosen.hostId && listed.path === chosen.path;
  if (!listed || !same || listed.blocked !== null) {
    set(selection, null);
    clearTasks();
    set(notice, 'The saved workspace is no longer available as chosen. Choose a workspace.');
    return;
  }
  await loadTasks();
}

/** The person stopped the reads in flight; what was drawn before stays. */
function cancel(): void {
  abortReads();
  set(notice, 'Read cancelled. Refresh to load again.');
}

/** The person picked a workspace in the picker. */
function chooseWorkspace(id: string): void {
  const option = read(workspaceList)?.workspaces.find((workspace) => workspace.id === id);
  if (!option || option.blocked !== null) return;
  abortReads();
  set(notice, null);
  set(selection, { id: option.id, hostId: option.hostId, path: option.path });
  clearTasks();
  void loadTasks();
}

/** The person changed the epic status filter. */
function chooseStatus(value: string): void {
  const option = STATUS_OPTIONS.find((status) => status.value === value);
  if (!option) return;
  abortReads();
  set(notice, null);
  set(statusFilter, option.value);
  clearTasks();
  void loadTasks();
}

/** A tree branch was opened or closed; an opened one loads its children once. */
function toggle(item: { key: string; expanded: boolean }): void {
  update(expanded, (keys) =>
    item.expanded
      ? [...keys.filter((key) => key !== item.key), item.key]
      : keys.filter((key) => key !== item.key),
  );
  const taskId = taskIdOf(item.key);
  if (item.expanded && read(children)[taskId] === undefined) void loadChildren(taskId);
}

/** A tree row was selected: show that task. */
function selectTask(item: { key: string }): void {
  set(selectedKey, item.key);
  set(detail, null);
  set(detailFailure, null);
  void loadDetail(taskIdOf(item.key));
}

/** Runs once before the first render; the returned cleanup runs when the panel closes. */
export function setup(ctx: PanelContext): () => void {
  ctx.subscriptions.push(plugin.on('cleo.refresh', () => void refresh()));
  void refresh();
  return abortReads;
}

/** One task as a tree item, with its loaded children below it. */
function treeItem(row: TaskRow, parentKey: string | null): TreeItem {
  const key = parentKey === null ? row.id : `${parentKey}${KEY_SEPARATOR}${row.id}`;
  const item: TreeItem = {
    key,
    label: `${row.id} ${row.title}`,
    description: `${row.status} · ${row.type}`,
    icon: row.type === 'epic' || row.type === 'saga' ? 'layers' : 'file-text',
  };
  const page = read(children)[row.id];
  if (page === undefined) {
    const expandable = row.type === 'epic' || row.type === 'saga' || read(parents).includes(row.id);
    return { ...item, hasChildren: expandable };
  }
  const items = page.tasks.map((child) => treeItem(child, key));
  if (page.truncated) {
    const hidden = Math.max(page.matched - page.tasks.length, 0);
    items.push({
      key: `${key}${KEY_SEPARATOR}more`,
      label: `${hidden} more children not shown`,
      icon: 'more',
      disabled: true,
    });
  }
  return { ...item, children: items };
}

/** A failure, and whether older data is still drawn below it. */
function failureCallout(failed: CleoFailure, stale: boolean) {
  return (
    <Callout tone="danger" title={FAILURE_TITLES[failed.code]} icon="error">
      <Text>{failed.message}</Text>
      {stale ? (
        <Text muted size="xs">
          Showing what was loaded before.
        </Text>
      ) : null}
    </Callout>
  );
}

/** The workspace picker and what is known about the chosen workspace. */
function workspaceSection(list: WorkspaceList | null, chosen: WorkspaceSelection | null) {
  if (list === null) return null;
  if (list.workspaces.length === 0) {
    return (
      <EmptyState
        title="No workspaces"
        description="Orca lists no workspace. Open a project in Orca, then refresh."
        icon="folder"
      />
    );
  }
  const remote = list.workspaces.filter((workspace) => workspace.blocked === 'remote').length;
  const option = (workspace: WorkspaceOption) => ({
    value: workspace.id,
    label: workspace.focused ? `${workspace.label} (focused)` : workspace.label,
    disabled: workspace.blocked !== null,
  });
  return (
    <Stack gap="sm">
      <Select
        label="Workspace"
        placeholder="Choose a workspace"
        value={chosen?.id}
        options={list.workspaces.map(option)}
        onChange={chooseWorkspace}
      />
      {list.truncated ? (
        <Callout tone="warning" title="Workspace list truncated" icon="warning">
          <Text>Orca listed only part of its workspaces. One you expect may be missing here.</Text>
        </Callout>
      ) : null}
      {list.focus.matches > 1 ? (
        <Callout tone="warning" title="Focused workspace is ambiguous" icon="warning">
          <Text>
            {`"${list.focus.name}" matches ${list.focus.matches} workspaces, so none is chosen for you.`}
          </Text>
        </Callout>
      ) : null}
      {remote > 0 ? (
        <Text muted size="xs">
          {`${remote} remote workspace(s) are listed but cannot be chosen: CLEO is only read on this machine.`}
        </Text>
      ) : null}
      {chosen ? (
        <KeyValue
          label="Chosen workspace"
          items={[
            { label: 'Workspace id', value: chosen.id, code: true },
            { label: 'Host', value: chosen.hostId ?? 'this machine' },
            { label: 'Path', value: chosen.path, code: true },
          ]}
        />
      ) : (
        <Text muted>Choose a workspace to read its CLEO tasks.</Text>
      )}
    </Stack>
  );
}

/** The epic and task tree of the chosen workspace. */
function taskSection(rows: TaskRow[] | null, failed: CleoFailure | null) {
  const page = read(epicPage);
  const filter = read(statusFilter);
  return (
    <Stack gap="sm">
      <Select label="Epic status" value={filter} options={STATUS_OPTIONS} onChange={chooseStatus} />
      {failed ? failureCallout(failed, rows !== null) : null}
      {rows !== null && rows.length === 0 ? (
        <EmptyState
          title="No epics"
          description={`This workspace has no epics with status "${filter}". Try another status.`}
          icon="layers"
        />
      ) : null}
      {rows !== null && rows.length > 0 ? (
        <Tree
          label="CLEO epics and tasks"
          items={rows.map((row) => treeItem(row, null))}
          expanded={read(expanded)}
          selected={read(selectedKey) ?? undefined}
          maxHeight="lg"
          onToggle={toggle}
          onSelect={selectTask}
        />
      ) : null}
      {rows !== null && page?.truncated ? (
        <Callout tone="warning" title="Epic list truncated" icon="warning">
          <Text>{`Showing ${rows.length} of ${page.matched} epics.`}</Text>
          <Button variant="outline" size="sm" onPress={() => void loadEpics(rows.length)}>
            Load more
          </Button>
        </Callout>
      ) : null}
    </Stack>
  );
}

/** A timestamp CLEO printed, as a time Orca keeps current; the raw text when unreadable. */
function time(iso: string | null) {
  if (iso === null) return 'unknown';
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : <RelativeTime at={at} />;
}

/** Acceptance criteria, evidence gates and worker claim of the selected task. */
function detailSection(shown: TaskDetail) {
  const { task, claim } = shown;
  return (
    <Stack gap="sm">
      <Heading level={3}>{`${task.id} ${task.title}`}</Heading>
      <KeyValue
        label="Task"
        items={[
          { label: 'Status', value: task.status },
          { label: 'Type', value: task.type },
          { label: 'Priority', value: task.priority },
          { label: 'Size', value: task.size },
          { label: 'Stage', value: task.pipelineStage },
          { label: 'Parent', value: task.parentId },
          { label: 'Children', value: task.children },
          { label: 'Next action', value: shown.nextAction },
        ]}
      />
      {task.description ? <Text>{task.description}</Text> : null}
      <Heading level={3}>Acceptance</Heading>
      {shown.acceptance.length === 0 ? (
        <Text muted>No acceptance criteria recorded.</Text>
      ) : (
        <List label="Acceptance criteria">
          {shown.acceptance.map((criterion) => (
            <ListItem key={criterion.alias} title={criterion.alias} description={criterion.text}>
              {criterion.gates.map((gate) => (
                <Badge key={gate} tone="success">
                  {gate}
                </Badge>
              ))}
            </ListItem>
          ))}
        </List>
      )}
      <Heading level={3}>Evidence</Heading>
      {shown.gates.length === 0 ? (
        <Text muted>No evidence gates recorded.</Text>
      ) : (
        <KeyValue
          label={shown.verificationPassed ? 'Gates (verification passed)' : 'Gates'}
          items={shown.gates.map((gate) => ({
            label: gate.gate,
            value: `${gate.passed ? 'passed' : 'not passed'}${gate.atoms ? ` · ${gate.atoms}` : ''}`,
            tone: gate.passed ? ('success' as const) : ('neutral' as const),
          }))}
        />
      )}
      <Heading level={3}>Worker</Heading>
      {claim === null ? (
        <Text muted>No worker holds this task.</Text>
      ) : (
        <Stack gap="xs">
          <KeyValue
            label="Claim"
            items={[
              { label: 'Agent', value: claim.agentId, code: true },
              { label: 'Session', value: claim.sessionId, code: true },
            ]}
          />
          <Text size="xs" muted>
            Claimed {time(claim.claimedAt)} · lease ends {time(claim.leaseExpiresAt)}
          </Text>
        </Stack>
      )}
    </Stack>
  );
}

export default function Panel() {
  const loading = read(pending) > 0;
  const list = read(workspaceList);
  const listFailure = read(workspaceFailure);
  const chosen = read(selection);
  const message = read(notice);
  const shown = read(detail);
  const shownFailure = read(detailFailure);
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>CLEO Tasks</Heading>
        <Row gap="xs" align="center">
          {loading ? <Spinner label="Reading CLEO" /> : null}
          <Button variant="ghost" size="sm" icon="stop" disabled={!loading} onPress={cancel}>
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon="refresh"
            disabled={loading}
            onPress={() => void refresh()}
          >
            Refresh
          </Button>
        </Row>
      </Row>
      {message ? (
        <Callout tone="neutral" icon="info">
          <Text>{message}</Text>
        </Callout>
      ) : null}
      {listFailure ? failureCallout(listFailure, list !== null) : null}
      {workspaceSection(list, chosen)}
      {chosen ? taskSection(read(epics), read(taskFailure)) : null}
      {shownFailure ? failureCallout(shownFailure, shown !== null) : null}
      {shown ? detailSection(shown) : null}
    </Stack>
  );
}
