/**
 * CLI update command.
 * @task T4461
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the update command.
 * @task T4461
 */
export function registerUpdateCommand(program: Command): void {
  program
    .command('update <taskId>')
    .description('Update a task')
    .option('--title <title>', 'New title')
    .option('-s, --status <status>', 'New status')
    .option('-p, --priority <priority>', 'New priority')
    .option('-t, --type <type>', 'New type')
    .option('--size <size>', 'New size')
    .option('-P, --phase <phase>', 'New phase')
    .option('-d, --description <desc>', 'New description')
    .option('-l, --labels <labels>', 'Set labels (comma-separated)')
    .option('--add-labels <labels>', 'Add labels (comma-separated)')
    .option('--remove-labels <labels>', 'Remove labels (comma-separated)')
    .option('-D, --depends <ids>', 'Set dependencies (comma-separated)')
    .option('--add-depends <ids>', 'Add dependencies (comma-separated)')
    .option('--remove-depends <ids>', 'Remove dependencies (comma-separated)')
    .option('--notes <note>', 'Add a note')
    .option('--acceptance <criteria>', 'Set acceptance criteria (comma-separated)')
    .option('--files <files>', 'Set files (comma-separated)')
    .option('--blocked-by <reason>', 'Set blocked-by reason')
    .option('--parent <id>', 'Set parent ID')
    .option('--no-auto-complete', 'Disable auto-complete for epic')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      const params: Record<string, unknown> = { taskId };

      if (opts['title'] !== undefined) params['title'] = opts['title'];
      if (opts['status'] !== undefined) params['status'] = opts['status'];
      if (opts['priority'] !== undefined) params['priority'] = opts['priority'];
      if (opts['type'] !== undefined) params['type'] = opts['type'];
      if (opts['size'] !== undefined) params['size'] = opts['size'];
      if (opts['phase'] !== undefined) params['phase'] = opts['phase'];
      if (opts['description'] !== undefined) params['description'] = opts['description'];
      if (opts['labels']) params['labels'] = (opts['labels'] as string).split(',').map(s => s.trim());
      if (opts['addLabels']) params['addLabels'] = (opts['addLabels'] as string).split(',').map(s => s.trim());
      if (opts['removeLabels']) params['removeLabels'] = (opts['removeLabels'] as string).split(',').map(s => s.trim());
      if (opts['depends']) params['depends'] = (opts['depends'] as string).split(',').map(s => s.trim());
      if (opts['addDepends']) params['addDepends'] = (opts['addDepends'] as string).split(',').map(s => s.trim());
      if (opts['removeDepends']) params['removeDepends'] = (opts['removeDepends'] as string).split(',').map(s => s.trim());
      if (opts['notes'] !== undefined) params['notes'] = opts['notes'];
      if (opts['acceptance']) params['acceptance'] = (opts['acceptance'] as string).split(',').map(s => s.trim());
      if (opts['files']) params['files'] = (opts['files'] as string).split(',').map(s => s.trim());
      if (opts['blockedBy'] !== undefined) params['blockedBy'] = opts['blockedBy'];
      if (opts['parent'] !== undefined) params['parent'] = opts['parent'];
      if (opts['autoComplete'] === false) params['noAutoComplete'] = true;

      await dispatchFromCli('mutate', 'tasks', 'update', params, { command: 'update' });
    });
}
