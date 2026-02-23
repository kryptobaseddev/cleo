/**
 * CLI research command with subcommands.
 * @task T4465
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

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
      await dispatchFromCli('mutate', 'memory', 'inject', {
        taskId: opts['task'],
        topic: opts['topic'],
        findings: opts['findings'] ? (opts['findings'] as string).split(',').map(s => s.trim()) : undefined,
        sources: opts['sources'] ? (opts['sources'] as string).split(',').map(s => s.trim()) : undefined,
      }, { command: 'research' });
    });

  research
    .command('show <id>')
    .description('Show a research entry')
    .action(async (id: string) => {
      await dispatchFromCli('query', 'memory', 'show', { entryId: id }, { command: 'research' });
    });

  research
    .command('list')
    .description('List research entries')
    .option('-t, --task <taskId>', 'Filter by task ID')
    .option('-s, --status <status>', 'Filter by status')
    .option('-l, --limit <n>', 'Limit results', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'memory', 'list', {
        taskId: opts['task'], status: opts['status'], limit: opts['limit'],
      }, { command: 'research' });
    });

  research
    .command('pending')
    .description('List pending research entries')
    .action(async () => {
      await dispatchFromCli('query', 'memory', 'pending', {}, { command: 'research' });
    });

  research
    .command('link <researchId> <taskId>')
    .description('Link a research entry to a task')
    .action(async (researchId: string, taskId: string) => {
      await dispatchFromCli('mutate', 'memory', 'link', {
        entryId: researchId, taskId,
      }, { command: 'research' });
    });

  research
    .command('update <id>')
    .description('Update research findings')
    .option('--findings <findings>', 'Comma-separated findings')
    .option('--sources <sources>', 'Comma-separated sources')
    .option('-s, --status <status>', 'Set status')
    .action(async (id: string, opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'memory', 'inject', {
        entryId: id,
        action: 'update',
        findings: opts['findings'] ? (opts['findings'] as string).split(',').map(s => s.trim()) : undefined,
        sources: opts['sources'] ? (opts['sources'] as string).split(',').map(s => s.trim()) : undefined,
        status: opts['status'],
      }, { command: 'research' });
    });

  research
    .command('stats')
    .description('Show research statistics')
    .action(async () => {
      await dispatchFromCli('query', 'memory', 'stats', {}, { command: 'research' });
    });

  research
    .command('links <taskId>')
    .description('Show research entries linked to a task')
    .action(async (taskId: string) => {
      await dispatchFromCli('query', 'memory', 'find', { taskId }, { command: 'research' });
    });

  research
    .command('archive')
    .description('Archive completed research entries')
    .action(async () => {
      await dispatchFromCli('mutate', 'memory', 'manifest.archive', {}, { command: 'research' });
    });

  research
    .command('manifest')
    .description('Query MANIFEST.jsonl entries')
    .option('-s, --status <status>', 'Filter by status')
    .option('-a, --agent-type <type>', 'Filter by agent type')
    .option('--topic <topic>', 'Filter by topic')
    .option('-t, --task <taskId>', 'Filter by linked task')
    .option('-l, --limit <n>', 'Limit results')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'memory', 'manifest.read', {
        status: opts['status'],
        agentType: opts['agentType'],
        topic: opts['topic'],
        taskId: opts['task'],
        limit: opts['limit'] ? parseInt(opts['limit'] as string, 10) : undefined,
      }, { command: 'research' });
    });
}
