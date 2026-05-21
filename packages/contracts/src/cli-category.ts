/**
 * CLI category labels used to group commands in `cleo --help` output.
 *
 * Every CLI command belongs to exactly one category. The category string is
 * the display label shown in the grouped help renderer.
 *
 * Adding a new category requires:
 *  1. Appending the literal to this union type.
 *  2. Adding the command name(s) to CLI_COMMAND_CATEGORIES in
 *     packages/core/src/routing/capability-matrix.ts.
 *
 * @module
 */

/**
 * The set of valid CLI help categories.
 *
 * Order here is the canonical display order in `cleo --help`.
 */
export type CliCategory =
  | 'Task Management'
  | 'Task Organization'
  | 'Sessions & Planning'
  | 'Phases & Lifecycle'
  | 'Memory & Notes'
  | 'Analysis & Stats'
  | 'Validation & Compliance'
  | 'Code & Documentation'
  | 'Research & Orchestration'
  | 'Import / Export'
  | 'Collaboration'
  | 'Agents'
  | 'System & Admin';

/**
 * Canonical ordered list of all CLI categories (display order in --help).
 */
export const CLI_CATEGORY_ORDER: readonly CliCategory[] = [
  'Task Management',
  'Task Organization',
  'Sessions & Planning',
  'Phases & Lifecycle',
  'Memory & Notes',
  'Analysis & Stats',
  'Validation & Compliance',
  'Code & Documentation',
  'Research & Orchestration',
  'Import / Export',
  'Collaboration',
  'Agents',
  'System & Admin',
] as const;
