/**
 * Code intelligence module — graph extraction and impact analysis.
 *
 * Provides the foundational abstractions for CLEO's code intelligence layer:
 *
 * - **Language Provider interface**: Strategy pattern for per-language AST extraction
 * - **TypeScript/JavaScript provider**: Extracts definitions, imports, and calls
 * - **Impact analysis**: BFS-based upstream/downstream impact traversal
 *
 * Graph type contracts (GraphNode, GraphRelation, ImpactResult) are exported
 * from `@cleocode/contracts` and re-exported here for consumer convenience.
 *
 * @task T512
 * @module intelligence
 */

// Re-export graph contracts for consumer convenience
export type {
  GraphNode,
  GraphNodeKind,
  GraphRelation,
  GraphRelationType,
  ImpactResult,
} from '@cleocode/contracts';
export type { ImpactOptions } from './impact.js';

// Impact analysis
export { analyzeImpact } from './impact.js';
// Language provider interface and AST types
export type { LanguageProvider, SyntaxNode, SyntaxTree } from './language-provider.js';
// TypeScript/JavaScript provider implementation
export { typescriptProvider } from './providers/typescript.js';
