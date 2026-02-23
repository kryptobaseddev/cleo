/**
 * CLI inject command - prepare tasks for TodoWrite injection.
 * @task T4539
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerInjectCommand(program: Command): void {
  program
    .command('inject')
    .description('Inject/prepare tasks for TodoWrite format (session start)')
    .option('--max-tasks <n>', 'Maximum tasks to inject', '8')
    .option('--focused-only', 'Only inject the focused task')
    .option('--phase <slug>', 'Filter tasks to specific phase')
    .option('--output <file>', 'Write to file instead of stdout')
    .option('--save-state', 'Save session state for extraction', true)
    .option('--dry-run', 'Preview without writing')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'admin', 'inject.generate', {
        maxTasks: opts['maxTasks'] ? Number(opts['maxTasks']) : 8,
        focusedOnly: opts['focusedOnly'],
        phase: opts['phase'],
        output: opts['output'],
        saveState: opts['saveState'],
        dryRun: opts['dryRun'],
      }, { command: 'inject' });
    });
}
