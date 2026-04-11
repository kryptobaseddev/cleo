/**
 * Graph type contracts for CLEO code intelligence.
 *
 * Defines the node types, relationship types, and structures that form the
 * foundation of the code intelligence graph. Ported from GitNexus graph
 * primitives and adapted for CLEO's lightweight, in-process use case.
 *
 * @task T512
 * @module contracts/graph
 */

// ---------------------------------------------------------------------------
// Node kinds
// ---------------------------------------------------------------------------

/**
 * All supported symbol node kinds in the code intelligence graph.
 *
 * Covers file/folder structural nodes plus every symbol-level construct
 * that tree-sitter can identify across TypeScript, JavaScript, and future
 * language providers.
 */
export type GraphNodeKind =
  | 'file'
  | 'folder'
  | 'module'
  | 'function'
  | 'method'
  | 'constructor'
  | 'class'
  | 'interface'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'type'
  | 'property'
  | 'constant'
  | 'variable'
  | 'namespace'
  | 'import'
  | 'export';

// ---------------------------------------------------------------------------
// Relationship types
// ---------------------------------------------------------------------------

/**
 * All supported directed relationship types between graph nodes.
 *
 * Types are intentionally lowercase to match CLEO convention.
 * Each type carries semantic meaning about the nature of the dependency.
 */
export type GraphRelationType =
  | 'contains'
  | 'defines'
  | 'imports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'has_method'
  | 'has_property'
  | 'accesses'
  | 'method_overrides'
  | 'method_implements';

// ---------------------------------------------------------------------------
// Node interface
// ---------------------------------------------------------------------------

/**
 * A node in the code intelligence graph representing a symbol or structural
 * element extracted from source code.
 *
 * The `id` field is a stable identifier for the node, typically derived from
 * the file path and symbol name (e.g., `src/foo.ts::parseFile`).
 */
export interface GraphNode {
  /** Unique, stable node identifier. Typically `<filePath>::<name>`. */
  id: string;
  /** Kind of code element this node represents. */
  kind: GraphNodeKind;
  /** Symbol name as it appears in source code. */
  name: string;
  /** File path relative to the project root. */
  filePath: string;
  /** Start line in the source file (1-based). */
  startLine: number;
  /** End line in the source file (1-based). */
  endLine: number;
  /** Language of the source file (e.g., "typescript", "javascript"). */
  language: string;
  /** Whether the symbol is publicly exported from its module. */
  exported: boolean;
  /** Parent node ID, if this symbol is nested (e.g., method inside class). */
  parent?: string;
  /** Parameter names or signatures for functions and methods. */
  parameters?: string[];
  /** Return type annotation text, if available. */
  returnType?: string;
  /** First line of the TSDoc/JSDoc comment for this symbol, if present. */
  docSummary?: string;
}

// ---------------------------------------------------------------------------
// Relation interface
// ---------------------------------------------------------------------------

/**
 * A directed relationship between two nodes in the code intelligence graph.
 *
 * The `source` and `target` fields reference node IDs (see {@link GraphNode.id}).
 * Confidence reflects how certain the extractor is about this relationship,
 * from 0.0 (speculative) to 1.0 (statically verified).
 */
export interface GraphRelation {
  /** ID of the originating node. */
  source: string;
  /** ID of the target node. */
  target: string;
  /** Semantic type of the relationship. */
  type: GraphRelationType;
  /**
   * Extractor confidence for this relationship (0.0 to 1.0).
   *
   * Common values by type:
   * - `calls` / `imports`: 0.9 (direct, strongly typed)
   * - `extends` / `implements`: 0.85 (statically verifiable)
   * - `has_method` / `has_property`: 0.95 (structural containment)
   * - `accesses`: 0.8 (field read/write, may be indirect)
   */
  confidence: number;
  /** Human-readable note explaining why this relation was emitted. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Impact analysis result
// ---------------------------------------------------------------------------

/**
 * Result of a BFS-based impact analysis starting from a named symbol.
 *
 * Affected nodes are grouped into three depth tiers that reflect the
 * likelihood and urgency of breakage:
 *
 * - **depth1_willBreak** (d=1): Direct callers/importers — WILL break.
 *   Must be updated whenever the target changes.
 * - **depth2_likelyAffected** (d=2): Indirect dependants — LIKELY affected.
 *   Should be tested.
 * - **depth3_mayNeedTesting** (d=3): Transitive dependants — MAY need testing.
 *   Test if the symbol is on a critical path.
 */
export interface ImpactResult {
  /** Name or ID of the symbol that was analyzed. */
  target: string;
  /**
   * Overall risk classification based on the number and type of affected nodes.
   *
   * - `low`: 0–3 direct dependants, no cross-module spread
   * - `medium`: 4–9 direct dependants, or limited cross-module spread
   * - `high`: 10+ direct dependants, or significant cross-module spread
   * - `critical`: Exported symbol with high cross-module usage
   */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Human-readable summary of the impact analysis outcome. */
  summary: string;
  /** Nodes affected at each traversal depth. */
  affectedByDepth: {
    /** d=1: Direct dependants — WILL BREAK. */
    depth1_willBreak: GraphNode[];
    /** d=2: Indirect dependants — LIKELY AFFECTED. */
    depth2_likelyAffected: GraphNode[];
    /** d=3: Transitive dependants — MAY NEED TESTING. */
    depth3_mayNeedTesting: GraphNode[];
  };
  /** Total number of affected nodes across all depths. */
  totalAffected: number;
}
