/**
 * CANT migration engine -- markdown-to-CANT conversion tooling.
 *
 * Entry point for the `cant migrate` command and programmatic
 * migration of AGENTS.md files to .cant format.
 *
 * @example
 * ```typescript
 * import { migrateMarkdown, showDiff } from '@cleocode/cant/migrate';
 *
 * const result = migrateMarkdown(markdownContent, 'AGENTS.md', {
 *   write: false,
 *   verbose: false,
 * });
 *
 * console.log(showDiff(result));
 * ```
 */

export { migrateMarkdown } from './converter';
export { serializeCantDocument } from './serializer';
export { showDiff, showSummary } from './diff';
export type {
  ConvertedFile,
  MigrationOptions,
  MigrationResult,
  UnconvertedSection,
} from './types';
