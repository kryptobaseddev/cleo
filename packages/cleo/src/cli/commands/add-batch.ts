/**
 * CLI add-batch command — thin adapter for the CORE `tasks.add-batch` op.
 *
 * Reads a JSON array from file or stdin; delegates atomicity to CORE via ONE
 * `dispatchRaw('mutate', 'tasks', 'add-batch', ...)` call. If any spec fails
 * the entire batch is rolled back by the CORE transaction.
 *
 * @task T9816
 * @epic T9813
 */

import { existsSync, readFileSync } from 'node:fs';
import { defineCommand } from 'citty';
import { dispatchRaw } from '../../dispatch/adapters/cli.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * Native citty command — thin CLI adapter for the CORE `tasks.add-batch` op.
 * Input parsing lives here; all business logic (validation, atomicity) lives in CORE.
 *
 * @task T9816
 */
export const addBatchCommand = defineCommand({
  meta: {
    name: 'add-batch',
    description: 'Create multiple tasks in a single atomic transaction from a JSON file',
  },
  args: {
    file: {
      type: 'string',
      description: 'Path to JSON file (array of task objects). Use - for stdin.',
    },
    parent: {
      type: 'string',
      description: 'Default parent for all tasks (overridden by per-task parent)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview what would be created without making changes',
    },
  },
  async run({ args }) {
    const filePath = args.file as string | undefined;
    const defaultParent = args.parent as string | undefined;
    const dryRun = args['dry-run'] as boolean | undefined;

    // --- Input adapter (CLI responsibility): file or stdin ---
    let raw: string;
    if (!filePath || filePath === '-') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) {
        cliError(
          'No input provided. Pass --file <path> or pipe JSON to stdin.',
          'E_VALIDATION',
          { name: 'E_VALIDATION', fix: 'cleo add-batch --file tasks.json' },
          { operation: 'tasks.add-batch' },
        );
        process.exitCode = 2;
        return;
      }
    } else {
      if (!existsSync(filePath)) {
        cliError(
          `File not found: ${filePath}`,
          'E_NOT_FOUND',
          { name: 'E_NOT_FOUND', fix: `Verify the file path exists: ${filePath}` },
          { operation: 'tasks.add-batch' },
        );
        process.exitCode = 2;
        return;
      }
      raw = readFileSync(filePath, 'utf-8');
    }

    let tasks: unknown[];
    try {
      const parsed = JSON.parse(raw) as unknown;
      tasks = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      cliError(
        'Invalid JSON input. Expected an array of task objects.',
        'E_VALIDATION',
        { name: 'E_VALIDATION', fix: 'Ensure the input is a valid JSON array of task objects' },
        { operation: 'tasks.add-batch' },
      );
      process.exitCode = 2;
      return;
    }

    if (tasks.length === 0) {
      cliError(
        'No tasks in input.',
        'E_VALIDATION',
        { name: 'E_VALIDATION', fix: 'Provide at least one task object in the JSON array' },
        { operation: 'tasks.add-batch' },
      );
      process.exitCode = 2;
      return;
    }

    // --- Single dispatch call: all atomicity owned by CORE ---
    const response = await dispatchRaw('mutate', 'tasks', 'add-batch', {
      tasks,
      ...(defaultParent && { defaultParent }),
      ...(dryRun && { dryRun: true }),
    });

    if (!response.success) {
      cliError(
        response.error?.message ?? 'Batch creation failed',
        response.error?.code ?? 'E_BATCH_FAILED',
        {
          name: response.error?.code ?? 'E_BATCH_FAILED',
          fix: response.error?.fix ?? 'Check task specs and try again',
        },
        { operation: 'tasks.add-batch' },
      );
      process.exitCode = 1;
      return;
    }

    cliOutput(response.data, { command: 'add-batch', operation: 'tasks.add-batch' });
  },
});
