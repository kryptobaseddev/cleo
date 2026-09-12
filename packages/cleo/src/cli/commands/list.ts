/**
 * CLI list command — list tasks with optional filters.
 *
 * Dispatches to `tasks.list` via dispatchRaw and renders the result
 * through cliOutput with pagination support.
 *
 * Args are derived from the registry via `paramsToCittyArgs` so that the
 * CLI surface stays in sync with `tasks.list` params[] (T864 SSoT).
 * CLI-only compatibility aliases are layered locally after registry arg
 * derivation so dispatch still receives canonical task params.
 *
 * @task T4460
 * @task T4668
 * @task T864
 * @epic T4454
 */

import { ExitCode } from '@cleocode/contracts';
import { createPage } from '@cleocode/core';
import { defineCommand } from 'citty';
import { dispatchRaw, handleRawError, maybeEmitDescribe } from '../../dispatch/adapters/cli.js';
import {
  getOperationParams,
  paramsToCittyArgs,
  registryParamsToDispatchPayload,
} from '../lib/registry-args.js';
import { cliOutput } from '../renderers/index.js';

const listArgs = {
  ...paramsToCittyArgs(getOperationParams('query', 'tasks', 'list')),
  'parent-id': {
    type: 'string',
    description: 'Alias for --parent (legacy parentId compatibility)',
  },
  // T12123 (GH #1242) — a DISCOVERABLE spelling of the `--limit 0` escape
  // hatch. `options.limit === 0 ? undefined : ...` in core has always meant
  // "no limit" and worked correctly, but it was documented nowhere: `--limit`'s
  // help text said only "Maximum number of tasks to return". So the one flag
  // that made complete enumeration possible was invisible to anyone who had
  // not read the core source, while `--output id` silently returned a page of
  // 10 against a match count of 1075.
  all: {
    type: 'boolean',
    description:
      'Return EVERY matching task instead of the default page of 10 (equivalent to --limit 0).',
  },
  // T9922 — MVI record projection opt-out flags (surfaced for --help).
  verbose: {
    type: 'boolean',
    description:
      'Return full task records instead of the MVI projection (id + title + status + key metadata). T9922.',
  },
  full: {
    type: 'boolean',
    description: 'Alias for --verbose. T9922.',
  },
  // T9932 — 1-line-per-record summary render. Global flag; parsed by cli/index.ts.
  summary: {
    type: 'boolean',
    description:
      'Render each task as a single line "<id> [<status>] <title-truncated-60>". Composes with --output: --output {id|table|count|silent} wins. T9932.',
  },
} as const;

/**
 * cleo list — list tasks with optional filters.
 *
 * Alias `ls` is wired in index.ts.
 */
export const listCommand = defineCommand({
  meta: { name: 'list', description: 'List tasks with optional filters' },
  args: listArgs,
  async run({ args }) {
    // T11692 (DHQ-057) — `cleo list --describe` prints the op's I/O schema.
    // list uses dispatchRaw, so it calls the describe short-circuit directly.
    if (maybeEmitDescribe('query', 'tasks', 'list', { command: 'list' })) return;

    // T12120 (GH #1245/#1248) — forward EVERY registry-declared param instead
    // of hand-copying a subset. The previous hand-written block copied 7 of the
    // 10 declared params, so `--compact` was advertised in `--help` and never
    // delivered, and any param added to the registry later would have been
    // dropped the same way. Deriving payload and flags from the same
    // `ParamDef[]` makes that divergence unrepresentable.
    const declaredParams = getOperationParams('query', 'tasks', 'list');
    const params = registryParamsToDispatchPayload(declaredParams, args as Record<string, unknown>);

    // CLI-only compatibility alias — not a registry param, so forwarded here.
    if (args['parent-id'] !== undefined) params['parent'] ??= args['parent-id'];

    // GH #1242 — `--all` is the discoverable spelling of `--limit 0`. Set it
    // explicitly rather than deleting `limit`, because an ABSENT limit falls
    // back to TASK_LIST_DEFAULT_LIMIT (10), not to "no limit".
    if (args['all'] === true) params['limit'] = 0;

    const limit = typeof params['limit'] === 'number' ? (params['limit'] as number) : undefined;
    const offset = typeof params['offset'] === 'number' ? (params['offset'] as number) : undefined;

    const response = await dispatchRaw('query', 'tasks', 'list', params);

    if (!response.success) {
      handleRawError(response, { command: 'list', operation: 'tasks.list' });
    }

    const rawData = response.data;
    const data =
      (Array.isArray(rawData)
        ? { tasks: rawData, total: rawData.length }
        : (rawData as Record<string, unknown>)) ?? {};
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];

    if (tasks.length === 0) {
      cliOutput(data, { command: 'list', message: 'No tasks found', operation: 'tasks.list' });
      process.exit(ExitCode.NO_DATA);
      return;
    }

    const filtered = (data?.filtered as number) ?? tasks.length;
    const page = response.page ?? createPage({ total: filtered, limit, offset });
    cliOutput(data, { command: 'list', operation: 'tasks.list', page });
  },
});
