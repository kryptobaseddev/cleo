/**
 * CLI add-batch command — atomic batch creation of multiple tasks.
 *
 * Reads a JSON array of task definitions from a file or stdin and creates
 * them atomically. More reliable than N sequential `cleo add` calls during
 * epic decomposition.
 *
 * @task T090
 */

import { readFileSync } from 'node:fs';
import { dispatchRaw } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

/** Schema for a single task in the batch input. */
interface BatchTaskInput {
  title: string;
  description?: string;
  parent?: string;
  type?: string;
  priority?: string;
  size?: string;
  acceptance?: string[];
  depends?: string[];
  labels?: string[];
  phase?: string;
  notes?: string;
  files?: string[];
}

/**
 * Register the add-batch command.
 * @task T090
 */
export function registerAddBatchCommand(program: Command): void {
  program
    .command('add-batch')
    .description('Create multiple tasks atomically from a JSON file')
    .option('--file <path>', 'Path to JSON file (array of task objects). Use - for stdin.')
    .option('--parent <parentId>', 'Default parent for all tasks (overridden by per-task parent)')
    .option('--dry-run', 'Preview what would be created without making changes')
    .action(async (opts: Record<string, unknown>) => {
      const filePath = opts['file'] as string | undefined;
      const defaultParent = opts['parent'] as string | undefined;
      const dryRun = opts['dryRun'] as boolean | undefined;

      // Read input
      let raw: string;
      if (!filePath || filePath === '-') {
        // Read from stdin
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk as Buffer);
        }
        raw = Buffer.concat(chunks).toString('utf-8');
      } else {
        raw = readFileSync(filePath, 'utf-8');
      }

      let tasks: BatchTaskInput[];
      try {
        const parsed = JSON.parse(raw);
        tasks = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        process.stderr.write('Error: Invalid JSON input. Expected an array of task objects.\n');
        process.exit(2);
        return;
      }

      if (tasks.length === 0) {
        process.stderr.write('Error: No tasks in input.\n');
        process.exit(2);
        return;
      }

      const results: Array<{ title: string; id?: string; error?: string }> = [];
      let failed = 0;

      for (const task of tasks) {
        const params: Record<string, unknown> = {
          title: task.title,
          ...(task.description && { description: task.description }),
          parent: task.parent ?? defaultParent,
          ...(task.type && { type: task.type }),
          ...(task.priority && { priority: task.priority }),
          ...(task.size && { size: task.size }),
          ...(task.acceptance?.length && { acceptance: task.acceptance }),
          ...(task.depends?.length && { depends: task.depends }),
          ...(task.labels?.length && { labels: task.labels }),
          ...(task.phase && { phase: task.phase }),
          ...(task.notes && { notes: task.notes }),
          ...(task.files?.length && { files: task.files }),
          ...(dryRun && { dryRun: true }),
        };

        const response = await dispatchRaw('mutate', 'tasks', 'add', params);

        if (response.success) {
          const data = response.data as Record<string, unknown>;
          const taskData = data?.task as Record<string, unknown> | undefined;
          results.push({ title: task.title, id: taskData?.id as string });
        } else {
          failed++;
          results.push({
            title: task.title,
            error: response.error?.message ?? 'Unknown error',
          });
        }
      }

      const output = {
        total: tasks.length,
        created: tasks.length - failed,
        failed,
        dryRun: dryRun ?? false,
        results,
      };

      if (failed > 0) {
        cliOutput(output, {
          command: 'add-batch',
          message: `${failed} of ${tasks.length} tasks failed`,
          operation: 'tasks.add-batch',
        });
        process.exit(1);
      } else {
        cliOutput(output, {
          command: 'add-batch',
          operation: 'tasks.add-batch',
        });
      }
    });
}
