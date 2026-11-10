/**
 * CLEO Tasks panel of the Orca plugin (T14462): a read-only view of one local
 * workspace's epics, tasks, acceptance criteria, evidence gates and worker claim.
 *
 * This file only draws. What is read when, and which answer may still be drawn,
 * is decided in `panel-state.ts`; here its cells become Orca atoms and its
 * requests become `plugin.request` to the plugin worker, which runs the bounded
 * `cleo` reads. Orca loads this file as written: no build step.
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
} from 'orca';
import { createPanelState, KEY_SEPARATOR, STATUS_OPTIONS } from './panel-state.ts';
import type {
  CleoFailure,
  CleoFailureCode,
  TaskDetail,
  TaskRow,
  WorkspaceList,
  WorkspaceOption,
  WorkspaceSelection,
} from './protocol.ts';

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

/** Backs one piece of panel state with an Orca atom; a `persistKey` keeps it between runs. */
function atomCell<T>(initial: T, persistKey?: string) {
  const store =
    persistKey === undefined ? atom(initial) : atom(persistKey, initial, { persist: 'plugin' });
  return { get: () => read(store), set: (value: T) => set(store, value) };
}

/** The panel's state and actions, bound to Orca atoms and to the plugin worker. */
const state = createPanelState(atomCell, {
  workspaces: (signal) => plugin.request('cleo.workspaces', undefined, { signal }),
  tasks: (input, signal) => plugin.request('cleo.tasks', input, { signal }),
  task: (input, signal) => plugin.request('cleo.task', input, { signal }),
});

/**
 * Runs once before the first render: reloads on the refresh command and loads
 * the first view. The returned cleanup stops the reads in flight when the
 * panel closes.
 *
 * @param ctx - Orca's panel context.
 */
export function setup(ctx: PanelContext): () => void {
  ctx.subscriptions.push(plugin.on('cleo.refresh', () => void state.refresh()));
  void state.refresh();
  return state.dispose;
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
  const page = state.children.get()[row.id];
  if (page === undefined) {
    const expandable =
      row.type === 'epic' || row.type === 'saga' || state.parents.get().includes(row.id);
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
        onChange={(id) => void state.chooseWorkspace(id)}
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
  const page = state.epicPage.get();
  const filter = state.statusFilter.get();
  return (
    <Stack gap="sm">
      <Select
        label="Epic status"
        value={filter}
        options={STATUS_OPTIONS}
        onChange={(value) => void state.chooseStatus(value)}
      />
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
          expanded={state.expanded.get()}
          selected={state.selectedKey.get() ?? undefined}
          maxHeight="lg"
          onToggle={(item) => void state.toggle(item)}
          onSelect={(item) => void state.selectTask(item)}
        />
      ) : null}
      {rows !== null && page?.truncated ? (
        <Callout tone="warning" title="Epic list truncated" icon="warning">
          <Text>{`Showing ${rows.length} of ${page.matched} epics.`}</Text>
          <Button variant="outline" size="sm" onPress={() => void state.loadMore()}>
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

/**
 * The CLEO Tasks panel: toolbar, workspace picker, epic and task tree, and the
 * selected task's acceptance criteria, evidence gates and worker claim.
 */
export default function Panel() {
  const loading = state.pending.get() > 0;
  const list = state.workspaceList.get();
  const listFailure = state.workspaceFailure.get();
  const chosen = state.selection.get();
  const message = state.notice.get();
  const shown = state.detail.get();
  const shownFailure = state.detailFailure.get();
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>CLEO Tasks</Heading>
        <Row gap="xs" align="center">
          {loading ? <Spinner label="Reading CLEO" /> : null}
          <Button variant="ghost" size="sm" icon="stop" disabled={!loading} onPress={state.cancel}>
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon="refresh"
            disabled={loading}
            onPress={() => void state.refresh()}
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
      {chosen ? taskSection(state.epics.get(), state.taskFailure.get()) : null}
      {shownFailure ? failureCallout(shownFailure, shown !== null) : null}
      {shown ? detailSection(shown) : null}
    </Stack>
  );
}
