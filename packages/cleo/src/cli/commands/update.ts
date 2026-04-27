/**
 * CLI `cleo update <taskId>` command — update a task's FIELDS.
 *
 * Not to be confused with:
 *   - `cleo upgrade` (see upgrade.ts) — project maintenance (schema/migration repair)
 *   - `cleo self-update` (see self-update.ts) — upgrade the CLI binary itself via npm
 *
 * This command mutates task-row columns (title, status, priority, etc.).
 * Accepts up to 20 options covering title, status, priority, type, size,
 * phase, description, labels, dependencies, notes, acceptance criteria,
 * files, blocked-by, parent, auto-complete control, pipeline stage,
 * role, and scope.
 *
 * Task CLI command convention: task operations are split root commands, not a
 * `tasks.ts` command group. CLI-only compatibility aliases are normalized in
 * the owning command file before dispatch so the wire params stay canonical.
 *
 * @task T4461
 * @epic T4454
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Update a task by ID, applying only the fields that are explicitly provided.
 */
export const updateCommand = defineCommand({
  meta: { name: 'update', description: 'Update a task' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to update',
      required: false,
    },
    title: {
      type: 'string',
      description: 'New title',
    },
    status: {
      type: 'string',
      description: 'New status (pending|active|blocked|done|cancelled)',
      alias: 's',
    },
    priority: {
      type: 'string',
      description: 'New priority (critical|high|medium|low)',
      alias: 'p',
    },
    type: {
      type: 'string',
      description: 'New type (task|epic|subtask|bug)',
      alias: 't',
    },
    size: {
      type: 'string',
      description: 'New size',
    },
    phase: {
      type: 'string',
      description: 'New phase',
      alias: 'P',
    },
    description: {
      type: 'string',
      description: 'New description',
      alias: 'd',
    },
    labels: {
      type: 'string',
      description: 'Set labels (comma-separated)',
      alias: 'l',
    },
    'add-labels': {
      type: 'string',
      description: 'Add labels (comma-separated)',
    },
    'remove-labels': {
      type: 'string',
      description: 'Remove labels (comma-separated)',
    },
    depends: {
      type: 'string',
      description: 'Set dependencies (comma-separated)',
      alias: 'D',
    },
    'add-depends': {
      type: 'string',
      description: 'Add dependencies (comma-separated)',
    },
    'remove-depends': {
      type: 'string',
      description: 'Remove dependencies (comma-separated)',
    },
    notes: {
      type: 'string',
      description: 'Add a note',
    },
    note: {
      type: 'string',
      description: 'Alias for --notes',
    },
    acceptance: {
      type: 'string',
      description: 'Set acceptance criteria (pipe-separated, e.g. "AC1|AC2|AC3")',
    },
    files: {
      type: 'string',
      description: 'Set files (comma-separated)',
    },
    'blocked-by': {
      type: 'string',
      description: 'Set blocked-by reason',
    },
    parent: {
      type: 'string',
      description: 'Set parent ID',
    },
    'parent-id': {
      type: 'string',
      description: 'Alias for --parent (legacy parentId compatibility)',
    },
    'no-auto-complete': {
      type: 'boolean',
      description: 'Disable auto-complete for epic',
    },
    'pipeline-stage': {
      type: 'string',
      description:
        'Set pipeline stage (forward-only: research|consensus|architecture_decision|specification|decomposition|implementation|validation|testing|release|contribution)',
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
     * @task T1472
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
  },
  async run({ args, cmd }) {
    if (!args.taskId) {
      await showUsage(cmd);
      return;
    }
    const params: Record<string, unknown> = { taskId: args.taskId };

    if (args.title !== undefined) params['title'] = args.title;
    if (args.status !== undefined) params['status'] = args.status;
    if (args.priority !== undefined) params['priority'] = args.priority;
    if (args.type !== undefined) params['type'] = args.type;
    if (args.size !== undefined) params['size'] = args.size;
    if (args.phase !== undefined) params['phase'] = args.phase;
    if (args.description !== undefined) params['description'] = args.description;
    if (args.labels) params['labels'] = (args.labels as string).split(',').map((s) => s.trim());
    if (args['add-labels'])
      params['addLabels'] = (args['add-labels'] as string).split(',').map((s) => s.trim());
    if (args['remove-labels'])
      params['removeLabels'] = (args['remove-labels'] as string).split(',').map((s) => s.trim());
    if (args.depends) params['depends'] = (args.depends as string).split(',').map((s) => s.trim());
    if (args['add-depends'])
      params['addDepends'] = (args['add-depends'] as string).split(',').map((s) => s.trim());
    if (args['remove-depends'])
      params['removeDepends'] = (args['remove-depends'] as string).split(',').map((s) => s.trim());
    if (args.notes !== undefined) params['notes'] = args.notes;
    if (args.note !== undefined) params['notes'] = params['notes'] ?? args.note;
    if (args.acceptance)
      params['acceptance'] = (args.acceptance as string)
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
    if (args.files) params['files'] = (args.files as string).split(',').map((s) => s.trim());
    if (args['blocked-by'] !== undefined) params['blockedBy'] = args['blocked-by'];
    if (args.parent !== undefined) params['parent'] = args.parent;
    if (args['parent-id'] !== undefined) params['parent'] = params['parent'] ?? args['parent-id'];
    if (args['no-auto-complete'] === true) params['noAutoComplete'] = true;
    if (args['pipeline-stage'] !== undefined) params['pipelineStage'] = args['pipeline-stage'];
    // T944: orthogonal axes
    if (args.role !== undefined) params['role'] = args.role;
    if (args.kind !== undefined) params['role'] = params['role'] ?? args.kind;
    if (args.scope !== undefined) params['scope'] = args.scope;

    await dispatchFromCli('mutate', 'tasks', 'update', params, { command: 'update' });
  },
});
