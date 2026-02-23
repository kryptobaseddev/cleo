/**
 * CLI deps command for dependency visualization and analysis.
 * @task T4464
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerDepsCommand(program: Command): void {
  const deps = program
    .command('deps')
    .description('Dependency visualization and analysis');

  deps
    .command('overview')
    .description('Overview of all dependencies')
    .action(async () => {
      await dispatchFromCli('query', 'tasks', 'depends', {
        action: 'overview',
      }, { command: 'deps', operation: 'tasks.depends' });
    });

  deps
    .command('show <taskId>')
    .description('Show dependencies for a specific task')
    .action(async (taskId: string) => {
      await dispatchFromCli('query', 'tasks', 'depends', {
        taskId,
      }, { command: 'deps', operation: 'tasks.depends' });
    });

  deps
    .command('waves [epicId]')
    .description('Group tasks into parallelizable execution waves')
    .action(async (epicId?: string) => {
      await dispatchFromCli('query', 'orchestrate', 'waves', {
        epicId,
      }, { command: 'deps', operation: 'tasks.depends' });
    });

  deps
    .command('critical-path <taskId>')
    .description('Find longest dependency chain from task')
    .action(async (taskId: string) => {
      await dispatchFromCli('query', 'orchestrate', 'critical.path', {
        taskId,
      }, { command: 'deps', operation: 'tasks.depends' });
    });

  deps
    .command('impact <taskId>')
    .description('Find all tasks affected by changes to task')
    .option('--depth <n>', 'Maximum depth for impact analysis', '10')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'tasks', 'depends', {
        taskId, action: 'impact', depth: parseInt(opts['depth'] as string, 10),
      }, { command: 'deps', operation: 'tasks.depends' });
    });

  deps
    .command('cycles')
    .description('Detect circular dependencies')
    .action(async () => {
      await dispatchFromCli('query', 'tasks', 'depends', {
        action: 'cycles',
      }, { command: 'deps', operation: 'tasks.depends' });
    });
}

export function registerTreeCommand(program: Command): void {
  program
    .command('tree [rootId]')
    .description('Task hierarchy tree visualization')
    .action(async (rootId?: string) => {
      await dispatchFromCli('query', 'tasks', 'tree', {
        taskId: rootId,
      }, { command: 'tree', operation: 'tasks.tree' });
    });
}
