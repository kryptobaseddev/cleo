/**
 * CLI orchestrate command group.
 * @task T4466
 * @epic T4454
 */

import { Command } from 'commander';
import {
  startOrchestration,
  analyzeEpic,
  getReadyTasks,
  getNextTask,
  prepareSpawn,
  validateSpawnOutput,
  getOrchestratorContext,
} from '../../core/orchestration/index.js';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the orchestrate command group.
 * @task T4466
 */
export function registerOrchestrateCommand(program: Command): void {
  const orch = program
    .command('orchestrate')
    .description('Multi-agent orchestration commands');

  orch
    .command('start <epicId>')
    .description('Start orchestrator session for an epic')
    .action(async (epicId: string) => {
      try {
        const result = await startOrchestration(epicId);
        cliOutput(result, { command: 'orchestrate' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  orch
    .command('analyze <epicId>')
    .description('Analyze epic dependency structure')
    .action(async (epicId: string) => {
      try {
        const result = await analyzeEpic(epicId);
        cliOutput(result, { command: 'orchestrate' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  orch
    .command('ready <epicId>')
    .description('Get parallel-safe ready tasks')
    .action(async (epicId: string) => {
      try {
        const result = await getReadyTasks(epicId);
        cliOutput({ tasks: result, count: result.length }, { command: 'orchestrate' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  orch
    .command('next <epicId>')
    .description('Get next task to spawn')
    .action(async (epicId: string) => {
      try {
        const result = await getNextTask(epicId);
        if (!result) {
          cliOutput({ task: null, message: 'No ready tasks' }, { command: 'orchestrate' });
        } else {
          cliOutput({ task: result }, { command: 'orchestrate' });
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  orch
    .command('spawn <taskId>')
    .description('Prepare spawn context for a subagent')
    .action(async (taskId: string) => {
      try {
        const result = await prepareSpawn(taskId);
        cliOutput(result, { command: 'orchestrate' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  orch
    .command('validate <taskId>')
    .description('Validate subagent output')
    .option('--file <path>', 'Output file path')
    .option('--manifest', 'Manifest entry was appended')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const result = await validateSpawnOutput(taskId, {
          file: opts['file'] as string | undefined,
          manifestEntry: opts['manifest'] as boolean | undefined,
        });
        cliOutput(result, { command: 'orchestrate' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  orch
    .command('context <epicId>')
    .description('Get orchestrator context summary')
    .action(async (epicId: string) => {
      try {
        const result = await getOrchestratorContext(epicId);
        cliOutput(result, { command: 'orchestrate' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
