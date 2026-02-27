/**
 * CLI bug command - shorthand for creating bug report tasks.
 * @task T4913
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Severity mapping configuration.
 * Maps severity levels to priority and labels.
 */
const SEVERITY_MAP: Record<string, { priority: string; labels: string[] }> = {
  P0: { priority: 'critical', labels: ['bug', 'p0'] },
  P1: { priority: 'high', labels: ['bug', 'p1'] },
  P2: { priority: 'medium', labels: ['bug', 'p2'] },
  P3: { priority: 'low', labels: ['bug', 'p3'] },
};

/**
 * Valid severity levels for error messages.
 */
const VALID_SEVERITIES = Object.keys(SEVERITY_MAP);

/**
 * Register the bug command.
 * @task T4913
 */
export function registerBugCommand(program: Command): void {
  program
    .command('bug <title>')
    .description('Create a bug report task with severity mapping')
    .option('-s, --severity <level>', 'Severity level (P0, P1, P2, P3) - required', 'P2')
    .option('-e, --epic <id>', 'Epic ID to link as parent (optional)')
    .option('-d, --description <desc>', 'Bug description')
    .option('--dry-run', 'Show what would be created without making changes')
    .action(async (title: string, opts: Record<string, unknown>) => {
      const severity = (opts['severity'] as string) || 'P2';

      // Validate severity level
      if (!VALID_SEVERITIES.includes(severity)) {
        console.error(
          `Error: Invalid severity "${severity}". Must be one of: ${VALID_SEVERITIES.join(', ')}`
        );
        process.exit(1);
      }

      const mapping = SEVERITY_MAP[severity];

      const params: Record<string, unknown> = {
        title,
        type: 'task',
        priority: mapping.priority,
        labels: mapping.labels,
        origin: 'bug-report',
        description: (opts['description'] as string) || title,
      };

      // Link to epic if provided
      if (opts['epic'] !== undefined) {
        params['parent'] = opts['epic'];
      }

      if (opts['dryRun'] !== undefined) {
        params['dryRun'] = opts['dryRun'];
      }

      const response = await dispatchRaw('mutate', 'tasks', 'add', params);

      if (!response.success) {
        handleRawError(response, { command: 'bug', operation: 'tasks.add' });
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
