/**
 * Process Detection Processor — Phase 6
 *
 * Detects execution flows (Processes) in the code graph by:
 * 1. Scoring candidate entry points by call ratio, export status, and name patterns
 * 2. Tracing forward via CALLS edges using BFS (max depth 10, max branching 4)
 * 3. Deduplicating traces (subset removal + longest-path-per-endpoint-pair)
 * 4. Creating Process nodes and STEP_IN_PROCESS edges in the KnowledgeGraph
 *
 * Ported and adapted from GitNexus
 * `src/core/ingestion/process-processor.ts`.
 *
 * @task T538
 * @module pipeline/process-processor
 */

import type { CommunityMembership } from './community-processor.js';
import { calculateEntryPointScore, isTestFile } from './entry-point-scoring.js';
import type { KnowledgeGraph } from './knowledge-graph.js';

// ============================================================================
// TYPES
// ============================================================================

/** An execution flow detected from a single BFS trace. */
export interface ProcessInfo {
  /** Stable ID, format: `proc_<idx>_<sanitised-entry-name>`. */
  id: string;
  /** Human-readable label: "EntryName → TerminalName". */
  heuristicLabel: string;
  /** Whether the trace crosses multiple communities. */
  processType: 'intra_community' | 'cross_community';
  /** Number of steps (nodes) in the trace. */
  stepCount: number;
  /** Community IDs traversed by this trace. */
  communities: string[];
  /** Node ID of the first step (entry point). */
  entryPointId: string;
  /** Node ID of the last step (terminal). */
  terminalId: string;
  /** Ordered list of node IDs forming the execution trace. */
  trace: string[];
}

/** A step assignment linking a node to a process at a given position. */
export interface ProcessStep {
  /** Node ID participating in the process. */
  nodeId: string;
  /** Process ID this step belongs to. */
  processId: string;
  /** 1-indexed position in the trace. */
  step: number;
}

/** Result returned by `detectProcesses`. */
export interface ProcessDetectionResult {
  /** All detected execution flows. */
  processes: ProcessInfo[];
  /** One entry per (node, process) pair. */
  steps: ProcessStep[];
  stats: {
    totalProcesses: number;
    crossCommunityCount: number;
    avgStepCount: number;
    entryPointsFound: number;
  };
}

/** Configuration for process detection tuning. */
export interface ProcessDetectionConfig {
  /** Maximum BFS depth per trace (default 10). */
  maxTraceDepth: number;
  /** Maximum outgoing branches to follow per node (default 4). */
  maxBranching: number;
  /** Maximum number of processes to retain (default 75). */
  maxProcesses: number;
  /** Minimum steps for a trace to be considered a valid process (default 3). */
  minSteps: number;
}

// ============================================================================
// DEFAULTS
// ============================================================================

const DEFAULT_CONFIG: ProcessDetectionConfig = {
  maxTraceDepth: 10,
  maxBranching: 4,
  maxProcesses: 75,
  minSteps: 3, // 3+ steps = genuine multi-hop flow; 2 steps is just "A calls B"
};

// ============================================================================
// ADJACENCY HELPERS
// ============================================================================

type AdjacencyList = Map<string, string[]>;

/** Minimum confidence for CALLS edges used in process tracing. */
const MIN_TRACE_CONFIDENCE = 0.5;

/** Build a forward CALLS adjacency list from the graph. */
function buildCallsGraph(kg: KnowledgeGraph): AdjacencyList {
  const adj: AdjacencyList = new Map();
  for (const rel of kg.relations) {
    if (rel.type !== 'calls' || rel.confidence < MIN_TRACE_CONFIDENCE) continue;
    if (!adj.has(rel.source)) adj.set(rel.source, []);
    adj.get(rel.source)!.push(rel.target);
  }
  return adj;
}

/** Build a reverse CALLS adjacency list (who calls whom). */
function buildReverseCallsGraph(kg: KnowledgeGraph): AdjacencyList {
  const adj: AdjacencyList = new Map();
  for (const rel of kg.relations) {
    if (rel.type !== 'calls' || rel.confidence < MIN_TRACE_CONFIDENCE) continue;
    if (!adj.has(rel.target)) adj.set(rel.target, []);
    adj.get(rel.target)!.push(rel.source);
  }
  return adj;
}

// ============================================================================
// ENTRY POINT DETECTION
// ============================================================================

/**
 * Find and rank entry point candidates in the knowledge graph.
 *
 * Only Function and Method nodes are considered. Test files are excluded.
 * Returns up to 200 node IDs ranked by descending entry-point score.
 */
function findEntryPoints(
  kg: KnowledgeGraph,
  reverseCallsEdges: AdjacencyList,
  callsEdges: AdjacencyList,
): string[] {
  const CALLABLE_KINDS = new Set(['function', 'method']);
  const candidates: { id: string; score: number }[] = [];

  for (const node of kg.nodes.values()) {
    if (!CALLABLE_KINDS.has(node.kind)) continue;

    const filePath = node.filePath ?? '';
    if (isTestFile(filePath)) continue;

    const callers = reverseCallsEdges.get(node.id) ?? [];
    const callees = callsEdges.get(node.id) ?? [];

    // Must call at least one other node to be traceable
    if (callees.length === 0) continue;

    const { score } = calculateEntryPointScore(
      node.name,
      node.exported ?? false,
      callers.length,
      callees.length,
    );

    if (score > 0) {
      candidates.push({ id: node.id, score });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 200)
    .map((c) => c.id);
}

// ============================================================================
// BFS TRACE
// ============================================================================

/**
 * Trace forward from a single entry point using BFS.
 *
 * Returns all distinct paths from the entry node up to `config.maxTraceDepth`
 * steps, following at most `config.maxBranching` outgoing edges per node.
 * Cycles are avoided by checking whether a node already appears in the path.
 */
function traceFromEntryPoint(
  entryId: string,
  callsEdges: AdjacencyList,
  config: ProcessDetectionConfig,
): string[][] {
  const traces: string[][] = [];

  // BFS queue: each entry is [currentNodeId, pathSoFar]
  const queue: [string, string[]][] = [[entryId, [entryId]]];

  while (queue.length > 0 && traces.length < config.maxBranching * 3) {
    const item = queue.shift();
    if (!item) break;
    const [currentId, path] = item;

    const callees = callsEdges.get(currentId) ?? [];

    if (callees.length === 0) {
      // Terminal node — record if long enough
      if (path.length >= config.minSteps) {
        traces.push([...path]);
      }
    } else if (path.length >= config.maxTraceDepth) {
      // Depth limit reached — save what we have
      if (path.length >= config.minSteps) {
        traces.push([...path]);
      }
    } else {
      const limited = callees.slice(0, config.maxBranching);
      let addedBranch = false;

      for (const calleeId of limited) {
        if (!path.includes(calleeId)) {
          queue.push([calleeId, [...path, calleeId]]);
          addedBranch = true;
        }
      }

      // All branches were cycles — save the current path as terminal
      if (!addedBranch && path.length >= config.minSteps) {
        traces.push([...path]);
      }
    }
  }

  return traces;
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

/**
 * Remove traces that are full subsequences of another (longer) trace.
 * Sorts by descending length, then skips any trace whose join string is a
 * substring of an already-accepted trace's join string.
 */
function deduplicateTraces(traces: string[][]): string[][] {
  if (traces.length === 0) return [];

  const sorted = [...traces].sort((a, b) => b.length - a.length);
  const unique: string[][] = [];

  for (const trace of sorted) {
    const traceKey = trace.join('->');
    const isSubset = unique.some((existing) => existing.join('->').includes(traceKey));
    if (!isSubset) unique.push(trace);
  }

  return unique;
}

/**
 * Keep only the longest trace per unique (entry → terminal) pair.
 * Multiple paths between the same two endpoints are redundant for agents.
 */
function deduplicateByEndpoints(traces: string[][]): string[][] {
  if (traces.length === 0) return [];

  const byEndpoints = new Map<string, string[]>();
  const sorted = [...traces].sort((a, b) => b.length - a.length);

  for (const trace of sorted) {
    const key = `${trace[0]}::${trace[trace.length - 1]}`;
    if (!byEndpoints.has(key)) byEndpoints.set(key, trace);
  }

  return Array.from(byEndpoints.values());
}

// ============================================================================
// STRING UTILITIES
// ============================================================================

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sanitizeId(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]/g, '_')
    .substring(0, 20)
    .toLowerCase();
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Detect execution flows (processes) in the knowledge graph.
 *
 * This runs AFTER community detection so that community membership can be
 * used to classify traces as intra- or cross-community. Writes Process nodes
 * and STEP_IN_PROCESS edges directly into `graph`.
 *
 * Handles empty graphs gracefully — returns empty results when no CALLS edges
 * are present.
 *
 * @param graph - The in-memory KnowledgeGraph (mutated in-place)
 * @param memberships - Community memberships from Phase 5 (may be empty)
 * @param config - Optional override for detection parameters
 * @returns Detection result with process nodes, steps, and stats
 */
export async function detectProcesses(
  graph: KnowledgeGraph,
  memberships: CommunityMembership[],
  config: Partial<ProcessDetectionConfig> = {},
): Promise<ProcessDetectionResult> {
  const cfg: ProcessDetectionConfig = { ...DEFAULT_CONFIG, ...config };

  // Build membership lookup map for fast community resolution
  const membershipMap = new Map<string, string>();
  for (const m of memberships) membershipMap.set(m.nodeId, m.communityId);

  const callsEdges = buildCallsGraph(graph);
  const reverseCallsEdges = buildReverseCallsGraph(graph);

  // Phase 6 Step 1: Identify entry points
  const entryPoints = findEntryPoints(graph, reverseCallsEdges, callsEdges);

  process.stderr.write(
    `[nexus] Phase 6: Found ${entryPoints.length} entry point candidates, tracing flows...\n`,
  );

  if (entryPoints.length === 0) {
    process.stderr.write('[nexus] Phase 6: No entry points found — skipping process detection\n');
    return {
      processes: [],
      steps: [],
      stats: { totalProcesses: 0, crossCommunityCount: 0, avgStepCount: 0, entryPointsFound: 0 },
    };
  }

  // Phase 6 Step 2: BFS trace from each entry point
  const allTraces: string[][] = [];

  for (let i = 0; i < entryPoints.length && allTraces.length < cfg.maxProcesses * 2; i++) {
    const entryId = entryPoints[i];
    const traces = traceFromEntryPoint(entryId, callsEdges, cfg);
    for (const t of traces) {
      if (t.length >= cfg.minSteps) allTraces.push(t);
    }
  }

  process.stderr.write(`[nexus] Phase 6: ${allTraces.length} raw traces, deduplicating...\n`);

  // Phase 6 Step 3: Deduplicate
  const unique = deduplicateTraces(allTraces);
  const endpointDeduped = deduplicateByEndpoints(unique);

  process.stderr.write(
    `[nexus] Phase 6: ${endpointDeduped.length} unique endpoint pairs after dedup\n`,
  );

  // Phase 6 Step 4: Limit to maxProcesses (prefer longer traces)
  const limitedTraces = endpointDeduped
    .sort((a, b) => b.length - a.length)
    .slice(0, cfg.maxProcesses);

  // Phase 6 Step 5: Create Process nodes and steps
  const processes: ProcessInfo[] = [];
  const steps: ProcessStep[] = [];

  for (let idx = 0; idx < limitedTraces.length; idx++) {
    const trace = limitedTraces[idx];
    const entryPointId = trace[0];
    const terminalId = trace[trace.length - 1];

    // Collect communities touched by this trace
    const commSet = new Set<string>();
    for (const nodeId of trace) {
      const comm = membershipMap.get(nodeId);
      if (comm) commSet.add(comm);
    }
    const communities = Array.from(commSet);

    const processType: 'intra_community' | 'cross_community' =
      communities.length > 1 ? 'cross_community' : 'intra_community';

    const entryNode = graph.nodes.get(entryPointId);
    const terminalNode = graph.nodes.get(terminalId);
    const entryName = entryNode?.name ?? 'Unknown';
    const terminalName = terminalNode?.name ?? 'Unknown';
    const heuristicLabel = `${capitalize(entryName)} → ${capitalize(terminalName)}`;

    const processId = `proc_${idx}_${sanitizeId(entryName)}`;

    processes.push({
      id: processId,
      heuristicLabel,
      processType,
      stepCount: trace.length,
      communities,
      entryPointId,
      terminalId,
      trace,
    });

    // Step records
    for (let stepIdx = 0; stepIdx < trace.length; stepIdx++) {
      steps.push({
        nodeId: trace[stepIdx],
        processId,
        step: stepIdx + 1, // 1-indexed
      });
    }
  }

  // Write Process nodes into the KnowledgeGraph
  for (const proc of processes) {
    graph.addNode({
      id: proc.id,
      kind: 'process',
      name: proc.heuristicLabel,
      filePath: '',
      startLine: 0,
      endLine: 0,
      language: '',
      exported: false,
      meta: {
        processType: proc.processType,
        stepCount: proc.stepCount,
        communities: proc.communities,
        entryPointId: proc.entryPointId,
        terminalId: proc.terminalId,
      },
    });
  }

  // Write STEP_IN_PROCESS edges and ENTRY_POINT_OF edge
  for (const step of steps) {
    graph.addRelation({
      source: step.nodeId,
      target: step.processId,
      type: 'step_in_process',
      confidence: 1.0,
      reason: `step:${step.step}`,
    });
  }

  // Write ENTRY_POINT_OF edges (entry point node → process node)
  for (const proc of processes) {
    graph.addRelation({
      source: proc.entryPointId,
      target: proc.id,
      type: 'entry_point_of',
      confidence: 1.0,
      reason: 'bfs-entry-point',
    });
  }

  // Update processIds on participating graph nodes
  for (const step of steps) {
    const node = graph.nodes.get(step.nodeId);
    if (node) {
      if (!node.processIds) node.processIds = [];
      if (!node.processIds.includes(step.processId)) {
        node.processIds.push(step.processId);
      }
    }
  }

  const crossCommunityCount = processes.filter((p) => p.processType === 'cross_community').length;
  const avgStepCount =
    processes.length > 0
      ? processes.reduce((sum, p) => sum + p.stepCount, 0) / processes.length
      : 0;

  return {
    processes,
    steps,
    stats: {
      totalProcesses: processes.length,
      crossCommunityCount,
      avgStepCount: Math.round(avgStepCount * 10) / 10,
      entryPointsFound: entryPoints.length,
    },
  };
}
