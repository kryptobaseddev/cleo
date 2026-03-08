/**
 * CLI sticky command group - Quick project-wide ephemeral captures.
 *
 * Sticky notes fill the gap between session notes (bound to sessions),
 * tasks (formal work items), and BRAIN observations (distilled knowledge).
 *
 * @task T5281
 * @epic T5267
 */

import type { Command } from 'commander';
import { CleoError } from '../../core/errors.js';
import { formatError } from '../../core/output.js';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { ExitCode } from '../../types/exit-codes.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Register the sticky command group.
 * @task T5281
 */
export function registerStickyCommand(program: Command): void {
  const sticky = program
    .command('sticky')
    .alias('note')
    .description('Manage sticky notes - quick project-wide ephemeral captures');

  // ── sticky add ─────────────────────────────────────────────────────────

  sticky
    .command('add <content>')
    .alias('jot')
    .description('Create a new sticky note')
    .option('--tag <tag>', 'Add a tag (can be used multiple times)', collect, [])
    .option('--color <color>', 'Sticky color: yellow|blue|green|red|purple', 'yellow')
    .option('--priority <priority>', 'Priority: low|medium|high', 'medium')
    .action(async (content: string, opts: Record<string, unknown>) => {
      try {
        await dispatchFromCli(
          'mutate',
          'sticky',
          'add',
          {
            content,
            tags: opts['tag'] as string[],
            color: opts['color'] as string,
            priority: opts['priority'] as string,
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
    });

  // ── sticky list ────────────────────────────────────────────────────────

  sticky
    .command('list')
    .alias('ls')
    .description('List active sticky notes')
    .option('--tag <tag>', 'Filter by tag')
    .option('--color <color>', 'Filter by color')
    .option('--status <status>', 'Filter by status: active|converted|archived', 'active')
    .option('--limit <n>', 'Max results', parseInt, 50)
    .action(async (opts: Record<string, unknown>) => {
      try {
        const response = await dispatchRaw('query', 'sticky', 'list', {
          tag: opts['tag'] as string | undefined,
          color: opts['color'] as string | undefined,
          status: opts['status'] as string,
          limit: opts['limit'] as number,
        });

        if (!response.success) {
          handleRawError(response, { command: 'sticky list', operation: 'sticky.list' });
          return;
        }

        const data = response.data as { stickies: StickyNote[]; total: number } | null;

        if (!data || !data.stickies || data.stickies.length === 0) {
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
    });

  // ── sticky show ────────────────────────────────────────────────────────

  sticky
    .command('show <id>')
    .description('Show a specific sticky note')
    .action(async (id: string) => {
      try {
        const response = await dispatchRaw('query', 'sticky', 'show', {
          stickyId: id,
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
              message: `Sticky note not found: ${id}`,
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
    });

  // ── sticky convert ─────────────────────────────────────────────────────

  const convertCmd = sticky
    .command('convert <id>')
    .description('Convert sticky note to task or memory');

  convertCmd
    .option('--to-task', 'Convert to a task')
    .option('--to-memory', 'Convert to a memory observation')
    .option('--title <title>', 'Title for the converted item (tasks only)')
    .option(
      '--type <type>',
      'Memory type: pattern|learning|decision|observation (memory only)',
      'observation',
    )
    .option('--epic <epic>', 'Epic ID for the new task (e.g., epic:T###)')
    .action(async (id: string, opts: Record<string, unknown>) => {
      try {
        const toTask = opts['toTask'] as boolean;
        const toMemory = opts['toMemory'] as boolean;

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
          stickyId: id,
          targetType: toTask ? 'task' : 'memory',
        };

        if (toTask) {
          if (opts['title']) convertParams['title'] = opts['title'];
          if (opts['epic']) convertParams['epic'] = opts['epic'];
        }

        if (toMemory) {
          convertParams['memoryType'] = opts['type'];
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
    });

  // ── sticky archive ─────────────────────────────────────────────────────

  sticky
    .command('archive <id>')
    .description('Archive a sticky note')
    .action(async (id: string) => {
      try {
        await dispatchFromCli(
          'mutate',
          'sticky',
          'archive',
          {
            stickyId: id,
          },
          { command: 'sticky archive', operation: 'sticky.archive' },
        );
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── sticky purge ────────────────────────────────────────────────────────

  sticky
    .command('purge <id>')
    .description('Permanently delete a sticky note (cannot be undone)')
    .action(async (id: string) => {
      try {
        await dispatchFromCli(
          'mutate',
          'sticky',
          'purge',
          {
            stickyId: id,
          },
          { command: 'sticky purge', operation: 'sticky.purge' },
        );
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}

/**
 * Helper to collect multiple --tag options into an array
 */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/**
 * Sticky note type definition
 */
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
