/**
 * Code analysis via tree-sitter AST parsing.
 *
 * @module code
 */

export { type OutlineNode, type SmartOutlineResult, smartOutline } from './outline.js';
export { batchParse, parseFile } from './parser.js';
export { type SmartSearchOptions, type SmartSearchResult, smartSearch } from './search.js';
export { type SmartUnfoldResult, smartUnfold } from './unfold.js';
