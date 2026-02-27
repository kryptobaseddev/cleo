/**
 * Issue module - GitHub issue template parsing, diagnostics, and creation.
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

export {
  collectDiagnostics,
  formatDiagnosticsTable,
} from './diagnostics.js';

export {
  buildIssueBody,
  checkGhCli,
  createGhIssue,
  createIssue,
} from './create.js';
export type { CreateIssueParams, CreateIssueResult } from './create.js';
