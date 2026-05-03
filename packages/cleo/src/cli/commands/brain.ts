/**
 * CLI command group: cleo brain
 *
 * Subcommands:
 *   cleo brain maintenance   — run temporal decay + consolidation + embedding backfill
 *   cleo brain backfill      — back-fill brain graph nodes/edges from typed tables
 *   cleo brain purge         — purge noise entries from brain.db
 *   cleo brain plasticity    — STDP plasticity operations
 *   cleo brain quality       — memory quality metrics
 *   cleo brain export        — export brain graph as GEXF or JSON
 *
 * @task T143
 * @task T1722
 * @epic T134
 * @epic T1691
 * @why Provide a single CLI entry point for brain optimization operations
 * @what Parent command group with subcommands and progress reporting
 */

import {
  backfillBrainGraph,
  exportBrainAsGexf,
  exportBrainAsJson,
  getMemoryQualityReport,
  getPlasticityStats,
  getProjectRoot,
  purgeBrainNoise,
  runBrainMaintenance,
} from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

/** cleo brain maintenance — temporal decay, consolidation, and embedding backfill */
const maintenanceCommand = defineCommand({
  meta: {
    name: 'maintenance',
    description: 'Run brain maintenance: temporal decay, consolidation, and embedding backfill',
  },
  args: {
    'skip-decay': {
      type: 'boolean',
      description: 'Skip the temporal decay step (confidence reduction on stale learnings)',
    },
    'skip-consolidation': {
      type: 'boolean',
      description: 'Skip the memory consolidation step (merging old observations)',
    },
    'skip-reconciliation': {
      type: 'boolean',
      description: 'Skip the cross-DB orphaned reference reconciliation step',
    },
    'skip-tier-promotion': {
      type: 'boolean',
      description: 'Skip the tier promotion step (short→medium, medium→long promotion)',
    },
    'skip-embeddings': {
      type: 'boolean',
      description: 'Skip the embedding backfill step (vector generation for observations)',
    },
    json: { type: 'boolean', description: 'Output results as JSON' },
  },
  async run({ args }) {
    const root = getProjectRoot();

    try {
      const result = await runBrainMaintenance(root, {
        skipDecay: !!args['skip-decay'],
        skipConsolidation: !!args['skip-consolidation'],
        skipReconciliation: !!args['skip-reconciliation'],
        skipTierPromotion: !!args['skip-tier-promotion'],
        skipEmbeddings: !!args['skip-embeddings'],
        onProgress: (step, current, total) => {
          if (step === 'embeddings' && total > 0) {
            if (process.stdout.isTTY) {
              process.stdout.clearLine(0);
              process.stdout.cursorTo(0);
              process.stdout.write(`  [embeddings] ${current}/${total}...`);
            } else if (current === 1 || current === total) {
              process.stderr.write(`  [embeddings] ${current}/${total}...\n`);
            }
          } else if (current === 0) {
            process.stderr.write(`  [${step}] starting...\n`);
          } else if (current === total && total > 0) {
            if (step === 'embeddings' && process.stdout.isTTY) {
              process.stdout.write('\n');
            }
            process.stderr.write(`  [${step}] done\n`);
          }
        },
      });

      const data: Record<string, unknown> = {
        duration: result.duration,
      };

      if (!args['skip-decay']) {
        data['decay'] = result.decay;
      }
      if (!args['skip-consolidation']) {
        data['consolidation'] = result.consolidation;
      }
      if (!args['skip-tier-promotion']) {
        data['tierPromotion'] = result.tierPromotion;
      }
      if (!args['skip-reconciliation']) {
        data['reconciliation'] = result.reconciliation;
      }
      if (!args['skip-embeddings']) {
        data['embeddings'] = result.embeddings;
      }

      cliOutput(data, {
        command: 'brain-maintenance',
        operation: 'brain.maintenance',
        message: `Maintenance complete in ${result.duration}ms`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Brain maintenance failed: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        {
          operation: 'brain.maintenance',
        },
      );
      process.exit(1);
    }
  },
});

/** cleo brain backfill — back-fill brain graph from surviving typed table rows */
const backfillBrainCommand = defineCommand({
  meta: {
    name: 'backfill',
    description:
      'Back-fill brain_page_nodes and brain_page_edges from all surviving typed table rows (decisions, patterns, learnings, observations, sticky notes). Safe to re-run — duplicates are silently skipped.',
  },
  args: {
    json: { type: 'boolean', description: 'Output results as JSON' },
  },
  async run({ args: _args }) {
    const root = getProjectRoot();

    try {
      const result = await backfillBrainGraph(root);

      cliOutput(
        {
          before: result.before,
          nodesInserted: result.nodesInserted,
          stubsCreated: result.stubsCreated,
          edgesInserted: result.edgesInserted,
          after: result.after,
          byType: result.byType,
        },
        {
          command: 'brain-backfill',
          operation: 'brain.backfill',
          message: `Back-fill complete: ${result.nodesInserted} nodes, ${result.edgesInserted} edges inserted`,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Brain backfill failed: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        {
          operation: 'brain.backfill',
        },
      );
      process.exit(1);
    }
  },
});

/** cleo brain purge — purge noise entries from brain.db */
const purgeCommand = defineCommand({
  meta: {
    name: 'purge',
    description:
      'Purge noise entries from brain.db — removes duplicate patterns, all learnings, test decisions, and task-lifecycle observations. TAKE A BACKUP FIRST.',
  },
  args: {
    json: { type: 'boolean', description: 'Output results as JSON' },
  },
  async run({ args: _args }) {
    const root = getProjectRoot();

    try {
      const result = await purgeBrainNoise(root);

      cliOutput(
        {
          patternsDeleted: result.patternsDeleted,
          learningsDeleted: result.learningsDeleted,
          decisionsDeleted: result.decisionsDeleted,
          observationsDeleted: result.observationsDeleted,
          after: result.after,
          fts5Rebuilt: result.fts5Rebuilt,
        },
        {
          command: 'brain-purge',
          operation: 'brain.purge',
          message: 'Purge complete',
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Brain purge failed: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        {
          operation: 'brain.purge',
        },
      );
      process.exit(1);
    }
  },
});

/** cleo brain plasticity stats — show recent STDP plasticity events */
const plasticityStatsCommand = defineCommand({
  meta: {
    name: 'stats',
    description:
      'Show recent STDP plasticity events: LTP/LTD counts, net weight delta, and most recent events.',
  },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum recent events to show (default 20)',
      default: '20',
    },
    json: { type: 'boolean', description: 'Output results as JSON' },
  },
  async run({ args }) {
    const root = getProjectRoot();
    const limit = Number.parseInt(args.limit, 10) || 20;

    try {
      const stats = await getPlasticityStats(root, limit);

      cliOutput(
        {
          totalEvents: stats.totalEvents,
          ltpCount: stats.ltpCount,
          ltdCount: stats.ltdCount,
          netDeltaW: stats.netDeltaW,
          lastEventAt: stats.lastEventAt,
          recentEvents: stats.recentEvents,
          limit,
        },
        {
          command: 'brain-plasticity-stats',
          operation: 'brain.plasticity.stats',
          message: `${stats.totalEvents} plasticity event(s) recorded`,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Brain plasticity stats failed: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        { operation: 'brain.plasticity.stats' },
      );
      process.exit(1);
    }
  },
});

/** cleo brain plasticity — STDP timing-dependent plasticity operations */
const plasticityCommand = defineCommand({
  meta: {
    name: 'plasticity',
    description: 'STDP timing-dependent plasticity operations (T626 phase 5)',
  },
  subCommands: {
    stats: plasticityStatsCommand,
  },
});

/** cleo brain quality — memory quality metrics */
const qualityCommand = defineCommand({
  meta: {
    name: 'quality',
    description:
      'Show memory quality metrics: retrieval rates, top/never-retrieved entries, quality distribution, and noise ratio.',
  },
  args: {
    json: { type: 'boolean', description: 'Output results as JSON' },
  },
  async run({ args: _args }) {
    const root = getProjectRoot();

    try {
      const report = await getMemoryQualityReport(root);

      cliOutput(
        {
          totalRetrievals: report.totalRetrievals,
          uniqueEntriesRetrieved: report.uniqueEntriesRetrieved,
          usageRate: report.usageRate,
          noiseRatio: report.noiseRatio,
          qualityDistribution: report.qualityDistribution,
          tierDistribution: report.tierDistribution,
          topRetrieved: report.topRetrieved,
          neverRetrieved: report.neverRetrieved,
        },
        {
          command: 'brain-quality',
          operation: 'brain.quality',
          message: `Quality report: ${(report.usageRate * 100).toFixed(1)}% usage rate, ${(report.noiseRatio * 100).toFixed(1)}% noise`,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Brain quality report failed: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        { operation: 'brain.quality' },
      );
      process.exit(1);
    }
  },
});

/** cleo brain export — export brain graph as GEXF or JSON */
const exportCommand = defineCommand({
  meta: {
    name: 'export',
    description: 'Export brain graph as GEXF (Gephi) or JSON format',
  },
  args: {
    format: {
      type: 'string',
      description: 'Export format: gexf (Gephi standard) or json (flat arrays)',
      default: 'gexf',
    },
    output: {
      type: 'string',
      description: 'Write to file instead of stdout (optional)',
    },
  },
  async run({ args }) {
    const root = getProjectRoot();
    const format = (args.format as string) ?? 'gexf';

    if (format !== 'gexf' && format !== 'json') {
      cliError(`Invalid format: ${format}. Use 'gexf' or 'json'.`, 'E_VALIDATION', {
        name: 'E_VALIDATION',
      });
      process.exit(1);
    }

    try {
      let content: string;
      let nodeCount: number;
      let edgeCount: number;

      if (format === 'gexf') {
        const result = await exportBrainAsGexf(root);
        content = result.content;
        nodeCount = result.nodeCount;
        edgeCount = result.edgeCount;
      } else {
        const result = await exportBrainAsJson(root);
        content = JSON.stringify(result, null, 2);
        nodeCount = result.nodeCount;
        edgeCount = result.edgeCount;
      }

      if (args.output) {
        const fs = await import('node:fs');
        fs.writeFileSync(args.output as string, content, 'utf-8');
        cliOutput(
          {
            outputFile: args.output,
            nodeCount,
            edgeCount,
            format,
          },
          {
            command: 'brain-export',
            operation: 'brain.export',
            message: `Exported to ${args.output}: ${nodeCount} nodes, ${edgeCount} edges (${format.toUpperCase()})`,
          },
        );
      } else {
        // Raw content output (GEXF/JSON) goes directly to stdout — not a LAFS envelope
        process.stdout.write(content + '\n');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Brain export failed: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        {
          operation: 'brain.export',
        },
      );
      process.exit(1);
    }
  },
});

/**
 * Root brain command group — registers all brain optimization subcommands.
 *
 * Provides maintenance, backfill, purge, plasticity, quality, and export
 * subcommands for brain.db operations.
 *
 * @task T143
 * @task T1722
 * @epic T134
 * @epic T1691
 *
 * @example
 * ```ts
 * // Adds: cleo brain maintenance [--skip-decay] [--skip-consolidation] ...
 * //       cleo brain backfill [--json]
 * //       cleo brain purge [--json]
 * //       cleo brain plasticity stats [--limit <n>] [--json]
 * //       cleo brain quality [--json]
 * //       cleo brain export [--format gexf|json] [--output <file>]
 * ```
 */
export const brainCommand = defineCommand({
  meta: { name: 'brain', description: 'Brain memory optimization operations' },
  subCommands: {
    maintenance: maintenanceCommand,
    backfill: backfillBrainCommand,
    purge: purgeCommand,
    plasticity: plasticityCommand,
    quality: qualityCommand,
    export: exportCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
