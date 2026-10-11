/**
 * CLI command group for REQ-ID-addressable acceptance gate management.
 *
 * Subcommands:
 *   cleo req add <taskId> --gate '<json>'   — add a typed AcceptanceGate with a REQ-ID
 *   cleo req replace <taskId> <REQ-ID> --gate '<json>' [--reason] — replace a gate in place
 *   cleo req list <taskId>                  — list all REQ-ID gates on a task
 *   cleo req migrate <taskId> [--apply]     — heuristic migrator for free-text criteria
 *
 * All output is JSON-envelope compliant (success + data).
 * Validation against the AcceptanceGate Zod schema happens server-side
 * (in the dispatch layer) before any write is performed.
 *
 * @epic T760
 * @task T782
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliError } from '../renderers/index.js';

/** cleo req add <task-id> — add a typed AcceptanceGate (with REQ-ID) to a task */
const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: "Add a typed AcceptanceGate (with REQ-ID) to a task's acceptance array",
  },
  args: {
    'task-id': {
      type: 'positional',
      description: 'Task ID to add the gate to',
      required: true,
    },
    gate: {
      type: 'string',
      description:
        'AcceptanceGate JSON string (must match the AcceptanceGate schema; include "req" for a REQ-ID)',
      required: true,
    },
  },
  async run({ args }) {
    const taskId = args['task-id'];
    const gate = args.gate;

    if (!gate) {
      cliError(
        '--gate <json> is required.',
        6,
        {
          name: 'E_VALIDATION',
          fix: 'Example: cleo req add T42 --gate \'{"kind":"test","command":"pnpm test","expect":"pass","description":"Tests pass","req":"TIMER-01"}\'',
        },
        { operation: 'tasks.req.add' },
      );
      process.exit(6);
    }

    await dispatchFromCli('mutate', 'tasks', 'req.add', { taskId, gate }, { command: 'req add' });
  },
});

/** cleo req replace <task-id> <req-id> — replace a typed gate's definition in place (T12988) */
const replaceCommand = defineCommand({
  meta: {
    name: 'replace',
    description:
      "Replace a typed gate's definition (command, args, cwd, …) in place. Keeps its AC row, ordinal and REQ-ID; " +
      'the superseded gate stays in AC history and the audit log, and the new gate must be verified again. ' +
      'Prefer a repo-relative command and cwd (no absolute --dir), so the gate runs in whichever checkout verifies.',
  },
  args: {
    'task-id': {
      type: 'positional',
      description: 'Task ID that owns the gate',
      required: true,
    },
    'req-id': {
      type: 'positional',
      description: 'REQ-ID of the gate to replace',
      required: true,
    },
    gate: {
      type: 'string',
      description: 'Replacement AcceptanceGate JSON; "req" must be absent or equal the REQ-ID',
      required: true,
    },
    reason: {
      type: 'string',
      description: 'Why the gate changes; required once the task is in a locked pipeline stage',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'req.replace',
      {
        taskId: args['task-id'],
        req: args['req-id'],
        gate: args.gate,
        ...(args.reason ? { reason: args.reason } : {}),
      },
      { command: 'req replace' },
    );
  },
});

/** cleo req list <task-id> — list all REQ-ID-addressed acceptance gates on a task */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List all REQ-ID-addressed acceptance gates on a task' },
  args: {
    'task-id': {
      type: 'positional',
      description: 'Task ID to list gates for',
      required: true,
    },
  },
  async run({ args }) {
    const taskId = args['task-id'];
    await dispatchFromCli('query', 'tasks', 'req.list', { taskId }, { command: 'req list' });
  },
});

/** cleo req migrate <task-id> — heuristic migrator for free-text acceptance criteria */
const migrateCommand = defineCommand({
  meta: {
    name: 'migrate',
    description:
      'Heuristic migrator: propose (or apply) typed gate replacements for free-text acceptance strings. ' +
      'Heuristics: "tests pass" → test gate, "<file> exists" → file gate, ' +
      '"lint clean" → lint gate, "<cmd> returns 0" → command gate, otherwise → manual gate.',
  },
  args: {
    'task-id': {
      type: 'positional',
      description: 'Task ID to migrate gates for',
      required: true,
    },
    apply: {
      type: 'boolean',
      description:
        'Write the proposed typed gates back to the task (default: dry-run, print proposals only)',
    },
  },
  async run({ args }) {
    const taskId = args['task-id'];
    const apply = Boolean(args.apply);
    await dispatchFromCli(
      apply ? 'mutate' : 'query',
      'tasks',
      apply ? 'req.migrate' : 'req.migrate.preview',
      { taskId, apply },
      { command: 'req migrate' },
    );
  },
});

/**
 * Root req command group — manages REQ-ID-addressable acceptance gates.
 *
 * Dispatches to `tasks.req.*` registry operations.
 *
 * @example
 * ```bash
 * # Add a test gate with REQ-ID TIMER-01
 * cleo req add T42 --gate '{"kind":"test","command":"pnpm test","expect":"pass","description":"Tests pass","req":"TIMER-01"}'
 *
 * # Replace TIMER-01's command with a repo-relative one
 * cleo req replace T42 TIMER-01 --gate '{"kind":"test","command":"pnpm","args":["--filter","app","exec","vitest","run"],"expect":"pass","description":"Tests pass"}'
 *
 * # List all REQ-ID gates on T42
 * cleo req list T42
 *
 * # Preview migration proposals for T42 (dry-run)
 * cleo req migrate T42
 *
 * # Apply migration (write typed gates back to the task)
 * cleo req migrate T42 --apply
 * ```
 */
export const reqCommand = defineCommand({
  meta: {
    name: 'req',
    description:
      'Manage REQ-ID-addressable acceptance gates on tasks (in-task gates only). For cross-task dependency edges, use `cleo update <id> --add-depends <ids>` or `cleo update <id> --add-relates <id>:blocks` (gh-394).',
  },
  subCommands: {
    add: addCommand,
    replace: replaceCommand,
    list: listCommand,
    migrate: migrateCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
