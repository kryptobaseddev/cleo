/**
 * CLI deps command for dependency visualization and analysis.
 * @task T4464
 * @epic T4454
 */

import { Command } from 'commander';
import {
  getDepsOverview,
  getTaskDeps,
  getExecutionWaves,
  getCriticalPath,
  getImpact,
  detectCycles,
  getTaskTree,
} from '../../core/phases/deps.js';
import { formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Register the deps command.
 * @task T4464
 */
export function registerDepsCommand(program: Command): void {
  const deps = program
    .command('deps')
    .description('Dependency visualization and analysis');

  deps
    .command('overview')
    .description('Overview of all dependencies')
    .action(async () => {
      try {
        const result = await getDepsOverview();
        cliOutput(result, { command: 'deps', operation: 'tasks.depends' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  deps
    .command('show <taskId>')
    .description('Show dependencies for a specific task')
    .action(async (taskId: string) => {
      try {
        const result = await getTaskDeps(taskId);
        cliOutput(result, { command: 'deps', operation: 'tasks.depends' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  deps
    .command('waves [epicId]')
    .description('Group tasks into parallelizable execution waves')
    .action(async (epicId?: string) => {
      try {
        const result = await getExecutionWaves(epicId);
        cliOutput({ waves: result }, { command: 'deps', operation: 'tasks.depends' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  deps
    .command('critical-path <taskId>')
    .description('Find longest dependency chain from task')
    .action(async (taskId: string) => {
      try {
        const result = await getCriticalPath(taskId);
        cliOutput(result, { command: 'deps', operation: 'tasks.depends' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  deps
    .command('impact <taskId>')
    .description('Find all tasks affected by changes to task')
    .option('--depth <n>', 'Maximum depth for impact analysis', '10')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const depth = parseInt(opts['depth'] as string, 10);
        const result = await getImpact(taskId, depth);
        cliOutput({ taskId, impacted: result, count: result.length }, { command: 'deps', operation: 'tasks.depends' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  deps
    .command('cycles')
    .description('Detect circular dependencies')
    .action(async () => {
      try {
        const result = await detectCycles();
        cliOutput(result, { command: 'deps', operation: 'tasks.depends' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}

/**
 * Register the tree command.
 * @task T4464
 */
export function registerTreeCommand(program: Command): void {
  program
    .command('tree [rootId]')
    .description('Task hierarchy tree visualization')
    .action(async (rootId?: string) => {
      try {
        const result = await getTaskTree(rootId);
        cliOutput({ tree: result }, { command: 'tree', operation: 'tasks.tree' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
