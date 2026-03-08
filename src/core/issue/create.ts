/**
 * GitHub issue creation logic.
 *
 * Extracted from CLI issue command to core for shared use
 * by both CLI and dispatch layer.
 *
 * @task T4555
 * @epic T4820
 */

import { execFileSync } from 'node:child_process';
import { BUILD_CONFIG } from '../../config/build-config.js';
import { ExitCode } from '../../types/exit-codes.js';
import { CleoError } from '../errors.js';
import { collectDiagnostics, formatDiagnosticsTable } from './diagnostics.js';
import { getTemplateForSubcommand } from './template-parser.js';

const CLEO_REPO = BUILD_CONFIG.repository.fullName;

/**
 * Build structured issue body with template sections.
 */
export function buildIssueBody(
  subcommand: string,
  rawBody: string,
  severity?: string,
  area?: string,
): string {
  const template = getTemplateForSubcommand(subcommand);
  const sectionLabel = template?.name ?? 'Description';

  const parts: string[] = [];
  parts.push(`### ${sectionLabel}`);
  parts.push('');
  parts.push(rawBody);

  if (severity) parts.push(`\n**Severity**: ${severity}`);
  if (area) parts.push(`**Area**: ${area}`);

  parts.push('\n### Are you using an AI agent?\n');
  parts.push('Yes - AI agent filed this issue');

  // Auto-append diagnostics
  parts.push('\n---\n');
  parts.push(formatDiagnosticsTable(collectDiagnostics()));

  return parts.join('\n');
}

/**
 * Check that gh CLI is installed and authenticated.
 */
export function checkGhCli(): void {
  try {
    execFileSync('gh', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new CleoError(ExitCode.DEPENDENCY_ERROR, 'GitHub CLI (gh) is not installed', {
      fix: 'Install gh: https://cli.github.com/ or brew install gh',
    });
  }

  try {
    execFileSync('gh', ['auth', 'status', '--hostname', 'github.com'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new CleoError(ExitCode.DEPENDENCY_ERROR, 'GitHub CLI is not authenticated', {
      fix: "Run 'gh auth login' to authenticate",
    });
  }
}

/**
 * Add a GitHub issue via gh CLI (internal implementation).
 */
function addGhIssue(title: string, body: string, labels: string): string {
  try {
    const result = execFileSync(
      'gh',
      ['issue', 'create', '--repo', CLEO_REPO, '--title', title, '--body', body, '--label', labels],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return result.trim();
  } catch (err) {
    throw new CleoError(
      ExitCode.CONFIG_ERROR,
      `Failed to create issue: ${(err as Error).message}`,
      {
        fix: 'Check gh auth status and network connectivity',
      },
    );
  }
}

export interface AddIssueParams {
  issueType: string;
  title: string;
  body: string;
  severity?: string;
  area?: string;
  dryRun?: boolean;
}

export interface AddIssueResult {
  type: string;
  url?: string;
  number?: number | string;
  title: string;
  labels: string[];
  body: string;
  repo: string;
  dryRun: boolean;
}

/**
 * Add a GitHub issue for a given type (bug, feature, help).
 * Returns structured result. Does not handle CLI output or process.exit.
 *
 * Note: Named 'add' per VERB-STANDARDS.md (canonical verb for "Create new entity")
 */
export function addIssue(params: AddIssueParams): AddIssueResult {
  const { issueType, title, body, severity, area, dryRun } = params;

  // Get template-driven label and title prefix
  const template = getTemplateForSubcommand(issueType);
  const labels = template?.labels?.join(',') ?? issueType;
  const titlePrefix = template?.title ?? '';
  const fullTitle = titlePrefix ? `${titlePrefix}${title}` : title;

  // Build structured body
  const fullBody = buildIssueBody(issueType, body, severity, area);

  if (dryRun) {
    return {
      type: issueType,
      repo: CLEO_REPO,
      title: fullTitle,
      labels: labels.split(','),
      body: fullBody,
      dryRun: true,
    };
  }

  checkGhCli();
  const issueUrl = addGhIssue(fullTitle, fullBody, labels);
  const issueNumber = issueUrl.match(/(\d+)$/)?.[1] ?? 'unknown';

  return {
    type: issueType,
    url: issueUrl,
    number: parseInt(issueNumber, 10) || issueNumber,
    title: fullTitle,
    labels: labels.split(','),
    body: fullBody,
    repo: CLEO_REPO,
    dryRun: false,
  };
}
