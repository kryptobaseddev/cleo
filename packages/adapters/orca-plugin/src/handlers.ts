/**
 * What the CLEO Orca plugin worker answers the panel with (T14462).
 *
 * This module has no Orca import: `worker.ts` binds it to Orca's worker API,
 * and the vitest suite in `packages/adapters` drives it directly. It is
 * read-only by construction: it asks its workspace source for Orca's list and
 * focus, runs only the two argv shapes `cleo-cli.ts` builds, and keeps no
 * state between requests.
 */

import { type CleoRunner, failure, isRecord, listArgv, showArgv } from './cleo-cli.ts';
import type { CleoFailure, TaskDetail, TaskPage, WorkspaceList } from './protocol.ts';
import { toTaskDetail, toTaskPage } from './views.ts';
import {
  buildWorkspaceOptions,
  type FocusContext,
  type HostWorkspace,
  resolveSelection,
} from './workspaces.ts';

/** Where the handlers learn Orca's workspaces: its `workspace:read` host calls. */
export type WorkspaceSource = {
  /** Orca's `workspace.list`. May reject. */
  list(signal: AbortSignal): Promise<{ workspaces: HostWorkspace[]; truncated: boolean }>;
  /** Orca's `workspace.readContext`. May reject. */
  focus(signal: AbortSignal): Promise<FocusContext>;
};

/** One handler per panel request; none of them rejects. */
export type CleoHandlers = {
  workspaces(signal: AbortSignal): Promise<WorkspaceList | CleoFailure>;
  tasks(input: unknown, signal: AbortSignal): Promise<TaskPage | CleoFailure>;
  task(input: unknown, signal: AbortSignal): Promise<TaskDetail | CleoFailure>;
};

/**
 * Builds the panel request handlers over a workspace source and a CLEO runner.
 *
 * @param source - Orca's workspace list and focus.
 * @param run - Runs one bounded `cleo` read.
 */
export function createHandlers(source: WorkspaceSource, run: CleoRunner): CleoHandlers {
  /** Orca's current workspaces, or why they could not be listed. */
  async function listed(signal: AbortSignal) {
    try {
      return { ok: true as const, ...(await source.list(signal)) };
    } catch (error) {
      if (signal.aborted) return failure('cancelled', 'The CLEO read was cancelled.');
      return failure('host-error', `Orca could not list its workspaces: ${String(error)}`);
    }
  }

  /** The local directory a request's selection resolves to right now. */
  async function directory(selection: unknown, signal: AbortSignal) {
    const current = await listed(signal);
    return current.ok ? resolveSelection(current.workspaces, selection) : current;
  }

  return {
    async workspaces(signal) {
      const current = await listed(signal);
      if (!current.ok) return current;
      // The focus is a hint for the picker; a failed read of it only drops the hint.
      const focus = await source.focus(signal).catch(() => null);
      return {
        ok: true,
        truncated: current.truncated,
        ...buildWorkspaceOptions(current.workspaces, focus),
      };
    },

    async tasks(input, signal) {
      const request: Record<string, unknown> = isRecord(input) ? input : {};
      const argv = listArgv(request);
      if (argv === null) return failure('invalid-request', 'The task list request is not valid.');
      const target = await directory(request['selection'], signal);
      if (!target.ok) return target;
      const answer = await run(argv, { cwd: target.path, signal });
      const offset = typeof request['offset'] === 'number' ? request['offset'] : 0;
      return answer.ok ? toTaskPage(answer.data, offset) : answer;
    },

    async task(input, signal) {
      const request: Record<string, unknown> = isRecord(input) ? input : {};
      const argv = showArgv(request['taskId']);
      if (argv === null) return failure('invalid-request', 'The task id is not a CLEO task id.');
      const target = await directory(request['selection'], signal);
      if (!target.ok) return target;
      const answer = await run(argv, { cwd: target.path, signal });
      return answer.ok ? toTaskDetail(answer.data) : answer;
    },
  };
}
