/**
 * CLI add-batch command — thin adapter for the CORE `tasks.add-batch` op.
 *
 * Reads a JSON array from `--params`, `--file`, or stdin via the shared
 * {@link collectMutateInput} adapter (T9916), validates against
 * {@link INPUT_CONTRACTS}['tasks.add-batch'] via {@link validateOperationInput}
 * (T9915), then delegates atomicity to CORE via ONE
 * `dispatchRaw('mutate', 'tasks', 'add-batch', ...)` call. If any spec fails
 * the entire batch is rolled back by the CORE transaction.
 *
 * @task T9816 (original CLI adapter)
 * @task T9917 (OperationInputContract retrofit)
 * @epic T9903 (E7-MUTATE-DX-SCHEMA-FIRST)
 * @saga T9855
 */

import { ExitCode } from '@cleocode/contracts';
import { INPUT_CONTRACTS, validateOperationInput } from '@cleocode/core';
import { defineCommand } from 'citty';
import { dispatchRaw, maybeEmitDescribe } from '../../dispatch/adapters/cli.js';
import { collectMutateInput } from '../lib/collect-input.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * Native citty command — thin CLI adapter for the CORE `tasks.add-batch` op.
 *
 * Input parsing flows through {@link collectMutateInput} (the canonical
 * `--params` / `--file` / stdin / positional adapter from T9916), then
 * through {@link validateOperationInput} (T9915) using the
 * `INPUT_CONTRACTS['tasks.add-batch']` schema (T9917). All business logic
 * (atomicity, dispatch) lives in CORE.
 *
 * Backwards compat: the legacy `--file <path>` and stdin paths still work
 * exactly as before — they now route through the shared adapter.
 *
 * @task T9816
 * @task T9917
 */
export const addBatchCommand = defineCommand({
  meta: {
    name: 'add-batch',
    description: 'Create multiple tasks in a single atomic transaction from a JSON file',
  },
  args: {
    params: {
      type: 'string',
      description:
        'Inline JSON object: { "tasks": [...], "defaultParent"?: "...", "dryRun"?: bool } (T9917)',
    },
    file: {
      type: 'string',
      description: 'Path to JSON file (array of task objects, or full payload). Use - for stdin.',
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
    // T11692 (DHQ-057) — `cleo add-batch --describe` prints the op's I/O schema
    // (input rejects `relates`; accepts `depends`) instead of executing. This
    // command uses dispatchRaw, so it calls the describe short-circuit directly
    // rather than relying on the dispatchFromCli intercept.
    if (maybeEmitDescribe('mutate', 'tasks', 'add-batch', { command: 'add-batch' })) return;

    const defaultParent = args.parent as string | undefined;
    const dryRunFlag = args['dry-run'] as boolean | undefined;
    const paramsArg = args.params as string | undefined;
    const fileArg = args.file as string | undefined;

    // 1. Collect raw input via the shared T9916 adapter. Supports
    //    --params, --file (including '-' for stdin), and piped stdin.
    //    Legacy compat: when --file is '-', treat as stdin (collectMutateInput
    //    only treats stdin as the third channel when no --file is passed, so
    //    we normalize here).
    const collectArgs: { params?: string; file?: string } = {};
    if (paramsArg !== undefined) collectArgs.params = paramsArg;
    if (fileArg !== undefined && fileArg !== '-') collectArgs.file = fileArg;

    let raw: unknown;
    try {
      raw = await collectMutateInput(
        collectArgs,
        process.stdin as NodeJS.ReadableStream & { isTTY?: boolean },
      );
    } catch (err) {
      cliError(
        (err as Error).message,
        ExitCode.VALIDATION_ERROR,
        {
          name: 'E_VALIDATION_FAILED',
          fix: 'Verify the JSON syntax of your --params / --file / stdin input',
        },
        { operation: 'tasks.add-batch' },
      );
      process.exitCode = ExitCode.VALIDATION_ERROR;
      return;
    }

    if (raw === undefined) {
      cliError(
        'No input provided. Pass --params <json>, --file <path>, or pipe JSON to stdin.',
        ExitCode.VALIDATION_ERROR,
        {
          name: 'E_VALIDATION_FAILED',
          fix: 'cleo add-batch --file tasks.json',
        },
        { operation: 'tasks.add-batch' },
      );
      process.exitCode = ExitCode.VALIDATION_ERROR;
      return;
    }

    // 2. Normalize the legacy "bare array" shape into the canonical
    //    `{ tasks: [...] }` payload. The schema-first contract expects an
    //    object with a `tasks` array — the pre-T9917 CLI accepted a raw
    //    array on stdin / --file for ergonomics.
    let payload: Record<string, unknown>;
    if (Array.isArray(raw)) {
      payload = { tasks: raw };
    } else if (
      raw !== null &&
      typeof raw === 'object' &&
      Array.isArray((raw as Record<string, unknown>)['tasks'])
    ) {
      payload = { ...(raw as Record<string, unknown>) };
    } else {
      // Single-object legacy compat: wrap into a one-element batch.
      payload = { tasks: [raw] };
    }

    // 3. Merge CLI flag overlays for --parent / --dry-run. Flags lose to
    //    explicit fields already present in the payload.
    if (defaultParent !== undefined && payload['defaultParent'] === undefined) {
      payload['defaultParent'] = defaultParent;
    }
    if (dryRunFlag === true && payload['dryRun'] === undefined) {
      payload['dryRun'] = true;
    }

    // 4. Schema-first validation via the SSoT INPUT_CONTRACTS registry.
    const contract = INPUT_CONTRACTS['tasks.add-batch'];
    if (!contract) {
      cliError(
        'tasks.add-batch contract missing from INPUT_CONTRACTS registry',
        ExitCode.GENERAL_ERROR,
        { name: 'E_INTERNAL', fix: 'This is a CLI bug — file an issue' },
        { operation: 'tasks.add-batch' },
      );
      process.exitCode = ExitCode.GENERAL_ERROR;
      return;
    }
    const result = validateOperationInput(contract, payload);
    if (!result.ok) {
      cliError(
        'tasks.add-batch failed: validation',
        ExitCode.VALIDATION_ERROR,
        {
          name: 'E_VALIDATION_FAILED',
          fix: result.errors[0]?.fix ?? 'Inspect the errors[] payload and correct the input',
          details: { errors: result.errors },
        },
        { operation: 'tasks.add-batch' },
      );
      process.exitCode = ExitCode.VALIDATION_ERROR;
      return;
    }

    // 5. Single dispatch call — atomicity owned by CORE. `payload` is the
    //    already-normalized object form that the validator accepted; reuse
    //    it directly as the wire shape (Record<string, unknown>-compatible).
    const response = await dispatchRaw('mutate', 'tasks', 'add-batch', payload);

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
