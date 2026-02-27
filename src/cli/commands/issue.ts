/**
 * CLI issue command - file bug reports, feature requests, or questions to CLEO GitHub.
 * Supports subcommands: bug, feature, help, diagnostics.
 *
 * @task T4555
 * @epic T4545
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import {
  getTemplateForSubcommand,
  collectDiagnostics,
  buildIssueBody,
  checkGhCli,
  createGhIssue,
} from '../../core/issue/index.js';
import { execFileSync } from 'node:child_process';

const CLEO_REPO = 'kryptobaseddev/cleo';

/**
 * Register the issue command with all subcommands.
 * @task T4555
 */
export function registerIssueCommand(program: Command): void {
  const issueCmd = program
    .command('issue')
    .description('File bug reports, feature requests, or questions to CLEO GitHub repo');

  // Subcommand: bug
  issueCmd
    .command('bug')
    .description('File a bug report')
    .requiredOption('--title <title>', 'Issue title')
    .requiredOption('--body <body>', 'Issue description')
    .option('--severity <severity>', 'Severity level (Blocker, Major, Moderate, Minor)')
    .option('--area <area>', 'Affected area (cli, mcp, docs, tests, other)')
    .option('--open', 'Open issue in browser after creation')
    .option('--dry-run', 'Preview without filing')
    .action(async (opts: Record<string, unknown>) => {
      await handleIssueType('bug', opts);
    });

  // Subcommand: feature
  issueCmd
    .command('feature')
    .description('Request a new feature')
    .requiredOption('--title <title>', 'Issue title')
    .requiredOption('--body <body>', 'Issue description')
    .option('--area <area>', 'Affected area')
    .option('--open', 'Open issue in browser after creation')
    .option('--dry-run', 'Preview without filing')
    .action(async (opts: Record<string, unknown>) => {
      await handleIssueType('feature', opts);
    });

  // Subcommand: help
  issueCmd
    .command('help')
    .description('Ask a question')
    .requiredOption('--title <title>', 'Issue title')
    .requiredOption('--body <body>', 'Issue description')
    .option('--open', 'Open issue in browser after creation')
    .option('--dry-run', 'Preview without filing')
    .action(async (opts: Record<string, unknown>) => {
      await handleIssueType('help', opts);
    });

  // Subcommand: diagnostics
  issueCmd
    .command('diagnostics')
    .description('Show system diagnostics (no issue filed)')
    .action(async () => {
      try {
        const diag = collectDiagnostics();
        cliOutput({ diagnostics: diag }, { command: 'issue' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}

/**
 * Handle issue creation for a subcommand type (bug, feature, help).
 * @task T4555
 */
async function handleIssueType(
  issueType: string,
  opts: Record<string, unknown>,
): Promise<void> {
  try {
    const title = opts['title'] as string;
    const body = opts['body'] as string;
    const severity = opts['severity'] as string | undefined;
    const area = opts['area'] as string | undefined;
    const dryRun = !!opts['dryRun'];

    // Get template-driven label and title prefix
    const template = getTemplateForSubcommand(issueType);
    const labels = template?.labels?.join(',') ?? issueType;
    const titlePrefix = template?.title ?? '';
    const fullTitle = titlePrefix ? `${titlePrefix}${title}` : title;

    // Build structured body
    const fullBody = buildIssueBody(issueType, body, severity, area);

    if (dryRun) {
      cliOutput({
        dryRun: true,
        type: issueType,
        repo: CLEO_REPO,
        title: fullTitle,
        labels: labels.split(','),
        body: fullBody,
      }, { command: 'issue' });
      return;
    }

    checkGhCli();
    const issueUrl = createGhIssue(fullTitle, fullBody, labels);
    const issueNumber = issueUrl.match(/(\d+)$/)?.[1] ?? 'unknown';

    if (opts['open'] && issueUrl.startsWith('https://')) {
      try {
        execFileSync('gh', ['issue', 'view', issueNumber, '--repo', CLEO_REPO, '--web'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // Browser open is non-fatal
      }
    }

    cliOutput({
      type: issueType,
      url: issueUrl,
      number: parseInt(issueNumber, 10) || issueNumber,
      title: fullTitle,
      labels: labels.split(','),
    }, { command: 'issue' });
  } catch (err) {
    if (err instanceof CleoError) {
      console.error(formatError(err));
      process.exit(err.code);
    }
    throw err;
  }
}
