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
  collectDiagnostics,
  addIssue,
} from '../../core/issue/index.js';
import { execFileSync } from 'node:child_process';
import { BUILD_CONFIG } from '../../config/build-config.js';

const CLEO_REPO = BUILD_CONFIG.repository.fullName;

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
 * Uses shared addIssue from core to ensure DRY principle.
 * @task T4555
 */
async function handleIssueType(
  issueType: string,
  opts: Record<string, unknown>,
): Promise<void> {
  try {
    // Use the shared addIssue function from core
    const result = addIssue({
      issueType,
      title: opts['title'] as string,
      body: opts['body'] as string,
      severity: opts['severity'] as string | undefined,
      area: opts['area'] as string | undefined,
      dryRun: !!opts['dryRun'],
    });

    if (result.dryRun) {
      cliOutput({
        dryRun: true,
        type: result.type,
        repo: result.repo,
        title: result.title,
        labels: result.labels,
        body: result.body,
      }, { command: 'issue' });
      return;
    }

    // Handle browser open if requested
    if (opts['open'] && result.url?.startsWith('https://')) {
      const issueNumber = result.url.match(/(\d+)$/)?.[1] ?? 'unknown';
      try {
        execFileSync('gh', ['issue', 'view', issueNumber, '--repo', CLEO_REPO, '--web'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // Browser open is non-fatal
      }
    }

    cliOutput({
      type: result.type,
      url: result.url,
      number: result.number,
      title: result.title,
      labels: result.labels,
    }, { command: 'issue' });
  } catch (err) {
    if (err instanceof CleoError) {
      console.error(formatError(err));
      process.exit(err.code);
    }
    throw err;
  }
}
