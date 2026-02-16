/**
 * Issue module - GitHub issue template parsing and management.
 *
 * @task T4454
 * @epic T4454
 */

export {
  parseIssueTemplates,
  getTemplateConfig,
  getTemplateForSubcommand,
  cacheTemplates,
  validateLabelsExist,
} from './template-parser.js';
export type { IssueTemplate } from './template-parser.js';
