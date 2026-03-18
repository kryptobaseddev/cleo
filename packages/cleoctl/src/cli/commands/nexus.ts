/**
 * CLI nexus command group - Cross-project NEXUS operations.
 *
 * Thin CLI wrappers routing through the dispatch layer.
 * All business logic lives in src/dispatch/domains/nexus.ts.
 *
 * @task T4554, T5323, T5330
 * @epic T4545
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the nexus command group.
 * @task T4554
 */
export function registerNexusCommand(program: Command): void {
  const nexus = program.command('nexus').description('Cross-project NEXUS operations');

  // ── nexus init ──────────────────────────────────────────────────────

  nexus
    .command('init')
    .description('Initialize NEXUS directory structure and registry')
    .action(async () => {
      await dispatchFromCli('mutate', 'nexus', 'init', {}, { command: 'nexus' });
    });

  // ── nexus register ──────────────────────────────────────────────────

  nexus
    .command('register <path>')
    .description('Register a project in the global registry')
    .option('--name <name>', 'Custom project name (default: directory name)')
    .option('--permissions <perms>', 'Permissions: read|write|execute', 'read')
    .action(async (projectPath: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'register',
        {
          path: projectPath,
          name: opts['name'] as string | undefined,
          permission: opts['permissions'] as string,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus unregister ────────────────────────────────────────────────

  nexus
    .command('unregister <nameOrHash>')
    .description('Remove a project from the registry')
    .action(async (nameOrHash: string) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'unregister',
        {
          name: nameOrHash,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus list ──────────────────────────────────────────────────────

  nexus
    .command('list')
    .description('List all registered projects')
    .action(async () => {
      await dispatchFromCli('query', 'nexus', 'list', {}, { command: 'nexus' });
    });

  // ── nexus status ────────────────────────────────────────────────────

  nexus
    .command('status')
    .description('Show NEXUS registry status')
    .action(async () => {
      await dispatchFromCli('query', 'nexus', 'status', {}, { command: 'nexus' });
    });

  // ── nexus show ─────────────────────────────────────────────────────

  nexus
    .command('show <taskId>')
    .alias('query')
    .description('Show a task across projects (project:T### or T###)')
    .action(async (taskId: string) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'resolve',
        {
          query: taskId,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus discover ──────────────────────────────────────────────────

  nexus
    .command('discover <taskQuery>')
    .description('Find related tasks across projects')
    .option('--method <method>', 'Discovery method: labels|description|files|auto', 'auto')
    .option('--limit <n>', 'Max results', parseInt, 10)
    .action(async (taskQuery: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'discover',
        {
          query: taskQuery,
          method: opts['method'] as string,
          limit: opts['limit'] as number,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus search ────────────────────────────────────────────────────

  nexus
    .command('search <pattern>')
    .description('Search tasks across projects by pattern')
    .option('--project <name>', 'Limit search to specific project')
    .option('--limit <n>', 'Max results', parseInt, 20)
    .action(async (pattern: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'search',
        {
          pattern,
          project: opts['project'] as string | undefined,
          limit: opts['limit'] as number,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus deps ──────────────────────────────────────────────────────

  nexus
    .command('deps <taskQuery>')
    .description('Show cross-project dependencies')
    .option('--reverse', 'Show reverse dependencies (what depends on this)')
    .action(async (taskQuery: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'deps',
        {
          query: taskQuery,
          direction: opts['reverse'] ? 'reverse' : 'forward',
        },
        { command: 'nexus' },
      );
    });

  // ── nexus critical-path ───────────────────────────────────────────

  nexus
    .command('critical-path')
    .description('Show global critical path across all registered projects')
    .action(async () => {
      await dispatchFromCli('query', 'nexus', 'path.show', {}, { command: 'nexus' });
    });

  // ── nexus blocking ────────────────────────────────────────────────

  nexus
    .command('blocking <taskQuery>')
    .description('Show blocking impact analysis for a task')
    .action(async (taskQuery: string) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'blockers.show',
        {
          query: taskQuery,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus orphans ─────────────────────────────────────────────────

  nexus
    .command('orphans')
    .description('Detect broken cross-project dependency references')
    .action(async () => {
      await dispatchFromCli('query', 'nexus', 'orphans.list', {}, { command: 'nexus' });
    });

  // ── nexus sync ──────────────────────────────────────────────────────

  nexus
    .command('sync [project]')
    .description('Sync project metadata (task count, labels)')
    .action(async (project?: string) => {
      if (project) {
        await dispatchFromCli(
          'mutate',
          'nexus',
          'sync',
          {
            name: project,
          },
          { command: 'nexus' },
        );
      } else {
        await dispatchFromCli('mutate', 'nexus', 'sync', {}, { command: 'nexus' });
      }
    });

  // ── nexus reconcile ──────────────────────────────────────────────────

  nexus
    .command('reconcile')
    .description(
      'Reconcile current project with NEXUS registry (auto-register if new, update path if moved)',
    )
    .option('--path <path>', 'Project path (default: current directory)')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'reconcile',
        {
          projectRoot: opts['path'] as string | undefined,
        },
        { command: 'nexus' },
      );
    });
}
