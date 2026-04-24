/**
 * Unified CQRS Dispatch Layer -- Operation Registry
 *
 * Single source of truth for all operations mapped to 10 canonical domains.
 * Canonical domains only -- no legacy alias support.
 *
 * @epic T4820
 * @task T4814, T5241, T5615
 */

import type { CanonicalDomain, Gateway, ParamDef, Tier } from './types.js';

/** Definition of a single dispatchable operation. */
export interface OperationDef {
  /** The CQRS gateway ('query' or 'mutate'). */
  gateway: Gateway;
  /** The canonical domain this operation belongs to. */
  domain: CanonicalDomain;
  /** The specific operation name (e.g. 'show', 'skill.list'). */
  operation: string;
  /** Brief description of what the operation does. */
  description: string;
  /** Agent progressive-disclosure tier (0=basic, 1=memory/check, 2=full). */
  tier: Tier;
  /** Whether the operation is safe to retry. */
  idempotent: boolean;
  /** Whether this operation requires an active session. */
  sessionRequired: boolean;
  /** List of parameter keys that MUST be present in the request. */
  requiredParams: string[];
  /**
   * Fully-described parameter list. Replaces `requiredParams` when populated.
   * Empty array = "no declared params" (not "no params accepted").
   * Optional during T4897 migration — defaults to [] when absent.
   * @see T4897 for progressive migration
   */
  params?: ParamDef[];
}

/**
 * Resolution output for a dispatch request.
 */
export interface Resolution {
  /** The canonical domain. */
  domain: CanonicalDomain;
  /** The operation name. */
  operation: string;
  /** The definition of the matched operation. */
  def: OperationDef;
}

/**
 * The single source of truth for all operations in CLEO.
 */
export const OPERATIONS: OperationDef[] = [
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'show',
    description: 'tasks.show (query)',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'ID of the task to retrieve',
        cli: { positional: true },
      },
      {
        name: 'history',
        type: 'boolean',
        required: false,
        description: 'Include lifecycle stage history in the response',
      },
      {
        name: 'ivtr-history',
        type: 'boolean',
        required: false,
        description: 'Include IVTR phase chain history in the response',
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'list',
    description: 'tasks.list (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      { name: 'parent', type: 'string', required: false, description: 'Filter by parent task ID' },
      { name: 'status', type: 'string', required: false, description: 'Filter by task status' },
      { name: 'priority', type: 'string', required: false, description: 'Filter by task priority' },
      { name: 'type', type: 'string', required: false, description: 'Filter by task type' },
      { name: 'phase', type: 'string', required: false, description: 'Filter by task phase' },
      { name: 'label', type: 'string', required: false, description: 'Filter by task label' },
      {
        name: 'children',
        type: 'boolean',
        required: false,
        description: 'Limit parent queries to direct children',
      },
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Maximum number of tasks to return',
      },
      {
        name: 'offset',
        type: 'number',
        required: false,
        description: 'Number of filtered tasks to skip',
      },
      {
        name: 'compact',
        type: 'boolean',
        required: false,
        description: 'Deprecated: request compact task rows for compatibility',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'find',
    description: 'tasks.find (query)',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'tree',
    description: 'tasks.tree (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'blockers',
    description: 'tasks.blockers (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'depends',
    description: 'tasks.depends (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'analyze',
    description: 'tasks.analyze (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'impact',
    description:
      'tasks.impact (query) — predict downstream effects of a free-text change description using keyword matching and reverse dependency graph traversal',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['change'],
    params: [
      {
        name: 'change',
        type: 'string',
        required: true,
        description:
          'Free-text description of the proposed change (e.g. "Modify authentication flow")',
      },
      {
        name: 'matchLimit',
        type: 'number',
        required: false,
        description: 'Maximum number of seed tasks to match by keyword (default: 5)',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'next',
    description: 'tasks.next (query)',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'plan',
    description:
      'Composite planning view with in-progress epics, ready tasks, blocked tasks, and open bugs (query)',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'relates',
    description: 'tasks.relates (query) — absorbs relates.find via mode param',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'complexity.estimate',
    description: 'tasks.complexity.estimate (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query' as const,
    domain: 'tasks' as const,
    operation: 'history',
    description: 'Show task work history (time tracked per task)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'current',
    description: 'tasks.current (query)',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // Label operations (dispatch migration)
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'label.list',
    description: 'List all labels with task counts',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'session',
    operation: 'status',
    description: 'session.status (query)',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'session',
    operation: 'list',
    description: 'session.list (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      { name: 'status', type: 'string', required: false, description: 'Filter by session status' },
      {
        name: 'active',
        type: 'boolean',
        required: false,
        description: 'Legacy active-session filter',
      },
      { name: 'limit', type: 'number', required: false, description: 'Maximum sessions to return' },
      {
        name: 'offset',
        type: 'number',
        required: false,
        description: 'Skip this many sessions before returning results',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'session',
    operation: 'show',
    description: 'session.show (query) — absorbs debrief.show via include param',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'session',
    operation: 'decision.log',
    description: 'session.decision.log (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'session',
    operation: 'context.drift',
    description: 'session.context.drift (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'session',
    operation: 'handoff.show',
    description:
      'session.handoff.show - Show handoff data from the most recent ended session (query)',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'session',
    operation: 'briefing.show',
    description: 'session.briefing.show - Composite session-start context (query)',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // T4959: Rich debrief removed — merged into session.show via include param (T5615)
  {
    gateway: 'query',
    domain: 'session',
    operation: 'find',
    description: 'session.find (query) — lightweight session discovery',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'status',
    description: 'orchestrate.status (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // T811 — IVTR multi-agent enforcement
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'ivtr.status',
    description: 'orchestrate.ivtr.status (query) — current IVTR phase + history',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'ivtr.start',
    description: 'orchestrate.ivtr.start (mutate) — begin Implement phase',
    tier: 1,
    idempotent: false,
    sessionRequired: true,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'ivtr.next',
    description: 'orchestrate.ivtr.next (mutate) — advance to next phase (requires prior evidence)',
    tier: 1,
    idempotent: false,
    sessionRequired: true,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'ivtr.release',
    description: 'orchestrate.ivtr.release (mutate) — final gate, requires I+V+T evidence',
    tier: 1,
    idempotent: false,
    sessionRequired: true,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'ivtr.loop-back',
    description: 'orchestrate.ivtr.loop-back (mutate) — rewind to phase on failure',
    tier: 1,
    idempotent: false,
    sessionRequired: true,
    requiredParams: ['taskId', 'phase', 'reason'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
      {
        name: 'phase',
        type: 'string',
        required: true,
        description: 'phase parameter',
      },
      {
        name: 'reason',
        type: 'string',
        required: true,
        description: 'reason parameter',
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'next',
    description: 'orchestrate.next (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'ready',
    description: 'orchestrate.ready (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'analyze',
    description:
      'orchestrate.analyze (query) — absorbs critical.path via mode param; Wave 7a adds mode="parallel-safety"',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'epicId',
        type: 'string',
        required: false,
        description:
          'Epic ID for standard analysis (required unless mode=critical-path or parallel-safety)',
      },
      {
        name: 'mode',
        type: 'string',
        required: false,
        description:
          'Analysis mode: omit for standard analysis, "critical-path" for CPM, "parallel-safety" for dep-graph grouping',
      },
      {
        name: 'taskIds',
        type: 'array',
        required: false,
        description:
          'Task ID list for mode="parallel-safety" — returns {parallelSafe, groups} dep-graph analysis',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'context',
    description: 'orchestrate.context (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'waves',
    description: 'orchestrate.waves (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'plan',
    description: 'orchestrate.plan (query) — deterministic wave+worker plan (T889)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['epicId'],
    params: [
      {
        name: 'epicId',
        type: 'string',
        required: true,
        description: 'Epic ID to emit a plan for',
        cli: { positional: true },
      },
      {
        name: 'preferTier',
        type: 'number',
        required: false,
        description: 'Preferred resolver tier (0=project, 1=global, 2=packaged)',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'bootstrap',
    description: 'orchestrate.bootstrap (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'unblock.opportunities',
    description: 'orchestrate.unblock.opportunities (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // orchestrate.critical.path removed — merged into analyze via mode param (T5615)
  // ---------------------------------------------------------------------------
  // memory — brain.db cognitive memory (T5241 cutover)
  // ---------------------------------------------------------------------------
  // memory.show removed — use memory.fetch with single-element ids array (T5615)
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'find',
    description: 'memory.find (query) — cross-table brain.db FTS5 search',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['query'],
    params: [
      {
        name: 'agent',
        type: 'string',
        required: false,
        description:
          'Filter results to observations produced by the named agent (T418 mental models)',
        cli: { flag: '--agent <name>' },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'timeline',
    description: 'memory.timeline (query) — chronological context around anchor',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['anchor'],
    params: [
      {
        name: 'anchor',
        type: 'string',
        required: true,
        description: 'anchor parameter',
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'fetch',
    description: 'memory.fetch (query) — batch fetch brain entries by IDs',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['ids'],
    params: [
      {
        name: 'ids',
        type: 'string',
        required: true,
        description: 'ids parameter',
      },
    ] satisfies ParamDef[],
  },
  // memory.stats, memory.contradictions, memory.superseded removed — dashboard-only (T5615)
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'decision.find',
    description: 'memory.decision.find (query) — search decisions in brain.db',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'pattern.find',
    description:
      'memory.pattern.find (query) — search BRAIN pattern memory by type, impact, or keyword',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // memory.pattern.stats removed — dashboard-only (T5615)
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'learning.find',
    description:
      'memory.learning.find (query) — search BRAIN learning memory by confidence, actionability, or keyword',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // memory.learning.stats removed — dashboard-only (T5615)
  // memory — PageIndex graph queries (T5385)
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'graph.show',
    description: 'memory.graph.show (query) — get a PageIndex graph node and its edges',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['nodeId'],
    params: [
      {
        name: 'nodeId',
        type: 'string',
        required: true,
        description: 'nodeId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'graph.neighbors',
    description: 'memory.graph.neighbors (query) — get neighbor nodes from the PageIndex graph',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['nodeId'],
    params: [
      {
        name: 'nodeId',
        type: 'string',
        required: true,
        description: 'nodeId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  // memory — Graph traversal (T535)
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'graph.trace',
    description:
      'memory.graph.trace (query) — BFS traversal from a seed node via recursive CTE (T535)',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['nodeId'],
    params: [
      {
        name: 'nodeId',
        type: 'string',
        required: true,
        description: 'nodeId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'graph.related',
    description:
      'memory.graph.related (query) — 1-hop typed neighbours of a brain graph node (T535)',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['nodeId'],
    params: [
      {
        name: 'nodeId',
        type: 'string',
        required: true,
        description: 'nodeId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'graph.context',
    description:
      'memory.graph.context (query) — 360-degree context view: node + all edges + neighbours (T535)',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['nodeId'],
    params: [
      {
        name: 'nodeId',
        type: 'string',
        required: true,
        description: 'nodeId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'graph.stats',
    description: 'memory.graph.stats (query) — aggregate node and edge counts by type (T535)',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // memory — Reasoning & hybrid search (T5388-T5393)
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'reason.why',
    description: 'memory.reason.why (query) — causal trace through task dependency chains',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'reason.similar',
    description: 'memory.reason.similar (query) — find semantically similar brain entries',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['entryId'],
    params: [
      {
        name: 'entryId',
        type: 'string',
        required: true,
        description: 'entryId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'search.hybrid',
    description: 'memory.search.hybrid (query) — hybrid search across FTS5, vector, and graph',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['query'],
    params: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'query parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'stage.validate',
    description: 'pipeline.stage.validate (query) — absorbs stage.prerequisites in response',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'stage.status',
    description: 'pipeline.stage.status (query) — absorbs stage.gates via include param',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'stage.history',
    description: 'pipeline.stage.history (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'stage.guidance',
    description:
      'pipeline.stage.guidance (query) — stage-aware LLM prompt guidance (Phase 2). Pi extensions shell out to this on before_agent_start.',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // stage.gates removed — merged into stage.status via include param (T5615)
  // stage.prerequisites removed — always returned in stage.validate response (T5615)
  // T5326: Phase management operations
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'phase.show',
    description: 'Show phase details by slug or current phase (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'phaseId',
        type: 'string',
        required: false,
        description: 'Phase slug (omit for current phase)',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'phase.list',
    description: 'List all phases with status and task counts (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // pipeline manifest query operations (T5241 — moved from memory)
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'manifest.show',
    description: 'pipeline.manifest.show (query) — get manifest entry by ID',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['entryId'],
    params: [
      {
        name: 'entryId',
        type: 'string',
        required: true,
        description: 'entryId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'manifest.list',
    description: 'pipeline.manifest.list (query) — list manifest entries with filters',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'manifest.find',
    description: 'pipeline.manifest.find (query) — search manifest entries by text',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['query'],
    params: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'query parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  // manifest.pending removed — merged into manifest.list via filter param (T5615)
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'manifest.stats',
    description: 'pipeline.manifest.stats (query) — manifest statistics',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // T5405: WarpChain pipeline operations
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'chain.show',
    description: 'pipeline.chain.show (query) — get chain definition by ID',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['chainId'],
    params: [
      {
        name: 'chainId',
        type: 'string',
        required: true,
        description: 'chainId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'chain.list',
    description: 'pipeline.chain.list (query) — list all chain definitions',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'check',
    operation: 'schema',
    description: 'check.schema (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['type'],
    params: [
      {
        name: 'type',
        type: 'string',
        required: true,
        description: 'Schema type to validate (todo, config, archive, log, sessions)',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'check',
    operation: 'protocol',
    description: 'check.protocol (query) — absorbs all protocol.* ops via protocolType param',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'check',
    operation: 'task',
    description: 'check.task (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'check',
    operation: 'manifest',
    description: 'check.manifest (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'check',
    operation: 'output',
    description: 'check.output (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'check',
    operation: 'compliance.summary',
    description:
      'check.compliance.summary (query) — absorbs compliance.violations via detail param',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // compliance.violations removed — merged into compliance.summary via detail param (T5615)
  // test.status removed — merged into test op (T5615)
  {
    gateway: 'query',
    domain: 'check',
    operation: 'test',
    description: 'check.test (query) — combined test status and coverage via format param',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'check',
    operation: 'coherence',
    description: 'check.coherence (query) — renamed from coherence.check (T5615)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },

  // Protocol validation operations (T5327) — protocol.consensus/contribution/decomposition/implementation/specification
  // removed — folded into check.protocol via protocolType param (T5615)

  // gate.verify split into gate.status (query) + gate.set (mutate) (T5615)
  {
    gateway: 'query',
    domain: 'check',
    operation: 'gate.status',
    description: 'check.gate.status (query) — read-only gate state; split from gate.verify (T5615)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  // check.archive.stats incoming from admin (T5615)
  {
    gateway: 'query',
    domain: 'check',
    operation: 'archive.stats',
    description: 'check.archive.stats (query) — archive analytics; moved from admin (T5615)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // check.grade and check.grade.list incoming from admin (T5615)
  {
    gateway: 'query',
    domain: 'check',
    operation: 'grade',
    description: 'check.grade (query) — grade agent behavioral session; moved from admin (T5615)',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['sessionId'],
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'sessionId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'check',
    operation: 'grade.list',
    description:
      'check.grade.list (query) — list past session grade results; moved from admin (T5615)',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: false,
        description: 'Filter grades by session ID',
      },
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Maximum grade entries to return',
      },
      {
        name: 'offset',
        type: 'number',
        required: false,
        description: 'Skip this many grade entries before returning results',
      },
    ],
  },
  // T5405: WarpChain validation query
  {
    gateway: 'query',
    domain: 'check',
    operation: 'chain.validate',
    description: 'check.chain.validate (query) — validate a WarpChain definition',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['chain'],
    params: [
      {
        name: 'chain',
        type: 'string',
        required: true,
        description: 'chain parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  // T646: Canon drift detection — CI gate
  {
    gateway: 'query',
    domain: 'check',
    operation: 'canon',
    description:
      'check.canon (query) — CI gate: detects canon drift between docs and live code (CANONICAL_DOMAINS count, forbidden phrases, required assertions)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // T065: Agent workflow compliance telemetry
  {
    gateway: 'query',
    domain: 'check',
    operation: 'workflow.compliance',
    description:
      'check.workflow.compliance (query) — WF-001..WF-005 compliance dashboard; AC rate, session rate, gate rate',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'since',
        type: 'string',
        required: false,
        description: 'ISO 8601 date; only include tasks/events on or after this date',
      },
    ],
  },

  {
    gateway: 'query',
    domain: 'admin',
    operation: 'version',
    description: 'admin.version (query)',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'health',
    description: 'admin.health (query) — absorbs doctor via mode param',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'config.show',
    description: 'admin.config.show (query) — show config value',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'config.presets',
    description:
      'admin.config.presets (query) — list all strictness presets with descriptions and values',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'stats',
    description: 'admin.stats (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'context',
    description: 'admin.context (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    // T549 Wave 5-A: JIT task context pull — bundles task + brain memories + handoff
    gateway: 'query',
    domain: 'admin',
    operation: 'context.pull',
    description:
      'admin.context.pull (query) — JIT bundle: task details + brain memories + last handoff',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'runtime',
    description: 'admin.runtime (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'paths',
    description:
      'admin.paths (query) — report all CleoOS paths (project + global hub) and scaffolding status',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // admin.job.status + admin.job.list merged into admin.job via action param (T5615)
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'job',
    description: 'admin.job (query) — absorbs job.status and job.list via action param',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'action',
        type: 'string',
        required: false,
        description: 'Action: status (default) or list',
      },
      {
        name: 'status',
        type: 'string',
        required: false,
        description: 'Filter jobs by status (for list action)',
      },
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Maximum jobs to return (for list action)',
      },
      {
        name: 'offset',
        type: 'number',
        required: false,
        description: 'Skip this many jobs before returning results',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'dash',
    description: 'admin.dash (query)',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'roadmap',
    description:
      'admin.roadmap (query) — project roadmap from task provenance, epics grouped by status with progress',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'includeHistory',
        type: 'boolean',
        required: false,
        description: 'Include release history from CHANGELOG.md',
      },
      {
        name: 'upcomingOnly',
        type: 'boolean',
        required: false,
        description: 'Only show pending/upcoming epics (exclude completed)',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'log',
    description: 'admin.log (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'sequence',
    description: 'admin.sequence (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'help',
    description: 'Get operations list and guidance filtered to specified disclosure tier',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'tier',
        type: 'number',
        required: false,
        description:
          'Progressive disclosure tier: 0=basic (default), 1=+memory/check, 2=all operations',
        cli: { flag: 'tier', short: '-t' },
      },
      {
        name: 'verbose',
        type: 'boolean',
        required: false,
        description: 'Return full operation objects instead of compact domain-grouped format',
        cli: { flag: 'verbose' },
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'issue.diagnostics',
    description: 'tools.issue.diagnostics (query) — CLEO install integrity check',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // tools.issue.templates and tools.issue.validate.labels moved to ct-github-issues plugin (T5615)
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'skill.list',
    description: 'tools.skill.list (query)',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'skill.show',
    description: 'tools.skill.show (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'skill.find',
    description: 'tools.skill.find (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'skill.dispatch',
    description: 'tools.skill.dispatch (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'skill.verify',
    description: 'tools.skill.verify (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'skill.dependencies',
    description: 'tools.skill.dependencies (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'skill.spawn.providers',
    description: 'List spawn-capable providers by capability (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // skill.catalog.protocols/profiles/resources/info merged into skill.catalog via type param (T5615)
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'skill.catalog',
    description:
      'tools.skill.catalog (query) — CAAMP catalog; absorbs catalog.protocols/profiles/resources/info via type param',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'type',
        type: 'string',
        required: false,
        description: 'Catalog type: protocols, profiles, resources, or info (default)',
      },
    ],
  },
  // skill.precedence.show/resolve merged into skill.precedence via action param (T5615)
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'skill.precedence',
    description:
      'tools.skill.precedence (query) — absorbs precedence.show and precedence.resolve via action param',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'action',
        type: 'string',
        required: false,
        description: 'Action: show (default) or resolve',
      },
      {
        name: 'providerId',
        type: 'string',
        required: false,
        description: 'Provider ID for resolve action',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'provider.list',
    description: 'tools.provider.list (query)',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'provider.detect',
    description: 'tools.provider.detect (query)',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'provider.inject.status',
    description: 'tools.provider.inject.status (query)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'provider.supports',
    description: 'tools.provider.supports (query) - check if provider supports capability',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['providerId', 'capability'],
    params: [
      {
        name: 'providerId',
        type: 'string',
        required: true,
        description: 'Provider ID (e.g., claude-code)',
      },
      {
        name: 'capability',
        type: 'string',
        required: true,
        description: 'Capability path in dot notation (e.g., spawn.supportsSubagents)',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'provider.hooks',
    description: 'tools.provider.hooks (query) - list providers by hook event support',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['event'],
    params: [
      {
        name: 'event',
        type: 'string',
        required: true,
        description: 'Hook event to query (e.g., onSessionStart, onToolComplete)',
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'add',
    description: 'tasks.add (mutate)',
    tier: 0,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['title'],
    params: [
      {
        name: 'title',
        type: 'string',
        required: true,
        description: 'Task title (3\u2013500 characters)',
        cli: { positional: true },
      },
      {
        name: 'parent',
        type: 'string',
        required: false,
        description: 'Parent task ID (makes this task a subtask)',
        cli: { flag: 'parent' },
      },
      {
        name: 'priority',
        type: 'string',
        required: false,
        description: 'Task priority',
        enum: ['low', 'medium', 'high', 'critical'] as const,
        cli: { flag: 'priority', short: '-p' },
      },
      {
        name: 'type',
        type: 'string',
        required: false,
        description: 'Task type',
        enum: ['epic', 'task', 'subtask', 'bug'] as const,
        cli: { flag: 'type', short: '-t' },
      },
      {
        name: 'size',
        type: 'string',
        required: false,
        description: 'Scope size estimate',
        enum: ['small', 'medium', 'large'] as const,
        cli: { flag: 'size' },
      },
      {
        name: 'description',
        type: 'string',
        required: false,
        description: 'Detailed task description (must differ meaningfully from title)',
        cli: { flag: 'description', short: '-d' },
      },
      {
        name: 'acceptance',
        type: 'array',
        required: false,
        description: 'Pipe-separated acceptance criteria (e.g. "AC1|AC2|AC3")',
        cli: { flag: 'acceptance' },
      },
      {
        name: 'labels',
        type: 'array',
        required: false,
        description: 'Comma-separated labels',
        cli: { flag: 'labels', short: '-l' },
      },
      {
        name: 'depends',
        type: 'array',
        required: false,
        description: 'Comma-separated dependency task IDs',
        cli: { flag: 'depends', short: '-D' },
      },
      {
        name: 'phase',
        type: 'string',
        required: false,
        description: 'Phase slug to assign the task to',
        cli: { flag: 'phase', short: '-P' },
      },
      {
        name: 'notes',
        type: 'string',
        required: false,
        description: 'Initial note entry for the task',
        cli: { flag: 'notes' },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'update',
    description: 'tasks.update (mutate)',
    tier: 0,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'complete',
    description: 'tasks.complete (mutate)',
    tier: 0,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'cancel',
    description:
      'tasks.cancel (mutate) — cancel task (soft terminal state; reversible via tasks.restore)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'delete',
    description: 'tasks.delete (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'archive',
    description: 'tasks.archive (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'restore',
    description: 'tasks.restore (mutate) — absorbs reopen and unarchive via from param',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'reparent',
    description: 'tasks.reparent (mutate) — absorbs promote via newParentId:null',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'reorder',
    description: 'tasks.reorder (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskId', 'position'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
      {
        name: 'position',
        type: 'string',
        required: true,
        description: 'position parameter',
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'relates.add',
    description: 'tasks.relates.add (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskId', 'type'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
      {
        name: 'type',
        type: 'string',
        required: true,
        description: 'type parameter',
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'start',
    description: 'tasks.start (mutate)',
    tier: 0,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'stop',
    description: 'tasks.stop (mutate)',
    tier: 0,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // === tasks.sync sub-domain (provider-agnostic task reconciliation) ===
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'sync.reconcile',
    description: 'tasks.sync.reconcile (mutate) — reconcile external tasks with CLEO as SSoT',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['providerId', 'externalTasks'],
    params: [
      {
        name: 'providerId',
        type: 'string',
        required: true,
        description: 'Provider identifier (e.g. linear, jira, github)',
      },
      {
        name: 'externalTasks',
        type: 'array',
        required: true,
        description: 'Array of normalized ExternalTask objects',
      },
      {
        name: 'dryRun',
        type: 'boolean',
        required: false,
        description: 'Compute actions without applying them',
      },
      {
        name: 'conflictPolicy',
        type: 'string',
        required: false,
        description: 'Conflict resolution: cleo-wins, provider-wins, latest-wins, report-only',
      },
      {
        name: 'defaultPhase',
        type: 'string',
        required: false,
        description: 'Default phase for newly created tasks',
      },
      {
        name: 'defaultLabels',
        type: 'array',
        required: false,
        description: 'Default labels for newly created tasks',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'tasks',
    operation: 'sync.links',
    description: 'tasks.sync.links (query) — list external task links by provider or task ID',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'providerId',
        type: 'string',
        required: false,
        description: 'Filter links by provider',
      },
      {
        name: 'taskId',
        type: 'string',
        required: false,
        description: 'Filter links by CLEO task ID',
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'sync.links.remove',
    description: 'tasks.sync.links.remove (mutate) — remove all external task links for a provider',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['providerId'],
    params: [
      {
        name: 'providerId',
        type: 'string',
        required: true,
        description: 'Provider whose links should be removed',
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'claim',
    description: 'tasks.claim (mutate) — claim a task by assigning it to the current session',
    tier: 0,
    idempotent: false,
    sessionRequired: true,
    requiredParams: ['taskId', 'agentId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'Task ID to claim',
      },
      {
        name: 'agentId',
        type: 'string',
        required: true,
        description: 'Agent ID to assign the task to',
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'unclaim',
    description: 'tasks.unclaim (mutate) — unclaim a task by removing the current assignee',
    tier: 0,
    idempotent: false,
    sessionRequired: true,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'Task ID to unclaim',
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'session',
    operation: 'start',
    description: 'session.start (mutate)',
    tier: 0,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'session',
    operation: 'end',
    description: 'session.end (mutate)',
    tier: 0,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'session',
    operation: 'resume',
    description: 'session.resume (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'session',
    operation: 'suspend',
    description: 'session.suspend (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'session',
    operation: 'gc',
    description: 'session.gc (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'session',
    operation: 'record.decision',
    description: 'session.record.decision (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'session',
    operation: 'record.assumption',
    description: 'session.record.assumption (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // session.context.inject moved to admin.context.inject (T5615)
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'start',
    description: 'orchestrate.start (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'spawn',
    description: 'orchestrate.spawn (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'handoff',
    description:
      'orchestrate.handoff (mutate) — composite handoff (context.inject -> session.end -> spawn)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskId', 'protocolType'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'Successor task ID for spawn context',
      },
      {
        name: 'protocolType',
        type: 'string',
        required: true,
        description: 'Protocol name for handoff context injection',
      },
      {
        name: 'note',
        type: 'string',
        required: false,
        description: 'Optional handoff note persisted through session.end',
      },
      {
        name: 'nextAction',
        type: 'string',
        required: false,
        description: 'Optional next action metadata for the handoff payload',
      },
      {
        name: 'variant',
        type: 'string',
        required: false,
        description: 'Optional context injection variant',
      },
      {
        name: 'tier',
        type: 'number',
        required: false,
        description: 'Progressive disclosure tier (0-2)',
      },
      {
        name: 'idempotencyKey',
        type: 'string',
        required: false,
        description: 'Caller-provided retry correlation key (reported in metadata)',
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'spawn.execute',
    description:
      'orchestrate.spawn.execute (mutate) — execute spawn for a task using adapter registry',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      { name: 'taskId', type: 'string', required: true, description: 'Task ID to spawn' },
      {
        name: 'adapterId',
        type: 'string',
        required: false,
        description: 'Adapter ID (auto-select if omitted)',
      },
      {
        name: 'protocolType',
        type: 'string',
        required: false,
        description: 'Protocol type override',
      },
      {
        name: 'tier',
        type: 'number',
        required: false,
        description: 'Progressive disclosure tier (0-2)',
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'validate',
    description: 'orchestrate.validate (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // parallel.start and parallel.end merged into orchestrate.parallel via action param (T5615)
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'parallel',
    description:
      'orchestrate.parallel (mutate) — absorbs parallel.start and parallel.end via action param',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['action'],
    params: [
      { name: 'action', type: 'string', required: true, description: 'Action: start or end' },
    ],
  },
  // memory mutate — brain.db cognitive memory (T5241 cutover)
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'observe',
    description: 'memory.observe (mutate) — save observation to brain.db',
    tier: 0,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['text'],
    params: [
      {
        name: 'text',
        type: 'string',
        required: true,
        description: 'text parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'decision.store',
    description: 'memory.decision.store (mutate) — store decision to brain.db',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['decision', 'rationale'],
    params: [
      {
        name: 'decision',
        type: 'string',
        required: true,
        description: 'decision parameter',
        cli: { positional: true },
      },
      {
        name: 'rationale',
        type: 'string',
        required: true,
        description: 'rationale parameter',
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'pattern.store',
    description:
      'memory.pattern.store (mutate) — store a reusable workflow or anti-pattern in BRAIN pattern memory',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['pattern', 'context'],
    params: [
      {
        name: 'pattern',
        type: 'string',
        required: true,
        description: 'pattern parameter',
        cli: { positional: true },
      },
      {
        name: 'context',
        type: 'string',
        required: true,
        description: 'context parameter',
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'learning.store',
    description:
      'memory.learning.store (mutate) — store an insight or lesson learned in BRAIN learning memory',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['insight', 'source'],
    params: [
      {
        name: 'insight',
        type: 'string',
        required: true,
        description: 'insight parameter',
        cli: { positional: true },
      },
      {
        name: 'source',
        type: 'string',
        required: true,
        description: 'source parameter',
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'link',
    description: 'memory.link (mutate) — link brain entry to task',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskId', 'entryId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'taskId parameter',
        cli: { positional: true },
      },
      {
        name: 'entryId',
        type: 'string',
        required: true,
        description: 'entryId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  // memory.unlink removed — rarely needed; direct repair if needed (T5615)
  // memory — PageIndex graph mutations (T5385)
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'graph.add',
    description: 'memory.graph.add (mutate) — add a node or edge to the PageIndex graph',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'graph.remove',
    description: 'memory.graph.remove (mutate) — remove a node or edge from the PageIndex graph',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'quality',
    description: 'Memory quality report: retrieval stats, noise ratio, tier distribution',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'code.links',
    description: 'List code_reference edges connecting memories to nexus code symbols',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'code.memories-for-code',
    description: 'Find memories linked to a code symbol via code_reference edges',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['symbol'],
    params: [
      {
        name: 'symbol',
        type: 'string',
        required: true,
        description: 'symbol parameter',
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'code.for-memory',
    description: 'Find code symbols linked to a memory entry via code_reference edges',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['memoryId'],
    params: [
      {
        name: 'memoryId',
        type: 'string',
        required: true,
        description: 'memoryId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'code.link',
    description: 'Create code_reference edge from memory to nexus symbol',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['memoryId', 'codeSymbol'],
    params: [
      {
        name: 'memoryId',
        type: 'string',
        required: true,
        description: 'memoryId parameter',
        cli: { positional: true },
      },
      {
        name: 'codeSymbol',
        type: 'string',
        required: true,
        description: 'codeSymbol parameter',
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'code.auto-link',
    description: 'Scan memories for entity references and auto-link to nexus nodes',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // T1262 — memory-doctor read-only noise detector (E1-parallel per council verdict)
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'doctor',
    description:
      'memory.doctor (query) — read-only brain noise scan: detects duplicate-content, missing-type, missing-provenance, orphan-edge, low-confidence, stale-unverified patterns. Used as M7 assert-clean gate for Sentient v1 activation.',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'assert-clean',
        type: 'boolean',
        required: false,
        description:
          'If true, exit non-zero when any noise patterns are detected (M7 gate for Sentient v1).',
      },
    ],
  },
  // T791 — LLM extraction backend status
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'llm-status',
    description:
      'memory.llm-status (query) — report LLM backend resolution status and extraction readiness',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // T792 — pending verification queue
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'pending-verify',
    description:
      'memory.pending-verify (query) — list unverified brain entries with citation_count >= threshold',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'minCitations',
        type: 'number',
        required: false,
        description: 'Minimum citation count threshold (default: 5)',
      },
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Maximum entries to return (default: 50)',
      },
    ],
  },
  // T999 — live memory-bridge content from brain.db (cli mode default)
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'bridge',
    description:
      'memory.bridge (query) — stream brain.db memory-bridge content directly (cli mode default)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // T997 — read-only explainability view for STDP + retrieval + citation promotion decisions
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'promote-explain',
    description:
      'memory.promote-explain (query) — read-only view over STDP weights, retrieval log, and citation_count for a brain entry; returns tier decision and score breakdown',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['id'],
    params: [
      {
        name: 'id',
        type: 'string',
        required: true,
        description: 'Brain entry id (e.g. O-abc123, D-def456, P-ghi789, L-jkl012)',
      },
    ],
  },
  // T1006 — summarized top-N observations as session briefing digest
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'digest',
    description:
      'memory.digest (query) — summarized top-N observations by citation_count for session briefings',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Max observations to include in digest (default: 10)',
      },
    ],
  },
  // T1006 — tail recent observations with optional filters
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'recent',
    description:
      'memory.recent (query) — tail recent brain_observations with optional filters (since, type, session, tier)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Max entries to return (default: 20)',
      },
      {
        name: 'since',
        type: 'string',
        required: false,
        description: "ISO timestamp or duration (e.g. '24h', '7d') to filter from",
      },
      {
        name: 'type',
        type: 'string',
        required: false,
        description: 'Filter by observation type (e.g. diary, observation, pattern)',
      },
      {
        name: 'session',
        type: 'string',
        required: false,
        description: 'Filter by source_session_id',
      },
      {
        name: 'tier',
        type: 'string',
        required: false,
        description: 'Filter by memory_tier (short, medium, long)',
      },
    ],
  },
  // T1006 — read diary-typed observations (requires diary enum from T1005)
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'diary',
    description:
      "memory.diary (query) — list observations with type='diary' in reverse chronological order",
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Max diary entries to return (default: 20)',
      },
    ],
  },
  // T1006 — long-poll stream of recent brain writes (SSE-style polling stub)
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'watch',
    description:
      'memory.watch (query) — poll for new brain_observations since a cursor; returns nextCursor for chained polling',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'cursor',
        type: 'string',
        required: false,
        description: 'ISO datetime cursor; only observations after this time are returned',
      },
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Max events per poll (default: 10)',
      },
    ],
  },
  // T1006 — write a diary-typed observation
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'diary.write',
    description:
      "memory.diary.write (mutate) — store an observation with type='diary' (thin wrapper over observe)",
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['text'],
    params: [
      { name: 'text', type: 'string', required: true, description: 'Diary entry text' },
      { name: 'title', type: 'string', required: false, description: 'Optional title' },
      {
        name: 'sourceSessionId',
        type: 'string',
        required: false,
        description: 'Session that produced this entry',
      },
      { name: 'agent', type: 'string', required: false, description: 'Agent provenance' },
    ],
  },
  // T792 — promote entry to verified=true (project-orchestrator or owner only)
  // T1258 E1 migration shim: 'cleo-prime' accepted as legacy alias for 'project-orchestrator'
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'verify',
    description:
      'memory.verify (mutate) — flip verified=1 on a brain entry; requires project-orchestrator or owner identity',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['id'],
    params: [
      { name: 'id', type: 'string', required: true, description: 'Brain entry ID to verify' },
      {
        name: 'agent',
        type: 'string',
        required: false,
        description:
          "Caller identity ('project-orchestrator' or 'owner'). Legacy alias 'cleo-prime' accepted per T1258 E1 migration shim. Omit for terminal invocation.",
      },
    ],
  },
  // T1004 — flush in-flight observations + WAL checkpoint before context compaction
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'precompact-flush',
    description:
      'memory.precompact-flush (mutate) — flush in-flight brain observations and issue a WAL checkpoint before context window compaction',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // T1003 — staged graph backfill operations
  {
    gateway: 'query',
    domain: 'memory',
    operation: 'backfill.list',
    description:
      'memory.backfill.list (query) — list staged backfill runs with status (pending/approved/rolled-back)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'backfill.run',
    description:
      'memory.backfill.run (mutate) — stage a new graph backfill run (rows held pending approval)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'backfill.approve',
    description:
      'memory.backfill.approve (mutate) — approve a staged backfill run (commits rows to live tables)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['runId'],
    params: [
      { name: 'runId', type: 'string', required: true, description: 'Backfill run ID to approve' },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'memory',
    operation: 'backfill.rollback',
    description:
      'memory.backfill.rollback (mutate) — rollback a backfill run (removes staged/committed rows)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['runId'],
    params: [
      { name: 'runId', type: 'string', required: true, description: 'Backfill run ID to rollback' },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'stage.record',
    description: 'pipeline.stage.record (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'stage.skip',
    description: 'pipeline.stage.skip (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'stage.reset',
    description: 'pipeline.stage.reset (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'stage.gate.pass',
    description: 'pipeline.stage.gate.pass (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'stage.gate.fail',
    description: 'pipeline.stage.gate.fail (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // pipeline manifest mutate operations (T5241 — moved from memory)
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'manifest.append',
    description:
      'pipeline.manifest.append (mutate) — append entry to pipeline_manifest (SQLite table per ADR-027)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['entry'],
    params: [
      {
        name: 'entry',
        type: 'string',
        required: true,
        description: 'entry parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'manifest.archive',
    description: 'pipeline.manifest.archive (mutate) — archive old manifest entries',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['beforeDate'],
    params: [
      {
        name: 'beforeDate',
        type: 'string',
        required: true,
        description: 'beforeDate parameter',
      },
    ] satisfies ParamDef[],
  },
  // T5326: Phase mutation operations
  {
    gateway: 'mutate' as const,
    domain: 'pipeline' as const,
    operation: 'phase.set',
    description: 'Set the active phase',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['phaseId'],
    params: [
      {
        name: 'phaseId',
        type: 'string',
        required: true,
        description: 'Phase slug to set as current',
      },
      {
        name: 'rollback',
        type: 'boolean',
        required: false,
        description: 'Allow backward phase movement',
      },
      { name: 'force', type: 'boolean', required: false, description: 'Skip confirmation prompt' },
      {
        name: 'dryRun',
        type: 'boolean',
        required: false,
        description: 'Preview changes without modifying files',
      },
    ],
  },
  // phase.start and phase.complete removed — merged into phase.set via action param (T5615)
  {
    gateway: 'mutate' as const,
    domain: 'pipeline' as const,
    operation: 'phase.advance',
    description: 'Complete current phase and start next',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'force',
        type: 'boolean',
        required: false,
        description: 'Skip validation and interactive prompt',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'pipeline' as const,
    operation: 'phase.rename',
    description: 'Rename a phase and update all task references',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['oldName', 'newName'],
    params: [
      {
        name: 'oldName',
        type: 'string',
        required: true,
        description: 'oldName parameter',
      },
      {
        name: 'newName',
        type: 'string',
        required: true,
        description: 'newName parameter',
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate' as const,
    domain: 'pipeline' as const,
    operation: 'phase.delete',
    description: 'Delete a phase with task reassignment protection',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['phaseId'],
    params: [
      { name: 'phaseId', type: 'string', required: true, description: 'Phase slug to delete' },
      {
        name: 'reassignTo',
        type: 'string',
        required: false,
        description: 'Reassign tasks to another phase',
      },
      { name: 'force', type: 'boolean', required: false, description: 'Required safety flag' },
    ],
  },
  // T5405: WarpChain pipeline mutate operations
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'chain.add',
    description: 'pipeline.chain.add (mutate) — store a validated chain definition',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['chain'],
    params: [
      {
        name: 'chain',
        type: 'string',
        required: true,
        description: 'chain parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'chain.instantiate',
    description: 'pipeline.chain.instantiate (mutate) — create chain instance for epic',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['chainId', 'epicId'],
    params: [
      {
        name: 'chainId',
        type: 'string',
        required: true,
        description: 'chainId parameter',
        cli: { positional: true },
      },
      {
        name: 'epicId',
        type: 'string',
        required: true,
        description: 'epicId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'chain.advance',
    description: 'pipeline.chain.advance (mutate) — advance instance to next stage',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['instanceId', 'nextStage'],
    params: [
      {
        name: 'instanceId',
        type: 'string',
        required: true,
        description: 'instanceId parameter',
        cli: { positional: true },
      },
      {
        name: 'nextStage',
        type: 'string',
        required: true,
        description: 'nextStage parameter',
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'check',
    operation: 'compliance.record',
    description: 'check.compliance.record (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'check',
    operation: 'test.run',
    description: 'check.test.run (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'check',
    operation: 'compliance.sync',
    description: 'check.compliance.sync (mutate) — sync project compliance metrics to global',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'check',
    operation: 'gate.set',
    description:
      'check.gate.set (mutate) — write path of former gate.verify; set/reset gates (T5615)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // T1006 — human-readable breakdown of why gates pass/fail for a task
  {
    gateway: 'query',
    domain: 'check',
    operation: 'verify.explain',
    description:
      'check.verify.explain (query) — show evidence atoms + gate state for a task in human-readable format (read-only)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'Task ID to explain verification state for (e.g. T1006)',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'release.list',
    description: 'List all releases from release_manifests table',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'release.show',
    description: 'Show details for a specific release version',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['version'],
    params: [
      {
        name: 'version',
        type: 'string',
        required: true,
        description: 'version parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'release.channel.show',
    description: 'Show the current release channel based on git branch (latest/beta/alpha)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'pipeline',
    operation: 'release.changelog.since',
    description:
      'Generate CHANGELOG from git log since a given tag — parses T\\d+ task/epic IDs and groups by epic (T820 RELEASE-02)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['sinceTag'],
    params: [
      {
        name: 'sinceTag',
        type: 'string',
        required: true,
        description: 'sinceTag parameter',
      },
    ] satisfies ParamDef[],
  },
  // release.prepare/changelog/commit/tag/push/gates.run removed — merged into release.ship via step param (T5615)
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'release.cancel',
    description: 'pipeline.release.cancel (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['version'],
    params: [
      {
        name: 'version',
        type: 'string',
        required: true,
        description: 'version parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'release.rollback',
    description: 'pipeline.release.rollback (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'release.ship',
    description:
      'Ship a release: validate gates → write CHANGELOG → git commit/tag/push → record provenance; absorbs prepare/changelog/commit/tag/push/gates.run via step param',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['version', 'epicId'],
    params: [
      {
        name: 'version',
        type: 'string',
        required: true,
        description: 'version parameter',
        cli: { positional: true },
      },
      {
        name: 'epicId',
        type: 'string',
        required: true,
        description: 'epicId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'pipeline',
    operation: 'release.rollback.full',
    description:
      'Full rollback: delete git tag (local + remote), revert release commit, remove manifest record (T820 RELEASE-05)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['version'],
    params: [
      {
        name: 'version',
        type: 'string',
        required: true,
        description: 'version parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate',
    domain: 'admin',
    operation: 'init',
    description: 'admin.init (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'admin',
    operation: 'scaffold-hub',
    description:
      'admin.scaffold-hub (mutate) — create CleoOS Hub dirs (global-recipes, pi-extensions, cant-workflows, agents) and seed starter justfile',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'admin',
    operation: 'config.set',
    description: 'admin.config.set (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'admin',
    operation: 'config.set-preset',
    description:
      'admin.config.set-preset (mutate) — apply a strictness preset (strict, standard, minimal)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['preset'],
    params: [
      {
        name: 'preset',
        type: 'string',
        required: true,
        description: 'Preset name: strict | standard | minimal',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'backup',
    description: 'admin.backup (query) — list available backups (read-only)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'admin',
    operation: 'backup',
    description: 'admin.backup (mutate) — absorbs restore and backup.restore via action param',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // admin.restore and admin.backup.restore removed — merged into admin.backup via action param (T5615)
  {
    gateway: 'mutate',
    domain: 'admin',
    operation: 'migrate',
    description: 'admin.migrate (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'admin',
    operation: 'cleanup',
    description: 'admin.cleanup (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'admin',
    operation: 'job.cancel',
    description: 'admin.job.cancel (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'admin',
    operation: 'safestop',
    description: 'admin.safestop (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'admin',
    operation: 'inject.generate',
    description: 'admin.inject.generate (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // admin.sequence (mutate) removed — duplicate name; expose via config.set if needed (T5615)
  // tools.issue.add.bug/feature/help moved to ct-github-issues plugin (T5615)
  // tools.issue.generate.config removed — stub with no runtime need (T5615)
  {
    gateway: 'mutate',
    domain: 'tools',
    operation: 'skill.install',
    description: 'tools.skill.install (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'tools',
    operation: 'skill.uninstall',
    description: 'tools.skill.uninstall (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // skill.enable/disable removed — aliases for install/uninstall (T5615)
  // skill.configure removed — stub with no real behavior (T5615)
  {
    gateway: 'mutate',
    domain: 'tools',
    operation: 'skill.refresh',
    description: 'tools.skill.refresh (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'tools',
    operation: 'provider.inject',
    description: 'tools.provider.inject (mutate)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // === adapter sub-domain (T5240) ===
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'adapter.list',
    description: 'tools.adapter.list (query) — list all discovered provider adapters',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'adapter.show',
    description: 'tools.adapter.show (query) — show details for a specific adapter',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['id'],
    params: [{ name: 'id', type: 'string', required: true, description: 'Adapter ID' }],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'adapter.detect',
    description: 'tools.adapter.detect (query) — detect active providers in current environment',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'tools',
    operation: 'adapter.health',
    description: 'tools.adapter.health (query) — health status for adapters',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'id',
        type: 'string',
        required: false,
        description: 'Specific adapter ID (omit for all)',
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'tools',
    operation: 'adapter.activate',
    description: 'tools.adapter.activate (mutate) — load and activate a provider adapter',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['id'],
    params: [{ name: 'id', type: 'string', required: true, description: 'Adapter ID to activate' }],
  },
  {
    gateway: 'mutate',
    domain: 'tools',
    operation: 'adapter.dispose',
    description: 'tools.adapter.dispose (mutate) — dispose one or all adapters',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'id',
        type: 'string',
        required: false,
        description: 'Adapter ID (omit to dispose all)',
      },
    ],
  },
  // T4916: Global install refresh
  {
    gateway: 'mutate',
    domain: 'admin',
    operation: 'install.global',
    description: 'Refresh global CLEO setup: provider files, configs, ~/.agents/AGENTS.md',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // admin.grade/grade.list/archive.stats moved to check domain (T5615)
  // admin.token.summary/list/show merged into admin.token (query) (T5615)
  {
    gateway: 'query',
    domain: 'admin',
    operation: 'token',
    description:
      'admin.token (query) — summarize/list/show token telemetry; absorbs token.summary, token.list, token.show via action param',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'action',
        type: 'string',
        required: false,
        description: 'Action: summary (default), list, or show',
      },
      { name: 'tokenId', type: 'string', required: false, description: 'Token ID for show action' },
      { name: 'provider', type: 'string', required: false, description: 'Filter by provider' },
      { name: 'transport', type: 'string', required: false, description: 'Filter by transport' },
      { name: 'domain', type: 'string', required: false, description: 'Filter by domain' },
      {
        name: 'operationName',
        type: 'string',
        required: false,
        description: 'Filter by operation name',
      },
      { name: 'sessionId', type: 'string', required: false, description: 'Filter by session ID' },
      { name: 'taskId', type: 'string', required: false, description: 'Filter by task ID' },
      { name: 'limit', type: 'number', required: false, description: 'Maximum records to return' },
      {
        name: 'offset',
        type: 'number',
        required: false,
        description: 'Skip this many records before returning results',
      },
    ],
  },
  // admin.token.record/delete/clear merged into admin.token (mutate) (T5615)
  {
    gateway: 'mutate',
    domain: 'admin',
    operation: 'token',
    description:
      'admin.token (mutate) — record/delete/clear token telemetry; absorbs token.record, token.delete, token.clear via action param',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'action',
        type: 'string',
        required: false,
        description: 'Action: record (default), delete, or clear',
      },
      {
        name: 'tokenId',
        type: 'string',
        required: false,
        description: 'Token ID for delete action',
      },
    ],
  },

  // ADR operations (ADR-017 §2, Tier 2 — admin domain)
  // admin.adr.list merged into adr.find (absent query = list all) (T5615)
  {
    gateway: 'query' as const,
    domain: 'admin',
    operation: 'adr.show',
    description: 'admin.adr.show (query) — retrieve single ADR by ID with frontmatter',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['adrId'],
    params: [
      {
        name: 'adrId',
        type: 'string',
        required: true,
        description: 'adrId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate' as const,
    domain: 'admin',
    operation: 'adr.sync',
    description:
      'admin.adr.sync (mutate) — sync .cleo/adrs/ markdown files into architecture_decisions DB table; absorbs adr.validate via validate flag',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // admin.adr.validate removed — merged into adr.sync via validate flag (T5615)
  {
    gateway: 'query' as const,
    domain: 'admin',
    operation: 'adr.find',
    description: 'admin.adr.find (query) — fuzzy search ADRs; absorbs adr.list when query absent',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'query',
        type: 'string',
        required: false,
        description: 'Search query (omit to list all ADRs)',
      },
      { name: 'status', type: 'string', required: false, description: 'Filter ADRs by status' },
      {
        name: 'since',
        type: 'string',
        required: false,
        description: 'Filter ADRs created on or after this date',
      },
      { name: 'limit', type: 'number', required: false, description: 'Maximum ADRs to return' },
      {
        name: 'offset',
        type: 'number',
        required: false,
        description: 'Skip this many ADRs before returning results',
      },
    ],
  },
  // admin.doctor removed — merged into admin.health via mode:"diagnose" param (T5615)
  // admin.fix removed — merged into admin.health (mutate) via mode:"repair" param (T5615)
  {
    gateway: 'mutate' as const,
    domain: 'admin',
    operation: 'health',
    description:
      'admin.health (mutate) — auto-fix failed health/doctor checks; mode:"repair" form of admin.health query (T5615)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // admin.context.inject moved from session.context.inject (T5615)
  {
    gateway: 'mutate' as const,
    domain: 'admin',
    operation: 'context.inject',
    description:
      'admin.context.inject (mutate) — inject protocol content into session context; moved from session domain (T5615)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['protocolType'],
    params: [
      {
        name: 'protocolType',
        type: 'string',
        required: true,
        description: 'protocolType parameter',
      },
    ] satisfies ParamDef[],
  },
  // admin.snapshot.export/export.tasks merged into admin.export via scope param (T5615)
  {
    gateway: 'query' as const,
    domain: 'admin',
    operation: 'export',
    description:
      'admin.export (query) — export tasks; absorbs snapshot.export and export.tasks via scope param',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // admin.snapshot.import/import.tasks merged into admin.import via scope param (T5615)
  {
    gateway: 'mutate' as const,
    domain: 'admin',
    operation: 'import',
    description:
      'admin.import (mutate) — import tasks; absorbs snapshot.import and import.tasks via scope param',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['file'],
    params: [
      {
        name: 'file',
        type: 'string',
        required: true,
        description: 'file parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate' as const,
    domain: 'admin',
    operation: 'detect',
    description: 'Refresh project-context.json — re-detect project type, framework, and LLM hints',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query' as const,
    domain: 'admin',
    operation: 'smoke',
    description: 'admin.smoke (query) — operational smoke test: one read-only query per domain',
    tier: 0,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query' as const,
    domain: 'admin',
    operation: 'smoke.provider',
    description:
      'admin.smoke.provider (query) — ADR-049 harness sovereignty probe: verify adapter shape, DB locality, hooks, spawn, and agent folder for a named provider',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['provider'],
    params: [
      {
        name: 'provider',
        type: 'string',
        required: true,
        description:
          'Provider ID to probe (claude-code | claude-sdk | codex | cursor | gemini-cli | kimi | openai-sdk | opencode | pi)',
      },
    ],
  },
  {
    gateway: 'query' as const,
    domain: 'admin',
    operation: 'hooks.matrix',
    description:
      'admin.hooks.matrix (query) — cross-provider hook support matrix using CAAMP canonical taxonomy',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'providerIds',
        type: 'string',
        required: false,
        description: 'Limit matrix to specific provider IDs (default: all mapped providers)',
      },
      {
        name: 'detectProvider',
        type: 'boolean',
        required: false,
        description: 'Detect current runtime provider (default: true)',
      },
    ],
  },
  {
    gateway: 'query' as const,
    domain: 'admin',
    operation: 'map',
    description: 'admin.map (query) — analyze codebase structure, return structured mapping',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'focus',
        type: 'string',
        required: false,
        description:
          'Focus analysis on one area: stack, architecture, structure, conventions, testing, integrations, concerns',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'admin',
    operation: 'map',
    description: 'admin.map (mutate) — analyze codebase and store findings to brain.db',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'focus',
        type: 'string',
        required: false,
        description:
          'Focus analysis on one area: stack, architecture, structure, conventions, testing, integrations, concerns',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // T1061 — nexus.augment (PreToolUse hook augmenter + T1058 search-code alias)
  // ---------------------------------------------------------------------------
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'augment',
    description: 'nexus.augment (query) — BM25 symbol context for PreToolUse hooks and search-code',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['pattern'],
    params: [
      { name: 'pattern', type: 'string', required: true, description: 'Symbol name or pattern' },
      { name: 'limit', type: 'number', required: false, description: 'Max results (default 5)' },
    ],
  },

  // ---------------------------------------------------------------------------
  // nexus.share — multi-contributor operations
  // ---------------------------------------------------------------------------
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'share.status',
    description: 'nexus.share.status (query) — sharing status',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // nexus.share.remotes removed — git CLI wrapper (T5615)
  // nexus.share.sync.status removed — git CLI wrapper (T5615)
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'share.snapshot.export',
    description: 'nexus.share.snapshot.export (mutate) — export project snapshot',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'share.snapshot.import',
    description: 'nexus.share.snapshot.import (mutate) — import project snapshot',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // nexus.share.sync.gitignore/remote.add/remote.remove/share.push/share.pull removed — git wrappers (T5615)

  // ---------------------------------------------------------------------------
  // nexus — Cross-project coordination (BRAIN Network)
  // ---------------------------------------------------------------------------

  // Query operations
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'status',
    description: 'nexus.status (query) — overall NEXUS health status',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'list',
    description: 'nexus.list (query) — list all registered NEXUS projects',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'show',
    description: 'nexus.show (query) — show a specific project by name or hash',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['name'],
    params: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'name parameter',
      },
    ] satisfies ParamDef[],
  },
  // nexus.query renamed to nexus.resolve — 'query' violates VERB-STANDARDS (T5615)
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'resolve',
    description:
      'nexus.resolve (query) — resolve a cross-project project:taskId reference; renamed from nexus.query (T5615)',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['query'],
    params: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'query parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'deps',
    description: 'nexus.deps (query) — cross-project dependency analysis',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['query'],
    params: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'query parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'graph',
    description: 'nexus.graph (query) — global dependency graph across all projects',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'path.show',
    description: 'nexus.path.show (query) — show critical dependency path across projects',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'blockers.show',
    description: 'nexus.blockers.show (query) — show blocking impact for a task query',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['query'],
    params: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'query parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'orphans.list',
    description: 'nexus.orphans.list (query) — list orphaned cross-project dependencies',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  // nexus.critical-path/blocking/orphans removed — aliases for path.show/blockers.show/orphans.list (T5615)
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'discover',
    description: 'nexus.discover (query) — discover related tasks across registered projects',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['query'],
    params: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'query parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'search',
    description: 'nexus.search (query) — search for patterns across registered projects',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['pattern'],
    params: [
      {
        name: 'pattern',
        type: 'string',
        required: true,
        description: 'pattern parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },

  // Mutate operations
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'init',
    description: 'nexus.init (mutate) — initialize NEXUS (creates registry and directories)',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'register',
    description: 'nexus.register (mutate) — register a project in NEXUS',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['path'],
    params: [
      {
        name: 'path',
        type: 'string',
        required: true,
        description: 'path parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'unregister',
    description: 'nexus.unregister (mutate) — remove a project from NEXUS',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['name'],
    params: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'name parameter',
      },
    ] satisfies ParamDef[],
  },
  // nexus.sync.all merged into nexus.sync via optional name param (T5615)
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'sync',
    description:
      'nexus.sync (mutate) — sync project(s) metadata; absorbs sync.all when name omitted',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'name',
        type: 'string',
        required: false,
        description: 'Project name to sync (omit to sync all)',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'permission.set',
    description: 'nexus.permission.set (mutate) — update project permissions',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['name', 'level'],
    params: [
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'name parameter',
      },
      {
        name: 'level',
        type: 'string',
        required: true,
        description: 'level parameter',
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'reconcile',
    description: 'nexus.reconcile (mutate) — reconcile project identity with global nexus registry',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },

  // ---------------------------------------------------------------------------
  // nexus.transfer — Cross-project task transfer (T046)
  // ---------------------------------------------------------------------------
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'transfer.preview',
    description: 'nexus.transfer.preview (query) — preview a cross-project task transfer',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskIds', 'sourceProject', 'targetProject'],
    params: [
      { name: 'taskIds', type: 'array', required: true, description: 'Task IDs to transfer' },
      {
        name: 'sourceProject',
        type: 'string',
        required: true,
        description: 'Source project name or hash',
      },
      {
        name: 'targetProject',
        type: 'string',
        required: true,
        description: 'Target project name or hash',
      },
      {
        name: 'mode',
        type: 'string',
        required: false,
        description: "Transfer mode: 'copy' (default) or 'move'",
      },
      {
        name: 'scope',
        type: 'string',
        required: false,
        description: "Transfer scope: 'subtree' (default) or 'single'",
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'transfer',
    description: 'nexus.transfer (mutate) — transfer tasks between NEXUS projects',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskIds', 'sourceProject', 'targetProject'],
    params: [
      { name: 'taskIds', type: 'array', required: true, description: 'Task IDs to transfer' },
      {
        name: 'sourceProject',
        type: 'string',
        required: true,
        description: 'Source project name or hash',
      },
      {
        name: 'targetProject',
        type: 'string',
        required: true,
        description: 'Target project name or hash',
      },
      {
        name: 'mode',
        type: 'string',
        required: false,
        description: "Transfer mode: 'copy' (default) or 'move'",
      },
      {
        name: 'scope',
        type: 'string',
        required: false,
        description: "Transfer scope: 'subtree' (default) or 'single'",
      },
      {
        name: 'onConflict',
        type: 'string',
        required: false,
        description: "Conflict strategy: 'rename' (default), 'skip', 'duplicate', 'fail'",
      },
      {
        name: 'transferBrain',
        type: 'boolean',
        required: false,
        description: 'Whether to transfer brain observations (default: false)',
      },
    ],
  },
  // T1006 / T1013 — highest-weight symbols from nexus_relations.weight (T998)
  {
    gateway: 'query',
    domain: 'nexus',
    operation: 'top-entries',
    description:
      'nexus.top-entries (query) — top-weighted symbols from nexus_relations by weight DESC (Hebbian plasticity aggregate)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Maximum entries to return (default: 20)',
      },
      {
        name: 'kind',
        type: 'string',
        required: false,
        description: 'Filter by nexus_nodes.kind (e.g. function, method, class, interface)',
      },
    ],
  },
  // T1013 — impact analysis with optional `why` reasons[]
  {
    gateway: 'query',
    domain: 'nexus',
    operation: 'impact',
    description:
      'nexus.impact (query) — BFS blast radius for a symbol with optional reasons[] path-strings when why=true',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['symbol'],
    params: [
      {
        name: 'symbol',
        type: 'string',
        required: true,
        description: 'Symbol name to analyze (case-insensitive substring match)',
      },
      {
        name: 'why',
        type: 'boolean',
        required: false,
        description:
          'Append reasons[] per affected symbol (caller count, edge strength, hop depth). Default false',
      },
      {
        name: 'depth',
        type: 'number',
        required: false,
        description: 'Maximum BFS depth (default 3, capped at 5)',
      },
      {
        name: 'projectId',
        type: 'string',
        required: false,
        description: 'Override project ID (default: auto-detected from cwd)',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // T1115 — Living Brain primitives (5 verbs)
  // ---------------------------------------------------------------------------
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'full-context',
    description:
      'nexus.full-context (query) — full 5-substrate Living Brain context for a code symbol (NEXUS callers/callees, BRAIN memories, TASKS, sentient proposals, conduit threads)',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['symbol'],
    params: [
      {
        name: 'symbol',
        type: 'string',
        required: true,
        description: 'Symbol name or nexus node ID',
      },
    ],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'task-footprint',
    description:
      'nexus.task-footprint (query) — full code impact for a task: files, symbols, blast radius, brain observations, decisions, risk tier',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'Task ID (e.g., T001)',
      },
    ],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'brain-anchors',
    description:
      'nexus.brain-anchors (query) — code anchors for a brain memory entry: linked nexus nodes, tasks that touched them, plasticity signal',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['entryId'],
    params: [
      {
        name: 'entryId',
        type: 'string',
        required: true,
        description: 'Brain entry node ID (e.g., observation:abc123)',
      },
    ],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'why',
    description:
      'nexus.why (query) — causal trace: why is a code symbol structured this way? walks BRAIN decisions, observations, and tasks',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['symbol'],
    params: [
      {
        name: 'symbol',
        type: 'string',
        required: true,
        description: 'Symbol name or nexus node ID to trace',
      },
    ],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'impact-full',
    description:
      'nexus.impact-full (query) — merged structural + task + brain impact report for a code symbol',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['symbol'],
    params: [
      {
        name: 'symbol',
        type: 'string',
        required: true,
        description: 'Symbol name or nexus node ID to analyze',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // T1116 — Code Intelligence CLI surface (4 verbs)
  // ---------------------------------------------------------------------------
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'route-map',
    description:
      'nexus.route-map (query) — display all routes with their handlers and dependencies for a project (route ID, handler name, HTTP method/path, dep count, caller count)',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'projectId',
        type: 'string',
        required: false,
        description: 'Project identifier (auto-derived from project root if omitted)',
      },
    ],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'shape-check',
    description:
      'nexus.shape-check (query) — check response shape compatibility between a route handler and its callers; returns per-caller compatibility status and recommendations',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['routeSymbol'],
    params: [
      {
        name: 'routeSymbol',
        type: 'string',
        required: true,
        description: 'Route symbol ID (format: <filePath>::<routeName>)',
      },
      {
        name: 'projectId',
        type: 'string',
        required: false,
        description: 'Project identifier (auto-derived from project root if omitted)',
      },
    ],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'search-code',
    description:
      'nexus.search-code (query) — BM25 search of code symbols in nexus.db; returns symbol names, kinds, file paths, and relevance scores',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['pattern'],
    params: [
      {
        name: 'pattern',
        type: 'string',
        required: true,
        description: 'Search query (symbol name, file pattern, or keyword)',
      },
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Max results (default: 10)',
      },
    ],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'wiki',
    description:
      'nexus.wiki (query) — generate community-grouped wiki index from the nexus code graph; scaffold mode when LOOM provider unavailable',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'outputDir',
        type: 'string',
        required: false,
        description: 'Output directory for wiki files (default: <projectRoot>/.cleo/wiki)',
      },
      {
        name: 'communityFilter',
        type: 'string',
        required: false,
        description: 'Filter generation to a single community ID (e.g. "community:3")',
      },
      {
        name: 'incremental',
        type: 'boolean',
        required: false,
        description:
          'Only regenerate communities whose symbols changed since last wiki run (uses .cleo/wiki-state.json)',
      },
    ],
  },

  // T1117 — contracts + ingestion bridge (2 query, 3 mutate)
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'contracts-show',
    description:
      'nexus.contracts-show (query) — show contract compatibility matrix between two registered projects; matches HTTP/gRPC/topic contracts and returns per-match compatibility scores',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['projectA', 'projectB'],
    params: [
      {
        name: 'projectA',
        type: 'string',
        required: true,
        description: 'First project name or ID',
      },
      {
        name: 'projectB',
        type: 'string',
        required: true,
        description: 'Second project name or ID',
      },
    ],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'task-symbols',
    description:
      'nexus.task-symbols (query) — show code symbols touched by a task via task_touches_symbol forward-lookup; returns symbol label, kind, filePath, weight, matchStrategy',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string',
        required: true,
        description: 'Task ID to look up (e.g. T001)',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'contracts-sync',
    description:
      'nexus.contracts-sync (mutate) — extract HTTP, gRPC, and topic contracts from a project and store them in nexus.db; idempotent upsert',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'repoPath',
        type: 'string',
        required: false,
        description: 'Path to project directory (default: cwd / projectRoot)',
      },
      {
        name: 'projectId',
        type: 'string',
        required: false,
        description: 'Override the project ID (default: auto-detected from repoPath)',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'contracts-link-tasks',
    description:
      'nexus.contracts-link-tasks (mutate) — link extracted contracts to tasks that touch their source symbols via task_touches_symbol edges; runs git-log task linker',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'repoPath',
        type: 'string',
        required: false,
        description: 'Path to project directory (default: cwd / projectRoot)',
      },
      {
        name: 'projectId',
        type: 'string',
        required: false,
        description: 'Override the project ID (default: auto-detected from repoPath)',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'conduit-scan',
    description:
      'nexus.conduit-scan (mutate) — scan conduit messages for symbol mentions and write conduit_mentions_symbol edges to brain_page_edges; gracefully no-ops when conduit.db or nexus.db is absent',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },

  // ---------------------------------------------------------------------------
  // T1080 — nexus.profile — user identity / preference profile (PSYCHE Wave 1)
  // ---------------------------------------------------------------------------

  // Query operations
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'profile.view',
    description:
      'nexus.profile.view (query) — list all user-profile traits, optionally filtered by minimum confidence',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'minConfidence',
        type: 'number',
        required: false,
        description: 'Minimum confidence threshold in [0.0, 1.0]. Defaults to 0.0.',
      },
      {
        name: 'includeSuperseded',
        type: 'boolean',
        required: false,
        description: 'Include superseded (deprecated) traits. Defaults to false.',
      },
    ],
  },
  {
    gateway: 'query' as const,
    domain: 'nexus',
    operation: 'profile.get',
    description: 'nexus.profile.get (query) — fetch a single user-profile trait by key',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['traitKey'],
    params: [
      {
        name: 'traitKey',
        type: 'string',
        required: true,
        description: 'Trait key to retrieve (e.g. "prefers-zero-deps")',
        cli: { positional: true },
      },
    ],
  },

  // Mutate operations
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'profile.import',
    description:
      'nexus.profile.import (mutate) — import user-profile traits from a portable JSON file (default: ~/.cleo/user_profile.json)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'path',
        type: 'string',
        required: false,
        description: 'Absolute path to the JSON file. Defaults to ~/.cleo/user_profile.json.',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'profile.export',
    description:
      'nexus.profile.export (mutate) — export user-profile traits to a portable JSON file (default: ~/.cleo/user_profile.json)',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'path',
        type: 'string',
        required: false,
        description: 'Absolute output path. Defaults to ~/.cleo/user_profile.json.',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'profile.reinforce',
    description:
      'nexus.profile.reinforce (mutate) — increment reinforcement count and boost confidence for a user-profile trait',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['traitKey'],
    params: [
      {
        name: 'traitKey',
        type: 'string',
        required: true,
        description: 'Key of the trait to reinforce',
        cli: { positional: true },
      },
      {
        name: 'source',
        type: 'string',
        required: false,
        description: 'Source identifier for this reinforcement event. Defaults to "manual".',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'profile.upsert',
    description:
      'nexus.profile.upsert (mutate) — create or update a user-profile trait in nexus.db',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['trait'],
    params: [
      {
        name: 'trait',
        type: 'string',
        required: true,
        description:
          'UserProfileTrait JSON object with traitKey, traitValue, confidence, source (accepted as JSON string at CLI boundary; parsed in dispatch handler)',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'nexus',
    operation: 'profile.supersede',
    description:
      'nexus.profile.supersede (mutate) — mark a user-profile trait as superseded by another (T1139 supersession prep)',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['oldKey', 'newKey'],
    params: [
      {
        name: 'oldKey',
        type: 'string',
        required: true,
        description: 'Trait key being deprecated',
      },
      {
        name: 'newKey',
        type: 'string',
        required: true,
        description: 'Trait key that replaces the old one',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // sticky — Ephemeral notes for quick capture (T5282)
  // ---------------------------------------------------------------------------

  // Query operations
  {
    gateway: 'query' as const,
    domain: 'sticky',
    operation: 'list',
    description: 'sticky.list (query) — list sticky notes',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query' as const,
    domain: 'sticky',
    operation: 'show',
    description: 'sticky.show (query) — show a specific sticky note',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['stickyId'],
    params: [
      {
        name: 'stickyId',
        type: 'string',
        required: true,
        description: 'stickyId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },

  // Mutate operations
  {
    gateway: 'mutate' as const,
    domain: 'sticky',
    operation: 'add',
    description: 'sticky.add (mutate) — create a new sticky note',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['content'],
    params: [
      {
        name: 'content',
        type: 'string',
        required: true,
        description: 'content parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate' as const,
    domain: 'sticky',
    operation: 'convert',
    description:
      'sticky.convert (mutate) — convert sticky to task, memory, task_note, or session_note',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['stickyId', 'targetType'],
    params: [
      { name: 'stickyId', type: 'string', required: true, description: 'ID of the sticky note' },
      {
        name: 'targetType',
        type: 'string',
        required: true,
        description: 'Target type: task, memory, task_note, or session_note',
      },
      {
        name: 'title',
        type: 'string',
        required: false,
        description: 'Optional task title (for task conversion)',
      },
      {
        name: 'memoryType',
        type: 'string',
        required: false,
        description: 'Optional memory type (for memory conversion)',
      },
      {
        name: 'taskId',
        type: 'string',
        required: false,
        description: 'Target task ID (required for task_note conversion)',
      },
      {
        name: 'sessionId',
        type: 'string',
        required: false,
        description:
          'Target session ID (optional for session_note conversion, defaults to active session)',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'sticky',
    operation: 'archive',
    description: 'sticky.archive (mutate) — archive sticky notes',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['stickyId'],
    params: [
      {
        name: 'stickyId',
        type: 'string',
        required: true,
        description: 'stickyId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  {
    gateway: 'mutate' as const,
    domain: 'sticky',
    operation: 'purge',
    description: 'sticky.purge (mutate) — permanently delete sticky notes',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['stickyId'],
    params: [
      {
        name: 'stickyId',
        type: 'string',
        required: true,
        description: 'stickyId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  // orchestrate — tessera template operations (T5411)
  // tessera.show removed — merged into tessera.list via optional id param (T5615)
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'tessera.list',
    description:
      'orchestrate.tessera.list (query) — list Tessera templates; absorbs tessera.show via optional id param',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'id',
        type: 'string',
        required: false,
        description: 'Optional template ID for single-item lookup (replaces tessera.show)',
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'tessera.instantiate',
    description:
      'orchestrate.tessera.instantiate (mutate) — instantiate a Tessera template into a chain instance',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['templateId', 'epicId'],
    params: [
      {
        name: 'templateId',
        type: 'string',
        required: true,
        description: 'templateId parameter',
        cli: { positional: true },
      },
      {
        name: 'epicId',
        type: 'string',
        required: true,
        description: 'epicId parameter',
        cli: { positional: true },
      },
    ] satisfies ParamDef[],
  },
  // orchestrate — Wave 7a dispatch ops (T408, T409, T410, T415)
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'classify',
    description:
      'orchestrate.classify (query) — classify a request against CANT team registry to route to correct team/lead/protocol',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['request'],
    params: [
      {
        name: 'request',
        type: 'string',
        required: true,
        description: 'The request or task description to classify against team consult-when hints',
      },
      {
        name: 'context',
        type: 'string',
        required: false,
        description: 'Optional additional context to improve classification accuracy',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'fanout.status',
    description:
      'orchestrate.fanout.status (query) — get status of a running fanout by its manifest entry ID',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['manifestEntryId'],
    params: [
      {
        name: 'manifestEntryId',
        type: 'string',
        required: true,
        description: 'Manifest entry ID returned by orchestrate.fanout',
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'fanout',
    description:
      'orchestrate.fanout (mutate) — fan out N spawn requests in parallel via Promise.allSettled',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['items'],
    params: [
      {
        name: 'items',
        type: 'array',
        required: true,
        description: 'Array of {team, taskId, skill?} objects to fan out',
      },
    ],
  },
  // orchestrate — Wave 7a: analyze parallel-safety mode (T410)
  // Note: orchestrate.analyze already registered above; this documents the new
  // mode="parallel-safety" variant via the existing analyze operation's params.
  // conduit — agent-to-agent messaging operations
  // T964: promoted to first-class canonical domain (supersedes ADR-042 Decision 1).
  // CONDUIT is semantically disjoint from ORCHESTRATE — it carries live
  // agent-to-agent messages via pluggable transports (Local/HTTP/SSE) and
  // persists to conduit.db. ORCHESTRATE handles wave planning + spawn-prompt
  // generation. The 10-domain invariant that justified the fold has lapsed.
  {
    gateway: 'query' as const,
    domain: 'conduit',
    operation: 'status',
    description: 'conduit.status (query) — check agent connection status and unread count',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'agentId',
        type: 'string' as const,
        required: false,
        description: 'Agent ID to check (defaults to active agent)',
      },
    ],
  },
  {
    gateway: 'query' as const,
    domain: 'conduit',
    operation: 'peek',
    description: 'conduit.peek (query) — one-shot poll for new messages without acking',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'agentId',
        type: 'string' as const,
        required: false,
        description: 'Agent ID to poll as (defaults to active agent)',
      },
      {
        name: 'limit',
        type: 'number' as const,
        required: false,
        description: 'Max messages to fetch (default: 20)',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'conduit',
    operation: 'start',
    description: 'conduit.start (mutate) — start continuous message polling for the active agent',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'agentId',
        type: 'string' as const,
        required: false,
        description: 'Agent ID to poll as (defaults to active agent)',
      },
      {
        name: 'pollIntervalMs',
        type: 'number' as const,
        required: false,
        description: 'Poll interval in milliseconds (default: 5000)',
      },
      {
        name: 'groupConversationIds',
        type: 'array' as const,
        required: false,
        description: 'Group conversation IDs to monitor for @mentions',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'conduit',
    operation: 'stop',
    description: 'conduit.stop (mutate) — stop the active polling loop',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate' as const,
    domain: 'conduit',
    operation: 'send',
    description: 'conduit.send (mutate) — send a message to an agent or conversation',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['content'],
    params: [
      {
        name: 'to',
        type: 'string' as const,
        required: false,
        description: 'Target agent ID (required if no conversationId)',
      },
      {
        name: 'conversationId',
        type: 'string' as const,
        required: false,
        description: 'Target conversation ID (required if no to)',
      },
      {
        name: 'content',
        type: 'string' as const,
        required: true,
        description: 'Message content to send',
      },
      {
        name: 'agentId',
        type: 'string' as const,
        required: false,
        description: 'Send as this agent (defaults to active agent)',
      },
    ],
  },

  // ===========================================================================
  // intelligence — Predictive Quality Intelligence (query-only)
  // ===========================================================================

  {
    gateway: 'query',
    domain: 'intelligence',
    operation: 'predict',
    description: 'Calculate risk score for a task, or predict validation outcome for a stage',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      { name: 'taskId', type: 'string' as const, required: true, description: 'Task ID to assess' },
      {
        name: 'stage',
        type: 'string' as const,
        required: false,
        description: 'Lifecycle stage for validation outcome prediction',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'intelligence',
    operation: 'suggest',
    description: 'Suggest verification gate focus for a task',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string' as const,
        required: true,
        description: 'Task ID to analyze',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'intelligence',
    operation: 'learn-errors',
    description: 'Extract recurring failure patterns from task and brain history',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'limit',
        type: 'number' as const,
        required: false,
        description: 'Maximum number of patterns to return',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'intelligence',
    operation: 'confidence',
    description: 'Score verification confidence for a task based on current gate state',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      { name: 'taskId', type: 'string' as const, required: true, description: 'Task ID to score' },
    ],
  },
  {
    gateway: 'query',
    domain: 'intelligence',
    operation: 'match',
    description: 'Match known brain patterns against a task',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string' as const,
        required: true,
        description: 'Task ID to match patterns against',
      },
    ],
  },

  // ===========================================================================
  // DIAGNOSTICS domain (T624) — opt-in telemetry for self-improvement
  // ===========================================================================

  {
    gateway: 'query',
    domain: 'diagnostics',
    operation: 'status',
    description: 'diagnostics.status (query) — show telemetry opt-in state and DB path',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'query',
    domain: 'diagnostics',
    operation: 'analyze',
    description:
      'diagnostics.analyze (query) — aggregate telemetry patterns; surface failing/slow commands and generate BRAIN observations',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'days',
        type: 'number' as const,
        required: false,
        description: 'Analysis window in days (default: 30)',
        cli: { flag: 'days', short: '-d' },
      },
      {
        name: 'noBrain',
        type: 'boolean' as const,
        required: false,
        description: 'Skip pushing observations to BRAIN',
        cli: { flag: 'no-brain' },
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'diagnostics',
    operation: 'export',
    description: 'diagnostics.export (query) — JSON dump of all telemetry events',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'days',
        type: 'number' as const,
        required: false,
        description: 'Limit export to last N days (default: all)',
        cli: { flag: 'days', short: '-d' },
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'diagnostics',
    operation: 'enable',
    description:
      'diagnostics.enable (mutate) — opt in to anonymous command telemetry; generates stable anonymousId',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate',
    domain: 'diagnostics',
    operation: 'disable',
    description: 'diagnostics.disable (mutate) — opt out of telemetry collection',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },

  // ── docs (T797) ────────────────────────────────────────────────────────────

  {
    gateway: 'mutate',
    domain: 'docs',
    operation: 'add',
    description:
      'docs.add (mutate) — attach a local file or URL to a CLEO owner entity (task, session, observation)',
    tier: 1,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['ownerId'],
    params: [
      {
        name: 'ownerId',
        type: 'string' as const,
        required: true,
        description: 'Owner entity ID (e.g. T123, ses_*, O-abc)',
      },
      {
        name: 'file',
        type: 'string' as const,
        required: false,
        description: 'Path to local file to attach',
      },
      {
        name: 'url',
        type: 'string' as const,
        required: false,
        description: 'Remote URL to attach',
      },
      {
        name: 'desc',
        type: 'string' as const,
        required: false,
        description: 'Free-text description',
      },
      {
        name: 'labels',
        type: 'string' as const,
        required: false,
        description: 'Comma-separated labels',
      },
      {
        name: 'attachedBy',
        type: 'string' as const,
        required: false,
        description: 'Agent identity (defaults to "human")',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'docs',
    operation: 'list',
    description: 'docs.list (query) — list attachments associated with a CLEO owner entity',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'task',
        type: 'string' as const,
        required: false,
        description: 'Filter by task ID (e.g. T123)',
      },
      {
        name: 'session',
        type: 'string' as const,
        required: false,
        description: 'Filter by session ID (e.g. ses_*)',
      },
      {
        name: 'observation',
        type: 'string' as const,
        required: false,
        description: 'Filter by observation ID (e.g. O-abc)',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'docs',
    operation: 'fetch',
    description:
      'docs.fetch (query) — retrieve attachment bytes and metadata by attachment ID or SHA-256',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['attachmentRef'],
    params: [
      {
        name: 'attachmentRef',
        type: 'string' as const,
        required: true,
        description: 'Attachment ID (att_*) or SHA-256 hex',
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'docs',
    operation: 'remove',
    description:
      'docs.remove (mutate) — remove an attachment ref from an owner; purges blob when refCount reaches zero',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['attachmentRef', 'from'],
    params: [
      {
        name: 'attachmentRef',
        type: 'string' as const,
        required: true,
        description: 'Attachment ID (att_*) or SHA-256 hex',
      },
      {
        name: 'from',
        type: 'string' as const,
        required: true,
        description: 'Owner entity ID to remove the ref from',
      },
    ],
  },
  // ── docs.generate (T798) ─────────────────────────────────────────────────
  {
    gateway: 'query',
    domain: 'docs',
    operation: 'generate',
    description:
      'docs.generate (query) — generate llms.txt-format doc summarising all attachments on a CLEO entity',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['for'],
    params: [
      {
        name: 'for',
        type: 'string' as const,
        required: true,
        description: 'Target entity ID (e.g. T798, ses_*, O-abc)',
      },
      {
        name: 'attach',
        type: 'boolean' as const,
        required: false,
        description: 'Save the generated output as an llms-txt attachment on the target entity',
      },
    ],
  },
  // ── playbook.* HITL CLI surface (T935) ───────────────────────────────────
  {
    gateway: 'mutate',
    domain: 'playbook',
    operation: 'run',
    description:
      'playbook.run (mutate) — load a .cantbook by name and execute it via the playbook runtime state machine',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['name'],
    params: [
      {
        name: 'name',
        type: 'string' as const,
        required: true,
        description: 'Playbook name (looks up <name>.cantbook in the configured search path)',
        cli: { positional: true },
      },
      {
        name: 'context',
        type: 'string' as const,
        required: false,
        description: 'JSON object string seeding the initial run context (e.g. {"epicId":"T999"})',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'playbook',
    operation: 'status',
    description:
      'playbook.status (query) — return the current state of a playbook run from playbook_runs',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['runId'],
    params: [
      {
        name: 'runId',
        type: 'string' as const,
        required: true,
        description: 'Playbook run identifier (FK into playbook_runs.run_id)',
        cli: { positional: true },
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'playbook',
    operation: 'resume',
    description:
      'playbook.resume (mutate) — resume a paused playbook run once its HITL gate is approved',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['runId'],
    params: [
      {
        name: 'runId',
        type: 'string' as const,
        required: true,
        description: 'Playbook run identifier to resume',
        cli: { positional: true },
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'playbook',
    operation: 'list',
    description:
      'playbook.list (query) — enumerate playbook runs with optional status filter (active|completed|pending)',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'status',
        type: 'string' as const,
        required: false,
        description: 'Filter on status (active|running|pending|paused|completed|failed|cancelled)',
      },
      {
        name: 'epicId',
        type: 'string' as const,
        required: false,
        description: 'Filter runs by the epic they belong to',
      },
      {
        name: 'limit',
        type: 'number' as const,
        required: false,
        description: 'Maximum number of runs to return',
      },
      {
        name: 'offset',
        type: 'number' as const,
        required: false,
        description: 'Skip the first N runs (applied after limit)',
      },
    ],
  },
  // ── playbook.validate (T1261 PSYCHE E4) ──────────────────────────────────
  {
    gateway: 'query',
    domain: 'playbook',
    operation: 'validate',
    description:
      'playbook.validate (query) — parse and validate a .cantbook file without executing it; exit 0 on success, exit 70 on parse error',
    tier: 1,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'file',
        type: 'string' as const,
        required: false,
        description: 'Absolute or relative path to the .cantbook file',
        cli: { positional: true },
      },
      {
        name: 'name',
        type: 'string' as const,
        required: false,
        description: 'Playbook name (resolved through the standard search path)',
      },
    ],
  },
  // ── orchestrate.{approve,reject,pending} HITL gate decisions (T935) ──────
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'approve',
    description:
      'orchestrate.approve (mutate) — approve a pending playbook approval gate to unblock the run',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['resumeToken'],
    params: [
      {
        name: 'resumeToken',
        type: 'string' as const,
        required: true,
        description: 'HMAC-signed resume token returned when the gate was created',
        cli: { positional: true },
      },
      {
        name: 'reason',
        type: 'string' as const,
        required: false,
        description: 'Optional justification note recorded on the approval row',
      },
      {
        name: 'approver',
        type: 'string' as const,
        required: false,
        description: 'Identity of the approver (defaults to cli-user)',
      },
    ],
  },
  {
    gateway: 'mutate',
    domain: 'orchestrate',
    operation: 'reject',
    description:
      'orchestrate.reject (mutate) — reject a pending playbook approval gate with a mandatory reason',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: ['resumeToken', 'reason'],
    params: [
      {
        name: 'resumeToken',
        type: 'string' as const,
        required: true,
        description: 'HMAC-signed resume token returned when the gate was created',
        cli: { positional: true },
      },
      {
        name: 'reason',
        type: 'string' as const,
        required: true,
        description: 'Justification for the rejection (recorded on the audit row)',
      },
      {
        name: 'approver',
        type: 'string' as const,
        required: false,
        description: 'Identity of the rejector (defaults to cli-user)',
      },
    ],
  },
  {
    gateway: 'query',
    domain: 'orchestrate',
    operation: 'pending',
    description:
      'orchestrate.pending (query) — list all approval gates awaiting a decision across every run',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [],
  },
  {
    gateway: 'mutate' as const,
    domain: 'orchestrate',
    operation: 'worktree.complete',
    description:
      'orchestrate.worktree.complete (mutate) — cherry-pick commits from a task worktree back to main and clean up the worktree',
    tier: 2,
    idempotent: false,
    sessionRequired: false,
    requiredParams: ['taskId'],
    params: [
      {
        name: 'taskId',
        type: 'string' as const,
        required: true,
        description: 'Task ID whose worktree should be merged and cleaned up',
      },
    ],
  },
  {
    gateway: 'mutate' as const,
    domain: 'orchestrate',
    operation: 'worktree.cleanup',
    description:
      'orchestrate.worktree.cleanup (mutate) — prune orphaned agent worktrees (e.g. after agent crash or session end)',
    tier: 2,
    idempotent: true,
    sessionRequired: false,
    requiredParams: [],
    params: [
      {
        name: 'olderThanHours',
        type: 'number' as const,
        required: false,
        description: 'Remove worktrees idle for longer than this many hours (default: 24)',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Gateway Matrix Derivation
// ---------------------------------------------------------------------------

/**
 * Derive a gateway operation matrix from the registry.
 *
 * Returns `Record<string, string[]>` containing:
 * - All canonical domains with their operations
 *
 * This is the SINGLE derivation point — gateways use this instead of
 * maintaining independent operation lists.
 */
export function deriveGatewayMatrix(gateway: Gateway): Record<string, string[]> {
  const matrix: Record<string, string[]> = {};

  for (const op of OPERATIONS) {
    if (op.gateway !== gateway) continue;
    if (!matrix[op.domain]) matrix[op.domain] = [];
    matrix[op.domain].push(op.operation);
  }

  return matrix;
}

/**
 * Get all accepted domain names for a gateway (canonical only).
 */
export function getGatewayDomains(gateway: Gateway): string[] {
  return Object.keys(deriveGatewayMatrix(gateway));
}

// ---------------------------------------------------------------------------
// Lookup & Validation
// ---------------------------------------------------------------------------

/**
 * Resolves a domain + operation to its registered definition.
 */
export function resolve(
  gateway: Gateway,
  domain: string,
  operation: string,
): Resolution | undefined {
  const def = OPERATIONS.find(
    (o) => o.gateway === gateway && o.domain === domain && o.operation === operation,
  );

  if (!def) return undefined;

  return { domain: def.domain, operation: def.operation, def };
}

/**
 * Validates that all required parameters are present in the request.
 * Returns an array of missing parameter keys.
 */
export function validateRequiredParams(
  def: OperationDef,
  params?: Record<string, unknown>,
): string[] {
  if (!def.requiredParams || def.requiredParams.length === 0) return [];
  const provided = params || {};
  return def.requiredParams.filter(
    (key) => provided[key] === undefined || provided[key] === null || provided[key] === '',
  );
}

/** Get all operations for a specific canonical domain. */
export function getByDomain(domain: CanonicalDomain): OperationDef[] {
  return OPERATIONS.filter((o) => o.domain === domain);
}

/** Get all operations for a specific gateway. */
export function getByGateway(gateway: Gateway): OperationDef[] {
  return OPERATIONS.filter((o) => o.gateway === gateway);
}

/** Get all operations available at or below a specific tier. */
export function getByTier(tier: Tier): OperationDef[] {
  return OPERATIONS.filter((o) => o.tier <= tier);
}

/** Get a list of canonical domains that actually have operations registered. */
export function getActiveDomains(): CanonicalDomain[] {
  const active = new Set(OPERATIONS.map((o) => o.domain));
  return Array.from(active);
}

/**
 * Returns summary counts of operations for module validation.
 */
export function getCounts(): { query: number; mutate: number; total: number } {
  return {
    query: OPERATIONS.filter((o) => o.gateway === 'query').length,
    mutate: OPERATIONS.filter((o) => o.gateway === 'mutate').length,
    total: OPERATIONS.length,
  };
}

// Module load validation (dynamic, no hardcoded operation totals)
const counts = getCounts();
if (counts.total !== OPERATIONS.length) {
  console.warn(
    `[Registry] Operation count mismatch: total=${counts.total}, registry=${OPERATIONS.length}`,
  );
}
