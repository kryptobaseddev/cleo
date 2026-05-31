/**
 * @cleocode/nexus — CLEO project registry and code intelligence.
 *
 * Public API surface:
 *
 * ## Code Analysis
 * Tree-sitter powered AST analysis for symbol extraction, structural
 * outlines, codebase search, and single-symbol unfold.
 *
 * ## Schema
 * Drizzle SQLite schema for the persistent code symbol index.
 *
 * ## Registry (future)
 * Cross-project registration and coordination is currently served by
 * `@cleocode/core`. It will migrate here in a follow-up epic once
 * core infrastructure is further decomposed.
 *
 * @module @cleocode/nexus
 */

// Code analysis — tree-sitter AST pipeline
// Language detection utilities
export {
  batchParse,
  detectLanguage,
  grammarPackage,
  isTreeSitterAvailable,
  type OutlineNode,
  parseFile,
  type SmartOutlineResult,
  type SmartSearchOptions,
  type SmartSearchResult,
  type SmartUnfoldResult,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_LANGUAGES,
  smartOutline,
  smartSearch,
  smartUnfold,
  type TreeSitterLanguage,
} from './code/index.js';
// Code intelligence — language providers, graph extraction, impact analysis
export {
  analyzeImpact,
  type GraphNode,
  type GraphNodeKind,
  type GraphRelation,
  type GraphRelationType,
  type ImpactOptions,
  type ImpactResult,
  type LanguageProvider,
  type SyntaxNode,
  type SyntaxTree,
  typescriptProvider,
} from './intelligence/index.js';
// Pipeline — filesystem walker, structure processor, knowledge graph
export {
  createKnowledgeGraph,
  detectLanguageFromPath,
  isIndexableFile,
  type KnowledgeGraph,
  type NexusDbInsert,
  type NexusTables,
  type PipelineResult,
  processStructure,
  runPipeline,
  type ScannedFile,
  walkRepositoryPaths,
} from './pipeline/index.js';
// Schema — Drizzle SQLite table definitions.
// `code_index` was relocated into the consolidated substrate schema directory
// (`@cleocode/core/store/schema/code-index`) for Gate 4 (Contracts Fan-Out)
// compliance — T11359 · E2 · SG-DB-SUBSTRATE-V2. A re-export shim cannot live
// here: `@cleocode/core` depends on `@cleocode/nexus`, so importing the table
// back would close a `core → nexus → core` cycle. The re-export had no
// consumers (the table is owned and migrated by the core substrate), so it is
// dropped rather than shimmed. Import `codeIndex` from `@cleocode/core` instead.
