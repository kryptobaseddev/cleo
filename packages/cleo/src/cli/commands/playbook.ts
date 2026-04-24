/**
 * CLI command group for playbook runtime operations.
 *
 * Exposes the four HITL playbook subcommands as native citty subcommands:
 *
 *   cleo playbook run <name> [--context '{"k":"v"}']
 *   cleo playbook status <runId>
 *   cleo playbook resume <runId>
 *   cleo playbook list [--status active|completed|pending]
 *
 * All commands route through the canonical dispatch layer via
 * {@link dispatchFromCli} so the LAFS envelope, telemetry, and rate-limit
 * middleware apply uniformly. No per-command output massaging.
 *
 * @task T935
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo playbook run — load a .cantbook by name and execute it via the runtime. */
const runCommand = defineCommand({
  meta: {
    name: 'run',
    description:
      'Execute a playbook (.cantbook) by name — walks the graph until completion or HITL pause',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Playbook name (resolved as <name>.cantbook)',
      required: true,
    },
    context: {
      type: 'string',
      description:
        'JSON object string seeding the initial run context (e.g. \'{"epicId":"T999"}\')',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'playbook',
      'run',
      { name: args.name, context: args.context },
      { command: 'playbook' },
    );
  },
});

/** cleo playbook status — return the current state of a playbook run. */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Return the current state of a playbook run from playbook_runs',
  },
  args: {
    runId: {
      type: 'positional',
      description: 'Playbook run identifier',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'playbook',
      'status',
      { runId: args.runId },
      { command: 'playbook' },
    );
  },
});

/** cleo playbook resume — resume a paused playbook run after its gate is approved. */
const resumeCommand = defineCommand({
  meta: {
    name: 'resume',
    description: 'Resume a paused playbook run once its HITL approval gate is approved',
  },
  args: {
    runId: {
      type: 'positional',
      description: 'Playbook run identifier to resume',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'playbook',
      'resume',
      { runId: args.runId },
      { command: 'playbook' },
    );
  },
});

/**
 * cleo playbook create — scaffold a new user-authored playbook.
 *
 * Dispatches to the `playbook.create` operation which invokes playbook-architect
 * (if available) or scaffolds a static .cantbook template into the project's
 * `.cleo/cant/playbooks/` directory.
 *
 * @task T1275 v2026.4.127 T1259 E2 cleo playbook create CLI verb
 */
const createCommand = defineCommand({
  meta: {
    name: 'create',
    description: 'Scaffold a new .cantbook playbook (invokes playbook-architect meta-agent)',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Playbook name (kebab-case, e.g. "feature-ship")',
      required: true,
    },
    description: {
      type: 'string',
      description: 'Plain-text description of what the playbook should do',
    },
    stages: {
      type: 'string',
      description: 'Comma-separated list of stage names to scaffold (auto-inferred if omitted)',
    },
    'output-dir': {
      type: 'string',
      description: 'Output directory for the .cantbook file (defaults to .cleo/cant/playbooks/)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview what would be created without writing files',
      default: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'playbook',
      'create',
      {
        name: args.name,
        description: args.description,
        stages: args.stages,
        outputDir: args['output-dir'],
        dryRun: args['dry-run'],
      },
      { command: 'playbook' },
    );
  },
});

/** cleo playbook list — enumerate playbook runs with optional status filter. */
const listCommand = defineCommand({
  meta: {
    name: 'list',
    description:
      'List playbook runs (optionally filter by status: active|completed|pending|failed|cancelled)',
  },
  args: {
    status: {
      type: 'string',
      description: 'Filter runs by status (active → running, pending → paused, completed, ...)',
    },
    epic: {
      type: 'string',
      description: 'Filter runs by epic id',
    },
    limit: {
      type: 'string',
      description: 'Maximum number of runs to return',
    },
    offset: {
      type: 'string',
      description: 'Skip the first N runs',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'playbook',
      'list',
      {
        status: args.status,
        epicId: args.epic,
        limit: args.limit !== undefined ? Number.parseInt(args.limit, 10) : undefined,
        offset: args.offset !== undefined ? Number.parseInt(args.offset, 10) : undefined,
      },
      { command: 'playbook' },
    );
  },
});

/**
 * Root `cleo playbook` command group.
 *
 * Delegates to the `playbook` dispatch domain for every subcommand; shows the
 * subcommand usage when invoked without arguments.
 *
 * @task T935
 */
export const playbookCommand = defineCommand({
  meta: {
    name: 'playbook',
    description: 'Playbook runtime operations (run, status, resume, list, create)',
  },
  subCommands: {
    run: runCommand,
    status: statusCommand,
    resume: resumeCommand,
    list: listCommand,
    create: createCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
