/**
 * CLI add command — create a new task.
 *
 * Dispatches to `tasks.add` via dispatchRaw and emits advisory warnings and
 * duplicate / dry-run notices from the response payload.
 *
 * @task T4460
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/**
 * cleo add — create a new task.
 *
 * Accepts a positional title plus a full suite of optional flags that map
 * directly to the `tasks.add` operation parameters.  Pipe-separated
 * acceptance criteria (`--acceptance "AC1|AC2"`) and JSON array format are
 * both supported.
 */
export const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Create a new task (requires active session)',
  },
  args: {
    title: {
      type: 'positional',
      description: 'Task title (3–500 characters)',
      required: true,
    },
    status: {
      type: 'string',
      alias: 's',
      description: 'Task status (pending | active | blocked | done)',
    },
    priority: {
      type: 'string',
      alias: 'p',
      description: 'Task priority (low | medium | high | critical)',
    },
    type: {
      type: 'string',
      alias: 't',
      description: 'Task type (epic | task | subtask | bug)',
    },
    parent: {
      type: 'string',
      description: 'Parent task ID (makes this task a subtask)',
    },
    size: {
      type: 'string',
      description: 'Scope size estimate (small | medium | large)',
    },
    phase: {
      type: 'string',
      alias: 'P',
      description: 'Phase slug to assign the task to',
    },
    description: {
      type: 'string',
      alias: 'd',
      description: 'Detailed task description (must differ meaningfully from title)',
    },
    desc: {
      type: 'string',
      description: 'Task description (alias for --description)',
    },
    labels: {
      type: 'string',
      alias: 'l',
      description: 'Comma-separated labels',
    },
    files: {
      type: 'string',
      description: 'Comma-separated file paths',
    },
    acceptance: {
      type: 'string',
      description: 'Pipe-separated acceptance criteria (e.g. "AC1|AC2|AC3")',
    },
    depends: {
      type: 'string',
      alias: 'D',
      description: 'Comma-separated dependency task IDs',
    },
    notes: {
      type: 'string',
      description: 'Initial note entry for the task',
    },
    position: {
      type: 'string',
      description: 'Position within sibling group',
    },
    'parent-search': {
      type: 'string',
      description: 'Resolve parent by title substring instead of exact ID (T090)',
    },
    'add-phase': {
      type: 'boolean',
      description: 'Create new phase if it does not exist',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Show what would be created without making changes',
    },
  },
  async run({ args }) {
    const params: Record<string, unknown> = { title: args.title };

    if (args.status !== undefined) params['status'] = args.status;
    if (args.priority !== undefined) params['priority'] = args.priority;
    if (args.type !== undefined) params['type'] = args.type;
    if (args.parent !== undefined) params['parent'] = args.parent;
    if (args.size !== undefined) params['size'] = args.size;
    if (args.phase !== undefined) params['phase'] = args.phase;
    if (args['add-phase'] !== undefined) params['addPhase'] = args['add-phase'];
    if (args.description !== undefined) {
      params['description'] = args.description;
    } else if (args.desc !== undefined) {
      params['description'] = args.desc;
    }
    if (args.labels) params['labels'] = (args.labels as string).split(',').map((s) => s.trim());
    if (args.files) params['files'] = (args.files as string).split(',').map((s) => s.trim());
    if (args.acceptance) {
      const raw = args.acceptance as string;
      // Support JSON array format: --acceptance '["c1","c2","c3"]' (T090)
      if (raw.trimStart().startsWith('[')) {
        try {
          const parsed = JSON.parse(raw);
          params['acceptance'] = Array.isArray(parsed)
            ? parsed.map((s: unknown) => String(s).trim()).filter(Boolean)
            : [raw];
        } catch {
          // Not valid JSON — fall through to pipe-delimited parsing
          params['acceptance'] = raw
            .split('|')
            .map((s) => s.trim())
            .filter(Boolean);
        }
      } else {
        params['acceptance'] = raw
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
    if (args.depends) params['depends'] = (args.depends as string).split(',').map((s) => s.trim());
    if (args.notes !== undefined) params['notes'] = args.notes;
    if (args.position !== undefined)
      params['position'] = Number.parseInt(args.position as string, 10);
    if (args['dry-run'] !== undefined) params['dryRun'] = args['dry-run'];
    if (args['parent-search'] !== undefined) params['parentSearch'] = args['parent-search'];

    const response = await dispatchRaw('mutate', 'tasks', 'add', params);

    if (!response.success) {
      handleRawError(response, { command: 'add', operation: 'tasks.add' });
    }

    const data = response.data as Record<string, unknown>;

    // Display advisory warnings (T089: orphan prevention, etc.)
    const dataWarnings = data?.warnings as string[] | undefined;
    if (dataWarnings?.length) {
      for (const w of dataWarnings) {
        process.stderr.write(`⚠ ${w}\n`);
      }
    }

    if (data?.duplicate) {
      cliOutput(data, {
        command: 'add',
        message: 'Task with identical title was created recently',
        operation: 'tasks.add',
      });
    } else if (data?.dryRun) {
      cliOutput(data, {
        command: 'add',
        message: 'Dry run - no changes made',
        operation: 'tasks.add',
      });
    } else {
      cliOutput(data, { command: 'add', operation: 'tasks.add' });
    }
  },
});
