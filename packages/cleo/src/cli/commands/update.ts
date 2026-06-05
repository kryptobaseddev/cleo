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

import { ExitCode, TASK_SEVERITIES } from '@cleocode/contracts';
import {
  appendSignedSeverityAttestation,
  INPUT_CONTRACTS,
  isPipelineTransitionForward,
  isValidPipelineStage,
  parseAcceptanceCriteria,
  TASK_PIPELINE_STAGES,
  validateOperationInput,
} from '@cleocode/core';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw, maybeEmitDescribe } from '../../dispatch/adapters/cli.js';
import { collectMutateInput } from '../lib/collect-input.js';
import { cliError, cliOutput } from '../renderers/index.js';

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
    /**
     * Schema-first input — supersedes all flag-based args when present.
     *
     * Accepts a JSON object matching `INPUT_CONTRACTS['tasks.update']`.
     * The `taskId` MUST be present in the JSON payload (positional
     * `taskId` arg is ignored in this path).
     *
     * @task T9917
     */
    params: {
      type: 'string',
      description:
        'Inline JSON object matching INPUT_CONTRACTS["tasks.update"] (T9917). Overrides positional + flags.',
    },
    /**
     * Schema-first input from a JSON file. Same semantics as --params.
     *
     * @task T9917
     */
    'params-file': {
      type: 'string',
      description: 'Path to JSON file matching INPUT_CONTRACTS["tasks.update"] (T9917).',
    },
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
      description:
        'New priority (critical|high|medium|low). Orthogonal to --severity — see `cleo find --urgent` for the unified surface (T9905).',
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
      description:
        'Set labels (comma-separated; lowercase alphanumeric + hyphens + periods only, e.g. "track-b,wave.1") (gh-392)',
      alias: 'l',
    },
    'add-labels': {
      type: 'string',
      description:
        'Add labels (comma-separated; lowercase alphanumeric + hyphens + periods only, e.g. "track-b,wave.1") (gh-392)',
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
        'Severity level (P0|P1|P2|P3) — valid for any --kind (T9073). Orthogonal to --priority — does NOT auto-map (a P0 with priority=medium stays medium). Use `cleo find --urgent` for the unified surface (T9905). Appends signed attestation.',
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
        'Justification (string) to waive the "--depends required for critical priority" check. Only consulted when the task is being promoted to --priority critical AND no existing or new --depends are declared. Stored verbatim in task metadata as audit trail; ignored for non-critical updates. (gh-405 / T1856)',
    },
    /**
     * Related tasks — semantic relationships (non-dependency).
     *
     * Direction convention (gh-403):
     *   `cleo update <fromId> --add-relates <toId>:<type>`
     * creates a directed edge FROM `<fromId>` TO `<toId>` with the given type.
     * Example: `cleo update T127 --add-relates T123:blocks` means
     * "T127 blocks T123" (the task being updated is the source).
     *
     * For dependency edges (T127 must complete before T128 can start), prefer
     * `--add-depends T128` on T127 — `depends` is the canonical dep primitive
     * and is what `cleo orchestrate ready`/`waves` walks. `--add-relates` is for
     * semantic relationships (blocks/supersedes/groups/related) that don't
     * affect wave-order scheduling.
     */
    relates: {
      type: 'string',
      description:
        'Set related tasks (comma-separated, optional type suffix: "T001:blocks,T002"). Direction: <current task> → <relate>. For dep edges, prefer --add-depends. (gh-403)',
    },
    'add-relates': {
      type: 'string',
      description:
        'Add related tasks without overwriting (comma-separated, optional type suffix: "T001:blocks"). Direction: <current task> → <relate>. For dep edges, prefer --add-depends. (gh-403)',
    },
    'remove-relates': {
      type: 'string',
      description: 'Remove related tasks by taskId (comma-separated)',
    },
  },
  async run({ args, cmd }) {
    // T11692 (DHQ-057) — `cleo update --describe` prints the op's I/O schema
    // (updated task lands at /data/updated/0).
    if (maybeEmitDescribe('mutate', 'tasks', 'update', { command: 'update' })) return;

    // T9917: schema-first input path. When --params or --params-file is
    // supplied, collect → validate against INPUT_CONTRACTS['tasks.update']
    // → dispatch directly. The legacy flag-mapping path is skipped.
    const paramsArg = args.params as string | undefined;
    const paramsFileArg = args['params-file'] as string | undefined;
    if (paramsArg !== undefined || paramsFileArg !== undefined) {
      const collectArgs: { params?: string; file?: string } = {};
      if (paramsArg !== undefined) collectArgs.params = paramsArg;
      if (paramsFileArg !== undefined) collectArgs.file = paramsFileArg;

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
            fix: 'Verify the JSON syntax of your --params / --params-file input',
          },
          { operation: 'tasks.update' },
        );
        process.exit(ExitCode.VALIDATION_ERROR);
        return;
      }

      // If the positional `taskId` was passed alongside --params and the
      // payload omits taskId, fold it in for ergonomics (`cleo update T9917
      // --params '{"status":"active"}'` should work).
      if (
        raw !== null &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        (raw as Record<string, unknown>)['taskId'] === undefined &&
        args.taskId !== undefined
      ) {
        (raw as Record<string, unknown>)['taskId'] = args.taskId;
      }

      const contract = INPUT_CONTRACTS['tasks.update'];
      if (!contract) {
        cliError(
          'tasks.update contract missing from INPUT_CONTRACTS registry',
          ExitCode.GENERAL_ERROR,
          { name: 'E_INTERNAL', fix: 'This is a CLI bug — file an issue' },
          { operation: 'tasks.update' },
        );
        process.exit(ExitCode.GENERAL_ERROR);
        return;
      }
      const validation = validateOperationInput(contract, raw);
      if (!validation.ok) {
        cliError(
          'tasks.update failed: validation',
          ExitCode.VALIDATION_ERROR,
          {
            name: 'E_VALIDATION_FAILED',
            fix: validation.errors[0]?.fix ?? 'Inspect errors[] and correct the input',
            details: { errors: validation.errors },
          },
          { operation: 'tasks.update' },
        );
        process.exit(ExitCode.VALIDATION_ERROR);
        return;
      }

      // `raw` is the parsed object that the validator accepted; reuse it
      // directly as the wire shape (Record<string, unknown>-compatible).
      const validatedPayload = raw as Record<string, unknown>;
      const response = await dispatchRaw('mutate', 'tasks', 'update', validatedPayload);
      if (!response.success) {
        cliError(
          response.error?.message ?? 'Update failed',
          response.error?.code ?? 'E_UPDATE_FAILED',
          {
            name: response.error?.code ?? 'E_UPDATE_FAILED',
            fix: response.error?.fix ?? 'Check task fields and try again',
          },
          { operation: 'tasks.update' },
        );
        process.exit(1);
        return;
      }
      cliOutput(response.data, { command: 'update', operation: 'tasks.update' });
      return;
    }

    if (!args.taskId) {
      await showUsage(cmd);
      return;
    }

    // T10341: validate --severity against the canonical TaskSeverity enum
    // BEFORE dispatch. Replaces the late-stage SQLite
    // `CHECK constraint failed: severity` failure mode with a typed
    // E_INVALID_SEVERITY_VALUE that names the valid enum members.
    if (
      args.severity !== undefined &&
      !TASK_SEVERITIES.includes(args.severity as (typeof TASK_SEVERITIES)[number])
    ) {
      const valid = TASK_SEVERITIES.join(', ');
      cliError(
        `severity must be one of: ${valid} — got '${args.severity}'`,
        6,
        {
          name: 'E_INVALID_SEVERITY_VALUE',
          fix: `Pass --severity with one of: ${valid}`,
        },
        { operation: 'tasks.update' },
      );
      process.exit(6);
      return;
    }

    // T10341: validate --pipeline-stage against the canonical
    // TASK_PIPELINE_STAGES enum BEFORE dispatch. Catches both unknown
    // stage names AND backward transitions (pipeline-stage is
    // forward-only per RCASD-IVTR+C). Replaces the late-stage failure
    // (DB CHECK constraint OR opaque core CleoError throw) with a
    // typed E_INVALID_PIPELINE_STAGE that names the valid next stages.
    if (args['pipeline-stage'] !== undefined) {
      const requestedStage = String(args['pipeline-stage']);

      // 1. Unknown stage name — short-circuit with a helpful enum list.
      if (!isValidPipelineStage(requestedStage)) {
        const valid = TASK_PIPELINE_STAGES.join(', ');
        cliError(
          `pipeline-stage must be one of: ${valid} — got '${requestedStage}'`,
          6,
          {
            name: 'E_INVALID_PIPELINE_STAGE',
            fix: `Pass --pipeline-stage with one of: ${valid}`,
          },
          { operation: 'tasks.update' },
        );
        process.exit(6);
        return;
      }

      // 2. Backward transition — fetch existing task to learn current
      // stage and reject if the request would move backward.
      const showResponse = await dispatchRaw('query', 'tasks', 'show', {
        taskId: args.taskId,
      });
      const existingTask = showResponse.success
        ? (showResponse.data as Record<string, unknown> | undefined)
        : undefined;
      const currentStage =
        typeof existingTask?.['pipelineStage'] === 'string'
          ? (existingTask['pipelineStage'] as string)
          : null;

      if (currentStage && !isPipelineTransitionForward(currentStage, requestedStage)) {
        const validForward = TASK_PIPELINE_STAGES.filter((s) => {
          // Same predicate as core's validatePipelineTransition fix hint.
          return isPipelineTransitionForward(currentStage, s);
        }).join(', ');
        cliError(
          `pipeline-stage transition rejected: cannot move backward from '${currentStage}' to '${requestedStage}'. Pipeline stages are forward-only.`,
          6,
          {
            name: 'E_INVALID_PIPELINE_STAGE',
            fix: `Pass --pipeline-stage with a stage at or after '${currentStage}'. Valid forward stages: ${validForward}`,
          },
          { operation: 'tasks.update' },
        );
        process.exit(6);
        return;
      }
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
    // T9839/gh-409: route through bracket+quote-aware parser to preserve
    // criteria containing `ENUM (a|b|c)` or quoted unions like `'a'|'b'`.
    if (args.acceptance) params['acceptance'] = parseAcceptanceCriteria(args.acceptance as string);
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
