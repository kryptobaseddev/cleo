/**
 * CLI command group for filing bug reports, feature requests, and questions to the CLEO GitHub repo.
 *
 * Supports subcommands:
 *   cleo issue bug         — file a bug report
 *   cleo issue feature     — request a new feature
 *   cleo issue help        — ask a question
 *   cleo issue diagnostics — show system diagnostics (no issue filed)
 *
 * Fix #63: Calls addIssue() from core directly (the tools.issue.add.*
 * operations were removed from the registry in T5615).
 *
 * @task T4555
 * @epic T4545
 */

import { execFileSync } from 'node:child_process';
import { type AddIssueResult, addIssue, BUILD_CONFIG } from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

const CLEO_REPO = BUILD_CONFIG.repository.fullName;

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

/** cleo issue bug — file a bug report */
const bugCommand = defineCommand({
  meta: { name: 'bug', description: 'File a bug report' },
  args: {
    title: { type: 'string', description: 'Issue title', required: true },
    body: { type: 'string', description: 'Issue description', required: true },
    severity: {
      type: 'string',
      description: 'Severity level (Blocker, Major, Moderate, Minor)',
    },
    area: { type: 'string', description: 'Affected area (cli, dispatch, docs, tests, other)' },
    open: { type: 'boolean', description: 'Open issue in browser after creation' },
    'dry-run': { type: 'boolean', description: 'Preview without filing' },
  },
  async run({ args }) {
    await handleIssueType('bug', {
      title: args.title,
      body: args.body,
      severity: args.severity,
      area: args.area,
      open: args.open,
      dryRun: args['dry-run'],
    });
  },
});

/** cleo issue feature — request a new feature */
const featureCommand = defineCommand({
  meta: { name: 'feature', description: 'Request a new feature' },
  args: {
    title: { type: 'string', description: 'Issue title', required: true },
    body: { type: 'string', description: 'Issue description', required: true },
    area: { type: 'string', description: 'Affected area' },
    open: { type: 'boolean', description: 'Open issue in browser after creation' },
    'dry-run': { type: 'boolean', description: 'Preview without filing' },
  },
  async run({ args }) {
    await handleIssueType('feature', {
      title: args.title,
      body: args.body,
      area: args.area,
      open: args.open,
      dryRun: args['dry-run'],
    });
  },
});

/** cleo issue help — ask a question */
const helpCommand = defineCommand({
  meta: { name: 'help', description: 'Ask a question' },
  args: {
    title: { type: 'string', description: 'Issue title', required: true },
    body: { type: 'string', description: 'Issue description', required: true },
    open: { type: 'boolean', description: 'Open issue in browser after creation' },
    'dry-run': { type: 'boolean', description: 'Preview without filing' },
  },
  async run({ args }) {
    await handleIssueType('help', {
      title: args.title,
      body: args.body,
      open: args.open,
      dryRun: args['dry-run'],
    });
  },
});

/** cleo issue diagnostics — show system diagnostics without filing an issue */
const diagnosticsCommand = defineCommand({
  meta: { name: 'diagnostics', description: 'Show system diagnostics (no issue filed)' },
  async run() {
    await dispatchFromCli(
      'query',
      'tools',
      'issue.diagnostics',
      {},
      { command: 'issue', operation: 'tools.issue.diagnostics' },
    );
  },
});

/**
 * Root issue command group — file bug reports, feature requests, or questions to the CLEO GitHub repo.
 *
 * Dispatches bug/feature/help subcommands via addIssue() from core (Fix #63).
 * Diagnostics route through dispatchFromCli.
 */
export const issueCommand = defineCommand({
  meta: {
    name: 'issue',
    description: 'File bug reports, feature requests, or questions to CLEO GitHub repo',
  },
  subCommands: {
    bug: bugCommand,
    feature: featureCommand,
    help: helpCommand,
    diagnostics: diagnosticsCommand,
  },
});
