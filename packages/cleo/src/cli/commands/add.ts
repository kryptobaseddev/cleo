/**
 * CLI add command.
 * @task T4460
 * @epic T4454
 */

import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import type { ParamDef } from '../../dispatch/types.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { applyParamDefsToCommand, buildOperationHelp } from '../help-generator.js';
import { cliOutput } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// ParamDef array for tasks.add
//
// This mirrors the STATIC_PARAMS_TABLE entry in packages/lafs/src/operation-gates.ts
// and will be upstreamed into registry.ts when the T4897 migration reaches
// tasks.add.  Until then, this is the authoritative CLI-visible param list.
// ---------------------------------------------------------------------------
const ADD_PARAMS: readonly ParamDef[] = [
  {
    name: 'title',
    type: 'string',
    required: true,
    description: 'Task title (3–500 characters)',
    cli: { positional: true },
  },
  {
    name: 'status',
    type: 'string',
    required: false,
    description: 'Task status',
    enum: ['pending', 'active', 'blocked', 'done'] as const,
    cli: { short: '-s', flag: 'status' },
  },
  {
    name: 'priority',
    type: 'string',
    required: false,
    description: 'Task priority',
    enum: ['low', 'medium', 'high', 'critical'] as const,
    cli: { short: '-p', flag: 'priority' },
  },
  {
    name: 'type',
    type: 'string',
    required: false,
    description: 'Task type',
    enum: ['epic', 'task', 'subtask', 'bug'] as const,
    cli: { short: '-t', flag: 'type' },
  },
  {
    name: 'parent',
    type: 'string',
    required: false,
    description: 'Parent task ID (makes this task a subtask)',
    cli: { flag: 'parent' },
  },
  {
    name: 'size',
    type: 'string',
    required: false,
    description: 'Scope size estimate',
    enum: ['small', 'medium', 'large'] as const,
    cli: { flag: 'size' },
  },
  {
    name: 'phase',
    type: 'string',
    required: false,
    description: 'Phase slug to assign the task to',
    cli: { short: '-P', flag: 'phase' },
  },
  {
    name: 'description',
    type: 'string',
    required: false,
    description: 'Detailed task description (must differ meaningfully from title)',
    cli: { short: '-d', flag: 'description' },
  },
  {
    name: 'labels',
    type: 'array',
    required: false,
    description: 'Comma-separated labels',
    cli: { short: '-l', flag: 'labels' },
  },
  {
    name: 'files',
    type: 'array',
    required: false,
    description: 'Comma-separated file paths',
    cli: { flag: 'files' },
  },
  {
    name: 'acceptance',
    type: 'array',
    required: false,
    description: 'Pipe-separated acceptance criteria (e.g. "AC1|AC2|AC3")',
    cli: { flag: 'acceptance' },
  },
  {
    name: 'depends',
    type: 'array',
    required: false,
    description: 'Comma-separated dependency task IDs',
    cli: { short: '-D', flag: 'depends' },
  },
  {
    name: 'notes',
    type: 'string',
    required: false,
    description: 'Initial note entry for the task',
    cli: { flag: 'notes' },
  },
  {
    name: 'position',
    type: 'number',
    required: false,
    description: 'Position within sibling group',
    cli: { flag: 'position', parse: parseInt as (val: string) => unknown },
  },
];

/**
 * Register the add command.
 * @task T4460
 */
export function registerAddCommand(program: Command): void {
  const cmd = program
    .command('add')
    .description(buildOperationHelp('tasks.add', 'Create a new task', ADD_PARAMS));

  // Auto-generate options and the <title> positional arg from the ParamDef
  // registry.  This replaces the previous hand-written .option() chain and
  // registers enum values, required indicators, and gate docs in --help.
  applyParamDefsToCommand(cmd, ADD_PARAMS, 'tasks.add');

  // Hand-written options with no ParamDef entry (CLI-only surface, not in the
  // dispatch registry).  These come AFTER applyParamDefsToCommand so they
  // appear at the bottom of --help output.
  cmd
    .option('--add-phase', 'Create new phase if it does not exist')
    .option('--desc <desc>', 'Task description (alias for --description)')
    .option('--dry-run', 'Show what would be created without making changes')
    .action(async (title: string, opts: Record<string, unknown>) => {
      const params: Record<string, unknown> = { title };

      if (opts['status'] !== undefined) params['status'] = opts['status'];
      if (opts['priority'] !== undefined) params['priority'] = opts['priority'];
      if (opts['type'] !== undefined) params['type'] = opts['type'];
      if (opts['parent'] !== undefined) params['parent'] = opts['parent'];
      if (opts['size'] !== undefined) params['size'] = opts['size'];
      if (opts['phase'] !== undefined) params['phase'] = opts['phase'];
      if (opts['addPhase'] !== undefined) params['addPhase'] = opts['addPhase'];
      if (opts['description'] !== undefined) {
        params['description'] = opts['description'];
      } else if (opts['desc'] !== undefined) {
        params['description'] = opts['desc'];
      }
      if (opts['labels'])
        params['labels'] = (opts['labels'] as string).split(',').map((s) => s.trim());
      if (opts['files'])
        params['files'] = (opts['files'] as string).split(',').map((s) => s.trim());
      if (opts['acceptance'])
        params['acceptance'] = (opts['acceptance'] as string)
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean);
      if (opts['depends'])
        params['depends'] = (opts['depends'] as string).split(',').map((s) => s.trim());
      if (opts['notes'] !== undefined) params['notes'] = opts['notes'];
      if (opts['position'] !== undefined) params['position'] = opts['position'];
      if (opts['dryRun'] !== undefined) params['dryRun'] = opts['dryRun'];

      const response = await dispatchRaw('mutate', 'tasks', 'add', params);

      if (!response.success) {
        handleRawError(response, { command: 'add', operation: 'tasks.add' });
      }

      const data = response.data as Record<string, unknown>;
      if (data?.duplicate) {
        cliOutput(data, {
          command: 'add',
          message: 'Task with identical title was created recently',
          operation: 'tasks.add',
        });
      } else if (data?.dryRun) {
        cliOutput(data, {
          command: 'add',
          message: 'Dry run - no changes made',
          operation: 'tasks.add',
        });
      } else {
        cliOutput(data, { command: 'add', operation: 'tasks.add' });
      }
    });
}
