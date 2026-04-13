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
 * language providers. Includes synthetic graph-level nodes produced by
 * analysis phases (community detection, process detection, route extraction).
 *
 * @since T529 — expanded from T512 baseline with 17 new kinds
 */
export type GraphNodeKind =
  // Structural
  | 'file'
  | 'folder'
  // Module-level
  | 'module'
  | 'namespace'
  // Callable
  | 'function'
  | 'method'
  | 'constructor'
  // Type hierarchy
  | 'class'
  | 'interface'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'type_alias'
  | 'enum'
  // Value-level
  | 'property'
  | 'constant'
  | 'variable'
  | 'static'
  | 'record'
  | 'delegate'
  // Language-specific constructs
  | 'macro'
  | 'union'
  | 'typedef'
  | 'annotation'
  | 'template'
  // Graph-level (synthetic, from analysis phases)
  | 'community'
  | 'process'
  | 'route'
  | 'tool'
  | 'section'
  // Legacy (kept for T506 compatibility)
  | 'import'
  | 'export'
  | 'type';

// ---------------------------------------------------------------------------
// Relationship types
// ---------------------------------------------------------------------------

/**
 * All supported directed relationship types between graph nodes.
 *
 * Types are intentionally lowercase to match CLEO convention.
 * Each type carries semantic meaning about the nature of the dependency.
 *
 * @since T529 — expanded from T512 baseline with 10 new relation types
 */
export type GraphRelationType =
  // Structural
  | 'contains'
  // Definition / usage
  | 'defines'
  | 'imports'
  | 'accesses'
  // Callable
  | 'calls'
  // Type hierarchy
  | 'extends'
  | 'implements'
  | 'method_overrides'
  | 'method_implements'
  // Class structure
  | 'has_method'
  | 'has_property'
  // Graph-level (synthetic, from analysis phases)
  | 'member_of' // symbol → community node
  | 'step_in_process' // symbol → process node
  // Web / API
  | 'handles_route' // function → route node
  | 'fetches' // function → external URL
  // Tool / agent
  | 'handles_tool'
  | 'entry_point_of' // function → process node
  // Wrapping / delegation
  | 'wraps'
  // Data access
  | 'queries'
  // Cross-graph (brain integration)
  | 'documents' // brain node → nexus node
  | 'applies_to'; // brain decision/learning → nexus node

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
  /** Community ID this node belongs to (set after Phase 5 community detection). */
  communityId?: string;
  /** Execution flow process IDs this node participates in (set after Phase 6). */
  processIds?: string[];
  /** Kind-specific metadata blob (matches nexus_nodes.meta_json). */
  meta?: Record<string, unknown>;
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

// ---------------------------------------------------------------------------
// Pipeline interfaces (T529)
// ---------------------------------------------------------------------------

/**
 * An in-memory symbol table entry tracking all files where a name appears.
 * Used during ingestion to resolve cross-file call targets.
 */
export interface SymbolIndex {
  /** Symbol name as it appears in source (e.g., "parseFile"). */
  name: string;
  /** All node IDs that define this name across the project. */
  nodeIds: string[];
  /** All file paths that export this name. */
  exportingFiles: string[];
}

/**
 * The in-memory KnowledgeGraph assembled during a single ingestion run.
 * Flushed to nexus_nodes + nexus_relations after all phases complete.
 */
export interface KnowledgeGraph {
  /** Primary node store: nodeId → GraphNode. */
  nodes: Map<string, GraphNode>;
  /** All directed edges (appended during ingestion, deduplicated at flush). */
  relations: GraphRelation[];
  /** Indexes for fast lookup during resolution phases. */
  symbolTable: SymbolIndex[];
  /** Files that changed since last index (incremental mode only). */
  changedFiles?: Set<string>;
}

/**
 * A community (module cluster) identified by Louvain community detection
 * during Phase 5. Represents a group of cohesive symbols within the graph.
 */
export interface CommunityNode {
  /** Node ID format: `community:<n>` */
  id: string;
  /** Inferred label from the top folder name. */
  label: string;
  /** Number of member symbols in this community. */
  memberCount: number;
  /** Top-level folders contributing most members. */
  topFolders: string[];
}

/**
 * A detected execution flow (process) from BFS entry point analysis
 * during Phase 6. Represents a named sequence of function calls.
 */
export interface ProcessNode {
  /** Node ID format: `process:<slug>` */
  id: string;
  /** Entry point function name used as the process label. */
  label: string;
  /** Node ID of the entry point function. */
  entryPointId: string;
  /** Ordered node IDs representing each step in the flow. */
  stepIds: string[];
  /** Total number of steps in this execution flow. */
  stepCount: number;
}
