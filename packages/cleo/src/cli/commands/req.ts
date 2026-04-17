/**
 * CLI command group for REQ-ID-addressable acceptance gate management.
 *
 * Subcommands:
 *   cleo req add <taskId> --gate '<json>'   — add a typed AcceptanceGate with a REQ-ID
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
      process.stderr.write(
        'Error: --gate <json> is required.\n' +
          'Example: cleo req add T42 --gate \'{"kind":"test","command":"pnpm test","expect":"pass","description":"Tests pass","req":"TIMER-01"}\'\n',
      );
      process.exit(6);
    }

    await dispatchFromCli('mutate', 'tasks', 'req.add', { taskId, gate }, { command: 'req add' });
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
      'req.migrate',
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
  meta: { name: 'req', description: 'Manage REQ-ID-addressable acceptance gates on tasks' },
  subCommands: {
    add: addCommand,
    list: listCommand,
    migrate: migrateCommand,
  },
  async run({ cmd }) {
    await showUsage(cmd);
  },
});
