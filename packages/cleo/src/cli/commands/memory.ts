/**
 * CLI memory commands for BRAIN pattern and learning memory.
 *
 * Subcommands:
 *   cleo memory store       — store a pattern or learning
 *   cleo memory find        — cross-table FTS5 search
 *   cleo memory stats       — pattern + learning statistics
 *   cleo memory observe     — save observation to brain.db
 *   cleo memory timeline    — chronological context around anchor
 *   cleo memory fetch       — full details for observation IDs
 *   cleo memory decision-find   — search decisions
 *   cleo memory decision-store  — store a decision
 *   cleo memory link        — link a brain entry to a task
 *   cleo memory trace       — BFS graph traversal
 *   cleo memory related     — 1-hop graph neighbours
 *   cleo memory context     — 360-degree node view
 *   cleo memory graph-stats — graph aggregate counts
 *   cleo memory graph-show  — get graph node + edges
 *   cleo memory graph-neighbors — get neighbour nodes
 *   cleo memory graph-add   — add node or edge
 *   cleo memory graph-remove — remove node or edge
 *   cleo memory reason-why  — causal trace through task deps
 *   cleo memory reason-similar — semantically similar entries
 *   cleo memory search-hybrid — hybrid FTS5/vector/graph search
 *   cleo memory code-links  — code ↔ memory connections
 *   cleo memory code-auto-link — auto-link brain to nexus
 *   cleo memory code-memories-for-code — memories referencing symbol
 *   cleo memory code-for-memory — code nodes for memory entry
 *   cleo memory consolidate — full consolidation pipeline
 *   cleo memory dream       — full dream cycle (STDP)
 *   cleo memory reflect     — LLM Observer + Reflector pipeline
 *   cleo memory dedup-scan  — report/merge duplicate entries
 *   cleo memory import      — migrate MEMORY.md files to brain.db
 *   cleo memory llm-status  — LLM backend resolution status
 *   cleo memory verify      — promote entry to verified=true
 *   cleo memory pending-verify — list unverified high-citation entries
 *   cleo memory tier        — tier management (stats|promote|demote)
 *
 * @task T4770 T614 T629
 * @epic T4763 T627
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  getBrainDb,
  getBrainNativeDb,
  getProjectRoot,
  runConsolidation,
  triggerManualDream,
} from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { CLEO_DIR_NAME, MIGRATE_MEMORY_HASHES_JSON } from '../paths.js';
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

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** cleo memory store — store a pattern or learning to BRAIN memory */
const storeCommand = defineCommand({
  meta: { name: 'store', description: 'Store a pattern or learning to BRAIN memory' },
  args: {
    type: {
      type: 'string',
      description: 'Memory type: pattern or learning',
      required: true,
    },
    content: {
      type: 'string',
      description: 'Content of the memory entry',
      required: true,
    },
    context: {
      type: 'string',
      description: 'Context in which the pattern/learning was observed',
    },
    source: {
      type: 'string',
      description: 'Source of the learning',
    },
    'pattern-type': {
      type: 'string',
      description: 'Pattern type: workflow, blocker, success, failure, optimization',
    },
    impact: {
      type: 'string',
      description: 'Impact level: low, medium, high',
    },
    confidence: {
      type: 'string',
      description: 'Confidence score 0.0-1.0 (for learnings)',
    },
    actionable: {
      type: 'boolean',
      description: 'Mark learning as actionable',
    },
    'linked-task': {
      type: 'string',
      description: 'Task ID to link this memory to',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const memType = args.type;

    if (memType === 'pattern') {
      await dispatchFromCli(
        'mutate',
        'memory',
        'pattern.store',
        {
          type: args['pattern-type'] || 'workflow',
          pattern: args.content,
          context: args.context || 'Unspecified context',
          impact: args.impact as string | undefined,
          examples: args['linked-task'] ? [args['linked-task']] : [],
        },
        { command: 'memory', operation: 'memory.pattern.store' },
      );
    } else if (memType === 'learning') {
      await dispatchFromCli(
        'mutate',
        'memory',
        'learning.store',
        {
          insight: args.content,
          source: args.source || 'manual',
          confidence: args.confidence !== undefined ? parseFloat(args.confidence) : 0.5,
          actionable: !!args.actionable,
          applicableTypes: args['linked-task'] ? [args['linked-task']] : [],
        },
        { command: 'memory', operation: 'memory.learning.store' },
      );
    } else {
      console.error(`Unknown memory type: ${memType}. Use 'pattern' or 'learning'.`);
      process.exit(1);
    }
  },
});

/** cleo memory find — search BRAIN memory (all tables, or filter by --type) */
const findCommand = defineCommand({
  meta: {
    name: 'find',
    description: 'Search BRAIN memory (all tables, or filter by --type pattern|learning)',
  },
  args: {
    query: {
      type: 'positional',
      description: 'Search query',
      required: true,
    },
    type: {
      type: 'string',
      description: 'Filter by memory type: pattern or learning (default: all)',
    },
    'pattern-type': {
      type: 'string',
      description: 'Filter patterns by type: workflow, blocker, success, failure, optimization',
    },
    'min-confidence': {
      type: 'string',
      description: 'Minimum confidence for learnings',
    },
    actionable: {
      type: 'boolean',
      description: 'Only show actionable learnings',
    },
    limit: {
      type: 'string',
      description: 'Maximum results',
    },
    // T418: agent filter for per-agent mental model retrieval
    agent: {
      type: 'string',
      description: 'Filter observations by agent provenance name (Wave 8 mental models)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const query = args.query;
    const memType = args.type as string | undefined;

    if (memType === 'pattern') {
      await dispatchFromCli(
        'query',
        'memory',
        'pattern.find',
        {
          query,
          type: args['pattern-type'] as string | undefined,
          limit: args.limit !== undefined ? parseInt(args.limit, 10) : undefined,
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
          minConfidence:
            args['min-confidence'] !== undefined ? parseFloat(args['min-confidence']) : undefined,
          actionableOnly: !!args.actionable,
          limit: args.limit !== undefined ? parseInt(args.limit, 10) : undefined,
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
          limit: args.limit !== undefined ? parseInt(args.limit, 10) : undefined,
          // T418: forward agent filter when provided
          ...(args.agent !== undefined && { agent: args.agent }),
        },
        { command: 'memory', operation: 'memory.find' },
      );
    }
  },
});

/** cleo memory stats — show BRAIN memory statistics */
const statsCommand = defineCommand({
  meta: { name: 'stats', description: 'Show BRAIN memory statistics' },
  async run() {
    // Output format is controlled by the global --json/--human flags (format-context),
    // not by a per-command --json option (the global flag is resolved pre-dispatch).
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
  },
});

/** cleo memory observe — save an observation to brain.db */
const observeCommand = defineCommand({
  meta: {
    name: 'observe',
    description:
      'Save an observation to brain.db — captures facts, decisions, and discoveries for cross-session memory',
  },
  args: {
    text: {
      type: 'positional',
      description: 'Observation text',
      required: true,
    },
    title: {
      type: 'string',
      description: 'Short title for the observation (defaults to first 120 chars of text)',
    },
    type: {
      type: 'string',
      description:
        'Category: discovery (found something new), decision (choice made), bugfix (bug found/fixed), refactor (code restructured), feature (feature added), change (general change), diary (journal entry), session-summary (end-of-session recap auto-created by cleo session end)',
    },
    agent: {
      type: 'string',
      description:
        'Name of the agent producing this observation (enables per-agent memory retrieval)',
    },
    'source-type': {
      type: 'string',
      description:
        'How this observation was captured: manual (typed by human/agent), auto (lifecycle hook), transcript (extracted from session)',
    },
    attach: {
      type: 'string',
      description:
        'SHA-256 of an attachment to link to this observation (comma-separated for multiple)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'memory',
      'observe',
      {
        text: args.text,
        title: args.title as string | undefined,
        ...(args.agent !== undefined && { agent: args.agent }),
        ...(args.type !== undefined && { type: args.type }),
        sourceType: (args['source-type'] as string | undefined) ?? 'manual',
        // T799: pass attachment refs
        ...(args.attach !== undefined && { attach: args.attach }),
      },
      { command: 'memory', operation: 'memory.observe' },
    );
  },
});

/** cleo memory timeline — show chronological context around an anchor observation ID */
const timelineCommand = defineCommand({
  meta: {
    name: 'timeline',
    description: 'Show chronological context around an anchor observation ID',
  },
  args: {
    // Output format is controlled by the global --json/--human flags (format-context).
    anchor: {
      type: 'positional',
      description: 'Anchor observation ID',
      required: true,
    },
    before: {
      type: 'string',
      description: 'Number of entries before anchor',
    },
    after: {
      type: 'string',
      description: 'Number of entries after anchor',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'timeline',
      {
        anchor: args.anchor,
        depthBefore: args.before !== undefined ? parseInt(args.before, 10) : undefined,
        depthAfter: args.after !== undefined ? parseInt(args.after, 10) : undefined,
      },
      { command: 'memory-timeline', operation: 'memory.timeline' },
    );
  },
});

/** cleo memory fetch — fetch full details for specific observation IDs */
const fetchCommand = defineCommand({
  meta: { name: 'fetch', description: 'Fetch full details for specific observation IDs' },
  args: {
    // Note: citty doesn't support variadic positional args, so we accept a single
    // positional and split on commas/spaces to support: `cleo memory fetch ID1,ID2`
    // Output format is controlled by the global --json/--human flags (format-context).
    ids: {
      type: 'positional',
      description: 'Comma- or space-separated observation IDs',
      required: true,
    },
  },
  async run({ args }) {
    const ids = args.ids
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
  },
});

/** cleo memory decision-find — search decisions stored in brain.db */
const decisionFindCommand = defineCommand({
  meta: { name: 'decision-find', description: 'Search decisions stored in brain.db' },
  args: {
    query: {
      type: 'positional',
      description: 'Search query',
      required: false,
    },
    limit: {
      type: 'string',
      description: 'Maximum results',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'decision.find',
      {
        query: args.query ?? '',
        limit: args.limit !== undefined ? parseInt(args.limit, 10) : undefined,
      },
      { command: 'memory', operation: 'memory.decision.find' },
    );
  },
});

/** cleo memory decision-store — store a decision to brain.db */
const decisionStoreCommand = defineCommand({
  meta: { name: 'decision-store', description: 'Store a decision to brain.db' },
  args: {
    decision: {
      type: 'string',
      description: 'The decision that was made',
      required: true,
    },
    rationale: {
      type: 'string',
      description: 'Rationale behind the decision',
      required: true,
    },
    alternatives: {
      type: 'string',
      description: 'Alternatives that were considered',
    },
    'linked-task': {
      type: 'string',
      description: 'Task ID to associate with this decision',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'memory',
      'decision.store',
      {
        decision: args.decision,
        rationale: args.rationale,
        ...(args.alternatives !== undefined && { alternatives: args.alternatives }),
        ...(args['linked-task'] !== undefined && { taskId: args['linked-task'] }),
      },
      { command: 'memory', operation: 'memory.decision.store' },
    );
  },
});

/** cleo memory link — link a brain entry to a task */
const linkCommand = defineCommand({
  meta: { name: 'link', description: 'Link a brain entry to a task' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID',
      required: true,
    },
    entryId: {
      type: 'positional',
      description: 'Brain entry ID',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'memory',
      'link',
      { taskId: args.taskId, entryId: args.entryId },
      { command: 'memory', operation: 'memory.link' },
    );
  },
});

/** cleo memory trace — BFS traversal of the brain knowledge graph from a seed node */
const traceCommand = defineCommand({
  meta: {
    name: 'trace',
    description: 'BFS traversal of the brain knowledge graph from a seed node',
  },
  args: {
    nodeId: {
      type: 'positional',
      description: 'Seed node ID',
      required: true,
    },
    depth: {
      type: 'string',
      description: 'Maximum traversal depth (default: 3)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'graph.trace',
      {
        nodeId: args.nodeId,
        ...(args.depth !== undefined && { maxDepth: parseInt(args.depth, 10) }),
      },
      { command: 'memory-trace', operation: 'memory.graph.trace' },
    );
  },
});

/** cleo memory related — return immediate (1-hop) neighbours of a brain graph node */
const relatedCommand = defineCommand({
  meta: {
    name: 'related',
    description: 'Return immediate (1-hop) neighbours of a brain graph node',
  },
  args: {
    nodeId: {
      type: 'positional',
      description: 'Node ID',
      required: true,
    },
    type: {
      type: 'string',
      description: 'Filter by edge type (e.g. applies_to, supports, derived_from)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'graph.related',
      {
        nodeId: args.nodeId,
        ...(args.type !== undefined && { edgeType: args.type }),
      },
      { command: 'memory-related', operation: 'memory.graph.related' },
    );
  },
});

/** cleo memory context — 360-degree context view of a brain graph node */
const contextCommand = defineCommand({
  meta: {
    name: 'context',
    description: '360-degree context view of a brain graph node: node + all edges + neighbours',
  },
  args: {
    nodeId: {
      type: 'positional',
      description: 'Node ID',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'graph.context',
      { nodeId: args.nodeId },
      { command: 'memory-context', operation: 'memory.graph.context' },
    );
  },
});

/** cleo memory graph-stats — show brain knowledge graph statistics */
const graphStatsCommand = defineCommand({
  meta: {
    name: 'graph-stats',
    description: 'Show brain knowledge graph statistics: node and edge counts by type',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run() {
    await dispatchFromCli(
      'query',
      'memory',
      'graph.stats',
      {},
      { command: 'memory-graph-stats', operation: 'memory.graph.stats' },
    );
  },
});

/** cleo memory graph-show — get a PageIndex graph node and its edges */
const graphShowCommand = defineCommand({
  meta: { name: 'graph-show', description: 'Get a PageIndex graph node and its edges' },
  args: {
    nodeId: {
      type: 'positional',
      description: 'Node ID',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'graph.show',
      { nodeId: args.nodeId },
      { command: 'memory', operation: 'memory.graph.show' },
    );
  },
});

/** cleo memory graph-neighbors — get neighbor nodes from the PageIndex graph */
const graphNeighborsCommand = defineCommand({
  meta: {
    name: 'graph-neighbors',
    description: 'Get neighbor nodes from the PageIndex graph',
  },
  args: {
    nodeId: {
      type: 'positional',
      description: 'Node ID',
      required: true,
    },
    depth: {
      type: 'string',
      description: 'Traversal depth',
    },
    limit: {
      type: 'string',
      description: 'Maximum neighbors',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'graph.neighbors',
      {
        nodeId: args.nodeId,
        ...(args.depth !== undefined && { depth: parseInt(args.depth, 10) }),
        ...(args.limit !== undefined && { limit: parseInt(args.limit, 10) }),
      },
      { command: 'memory', operation: 'memory.graph.neighbors' },
    );
  },
});

/** cleo memory graph-add — add a node or edge to the PageIndex graph */
const graphAddCommand = defineCommand({
  meta: { name: 'graph-add', description: 'Add a node or edge to the PageIndex graph' },
  args: {
    'node-id': {
      type: 'string',
      description: 'Node ID to add',
    },
    'node-type': {
      type: 'string',
      description: 'Node type (e.g. concept, task, file)',
    },
    label: {
      type: 'string',
      description: 'Label for the node',
    },
    from: {
      type: 'string',
      description: 'Source node ID for an edge',
    },
    to: {
      type: 'string',
      description: 'Target node ID for an edge',
    },
    'edge-type': {
      type: 'string',
      description: 'Edge relationship type',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'memory',
      'graph.add',
      {
        ...(args['node-id'] !== undefined && { nodeId: args['node-id'] }),
        ...(args['node-type'] !== undefined && { nodeType: args['node-type'] }),
        ...(args.label !== undefined && { label: args.label }),
        ...(args.from !== undefined && { fromId: args.from }),
        ...(args.to !== undefined && { toId: args.to }),
        ...(args['edge-type'] !== undefined && { edgeType: args['edge-type'] }),
      },
      { command: 'memory', operation: 'memory.graph.add' },
    );
  },
});

/** cleo memory graph-remove — remove a node or edge from the PageIndex graph */
const graphRemoveCommand = defineCommand({
  meta: { name: 'graph-remove', description: 'Remove a node or edge from the PageIndex graph' },
  args: {
    'node-id': {
      type: 'string',
      description: 'Node ID to remove',
    },
    from: {
      type: 'string',
      description: 'Source node ID of the edge to remove',
    },
    to: {
      type: 'string',
      description: 'Target node ID of the edge to remove',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'memory',
      'graph.remove',
      {
        ...(args['node-id'] !== undefined && { nodeId: args['node-id'] }),
        ...(args.from !== undefined && { fromId: args.from }),
        ...(args.to !== undefined && { toId: args.to }),
      },
      { command: 'memory', operation: 'memory.graph.remove' },
    );
  },
});

/** cleo memory reason-why — causal trace through task dependency chains */
const reasonWhyCommand = defineCommand({
  meta: { name: 'reason-why', description: 'Causal trace through task dependency chains' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID',
      required: true,
    },
    depth: {
      type: 'string',
      description: 'Maximum trace depth',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'reason.why',
      {
        taskId: args.taskId,
        ...(args.depth !== undefined && { depth: parseInt(args.depth, 10) }),
      },
      { command: 'memory', operation: 'memory.reason.why' },
    );
  },
});

/** cleo memory reason-similar — find semantically similar brain entries */
const reasonSimilarCommand = defineCommand({
  meta: { name: 'reason-similar', description: 'Find semantically similar brain entries' },
  args: {
    entryId: {
      type: 'positional',
      description: 'Entry ID',
      required: true,
    },
    limit: {
      type: 'string',
      description: 'Maximum results',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'reason.similar',
      {
        entryId: args.entryId,
        ...(args.limit !== undefined && { limit: parseInt(args.limit, 10) }),
      },
      { command: 'memory', operation: 'memory.reason.similar' },
    );
  },
});

/** cleo memory search-hybrid — hybrid search across FTS5, vector, and graph indexes */
const searchHybridCommand = defineCommand({
  meta: {
    name: 'search-hybrid',
    description: 'Hybrid search across FTS5, vector, and graph indexes',
  },
  args: {
    query: {
      type: 'positional',
      description: 'Search query',
      required: true,
    },
    limit: {
      type: 'string',
      description: 'Maximum results',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'search.hybrid',
      {
        query: args.query,
        ...(args.limit !== undefined && { limit: parseInt(args.limit, 10) }),
      },
      { command: 'memory', operation: 'memory.search.hybrid' },
    );
  },
});

/** cleo memory code-links — show all code ↔ memory connections */
const codeLinksCommand = defineCommand({
  meta: {
    name: 'code-links',
    description: 'Show code ↔ memory connections (code_reference edges between brain and nexus)',
  },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum entries to return (default 100)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'code.links',
      {
        ...(args.limit !== undefined && { limit: parseInt(args.limit, 10) }),
      },
      { command: 'memory', operation: 'memory.code.links' },
    );
  },
});

/** cleo memory code-auto-link — scan brain nodes and auto-link to nexus */
const codeAutoLinkCommand = defineCommand({
  meta: {
    name: 'code-auto-link',
    description: 'Scan brain memory nodes for entity references and auto-link to nexus code nodes',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run() {
    await dispatchFromCli(
      'mutate',
      'memory',
      'code.auto-link',
      {},
      { command: 'memory', operation: 'memory.code.auto-link' },
    );
  },
});

/** cleo memory code-memories-for-code — find memories that reference a code symbol */
const codeMemoriesForCodeCommand = defineCommand({
  meta: {
    name: 'code-memories-for-code',
    description: 'Find brain memory nodes that reference a given nexus code symbol',
  },
  args: {
    symbol: {
      type: 'positional',
      description: 'Code symbol name',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'code.memories-for-code',
      { symbol: args.symbol },
      { command: 'memory', operation: 'memory.code.memories-for-code' },
    );
  },
});

/** cleo memory code-for-memory — find code nodes referenced by a memory entry */
const codeForMemoryCommand = defineCommand({
  meta: {
    name: 'code-for-memory',
    description: 'Find nexus code nodes referenced by a given brain memory entry',
  },
  args: {
    memoryId: {
      type: 'positional',
      description: 'Memory entry ID',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'code.for-memory',
      { memoryId: args.memoryId },
      { command: 'memory', operation: 'memory.code.for-memory' },
    );
  },
});

/** cleo memory consolidate — run the full brain consolidation pipeline on demand */
const consolidateCommand = defineCommand({
  meta: {
    name: 'consolidate',
    description:
      'Run the full brain consolidation pipeline: dedup, quality recompute, tier promotion, ' +
      'contradiction detection, soft eviction, graph strengthening, summary generation. ' +
      'Equivalent to the session-end sleep-time consolidation but triggered on demand.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output results as JSON',
    },
  },
  async run({ args }) {
    const root = getProjectRoot();
    const isJson = !!args.json;

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
  },
});

/** cleo memory dream — manually trigger the full dream cycle including STDP plasticity (T628) */
const dreamCommand = defineCommand({
  meta: {
    name: 'dream',
    description:
      'Manually trigger the full auto-dream cycle: consolidation pipeline including ' +
      'R-STDP reward backfill (Step 9a), STDP plasticity (Step 9b), and homeostatic ' +
      'decay (Step 9c). Equivalent to autonomous nightly consolidation but ' +
      'triggered on demand. Idempotent — safe to run multiple times.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output results as JSON',
    },
  },
  async run({ args }) {
    const root = getProjectRoot();
    const isJson = !!args.json;

    if (!isJson) {
      console.log('Triggering dream cycle (full consolidation including STDP plasticity)...');
    }

    try {
      const result = await triggerManualDream(root);

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              success: true,
              data: result,
              meta: {
                operation: 'memory.dream',
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
      console.log('\nDream cycle complete.');
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
      if (result.rewardBackfilled !== undefined) {
        console.log(
          `  Reward backfill: ${result.rewardBackfilled.rowsLabeled} labeled, ` +
            `${result.rewardBackfilled.rowsSkipped} skipped`,
        );
      }
      if (result.stdpPlasticity !== undefined) {
        console.log(
          `  STDP plasticity: ${result.stdpPlasticity.ltpEvents} LTP, ` +
            `${result.stdpPlasticity.ltdEvents} LTD, ` +
            `${result.stdpPlasticity.edgesCreated} edges created`,
        );
      }
      if (result.homeostaticDecay !== undefined) {
        console.log(
          `  Decay/pruning:   ${result.homeostaticDecay.edgesDecayed} decayed, ` +
            `${result.homeostaticDecay.edgesPruned} pruned`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isJson) {
        console.log(JSON.stringify({ success: false, error: message }));
      } else {
        console.error(`Dream cycle failed: ${message}`);
      }
      process.exit(1);
    }
  },
});

/** cleo memory reflect — manually trigger the LLM Observer + Reflector pipeline (T745) */
const reflectCommand = defineCommand({
  meta: {
    name: 'reflect',
    description:
      'Manually trigger the LLM Observer + Reflector pipeline for the most recent session. ' +
      'Observer compresses session observations; Reflector synthesizes patterns and learnings. ' +
      'Requires ANTHROPIC_API_KEY to be set.',
  },
  args: {
    session: {
      type: 'string',
      description: 'Run against a specific session ID (default: most recent session)',
    },
    json: {
      type: 'boolean',
      description: 'Output results as JSON',
    },
  },
  async run({ args }) {
    const root = getProjectRoot();
    const isJson = !!args.json;

    if (!isJson) {
      console.log('Running Observer + Reflector pipeline...');
    }

    try {
      const { runObserver, runReflector } = await import('@cleocode/core/internal');

      const observerResult = await runObserver(root, args.session as string | undefined, {
        thresholdOverride: 1,
      });
      const reflectorResult = await runReflector(root, args.session as string | undefined);

      const data = {
        observer: {
          ran: observerResult.ran,
          stored: observerResult.stored,
          compressedIds: observerResult.compressedIds,
        },
        reflector: {
          ran: reflectorResult.ran,
          patternsStored: reflectorResult.patternsStored,
          learningsStored: reflectorResult.learningsStored,
          supersededIds: reflectorResult.supersededIds,
        },
      };

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              success: true,
              data,
              meta: {
                operation: 'memory.reflect',
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log('\nReflection complete.');
      if (!observerResult.ran) {
        console.log('  Observer: skipped (no API key, disabled in config, or no observations)');
      } else {
        console.log(`  Observer: compressed ${observerResult.stored} notes`);
        console.log(`    Source IDs: ${observerResult.compressedIds.length} observations`);
      }
      if (!reflectorResult.ran) {
        console.log('  Reflector: skipped (no API key, disabled in config, or < 3 observations)');
      } else {
        console.log(
          `  Reflector: ${reflectorResult.patternsStored} patterns, ${reflectorResult.learningsStored} learnings`,
        );
        if (reflectorResult.supersededIds.length > 0) {
          console.log(`    Superseded: ${reflectorResult.supersededIds.length} observations`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isJson) {
        console.log(JSON.stringify({ success: false, error: message }));
      } else {
        console.error(`Reflect failed: ${message}`);
      }
      process.exit(1);
    }
  },
});

/** cleo memory dedup-scan — scan brain.db for potential duplicate entries (T745) */
const dedupScanCommand = defineCommand({
  meta: {
    name: 'dedup-scan',
    description:
      'Scan brain.db for potential duplicate entries by content-hash and keyword similarity. ' +
      'Reports duplicates per table without modifying any data. ' +
      'Use --apply to merge confirmed duplicates via the consolidation pipeline.',
  },
  args: {
    apply: {
      type: 'boolean',
      description:
        'Run full consolidation to merge duplicates (calls cleo memory consolidate internally)',
    },
    json: {
      type: 'boolean',
      description: 'Output results as JSON',
    },
  },
  async run({ args }) {
    const root = getProjectRoot();
    const isJson = !!args.json;

    if (!isJson) {
      console.log('Scanning brain.db for duplicate entries...');
    }

    try {
      const { getBrainDb: getBrainDbInner, getBrainNativeDb: getBrainNativeDbInner } = await import(
        '@cleocode/core/internal'
      );
      await getBrainDbInner(root);
      const nativeDb = getBrainNativeDbInner();

      if (!nativeDb) {
        const msg = 'brain.db is unavailable';
        if (isJson) {
          console.log(JSON.stringify({ success: false, error: msg }));
        } else {
          console.error(msg);
        }
        process.exit(1);
        return;
      }

      // Scan each table for content-hash duplicates
      const tables = [
        { name: 'brain_observations', hashCol: 'content_hash', labelCol: 'title' },
        { name: 'brain_decisions', hashCol: 'content_hash', labelCol: 'decision' },
        { name: 'brain_patterns', hashCol: 'content_hash', labelCol: 'pattern' },
        { name: 'brain_learnings', hashCol: 'content_hash', labelCol: 'insight' },
      ] as const;

      interface DupGroup {
        table: string;
        hash: string;
        count: number;
        samples: string[];
      }
      const groups: DupGroup[] = [];

      for (const t of tables) {
        let dupRows: Array<{ hash: string; cnt: number }>;
        try {
          dupRows = nativeDb
            .prepare(
              `SELECT ${t.hashCol} AS hash, COUNT(*) AS cnt
               FROM ${t.name}
               WHERE ${t.hashCol} IS NOT NULL
                 AND invalid_at IS NULL
               GROUP BY ${t.hashCol}
               HAVING cnt > 1
               ORDER BY cnt DESC
               LIMIT 20`,
            )
            .all() as Array<{ hash: string; cnt: number }>;
        } catch {
          dupRows = [];
        }

        for (const row of dupRows) {
          let sampleRows: Array<{ id: string; label: string }>;
          try {
            sampleRows = nativeDb
              .prepare(
                `SELECT id, COALESCE(${t.labelCol}, id) AS label
                 FROM ${t.name}
                 WHERE ${t.hashCol} = ?
                   AND invalid_at IS NULL
                 LIMIT 3`,
              )
              .all(row.hash) as Array<{ id: string; label: string }>;
          } catch {
            sampleRows = [];
          }

          groups.push({
            table: t.name,
            hash: row.hash,
            count: row.cnt,
            samples: sampleRows.map((r) => `${r.id}: ${String(r.label).slice(0, 80)}`),
          });
        }
      }

      const totalDups = groups.reduce((sum, g) => sum + (g.count - 1), 0);

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              success: true,
              data: {
                totalDuplicateRows: totalDups,
                groups,
                applied: false,
              },
              meta: {
                operation: 'memory.dedup-scan',
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ),
        );
      } else {
        if (groups.length === 0) {
          console.log('No hash-duplicate entries found.');
        } else {
          console.log(`\nFound ${totalDups} duplicate rows across ${groups.length} groups:`);
          for (const g of groups) {
            console.log(`\n  [${g.table}] hash=${g.hash.slice(0, 12)}... (${g.count} copies)`);
            for (const s of g.samples) {
              console.log(`    - ${s}`);
            }
          }
        }
      }

      // Optionally merge duplicates via the consolidation pipeline
      if (args.apply) {
        if (!isJson) console.log('\nApplying — running consolidation to merge duplicates...');
        const { runConsolidation: runConsolidationInner } = await import('@cleocode/core/internal');
        const result = await runConsolidationInner(root);
        if (isJson) {
          // Reprint with applied=true
          console.log(
            JSON.stringify(
              {
                success: true,
                data: {
                  totalDuplicateRows: totalDups,
                  groups,
                  applied: true,
                  consolidation: { deduplicated: result.deduplicated },
                },
                meta: {
                  operation: 'memory.dedup-scan',
                  timestamp: new Date().toISOString(),
                },
              },
              null,
              2,
            ),
          );
        } else {
          console.log(`Consolidation merged ${result.deduplicated} duplicate entries.`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isJson) {
        console.log(JSON.stringify({ success: false, error: message }));
      } else {
        console.error(`Dedup scan failed: ${message}`);
      }
      process.exit(1);
    }
  },
});

/** cleo memory import — migrate MEMORY.md files to brain.db (T629 provider-agnostic) */
const importCommand = defineCommand({
  meta: {
    name: 'import',
    description:
      'Import memory files from a provider-specific directory (e.g. ~/.claude/projects/*/memory/) into brain.db. ' +
      'Enables provider-agnostic memory via CLEO CLI instead of Claude Code MEMORY.md.',
  },
  args: {
    from: {
      type: 'string',
      description:
        'Source directory containing *.md memory files ' +
        '(default: ~/.claude/projects/-mnt-projects-cleocode/memory)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print what would be imported without writing to brain.db',
    },
    json: {
      type: 'boolean',
      description: 'Output results as JSON',
    },
  },
  async run({ args }) {
    const sourceDir =
      args.from ?? join(homedir(), '.claude', 'projects', '-mnt-projects-cleocode', 'memory');
    const isDryRun = !!args['dry-run'];
    const isJson = !!args.json;
    const projectRoot = getProjectRoot();
    const stateFile = join(projectRoot, CLEO_DIR_NAME, MIGRATE_MEMORY_HASHES_JSON);

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
  },
});

/**
 * cleo memory doctor — read-only brain noise detector (T1262 E1-parallel).
 *
 * Scans `.cleo/brain.db` for known noise patterns without modifying any data.
 * Pass `--assert-clean` to exit non-zero when noise is detected (M7 gate).
 */
const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description:
      'Read-only brain noise scan: detects duplicate-content, missing-type, missing-provenance, ' +
      'orphan-edge, low-confidence, and stale-unverified patterns. ' +
      'Use --assert-clean as the M7 entry gate before enabling Sentient v1 (`cleo sentient propose enable`).',
  },
  args: {
    'assert-clean': {
      type: 'boolean',
      description: 'Exit non-zero when any noise patterns are detected (M7 gate for Sentient v1)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }: { args: { 'assert-clean'?: boolean; json?: boolean } }) {
    await dispatchFromCli(
      'query',
      'memory',
      'doctor',
      { 'assert-clean': args['assert-clean'] },
      { command: 'memory-doctor', operation: 'memory.doctor' },
    );
  },
});

/**
 * cleo memory llm-status — report LLM backend resolution status (T791).
 *
 * Shows which source resolved the Anthropic API key and extraction readiness.
 */
const llmStatusCommand = defineCommand({
  meta: {
    name: 'llm-status',
    description:
      'Report LLM backend resolution status and extraction readiness. ' +
      'Shows which source resolved the Anthropic API key (env/config/oauth/none), ' +
      'whether LLM extraction is enabled, and when extraction last ran.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run() {
    await dispatchFromCli(
      'query',
      'memory',
      'llm-status',
      {},
      { command: 'memory-llm-status', operation: 'memory.llm-status' },
    );
  },
});

/** cleo memory verify — promote a brain memory entry to verified=true (T792) */
const verifyCommand = defineCommand({
  meta: {
    name: 'verify',
    description:
      'Promote a brain memory entry to verified=true. ' +
      'Requires caller identity of cleo-prime or owner. ' +
      'Flips the verified flag in brain_observations (or typed table), ' +
      'enabling long-tier promotion and ground-truth retrieval weighting.',
  },
  args: {
    id: {
      type: 'positional',
      description: 'Brain entry ID to verify',
      required: true,
    },
    agent: {
      type: 'string',
      description:
        "Caller identity ('cleo-prime' or 'owner'). " +
        'Omit when calling from the owner terminal (no identity required).',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'memory',
      'verify',
      {
        id: args.id,
        ...(args.agent !== undefined && { agent: args.agent }),
      },
      { command: 'memory-verify', operation: 'memory.verify' },
    );
  },
});

/** cleo memory pending-verify — list unverified but highly cited entries (T792) */
const pendingVerifyCommand = defineCommand({
  meta: {
    name: 'pending-verify',
    description:
      'List brain memory entries that are unverified (verified=false) but highly cited ' +
      '(citation_count >= threshold). These are strong candidates for manual verification ' +
      "via 'cleo memory verify <id>'.",
  },
  args: {
    'min-citations': {
      type: 'string',
      description: 'Minimum citation count threshold (default: 5)',
    },
    limit: {
      type: 'string',
      description: 'Maximum entries to return (default: 50)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'memory',
      'pending-verify',
      {
        ...(args['min-citations'] !== undefined && {
          minCitations: parseInt(args['min-citations'], 10),
        }),
        ...(args.limit !== undefined && { limit: parseInt(args.limit, 10) }),
      },
      { command: 'memory-pending-verify', operation: 'memory.pending-verify' },
    );
  },
});

// ---------------------------------------------------------------------------
// T744 — cleo memory tier <stats|promote|demote>
// Provides tier observability and manual override for the 3-tier memory model.
// ---------------------------------------------------------------------------

/** cleo memory tier stats — tier distribution + countdown to next long-tier promotions */
const tierStatsCommand = defineCommand({
  meta: {
    name: 'stats',
    description:
      'Show tier distribution across all brain tables + countdown to next long-tier promotions (top-10)',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const root = getProjectRoot();
    const isJson = !!args.json;

    try {
      await getBrainDb(root);
      const nativeDb = getBrainNativeDb();
      if (!nativeDb) {
        const msg = 'brain.db not available';
        if (isJson) {
          console.log(JSON.stringify({ success: false, error: msg }));
        } else {
          console.error(msg);
        }
        process.exit(1);
      }

      // Per-table tier distributions
      const tables = ['brain_observations', 'brain_learnings', 'brain_patterns', 'brain_decisions'];
      const distribution: Record<string, Record<string, number>> = {};
      for (const tbl of tables) {
        try {
          const rows = nativeDb
            .prepare(
              `SELECT COALESCE(memory_tier, 'short') as tier, COUNT(*) as cnt
               FROM ${tbl}
               WHERE invalid_at IS NULL
               GROUP BY memory_tier`,
            )
            .all() as Array<{ tier: string; cnt: number }>;
          distribution[tbl] = { short: 0, medium: 0, long: 0 };
          for (const r of rows) {
            distribution[tbl]![r.tier] = r.cnt;
          }
        } catch {
          distribution[tbl] = { short: 0, medium: 0, long: 0 };
        }
      }

      // Countdown: top-10 medium entries closest to 7-day long-tier gate
      // (citation_count >= 5 OR verified=1) AND created_at > (now - 7d) — approaching gate
      const age7dMs = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      interface CountdownRow {
        id: string;
        tbl: string;
        created_at: string;
        citation_count: number;
        verified: number;
        quality_score: number | null;
      }
      const countdown: Array<{
        id: string;
        table: string;
        daysUntil: number;
        track: string;
      }> = [];

      for (const tbl of tables) {
        const dateCol = tbl === 'brain_patterns' ? 'extracted_at' : 'created_at';
        try {
          const rawRows = nativeDb
            .prepare(
              `SELECT id, ${dateCol} as created_at, citation_count, verified, quality_score
               FROM ${tbl}
               WHERE memory_tier = 'medium'
                 AND invalid_at IS NULL
                 AND (citation_count >= 5 OR verified = 1)
               ORDER BY ${dateCol} ASC
               LIMIT 20`,
            )
            .all();
          const rows: CountdownRow[] = rawRows.map((raw) => {
            const r = raw as Record<string, unknown>;
            return {
              id: String(r['id'] ?? ''),
              tbl,
              created_at: String(r['created_at'] ?? ''),
              citation_count: Number(r['citation_count'] ?? 0),
              verified: Number(r['verified'] ?? 0),
              quality_score: r['quality_score'] == null ? null : Number(r['quality_score']),
            };
          });

          for (const r of rows) {
            const entryMs = new Date(r.created_at.replace(' ', 'T')).getTime();
            const promotionMs = entryMs + age7dMs;
            const daysUntil = Math.max(0, (promotionMs - now) / (24 * 60 * 60 * 1000));
            const track = r.citation_count >= 5 ? `citation (${r.citation_count})` : 'verified';
            countdown.push({ id: r.id, table: tbl, daysUntil, track });
          }
        } catch {
          // Table may not have memory_tier column
        }
      }
      countdown.sort((a, b) => a.daysUntil - b.daysUntil);
      const top10 = countdown.slice(0, 10);

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              success: true,
              data: { distribution, upcomingLongPromotions: top10 },
              meta: {
                operation: 'memory.tier.stats',
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
      console.log('\nMemory Tier Distribution');
      console.log('========================');
      for (const [tbl, counts] of Object.entries(distribution)) {
        const shortName = tbl.replace('brain_', '');
        console.log(
          `  ${shortName.padEnd(14)} short=${counts['short']}  medium=${counts['medium']}  long=${counts['long']}`,
        );
      }

      if (top10.length > 0) {
        console.log('\nTop-10 Upcoming Long-Tier Promotions (medium → long):');
        console.log('-----------------------------------------------------');
        for (const entry of top10) {
          const days = entry.daysUntil.toFixed(1);
          const table = entry.table.replace('brain_', '');
          console.log(`  [${table}] ${entry.id}  in ${days}d  via ${entry.track}`);
        }
      } else {
        console.log('\nNo entries currently qualifying for long-tier promotion.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isJson) {
        console.log(JSON.stringify({ success: false, error: message }));
      } else {
        console.error(`Tier stats failed: ${message}`);
      }
      process.exit(1);
    }
  },
});

/** cleo memory tier promote — manually promote a memory entry to a higher tier */
const tierPromoteCommand = defineCommand({
  meta: {
    name: 'promote',
    description: 'Manually promote a memory entry to a higher tier (bypasses age gate)',
  },
  args: {
    id: {
      type: 'positional',
      description: 'Brain entry ID',
      required: true,
    },
    to: {
      type: 'string',
      description: 'Target tier: medium or long',
      required: true,
    },
    reason: {
      type: 'string',
      description: 'Reason for manual promotion (required)',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const root = getProjectRoot();
    const isJson = !!args.json;
    const targetTier = args.to;
    const reason = args.reason;

    const validTiers = ['medium', 'long'];
    if (!validTiers.includes(targetTier)) {
      const msg = `Invalid target tier: ${targetTier}. Must be one of: ${validTiers.join(', ')}`;
      if (isJson) {
        console.log(JSON.stringify({ success: false, error: msg }));
      } else {
        console.error(msg);
      }
      process.exit(1);
    }

    try {
      await getBrainDb(root);
      const nativeDb = getBrainNativeDb();
      if (!nativeDb) {
        const msg = 'brain.db not available';
        if (isJson) {
          console.log(JSON.stringify({ success: false, error: msg }));
        } else {
          console.error(msg);
        }
        process.exit(1);
      }

      const tables = ['brain_observations', 'brain_learnings', 'brain_patterns', 'brain_decisions'];
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      let found = false;
      let fromTier = '';
      let foundTable = '';

      for (const tbl of tables) {
        try {
          const row = nativeDb
            .prepare(
              `SELECT id, memory_tier FROM ${tbl} WHERE id = ? AND invalid_at IS NULL LIMIT 1`,
            )
            .get(args.id) as { id: string; memory_tier: string } | undefined;

          if (row) {
            found = true;
            fromTier = row.memory_tier ?? 'short';
            foundTable = tbl;

            if (fromTier === targetTier) {
              const msg = `Entry ${args.id} is already at tier '${targetTier}'`;
              if (isJson) {
                console.log(JSON.stringify({ success: false, error: msg }));
              } else {
                console.error(msg);
              }
              process.exit(1);
            }

            const tierOrder: Record<string, number> = { short: 0, medium: 1, long: 2 };
            const fromOrd = tierOrder[fromTier] ?? 0;
            const toOrd = tierOrder[targetTier] ?? 0;
            if (toOrd <= fromOrd) {
              const msg = `Cannot promote: '${targetTier}' is not higher than current tier '${fromTier}'. Use 'demote' to lower tiers.`;
              if (isJson) {
                console.log(JSON.stringify({ success: false, error: msg }));
              } else {
                console.error(msg);
              }
              process.exit(1);
            }

            nativeDb
              .prepare(`UPDATE ${tbl} SET memory_tier = ?, updated_at = ? WHERE id = ?`)
              .run(targetTier, now, args.id);

            break;
          }
        } catch {
          // Try next table
        }
      }

      if (!found) {
        const msg = `Entry '${args.id}' not found in any brain table (or is invalidated)`;
        if (isJson) {
          console.log(JSON.stringify({ success: false, error: msg }));
        } else {
          console.error(msg);
        }
        process.exit(1);
      }

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              success: true,
              data: {
                id: args.id,
                table: foundTable,
                fromTier,
                toTier: targetTier,
                reason,
                promotedAt: now,
              },
              meta: {
                operation: 'memory.tier.promote',
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ),
        );
      } else {
        const shortTable = foundTable.replace('brain_', '');
        console.log(
          `Promoted [${shortTable}] ${args.id}: ${fromTier} → ${targetTier} (reason: ${reason})`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isJson) {
        console.log(JSON.stringify({ success: false, error: message }));
      } else {
        console.error(`Tier promote failed: ${message}`);
      }
      process.exit(1);
    }
  },
});

/** cleo memory tier demote — manually demote a memory entry to a lower tier */
const tierDemoteCommand = defineCommand({
  meta: {
    name: 'demote',
    description: 'Manually demote a memory entry to a lower tier',
  },
  args: {
    id: {
      type: 'positional',
      description: 'Brain entry ID',
      required: true,
    },
    to: {
      type: 'string',
      description: 'Target tier: short or medium',
      required: true,
    },
    reason: {
      type: 'string',
      description: 'Reason for manual demotion (required)',
      required: true,
    },
    force: {
      type: 'boolean',
      description: 'Required when demoting from long tier',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const root = getProjectRoot();
    const isJson = !!args.json;
    const targetTier = args.to;
    const reason = args.reason;

    const validTiers = ['short', 'medium'];
    if (!validTiers.includes(targetTier)) {
      const msg = `Invalid target tier for demotion: ${targetTier}. Must be one of: ${validTiers.join(', ')}`;
      if (isJson) {
        console.log(JSON.stringify({ success: false, error: msg }));
      } else {
        console.error(msg);
      }
      process.exit(1);
    }

    try {
      await getBrainDb(root);
      const nativeDb = getBrainNativeDb();
      if (!nativeDb) {
        const msg = 'brain.db not available';
        if (isJson) {
          console.log(JSON.stringify({ success: false, error: msg }));
        } else {
          console.error(msg);
        }
        process.exit(1);
      }

      const tables = ['brain_observations', 'brain_learnings', 'brain_patterns', 'brain_decisions'];
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      let found = false;
      let fromTier = '';
      let foundTable = '';

      for (const tbl of tables) {
        try {
          const row = nativeDb
            .prepare(
              `SELECT id, memory_tier FROM ${tbl} WHERE id = ? AND invalid_at IS NULL LIMIT 1`,
            )
            .get(args.id) as { id: string; memory_tier: string } | undefined;

          if (row) {
            found = true;
            fromTier = row.memory_tier ?? 'short';
            foundTable = tbl;

            if (fromTier === 'long' && !args.force) {
              const msg = `Entry ${args.id} is in long tier. Long-tier entries are permanent. Use --force to override.`;
              if (isJson) {
                console.log(JSON.stringify({ success: false, error: msg }));
              } else {
                console.error(msg);
              }
              process.exit(1);
            }

            if (fromTier === targetTier) {
              const msg = `Entry ${args.id} is already at tier '${targetTier}'`;
              if (isJson) {
                console.log(JSON.stringify({ success: false, error: msg }));
              } else {
                console.error(msg);
              }
              process.exit(1);
            }

            const tierOrder: Record<string, number> = { short: 0, medium: 1, long: 2 };
            const fromOrd = tierOrder[fromTier] ?? 0;
            const toOrd = tierOrder[targetTier] ?? 0;
            if (toOrd >= fromOrd) {
              const msg = `Cannot demote: '${targetTier}' is not lower than current tier '${fromTier}'. Use 'promote' to raise tiers.`;
              if (isJson) {
                console.log(JSON.stringify({ success: false, error: msg }));
              } else {
                console.error(msg);
              }
              process.exit(1);
            }

            nativeDb
              .prepare(`UPDATE ${tbl} SET memory_tier = ?, updated_at = ? WHERE id = ?`)
              .run(targetTier, now, args.id);

            break;
          }
        } catch {
          // Try next table
        }
      }

      if (!found) {
        const msg = `Entry '${args.id}' not found in any brain table (or is invalidated)`;
        if (isJson) {
          console.log(JSON.stringify({ success: false, error: msg }));
        } else {
          console.error(msg);
        }
        process.exit(1);
      }

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              success: true,
              data: {
                id: args.id,
                table: foundTable,
                fromTier,
                toTier: targetTier,
                reason,
                demotedAt: now,
              },
              meta: {
                operation: 'memory.tier.demote',
                timestamp: new Date().toISOString(),
              },
            },
            null,
            2,
          ),
        );
      } else {
        const shortTable = foundTable.replace('brain_', '');
        console.log(
          `Demoted [${shortTable}] ${args.id}: ${fromTier} → ${targetTier} (reason: ${reason})`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isJson) {
        console.log(JSON.stringify({ success: false, error: message }));
      } else {
        console.error(`Tier demote failed: ${message}`);
      }
      process.exit(1);
    }
  },
});

// ---------------------------------------------------------------------------
// T1013 — new memory subcommands (T1003 backfill, T1004 precompact-flush,
// T1006 digest / recent / diary / watch)
// ---------------------------------------------------------------------------

/**
 * Factory helper that wraps a `dispatchFromCli` call in a minimal citty
 * subcommand shell. Extracted to eliminate copy-paste across the new
 * memory subcommands (T1003/T1004/T1006) per AGENTS.md DRY rules.
 *
 * The returned `CommandDef` always accepts a shared `--json` flag; all
 * other args must be supplied by the caller. The `paramBuilder` maps the
 * parsed citty args into the dispatch payload.
 *
 * @param opts - Subcommand metadata + dispatch wiring.
 * @returns A citty `CommandDef` ready to drop into `subCommands: { ... }`.
 *
 * @internal
 */
function makeMemorySubcommand(opts: {
  /** Subcommand name (e.g. 'digest', 'precompact-flush'). */
  name: string;
  /** One-line description surfaced in `--help`. */
  description: string;
  /** citty-shaped args record (positional + flags). A `json` bool flag is merged automatically. */
  args: Record<string, import('citty').ArgDef>;
  /** 'query' (read-only) or 'mutate' (side-effecting) gateway. */
  gateway: 'query' | 'mutate';
  /** Dispatch operation under the `memory` domain (e.g. 'digest', 'backfill.run'). */
  operation: string;
  /** Output render options — command + fully-qualified operation label. */
  output: { command: string; operation: string };
  /** Build the dispatch params from the parsed citty args. */
  paramBuilder: (args: Record<string, unknown>) => Record<string, unknown>;
}): import('citty').CommandDef {
  // Merge in a shared --json flag so every subcommand supports JSON output
  // without duplicating the boilerplate arg at every definition site.
  const mergedArgs: Record<string, import('citty').ArgDef> = {
    ...opts.args,
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  };

  return defineCommand({
    meta: { name: opts.name, description: opts.description },
    args: mergedArgs,
    async run({ args }) {
      const params = opts.paramBuilder(args as Record<string, unknown>);
      await dispatchFromCli(opts.gateway, 'memory', opts.operation, params, opts.output);
    },
  });
}

/**
 * cleo memory precompact-flush — T1004.
 *
 * Thin wrapper around `precompactFlush()` that unblocks the bash-shim
 * `precompact-safestop.sh` hook path. This is the CRITICAL runtime bug
 * fix called out in T1013: without this command, the shim's
 * `cleo memory precompact-flush` invocation resolves to E_NO_HANDLER.
 */
const precompactFlushCommand = makeMemorySubcommand({
  name: 'precompact-flush',
  description:
    'Flush in-flight observations to brain.db and checkpoint the SQLite WAL before context compaction (T1004).',
  args: {},
  gateway: 'mutate',
  operation: 'precompact-flush',
  output: { command: 'memory-precompact-flush', operation: 'memory.precompact-flush' },
  paramBuilder: () => ({}),
});

/**
 * cleo memory backfill run — T1003.
 *
 * Stage a new brain-graph backfill run. Rows are written to a staging
 * manifest pending approval via `cleo memory backfill approve <runId>`.
 */
const backfillRunCommand = makeMemorySubcommand({
  name: 'run',
  description:
    'Stage a brain-graph backfill run (pending approval). Pass --source to tag the run with a human-readable descriptor.',
  args: {
    source: {
      type: 'string',
      description:
        'Human-readable descriptor for the backfill source (file path, session ID, etc).',
    },
    kind: {
      type: 'string',
      description: "Backfill kind (default: 'graph-backfill').",
    },
    'target-table': {
      type: 'string',
      description: "Target table (default: 'brain_page_nodes').",
    },
  },
  gateway: 'mutate',
  operation: 'backfill.run',
  output: { command: 'memory-backfill-run', operation: 'memory.backfill.run' },
  paramBuilder: (args) => ({
    ...(args['source'] !== undefined && { source: args['source'] as string }),
    ...(args['kind'] !== undefined && { kind: args['kind'] as string }),
    ...(args['target-table'] !== undefined && { targetTable: args['target-table'] as string }),
  }),
});

/**
 * cleo memory backfill approve <runId> — T1003.
 *
 * Promote a staged backfill run to committed state. Idempotent: a run that
 * has already been approved returns `alreadySettled: true` without error.
 */
const backfillApproveCommand = makeMemorySubcommand({
  name: 'approve',
  description:
    'Approve a staged backfill run (commits rows to brain_page_nodes). Idempotent — re-approval returns alreadySettled=true.',
  args: {
    runId: {
      type: 'positional',
      description: 'Backfill run ID to approve',
      required: true,
    },
    'approved-by': {
      type: 'string',
      description: "Identity of the approver (default: 'cli').",
    },
  },
  gateway: 'mutate',
  operation: 'backfill.approve',
  output: { command: 'memory-backfill-approve', operation: 'memory.backfill.approve' },
  paramBuilder: (args) => ({
    runId: args['runId'] as string,
    ...(args['approved-by'] !== undefined && { approvedBy: args['approved-by'] as string }),
  }),
});

/**
 * cleo memory backfill rollback <runId> — T1003.
 *
 * Roll back a previously-staged or committed backfill run. Staged rows are
 * dropped in-place; committed rows are deleted from the live graph tables.
 */
const backfillRollbackCommand = makeMemorySubcommand({
  name: 'rollback',
  description:
    'Rollback a staged or committed backfill run. Removes any rows written to brain_page_nodes.',
  args: {
    runId: {
      type: 'positional',
      description: 'Backfill run ID to rollback',
      required: true,
    },
  },
  gateway: 'mutate',
  operation: 'backfill.rollback',
  output: { command: 'memory-backfill-rollback', operation: 'memory.backfill.rollback' },
  paramBuilder: (args) => ({
    runId: args['runId'] as string,
  }),
});

/**
 * cleo memory backfill — group command hosting run / approve / rollback (T1003).
 */
const backfillCommand = defineCommand({
  meta: {
    name: 'backfill',
    description: 'Staged brain-graph backfill operations: run, approve, rollback (T1003).',
  },
  subCommands: {
    run: backfillRunCommand,
    approve: backfillApproveCommand,
    rollback: backfillRollbackCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});

/**
 * cleo memory digest — T1006.
 *
 * Summarized top-N observations as a session-briefing digest. Wraps the
 * `memory.digest` dispatch operation which sorts by citation_count +
 * quality_score DESC.
 */
const digestCommand = makeMemorySubcommand({
  name: 'digest',
  description:
    'Summarized top-N brain observations for session briefing (T1006). Sorted by citation_count + quality_score.',
  args: {
    limit: {
      type: 'string',
      description: 'Maximum number of observations to include (default: 10).',
    },
  },
  gateway: 'query',
  operation: 'digest',
  output: { command: 'memory-digest', operation: 'memory.digest' },
  paramBuilder: (args) => ({
    ...(args['limit'] !== undefined && { limit: parseInt(args['limit'] as string, 10) }),
  }),
});

/**
 * cleo memory recent — T1006.
 *
 * Tail recent observations with optional type / session / tier filters.
 * Supports a compact `since` syntax (`24h`, `7d`, `30m`, or ISO timestamp).
 */
const recentCommand = makeMemorySubcommand({
  name: 'recent',
  description:
    'Tail recent brain observations with optional filters (T1006). --since accepts 30m / 24h / 7d or an ISO timestamp.',
  args: {
    limit: {
      type: 'string',
      description: 'Maximum number of observations to return (default: 20).',
    },
    type: {
      type: 'string',
      description:
        'Filter by observation type (discovery, decision, bugfix, refactor, feature, change, diary, session-summary).',
    },
    since: {
      type: 'string',
      description: 'Duration (e.g. 24h, 7d, 30m) or ISO timestamp lower bound.',
    },
    session: {
      type: 'string',
      description: 'Filter by source session ID.',
    },
    tier: {
      type: 'string',
      description: "Filter by memory tier ('short', 'medium', 'long').",
    },
  },
  gateway: 'query',
  operation: 'recent',
  output: { command: 'memory-recent', operation: 'memory.recent' },
  paramBuilder: (args) => ({
    ...(args['limit'] !== undefined && { limit: parseInt(args['limit'] as string, 10) }),
    ...(args['type'] !== undefined && { type: args['type'] as string }),
    ...(args['since'] !== undefined && { since: args['since'] as string }),
    ...(args['session'] !== undefined && { session: args['session'] as string }),
    ...(args['tier'] !== undefined && { tier: args['tier'] as string }),
  }),
});

/**
 * cleo memory diary read — T1006.
 *
 * Read recent diary-typed observations. Requires the `diary` enum value
 * shipped by T1005 (already in main).
 */
const diaryReadCommand = makeMemorySubcommand({
  name: 'read',
  description: 'Read recent diary-typed observations (T1006).',
  args: {
    limit: {
      type: 'string',
      description: 'Maximum number of diary entries to return (default: 20).',
    },
  },
  gateway: 'query',
  operation: 'diary',
  output: { command: 'memory-diary-read', operation: 'memory.diary' },
  paramBuilder: (args) => ({
    ...(args['limit'] !== undefined && { limit: parseInt(args['limit'] as string, 10) }),
  }),
});

/**
 * cleo memory diary write <text> — T1006.
 *
 * Write a diary-typed observation (thin wrapper around `memory.diary.write`
 * which delegates to `memoryObserve` with `type: 'diary'`).
 */
const diaryWriteCommand = makeMemorySubcommand({
  name: 'write',
  description: 'Write a diary-typed observation to brain.db (T1006).',
  args: {
    text: {
      type: 'positional',
      description: 'Diary entry text',
      required: true,
    },
    title: {
      type: 'string',
      description: 'Optional diary entry title (defaults to first 120 chars of text).',
    },
    agent: {
      type: 'string',
      description: 'Optional agent provenance (e.g. cleo-prime, historian).',
    },
  },
  gateway: 'mutate',
  operation: 'diary.write',
  output: { command: 'memory-diary-write', operation: 'memory.diary.write' },
  paramBuilder: (args) => ({
    text: args['text'] as string,
    ...(args['title'] !== undefined && { title: args['title'] as string }),
    ...(args['agent'] !== undefined && { agent: args['agent'] as string }),
  }),
});

/**
 * cleo memory diary — group command hosting read / write subcommands (T1006).
 */
const diaryCommand = defineCommand({
  meta: {
    name: 'diary',
    description: 'Read or write diary-typed brain observations (T1006).',
  },
  subCommands: {
    read: diaryReadCommand,
    write: diaryWriteCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});

/**
 * cleo memory watch — T1006.
 *
 * Long-poll stream of recent brain writes. Without `--follow` the command
 * returns a single batch and exits. With `--follow`, it polls the
 * dispatch `memory.watch` operation using the returned cursor until
 * stdout closes or SIGINT. Each event is emitted as an SSE-style
 * `data: <json>\n\n` line so that downstream consumers can pipe into
 * EventSource-compatible clients.
 */
const watchCommand = defineCommand({
  meta: {
    name: 'watch',
    description:
      'Long-poll stream of recent brain writes. Use --follow to stream continuously as SSE-style events.',
  },
  args: {
    cursor: {
      type: 'string',
      description: 'Resume cursor (created_at lower bound) from a previous watch call.',
    },
    limit: {
      type: 'string',
      description: 'Maximum events per poll (default: 10).',
    },
    follow: {
      type: 'boolean',
      description: 'Stream continuously; polls every --interval ms until interrupted.',
    },
    interval: {
      type: 'string',
      description: 'Poll interval in milliseconds when --follow is set (default: 1000).',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON (non-follow mode only).',
    },
  },
  async run({ args }) {
    const buildParams = (cursor: string | undefined): Record<string, unknown> => ({
      ...(cursor !== undefined && { cursor }),
      ...(args.limit !== undefined && { limit: parseInt(args.limit as string, 10) }),
    });

    // Non-follow mode: single dispatch → normal LAFS output.
    if (!args.follow) {
      await dispatchFromCli(
        'query',
        'memory',
        'watch',
        buildParams(args.cursor as string | undefined),
        { command: 'memory-watch', operation: 'memory.watch' },
      );
      return;
    }

    // Follow mode: SSE-style stdout stream. Emit a `ping` event, then poll
    // `memory.watch` every interval, emitting each event as
    // `event: observation\ndata: <json>\n\n`. Graceful shutdown on SIGINT.
    const intervalMs = args.interval !== undefined ? parseInt(args.interval as string, 10) : 1000;
    let cursor = args.cursor as string | undefined;
    let running = true;

    const onSignal = (): void => {
      running = false;
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    // Initial ping so downstream EventSource-like clients see the stream open.
    process.stdout.write(
      `event: ping\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`,
    );

    while (running) {
      const response = await dispatchRaw('query', 'memory', 'watch', buildParams(cursor));
      if (!response.success) {
        handleRawError(response, { command: 'memory-watch', operation: 'memory.watch' });
        return; // handleRawError calls process.exit on failure
      }

      const data = response.data as {
        events?: Array<{ created_at?: string } & Record<string, unknown>>;
        nextCursor?: string | null;
      };

      const events = data.events ?? [];
      for (const event of events) {
        process.stdout.write(`event: observation\ndata: ${JSON.stringify(event)}\n\n`);
      }

      if (typeof data.nextCursor === 'string') {
        cursor = data.nextCursor;
      }

      if (!running) break;

      // Fixed-interval sleep between polls. Resolves early on SIGINT because
      // `running` is re-checked on the next loop pass.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        // Allow the process to exit cleanly even if the timer is outstanding.
        timer.unref?.();
      });
    }

    // Graceful stream close marker.
    process.stdout.write(
      `event: close\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`,
    );
  },
});

/** cleo memory tier — memory tier management (stats, promote, demote) (T744) */
const tierCommand = defineCommand({
  meta: { name: 'tier', description: 'Memory tier management: stats, promote, demote' },
  subCommands: {
    stats: tierStatsCommand,
    promote: tierPromoteCommand,
    demote: tierDemoteCommand,
  },
});

/**
 * cleo memory sweep — T1147 W7 BRAIN noise sweep (shadow-write envelope).
 *
 * `--dry-run`           Detect noise candidates without staging DB writes.
 * `--approve <runId>`   Apply a staged sweep to live tables (with killSwitch gate).
 * `--status`            List recent noise-sweep-2440 runs.
 * `--rollback <runId>`  Discard a staged run without applying changes.
 */
const sweepCommand = defineCommand({
  meta: {
    name: 'sweep',
    description:
      'T1147 W7 BRAIN noise sweep. --dry-run: detect noise candidates. ' +
      '--approve <runId>: apply to live tables. --status: list runs. ' +
      '--rollback <runId>: discard staged run.',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Detect noise candidates without staging DB writes.',
    },
    approve: {
      type: 'string',
      description: 'Run ID to approve and apply to live tables.',
    },
    status: {
      type: 'boolean',
      description: 'List recent noise-sweep-2440 runs.',
    },
    rollback: {
      type: 'string',
      description: 'Run ID to roll back without applying changes.',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({
    args,
  }: {
    args: {
      'dry-run'?: boolean;
      approve?: string;
      status?: boolean;
      rollback?: string;
      json?: boolean;
    };
  }) {
    const gateway = args.approve || args.rollback ? 'mutate' : 'query';
    await dispatchFromCli(
      gateway,
      'memory',
      'sweep',
      {
        'dry-run': args['dry-run'],
        approve: args.approve,
        status: args.status,
        rollback: args.rollback,
      },
      { command: 'memory-sweep', operation: 'memory.sweep' },
    );
  },
});

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

/**
 * Root memory command group — registers all BRAIN memory subcommands.
 *
 * Dispatches to `memory.*` registry operations.
 */
export const memoryCommand = defineCommand({
  meta: { name: 'memory', description: 'BRAIN memory operations (patterns, learnings)' },
  subCommands: {
    store: storeCommand,
    find: findCommand,
    stats: statsCommand,
    observe: observeCommand,
    timeline: timelineCommand,
    fetch: fetchCommand,
    'decision-find': decisionFindCommand,
    'decision-store': decisionStoreCommand,
    link: linkCommand,
    trace: traceCommand,
    related: relatedCommand,
    context: contextCommand,
    'graph-stats': graphStatsCommand,
    'graph-show': graphShowCommand,
    'graph-neighbors': graphNeighborsCommand,
    'graph-add': graphAddCommand,
    'graph-remove': graphRemoveCommand,
    'reason-why': reasonWhyCommand,
    'reason-similar': reasonSimilarCommand,
    'search-hybrid': searchHybridCommand,
    'code-links': codeLinksCommand,
    'code-auto-link': codeAutoLinkCommand,
    'code-memories-for-code': codeMemoriesForCodeCommand,
    'code-for-memory': codeForMemoryCommand,
    consolidate: consolidateCommand,
    dream: dreamCommand,
    reflect: reflectCommand,
    'dedup-scan': dedupScanCommand,
    import: importCommand,
    doctor: doctorCommand,
    'llm-status': llmStatusCommand,
    verify: verifyCommand,
    'pending-verify': pendingVerifyCommand,
    tier: tierCommand,
    // T1013 — new memory subcommands
    'precompact-flush': precompactFlushCommand,
    backfill: backfillCommand,
    digest: digestCommand,
    recent: recentCommand,
    diary: diaryCommand,
    watch: watchCommand,
    // T1147 W7 — BRAIN noise sweep
    sweep: sweepCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
