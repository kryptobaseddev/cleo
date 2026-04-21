/**
 * CLI command: cleo migrate claude-mem / cleo migrate storage
 *
 * Migrates observations from the external claude-mem plugin's SQLite
 * database (~/.claude-mem/claude-mem.db) into CLEO's native brain.db.
 *
 * Also registers `cleo migrate storage` which dispatches to the admin.migrate
 * operation for internal CLEO storage/schema migrations.
 *
 * @epic T5149
 * @task T5143
 * @task T480 — add `migrate storage` subcommand dispatching to mutate admin migrate.
 */

import { getProjectRoot, migrateClaudeMem } from '@cleocode/core/internal';
import { ingestLooseAgentOutputs, ingestRcasdDirectories } from '@cleocode/core/memory';
import { getDb } from '@cleocode/core/store/sqlite';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliError, cliOutput } from '../renderers/index.js';

/** cleo migrate storage — run CLEO internal storage and schema migrations */
const storageCommand = defineCommand({
  meta: {
    name: 'storage',
    description: 'Run CLEO internal storage and schema migrations',
  },
  args: {
    target: {
      type: 'string',
      description: 'Target schema version to migrate to',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview migration steps without making changes',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'admin',
      'migrate',
      {
        target: args.target as string | undefined,
        dryRun: args['dry-run'] === true,
      },
      { command: 'migrate storage', operation: 'admin.migrate' },
    );
  },
});

/** cleo migrate claude-mem — import observations from claude-mem into brain.db */
const claudeMemCommand = defineCommand({
  meta: {
    name: 'claude-mem',
    description: 'Import observations from claude-mem into brain.db',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Show what would be imported without making changes',
    },
    source: {
      type: 'string',
      description: 'Path to claude-mem.db (default: ~/.claude-mem/claude-mem.db)',
    },
    project: {
      type: 'string',
      description: 'Project tag for imported entries',
    },
    'batch-size': {
      type: 'string',
      description: 'Rows per transaction batch (default: 100)',
    },
  },
  async run({ args }) {
    const root = getProjectRoot();

    try {
      const result = await migrateClaudeMem(root, {
        sourcePath: args.source as string | undefined,
        project: args.project as string | undefined,
        dryRun: !!args['dry-run'],
        batchSize: args['batch-size'] ? parseInt(args['batch-size'] as string, 10) : undefined,
      });

      cliOutput(
        {
          dryRun: result.dryRun,
          observationsImported: result.observationsImported,
          learningsImported: result.learningsImported,
          decisionsImported: result.decisionsImported,
          observationsSkipped: result.observationsSkipped,
          errors: result.errors,
        },
        { command: 'migrate-claude-mem', operation: 'migrate.claude-mem' },
      );

      if (result.errors.length > 0) {
        process.exitCode = 1;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(message, 'E_MIGRATION_FAILED', undefined, {
        operation: 'migrate.claude-mem',
      });
      process.exitCode = 1;
    }
  },
});

/** cleo migrate manifest-ingest — ingest RCASD and loose markdown files into pipeline_manifest */
const manifestIngestCommand = defineCommand({
  meta: {
    name: 'manifest-ingest',
    description: 'Ingest RCASD and loose agent-output markdown files into pipeline_manifest',
  },
  args: {
    rcasd: {
      type: 'boolean',
      description: 'Ingest only RCASD directories',
      default: false,
    },
    loose: {
      type: 'boolean',
      description: 'Ingest only loose agent-output files',
      default: false,
    },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();

    try {
      const db = await getDb(projectRoot);

      // Determine mode: explicit flags or default to all
      const rcasdFlag = Boolean(args.rcasd);
      const looseFlag = Boolean(args.loose);
      // If both are false (defaults), ingest all; otherwise only ingest flagged ones
      const ingestRcasd = rcasdFlag || (!rcasdFlag && !looseFlag);
      const ingestLoose = looseFlag || (!rcasdFlag && !looseFlag);

      const results = {
        rcasd: null as { ingested: number; skipped: number } | null,
        loose: null as { ingested: number; skipped: number } | null,
      };

      if (ingestRcasd) {
        results.rcasd = await ingestRcasdDirectories(projectRoot, db);
      }

      if (ingestLoose) {
        results.loose = await ingestLooseAgentOutputs(projectRoot, db);
      }

      // Report results
      if (results.rcasd) {
        console.log(`RCASD: ingested ${results.rcasd.ingested}, skipped ${results.rcasd.skipped}`);
      }

      if (results.loose) {
        console.log(`Loose: ingested ${results.loose.ingested}, skipped ${results.loose.skipped}`);
      }

      const totalIngested = (results.rcasd?.ingested ?? 0) + (results.loose?.ingested ?? 0);
      const totalSkipped = (results.rcasd?.skipped ?? 0) + (results.loose?.skipped ?? 0);

      cliOutput(
        {
          rcasd: results.rcasd,
          loose: results.loose,
          total: { ingested: totalIngested, skipped: totalSkipped },
        },
        { command: 'migrate manifest-ingest', operation: 'migrate.manifest-ingest' },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(message, 'E_MANIFEST_INGEST_FAILED', undefined, {
        operation: 'migrate.manifest-ingest',
      });
      process.exitCode = 1;
    }
  },
});

/**
 * Root migrate command group — registers migrate subcommands.
 *
 * Subcommands:
 *   cleo migrate claude-mem      [--dry-run] [--source <path>] [--project <name>]
 *   cleo migrate storage         [--target <version>] [--dry-run]
 *   cleo migrate manifest-ingest [--rcasd] [--loose]
 */
export const migrateClaudeMemCommand = defineCommand({
  meta: { name: 'migrate', description: 'Data migration utilities' },
  subCommands: {
    'claude-mem': claudeMemCommand,
    storage: storageCommand,
    'manifest-ingest': manifestIngestCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
