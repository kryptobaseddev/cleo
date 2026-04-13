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
// Schema — Drizzle SQLite table definitions
export { type CodeIndexRow, codeIndex, type NewCodeIndexRow } from './schema/code-index.js';
