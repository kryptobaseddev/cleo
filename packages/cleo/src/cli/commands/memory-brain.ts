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
  // Output format is controlled by the global --json/--human flags (format-context),
  // not by a per-command --json option (the global flag is resolved pre-dispatch).
  memory
    .command('stats')
    .description('Show BRAIN memory statistics')
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
        handleRawError(pResponse, { command: 'memory-stats', operation: 'memory.stats' });
        return;
      }

      cliOutput(result, { command: 'memory-stats', operation: 'memory.stats' });
    });

  // -- observe (save observation to brain.db) --
  memory
    .command('observe <text>')
    .description(
      'Save an observation to brain.db — captures facts, decisions, and discoveries for cross-session memory',
    )
    .option(
      '--title <title>',
      'Short title for the observation (defaults to first 120 chars of text)',
    )
    .option(
      '--type <type>',
      'Category: discovery (found something new), decision (choice made), bugfix (bug found/fixed), refactor (code restructured), feature (feature added), change (general change), pattern (recurring pattern), session_summary (end-of-session recap)',
    )
    .option(
      '--agent <name>',
      'Name of the agent producing this observation (enables per-agent memory retrieval)',
    )
    .option(
      '--source-type <sourceType>',
      'How this observation was captured: manual (typed by human/agent), auto (lifecycle hook), transcript (extracted from session)',
    )
    .action(async (text: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'memory',
        'observe',
        {
          text,
          title: opts['title'],
          ...(opts['agent'] !== undefined && { agent: opts['agent'] }),
          ...(opts['type'] !== undefined && { type: opts['type'] }),
          sourceType: (opts['sourceType'] as string | undefined) ?? 'manual',
        },
        { command: 'memory', operation: 'memory.observe' },
      );
    });

  // -- timeline (chronological context around an anchor observation ID) --
  // Output format is controlled by the global --json/--human flags (format-context).
  memory
    .command('timeline <anchor>')
    .description('Show chronological context around an anchor observation ID')
    .option('--before <n>', 'Number of entries before anchor', parseInt)
    .option('--after <n>', 'Number of entries after anchor', parseInt)
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
        { command: 'memory-timeline', operation: 'memory.timeline' },
      );
    });

  // -- fetch (retrieve full details for specific observation IDs) --
  // Note: citty doesn't support variadic positional args, so we accept a single
  // positional and split on commas/spaces to support: `cleo memory fetch ID1,ID2`
  // Output format is controlled by the global --json/--human flags (format-context).
  memory
    .command('fetch <ids>')
    .description('Fetch full details for specific observation IDs')
    .action(async (idsRaw: string) => {
      const ids = idsRaw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await dispatchFromCli(
        'query',
        'memory',
        'fetch',
        { ids },
        { command: 'memory-fetch', operation: 'memory.fetch' },
      );
    });

  // -- decision-find --
  memory
    .command('decision-find [query]')
    .description('Search decisions stored in brain.db')
    .option('--limit <n>', 'Maximum results', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (query: string | undefined, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'memory',
        'decision.find',
        {
          query: query ?? '',
          limit: opts['limit'],
        },
        { command: 'memory', operation: 'memory.decision.find' },
      );
    });

  // -- decision-store --
  memory
    .command('decision-store')
    .description('Store a decision to brain.db')
    .requiredOption('--decision <text>', 'The decision that was made')
    .requiredOption('--rationale <text>', 'Rationale behind the decision')
    .option('--alternatives <text>', 'Alternatives that were considered')
    .option('--linked-task <id>', 'Task ID to associate with this decision')
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'memory',
        'decision.store',
        {
          decision: opts['decision'],
          rationale: opts['rationale'],
          ...(opts['alternatives'] !== undefined && { alternatives: opts['alternatives'] }),
          ...(opts['linkedTask'] !== undefined && { taskId: opts['linkedTask'] }),
        },
        { command: 'memory', operation: 'memory.decision.store' },
      );
    });

  // -- link (link a brain entry to a task) --
  memory
    .command('link <taskId> <entryId>')
    .description('Link a brain entry to a task')
    .option('--json', 'Output as JSON')
    .action(async (taskId: string, entryId: string, _opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'memory',
        'link',
        { taskId, entryId },
        { command: 'memory', operation: 'memory.link' },
      );
    });

  // -- graph-show --
  memory
    .command('graph-show <nodeId>')
    .description('Get a PageIndex graph node and its edges')
    .option('--json', 'Output as JSON')
    .action(async (nodeId: string, _opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'memory',
        'graph.show',
        { nodeId },
        { command: 'memory', operation: 'memory.graph.show' },
      );
    });

  // -- graph-neighbors --
  memory
    .command('graph-neighbors <nodeId>')
    .description('Get neighbor nodes from the PageIndex graph')
    .option('--depth <n>', 'Traversal depth', parseInt)
    .option('--limit <n>', 'Maximum neighbors', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (nodeId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'memory',
        'graph.neighbors',
        {
          nodeId,
          ...(opts['depth'] !== undefined && { depth: opts['depth'] }),
          ...(opts['limit'] !== undefined && { limit: opts['limit'] }),
        },
        { command: 'memory', operation: 'memory.graph.neighbors' },
      );
    });

  // -- graph-add --
  memory
    .command('graph-add')
    .description('Add a node or edge to the PageIndex graph')
    .option('--node-id <id>', 'Node ID to add')
    .option('--node-type <type>', 'Node type (e.g. concept, task, file)')
    .option('--label <text>', 'Label for the node')
    .option('--from <id>', 'Source node ID for an edge')
    .option('--to <id>', 'Target node ID for an edge')
    .option('--edge-type <type>', 'Edge relationship type')
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'memory',
        'graph.add',
        {
          ...(opts['nodeId'] !== undefined && { nodeId: opts['nodeId'] }),
          ...(opts['nodeType'] !== undefined && { nodeType: opts['nodeType'] }),
          ...(opts['label'] !== undefined && { label: opts['label'] }),
          ...(opts['from'] !== undefined && { fromId: opts['from'] }),
          ...(opts['to'] !== undefined && { toId: opts['to'] }),
          ...(opts['edgeType'] !== undefined && { edgeType: opts['edgeType'] }),
        },
        { command: 'memory', operation: 'memory.graph.add' },
      );
    });

  // -- graph-remove --
  memory
    .command('graph-remove')
    .description('Remove a node or edge from the PageIndex graph')
    .option('--node-id <id>', 'Node ID to remove')
    .option('--from <id>', 'Source node ID of the edge to remove')
    .option('--to <id>', 'Target node ID of the edge to remove')
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'memory',
        'graph.remove',
        {
          ...(opts['nodeId'] !== undefined && { nodeId: opts['nodeId'] }),
          ...(opts['from'] !== undefined && { fromId: opts['from'] }),
          ...(opts['to'] !== undefined && { toId: opts['to'] }),
        },
        { command: 'memory', operation: 'memory.graph.remove' },
      );
    });

  // -- reason-why (causal trace through task dependency chains) --
  memory
    .command('reason-why <taskId>')
    .description('Causal trace through task dependency chains')
    .option('--depth <n>', 'Maximum trace depth', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'memory',
        'reason.why',
        {
          taskId,
          ...(opts['depth'] !== undefined && { depth: opts['depth'] }),
        },
        { command: 'memory', operation: 'memory.reason.why' },
      );
    });

  // -- reason-similar (find semantically similar brain entries) --
  memory
    .command('reason-similar <entryId>')
    .description('Find semantically similar brain entries')
    .option('--limit <n>', 'Maximum results', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (entryId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'memory',
        'reason.similar',
        {
          entryId,
          ...(opts['limit'] !== undefined && { limit: opts['limit'] }),
        },
        { command: 'memory', operation: 'memory.reason.similar' },
      );
    });

  // -- search-hybrid (hybrid search across FTS5, vector, and graph) --
  memory
    .command('search-hybrid <query>')
    .description('Hybrid search across FTS5, vector, and graph indexes')
    .option('--limit <n>', 'Maximum results', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (query: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'memory',
        'search.hybrid',
        {
          query,
          ...(opts['limit'] !== undefined && { limit: opts['limit'] }),
        },
        { command: 'memory', operation: 'memory.search.hybrid' },
      );
    });
}
