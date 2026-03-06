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
  addIssue,
} from './create.js';
export type { AddIssueParams, AddIssueResult } from './create.js';
