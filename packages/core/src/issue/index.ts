/**
 * Issue module - GitHub issue template parsing, diagnostics, and creation.
 *
 * @task T4454
 * @epic T4454
 */

export type { AddIssueParams, AddIssueResult } from './create.js';
export {
  addIssue,
  buildIssueBody,
  checkGhCli,
} from './create.js';

export {
  collectDiagnostics,
  formatDiagnosticsTable,
} from './diagnostics.js';
export type { IssueTemplate } from './template-parser.js';
export {
  cacheTemplates,
  getTemplateConfig,
  getTemplateForSubcommand,
  parseIssueTemplates,
  validateLabelsExist,
} from './template-parser.js';
