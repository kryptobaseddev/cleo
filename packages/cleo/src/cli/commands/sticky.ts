/**
 * CLI sticky command group — quick project-wide ephemeral captures.
 *
 * Sticky notes fill the gap between session notes (bound to sessions),
 * tasks (formal work items), and BRAIN observations (distilled knowledge).
 *
 *   cleo sticky add <content>    — create a sticky note (alias: jot)
 *   cleo sticky list             — list active sticky notes (alias: ls)
 *   cleo sticky show <id>        — show a specific sticky note
 *   cleo sticky convert <id>     — convert to task or memory
 *   cleo sticky archive <id>     — archive a sticky note
 *   cleo sticky purge <id>       — permanently delete a sticky note
 *
 * @task T5281
 * @epic T5267
 */

import { ExitCode } from '@cleocode/contracts';
import { CleoError, formatError } from '@cleocode/core';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/** Sticky note shape returned by the sticky domain */
interface StickyNote {
  id: string;
  content: string;
  createdAt: string;
  tags?: string[];
  status: 'active' | 'converted' | 'archived';
  convertedTo?: { type: string; id: string };
  color?: string;
  priority?: string;
}

/** cleo sticky add <content> — create a new sticky note (alias: jot) */
const addCommand = defineCommand({
  meta: { name: 'add', description: 'Create a new sticky note' },
  args: {
    content: {
      type: 'positional',
      description: 'Sticky note content',
      required: true,
    },
    tag: {
      type: 'string',
      description: 'Comma-separated tags (e.g. "bug,urgent")',
    },
    color: {
      type: 'string',
      description: 'Sticky color: yellow|blue|green|red|purple',
      default: 'yellow',
    },
    priority: {
      type: 'string',
      description: 'Priority: low|medium|high',
      default: 'medium',
    },
  },
  async run({ args }) {
    try {
      const rawTag = args.tag as string | undefined;
      const tags = rawTag
        ? rawTag
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
      await dispatchFromCli(
        'mutate',
        'sticky',
        'add',
        {
          content: args.content,
          tags,
          color: args.color,
          priority: args.priority,
        },
        { command: 'sticky', operation: 'sticky.add' },
      );
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo sticky list — list active sticky notes (alias: ls) */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List active sticky notes' },
  args: {
    tag: {
      type: 'string',
      description: 'Filter by tags (comma-separated, e.g. "bug,urgent")',
    },
    color: {
      type: 'string',
      description: 'Filter by color',
    },
    status: {
      type: 'string',
      description: 'Filter by status: active|converted|archived',
      default: 'active',
    },
    limit: {
      type: 'string',
      description: 'Max results',
      default: '50',
    },
  },
  async run({ args }) {
    try {
      const rawTag = args.tag as string | undefined;
      const tags = rawTag
        ? rawTag
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;
      const response = await dispatchRaw('query', 'sticky', 'list', {
        tags,
        color: args.color as string | undefined,
        status: args.status,
        limit: Number.parseInt(args.limit, 10),
      });

      if (!response.success) {
        handleRawError(response, { command: 'sticky list', operation: 'sticky.list' });
        return;
      }

      const data = response.data as { stickies: StickyNote[]; total: number } | null;

      if (!data?.stickies || data.stickies.length === 0) {
        cliOutput(
          { stickies: [], total: 0 },
          { command: 'sticky list', message: 'No sticky notes found', operation: 'sticky.list' },
        );
        process.exit(ExitCode.NO_DATA);
        return;
      }

      cliOutput(data, { command: 'sticky list', operation: 'sticky.list', page: response.page });
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo sticky show <id> — show a specific sticky note */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show a specific sticky note' },
  args: {
    id: {
      type: 'positional',
      description: 'Sticky note ID',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const response = await dispatchRaw('query', 'sticky', 'show', {
        stickyId: args.id,
      });

      if (!response.success) {
        handleRawError(response, { command: 'sticky show', operation: 'sticky.show' });
        return;
      }

      const data = response.data as StickyNote | null;

      if (!data) {
        cliOutput(
          { sticky: null },
          {
            command: 'sticky show',
            message: `Sticky note not found: ${args.id}`,
            operation: 'sticky.show',
          },
        );
        process.exit(ExitCode.NO_DATA);
        return;
      }

      cliOutput({ sticky: data }, { command: 'sticky show', operation: 'sticky.show' });
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo sticky convert <id> — convert sticky note to task or memory */
const convertCommand = defineCommand({
  meta: { name: 'convert', description: 'Convert sticky note to task or memory' },
  args: {
    id: {
      type: 'positional',
      description: 'Sticky note ID to convert',
      required: true,
    },
    'to-task': {
      type: 'boolean',
      description: 'Convert to a task',
    },
    'to-memory': {
      type: 'boolean',
      description: 'Convert to a memory observation',
    },
    title: {
      type: 'string',
      description: 'Title for the converted item (tasks only)',
    },
    type: {
      type: 'string',
      description: 'Memory type: pattern|learning|decision|observation (memory only)',
      default: 'observation',
    },
    epic: {
      type: 'string',
      description: 'Epic ID for the new task (e.g., epic:T###)',
    },
  },
  async run({ args }) {
    try {
      const toTask = args['to-task'] as boolean | undefined;
      const toMemory = args['to-memory'] as boolean | undefined;

      if (!toTask && !toMemory) {
        console.error('Error: Must specify either --to-task or --to-memory');
        process.exit(ExitCode.INVALID_INPUT);
        return;
      }

      if (toTask && toMemory) {
        console.error('Error: Cannot specify both --to-task and --to-memory');
        process.exit(ExitCode.INVALID_INPUT);
        return;
      }

      const convertParams: Record<string, unknown> = {
        stickyId: args.id,
        targetType: toTask ? 'task' : 'memory',
      };

      if (toTask) {
        if (args.title) convertParams['title'] = args.title;
        if (args.epic) convertParams['epic'] = args.epic;
      }

      if (toMemory) {
        convertParams['memoryType'] = args.type;
      }

      await dispatchFromCli('mutate', 'sticky', 'convert', convertParams, {
        command: 'sticky convert',
        operation: 'sticky.convert',
      });
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo sticky archive <id> — archive a sticky note */
const archiveCommand = defineCommand({
  meta: { name: 'archive', description: 'Archive a sticky note' },
  args: {
    id: {
      type: 'positional',
      description: 'Sticky note ID to archive',
      required: true,
    },
  },
  async run({ args }) {
    try {
      await dispatchFromCli(
        'mutate',
        'sticky',
        'archive',
        { stickyId: args.id },
        { command: 'sticky archive', operation: 'sticky.archive' },
      );
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo sticky purge <id> — permanently delete a sticky note */
const purgeCommand = defineCommand({
  meta: { name: 'purge', description: 'Permanently delete a sticky note (cannot be undone)' },
  args: {
    id: {
      type: 'positional',
      description: 'Sticky note ID to purge',
      required: true,
    },
  },
  async run({ args }) {
    try {
      await dispatchFromCli(
        'mutate',
        'sticky',
        'purge',
        { stickyId: args.id },
        { command: 'sticky purge', operation: 'sticky.purge' },
      );
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/**
 * Root sticky command group — manage quick project-wide ephemeral captures.
 *
 * Aliases: `add` → `jot`, `list` → `ls` (duplicated subcommand keys per citty convention).
 */
export const stickyCommand = defineCommand({
  meta: {
    name: 'sticky',
    description: 'Manage sticky notes - quick project-wide ephemeral captures',
  },
  subCommands: {
    add: addCommand,
    jot: addCommand,
    list: listCommand,
    ls: listCommand,
    show: showCommand,
    convert: convertCommand,
    archive: archiveCommand,
    purge: purgeCommand,
  },
  async run({ cmd }) {
    await showUsage(cmd);
  },
});
