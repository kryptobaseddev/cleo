/**
 * CLI memory commands for BRAIN pattern and learning memory.
 *
 * Commands:
 *   cleo memory store --type <type> --content <text> --context <text>
 *   cleo memory find <query> [--type pattern|learning]
 *   cleo memory stats
 *
 * @task T4770
 * @epic T4763
 */

import type { Command } from 'commander';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

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
    .option(
      '--pattern-type <type>',
      'Pattern type: workflow, blocker, success, failure, optimization',
    )
    .option('--impact <level>', 'Impact level: low, medium, high')
    .option('--confidence <n>', 'Confidence score 0.0-1.0 (for learnings)', parseFloat)
    .option('--actionable', 'Mark learning as actionable')
    .option('--linked-task <id>', 'Task ID to link this memory to')
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, unknown>) => {
      const memType = opts['type'] as string;

      if (memType === 'pattern') {
        await dispatchFromCli(
          'mutate',
          'memory',
          'pattern.store',
          {
            type: opts['patternType'] || 'workflow',
            pattern: opts['content'],
            context: opts['context'] || 'Unspecified context',
            impact: opts['impact'],
            examples: opts['linkedTask'] ? [opts['linkedTask']] : [],
          },
          { command: 'memory', operation: 'memory.pattern.store' },
        );
      } else if (memType === 'learning') {
        await dispatchFromCli(
          'mutate',
          'memory',
          'learning.store',
          {
            insight: opts['content'],
            source: opts['source'] || 'manual',
            confidence: opts['confidence'] ?? 0.5,
            actionable: !!opts['actionable'],
            applicableTypes: opts['linkedTask'] ? [opts['linkedTask']] : [],
          },
          { command: 'memory', operation: 'memory.learning.store' },
        );
      } else {
        console.error(`Unknown memory type: ${memType}. Use 'pattern' or 'learning'.`);
        process.exit(1);
      }
    });

  // -- find (cross-table FTS5 search, or type-specific with --type) --
  memory
    .command('find <query>')
    .description('Search BRAIN memory (all tables, or filter by --type pattern|learning)')
    .option('--type <type>', 'Filter by memory type: pattern or learning (default: all)')
    .option(
      '--pattern-type <type>',
      'Filter patterns by type: workflow, blocker, success, failure, optimization',
    )
    .option('--min-confidence <n>', 'Minimum confidence for learnings', parseFloat)
    .option('--actionable', 'Only show actionable learnings')
    .option('--limit <n>', 'Maximum results', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (query: string, opts: Record<string, unknown>) => {
      const memType = opts['type'] as string | undefined;

      if (memType === 'pattern') {
        await dispatchFromCli(
          'query',
          'memory',
          'pattern.find',
          {
            query,
            type: opts['patternType'],
            limit: opts['limit'],
          },
          { command: 'memory', operation: 'memory.find' },
        );
      } else if (memType === 'learning') {
        await dispatchFromCli(
          'query',
          'memory',
          'learning.find',
          {
            query,
            minConfidence: opts['minConfidence'],
            actionableOnly: !!opts['actionable'],
            limit: opts['limit'],
          },
          { command: 'memory', operation: 'memory.find' },
        );
      } else {
        await dispatchFromCli(
          'query',
          'memory',
          'find',
          {
            query,
            limit: opts['limit'],
          },
          { command: 'memory', operation: 'memory.find' },
        );
      }
    });

  // -- stats --
  memory
    .command('stats')
    .description('Show BRAIN memory statistics')
    .option('--json', 'Output as JSON')
    .action(async () => {
      // Fetch both pattern and learning stats via dispatch
      const pResponse = await dispatchRaw('query', 'memory', 'pattern.stats', {});
      const lResponse = await dispatchRaw('query', 'memory', 'learning.stats', {});

      const result: Record<string, unknown> = {};
      if (pResponse.success) result['patterns'] = pResponse.data;
      if (lResponse.success) result['learnings'] = lResponse.data;

      if (!pResponse.success && !lResponse.success) {
        handleRawError(pResponse, { command: 'memory', operation: 'memory.stats' });
        return;
      }

      cliOutput(result, { command: 'memory', operation: 'memory.stats' });
    });

  // -- observe (save observation to brain.db) --
  memory
    .command('observe <text>')
    .description('Save an observation to brain.db')
    .option('--title <title>', 'Short title for the observation')
    .action(async (text: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'memory',
        'observe',
        {
          text,
          title: opts['title'],
        },
        { command: 'memory', operation: 'memory.observe' },
      );
    });
}
