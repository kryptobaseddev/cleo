/**
 * CLI command group: cleo brain
 *
 * Subcommands:
 *   cleo brain maintenance   — run temporal decay + consolidation + embedding backfill
 *
 * @task T143
 * @epic T134
 * @why Provide a single CLI entry point for brain optimization operations
 * @what Parent command group with maintenance subcommand and progress reporting
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
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the `cleo brain` command group.
 *
 * Registers a `brain` parent command and a `maintenance` subcommand that
 * combines temporal decay, memory consolidation, and embedding backfill
 * into one idempotent pass.
 *
 * @param program - The root CLI command to attach to
 *
 * @example
 * ```ts
 * registerBrainCommand(rootCommand);
 * // Adds: cleo brain maintenance [--skip-decay] [--skip-consolidation] [--skip-embeddings] [--json]
 * ```
 */
export function registerBrainCommand(program: Command): void {
  const brain = program.command('brain').description('Brain memory optimization operations');

  brain
    .command('maintenance')
    .description('Run brain maintenance: temporal decay, consolidation, and embedding backfill')
    .option(
      '--skip-decay',
      'Skip the temporal decay step (confidence reduction on stale learnings)',
    )
    .option('--skip-consolidation', 'Skip the memory consolidation step (merging old observations)')
    .option('--skip-reconciliation', 'Skip the cross-DB orphaned reference reconciliation step')
    .option(
      '--skip-tier-promotion',
      'Skip the tier promotion step (short→medium, medium→long promotion)',
    )
    .option(
      '--skip-embeddings',
      'Skip the embedding backfill step (vector generation for observations)',
    )
    .option('--json', 'Output results as JSON')
    .action(
      async (opts: {
        skipDecay?: boolean;
        skipConsolidation?: boolean;
        skipReconciliation?: boolean;
        skipTierPromotion?: boolean;
        skipEmbeddings?: boolean;
        json?: boolean;
      }) => {
        const root = getProjectRoot();
        const isJson = !!opts.json;

        if (!isJson) {
          console.log('Running brain maintenance...');
        }

        try {
          const result = await runBrainMaintenance(root, {
            skipDecay: !!opts.skipDecay,
            skipConsolidation: !!opts.skipConsolidation,
            skipReconciliation: !!opts.skipReconciliation,
            skipTierPromotion: !!opts.skipTierPromotion,
            skipEmbeddings: !!opts.skipEmbeddings,
            onProgress: isJson
              ? undefined
              : (step, current, total) => {
                  if (step === 'embeddings' && total > 0) {
                    // Inline progress for embeddings (the only long-running step)
                    if (process.stdout.isTTY) {
                      process.stdout.clearLine(0);
                      process.stdout.cursorTo(0);
                      process.stdout.write(`  [embeddings] ${current}/${total}...`);
                    } else if (current === 1 || current === total) {
                      console.log(`  [embeddings] ${current}/${total}...`);
                    }
                  } else if (current === 0) {
                    console.log(`  [${step}] starting...`);
                  } else if (current === total && total > 0) {
                    if (step === 'embeddings' && process.stdout.isTTY) {
                      process.stdout.write('\n');
                    }
                    console.log(`  [${step}] done`);
                  }
                },
          });

          if (isJson) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          // Human-readable summary
          console.log('\nMaintenance complete.');
          console.log(`  Duration: ${result.duration}ms`);

          if (!opts.skipDecay) {
            console.log(`  Decay:         ${result.decay.affected} learning(s) updated`);
          }
          if (!opts.skipConsolidation) {
            console.log(
              `  Consolidation: ${result.consolidation.merged} merged, ${result.consolidation.removed} archived`,
            );
          }
          if (!opts.skipTierPromotion) {
            console.log(
              `  Tier promotion: ${result.tierPromotion.promoted} promoted, ${result.tierPromotion.evicted} evicted`,
            );
          }
          if (!opts.skipReconciliation) {
            console.log(
              `  Reconcile:     ${result.reconciliation.decisionsFixed} decisions, ${result.reconciliation.observationsFixed} observations, ${result.reconciliation.linksRemoved} links`,
            );
          }
          if (!opts.skipEmbeddings) {
            console.log(
              `  Embeddings:    ${result.embeddings.processed} processed, ${result.embeddings.skipped} skipped, ${result.embeddings.errors} errors`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isJson) {
            console.log(JSON.stringify({ error: message }));
          } else {
            console.error(`Brain maintenance failed: ${message}`);
          }
          process.exit(1);
        }
      },
    );

  brain
    .command('backfill')
    .description(
      'Back-fill brain_page_nodes and brain_page_edges from all surviving typed table rows (decisions, patterns, learnings, observations, sticky notes). Safe to re-run — duplicates are silently skipped.',
    )
    .option('--json', 'Output results as JSON')
    .action(async (opts: { json?: boolean }) => {
      const root = getProjectRoot();
      const isJson = !!opts.json;

      if (!isJson) {
        console.log('Running brain graph back-fill...');
      }

      try {
        const result = await backfillBrainGraph(root);

        if (isJson) {
          console.log(
            JSON.stringify(
              {
                success: true,
                data: result,
                meta: { operation: 'brain.backfill', timestamp: new Date().toISOString() },
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log('\nBack-fill complete.');
        console.log(`  Before: ${result.before.nodes} nodes, ${result.before.edges} edges`);
        console.log(
          `  Source: ${result.before.decisions} decisions, ${result.before.patterns} patterns, ${result.before.learnings} learnings, ${result.before.observations} observations, ${result.before.stickyNotes} stickies`,
        );
        console.log(
          `  Nodes inserted: ${result.nodesInserted} (including ${result.stubsCreated} stub nodes)`,
        );
        console.log(`  Edges inserted: ${result.edgesInserted}`);
        console.log(`  After:  ${result.after.nodes} nodes, ${result.after.edges} edges`);
        console.log('\n  By type:');
        for (const [type, count] of Object.entries(result.byType)) {
          console.log(`    ${type}: ${count}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isJson) {
          console.log(JSON.stringify({ success: false, error: message }));
        } else {
          console.error(`Brain backfill failed: ${message}`);
        }
        process.exit(1);
      }
    });

  brain
    .command('purge')
    .description(
      'Purge noise entries from brain.db — removes duplicate patterns, all learnings, test decisions, and task-lifecycle observations. TAKE A BACKUP FIRST.',
    )
    .option('--json', 'Output results as JSON')
    .action(async (opts: { json?: boolean }) => {
      const root = getProjectRoot();
      const isJson = !!opts.json;

      if (!isJson) {
        console.log('Running brain noise purge...');
        console.log('Safety check: verifying D-mntpeeer exists before any deletes...');
      }

      try {
        const result = await purgeBrainNoise(root);

        if (isJson) {
          console.log(
            JSON.stringify(
              {
                success: true,
                data: result,
                meta: { operation: 'brain.purge', timestamp: new Date().toISOString() },
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log('\nPurge complete.');
        console.log(`  Patterns deleted:     ${result.patternsDeleted}`);
        console.log(`  Learnings deleted:    ${result.learningsDeleted}`);
        console.log(`  Decisions deleted:    ${result.decisionsDeleted}`);
        console.log(`  Observations deleted: ${result.observationsDeleted}`);
        console.log('\nPost-purge counts:');
        console.log(`  Patterns:     ${result.after.patterns}`);
        console.log(`  Learnings:    ${result.after.learnings}`);
        console.log(`  Decisions:    ${result.after.decisions}`);
        console.log(`  Observations: ${result.after.observations}`);
        console.log(`  FTS5 rebuilt: ${result.fts5Rebuilt}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isJson) {
          console.log(JSON.stringify({ success: false, error: message }));
        } else {
          console.error(`Brain purge failed: ${message}`);
        }
        process.exit(1);
      }
    });

  const plasticity = brain
    .command('plasticity')
    .description('STDP timing-dependent plasticity operations (T626 phase 5)');

  plasticity
    .command('stats')
    .description(
      'Show recent STDP plasticity events: LTP/LTD counts, net weight delta, and most recent events.',
    )
    .option('--limit <n>', 'Maximum recent events to show (default 20)', '20')
    .option('--json', 'Output results as JSON')
    .action(async (opts: { limit?: string; json?: boolean }) => {
      const root = getProjectRoot();
      const isJson = !!opts.json;
      const limit = Number(opts.limit ?? '20') || 20;

      try {
        const stats = await getPlasticityStats(root, limit);

        if (isJson) {
          console.log(
            JSON.stringify(
              {
                success: true,
                data: stats,
                meta: { operation: 'brain.plasticity.stats', timestamp: new Date().toISOString() },
              },
              null,
              2,
            ),
          );
          return;
        }

        // Human-readable output
        console.log('\nBrain Plasticity Stats (STDP)');
        console.log('═════════════════════════════════════════');
        console.log(`  Total events:       ${stats.totalEvents}`);
        console.log(`  LTP (potentiation): ${stats.ltpCount}`);
        console.log(`  LTD (depression):   ${stats.ltdCount}`);
        const sign = stats.netDeltaW >= 0 ? '+' : '';
        console.log(`  Net Δw:             ${sign}${stats.netDeltaW.toFixed(4)}`);
        console.log(`  Last event:         ${stats.lastEventAt ?? '(none)'}`);

        if (stats.recentEvents.length > 0) {
          console.log(`\nRecent Events (newest first, limit=${limit})`);
          for (const ev of stats.recentEvents) {
            const evSign = ev.deltaW >= 0 ? '+' : '';
            const src = ev.sourceNode.slice(0, 30).padEnd(30);
            const tgt = ev.targetNode.slice(0, 30).padEnd(30);
            console.log(
              `  [${ev.kind.toUpperCase()}] ${src} → ${tgt}  Δw=${evSign}${ev.deltaW.toFixed(4)}  ${ev.timestamp}`,
            );
          }
        } else {
          console.log('\n  No plasticity events recorded yet.');
          console.log('  Run `cleo brain maintenance` or `cleo session end` to trigger STDP.');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isJson) {
          console.log(JSON.stringify({ success: false, error: message }));
        } else {
          console.error(`Brain plasticity stats failed: ${message}`);
        }
        process.exit(1);
      }
    });

  brain
    .command('quality')
    .description(
      'Show memory quality metrics: retrieval rates, top/never-retrieved entries, quality distribution, and noise ratio.',
    )
    .option('--json', 'Output results as JSON')
    .action(async (opts: { json?: boolean }) => {
      const root = getProjectRoot();
      const isJson = !!opts.json;

      try {
        const report = await getMemoryQualityReport(root);

        if (isJson) {
          console.log(
            JSON.stringify(
              {
                success: true,
                data: report,
                meta: { operation: 'brain.quality', timestamp: new Date().toISOString() },
              },
              null,
              2,
            ),
          );
          return;
        }

        // Human-readable output
        console.log('\nBrain Memory Quality Report');
        console.log('══════════════════════════════════════════');
        console.log(`  Total retrievals:       ${report.totalRetrievals}`);
        console.log(`  Unique entries hit:     ${report.uniqueEntriesRetrieved}`);
        console.log(`  Usage rate:             ${(report.usageRate * 100).toFixed(1)}%`);
        console.log(`  Noise ratio:            ${(report.noiseRatio * 100).toFixed(1)}%`);

        console.log('\nQuality Distribution');
        console.log(`  Low  (<0.3):    ${report.qualityDistribution.low}`);
        console.log(`  Med  (0.3-0.6): ${report.qualityDistribution.medium}`);
        console.log(`  High (>0.6):    ${report.qualityDistribution.high}`);

        console.log('\nTier Distribution');
        console.log(`  Short:   ${report.tierDistribution.short}`);
        console.log(`  Medium:  ${report.tierDistribution.medium}`);
        console.log(`  Long:    ${report.tierDistribution.long}`);
        if (report.tierDistribution.unknown > 0) {
          console.log(`  Unknown: ${report.tierDistribution.unknown}`);
        }

        if (report.topRetrieved.length > 0) {
          console.log('\nTop 10 Most Retrieved');
          for (const e of report.topRetrieved) {
            console.log(`  [${e.citationCount}x] ${e.id}  ${e.title.slice(0, 60)}`);
          }
        }

        if (report.neverRetrieved.length > 0) {
          console.log('\nNever Retrieved (pruning candidates)');
          for (const e of report.neverRetrieved) {
            console.log(`  q=${e.qualityScore.toFixed(2)}  ${e.id}  ${e.title.slice(0, 60)}`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isJson) {
          console.log(JSON.stringify({ success: false, error: message }));
        } else {
          console.error(`Brain quality report failed: ${message}`);
        }
        process.exit(1);
      }
    });

  brain
    .command('export')
    .description('Export brain graph as GEXF (Gephi) or JSON format')
    .option(
      '--format <format>',
      'Export format: gexf (Gephi standard) or json (flat arrays)',
      'gexf',
    )
    .option('--output <file>', 'Write to file instead of stdout (optional)')
    .action(async (opts: { format?: string; output?: string }) => {
      const root = getProjectRoot();
      const format = opts.format ?? 'gexf';

      if (format !== 'gexf' && format !== 'json') {
        console.error(`Invalid format: ${format}. Use 'gexf' or 'json'.`);
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

        // Output to file or stdout
        if (opts.output) {
          // Use dynamic import for writeFileSync to avoid bundling issues
          const fs = await import('node:fs');
          fs.writeFileSync(opts.output, content, 'utf-8');
          console.log(
            `Exported to ${opts.output}: ${nodeCount} nodes, ${edgeCount} edges (${format.toUpperCase()})`,
          );
        } else {
          console.log(content);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Brain export failed: ${message}`);
        process.exit(1);
      }
    });
}
