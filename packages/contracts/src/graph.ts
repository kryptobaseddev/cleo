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
  /** Whether this node represents an external module (unresolved import). */
  isExternal?: boolean;
}

// ---------------------------------------------------------------------------
// Confidence label
// ---------------------------------------------------------------------------

/**
 * Three-state confidence label for extracted edges.
 *
 * Complements the numeric `confidence` field with a categorical classification
 * that maps to the pipeline's resolution tiers:
 *
 * - **`EXTRACTED`** (Tier 1): Statically verifiable from the AST — the
 *   relationship is directly present in source. Covers `defines`, `imports`,
 *   structural containment (`has_method`, `has_property`), and same-file
 *   `calls` / `extends` / `implements`. Numeric confidence ≥ 0.90.
 *
 * - **`INFERRED`** (Tier 2a): Resolved through import-scoped analysis — the
 *   target is reachable via a known import but requires cross-file name
 *   resolution. Covers `accesses`, cross-file `calls`, and cross-file
 *   `extends` / `implements`. Numeric confidence in range 0.80 – 0.89.
 *
 * - **`AMBIGUOUS`** (Tier 3): Global fallback resolution — the target was
 *   found by scanning the entire repository index with no direct import
 *   path. Multiple candidates may exist. Numeric confidence < 0.80.
 *
 * @since T1862
 */
export type GraphEdgeConfidenceLabel = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

/**
 * Map a numeric confidence value to a {@link GraphEdgeConfidenceLabel}.
 *
 * Thresholds align with the pipeline resolution tiers defined in
 * `resolution-context.ts`:
 * - ≥ 0.90 → `EXTRACTED`  (same-file 0.95, import-scoped 0.90, defines 1.0)
 * - 0.80 – 0.89 → `INFERRED`   (accesses 0.80, heritage import-scoped 0.85)
 * - < 0.80 → `AMBIGUOUS`  (global 0.50, speculative)
 *
 * @param confidence - Numeric confidence in range [0.0, 1.0]
 * @returns The corresponding three-state label
 */
export function confidenceLabelFromNumeric(confidence: number): GraphEdgeConfidenceLabel {
  if (confidence >= 0.9) return 'EXTRACTED';
  if (confidence >= 0.8) return 'INFERRED';
  return 'AMBIGUOUS';
}

// ---------------------------------------------------------------------------
// ConfidenceProvenance — structured provenance for confidence scores
// ---------------------------------------------------------------------------

/**
 * Structured provenance for an EXTRACTED confidence assignment.
 *
 * Used when confidence was derived from direct AST evidence (same-file
 * lookup, import-scoped resolution) or an explicit source annotation.
 *
 * @since T9145
 */
export interface ExtractedProvenance {
  /** Discriminant. */
  readonly kind: 'extracted';
  /**
   * AST / static-analysis source that produced this confidence value.
   * Examples: `"ast"`, `"import-scope"`, `"same-file"`, `"defines"`.
   */
  readonly source: string;
}

/**
 * Structured provenance for an INFERRED confidence assignment.
 *
 * Used when confidence was derived from resolution heuristics (cross-file
 * type lookup, heritage-map inference, name matching).
 *
 * @since T9145
 */
export interface InferredProvenance {
  /** Discriminant. */
  readonly kind: 'inferred';
  /**
   * Heuristic or rule that produced this confidence value.
   * Examples: `"heritage-map"`, `"name-match"`, `"global-tier"`.
   */
  readonly heuristic: string;
}

/**
 * Structured provenance for an AMBIGUOUS confidence assignment.
 *
 * Used when confidence is low because multiple candidates were found,
 * the parent is external / unresolvable, or resolution fell to a global stub.
 *
 * @since T9145
 */
export interface AmbiguousProvenance {
  /** Discriminant. */
  readonly kind: 'ambiguous';
  /**
   * Candidate node IDs that competed for this resolution slot.
   * May be empty when the ambiguity is due to an unresolvable external type.
   */
  readonly candidates: ReadonlyArray<string>;
}

/**
 * Discriminated union of structured confidence provenance variants.
 *
 * Replaces the bare numeric `confidence` field on {@link GraphRelation} as
 * part of the Beta gradient deprecation (phase 0: addition, phase 1:
 * co-existence, removal at v2026.9).
 *
 * **Backfill mapping** for existing records created without structured
 * provenance:
 * - `confidence === 1.0` → `{ kind: 'extracted', source: 'ast' }`
 * - `confidence >= 0.90` → `{ kind: 'extracted', source: 'legacy' }`
 * - `confidence >= 0.80` → `{ kind: 'inferred', heuristic: 'legacy' }`
 * - `confidence < 0.80`  → `{ kind: 'ambiguous', candidates: [] }`
 *
 * @since T9145
 * @deprecated Numeric `confidence` on {@link GraphRelation} will be removed in v2026.9.
 *   Use `confidenceProvenance` instead. Migration: `confidenceFromProvenance()` maps back.
 */
export type ConfidenceProvenance = ExtractedProvenance | InferredProvenance | AmbiguousProvenance;

/**
 * Backfill a {@link ConfidenceProvenance} from a legacy numeric confidence value.
 *
 * @param confidence - Numeric confidence in range [0.0, 1.0]
 * @returns A structured provenance record consistent with the numeric value
 * @since T9145
 */
export function provenanceFromNumeric(confidence: number): ConfidenceProvenance {
  if (confidence === 1.0) return { kind: 'extracted', source: 'ast' };
  if (confidence >= 0.9) return { kind: 'extracted', source: 'legacy' };
  if (confidence >= 0.8) return { kind: 'inferred', heuristic: 'legacy' };
  return { kind: 'ambiguous', candidates: [] };
}

/**
 * Recover a numeric confidence value from a {@link ConfidenceProvenance} record.
 *
 * Inverse of {@link provenanceFromNumeric} for backward-compat bridging.
 *
 * @param provenance - Structured provenance record
 * @returns Best-effort numeric confidence in range [0.0, 1.0]
 * @since T9145
 */
export function confidenceFromProvenance(provenance: ConfidenceProvenance): number {
  switch (provenance.kind) {
    case 'extracted':
      return provenance.source === 'ast' ? 1.0 : 0.95;
    case 'inferred':
      return 0.85;
    case 'ambiguous':
      return 0.5;
  }
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
 *
 * The `confidenceLabel` field provides a categorical three-state classification
 * (see {@link GraphEdgeConfidenceLabel}) derived from the numeric `confidence`.
 * Both fields are kept for backward compatibility: existing consumers that read
 * the numeric field are unaffected; new consumers can use the label directly.
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
  /**
   * Three-state categorical label derived from the numeric `confidence` tier.
   *
   * Optional for backward compatibility with callers that construct
   * `GraphRelation` objects directly. Pipeline code SHOULD populate this
   * field. See {@link GraphEdgeConfidenceLabel} and
   * {@link confidenceLabelFromNumeric} for values and thresholds.
   */
  confidenceLabel?: GraphEdgeConfidenceLabel;
  /** Human-readable note explaining why this relation was emitted. */
  reason?: string;
}

/** Insert row shape for nexus_nodes. */
export interface NexusNodeInsertRow {
  id: string;
  kind: GraphNodeKind;
  label: string;
  name: string | null;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  language: string | null;
  isExported: boolean;
  parentId: string | null;
  parametersJson: string | null;
  returnType: string | null;
  docSummary: string | null;
  communityId: string | null;
  metaJson: string | null;
  indexedAt: string;
}

/** Insert row shape for nexus_relations. */
export interface NexusRelationInsertRow {
  id: string;
  sourceId: string;
  targetId: string;
  type: GraphRelationType;
  confidence: number;
  reason: string | null;
  step: number | null;
  indexedAt: string;
}

/**
 * Role supported by a file's recorded classification evidence.
 * @remarks Unknown files retain potential executable gaps. Generated data is not
 * generated executable code; executable files retain their code capabilities.
 * @example
 * ```ts
 * const role: GraphFileRole = 'documentation';
 * ```
 */
export type GraphFileRole =
  | 'executable'
  | 'sql'
  | 'documentation'
  | 'configuration'
  | 'schema'
  | 'generated-data'
  | 'data'
  | 'asset'
  | 'unknown';

/**
 * One independently requested indexing capability, not a runtime completeness claim.
 * @remarks Evidence capabilities retain available file content and its positively
 * identified role. They do not validate scientific authority, execute configuration,
 * or establish complete symbol/reference resolution. SQL capabilities are separate.
 * @example
 * ```ts
 * const requested: GraphAnalysisCapability[] = ['file-evidence', 'call-references'];
 * ```
 */
export type GraphAnalysisCapability =
  | 'file-evidence'
  | 'documentary-evidence'
  | 'configuration-evidence'
  | 'schema-evidence'
  | 'data-evidence'
  | 'resource-evidence'
  | 'declarations'
  | 'imports'
  | 'call-references'
  | 'access-references'
  | 'type-heritage'
  | 'sql-schema-objects'
  | 'sql-migrations'
  | 'sql-triggers'
  | 'sql-constraints'
  | 'sql-literal-references'
  | 'sql-dynamic-references';

/**
 * Provenance for assigning a file role; recognition is not authority.
 * @remarks Path-only recognition cannot prove an unknown file is non-executable.
 * @example
 * ```ts
 * const classification: GraphFileClassification = {
 *   basis: 'path-and-content', reason: 'PNG path and binary signature',
 * };
 * ```
 */
export interface GraphFileClassification {
  /** Inputs that positively establish the recorded role, or unknown when unclassified. */
  basis: 'path' | 'content' | 'path-and-content' | 'unknown';
  /** Human-readable observation; never an inferred scientific or policy authority. */
  reason: string;
}

/**
 * Capability-specific observations for an existing per-file index report.
 * @remarks Completed is a subset of requested and records performed extraction or
 * available evidence, not the absence of unresolved references. Static limitations
 * and uncompleted capabilities must survive compact reporting. Legacy reports may
 * lack this object and cannot retrospectively be declared capability-complete.
 * @example
 * ```ts
 * const capabilities: GraphFileCapabilityCoverage = {
 *   role: 'documentation',
 *   classification: { basis: 'path', reason: 'Documentary Markdown extension' },
 *   requested: ['file-evidence', 'documentary-evidence'],
 *   completed: ['file-evidence', 'documentary-evidence'],
 *   limitations: [],
 * };
 * ```
 */
export interface GraphFileCapabilityCoverage {
  /** Actual role supported by classification provenance. */
  role: GraphFileRole;
  /** Evidence explaining this role and its limits. */
  classification: GraphFileClassification;
  /** Capabilities required for this role in the assessed scope. */
  requested: GraphAnalysisCapability[];
  /** Requested capabilities whose processing actually completed. */
  completed: GraphAnalysisCapability[];
  /** Explicit limits, including unresolved dynamic/static analysis. */
  limitations: string[];
}

/** Observed outcome for one file or explicitly excluded directory during indexing. */
export interface GraphIndexFileReport {
  /** Path relative to the assessed source root. */
  path: string;
  /**
   * Processing outcome relative to requested capabilities; not a universal caller verdict.
   * Unsupported or oversized executable capabilities remain gaps.
   */
  status: 'analyzed' | 'excluded' | 'unsupported' | 'oversized' | 'failed';
  /**
   * Role-specific capability evidence from current producers.
   * @defaultValue undefined on legacy reports without capability provenance.
   */
  capabilities?: GraphFileCapabilityCoverage;
  /** Explanation for skipped or failed extraction. */
  reason?: string;
  /** Filesystem modification time captured before parsing. */
  mtimeMs?: number;
  /** SHA-256 of the bytes analyzed; detects edits even when filesystem metadata is preserved. */
  contentHash?: string;
  /** File size captured before parsing. */
  size?: number;
}

/** Original-source range; native parser indexes count UTF-16 code units, not UTF-8 bytes. */
export interface GraphSourceSpan {
  /** Inclusive start offset in original source. */
  startIndex: number;
  /** Exclusive end offset in original source. */
  endIndex: number;
  /** One-based start line. */
  startLine: number;
  /** One-based end line. */
  endLine: number;
  /** Zero-based start column in UTF-16 units. */
  startColumn: number;
  /** Zero-based end column in UTF-16 units. */
  endColumn: number;
  /** Explicit index encoding prevents byte/character confusion. */
  offsetEncoding: 'utf16';
}

/** A binding introduced by syntax in an explicitly supported lexical model. */
export interface GraphLexicalBinding {
  /** Stable declaration identity, distinct from its visible name. */
  id: string;
  /** Identifier visible in the declaring scope. */
  name: string;
  /** Scope that owns the binding. */
  scopeId: string;
  /** Value binding category; type-only imports remain explicitly marked. */
  kind: 'function' | 'class' | 'local' | 'parameter' | 'catch' | 'import';
  /** Original declaration range. */
  span: GraphSourceSpan;
  /** Callable/class target established by syntax, absent for unknown local values. */
  targetId?: string;
  /** Literal import source, before repository resolution. */
  importSource?: string;
  /** Imported name; '*' identifies a namespace import. */
  importedName?: string;
  /** True when this declaration cannot provide a runtime value. */
  typeOnly?: boolean;
}

/** One scope in a per-file lexical model, qualified by its containing scopes. */
export interface GraphLexicalScope {
  /** Unique scope identity. */
  id: string;
  /** Lexical parent; omitted only for the module. */
  parentId?: string;
  /** Scope semantics used for shadowing and var hoisting. */
  kind: 'module' | 'function' | 'class' | 'block' | 'catch';
  /** Nearest declared callable/class identity for reference ownership. */
  ownerId: string;
  /** Original syntax range. */
  span: GraphSourceSpan;
}

/** Lexical lookup evidence; an unknown local value is never a global-name fallback. */
export interface GraphLexicalResolution {
  /** Outcome before repository import/member resolution. */
  kind: 'resolved' | 'import' | 'shadowed' | 'ambiguous' | 'unbound';
  /** Binding candidates in the nearest declaring scope, without arbitrary selection. */
  bindings: GraphLexicalBinding[];
  /** Why these bindings or their absence produced the outcome. */
  reason: string;
}

/** An unresolved static reference retained with its available lexical and source evidence. */
export interface GraphIndexReferenceReport {
  /** Explicit extraction limitation; this record is not a resolved graph relationship. */
  kind: 'unmodeled-source' | 'ambiguous' | 'external' | 'dynamic' | 'shadowed' | 'unresolved';
  /** Analyzed source file containing the reference. */
  filePath: string;
  /** Enclosing qualified scope identifier extracted from original syntax. */
  sourceId: string;
  /** Known target, absent when syntax cannot establish one. */
  targetId?: string;
  /** Callee or member name retained for independent source inspection. */
  targetName: string;
  /** The kind of static relationship omitted from the published graph. */
  relationship: 'calls' | 'accesses';
  /** Extraction and resolution provenance from the attempted relationship. */
  reason: string;
  /** Original reference range; absent on historical or unsupported-language reports. */
  span?: GraphSourceSpan;
  /** Candidate identities retained without asserting an authoritative target. */
  candidateIds?: string[];
  /** Source-content generation tying reference evidence to analyzed bytes. */
  generation?: string;
  /** Preallocated publication identity; absent for standalone or historical extraction. */
  publicationGeneration?: string;
}

/** One explicitly selected source root, without implying complete file or caller coverage. */
export interface GraphSourceRoot {
  /** Absolute normalized requested location, retained even when inaccessible. */
  readonly requestedPath: string;
  /** Real filesystem location; null when canonical ownership could not be observed. */
  readonly canonicalPath: string | null;
  /** Forward-slash prefix relative to the graph source root; empty for the root itself. */
  readonly graphPrefix: string;
  /** Whether the caller explicitly included this repository below the graph source root. */
  readonly explicitlyIncluded: boolean;
  /** Git HEAD observed at this root; null is never interpreted as a known revision. */
  readonly revision: string | null;
  /** Outcome of root/revision observation, distinct from file-analysis coverage. */
  readonly status: 'available' | 'unversioned' | 'missing' | 'failed' | 'pending';
  /** Diagnostic failures or limitations that must survive compact root rendering. */
  readonly diagnostics: readonly string[];
}

/** Immutable provenance of explicitly owned roots under a stable parent project identity. */
export interface GraphSourceRootAssessment {
  /** Existing project identity supplied by the caller, never derived from Git roots. */
  readonly projectId: string;
  /** Absolute parent project location; canonicalized when it exists. */
  readonly projectRoot: string;
  /** Absolute graph source location; canonicalized when it exists. */
  readonly sourceRoot: string;
  /** Observation start time in ISO-8601 form. */
  readonly assessedAt: string;
  /** Source root followed by explicitly selected repository roots; no implicit nested discovery. */
  readonly roots: readonly GraphSourceRoot[];
}

/** Explicit source ownership and bounded revision-assessment input. */
export interface GraphSourceRootRequest {
  /** Stable existing parent project identity. */
  readonly projectId: string;
  /** Parent project location; independent of repository ownership. */
  readonly projectRoot: string;
  /** Explicit graph source location; defaults to the parent project location. */
  readonly sourceRoot?: string;
  /** Repository paths relative to the source root; escaping or aliased ownership is invalid. */
  readonly includedRepositories?: readonly string[];
  /** Absolute epoch-millisecond deadline shared across every root; defaults to two seconds. */
  readonly deadline?: number;
  /** Caller cancellation; cancellation rejects instead of reporting successful observation. */
  readonly signal?: AbortSignal;
}

/** Source provenance persisted with a complete published graph generation. */
export interface GraphIndexAssessment {
  /** Explicit parent identity and per-root revision observations; absent on historical indexes. */
  sourceRoots?: GraphSourceRootAssessment;
  /** Immutable publication identity allocated before extraction; absent on historical indexes. */
  generation?: string;
  /**
   * Unmodeled AST scopes remain explicit limitations instead of fabricated declarations.
   * Absent on a summary read: the list is stored beside the assessment (T12348)
   * and loaded only on request; {@link GraphIndexAssessment.referenceCount} still
   * reports how many there are.
   */
  references?: GraphIndexReferenceReport[];
  /**
   * Number of retained references, recorded whenever the list is stored
   * separately from this summary (T12348). Absent on historical indexes, whose
   * `references` are inline.
   */
  referenceCount?: number;
  /** Explicit nested repository/worktree scope retained for subsequent rebuilds. */
  includedRepositories?: string[];
  /** Canonical root whose relative file paths this graph describes. */
  sourceRoot: string;
  /** Git revision captured at assessment; null when no revision is available. */
  assessedRevision: string | null;
  /** ISO timestamp of the assessment. */
  assessedAt: string;
  /** Explicit extraction/exclusion outcomes, including partial coverage. */
  files: GraphIndexFileReport[];
}

/** Validated rows staged before an atomic graph publication. */
export interface GraphPublicationRows {
  /** Immutable publication identity shared by anonymous symbols, rows and assessment. */
  generation?: string;
  /** Source provenance and coverage belonging to this generation. */
  assessment?: GraphIndexAssessment;
  /** Complete replacement node generation. */
  nodes: NexusNodeInsertRow[];
  /** Complete replacement relationship generation. */
  relations: NexusRelationInsertRow[];
  /**
   * Per-file extraction memo changes committed in the same transaction as the rows.
   * Absent when the producer does not maintain a parse cache.
   */
  parseCache?: GraphParseCacheUpdate;
}

/**
 * One file's memoized extraction output, valid only for the exact bytes and extractor build.
 *
 * Extraction is a pure function of `(path, content, extractor build, publication generation)`;
 * the generation token embedded in anonymous identities is rewritten on reuse, so a reused
 * entry yields exactly what re-parsing the same bytes would.
 */
export interface GraphParseCacheEntry {
  /** Path relative to the assessed source root. */
  path: string;
  /** SHA-256 of the bytes that produced this extraction. */
  contentHash: string;
  /** Fingerprint of the extractor build (code + grammars) that produced it. */
  fingerprint: string;
  /** Publication generation embedded in the stored payload's anonymous identities. */
  generation: string;
  /** Compressed serialized extraction; opaque to every owner except the producing pipeline. */
  payload: Uint8Array;
}

/** Parse-cache mutation applied atomically with a graph publication. */
export interface GraphParseCacheUpdate {
  /** Extractor fingerprint every retained and written entry must carry. */
  fingerprint: string;
  /** Delete every existing entry before applying `upserts` (full rebuilds). */
  reset: boolean;
  /** Entries for files parsed during this run. */
  upserts: GraphParseCacheEntry[];
  /** Paths whose entries no longer describe a current, successfully parsed file. */
  deletePaths: string[];
}

/** Why and how an index run chose between reusing prior extraction and parsing everything. */
export interface GraphIndexRunSummary {
  /**
   * `incremental` parsed only files without a reusable extraction; `full` parsed every file;
   * `unchanged` found no source difference and published nothing.
   */
  mode: 'incremental' | 'full' | 'unchanged';
  /** Human-readable reason for the mode, including every full-rebuild fallback. */
  reason: string;
  /** Previously indexed files whose content hash differs. */
  changedFiles: number;
  /** Files absent from the previous generation. */
  addedFiles: number;
  /** Previously indexed files no longer present. */
  deletedFiles: number;
  /** Files handed to the parser this run. */
  parsedFiles: number;
  /** Files whose extraction was reused from the parse cache instead of re-parsed. */
  reusedFiles: number;
  /**
   * Files whose imports, calls, accesses and heritage were re-resolved. Resolution always runs
   * over the complete merged symbol table, so this equals every extracted file; dependents of
   * changed files are therefore never left pointing at stale targets.
   */
  resolvedFiles: number;
  /** Wall-clock milliseconds per pipeline phase, for cost disclosure. */
  phaseMs: Record<string, number>;
}

/**
 * Freshness of a published code-graph index relative to the working tree.
 *
 * Computed by metadata comparison (mtime + size) with a content-hash fallback on mismatch, so
 * a touched-but-identical file is not reported stale.
 */
export interface GraphIndexFreshness {
  /** Whether a published index exists at all. */
  indexed: boolean;
  /** `fresh` when no indexed file differs from disk; `stale` otherwise; `unknown` if unassessed. */
  status: 'fresh' | 'stale' | 'unknown';
  /** Assessment timestamp of the published generation. */
  lastIndexedAt: string | null;
  /** Files recorded in the published generation's assessment. */
  fileCount: number;
  /** Modified, added and deleted source files. */
  staleFileCount: number;
  /** Up to a bounded sample of stale paths, for disclosure. */
  stalePaths: string[];
  /** Whether the queried symbol's own file is stale; absent when no symbol file is known. */
  symbolFileStale?: boolean;
  /** The symbol file the `symbolFileStale` verdict describes. */
  symbolFile?: string;
  /** Command that refreshes the index. */
  refreshCommand: string;
  /** Rough cost of that refresh, for the caller to decide whether to wait for it. */
  refreshEstimate: string;
  /** Milliseconds spent assessing freshness. */
  checkMs: number;
  /** Diagnostic reason when `status` is `unknown`. */
  reason?: string;
  /** Present when the query attempted to refresh the index inline before answering. */
  autoRefresh?: {
    /** Whether the inline refresh published a new generation. */
    refreshed: boolean;
    /** Stale files at the time the refresh was attempted. */
    staleFiles: number;
    /** Milliseconds the refresh took (or ran before it was abandoned). */
    durationMs: number;
    /** Why the refresh ran, was skipped, or failed. */
    reason: string;
  };
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
   * - `unknown`: target missing or evidence insufficient
   * - `none`: assessed target with no detected static dependants
   * - `low`: 1–3 direct dependants, no cross-module spread
   * - `medium`: 4–9 direct dependants, or limited cross-module spread
   * - `high`: 10+ direct dependants, or significant cross-module spread
   * - `critical`: Exported symbol with high cross-module usage
   */
  riskLevel: 'unknown' | 'none' | 'low' | 'medium' | 'high' | 'critical';
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
