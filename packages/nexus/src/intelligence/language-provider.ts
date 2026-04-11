/**
 * Language Provider interface — strategy pattern for per-language code extraction.
 *
 * Each language provider implements this interface to supply language-specific
 * logic for extracting graph nodes (definitions) and relations (imports, calls)
 * from a tree-sitter AST.
 *
 * Design: Strategy pattern. The intelligence pipeline dispatches to the
 * appropriate provider based on detected file language, keeping the pipeline
 * language-agnostic.
 *
 * Ported and adapted from GitNexus language-provider.ts for CLEO's lightweight
 * in-process code intelligence use case.
 *
 * @task T512
 * @module intelligence/language-provider
 */

import type { GraphNode, GraphRelation } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// SyntaxNode — minimal tree-sitter AST node shape
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a tree-sitter SyntaxNode used by language providers.
 *
 * This avoids a hard dependency on any particular tree-sitter type package
 * while still giving providers a typed surface for AST traversal.
 */
export interface SyntaxNode {
  /** Node type string as defined by the grammar (e.g., "function_declaration"). */
  type: string;
  /** Raw source text for this node. */
  text: string;
  /** Start position in the source file (0-based row). */
  startPosition: { row: number; column: number };
  /** End position in the source file (0-based row). */
  endPosition: { row: number; column: number };
  /** All child nodes (named and anonymous). */
  children: SyntaxNode[];
  /** Only the named child nodes (semantic children). */
  namedChildren: SyntaxNode[];
  /** Total count of named children. */
  namedChildCount: number;
  /** Whether this node is a named (semantic) node, not punctuation/keyword. */
  isNamed: boolean;
  /** Parent node, null for the root node. */
  parent: SyntaxNode | null;
  /** Previous named sibling in the parent's children list. */
  previousSibling: SyntaxNode | null;
  /**
   * Get a named child by its field name as defined in the grammar.
   *
   * @param fieldName - The grammar field name (e.g., "name", "body")
   * @returns The child node, or null if the field is not present
   */
  childForFieldName(fieldName: string): SyntaxNode | null;
  /**
   * Get a named child by index.
   *
   * @param index - Zero-based index into namedChildren
   */
  namedChild(index: number): SyntaxNode | null;
}

/**
 * Minimal shape of a parsed tree-sitter Tree.
 *
 * Language providers receive the root node directly; this type is used
 * internally by the intelligence pipeline when wiring together the parser
 * and provider extraction steps.
 */
export interface SyntaxTree {
  /** Root node of the parsed AST. */
  rootNode: SyntaxNode;
}

// ---------------------------------------------------------------------------
// LanguageProvider interface
// ---------------------------------------------------------------------------

/**
 * Strategy interface for per-language code extraction.
 *
 * Implementors walk a tree-sitter AST and produce graph nodes (definitions)
 * and graph relations (imports, calls) that the intelligence pipeline
 * assembles into the code intelligence graph.
 *
 * All three extraction methods receive the raw source text in addition to
 * the AST so providers can recover information not captured in the tree
 * (e.g., doc comments in leading sibling nodes).
 */
export interface LanguageProvider {
  /**
   * Language identifier as returned by the tree-sitter language detection.
   * Must match the keys used in `SUPPORTED_LANGUAGES` in the nexus package.
   *
   * @example "typescript"
   */
  language: string;

  /**
   * File extensions that this provider handles (with leading dot).
   *
   * @example [".ts", ".tsx"]
   */
  fileExtensions: string[];

  /**
   * Parse strategy used by this provider.
   * Currently only `tree-sitter` is supported; future providers may use
   * regex-based or standalone strategies.
   */
  parseStrategy: 'tree-sitter';

  /**
   * Extract type/symbol definitions from the AST.
   *
   * Walk the AST and produce a {@link GraphNode} for each function, class,
   * interface, method, or other declarative symbol found in the file.
   *
   * @param tree - Parsed tree-sitter AST (rootNode is the entry point)
   * @param source - Raw source text of the file
   * @param filePath - File path relative to the project root
   * @returns Array of graph nodes representing definitions found in the file
   */
  extractDefinitions(tree: SyntaxTree, source: string, filePath: string): GraphNode[];

  /**
   * Extract import statements from the AST.
   *
   * Walk the AST and produce a {@link GraphRelation} of type `imports` for
   * each import/require statement, linking the current file node to the
   * imported module's file node.
   *
   * @param tree - Parsed tree-sitter AST
   * @param source - Raw source text of the file
   * @param filePath - File path relative to the project root
   * @returns Array of import relations from this file to imported modules
   */
  extractImports(tree: SyntaxTree, source: string, filePath: string): GraphRelation[];

  /**
   * Extract function and method call expressions from the AST.
   *
   * Walk the AST and produce a {@link GraphRelation} of type `calls` for each
   * call expression found within function/method bodies, linking the calling
   * symbol to the callee symbol by name.
   *
   * @param tree - Parsed tree-sitter AST
   * @param source - Raw source text of the file
   * @param filePath - File path relative to the project root
   * @returns Array of call relations from callers to callees
   */
  extractCalls(tree: SyntaxTree, source: string, filePath: string): GraphRelation[];
}
