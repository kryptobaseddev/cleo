/**
 * CLEO CLI - Clean citty-based command interface
 *
 * Thin wrapper around the dispatch layer. Each command maps CLI arguments
 * to a dispatch call (domain, operation, params).
 *
 * @example
 * cleo add "Task title" --priority high
 * → dispatch('mutate', 'tasks', 'add', { title: "Task title", priority: "high" })
 */

import { type CommandDef, defineCommand, runMain } from 'citty';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../dispatch/adapters/cli.js';
import { cliOutput } from './renderers/index.js';

const CLI_VERSION = '2026.3.38';

// ============================================================================
// Type Definitions
// ============================================================================

/** CLI argument definition - strict typing, no 'any' */
interface StringArg {
  type: 'positional';
  description: string;
  required?: boolean;
}

interface StringOption {
  type: 'string';
  description: string;
  alias?: string;
  default?: string;
}

interface BooleanOption {
  type: 'boolean';
  description: string;
  alias?: string;
  default?: boolean;
}

interface EnumOption {
  type: 'enum';
  description: string;
  options: readonly string[];
  alias?: string;
  default?: string;
}

type ArgDef = StringArg | StringOption | BooleanOption | EnumOption;

/** Command handler function */
type CommandHandler<TArgs extends Record<string, ArgDef>> = (
  args: {
    [K in keyof TArgs]: TArgs[K] extends { type: 'positional'; required: true }
      ? string
      : TArgs[K] extends { type: 'positional' }
        ? string | undefined
        : TArgs[K] extends { type: 'string'; required: true }
          ? string
          : TArgs[K] extends { type: 'string' }
            ? string | undefined
            : TArgs[K] extends { type: 'boolean'; required: true }
              ? boolean
              : TArgs[K] extends { type: 'boolean' }
                ? boolean | undefined
                : TArgs[K] extends { type: 'enum'; required: true }
                  ? TArgs[K]['options'][number]
                  : TArgs[K] extends { type: 'enum' }
                    ? TArgs[K]['options'][number] | undefined
                    : never;
  },
) => Promise<void> | void;

// ============================================================================
// Command Registry
// ============================================================================

const commands: Record<string, CommandDef> = {};

/**
 * Helper to define a command with full type safety
 */
function cmd<const TArgs extends Record<string, ArgDef>>(
  name: string,
  description: string,
  args: TArgs,
  handler: CommandHandler<TArgs>,
): void {
  commands[name] = defineCommand({
    meta: { name, description },
    args: args as Record<string, import('citty').ArgDef>,
    async run({ args }) {
      await handler(args as Parameters<typeof handler>[0]);
    },
  });
}

// ============================================================================
// Task Commands
// ============================================================================

cmd(
  'add',
  'Create a new task',
  {
    title: { type: 'positional', description: 'Task title', required: true },
    status: { type: 'string', description: 'Task status', alias: 's' },
    priority: {
      type: 'enum',
      description: 'Priority level',
      options: ['low', 'medium', 'high', 'critical'] as const,
      alias: 'p',
    },
    type: {
      type: 'enum',
      description: 'Task type',
      options: ['epic', 'task', 'subtask'] as const,
      alias: 't',
    },
    parent: { type: 'string', description: 'Parent task ID' },
    size: {
      type: 'enum',
      description: 'Scope size',
      options: ['small', 'medium', 'large'] as const,
    },
    phase: { type: 'string', description: 'Phase slug', alias: 'P' },
    description: { type: 'string', description: 'Task description', alias: 'd' },
    labels: { type: 'string', description: 'Comma-separated labels', alias: 'l' },
    depends: { type: 'string', description: 'Comma-separated dependency IDs', alias: 'D' },
    dryRun: { type: 'boolean', description: 'Show what would be created without making changes' },
  },
  async (args) => {
    const params: Record<string, unknown> = {
      title: args.title,
      description: args.description ?? args.title,
    };

    if (args.status) params.status = args.status;
    if (args.priority) params.priority = args.priority;
    if (args.type) params.type = args.type;
    if (args.parent) params.parent = args.parent;
    if (args.size) params.size = args.size;
    if (args.phase) params.phase = args.phase;
    if (args.labels) params.labels = args.labels.split(',').map((s: string) => s.trim());
    if (args.depends) params.depends = args.depends.split(',').map((s: string) => s.trim());
    if (args.dryRun) params.dryRun = true;

    const response = await dispatchRaw('mutate', 'tasks', 'add', params);

    if (!response.success) {
      handleRawError(response, { command: 'add', operation: 'tasks.add' });
      return;
    }

    const data = response.data as { duplicate?: boolean; dryRun?: boolean };
    const message = data.duplicate
      ? 'Task with identical title was created recently'
      : data.dryRun
        ? 'Dry run - no changes made'
        : undefined;

    cliOutput(response.data as Record<string, unknown>, {
      command: 'add',
      operation: 'tasks.add',
      message,
    });
  },
);

cmd(
  'list',
  'List tasks',
  {
    status: { type: 'string', description: 'Filter by status', alias: 's' },
    priority: { type: 'string', description: 'Filter by priority', alias: 'p' },
    label: { type: 'string', description: 'Filter by label', alias: 'l' },
    limit: { type: 'string', description: 'Limit results', alias: 'n' },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async (args) => {
    const params: Record<string, unknown> = {};
    if (args.status) params.status = args.status;
    if (args.priority) params.priority = args.priority;
    if (args.label) params.label = args.label;
    if (args.limit) params.limit = parseInt(args.limit, 10);
    if (args.json) params.format = 'json';

    await dispatchFromCli('query', 'tasks', 'list', params, {
      command: 'list',
      operation: 'tasks.list',
    });
  },
);

cmd(
  'show',
  'Show task details',
  {
    taskId: { type: 'positional', description: 'Task ID', required: true },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async (args) => {
    await dispatchFromCli(
      'query',
      'tasks',
      'show',
      { taskId: args.taskId, format: args.json ? 'json' : 'human' },
      { command: 'show', operation: 'tasks.show' },
    );
  },
);

cmd(
  'complete',
  'Mark task as complete',
  {
    taskId: { type: 'positional', description: 'Task ID', required: true },
    notes: { type: 'string', description: 'Completion notes', alias: 'n' },
    force: { type: 'boolean', description: 'Force completion even if blocked', alias: 'f' },
  },
  async (args) => {
    const params: Record<string, unknown> = { taskId: args.taskId };
    if (args.notes) params.notes = args.notes;
    if (args.force) params.force = true;

    await dispatchFromCli('mutate', 'tasks', 'complete', params, {
      command: 'complete',
      operation: 'tasks.complete',
    });
  },
);

cmd(
  'update',
  'Update task fields',
  {
    taskId: { type: 'positional', description: 'Task ID', required: true },
    title: { type: 'string', description: 'New title', alias: 't' },
    status: { type: 'string', description: 'New status', alias: 's' },
    priority: { type: 'string', description: 'New priority', alias: 'p' },
    description: { type: 'string', description: 'New description', alias: 'd' },
  },
  async (args) => {
    const params: Record<string, unknown> = { taskId: args.taskId };
    if (args.title) params.title = args.title;
    if (args.status) params.status = args.status;
    if (args.priority) params.priority = args.priority;
    if (args.description) params.description = args.description;

    await dispatchFromCli('mutate', 'tasks', 'update', params, {
      command: 'update',
      operation: 'tasks.update',
    });
  },
);

cmd(
  'delete',
  'Delete a task',
  {
    taskId: { type: 'positional', description: 'Task ID', required: true },
    force: { type: 'boolean', description: 'Skip confirmation', alias: 'f' },
  },
  async (args) => {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'delete',
      { taskId: args.taskId, force: args.force },
      { command: 'delete', operation: 'tasks.delete' },
    );
  },
);

// ============================================================================
// Session Commands
// ============================================================================

cmd(
  'session',
  'Manage sessions',
  {
    action: { type: 'positional', description: 'Action: start, stop, show, list' },
    name: { type: 'string', description: 'Session name', alias: 'n' },
  },
  async (args) => {
    const action = args.action ?? 'show';

    switch (action) {
      case 'start':
        await dispatchFromCli(
          'mutate',
          'session',
          'start',
          { name: args.name },
          { command: 'session', operation: 'session.start' },
        );
        break;
      case 'stop':
        await dispatchFromCli(
          'mutate',
          'session',
          'stop',
          {},
          { command: 'session', operation: 'session.stop' },
        );
        break;
      case 'show':
      default:
        await dispatchFromCli(
          'query',
          'session',
          'show',
          {},
          { command: 'session', operation: 'session.show' },
        );
    }
  },
);

// ============================================================================
// Core/Dash Command
// ============================================================================

cmd(
  'dash',
  'Show project dashboard',
  {
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Human-readable output' },
  },
  async (args) => {
    await dispatchFromCli(
      'query',
      'system',
      'dash',
      { format: args.json ? 'json' : args.human ? 'human' : 'auto' },
      { command: 'dash', operation: 'system.dash' },
    );
  },
);

// ============================================================================
// Version Command
// ============================================================================

commands['version'] = defineCommand({
  meta: { name: 'version', description: 'Display CLEO version' },
  async run() {
    cliOutput({ version: CLI_VERSION }, { command: 'version' });
  },
});

// ============================================================================
// Main CLI
// ============================================================================

const main = defineCommand({
  meta: {
    name: 'cleo',
    version: CLI_VERSION,
    description: 'CLEO V2 - Task management for AI coding agents',
  },
  subCommands: commands,
});

runMain(main);
