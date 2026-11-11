/**
 * Worker of the CLEO Orca plugin (T14462): binds the read handlers in
 * `handlers.ts` to Orca's worker API and serves the refresh palette command.
 *
 * It asks Orca only for the workspace list and the focused-workspace context
 * (`workspace:read`) and keeps no state: a save or an idle stop loses nothing.
 * Orca loads this file as written; there is no build step.
 */

import type { OrcaWorkerApi } from 'orca/worker';
import { runCleo } from './cleo-cli.ts';
import { createHandlers } from './handlers.ts';

/**
 * Entry point Orca calls once when the worker starts.
 *
 * @param orca - The worker API Orca passes in.
 */
export default function activate(orca: OrcaWorkerApi): void {
  const handlers = createHandlers(
    {
      list: (signal) => orca.host.call('workspace.list', undefined, { signal }),
      focus: (signal) => orca.host.call('workspace.readContext', undefined, { signal }),
    },
    runCleo,
  );

  orca.panels.handle('cleo.workspaces', (_input, { signal }) => handlers.workspaces(signal));
  orca.panels.handle('cleo.tasks', (input, { signal }) => handlers.tasks(input, signal));
  orca.panels.handle('cleo.task', (input, { signal }) => handlers.task(input, signal));

  orca.commands.register('cleo.refresh', () => {
    orca.panels.post('cleo.refresh', { requestedAt: Date.now() });
    return 'CLEO: refresh sent to the open CLEO Tasks panel.';
  });
}
