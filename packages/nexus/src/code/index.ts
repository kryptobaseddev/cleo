/**
 * Code analysis via tree-sitter AST parsing.
 *
 * Provides symbol extraction, structural outline generation, cross-codebase
 * search, and single-symbol unfold for agents doing code intelligence tasks.
 *
 * @module code
 */

export { type OutlineNode, type SmartOutlineResult, smartOutline } from './outline.js';
export {
  batchParse,
  isTreeSitterAvailable,
  missingGrammarMessage,
  missingGrammars,
  parseFile,
  TREE_SITTER_GRAMMAR_FIX,
} from './parser.js';
export { type SmartSearchOptions, type SmartSearchResult, smartSearch } from './search.js';
export {
  detectLanguage,
  grammarPackage,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_LANGUAGES,
  type TreeSitterLanguage,
} from './tree-sitter-languages.js';
export { type SmartUnfoldResult, smartUnfold } from './unfold.js';
