/**
 * CLI exists command
 * @task T4454
 * @task T487
 */
import { ExitCode } from '@cleocode/contracts';
import { getTask, resolveProjectRoot } from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { cliOutput } from '../renderers/index.js';
/** Native citty command for `cleo exists <task-id>`. */
export const existsCommand = defineCommand({
  meta: { name: 'exists', description: 'Check if a task ID exists (exit 0=exists, 4=not found)' },
  args: {
    'task-id': { type: 'positional', description: 'Task ID to look up', required: true },
    verbose: { type: 'boolean', description: 'Show task title and status when found' },
  },
  async run({ args }) {
    const taskId = args['task-id'];
    const cwd = resolveProjectRoot();
    let task: Awaited<ReturnType<typeof getTask>>;
    try {
      task = await getTask(taskId, cwd);
    } catch (err) {
      console.error(`exists: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(ExitCode.GENERAL_ERROR);
    }
    if (!task) {
      cliOutput({ exists: false, taskId }, { command: 'exists', operation: 'tasks.exists' });
      process.exit(ExitCode.NOT_FOUND);
    }
    const data: Record<string, unknown> = { exists: true, taskId };
    if (args.verbose) {
      data['title'] = task.title;
      data['status'] = task.status;
    }
    cliOutput(data, { command: 'exists', operation: 'tasks.exists' });
  },
});
