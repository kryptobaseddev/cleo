/**
 * CLI issue command - file bug reports, feature requests, or questions to CLEO GitHub.
 * Supports subcommands: bug, feature, help, diagnostics.
 *
 * @task T4555
 * @epic T4545
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import {
  getTemplateForSubcommand,
} from '../../core/issue/index.js';
import { execFileSync } from 'node:child_process';
import { platform, release, arch } from 'node:os';

const CLEO_REPO = 'kryptobaseddev/cleo';

/**
 * Collect system diagnostics for bug reports.
 * @task T4555
 */
function collectDiagnostics(): Record<string, string> {
  const getVersion = (cmd: string, args: string[]): string => {
    try {
      return execFileSync(cmd, args, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return 'not installed';
    }
  };

  const cleoLocation = getVersion('which', ['cleo']);
  const ghVersion = getVersion('gh', ['--version']).split('\n')[0] ?? 'not installed';

  return {
    cleoVersion: '2026.2.1',
    nodeVersion: process.version,
    os: `${platform()} ${release()} ${arch()}`,
    shell: process.env['SHELL'] ?? 'unknown',
    cleoHome: process.env['CLEO_HOME'] ?? `${process.env['HOME']}/.cleo`,
    ghVersion,
    installLocation: cleoLocation || 'not found',
  };
}

/**
 * Format diagnostics as markdown table.
 * @task T4555
 */
function formatDiagnosticsTable(diag: Record<string, string>): string {
  const rows = [
    '## Environment',
    '| Component | Version |',
    '|-----------|---------|',
    `| CLEO | ${diag.cleoVersion} |`,
    `| Node.js | ${diag.nodeVersion} |`,
    `| OS | ${diag.os} |`,
    `| Shell | ${diag.shell} |`,
    `| gh CLI | ${diag.ghVersion} |`,
    `| Install | ${diag.installLocation} |`,
  ];
  return rows.join('\n');
}

/**
 * Build structured issue body with template sections.
 * @task T4555
 */
function buildIssueBody(
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
 * @task T4555
 */
function checkGhCli(): void {
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
 * Create a GitHub issue via gh CLI.
 * @task T4555
 */
function createGhIssue(title: string, body: string, labels: string): string {
  try {
    const result = execFileSync('gh', [
      'issue', 'create',
      '--repo', CLEO_REPO,
      '--title', title,
      '--body', body,
      '--label', labels,
    ], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (err) {
    throw new CleoError(ExitCode.CONFIG_ERROR, `Failed to create issue: ${(err as Error).message}`, {
      fix: 'Check gh auth status and network connectivity',
    });
  }
}

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
        console.log(formatSuccess({ diagnostics: diag }));
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
      console.log(formatSuccess({
        dryRun: true,
        type: issueType,
        repo: CLEO_REPO,
        title: fullTitle,
        labels: labels.split(','),
        body: fullBody,
      }));
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

    console.log(formatSuccess({
      type: issueType,
      url: issueUrl,
      number: parseInt(issueNumber, 10) || issueNumber,
      title: fullTitle,
      labels: labels.split(','),
    }));
  } catch (err) {
    if (err instanceof CleoError) {
      console.error(formatError(err));
      process.exit(err.code);
    }
    throw err;
  }
}
