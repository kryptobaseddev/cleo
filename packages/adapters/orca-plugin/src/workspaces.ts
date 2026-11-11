/**
 * Workspace selection policy of the CLEO Orca plugin (T14462).
 *
 * Orca lists workspaces on every host it reaches, and its focused-workspace
 * context carries a name and branch but no id or path. A local `cleo`
 * subprocess must therefore never run on a path just because Orca listed it:
 * the person picks one workspace explicitly, and every read re-checks that the
 * id still names the same host and path and that the host is this machine.
 */

import { isAbsolute } from 'node:path';
import { failure, isRecord } from './cleo-cli.ts';
import type { CleoFailure, FocusHint, WorkspaceOption, WorkspaceSelection } from './protocol.ts';

/** One row of Orca's `workspace.list` answer. */
export type HostWorkspace = {
  id: string;
  kind: 'worktree' | 'folder';
  name: string;
  path: string;
  branch: string | null;
  hostId: string | null;
};

/** Orca's `workspace.readContext` answer: the focused workspace, without id or path. */
export type FocusContext = { displayName: string; branch: string } | null;

/**
 * Whether Orca's host id names the machine the plugin worker runs on. Orca
 * reports `local` for its own worktrees and `null` for a folder workspace with
 * no execution host; every other id is an SSH target or a paired server.
 *
 * @param hostId - `hostId` of a `workspace.list` row.
 */
export function isLocalHost(hostId: string | null): boolean {
  return hostId === null || hostId === 'local';
}

/** Whether a listed workspace is the focused one, as far as name and branch can tell. */
function matchesFocus(workspace: HostWorkspace, focus: FocusContext): boolean {
  if (focus === null || workspace.name !== focus.displayName) return false;
  return workspace.branch === null || workspace.branch === focus.branch;
}

/**
 * Turns Orca's workspace rows into picker rows.
 *
 * Remote workspaces stay visible but blocked. An id that names more than one
 * row is collapsed into a single blocked row. A name shared by several rows
 * gets its path in the label. The focus only marks a row when exactly one row
 * matches it; it never selects one.
 *
 * @param workspaces - Rows of `workspace.list`.
 * @param focus - Answer of `workspace.readContext`.
 */
export function buildWorkspaceOptions(
  workspaces: readonly HostWorkspace[],
  focus: FocusContext,
): { workspaces: WorkspaceOption[]; focus: FocusHint } {
  const idCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  for (const workspace of workspaces) {
    idCounts.set(workspace.id, (idCounts.get(workspace.id) ?? 0) + 1);
    nameCounts.set(workspace.name, (nameCounts.get(workspace.name) ?? 0) + 1);
  }
  const focusMatches = workspaces.filter((workspace) => matchesFocus(workspace, focus));
  const seen = new Set<string>();
  const options: WorkspaceOption[] = [];
  for (const workspace of workspaces) {
    if (seen.has(workspace.id)) continue;
    seen.add(workspace.id);
    const duplicateId = (idCounts.get(workspace.id) ?? 0) > 1;
    const remote = !isLocalHost(workspace.hostId);
    const sharedName = (nameCounts.get(workspace.name) ?? 0) > 1;
    let label = sharedName ? `${workspace.name} — ${workspace.path}` : workspace.name;
    if (remote) label += ` (remote: ${workspace.hostId})`;
    if (duplicateId) label += ' (ambiguous id)';
    options.push({
      id: workspace.id,
      hostId: workspace.hostId,
      path: workspace.path,
      name: workspace.name,
      branch: workspace.branch,
      label,
      blocked: duplicateId ? 'duplicate-id' : remote ? 'remote' : null,
      focused: focusMatches.length === 1 && focusMatches[0] === workspace,
    });
  }
  return {
    workspaces: options,
    focus: { name: focus?.displayName ?? null, matches: focusMatches.length },
  };
}

/**
 * Narrows a panel-supplied value to a workspace selection.
 *
 * @param value - `selection` field of a panel request.
 */
export function isWorkspaceSelection(value: unknown): value is WorkspaceSelection {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['path'] === 'string' &&
    (value['hostId'] === null || typeof value['hostId'] === 'string')
  );
}

/**
 * Resolves a selection to the local directory a read may run in.
 *
 * The path comes from Orca's current list, never from the panel: the selection
 * only has to still agree with it. A selection whose id is gone, names several
 * rows, moved to another host or path, or lives on a remote host is refused.
 *
 * @param workspaces - Fresh rows of `workspace.list`.
 * @param selection - What the person chose, as the panel stored it.
 */
export function resolveSelection(
  workspaces: readonly HostWorkspace[],
  selection: unknown,
): { ok: true; path: string } | CleoFailure {
  if (!isWorkspaceSelection(selection)) {
    return failure('invalid-request', 'The request names no workspace id, host and path.');
  }
  const rows = workspaces.filter((workspace) => workspace.id === selection.id);
  const [row] = rows;
  if (row === undefined) {
    return failure('workspace-unavailable', 'Orca no longer lists the chosen workspace.');
  }
  if (rows.length > 1) {
    return failure('workspace-changed', 'The chosen workspace id now names several workspaces.');
  }
  if (row.hostId !== selection.hostId || row.path !== selection.path) {
    return failure(
      'workspace-changed',
      'The chosen workspace now points at another host or path. Choose it again.',
    );
  }
  if (!isLocalHost(row.hostId)) {
    return failure(
      'workspace-remote',
      `This workspace lives on the remote host "${row.hostId}". CLEO is only read on this machine.`,
    );
  }
  if (!isAbsolute(row.path)) {
    return failure('workspace-unavailable', 'The chosen workspace has no absolute local path.');
  }
  return { ok: true, path: row.path };
}
