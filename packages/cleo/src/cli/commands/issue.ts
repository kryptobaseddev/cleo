/**
 * CLI issue command - file bug reports, feature requests, or questions to CLEO GitHub.
 * Supports subcommands: bug, feature, help, diagnostics.
 *
 * Fix #63: Calls addIssue() from core directly (the tools.issue.add.*
 * operations were removed from the registry in T5615).
 *
 * @task T4555
 * @epic T4545
 */

import { execFileSync } from 'node:child_process';
import { type AddIssueResult, addIssue, BUILD_CONFIG } from '@cleocode/core/internal';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

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
    .option('--area <area>', 'Affected area (cli, dispatch, docs, tests, other)')
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
      await dispatchFromCli(
        'query',
        'tools',
        'issue.diagnostics',
        {},
        {
          command: 'issue',
          operation: 'tools.issue.diagnostics',
        },
      );
    });
}

/**
 * Handle issue creation for a subcommand type (bug, feature, help).
 * Calls addIssue() from core directly (Fix #63: operations were removed in T5615).
 * @task T4555
 */
async function handleIssueType(issueType: string, opts: Record<string, unknown>): Promise<void> {
  let result: AddIssueResult;
  try {
    result = addIssue({
      issueType,
      title: opts['title'] as string,
      body: opts['body'] as string,
      severity: opts['severity'] as string | undefined,
      area: opts['area'] as string | undefined,
      dryRun: !!opts['dryRun'],
    });
  } catch (err) {
    console.error(`Failed to create issue: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  // Handle browser open if requested
  if (opts['open'] && typeof result.url === 'string' && result.url.startsWith('https://')) {
    const issueNumber = result.url.match(/(\d+)$/)?.[1] ?? 'unknown';
    try {
      execFileSync('gh', ['issue', 'view', issueNumber, '--repo', CLEO_REPO, '--web'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // Browser open is non-fatal
    }
  }

  cliOutput(result, { command: 'issue', operation: `tools.issue.add.${issueType}` });
}
