/**
 * CLI `cleo update <taskId>` command — update a task's FIELDS.
 *
 * Not to be confused with:
 *   - `cleo upgrade` (see upgrade.ts) — project maintenance (schema/migration repair)
 *   - `cleo self-update` (see self-update.ts) — upgrade the CLI binary itself via npm
 *
 * This command mutates task-row columns (title, status, priority, etc.).
 * Accepts options covering title, status, priority, type, size,
 * phase, description, labels, dependencies, notes, acceptance criteria,
 * files, blocked-by, parent, auto-complete control, pipeline stage,
 * role, scope, and severity.
 *
 * Task CLI command convention: task operations are split root commands, not a
 * `tasks.ts` command group. CLI-only compatibility aliases are normalized in
 * the owning command file before dispatch so the wire params stay canonical.
 *
 * @task T4461
 * @epic T4454
 */

import { appendSignedSeverityAttestation } from '@cleocode/core';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw } from '../../dispatch/adapters/cli.js';
import { cliError } from '../renderers/index.js';

/**
 * Update a task by ID, applying only the fields that are explicitly provided.
 */
export const updateCommand = defineCommand({
  meta: {
    name: 'update',
    description:
      'Update a task. Safe under concurrent invocation — retries on SQLITE_BUSY up to 4 attempts (gh#391).',
  },
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
      description: 'New type (task|epic|subtask)',
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
    'add-files': {
      type: 'string',
      description: 'Add files incrementally (comma-separated)',
    },
    'remove-files': {
      type: 'string',
      description: 'Remove files incrementally (comma-separated)',
    },
    'blocked-by': {
      type: 'string',
      description: 'Set blocked-by reason',
    },
    'clear-blocked-by': {
      type: 'boolean',
      description: 'Clear the blocked-by reason string',
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
     * Task kind axis — intent of work.
     * Values: work | research | experiment | bug | spike | release
     * @task T944
     * @task T9072
     */
    kind: {
      type: 'string',
      description:
        'Task kind / intent axis (work|research|experiment|bug|spike|release) — orthogonal to --type (T944)',
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
     * Severity level — valid for any role (not just bug).
     * Values: P0 | P1 | P2 | P3
     * Orthogonal to --priority — does NOT auto-map priority.
     * Appends a signed attestation to .cleo/audit/severity-attestation.jsonl (T9071/T9073).
     * @task T9073
     */
    severity: {
      type: 'string',
      description:
        'Severity level (P0|P1|P2|P3) — valid for any --role (T9073). Orthogonal to priority. Appends signed attestation.',
    },
    /**
     * Operator-supplied justification required to override the
     * acceptance-criteria immutability guard once a task has entered the
     * implementation pipeline stage. Audit log: `.cleo/audit/ac-changes.jsonl`.
     *
     * @epic T1586 Foundation Lockdown
     * @task T1590
     */
    reason: {
      type: 'string',
      description:
        'Operator override reason for AC-immutability guard (required to mutate --acceptance once stage >= implementation; T1590)',
    },
    /**
     * Waiver for the critical-priority dependency declaration requirement.
     *
     * Critical-priority tasks without declared dependencies silently break
     * wave-order spawning when downstream work assumes they are load-bearing.
     * Provide a justification string to waive the `--depends` requirement.
     * The waiver is stored in task metadata for auditability.
     *
     * @task T1856
     * @epic T1855
     */
    'depends-waiver': {
      type: 'string',
      description:
        'Justification for promoting a task to critical priority without --depends (T1856). Records waiver in task metadata.',
    },
    /**
     * Related tasks — semantic relationships (non-dependency).
     * Comma-separated task IDs with optional type suffix (e.g. "T001:blocks,T002").
     * Default type is 'related'. Replaces existing relates list.
     */
    relates: {
      type: 'string',
      description: 'Set related tasks (comma-separated, optional type suffix: "T001:blocks,T002")',
    },
    'add-relates': {
      type: 'string',
      description:
        'Add related tasks without overwriting existing (comma-separated, optional type suffix)',
    },
    'remove-relates': {
      type: 'string',
      description: 'Remove related tasks by taskId (comma-separated)',
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
    if (args.relates) {
      params['relates'] = (args.relates as string).split(',').map((s) => {
        const [taskId, relType = 'related'] = s.trim().split(':');
        return { taskId: taskId.trim(), type: relType.trim() };
      });
    }
    if (args['add-relates']) {
      params['addRelates'] = (args['add-relates'] as string).split(',').map((s) => {
        const [taskId, relType = 'related'] = s.trim().split(':');
        return { taskId: taskId.trim(), type: relType.trim() };
      });
    }
    if (args['remove-relates']) {
      params['removeRelates'] = (args['remove-relates'] as string).split(',').map((s) => s.trim());
    }
    if (args.notes !== undefined) params['notes'] = args.notes;
    if (args.note !== undefined) params['notes'] = params['notes'] ?? args.note;
    if (args.acceptance)
      params['acceptance'] = (args.acceptance as string)
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
    if (args.files) params['files'] = (args.files as string).split(',').map((s) => s.trim());
    if (args['add-files'])
      params['addFiles'] = (args['add-files'] as string).split(',').map((s) => s.trim());
    if (args['remove-files'])
      params['removeFiles'] = (args['remove-files'] as string).split(',').map((s) => s.trim());
    if (args['blocked-by'] !== undefined) params['blockedBy'] = args['blocked-by'];
    if (args['clear-blocked-by'] === true) params['clearBlockedBy'] = true;
    if (args.parent !== undefined) params['parent'] = args.parent;
    if (args['parent-id'] !== undefined) params['parent'] = params['parent'] ?? args['parent-id'];
    if (args['no-auto-complete'] === true) params['noAutoComplete'] = true;
    if (args['pipeline-stage'] !== undefined) params['pipelineStage'] = args['pipeline-stage'];
    // T944/T9072: --kind is canonical
    if (args.kind !== undefined) params['kind'] = args.kind;
    if (args.scope !== undefined) params['scope'] = args.scope;
    // T9073: severity — orthogonal to priority, valid for any role
    if (args.severity !== undefined) params['severity'] = args.severity;
    // T1590: AC-immutability override reason — forwarded as `reason`.
    if (args.reason !== undefined) params['reason'] = args.reason;

    // T1856: Critical-priority tasks MUST declare dependencies or provide a waiver.
    // When --priority critical is being set, check if the caller is simultaneously
    // declaring depends (via --depends or --add-depends) or providing a waiver.
    // If neither is present, fetch the existing task to check for pre-existing depends
    // before rejecting. Tasks created before this guard (with existing depends) pass.
    if (
      args.priority === 'critical' &&
      !args.depends &&
      !args['add-depends'] &&
      args['depends-waiver'] === undefined
    ) {
      // Fetch the existing task to check for pre-existing dependency declarations.
      const showResponse = await dispatchRaw('query', 'tasks', 'show', {
        taskId: args.taskId,
      });
      const existingTask = showResponse.success
        ? (showResponse.data as Record<string, unknown> | undefined)
        : undefined;
      const existingDepends = existingTask?.['depends'] as unknown[] | undefined;
      const hasDependencies = Array.isArray(existingDepends) && existingDepends.length > 0;

      if (!hasDependencies) {
        cliError(
          'Critical-priority tasks must declare at least one dependency (--depends) or provide a waiver (--depends-waiver "<reason>").',
          'E_VALIDATION',
          {
            name: 'E_VALIDATION',
            fix:
              'Add --depends <taskId> to declare a dependency, or use --depends-waiver "<reason>" ' +
              'to waive the requirement. Use `cleo find "<topic>"` to discover candidate dependencies.',
          },
          { operation: 'tasks.update' },
        );
        process.exit(6);
        return;
      }
    }
    if (args['depends-waiver'] !== undefined) params['dependsWaiver'] = args['depends-waiver'];

    // T9073 / T9071: fire signed severity attestation for any role.
    // Severity is orthogonal to priority — no auto-mapping here.
    // Non-fatal outside CLEO project (falls through).
    if (args.severity !== undefined) {
      try {
        await appendSignedSeverityAttestation({
          timestamp: new Date().toISOString(),
          title: String(args.taskId),
          severity: args.severity,
          taskId: String(args.taskId),
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'E_OWNER_ONLY') {
          cliError((err as Error).message, 72, { name: 'E_OWNER_ONLY' });
          process.exit(72);
          return;
        }
        // Any other failure (e.g. not inside a CLEO project) is non-fatal.
      }
    }

    await dispatchFromCli('mutate', 'tasks', 'update', params, { command: 'update' });
  },
});
