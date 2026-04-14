/**
 * Call processor — Phase 3e of the code intelligence ingestion pipeline.
 *
 * Resolves pre-extracted call expressions to CALLS graph edges using a
 * two-tier lookup strategy:
 *
 * - **Tier 1** (same-file, confidence 0.95): The callee is defined in the
 *   same file as the call site. Uses `symbolTable.lookupExact` for O(1)
 *   resolution.
 *
 * - **Tier 2a** (named-import, confidence 0.90): The callee is imported by
 *   name from another file. Walks the namedImportMap populated during the
 *   import processing phase. Handles aliased imports (`import { X as Y }`).
 *
 * - **Tier 3** (global fallback, confidence 0.50): Unambiguous global lookup
 *   across all registered callables. Skipped when multiple candidates exist
 *   (ambiguous match) — silence is better than a wrong edge.
 *
 * Additionally emits structural class-member edges:
 * - **HAS_METHOD** — class node → method node (for all extracted method definitions)
 * - **HAS_PROPERTY** — class node → property node (for all extracted property definitions)
 *
 * Virtual-dispatch / MRO resolution and Tier 2b (package-scoped) resolution
 * are deferred to future waves.
 *
 * Ported and simplified from GitNexus
 * `src/core/ingestion/call-processor.ts` (processCallsFromExtracted, Tier 1 + 2a path).
 *
 * @task T536
 * @module pipeline/call-processor
 */

import type { GraphRelation } from '@cleocode/contracts';
import type { ExtractedCall } from './extractors/typescript-extractor.js';
import type { BarrelExportMap, NamedImportMap } from './import-processor.js';
import { resolveBarrelBinding } from './import-processor.js';
import type { KnowledgeGraph } from './knowledge-graph.js';
import { TIER_CONFIDENCE } from './resolution-context.js';
import type { SymbolTable } from './symbol-table.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result counters from a call resolution run.
 */
export interface CallResolutionResult {
  /** CALLS edges emitted at Tier 1 (same-file confidence 0.95). */
  tier1Count: number;
  /** CALLS edges emitted at Tier 2a (named-import confidence 0.90). */
  tier2aCount: number;
  /** CALLS edges emitted at Tier 3 (global fallback confidence 0.50). */
  tier3Count: number;
  /** Call sites that could not be resolved at any tier. */
  unresolvedCount: number;
  /** HAS_METHOD edges emitted. */
  hasMethodCount: number;
  /** HAS_PROPERTY edges emitted. */
  hasPropertyCount: number;
}

// ---------------------------------------------------------------------------
// HAS_METHOD and HAS_PROPERTY edges
// ---------------------------------------------------------------------------

/**
 * Emit HAS_METHOD and HAS_PROPERTY edges for all class-member nodes in the graph.
 *
 * These structural edges link each class node to its method and property nodes
 * using the `parent` field already set during definition extraction. They are
 * emitted here rather than in the parse loop so that all class nodes are
 * guaranteed to exist in the graph before member edges reference them.
 *
 * @param graph - KnowledgeGraph containing all extracted nodes
 * @returns Counts of HAS_METHOD and HAS_PROPERTY edges emitted
 */
export function emitClassMemberEdges(graph: KnowledgeGraph): {
  hasMethodCount: number;
  hasPropertyCount: number;
} {
  let hasMethodCount = 0;
  let hasPropertyCount = 0;

  for (const node of graph.nodes.values()) {
    if (!node.parent) continue;

    if (node.kind === 'method' || node.kind === 'constructor') {
      const rel: GraphRelation = {
        source: node.parent,
        target: node.id,
        type: 'has_method',
        confidence: 0.99,
        reason: `method definition in ${node.filePath}`,
      };
      graph.addRelation(rel);
      hasMethodCount++;
    } else if (node.kind === 'property') {
      const rel: GraphRelation = {
        source: node.parent,
        target: node.id,
        type: 'has_property',
        confidence: 0.99,
        reason: `property definition in ${node.filePath}`,
      };
      graph.addRelation(rel);
      hasPropertyCount++;
    }
  }

  return { hasMethodCount, hasPropertyCount };
}

// ---------------------------------------------------------------------------
// Core tiered call resolution
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve a single call expression to a target node ID.
 *
 * Resolution order:
 * 1. Tier 1 — same-file exact lookup (`symbolTable.lookupExact`)
 * 2. Tier 2a — named import binding (`namedImportMap` → `symbolTable.lookupExact`)
 *    2a-barrel — barrel chain tracing: if binding.sourcePath is a barrel, follow
 *                the BarrelExportMap to find the canonical definition (T617)
 * 3. Tier 3 — global callable index (`symbolTable.lookupCallableByName`),
 *             only when exactly one candidate is found
 *
 * Returns `null` when no tier resolves the name.
 */
function resolveSingleCall(
  call: ExtractedCall,
  symbolTable: SymbolTable,
  namedImportMap: NamedImportMap,
  barrelMap: BarrelExportMap,
): { nodeId: string; confidence: number; tier: 'same-file' | 'import-scoped' | 'global' } | null {
  const { filePath, calledName, argCount } = call;

  // ── Tier 1: same-file ─────────────────────────────────────────────────────
  const tier1Id = symbolTable.lookupExact(filePath, calledName);
  if (tier1Id) {
    return { nodeId: tier1Id, confidence: TIER_CONFIDENCE['same-file'], tier: 'same-file' };
  }

  // ── Tier 2a: named import binding ─────────────────────────────────────────
  const fileBindings = namedImportMap.get(filePath);
  if (fileBindings) {
    const binding = fileBindings.get(calledName);
    if (binding) {
      // Direct lookup: symbol defined in the imported file
      const tier2Id = symbolTable.lookupExact(binding.sourcePath, binding.exportedName);
      if (tier2Id) {
        return {
          nodeId: tier2Id,
          confidence: TIER_CONFIDENCE['import-scoped'],
          tier: 'import-scoped',
        };
      }

      // Barrel tracing (T617): the imported file is a barrel that re-exports the
      // symbol from a deeper source file. Follow the chain to find the canonical
      // definition.
      if (barrelMap.has(binding.sourcePath)) {
        const canonical = resolveBarrelBinding(
          binding.sourcePath,
          binding.exportedName,
          barrelMap,
        );
        if (canonical) {
          const barrelResolvedId = symbolTable.lookupExact(
            canonical.canonicalFile,
            canonical.canonicalName,
          );
          if (barrelResolvedId) {
            return {
              nodeId: barrelResolvedId,
              confidence: TIER_CONFIDENCE['import-scoped'],
              tier: 'import-scoped',
            };
          }
        }
      }
    }
  }

  // ── Tier 3: global callable fallback ─────────────────────────────────────
  // Only emit when exactly one candidate — ambiguous matches are skipped to
  // avoid emitting false CALLS edges for common names (e.g. `get`, `set`).
  const tier3Candidates = symbolTable.lookupCallableByName(calledName);

  if (tier3Candidates.length === 1) {
    const candidate = tier3Candidates[0];

    // Arity filter: skip if argument count clearly does not match
    if (argCount !== undefined && candidate.parameterCount !== undefined) {
      const min = candidate.requiredParameterCount ?? candidate.parameterCount;
      if (argCount < min || argCount > candidate.parameterCount) {
        return null;
      }
    }

    return {
      nodeId: candidate.nodeId,
      confidence: TIER_CONFIDENCE.global,
      tier: 'global',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main call resolution entry point
// ---------------------------------------------------------------------------

/**
 * Resolve all extracted call expressions and emit CALLS edges into the graph.
 *
 * This should be called **after all files are parsed** (so the SymbolTable
 * and NamedImportMap are fully populated) and **after heritage processing**
 * (the HeritageMap is available for future virtual-dispatch, though not used
 * in Tier 1 + 2a).
 *
 * Processing is grouped per-file for cache efficiency, consistent with
 * GitNexus `processCallsFromExtracted`.
 *
 * @param calls - All call expression records accumulated during the parse loop
 * @param graph - KnowledgeGraph to write CALLS edges into
 * @param symbolTable - Fully-populated SymbolTable (all files parsed)
 * @param namedImportMap - Named import bindings from the import processing phase
 * @param barrelMap - Barrel export chain map for Tier 2a barrel tracing (T617)
 * @returns Resolution counters
 */
export async function resolveCalls(
  calls: ExtractedCall[],
  graph: KnowledgeGraph,
  symbolTable: SymbolTable,
  namedImportMap: NamedImportMap,
  barrelMap: BarrelExportMap = new Map(),
): Promise<CallResolutionResult> {
  let tier1Count = 0;
  let tier2aCount = 0;
  let tier3Count = 0;
  let unresolvedCount = 0;

  // Group calls by file for cache efficiency
  const byFile = new Map<string, ExtractedCall[]>();
  for (const call of calls) {
    let list = byFile.get(call.filePath);
    if (!list) {
      list = [];
      byFile.set(call.filePath, list);
    }
    list.push(call);
  }

  let filesProcessed = 0;

  for (const [, fileCalls] of byFile) {
    filesProcessed++;

    // Yield to event loop periodically on large repos (mirrors parse-loop pattern)
    if (filesProcessed % 100 === 0) {
      await Promise.resolve();
    }

    for (const call of fileCalls) {
      const resolved = resolveSingleCall(call, symbolTable, namedImportMap, barrelMap);

      if (!resolved) {
        unresolvedCount++;
        continue;
      }

      const rel: GraphRelation = {
        source: call.sourceId,
        target: resolved.nodeId,
        type: 'calls',
        confidence: resolved.confidence,
        reason: `${call.callForm} call to ${call.calledName} (tier: ${resolved.tier})`,
      };

      graph.addRelation(rel);

      if (resolved.tier === 'same-file') {
        tier1Count++;
      } else if (resolved.tier === 'import-scoped') {
        tier2aCount++;
      } else {
        tier3Count++;
      }
    }
  }

  // Emit HAS_METHOD and HAS_PROPERTY structural edges
  const { hasMethodCount, hasPropertyCount } = emitClassMemberEdges(graph);

  return {
    tier1Count,
    tier2aCount,
    tier3Count,
    unresolvedCount,
    hasMethodCount,
    hasPropertyCount,
  };
}
