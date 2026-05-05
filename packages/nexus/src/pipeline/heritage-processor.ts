/**
 * Heritage processor — Phase 3c of the code intelligence ingestion pipeline.
 *
 * Converts accumulated {@link ExtractedHeritage} records into EXTENDS and
 * IMPLEMENTS graph edges and builds the {@link HeritageMap} index for use
 * by the downstream call resolution phase.
 *
 * Key design decisions (compared to GitNexus):
 *
 * - TypeScript-only — language-specific edge disambiguation (C#/Java
 *   `base_list`, Rust `trait-impl`) is deferred to future language providers.
 * - No tree-sitter re-parsing — all heritage data was already extracted by
 *   the TypeScript extractor during the parse loop (Phase 3).
 * - `extends` clauses → EXTENDS edges; `implements` clauses → IMPLEMENTS edges.
 * - Confident resolution via ResolutionContext when the parent type is found
 *   in the SymbolTable; falls back to a synthetic `__heritage__<name>` stub
 *   node ID when the type is external/unresolved (avoids silent misses while
 *   keeping the graph consistent).
 * - IMPLEMENTS edges also index the implementor file in the HeritageMap so
 *   that call resolution can look up dispatch targets without re-scanning edges.
 *
 * Ported and heavily simplified from GitNexus
 * `src/core/ingestion/heritage-processor.ts` (processHeritageFromExtracted)
 * and `src/core/ingestion/heritage-map.ts`.
 *
 * @task T536
 * @module pipeline/heritage-processor
 */

import type { GraphRelation } from '@cleocode/contracts';
import { confidenceLabelFromNumeric } from '@cleocode/contracts';
import type { ExtractedHeritage } from './extractors/typescript-extractor.js';
import type { KnowledgeGraph } from './knowledge-graph.js';
import type { ResolutionContext } from './resolution-context.js';
import { TIER_CONFIDENCE } from './resolution-context.js';

// ---------------------------------------------------------------------------
// HeritageMap
// ---------------------------------------------------------------------------

/** Maximum ancestor-chain depth for cycle-safe BFS traversal. */
const MAX_ANCESTOR_DEPTH = 32;

/**
 * Unified inheritance index built from all EXTENDS / IMPLEMENTS relationships
 * extracted during the parse loop.
 *
 * Provides two lookups used by call resolution:
 * - `getParents` — direct parents of a child node (by nodeId)
 * - `getImplementorFiles` — file paths of classes that implement an interface
 *   (keyed by interface name, for interface-dispatch resolution)
 *
 * Ported from GitNexus `src/core/ingestion/heritage-map.ts`.
 */
export interface HeritageMap {
  /**
   * Return the direct parent nodeIds for the given child nodeId.
   * Returns an empty array when no parents are known.
   */
  getParents(childNodeId: string): string[];

  /**
   * Return all ancestor nodeIds (BFS, bounded to {@link MAX_ANCESTOR_DEPTH}
   * levels, cycle-safe). Includes direct parents and transitive ancestors.
   */
  getAncestors(childNodeId: string): string[];

  /**
   * Return the file paths of classes that directly implement or extend-as-interface
   * the given interface / abstract class name.
   *
   * Keyed by the unqualified type name (e.g. `'IRepository'`). When two
   * interfaces share the same unqualified name in different packages, their
   * implementors are merged under one key — this is a known limitation that
   * matches GitNexus behaviour.
   */
  getImplementorFiles(interfaceName: string): ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Shared empty set returned when no implementors are found. */
const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Derive a synthetic stub node ID for unresolvable parent types.
 *
 * This keeps EXTENDS/IMPLEMENTS edges pointing at something unique-and-stable
 * without fabricating a real graph node. The prefix `__heritage__` makes stubs
 * easy to filter in downstream consumers that only want resolved edges.
 */
function stubId(name: string): string {
  return `__heritage__${name}`;
}

/**
 * Resolve a parent type name to a concrete node ID and confidence score.
 *
 * Resolution order:
 * 1. `ctx.resolve()` (Tier 1 → 2a → 3 via ResolutionContext)
 * 2. Stub ID at Tier 3 confidence (0.50) for external/unresolvable types
 *
 * When Tier 3 returns multiple candidates the result is ambiguous — the stub
 * is used instead of an arbitrary pick to avoid false edges.
 */
function resolveParentId(
  parentName: string,
  fromFile: string,
  ctx: ResolutionContext,
): { id: string; confidence: number } {
  const resolved = ctx.resolve(parentName, fromFile);

  if (resolved && resolved.candidates.length > 0) {
    // Tier 3 with multiple candidates is ambiguous — use stub rather than guess
    if (resolved.tier === 'global' && resolved.candidates.length > 1) {
      return { id: stubId(parentName), confidence: TIER_CONFIDENCE.global };
    }
    return {
      id: resolved.candidates[0].nodeId,
      confidence: TIER_CONFIDENCE[resolved.tier],
    };
  }

  // Unresolved — external type; use stub at global-tier confidence
  return { id: stubId(parentName), confidence: TIER_CONFIDENCE.global };
}

/**
 * Resolve a child type name (the declaring class/interface) to a node ID.
 *
 * For the child type we prefer exact same-file lookup because the declaring
 * class MUST be in the current file — if it is not in the SymbolTable that
 * means extraction failed for this file, so we skip the record.
 */
function resolveChildId(typeName: string, fromFile: string, ctx: ResolutionContext): string | null {
  const nodeId = ctx.symbols.lookupExact(fromFile, typeName);
  return nodeId ?? null;
}

// ---------------------------------------------------------------------------
// HeritageMap builder
// ---------------------------------------------------------------------------

/**
 * Build a {@link HeritageMap} from accumulated {@link ExtractedHeritage} records.
 *
 * This is a pure in-memory index build — it does NOT add edges to the graph.
 * Graph edges are written by {@link processHeritage}.
 *
 * Resolution uses `ctx.symbols.lookupClassByName` (like GitNexus) for parent
 * lookup so that cross-file types are found even before import resolution is
 * complete. Unresolvable parents are silently skipped (a missing parent is
 * better than a wrong edge in the heritage index).
 *
 * @param heritage - All heritage records accumulated during the parse loop
 * @param ctx - Populated ResolutionContext (after all symbols are registered)
 * @returns A read-only HeritageMap for use by call resolution
 */
export function buildHeritageMap(
  heritage: readonly ExtractedHeritage[],
  ctx: ResolutionContext,
): HeritageMap {
  // childNodeId → Set<parentNodeId>
  const directParents = new Map<string, Set<string>>();

  // interfaceName → Set<filePath>
  const implementorFiles = new Map<string, Set<string>>();

  for (const h of heritage) {
    // ── Parent lookup (nodeId-based index) ─────────────────────────────────
    const childDefs = ctx.symbols.lookupClassByName(h.typeName);
    const parentDefs = ctx.symbols.lookupClassByName(h.parentName);

    if (childDefs.length > 0 && parentDefs.length > 0) {
      for (const child of childDefs) {
        for (const parent of parentDefs) {
          // Skip self-references (can happen with generics like `class Foo extends Foo<T>`)
          if (child.nodeId === parent.nodeId) continue;

          let parents = directParents.get(child.nodeId);
          if (!parents) {
            parents = new Set();
            directParents.set(child.nodeId, parents);
          }
          parents.add(parent.nodeId);
        }
      }
    }

    // ── Implementor index (name-based, for interface dispatch) ──────────────
    // For TypeScript: `implements` clauses always map to interface dispatch.
    // `extends` clauses on classes are inheritance — not tracked here.
    // `extends` clauses on interfaces also represent interface dispatch targets.
    if (h.kind === 'implements') {
      let files = implementorFiles.get(h.parentName);
      if (!files) {
        files = new Set();
        implementorFiles.set(h.parentName, files);
      }
      files.add(h.filePath);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function getParents(childNodeId: string): string[] {
    const parents = directParents.get(childNodeId);
    return parents ? [...parents] : [];
  }

  function getAncestors(childNodeId: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    visited.add(childNodeId);

    let frontier = getParents(childNodeId);
    let depth = 0;

    while (frontier.length > 0 && depth < MAX_ANCESTOR_DEPTH) {
      const nextFrontier: string[] = [];
      for (const parentId of frontier) {
        if (visited.has(parentId)) continue;
        visited.add(parentId);
        result.push(parentId);
        const grandparents = directParents.get(parentId);
        if (grandparents) {
          for (const gp of grandparents) {
            if (!visited.has(gp)) nextFrontier.push(gp);
          }
        }
      }
      frontier = nextFrontier;
      depth++;
    }

    return result;
  }

  function getImplementorFiles(interfaceName: string): ReadonlySet<string> {
    return implementorFiles.get(interfaceName) ?? EMPTY_SET;
  }

  return { getParents, getAncestors, getImplementorFiles };
}

// ---------------------------------------------------------------------------
// Graph edge emission
// ---------------------------------------------------------------------------

/**
 * Result counters from a heritage processing run.
 */
export interface HeritageProcessingResult {
  /** Number of EXTENDS edges emitted. */
  extendsCount: number;
  /** Number of IMPLEMENTS edges emitted. */
  implementsCount: number;
  /** Number of records skipped (unresolvable child or self-reference). */
  skippedCount: number;
}

/**
 * Process accumulated heritage records and emit EXTENDS / IMPLEMENTS edges
 * into the KnowledgeGraph.
 *
 * This function should be called **after all files have been parsed** and
 * their symbols registered in the ResolutionContext, so that cross-file
 * parent types can be resolved.
 *
 * Edge confidence uses geometric-mean of child and parent confidence scores,
 * consistent with GitNexus convention.
 *
 * @param heritage - All heritage records accumulated during the parse loop
 * @param graph - KnowledgeGraph to write EXTENDS / IMPLEMENTS edges into
 * @param ctx - Fully-populated ResolutionContext (Tier 1 + 2a + 3 available)
 * @returns Counters for emitted and skipped edges
 */
export function processHeritage(
  heritage: ExtractedHeritage[],
  graph: KnowledgeGraph,
  ctx: ResolutionContext,
): HeritageProcessingResult {
  let extendsCount = 0;
  let implementsCount = 0;
  let skippedCount = 0;

  for (const h of heritage) {
    // Resolve child — MUST be in the current file
    const childId = resolveChildId(h.typeName, h.filePath, ctx);
    if (!childId) {
      // Child type not found in SymbolTable — extraction must have failed for this file
      skippedCount++;
      continue;
    }

    // Resolve parent via tiered lookup
    const { id: parentId, confidence: parentConf } = resolveParentId(h.parentName, h.filePath, ctx);

    // Child confidence is 0.95 (same-file lookup — we know it's there)
    const childConf = TIER_CONFIDENCE['same-file'];

    // Skip self-references
    if (childId === parentId) {
      skippedCount++;
      continue;
    }

    // Geometric-mean confidence (consistent with GitNexus convention)
    const confidence = Math.sqrt(childConf * parentConf);

    const relType = h.kind === 'extends' ? 'extends' : 'implements';

    const rel: GraphRelation = {
      source: childId,
      target: parentId,
      type: relType,
      confidence,
      confidenceLabel: confidenceLabelFromNumeric(confidence),
      reason: `${h.kind} clause in ${h.filePath}`,
    };

    graph.addRelation(rel);

    if (h.kind === 'extends') {
      extendsCount++;
    } else {
      implementsCount++;
    }
  }

  return { extendsCount, implementsCount, skippedCount };
}
