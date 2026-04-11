/**
 * Code analysis via tree-sitter AST parsing.
 *
 * @deprecated Import directly from `@cleocode/nexus` instead.
 *
 * This barrel is retained for backward compatibility. The canonical
 * implementation lives in `@cleocode/nexus/src/code/`. Consumers in the
 * `@cleocode/core` dispatch layer that need these symbols should import
 * from `@cleocode/nexus` directly.
 *
 * @module code
 */

export {
  batchParse,
  isTreeSitterAvailable,
  type OutlineNode,
  parseFile,
  type SmartOutlineResult,
  type SmartSearchOptions,
  type SmartSearchResult,
  type SmartUnfoldResult,
  smartOutline,
  smartSearch,
  smartUnfold,
} from '@cleocode/nexus';
