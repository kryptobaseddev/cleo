/**
 * CLI memory commands for BRAIN pattern and learning memory.
 *
 * Commands:
 *   cleo memory store --type <type> --content <text> --context <text>
 *   cleo memory find <query> [--type pattern|learning]
 *   cleo memory stats
 *   cleo memory observe <text> [--title <title>] [--type <type>]
 *   cleo memory import --from <dir> [--dry-run]
 *   cleo memory consolidate — run full consolidation pipeline (tier promotion, dedup, etc.)
 *
 * @task T4770 T614 T629
 * @epic T4763 T627
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProjectRoot, runConsolidation } from '@cleocode/core/internal';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Memory import helpers (T629 — provider-agnostic migration)
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a markdown string.
 * Supports simple `key: value` pairs only (no nested YAML).
 *
 * @param raw - Raw file content
 * @returns Extracted frontmatter fields and body text
 */
function parseMemoryFileFrontmatter(raw: string): {
  name?: string;
  description?: string;
  type?: string;
  body: string;
} {
  const lines = raw.split('\n');
  if (!lines[0]?.trim().startsWith('---')) {
    return { body: raw.trim() };
  }

  const endIdx = lines.slice(1).findIndex((l) => /^---\s*$/.test(l));
  if (endIdx === -1) {
    return { body: raw.trim() };
  }

  const fmLines = lines.slice(1, endIdx + 1);
  const body = lines
    .slice(endIdx + 2)
    .join('\n')
    .trim();

  const fm: Record<string, string> = {};
  for (const line of fmLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) fm[key] = value;
  }

  return {
    name: fm['name'],
    description: fm['description'],
    type: fm['type'],
    body,
  };
}

/**
 * Compute a 16-char hex content fingerprint for dedup.
 *
 * @param title - Entry title
 * @param body - Entry body text
 * @returns 16-char hex prefix of SHA-256 hash
 */
function memoryContentHash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex').slice(0, 16);
}

/** Load set of already-imported content hashes from the dedup state file. */
function loadImportHashes(stateFile: string): Set<string> {
  try {
    if (!existsSync(stateFile)) return new Set();
    const raw = readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(raw) as { hashes: string[] };
    return new Set(parsed.hashes);
  } catch {
    return new Set();
  }
}

/** Persist updated set of imported hashes to the dedup state file. */
function saveImportHashes(stateFile: string, hashes: Set<string>): void {
  const dir = stateFile.slice(0, stateFile.lastIndexOf('/'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ hashes: [...hashes] }, null, 2), 'utf-8');
}

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

  // -- trace (BFS traversal from a seed node via recursive CTE) --
  memory
    .command('trace <nodeId>')
    .description('BFS traversal of the brain knowledge graph from a seed node')
    .option('--depth <n>', 'Maximum traversal depth (default: 3)', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (nodeId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'memory',
        'graph.trace',
        {
          nodeId,
          ...(opts['depth'] !== undefined && { maxDepth: opts['depth'] }),
        },
        { command: 'memory-trace', operation: 'memory.graph.trace' },
      );
    });

  // -- related (1-hop neighbours with edge metadata) --
  memory
    .command('related <nodeId>')
    .description('Return immediate (1-hop) neighbours of a brain graph node')
    .option('--type <edgeType>', 'Filter by edge type (e.g. applies_to, supports, derived_from)')
    .option('--json', 'Output as JSON')
    .action(async (nodeId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'memory',
        'graph.related',
        {
          nodeId,
          ...(opts['type'] !== undefined && { edgeType: opts['type'] }),
        },
        { command: 'memory-related', operation: 'memory.graph.related' },
      );
    });

  // -- context (360-degree view of a single node) --
  memory
    .command('context <nodeId>')
    .description('360-degree context view of a brain graph node: node + all edges + neighbours')
    .option('--json', 'Output as JSON')
    .action(async (nodeId: string, _opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'memory',
        'graph.context',
        { nodeId },
        { command: 'memory-context', operation: 'memory.graph.context' },
      );
    });

  // -- graph-stats (aggregate counts by type) --
  memory
    .command('graph-stats')
    .description('Show brain knowledge graph statistics: node and edge counts by type')
    .option('--json', 'Output as JSON')
    .action(async (_opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'memory',
        'graph.stats',
        {},
        { command: 'memory-graph-stats', operation: 'memory.graph.stats' },
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

  // -- code-links (show all code ↔ memory connections) --
  memory
    .command('code-links')
    .description('Show code ↔ memory connections (code_reference edges between brain and nexus)')
    .option('--limit <n>', 'Maximum entries to return (default 100)', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'memory',
        'code.links',
        {
          ...(opts['limit'] !== undefined && { limit: opts['limit'] }),
        },
        { command: 'memory', operation: 'memory.code.links' },
      );
    });

  // -- code-auto-link (scan brain nodes and auto-link to nexus) --
  memory
    .command('code-auto-link')
    .description('Scan brain memory nodes for entity references and auto-link to nexus code nodes')
    .option('--json', 'Output as JSON')
    .action(async () => {
      await dispatchFromCli(
        'mutate',
        'memory',
        'code.auto-link',
        {},
        {
          command: 'memory',
          operation: 'memory.code.auto-link',
        },
      );
    });

  // -- code-memories-for-code (find memories that reference a code symbol) --
  memory
    .command('code-memories-for-code <symbol>')
    .description('Find brain memory nodes that reference a given nexus code symbol')
    .option('--json', 'Output as JSON')
    .action(async (symbol: string) => {
      await dispatchFromCli(
        'query',
        'memory',
        'code.memories-for-code',
        { symbol },
        { command: 'memory', operation: 'memory.code.memories-for-code' },
      );
    });

  // -- code-for-memory (find code nodes referenced by a memory entry) --
  memory
    .command('code-for-memory <memoryId>')
    .description('Find nexus code nodes referenced by a given brain memory entry')
    .option('--json', 'Output as JSON')
    .action(async (memoryId: string) => {
      await dispatchFromCli(
        'query',
        'memory',
        'code.for-memory',
        { memoryId },
        { command: 'memory', operation: 'memory.code.for-memory' },
      );
    });

  // -- consolidate (run full consolidation pipeline, including tier promotion) --
  memory
    .command('consolidate')
    .description(
      'Run the full brain consolidation pipeline: dedup, quality recompute, tier promotion, ' +
        'contradiction detection, soft eviction, graph strengthening, summary generation. ' +
        'Equivalent to the session-end sleep-time consolidation but triggered on demand.',
    )
    .option('--json', 'Output results as JSON')
    .action(async (opts: { json?: boolean }) => {
      const root = getProjectRoot();
      const isJson = !!opts.json;

      if (!isJson) {
        console.log('Running memory consolidation (including tier promotion)...');
      }

      try {
        const result = await runConsolidation(root);

        if (isJson) {
          console.log(
            JSON.stringify(
              {
                success: true,
                data: result,
                meta: {
                  operation: 'memory.consolidate',
                  timestamp: new Date().toISOString(),
                },
              },
              null,
              2,
            ),
          );
          return;
        }

        // Human-readable output
        console.log('\nConsolidation complete.');
        console.log(`  Deduplicated:    ${result.deduplicated}`);
        console.log(`  Quality recomp:  ${result.qualityRecomputed}`);
        console.log(`  Tier promoted:   ${result.tierPromotions.promoted.length} entries promoted`);
        console.log(`  Tier evicted:    ${result.tierPromotions.evicted.length} entries evicted`);
        console.log(`  Contradictions:  ${result.contradictions}`);
        console.log(`  Soft evicted:    ${result.softEvicted}`);
        console.log(`  Edges strength:  ${result.edgesStrengthened}`);
        console.log(`  Summaries gen:   ${result.summariesGenerated}`);
        if (result.graphLinksCreated !== undefined) {
          console.log(`  Graph links:     ${result.graphLinksCreated}`);
        }

        if (result.tierPromotions.promoted.length > 0) {
          console.log('\nTier promotions:');
          for (const p of result.tierPromotions.promoted) {
            console.log(`  [${p.table}] ${p.id}: ${p.fromTier} → ${p.toTier} (${p.reason})`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isJson) {
          console.log(JSON.stringify({ success: false, error: message }));
        } else {
          console.error(`Memory consolidation failed: ${message}`);
        }
        process.exit(1);
      }
    });

  // -- import (migrate MEMORY.md files to brain.db — T629 provider-agnostic) --
  memory
    .command('import')
    .description(
      'Import memory files from a provider-specific directory (e.g. ~/.claude/projects/*/memory/) into brain.db. ' +
        'Enables provider-agnostic memory via CLEO CLI instead of Claude Code MEMORY.md.',
    )
    .option(
      '--from <dir>',
      'Source directory containing *.md memory files ' +
        '(default: ~/.claude/projects/-mnt-projects-cleocode/memory)',
    )
    .option('--dry-run', 'Print what would be imported without writing to brain.db')
    .option('--json', 'Output results as JSON')
    .action(async (opts: { from?: string; dryRun?: boolean; json?: boolean }) => {
      const sourceDir =
        opts.from ?? join(homedir(), '.claude', 'projects', '-mnt-projects-cleocode', 'memory');
      const isDryRun = !!opts.dryRun;
      const isJson = !!opts.json;
      const projectRoot = getProjectRoot();
      const stateFile = join(projectRoot, '.cleo', 'migrate-memory-hashes.json');

      if (!existsSync(sourceDir)) {
        const msg = `Source directory not found: ${sourceDir}`;
        if (isJson) {
          console.log(JSON.stringify({ success: false, error: msg }));
        } else {
          console.error(msg);
        }
        process.exit(1);
      }

      const files = readdirSync(sourceDir)
        .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
        .map((f) => join(sourceDir, f));

      const importedHashes = isDryRun ? new Set<string>() : loadImportHashes(stateFile);
      const stats = { total: files.length, imported: 0, skipped: 0, errors: 0 };
      const importedEntries: Array<{ file: string; type: string; title: string }> = [];
      const skippedEntries: Array<{ file: string; reason: string }> = [];
      const errorEntries: Array<{ file: string; error: string }> = [];

      if (!isJson) {
        console.log(`Importing memory from: ${sourceDir}`);
        console.log(`Files found: ${files.length}`);
        if (isDryRun) console.log('Mode: DRY RUN');
        console.log('');
      }

      for (const filePath of files) {
        const fileName = filePath.split('/').pop() ?? filePath;
        try {
          const raw = readFileSync(filePath, 'utf-8');
          if (!raw.trim()) {
            stats.skipped++;
            skippedEntries.push({ file: fileName, reason: 'empty file' });
            continue;
          }

          const { name, description, type, body } = parseMemoryFileFrontmatter(raw);
          const title = name ?? fileName.replace(/\.md$/, '').replace(/-/g, ' ');
          const bodyParts = [description, body].filter(Boolean);
          const fullText = bodyParts.join('\n\n').trim();

          if (!fullText) {
            stats.skipped++;
            skippedEntries.push({ file: fileName, reason: 'empty body' });
            continue;
          }

          const hash = memoryContentHash(title, fullText);

          if (!isDryRun && importedHashes.has(hash)) {
            stats.skipped++;
            skippedEntries.push({ file: fileName, reason: `already imported (hash: ${hash})` });
            if (!isJson) console.log(`  [SKIP] ${fileName}`);
            continue;
          }

          const entryType = type ?? 'project';

          if (!isJson) {
            const prefix = isDryRun ? '[DRY-RUN]' : '[IMPORT]';
            console.log(`  ${prefix} ${fileName} (type: ${entryType})`);
          }

          if (!isDryRun) {
            // Route by frontmatter type
            if (entryType === 'feedback') {
              // Feedback → learning
              await dispatchFromCli(
                'mutate',
                'memory',
                'learning.store',
                {
                  insight: `[MIGRATED] ${title}: ${fullText}`,
                  source: 'manual',
                  confidence: 0.8,
                  actionable: false,
                },
                { command: 'memory', operation: 'memory.learning.store' },
              );
            } else {
              // project | reference | user | default → observation
              const observeType =
                entryType === 'project'
                  ? 'feature'
                  : entryType === 'reference'
                    ? 'discovery'
                    : entryType === 'user'
                      ? 'change'
                      : 'discovery';

              await dispatchFromCli(
                'mutate',
                'memory',
                'observe',
                {
                  text: `[MIGRATED] ${title}: ${fullText}`,
                  title: `[MIGRATED] ${title}`,
                  type: observeType,
                  sourceType: 'manual',
                },
                { command: 'memory', operation: 'memory.observe' },
              );
            }

            importedHashes.add(hash);
          }

          stats.imported++;
          importedEntries.push({ file: fileName, type: entryType, title });
        } catch (err) {
          stats.errors++;
          const message = err instanceof Error ? err.message : String(err);
          errorEntries.push({ file: fileName, error: message });
          if (!isJson) console.error(`  [ERROR] ${fileName}: ${message}`);
        }
      }

      if (!isDryRun) {
        saveImportHashes(stateFile, importedHashes);
      }

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              success: stats.errors === 0,
              data: {
                ...stats,
                dryRun: isDryRun,
                imported: importedEntries,
                skipped: skippedEntries,
                errors: errorEntries,
              },
              meta: {
                operation: 'memory.import',
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ),
        );
      } else {
        console.log('');
        console.log('=== Import Complete ===');
        console.log(`Total:   ${stats.total}`);
        console.log(`Imported: ${stats.imported}`);
        console.log(`Skipped:  ${stats.skipped}`);
        console.log(`Errors:   ${stats.errors}`);
      }

      if (stats.errors > 0) process.exit(1);
    });
}
