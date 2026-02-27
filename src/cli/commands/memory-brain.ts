/**
 * CLI memory commands for BRAIN pattern and learning memory.
 *
 * Commands:
 *   cleo memory store --type <type> --content <text> --context <text>
 *   cleo memory recall <query>
 *   cleo memory search <query> --type <type>
 *   cleo memory stats
 *
 * @task T4770
 * @epic T4763
 */

import { Command } from 'commander';
import { getProjectRoot } from '../../core/paths.js';
import {
  storePattern,
  searchPatterns,
  patternStats,
  type PatternType,
} from '../../core/memory/patterns.js';
import {
  storeLearning,
  searchLearnings,
  learningStats,
} from '../../core/memory/learnings.js';

export function registerMemoryBrainCommand(program: Command): void {
  const memory = program
    .command('memory')
    .description('BRAIN memory operations (patterns, learnings)');

  // -- store --
  memory
    .command('store')
    .description('Store a pattern or learning to BRAIN memory')
    .requiredOption('--type <type>', 'Memory type: pattern or learning')
    .requiredOption('--content <text>', 'Content of the memory entry')
    .option('--context <text>', 'Context in which the pattern/learning was observed')
    .option('--source <text>', 'Source of the learning')
    .option('--pattern-type <type>', 'Pattern type: workflow, blocker, success, failure, optimization')
    .option('--impact <level>', 'Impact level: low, medium, high')
    .option('--confidence <n>', 'Confidence score 0.0-1.0 (for learnings)', parseFloat)
    .option('--actionable', 'Mark learning as actionable')
    .option('--linked-task <id>', 'Task ID to link this memory to')
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, unknown>) => {
      const root = getProjectRoot();
      const memType = opts['type'] as string;

      try {
        if (memType === 'pattern') {
          const result = storePattern(root, {
            type: (opts['patternType'] as PatternType) || 'workflow',
            pattern: opts['content'] as string,
            context: (opts['context'] as string) || 'Unspecified context',
            impact: opts['impact'] as 'low' | 'medium' | 'high' | undefined,
            examples: opts['linkedTask'] ? [opts['linkedTask'] as string] : [],
          });

          if (opts['json']) {
            console.log(JSON.stringify({ success: true, result }, null, 2));
          } else {
            console.log(`Pattern stored: ${result.id} (${result.type})`);
            console.log(`  Pattern: ${result.pattern}`);
            console.log(`  Frequency: ${result.frequency}`);
          }
        } else if (memType === 'learning') {
          const result = storeLearning(root, {
            insight: opts['content'] as string,
            source: (opts['source'] as string) || 'manual',
            confidence: (opts['confidence'] as number) ?? 0.5,
            actionable: !!opts['actionable'],
            applicableTypes: opts['linkedTask'] ? [opts['linkedTask'] as string] : [],
          });

          if (opts['json']) {
            console.log(JSON.stringify({ success: true, result }, null, 2));
          } else {
            console.log(`Learning stored: ${result.id}`);
            console.log(`  Insight: ${result.insight}`);
            console.log(`  Confidence: ${result.confidence}`);
          }
        } else {
          console.error(`Unknown memory type: ${memType}. Use 'pattern' or 'learning'.`);
          process.exit(1);
        }
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // -- recall / search --
  memory
    .command('recall <query>')
    .alias('search')
    .description('Search BRAIN memory for patterns and learnings')
    .option('--type <type>', 'Filter by memory type: pattern or learning')
    .option('--pattern-type <type>', 'Filter patterns by type: workflow, blocker, success, failure, optimization')
    .option('--min-confidence <n>', 'Minimum confidence for learnings', parseFloat)
    .option('--actionable', 'Only show actionable learnings')
    .option('--limit <n>', 'Maximum results per category', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (query: string, opts: Record<string, unknown>) => {
      const root = getProjectRoot();
      const memType = opts['type'] as string | undefined;
      const limit = (opts['limit'] as number) || 10;

      const results: { patterns: unknown[]; learnings: unknown[] } = {
        patterns: [],
        learnings: [],
      };

      if (!memType || memType === 'pattern') {
        results.patterns = searchPatterns(root, {
          query,
          type: opts['patternType'] as PatternType | undefined,
          limit,
        });
      }

      if (!memType || memType === 'learning') {
        results.learnings = searchLearnings(root, {
          query,
          minConfidence: opts['minConfidence'] as number | undefined,
          actionableOnly: !!opts['actionable'],
          limit,
        });
      }

      if (opts['json']) {
        console.log(JSON.stringify({ success: true, results }, null, 2));
      } else {
        const totalResults =
          results.patterns.length + results.learnings.length;

        if (totalResults === 0) {
          console.log('No matching memories found.');
          return;
        }

        if (results.patterns.length > 0) {
          console.log(`\nPatterns (${results.patterns.length}):`);
          for (const p of results.patterns as Array<{ id: string; type: string; pattern: string; frequency: number }>) {
            console.log(`  ${p.id} [${p.type}] (freq: ${p.frequency}) ${p.pattern}`);
          }
        }

        if (results.learnings.length > 0) {
          console.log(`\nLearnings (${results.learnings.length}):`);
          for (const l of results.learnings as Array<{ id: string; insight: string; confidence: number }>) {
            console.log(`  ${l.id} (conf: ${l.confidence}) ${l.insight}`);
          }
        }
      }
    });

  // -- stats --
  memory
    .command('stats')
    .description('Show BRAIN memory statistics')
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, unknown>) => {
      const root = getProjectRoot();

      const pStats = patternStats(root);
      const lStats = learningStats(root);

      if (opts['json']) {
        console.log(JSON.stringify({
          success: true,
          result: { patterns: pStats, learnings: lStats },
        }, null, 2));
      } else {
        console.log('BRAIN Memory Statistics');
        console.log('======================');
        console.log(`\nPatterns: ${pStats.total} total`);
        if (pStats.total > 0) {
          for (const [type, count] of Object.entries(pStats.byType)) {
            if (count > 0) console.log(`  ${type}: ${count}`);
          }
          if (pStats.highestFrequency) {
            console.log(`  Most common: "${pStats.highestFrequency.pattern}" (${pStats.highestFrequency.frequency}x)`);
          }
        }
        console.log(`\nLearnings: ${lStats.total} total`);
        if (lStats.total > 0) {
          console.log(`  Actionable: ${lStats.actionable}`);
          console.log(`  Avg confidence: ${lStats.averageConfidence}`);
          console.log(`  High confidence (>0.8): ${lStats.highConfidence}`);
        }
      }
    });
}
