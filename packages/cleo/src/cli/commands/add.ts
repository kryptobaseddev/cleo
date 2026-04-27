/**
 * CLI add command — create a new task.
 *
 * Task CLI command convention: CLEO intentionally exposes task operations as
 * split root commands (`add`, `update`, `list`, etc.) instead of a
 * `tasks.ts` command group. Keep CLI-only compatibility aliases in the
 * command file that owns the flag, then dispatch only canonical task params.
 *
 * Dispatches to `tasks.add` via dispatchRaw and emits advisory warnings and
 * duplicate / dry-run notices from the response payload.
 *
 * @task T4460
 * @epic T4454
 */

import { getProjectRoot, inferTaskAddParams } from '@cleocode/core';
import { defineCommand, showUsage } from 'citty';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/**
 * cleo add — create a new task.
 *
 * Accepts a positional title plus a full suite of optional flags that map
 * directly to the `tasks.add` operation parameters.  Pipe-separated
 * acceptance criteria (`--acceptance "AC1|AC2"`) and JSON array format are
 * both supported.
 *
 * T944 additions: `--role` (intent axis) and `--scope` (granularity axis).
 * `--kind` is accepted as a backward-compatible alias for `--role`.
 * `--parent-id` and `--note` are CLI-only compatibility aliases for
 * `--parent` and `--notes`.
 *
 * T1329: In strict mode, if no explicit `--parent` is provided and the task
 * type is not 'epic', the command attempts to infer `--parent` from the active
 * session's current task (`session.taskWork.taskId`). This reduces friction for
 * creating subtasks under the active focus task.
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
      required: false,
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
    'parent-id': {
      type: 'string',
      description: 'Alias for --parent (legacy parentId compatibility)',
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
    'files-infer': {
      type: 'boolean',
      description: 'Infer touched files from task title and description using GitNexus',
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
    note: {
      type: 'string',
      description: 'Alias for --notes',
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
    /**
     * Task role axis — intent of work.
     * Values: work | research | experiment | bug | spike | release
     * @task T944
     */
    role: {
      type: 'string',
      description:
        'Task role / intent axis (work|research|experiment|bug|spike|release) — orthogonal to --type (T944)',
    },
    /**
     * Backward-compatible alias for --role (fractal-ontology spec used "kind").
     * @task T944
     */
    kind: {
      type: 'string',
      description: 'Alias for --role (T944 fractal-ontology compat)',
    },
    /**
     * Task scope axis — granularity of work.
     * Values: project | feature | unit
     * @task T944
     */
    scope: {
      type: 'string',
      description:
        'Task scope / granularity axis (project|feature|unit) — orthogonal to --type (T944)',
    },
    /**
     * Bug severity. Only valid when --role bug.
     * Values: P0 | P1 | P2 | P3
     * @task T944
     */
    severity: {
      type: 'string',
      description: 'Bug severity (P0|P1|P2|P3) — only valid with --role bug (T944)',
    },
  },
  async run({ args, cmd }) {
    if (!args.title) {
      await showUsage(cmd);
      return;
    }
    const params: Record<string, unknown> = { title: args.title };

    if (args.status !== undefined) params['status'] = args.status;
    if (args.priority !== undefined) params['priority'] = args.priority;
    if (args.type !== undefined) params['type'] = args.type;
    if (args.parent !== undefined) params['parent'] = args.parent;
    if (args['parent-id'] !== undefined) params['parent'] = params['parent'] ?? args['parent-id'];
    if (args.size !== undefined) params['size'] = args.size;
    if (args.phase !== undefined) params['phase'] = args.phase;
    if (args['add-phase'] !== undefined) params['addPhase'] = args['add-phase'];
    if (args.description !== undefined) {
      params['description'] = args.description;
    } else if (args.desc !== undefined) {
      params['description'] = args.desc;
    }
    if (args.labels) params['labels'] = (args.labels as string).split(',').map((s) => s.trim());

    if (args.depends) params['depends'] = (args.depends as string).split(',').map((s) => s.trim());
    if (args.notes !== undefined) params['notes'] = args.notes;
    if (args.note !== undefined) params['notes'] = params['notes'] ?? args.note;
    if (args.position !== undefined)
      params['position'] = Number.parseInt(args.position as string, 10);
    if (args['dry-run'] !== undefined) params['dryRun'] = args['dry-run'];
    if (args['parent-search'] !== undefined) params['parentSearch'] = args['parent-search'];
    // T944: orthogonal axes — --kind is a CLI alias for --role (ADR-057 D2)
    // Aliasing lives at the CLI layer; wire format only uses 'role'.
    if (args.role !== undefined) params['role'] = args.role;
    if (args.kind !== undefined)
      params['role'] = (params['role'] as string | undefined) ?? args.kind;
    if (args.scope !== undefined) params['scope'] = args.scope;
    if (args.severity !== undefined) params['severity'] = args.severity;

    // T1490: Delegate file inference, acceptance parsing, and parent inference
    // to Core so the CLI layer stays a thin parse-and-delegate shell.
    // Stderr output (warnings, notices) remains here in the CLI layer.
    const inferred = await inferTaskAddParams(getProjectRoot(), {
      title: args.title,
      description: (args.description ?? args.desc) as string | undefined,
      filesInfer: args['files-infer'] as boolean | undefined,
      filesRaw: args.files as string | undefined,
      acceptanceRaw: args.acceptance as string | undefined,
      parentRaw: params['parent'] as string | undefined,
      type: params['type'] as string | undefined,
    });

    // Emit stderr notices (CLI responsibility — Core never writes to stderr)
    if (inferred.filesInferWarning) {
      process.stderr.write(
        '⚠ No files inferred by GitNexus. Use --files to specify files explicitly, or leave empty for atomicity check at spawn time.\n',
      );
    }
    if (inferred.files) params['files'] = inferred.files;
    if (inferred.acceptance) params['acceptance'] = inferred.acceptance;
    // T1329: parent inference from active session's current task
    if (inferred.inferredParent) {
      params['parent'] = inferred.inferredParent;
      process.stderr.write(
        `[cleo add] inferred --parent from current task: ${inferred.inferredParent}\n`,
      );
    }

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
