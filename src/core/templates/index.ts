/**
 * Core Templates Module
 *
 * Barrel export for GitHub issue template parsing logic.
 *
 * @task T5705
 * @epic T5701
 */

export type {
  IssueTemplate,
  TemplateConfig,
  TemplateResult,
  TemplateSection,
} from './parser.js';
export {
  generateTemplateConfig,
  getTemplateForSubcommand,
  parseIssueTemplates,
  validateLabels,
} from './parser.js';
