/**
 * CLI show command.
 * @task T4460
 * @task T864
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli, dispatchRaw } from '../../dispatch/adapters/cli.js';
import { getOperationParams, paramsToCittyArgs } from '../lib/registry-args.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Native citty command for `cleo show` — retrieves full task details by ID,
 * including metadata, verification, and lifecycle information.
 *
 * Args are derived from the registry via `paramsToCittyArgs` so that the
 * CLI surface stays in sync with `tasks.show` params[] (T864 SSoT).
 *
 * @task T4460
 * @task T4666
 * @task T787
 * @task T864
 * @epic T487
 */
export const showCommand = defineCommand({
  meta: {
    name: 'show',
    description:
      'Show task details by ID. Accepts SEVERAL ids — `cleo show T1 T2 T3` returns them in one envelope and pays CLI startup once instead of per task (gh#1207). MVI-projected (id + title + status + key metadata) by default; pass --verbose / --full to receive the complete record with description, acceptance, verification, evidence, etc. (T9922)',
  },
  args: {
    ...paramsToCittyArgs(getOperationParams('query', 'tasks', 'show')),
    // T9922 — MVI record projection opt-out flags. The global parser in
    // cli/index.ts reads these too; the declarations here surface them in
    // `cleo show --help` and document the contract for agents.
    verbose: {
      type: 'boolean',
      description:
        'Return the full task record (description, acceptance, verification, evidence) instead of the MVI projection. T9922.',
    },
    full: {
      type: 'boolean',
      description: 'Alias for --verbose. T9922.',
    },
    // T9932 — 1-line summary render. Global flag; parsed by cli/index.ts.
    summary: {
      type: 'boolean',
      description:
        'Render the task as a single line "<id> [<status>] <title-truncated-60>". Composes with --output: --output {id|table|count|silent} wins. T9932.',
    },
  },
  async run({ args }) {
    const shared = {
      history: args['history'] === true,
      ivtrHistory: args['ivtr-history'] === true,
      relations: args['relations'] === true,
    };

    // gh#1207: batch lookup. CLI startup is a FIXED ~1.3s floor paid before any
    // command work — measured, and dominated by module loading rather than the
    // query. So a 25-task status sweep spent ~33s of its 2.5 minutes just
    // starting Node 25 times. Accepting several ids amortises that floor across
    // one process instead of paying it per task.
    //
    // A single id keeps the exact prior envelope, byte for byte: batching must
    // not change the shape every existing caller and script parses.
    const ids = collectTaskIds(args);
    if (ids.length <= 1) {
      await dispatchFromCli(
        'query',
        'tasks',
        'show',
        { taskId: args['taskId'] as string, ...shared },
        { command: 'show' },
      );
      return;
    }

    const tasks: unknown[] = [];
    const notFound: Array<{ taskId: string; reason: string }> = [];
    for (const taskId of ids) {
      const res = await dispatchRaw('query', 'tasks', 'show', { taskId, ...shared });
      if (res.success) {
        tasks.push(res.data);
      } else {
        // One bad id must not discard the other N-1 results — that would make
        // the batch strictly worse than the loop it replaces.
        notFound.push({
          taskId,
          reason: res.error?.message ?? 'not found',
        });
      }
    }

    cliOutput(
      { tasks, count: tasks.length, requested: ids.length, notFound },
      { command: 'show', operation: 'tasks.show.batch' },
    );

    // Exit non-zero when any id failed, so a script cannot read a partial
    // batch as a complete one.
    if (notFound.length > 0 && (process.exitCode ?? 0) === 0) {
      process.exitCode = 1;
    }
  },
});

/**
 * Collect the task ids for this invocation, in order, de-duplicated.
 *
 * citty binds the first positional to `taskId` and leaves the rest in `_`, so
 * `cleo show T1 T2 T3` arrives as `taskId: 'T1'` plus `_: ['T2', 'T3']` (some
 * versions repeat the first — hence the de-duplication rather than a blind
 * concat).
 *
 * @param args - Parsed citty args.
 * @returns Ordered, de-duplicated task ids.
 *
 * @task T12141 (gh#1207)
 */
function collectTaskIds(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v !== 'string') return;
    const id = v.trim();
    if (id.length === 0 || id.startsWith('-')) return;
    if (!out.includes(id)) out.push(id);
  };
  push(args['taskId']);
  const rest = args['_'];
  if (Array.isArray(rest)) for (const v of rest) push(v);
  return out;
}
