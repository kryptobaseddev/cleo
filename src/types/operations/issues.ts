/**
 * Issues Domain Operations (4 operations)
 *
 * Query operations: 1 (diagnostics)
 * Mutate operations: 3 (create.bug, create.feature, create.help)
 *
 * @task T4494
 */

/**
 * Common issue types
 */
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IssueArea = 'cli' | 'mcp' | 'docs' | 'tests' | 'other';
export type IssueType = 'bug' | 'feature' | 'help';

export interface Diagnostics {
  cleoVersion: string;
  bashVersion: string;
  jqVersion: string;
  os: string;
  shell: string;
  cleoHome: string;
  ghVersion: string;
  installLocation: string;
}

/**
 * Query Operations
 */

// issues.diagnostics
export type IssuesDiagnosticsParams = Record<string, never>;
export interface IssuesDiagnosticsResult {
  diagnostics: Diagnostics;
}

/**
 * Mutate Operations
 */

// issues.create.bug
export interface IssuesCreateBugParams {
  title: string;
  body: string;
  severity?: IssueSeverity;
  area?: IssueArea;
  dryRun?: boolean;
}
export interface IssuesCreateBugResult {
  type: 'bug';
  url: string;
  number: number;
  title: string;
  labels: string[];
}

// issues.create.feature
export interface IssuesCreateFeatureParams {
  title: string;
  body: string;
  area?: IssueArea;
  dryRun?: boolean;
}
export interface IssuesCreateFeatureResult {
  type: 'feature';
  url: string;
  number: number;
  title: string;
  labels: string[];
}

// issues.create.help
export interface IssuesCreateHelpParams {
  title: string;
  body: string;
  area?: IssueArea;
  dryRun?: boolean;
}
export interface IssuesCreateHelpResult {
  type: 'help';
  url: string;
  number: number;
  title: string;
  labels: string[];
}
