/**
 * Template Parser Engine (Re-export Adapter)
 *
 * Thin re-export from src/core/templates/parser.ts, adapting the core
 * TemplateResult type to the dispatch EngineResult type.
 *
 * All business logic lives in src/core/templates/parser.ts.
 * This file preserves backward compatibility for existing importers.
 *
 * @task T5705
 * @epic T5701
 */

import {
  generateTemplateConfig as coreGenerateTemplateConfig,
  getTemplateForSubcommand as coreGetTemplateForSubcommand,
  parseIssueTemplates as coreParseIssueTemplates,
  templates,
} from '@cleocode/core/internal';
import type { EngineResult } from './_error.js';

// Re-export types directly from core
export type {
  IssueTemplate,
  TemplateConfig,
  TemplateSection,
} from '@cleocode/core/internal';

/**
 * Adapt a core TemplateResult to an EngineResult.
 * The shapes are compatible -- TemplateResult is a subset of EngineResult.
 */
function adaptResult<T>(result: {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}): EngineResult<T> {
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error
      ? {
          code: result.error.code,
          message: result.error.message,
          ...(result.error.details ? { details: result.error.details } : {}),
        }
      : { code: 'E_INTERNAL', message: 'Unknown error' },
  };
}

/**
 * Parse all templates from the repo's .github/ISSUE_TEMPLATE/ directory.
 *
 * @remarks
 * Delegates to the core template parser and adapts the result to the
 * dispatch EngineResult type.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns EngineResult containing the parsed template configuration
 *
 * @example
 * ```typescript
 * const result = parseIssueTemplates('/path/to/project');
 * if (result.success) {
 *   console.log(result.data.templates);
 * }
 * ```
 */
export function parseIssueTemplates(
  projectRoot: string,
): EngineResult<import('@cleocode/core/internal').TemplateConfig> {
  return adaptResult(coreParseIssueTemplates(projectRoot));
}

/**
 * Get template config for a specific subcommand (bug/feature/help).
 *
 * @remarks
 * Looks up a specific template by subcommand name from the project's
 * issue template directory.
 *
 * @param projectRoot - Absolute path to the project root
 * @param subcommand - Template subcommand identifier (e.g. "bug", "feature")
 * @returns EngineResult containing the matched issue template
 *
 * @example
 * ```typescript
 * const result = getTemplateForSubcommand('/path/to/project', 'bug');
 * ```
 */
export function getTemplateForSubcommand(
  projectRoot: string,
  subcommand: string,
): EngineResult<import('@cleocode/core/internal').IssueTemplate> {
  return adaptResult(coreGetTemplateForSubcommand(projectRoot, subcommand));
}

/**
 * Generate and cache the config as .cleo/issue-templates.json.
 *
 * @remarks
 * Parses all templates and writes the resulting config to disk for caching.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns EngineResult containing the generated template configuration
 *
 * @example
 * ```typescript
 * const result = await generateTemplateConfig('/path/to/project');
 * ```
 */
export async function generateTemplateConfig(
  projectRoot: string,
): Promise<EngineResult<import('@cleocode/core/internal').TemplateConfig>> {
  return adaptResult(await coreGenerateTemplateConfig(projectRoot));
}

/**
 * Validate that labels exist on a GitHub repo.
 *
 * @remarks
 * Compares a set of required labels against the labels found on the repo.
 *
 * @param labels - Labels required by the template
 * @param repoLabels - Labels that exist on the GitHub repo
 * @returns EngineResult with existing and missing label lists
 *
 * @example
 * ```typescript
 * const result = validateLabels(['bug', 'enhancement'], repoLabels);
 * ```
 */
export function validateLabels(
  labels: string[],
  repoLabels: string[],
): EngineResult<{ existing: string[]; missing: string[] }> {
  return adaptResult(templates.validateLabels(labels, repoLabels));
}
