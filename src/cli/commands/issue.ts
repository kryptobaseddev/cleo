/**
 * CLI issue command - file bug reports, feature requests, or questions to CLEO GitHub.
 * Supports subcommands: bug, feature, help, diagnostics.
 *
 * @task T4555
 * @epic T4545
 */

import { Command } from 'commander';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';
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
      await dispatchFromCli('query', 'tools', 'issue.diagnostics', {}, {
        command: 'issue',
        operation: 'tools.issue.diagnostics',
      });
    });
}

/**
 * Handle issue creation for a subcommand type (bug, feature, help).
 * Routes through dispatch for the mutation, with post-dispatch browser open.
 * @task T4555
 */
async function handleIssueType(
  issueType: string,
  opts: Record<string, unknown>,
): Promise<void> {
  const params: Record<string, unknown> = {
    issueType,
    title: opts['title'],
    body: opts['body'],
    dryRun: !!opts['dryRun'],
  };
  if (opts['severity']) params['severity'] = opts['severity'];
  if (opts['area']) params['area'] = opts['area'];

  const opName = `issue.add.${issueType}` as const;
  const response = await dispatchRaw('mutate', 'tools', opName, params);
  if (!response.success) {
    handleRawError(response, { command: 'issue', operation: `tools.${opName}` });
    return;
  }

  const result = response.data as Record<string, unknown>;

  // Handle browser open if requested
  if (opts['open'] && typeof result['url'] === 'string' && result['url'].startsWith('https://')) {
    const issueNumber = (result['url'] as string).match(/(\d+)$/)?.[1] ?? 'unknown';
    try {
      execFileSync('gh', ['issue', 'view', issueNumber, '--repo', CLEO_REPO, '--web'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // Browser open is non-fatal
    }
  }

  cliOutput(result, { command: 'issue', operation: `tools.${opName}` });
}
