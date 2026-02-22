/**
 * CLI add command.
 * @task T4460
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchRaw } from '../../dispatch/adapters/cli.js';
import { cliOutput, cliError } from '../renderers/index.js';

/**
 * Register the add command.
 * @task T4460
 */
export function registerAddCommand(program: Command): void {
  program
    .command('add <title>')
    .description('Create a new task')
    .option('-s, --status <status>', 'Task status (pending|active|blocked|done)')
    .option('-p, --priority <priority>', 'Priority: low, medium, high, critical')
    .option('-t, --type <type>', 'Task type: epic, task, subtask')
    .option('--parent <id>', 'Parent task ID')
    .option('--size <size>', 'Scope size: small, medium, large')
    .option('-P, --phase <phase>', 'Phase slug')
    .option('--add-phase', 'Create new phase if it does not exist')
    .option('-d, --description <desc>', 'Task description')
    .option('-l, --labels <labels>', 'Comma-separated labels')
    .option('--files <files>', 'Comma-separated file paths')
    .option('--acceptance <criteria>', 'Comma-separated acceptance criteria')
    .option('-D, --depends <ids>', 'Comma-separated dependency IDs')
    .option('--notes <note>', 'Initial note entry')
    .option('--position <pos>', 'Position within sibling group', parseInt)
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
      } else {
        params['description'] = title;
      }
      if (opts['labels']) params['labels'] = (opts['labels'] as string).split(',').map(s => s.trim());
      if (opts['files']) params['files'] = (opts['files'] as string).split(',').map(s => s.trim());
      if (opts['acceptance']) params['acceptance'] = (opts['acceptance'] as string).split(',').map(s => s.trim());
      if (opts['depends']) params['depends'] = (opts['depends'] as string).split(',').map(s => s.trim());
      if (opts['notes'] !== undefined) params['notes'] = opts['notes'];
      if (opts['position'] !== undefined) params['position'] = opts['position'];
      if (opts['dryRun'] !== undefined) params['dryRun'] = opts['dryRun'];

      const response = await dispatchRaw('mutate', 'tasks', 'add', params);

      if (!response.success) {
        const exitCode = response.error?.exitCode ?? 1;
        cliError(response.error?.message ?? 'Unknown error', exitCode, {
          name: response.error?.code,
          details: response.error?.details,
          fix: response.error?.fix,
        });
        process.exit(exitCode);
        return;
      }

      const data = response.data as Record<string, unknown>;
      if (data?.duplicate) {
        cliOutput(data, { command: 'add', message: 'Task with identical title was created recently', operation: 'tasks.add' });
      } else if (data?.dryRun) {
        cliOutput(data, { command: 'add', message: 'Dry run - no changes made', operation: 'tasks.add' });
      } else {
        cliOutput(data, { command: 'add', operation: 'tasks.add' });
      }
    });
}
