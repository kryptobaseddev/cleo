/**
 * CLI show command.
 * @task T4460
 * @epic T4454
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ParamDef } from '../../dispatch/types.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { applyParamDefsToCommand, buildOperationHelp } from '../help-generator.js';

// ---------------------------------------------------------------------------
// ParamDef array for tasks.show
//
// Mirrors STATIC_PARAMS_TABLE in packages/lafs/src/operation-gates.ts.
// Will be upstreamed into registry.ts during the T4897 migration.
// ---------------------------------------------------------------------------
const SHOW_PARAMS: readonly ParamDef[] = [
  {
    name: 'taskId',
    type: 'string',
    required: true,
    description: 'ID of the task to retrieve',
    cli: { positional: true },
  },
];

/**
 * Register the show command.
 * @task T4460
 * @task T4666
 */
export function registerShowCommand(program: Command): void {
  const cmd = program
    .command('show')
    .description(buildOperationHelp('tasks.show', 'Show full task details by ID', SHOW_PARAMS));

  // Auto-generate the <taskId> positional arg from the ParamDef registry.
  // Replaces the previous hard-coded 'show <taskId>' in the command name string
  // and surfaces the task-exists gate in --help output.
  applyParamDefsToCommand(cmd, SHOW_PARAMS, 'tasks.show');

  cmd.action(async (taskId: string) => {
    await dispatchFromCli('query', 'tasks', 'show', { taskId }, { command: 'show' });
  });
}
