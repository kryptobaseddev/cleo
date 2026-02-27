/**
 * CLI adr command group — ADR validation, listing, and sync.
 *
 * Thin CLI wrapper delegating to dispatch layer (admin domain).
 * Core logic lives in src/core/adrs/.
 *
 * Commands:
 *   ct adr validate          — validate frontmatter on all .cleo/adrs/*.md
 *   ct adr list [--status]   — list ADRs with optional status filter
 *   ct adr show <id>         — show single ADR by ID (e.g., ADR-017)
 *   ct adr sync              — sync .cleo/adrs/ into architecture_decisions DB
 *
 * MCP equivalents:
 *   cleo_mutate({domain:'admin', operation:'adr.validate'})
 *   cleo_query({domain:'admin',  operation:'adr.list',  params:{status?}})
 *   cleo_query({domain:'admin',  operation:'adr.show',  params:{adrId}})
 *   cleo_mutate({domain:'admin', operation:'adr.sync'})
 *
 * @see ADR-017 §5.1 for canonical frontmatter spec
 * @see schemas/adr-frontmatter.schema.json for validation schema
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerAdrCommand(program: Command): void {
  const adr = program
    .command('adr')
    .description('Manage and validate Architecture Decision Records in .cleo/adrs/');

  // ct adr validate
  adr
    .command('validate')
    .description('Validate frontmatter on all .cleo/adrs/*.md files against ADR-017 schema')
    .action(async () => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'adr.validate',
        {},
        { command: 'adr validate', operation: 'admin.adr.validate' },
      );
    });

  // ct adr list
  adr
    .command('list')
    .description('List ADRs from .cleo/adrs/')
    .option('--status <status>', 'Filter by status: proposed | accepted | superseded | deprecated')
    .option('--since <date>', 'Filter to ADRs created on or after YYYY-MM-DD')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'adr.list',
        {
          status: opts['status'] as string | undefined,
          since: opts['since'] as string | undefined,
        },
        { command: 'adr list', operation: 'admin.adr.list' },
      );
    });

  // ct adr show <id>
  adr
    .command('show <adrId>')
    .description('Show full details for a single ADR (e.g., ct adr show ADR-017)')
    .action(async (adrId: string) => {
      await dispatchFromCli(
        'query',
        'admin',
        'adr.show',
        { adrId },
        { command: 'adr show', operation: 'admin.adr.show' },
      );
    });

  // ct adr sync
  adr
    .command('sync')
    .description('Sync .cleo/adrs/ markdown files into the architecture_decisions DB table')
    .action(async () => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'adr.sync',
        {},
        { command: 'adr sync', operation: 'admin.adr.sync' },
      );
    });
}
