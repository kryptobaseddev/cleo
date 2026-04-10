/**
 * CLI nexus command group - Cross-project NEXUS operations.
 *
 * Thin CLI wrappers routing through the dispatch layer.
 * All business logic lives in src/dispatch/domains/nexus.ts.
 *
 * @task T4554, T5323, T5330, T481
 * @epic T4545
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

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
    .command('show <name>')
    .description('Show details for a registered project by name')
    .action(async (name: string) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'show',
        {
          name,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus resolve ───────────────────────────────────────────────────

  nexus
    .command('resolve <taskRef>')
    .alias('query')
    .description('Resolve a task reference across projects (project:T### or T###)')
    .action(async (taskRef: string) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'resolve',
        {
          query: taskRef,
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

  // ── nexus graph ───────────────────────────────────────────────────

  nexus
    .command('graph')
    .description('Show full dependency graph across all registered projects')
    .action(async () => {
      await dispatchFromCli('query', 'nexus', 'graph', {}, { command: 'nexus' });
    });

  // ── nexus share-status ────────────────────────────────────────────

  nexus
    .command('share-status')
    .description('Show multi-contributor sharing status for the current project')
    .action(async () => {
      await dispatchFromCli('query', 'nexus', 'share.status', {}, { command: 'nexus' });
    });

  // ── nexus transfer-preview ────────────────────────────────────────

  nexus
    .command('transfer-preview <taskIds...>')
    .description('Preview a task transfer between projects (dry-run, no changes made)')
    .requiredOption('--from <project>', 'Source project name')
    .requiredOption('--to <project>', 'Target project name')
    .option('--mode <mode>', 'Transfer mode: copy|move', 'copy')
    .option('--scope <scope>', 'Transfer scope: single|subtree', 'subtree')
    .action(async (taskIds: string[], opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'nexus',
        'transfer.preview',
        {
          taskIds,
          sourceProject: opts['from'] as string,
          targetProject: opts['to'] as string,
          mode: opts['mode'] as string,
          scope: opts['scope'] as string,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus transfer ────────────────────────────────────────────────

  nexus
    .command('transfer <taskIds...>')
    .description('Transfer tasks from one project to another')
    .requiredOption('--from <project>', 'Source project name')
    .requiredOption('--to <project>', 'Target project name')
    .option('--mode <mode>', 'Transfer mode: copy|move', 'copy')
    .option('--scope <scope>', 'Transfer scope: single|subtree', 'subtree')
    .option('--on-conflict <strategy>', 'Conflict strategy: rename|skip|duplicate|fail', 'rename')
    .option('--transfer-brain', 'Also transfer associated brain memory entries', false)
    .action(async (taskIds: string[], opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'transfer',
        {
          taskIds,
          sourceProject: opts['from'] as string,
          targetProject: opts['to'] as string,
          mode: opts['mode'] as string,
          scope: opts['scope'] as string,
          onConflict: opts['onConflict'] as string,
          transferBrain: opts['transferBrain'] as boolean,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus permission ──────────────────────────────────────────────

  const permission = nexus
    .command('permission')
    .description('Manage permissions for registered projects');

  permission
    .command('set <name> <level>')
    .description('Set permission level for a registered project (read|write|execute)')
    .action(async (name: string, level: string) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'permission.set',
        {
          name,
          level,
        },
        { command: 'nexus' },
      );
    });

  // ── nexus share ───────────────────────────────────────────────────

  const share = nexus.command('share').description('Multi-contributor sharing operations');

  share
    .command('export')
    .description('Export a snapshot of current project state for sharing')
    .option('--output <path>', 'Output file path (default: auto-generated in current directory)')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'share.snapshot.export',
        {
          outputPath: opts['output'] as string | undefined,
        },
        { command: 'nexus' },
      );
    });

  share
    .command('import <file>')
    .description('Import a shared project snapshot')
    .action(async (file: string) => {
      await dispatchFromCli(
        'mutate',
        'nexus',
        'share.snapshot.import',
        {
          inputPath: file,
        },
        { command: 'nexus' },
      );
    });
}
