/**
 * CLI find command
 * @task T4460
 * @task T4668
 * @task T487
 */
import { ExitCode } from '@cleocode/contracts';
import { createPage } from '@cleocode/core';
import { defineCommand } from 'citty';
import { dispatchRaw, handleRawError, maybeEmitDescribe } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';
/** Native citty command for `cleo find [query]`. */
export const findCommand = defineCommand({
  meta: { name: 'find', description: 'Fuzzy search tasks by title/description' },
  args: {
    query: {
      type: 'positional',
      description: 'Search text (required unless --id is provided)',
      required: false,
    },
    id: { type: 'string', description: 'Search by ID prefix' },
    exact: { type: 'boolean', description: 'Exact title match' },
    status: {
      type: 'string',
      description: 'Filter by status (pending|active|blocked|done|cancelled)',
    },
    in: { type: 'string', description: 'Field to search in (title|description|notes|id)' },
    'include-archive': { type: 'boolean', description: 'Include archived tasks' },
    limit: { type: 'string', description: 'Max results (default: 20)' },
    offset: { type: 'string', description: 'Skip first N results' },
    fields: { type: 'string', description: 'Comma-separated additional fields to include' },
    verbose: {
      type: 'boolean',
      description:
        'Return full task records instead of the MVI projection (id + title + status + key metadata). T9922.',
      alias: 'v',
    },
    // T9922 — MVI record projection opt-out alias (surfaced for --help).
    full: {
      type: 'boolean',
      description: 'Alias for --verbose. T9922.',
    },
    /**
     * Filter by task kind axis (T944/T9072).
     * Values: work | research | experiment | bug | spike | release
     */
    kind: {
      type: 'string',
      description: 'Filter by kind axis (work|research|experiment|bug|spike|release) — T944',
    },
    /**
     * Unified urgency surface (T9905).
     *
     * Selects tasks where
     *   priority IN ('critical','high') OR severity IN ('P0','P1')
     *
     * Combines the two orthogonal urgency axes (priority + severity) into a
     * single filter so agents don't have to query each axis separately.
     */
    urgent: {
      type: 'boolean',
      description:
        'Surface urgent work across both axes: priority IN (critical,high) OR severity IN (P0,P1) (T9905)',
      alias: 'u',
    },
    /**
     * Filter by label — `cleo find --label <name>` returns every task
     * whose `labels[]` includes the given value. Closes GH#393 and gives
     * `find` parity with the positional `cleo labels <name>` surface.
     * @task T9904
     */
    label: {
      type: 'string',
      description: 'Filter by label — return tasks whose labels[] includes this value (T9904)',
    },
    /**
     * Filter by parent task ID — `cleo find --parent <id>` returns only
     * tasks whose `parentId` matches. Mirrors the `--parent` axis on
     * `cleo list`. When the parent target is a Saga (Epic with
     * `label='saga'`), routing goes through `task_relations.type='groups'`
     * member IDs (ADR-073 §1) — same path as `cleo list --parent`.
     *
     * Closes T10108 — pre-fix the flag was missing entirely AND empty-string
     * queries bypassed every filter via `fuzzyScore('', '<title>')===80`.
     *
     * @task T10108
     * @saga T9862
     */
    parent: {
      type: 'string',
      description:
        'Filter by parent task ID — Saga-aware via task_relations groups (ADR-073 §1) (T10108)',
    },
  },
  async run({ args }) {
    // T11692 (DHQ-057) — `cleo find --describe` prints the op's I/O schema.
    // find uses dispatchRaw, so it calls the describe short-circuit directly.
    if (maybeEmitDescribe('query', 'tasks', 'find', { command: 'find' })) return;

    const limit = args.limit !== undefined ? Number.parseInt(args.limit, 10) : undefined;
    const offset = args.offset !== undefined ? Number.parseInt(args.offset, 10) : undefined;
    const params: Record<string, unknown> = {};
    if (args.query !== undefined) params['query'] = args.query;
    if (args.id !== undefined) params['id'] = args.id;
    if (args.exact !== undefined) params['exact'] = args.exact;
    if (args.status !== undefined) params['status'] = args.status;
    if (args.in !== undefined) params['field'] = args.in;
    if (args['include-archive'] !== undefined) params['includeArchive'] = args['include-archive'];
    if (limit !== undefined) params['limit'] = limit;
    if (offset !== undefined) params['offset'] = offset;
    if (args.fields !== undefined) params['fields'] = args.fields;
    if (args.verbose !== undefined) params['verbose'] = args.verbose;
    // T944/T9072: kind filter
    if (args.kind !== undefined) params['kind'] = args.kind;
    // T9905: unified urgency surface — only forward when the flag was set
    if (args.urgent !== undefined) params['urgent'] = args.urgent;
    // T9904: label filter — forward when set
    if (args.label !== undefined) params['label'] = args.label;
    // T10108: parent filter — forward when set
    if (args.parent !== undefined) params['parent'] = args.parent;
    const response = await dispatchRaw('query', 'tasks', 'find', params);
    if (!response.success) {
      handleRawError(response, { command: 'find', operation: 'tasks.find' });
    }
    const rawData = response.data;
    const data =
      (Array.isArray(rawData)
        ? { results: rawData, total: rawData.length }
        : (rawData as Record<string, unknown>)) ?? {};
    const results = Array.isArray(data?.results) ? data.results : [];
    if (results.length === 0) {
      cliOutput(data, {
        command: 'find',
        message: 'No matching tasks found',
        operation: 'tasks.find',
      });
      process.exit(ExitCode.NO_DATA);
      return;
    }
    const total = (data?.total as number) ?? results.length;
    const page = createPage({ total, limit, offset });
    cliOutput(data, { command: 'find', operation: 'tasks.find', page });
  },
});
