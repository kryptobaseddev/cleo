/**
 * Code analysis via tree-sitter AST parsing.
 *
 * @module code
 */

export { smartOutline, type OutlineNode, type SmartOutlineResult } from './outline.js';
export { batchParse, parseFile } from './parser.js';
