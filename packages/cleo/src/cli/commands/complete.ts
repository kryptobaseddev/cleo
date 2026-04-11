/**
 * CLI complete command.
 * @task T4461
 * @epic T4454
 */

import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import type { ParamDef } from '../../dispatch/types.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { applyParamDefsToCommand, buildOperationHelp } from '../help-generator.js';
import { cliOutput } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// ParamDef array for tasks.complete
//
// Mirrors STATIC_PARAMS_TABLE in packages/lafs/src/operation-gates.ts.
// Will be upstreamed into registry.ts during the T4897 migration.
// ---------------------------------------------------------------------------
const COMPLETE_PARAMS: readonly ParamDef[] = [
  {
    name: 'taskId',
    type: 'string',
    required: true,
    description: 'ID of the task to complete',
    cli: { positional: true },
  },
  {
    name: 'notes',
    type: 'string',
    required: false,
    description: 'Completion notes',
    cli: { flag: 'notes' },
  },
  {
    name: 'changeset',
    type: 'string',
    required: false,
    description: 'Changeset reference',
    cli: { flag: 'changeset' },
  },
  {
    name: 'force',
    type: 'boolean',
    required: false,
    description: 'Force completion even when children are not done or dependencies unresolved',
    cli: { flag: 'force' },
  },
  {
    name: 'verificationNote',
    type: 'string',
    required: false,
    description: 'Evidence that acceptance criteria were met',
    cli: { flag: 'verification-note' },
  },
];

/**
 * Register the complete command.
 * @task T4461
 */
export function registerCompleteCommand(program: Command): void {
  const cmd = program
    .command('complete')
    .alias('done')
    .description(
      buildOperationHelp(
        'tasks.complete',
        'Mark a task as completed (requires active session)',
        COMPLETE_PARAMS,
      ),
    );

  // Auto-generate <taskId> positional arg and flag options from the ParamDef
  // registry.  Replaces hand-written .option('--notes', ...) etc. and surfaces
  // the children-completion, dependency-check, and verification-required gates
  // in --help output.
  applyParamDefsToCommand(cmd, COMPLETE_PARAMS, 'tasks.complete');

  cmd.action(async (taskId: string, opts: Record<string, unknown>) => {
    const response = await dispatchRaw('mutate', 'tasks', 'complete', {
      taskId,
      notes: opts['notes'] as string | undefined,
      changeset: opts['changeset'] as string | undefined,
      force: opts['force'] as boolean | undefined,
      verificationNote: opts['verificationNote'] as string | undefined,
    });

    if (!response.success) {
      handleRawError(response, { command: 'complete', operation: 'tasks.complete' });
    }

    const data = response.data as Record<string, unknown> | undefined;
    // Engine may return {task: {...}} or the task record directly
    const task = data?.task ?? data;
    const output: Record<string, unknown> = { task };
    const autoCompleted = data?.autoCompleted;
    if (Array.isArray(autoCompleted) && autoCompleted.length > 0) {
      output['autoCompleted'] = autoCompleted;
    }
    const unblockedTasks = data?.unblockedTasks;
    if (Array.isArray(unblockedTasks) && unblockedTasks.length > 0) {
      output['unblockedTasks'] = unblockedTasks;
    }

    cliOutput(output, { command: 'complete', operation: 'tasks.complete' });
  });
}
