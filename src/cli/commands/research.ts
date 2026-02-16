/**
 * CLI research command with subcommands.
 * @task T4465
 * @epic T4454
 */

import { Command } from 'commander';
import {
  addResearch,
  showResearch,
  listResearch,
  pendingResearch,
  linkResearch,
  updateResearch,
  queryManifest,
  statsResearch,
  linksResearch,
  archiveResearch,
} from '../../core/research/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the research command group.
 * @task T4465
 */
export function registerResearchCommand(program: Command): void {
  const research = program
    .command('research')
    .description('Research commands and manifest operations');

  research
    .command('add')
    .description('Add a research entry')
    .requiredOption('-t, --task <taskId>', 'Task ID to attach research to')
    .requiredOption('--topic <topic>', 'Research topic')
    .option('--findings <findings>', 'Comma-separated findings')
    .option('--sources <sources>', 'Comma-separated sources')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await addResearch({
          taskId: opts['task'] as string,
          topic: opts['topic'] as string,
          findings: opts['findings'] ? (opts['findings'] as string).split(',').map(s => s.trim()) : undefined,
          sources: opts['sources'] ? (opts['sources'] as string).split(',').map(s => s.trim()) : undefined,
        });
        console.log(formatSuccess({ entry: result }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  research
    .command('show <id>')
    .description('Show a research entry')
    .action(async (id: string) => {
      try {
        const result = await showResearch(id);
        console.log(formatSuccess({ entry: result }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  research
    .command('list')
    .description('List research entries')
    .option('-t, --task <taskId>', 'Filter by task ID')
    .option('-s, --status <status>', 'Filter by status')
    .option('-l, --limit <n>', 'Limit results', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      try {
        let result = await listResearch({
          taskId: opts['task'] as string | undefined,
          status: opts['status'] as 'pending' | 'complete' | 'partial' | undefined,
        });
        const limit = opts['limit'] as number | undefined;
        if (limit && limit > 0) {
          result = result.slice(0, limit);
        }
        console.log(formatSuccess({ entries: result, count: result.length }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  research
    .command('pending')
    .description('List pending research entries')
    .action(async () => {
      try {
        const result = await pendingResearch();
        console.log(formatSuccess({ entries: result, count: result.length }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  research
    .command('link <researchId> <taskId>')
    .description('Link a research entry to a task')
    .action(async (researchId: string, taskId: string) => {
      try {
        const result = await linkResearch(researchId, taskId);
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  research
    .command('update <id>')
    .description('Update research findings')
    .option('--findings <findings>', 'Comma-separated findings')
    .option('--sources <sources>', 'Comma-separated sources')
    .option('-s, --status <status>', 'Set status')
    .action(async (id: string, opts: Record<string, unknown>) => {
      try {
        const result = await updateResearch(id, {
          findings: opts['findings'] ? (opts['findings'] as string).split(',').map(s => s.trim()) : undefined,
          sources: opts['sources'] ? (opts['sources'] as string).split(',').map(s => s.trim()) : undefined,
          status: opts['status'] as 'pending' | 'complete' | 'partial' | undefined,
        });
        console.log(formatSuccess({ entry: result }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  research
    .command('stats')
    .description('Show research statistics')
    .action(async () => {
      try {
        const result = await statsResearch();
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  research
    .command('links <taskId>')
    .description('Show research entries linked to a task')
    .action(async (taskId: string) => {
      try {
        const result = await linksResearch(taskId);
        console.log(formatSuccess({ entries: result, count: result.length }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  research
    .command('archive')
    .description('Archive completed research entries')
    .action(async () => {
      try {
        const result = await archiveResearch();
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Manifest subcommands
  research
    .command('manifest')
    .description('Query MANIFEST.jsonl entries')
    .option('-s, --status <status>', 'Filter by status')
    .option('-a, --agent-type <type>', 'Filter by agent type')
    .option('--topic <topic>', 'Filter by topic')
    .option('-t, --task <taskId>', 'Filter by linked task')
    .option('-l, --limit <n>', 'Limit results')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await queryManifest({
          status: opts['status'] as string | undefined,
          agentType: opts['agentType'] as string | undefined,
          topic: opts['topic'] as string | undefined,
          taskId: opts['task'] as string | undefined,
          limit: opts['limit'] ? parseInt(opts['limit'] as string, 10) : undefined,
        });
        console.log(formatSuccess({ entries: result, count: result.length }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
