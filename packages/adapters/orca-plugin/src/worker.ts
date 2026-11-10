/**
 * Worker of the CLEO Orca plugin (T14462): answers the task panel with bounded
 * `cleo` reads and serves the refresh palette command.
 *
 * It is read-only by construction. It asks Orca only for the workspace list
 * and the focused-workspace context (`workspace:read`), runs only the two argv
 * shapes `cleo-cli.ts` builds, and keeps no state: a save or an idle stop
 * loses nothing. Orca loads this file as written; there is no build step.
 */

import type { OrcaWorkerApi } from 'orca/worker';
import { type CleoRunner, failure, isRecord, listArgv, runCleo, showArgv } from './cleo-cli.ts';
import type { CleoFailure, WorkspaceList } from './protocol.ts';
import { toTaskDetail, toTaskPage } from './views.ts';
import { buildWorkspaceOptions, type HostWorkspace, resolveSelection } from './workspaces.ts';

/** Orca's current workspaces, or why they could not be listed. */
async function listWorkspaces(
  orca: OrcaWorkerApi,
  signal: AbortSignal,
): Promise<{ ok: true; workspaces: HostWorkspace[]; truncated: boolean } | CleoFailure> {
  try {
    const answer = await orca.host.call('workspace.list', undefined, { signal });
    return { ok: true, workspaces: answer.workspaces, truncated: answer.truncated };
  } catch (error) {
    if (signal.aborted) return failure('cancelled', 'The CLEO read was cancelled.');
    return failure('host-error', `Orca could not list its workspaces: ${String(error)}`);
  }
}

/** The local directory a request's selection resolves to right now. */
async function resolveDirectory(orca: OrcaWorkerApi, selection: unknown, signal: AbortSignal) {
  const listed = await listWorkspaces(orca, signal);
  return listed.ok ? resolveSelection(listed.workspaces, selection) : listed;
}

/**
 * Registers the panel handlers and the refresh command on a given CLEO runner.
 * Tests pass a stand-in runner; Orca gets the real one through {@link activate}.
 *
 * @param orca - The worker API Orca passes to `activate`.
 * @param run - Runs one bounded `cleo` read.
 */
export function activateWith(orca: OrcaWorkerApi, run: CleoRunner): void {
  orca.panels.handle('cleo.workspaces', async (_input, { signal }) => {
    const listed = await listWorkspaces(orca, signal);
    if (!listed.ok) return listed;
    // The focus is a hint for the picker; a failed read of it only drops the hint.
    const focus = await orca.host
      .call('workspace.readContext', undefined, { signal })
      .catch(() => null);
    const answer: WorkspaceList = {
      ok: true,
      truncated: listed.truncated,
      ...buildWorkspaceOptions(listed.workspaces, focus),
    };
    return answer;
  });

  orca.panels.handle('cleo.tasks', async (input, { signal }) => {
    const request: Record<string, unknown> = isRecord(input) ? input : {};
    const argv = listArgv(request);
    if (argv === null) return failure('invalid-request', 'The task list request is not valid.');
    const directory = await resolveDirectory(orca, request['selection'], signal);
    if (!directory.ok) return directory;
    const answer = await run(argv, { cwd: directory.path, signal });
    const offset = typeof request['offset'] === 'number' ? request['offset'] : 0;
    return answer.ok ? toTaskPage(answer.data, offset) : answer;
  });

  orca.panels.handle('cleo.task', async (input, { signal }) => {
    const request: Record<string, unknown> = isRecord(input) ? input : {};
    const argv = showArgv(request['taskId']);
    if (argv === null) return failure('invalid-request', 'The task id is not a CLEO task id.');
    const directory = await resolveDirectory(orca, request['selection'], signal);
    if (!directory.ok) return directory;
    const answer = await run(argv, { cwd: directory.path, signal });
    return answer.ok ? toTaskDetail(answer.data) : answer;
  });

  orca.commands.register('cleo.refresh', () => {
    orca.panels.post('cleo.refresh', { requestedAt: Date.now() });
    return 'CLEO: refresh sent to the open CLEO Tasks panel.';
  });
}

/**
 * Entry point Orca calls once when the worker starts.
 *
 * @param orca - The worker API Orca passes in.
 */
export default function activate(orca: OrcaWorkerApi): void {
  activateWith(orca, runCleo);
}
