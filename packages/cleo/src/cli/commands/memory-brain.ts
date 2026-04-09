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

import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';
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
    // T418: agent filter for per-agent mental model retrieval
    .option('--agent <name>', 'Filter observations by agent provenance name (Wave 8 mental models)')
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
            // T418: forward agent filter when provided
            ...(opts['agent'] !== undefined && { agent: opts['agent'] }),
          },
          { command: 'memory', operation: 'memory.find' },
        );
      }
    });

  // -- stats (delegates to pattern.find + learning.find with empty query) --
  memory
    .command('stats')
    .description('Show BRAIN memory statistics')
    .option('--json', 'Output as JSON')
    .action(async () => {
      // Fetch both pattern and learning summaries via find with empty query
      const pResponse = await dispatchRaw('query', 'memory', 'pattern.find', {
        query: '',
        limit: 0,
      });
      const lResponse = await dispatchRaw('query', 'memory', 'learning.find', {
        query: '',
        limit: 0,
      });

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
    // T417: tag observation with agent provenance for per-agent mental model retrieval
    .option('--agent <name>', 'Tag this observation with the producing agent name (Wave 8 mental models)')
    .action(async (text: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'memory',
        'observe',
        {
          text,
          title: opts['title'],
          ...(opts['agent'] !== undefined && { agent: opts['agent'] }),
        },
        { command: 'memory', operation: 'memory.observe' },
      );
    });

  // -- timeline (chronological context around an anchor observation ID) --
  memory
    .command('timeline <anchor>')
    .description('Show chronological context around an anchor observation ID')
    .option('--before <n>', 'Number of entries before anchor', parseInt)
    .option('--after <n>', 'Number of entries after anchor', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (anchor: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'memory',
        'timeline',
        {
          anchor,
          depthBefore: opts['before'],
          depthAfter: opts['after'],
        },
        { command: 'memory', operation: 'memory.timeline' },
      );
    });

  // -- fetch (retrieve full details for specific observation IDs) --
  // Note: citty doesn't support variadic positional args, so we accept a single
  // positional and split on commas/spaces to support: `cleo memory fetch ID1,ID2`
  memory
    .command('fetch <ids>')
    .description('Fetch full details for specific observation IDs')
    .option('--json', 'Output as JSON')
    .action(async (idsRaw: string, _opts: Record<string, unknown>) => {
      const ids = idsRaw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await dispatchFromCli(
        'query',
        'memory',
        'fetch',
        { ids },
        { command: 'memory', operation: 'memory.fetch' },
      );
    });
}
