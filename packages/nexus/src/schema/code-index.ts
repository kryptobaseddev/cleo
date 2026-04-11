/**
 * Drizzle SQLite schema for the persistent code symbol index.
 *
 * Stores extracted symbols from tree-sitter parsing, enabling
 * incremental re-indexing and cross-session symbol lookup without
 * re-parsing source files.
 *
 * The schema lives in nexus.db alongside the project registry tables.
 *
 * @module schema/code-index
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Persistent index of code symbols extracted by tree-sitter.
 *
 * One row per symbol per file. The `projectId` foreign key links each
 * symbol to its owning project in the `project_registry` table.
 *
 * Compound uniqueness: `(projectId, filePath, symbolName, startLine)` —
 * allows the same name in different files or scopes.
 */
export const codeIndex = sqliteTable('code_index', {
  /**
   * Stable row identifier (UUID v4).
   * Generated at index time; never reused after deletion.
   */
  id: text('id').primaryKey(),

  /**
   * Foreign key to `project_registry.project_id`.
   * Scopes the symbol to its owning CLEO project.
   */
  projectId: text('project_id').notNull(),

  /**
   * Relative file path within the project root.
   * Example: `src/core/parser.ts`
   */
  filePath: text('file_path').notNull(),

  /**
   * Symbol name as extracted from the AST.
   * Example: `parseFile`, `HttpTransport`, `validateEnvelope`
   */
  symbolName: text('symbol_name').notNull(),

  /**
   * Symbol kind from the tree-sitter capture group.
   * One of: `function`, `method`, `class`, `interface`, `type`,
   * `enum`, `variable`, `constant`, `module`, `import`, `export`,
   * `struct`, `trait`, `impl`.
   */
  kind: text('kind').notNull(),

  /**
   * Start line of the symbol in the source file (1-based).
   */
  startLine: integer('start_line').notNull(),

  /**
   * End line of the symbol in the source file (1-based).
   */
  endLine: integer('end_line').notNull(),

  /**
   * Source language detected from the file extension.
   * One of: `typescript`, `tsx`, `javascript`, `python`, `go`,
   * `rust`, `java`, `c`, `cpp`, `ruby`.
   */
  language: text('language').notNull(),

  /**
   * Whether the symbol has an `export` modifier (1) or not (0).
   * Stored as integer boolean for SQLite compatibility.
   */
  exported: integer('exported', { mode: 'boolean' }).default(false),

  /**
   * Parent symbol name for nested declarations.
   * Set for methods inside a class or impl block.
   * Example: `HttpTransport` for a method inside that class.
   */
  parent: text('parent'),

  /**
   * Return type annotation extracted from the declaration.
   * Null if not present or not detected by the grammar pattern.
   */
  returnType: text('return_type'),

  /**
   * First line of the leading JSDoc/docstring comment, if present.
   * Enables semantic search without re-reading source files.
   */
  docSummary: text('doc_summary'),

  /**
   * ISO 8601 timestamp when this row was last indexed.
   * Used for incremental re-indexing: skip files whose mtime
   * predates this timestamp.
   */
  indexedAt: text('indexed_at').notNull(),
});

/** TypeScript type for a full code_index row (select). */
export type CodeIndexRow = typeof codeIndex.$inferSelect;

/** TypeScript type for inserting a new code_index row. */
export type NewCodeIndexRow = typeof codeIndex.$inferInsert;
