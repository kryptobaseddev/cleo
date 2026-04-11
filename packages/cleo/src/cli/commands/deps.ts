/**
 * CLI deps command for dependency visualization and analysis.
 *
 * Fix #69: The critical-path subcommand now calls depsCriticalPath() from core
 * directly instead of dispatching to query:orchestrate.critical.path, which was
 * removed from the registry in T5615 (merged into orchestrate.analyze).
 *
 * @task T4464
 * @epic T4454
 */

import { ExitCode } from '@cleocode/contracts';
import { depsCriticalPath, resolveProjectRoot } from '@cleocode/core/internal';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Register the deps command group and its subcommands.
 *
 * @param program - Root CLI program instance.
 */
export function registerDepsCommand(program: Command): void {
  const deps = program.command('deps').description('Dependency visualization and analysis');

  deps
    .command('overview')
    .description('Overview of all dependencies')
    .action(async () => {
      await dispatchFromCli(
        'query',
        'tasks',
        'depends',
        {
          action: 'overview',
        },
        { command: 'deps', operation: 'tasks.depends' },
      );
    });

  deps
    .command('show <taskId>')
    .description('Show dependencies for a specific task')
    .option('--tree', 'Show full transitive dependency tree')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'tasks',
        'depends',
        {
          taskId,
          tree: opts['tree'] as boolean | undefined,
        },
        { command: 'deps', operation: 'tasks.depends' },
      );
    });

  deps
    .command('waves <epicId>')
    .description('Group tasks into parallelizable execution waves')
    .action(async (epicId: string) => {
      await dispatchFromCli(
        'query',
        'orchestrate',
        'waves',
        {
          epicId,
        },
        { command: 'deps', operation: 'orchestrate.waves' },
      );
    });

  deps
    .command('critical-path <taskId>')
    .description('Find longest dependency chain from task')
    .action(async (taskId: string) => {
      const cwd = resolveProjectRoot();
      try {
        const result = await depsCriticalPath(taskId, cwd);
        cliOutput(result, { command: 'deps', operation: 'tasks.criticalPath' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`critical-path: ${msg}`);
        process.exit(ExitCode.NOT_FOUND);
      }
    });

  deps
    .command('impact <taskId>')
    .description('Find all tasks affected by changes to task')
    .option('--depth <n>', 'Maximum depth for impact analysis', '10')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'tasks',
        'depends',
        {
          taskId,
          action: 'impact',
          depth: parseInt(opts['depth'] as string, 10),
        },
        { command: 'deps', operation: 'tasks.depends' },
      );
    });

  deps
    .command('cycles')
    .description('Detect circular dependencies')
    .action(async () => {
      await dispatchFromCli(
        'query',
        'tasks',
        'depends',
        {
          action: 'cycles',
        },
        { command: 'deps', operation: 'tasks.depends' },
      );
    });
}

/**
 * Register the tree command.
 *
 * @param program - Root CLI program instance.
 */
export function registerTreeCommand(program: Command): void {
  program
    .command('tree [rootId]')
    .description('Task hierarchy tree visualization')
    .action(async (rootId?: string) => {
      await dispatchFromCli(
        'query',
        'tasks',
        'tree',
        {
          taskId: rootId,
        },
        { command: 'tree', operation: 'tasks.tree' },
      );
    });
}
