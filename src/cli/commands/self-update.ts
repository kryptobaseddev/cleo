/**
 * CLI self-update command - check for and install updates.
 *
 * After updating, runs post-update diagnostics:
 *   - Pre-flight storage migration check
 *   - Auto-triggers upgrade if JSON data needs SQLite migration
 *
 * Designed for LLM agents: structured JSON output, actionable fix commands.
 *
 * @task T4699
 * @epic T4454
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoHome } from '../../core/paths.js';
import { checkStorageMigration } from '../../core/migration/preflight.js';
import { runUpgrade } from '../../core/upgrade.js';
import { readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(execFile);

const GITHUB_REPO = 'kryptobaseddev/cleo';

async function getCurrentVersion(): Promise<string> {
  const cleoHome = getCleoHome();
  try {
    const content = await readFile(join(cleoHome, 'VERSION'), 'utf-8');
    return content.trim();
  } catch {
    return 'unknown';
  }
}

async function isDevInstall(): Promise<boolean> {
  const cleoHome = getCleoHome();
  try {
    await access(join(cleoHome, '.git'), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function getLatestVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('curl', [
      '-sL',
      '--max-time', '10',
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    ]);
    const data = JSON.parse(stdout);
    return (data.tag_name as string)?.replace(/^v/, '') ?? null;
  } catch {
    return null;
  }
}

export function registerSelfUpdateCommand(program: Command): void {
  program
    .command('self-update')
    .description('Check for and install CLEO updates, then run post-update diagnostics')
    .option('--check', 'Only check if update is available')
    .option('--status', 'Show current vs latest version')
    .option('--version <ver>', 'Update to specific version')
    .option('--force', 'Force update even if same version')
    .option('--post-update', 'Run post-update diagnostics and migration only')
    .option('--no-auto-upgrade', 'Skip automatic upgrade after update')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const noAutoUpgrade = opts['autoUpgrade'] === false; // Commander normalizes --no-auto-upgrade to autoUpgrade=false

        // --post-update: skip version check, just run diagnostics + upgrade
        if (opts['postUpdate']) {
          await runPostUpdateDiagnostics({ skipUpgrade: noAutoUpgrade });
          return;
        }

        const currentVersion = await getCurrentVersion();
        const isDev = await isDevInstall();

        if (isDev && !opts['force']) {
          // For dev installs, still run post-update diagnostics
          const preflight = checkStorageMigration();
          cliOutput({
            devMode: true,
            currentVersion,
            message: 'Dev install detected. Use git pull to update.',
            storagePreflight: {
              migrationNeeded: preflight.migrationNeeded,
              summary: preflight.summary,
              fix: preflight.fix,
            },
          }, { command: 'self-update' });
          if (preflight.migrationNeeded) {
            process.stderr.write(
              `\n⚠ Storage migration needed: ${preflight.summary}\n`
              + `  Fix: ${preflight.fix}\n`
              + `  Or run: cleo upgrade\n\n`,
            );
          }
          process.exit(ExitCode.NO_DATA);
          return;
        }

        if (opts['status'] || opts['check']) {
          const latest = await getLatestVersion();
          if (!latest) {
            throw new CleoError(ExitCode.DEPENDENCY_ERROR, 'Failed to check latest version from GitHub');
          }

          const updateAvailable = latest !== currentVersion;
          const preflight = checkStorageMigration();

          cliOutput({
            currentVersion,
            latestVersion: latest,
            updateAvailable,
            storagePreflight: {
              migrationNeeded: preflight.migrationNeeded,
              summary: preflight.summary,
              fix: preflight.fix,
            },
          }, { command: 'self-update' });

          if (opts['check'] && updateAvailable) {
            process.exit(1); // exit 1 means update available for scripting
          }
          return;
        }

        // Actual update - delegated to shell for file system operations
        const latest = opts['version'] as string ?? await getLatestVersion();
        if (!latest) {
          throw new CleoError(ExitCode.DEPENDENCY_ERROR, 'Failed to check latest version from GitHub');
        }

        if (latest === currentVersion && !opts['force']) {
          // Up to date - still run post-update diagnostics
          await runPostUpdateDiagnostics({ skipUpgrade: noAutoUpgrade });
          cliOutput({
            currentVersion,
            upToDate: true,
          }, { command: 'self-update', message: 'Already up to date' });
          return;
        }

        // For the TS port, self-update delegates the heavy lifting
        // to the install script since we need to replace files on disk
        cliOutput({
          currentVersion,
          targetVersion: latest,
          message: 'Run the install script to update: curl -fsSL https://raw.githubusercontent.com/kryptobaseddev/cleo/main/install.sh | bash',
          postUpdate: 'After updating, run: cleo self-update --post-update',
        }, { command: 'self-update' });
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
 * Run post-update diagnostics and auto-upgrade.
 *
 * Called after a version update to detect and fix:
 *   - JSON→SQLite storage migration
 *   - Schema version mismatches
 *   - Structural data repairs
 *
 * @task T4699
 */
async function runPostUpdateDiagnostics(opts?: { skipUpgrade?: boolean }): Promise<void> {
  const preflight = checkStorageMigration();

  if (preflight.migrationNeeded) {
    if (opts?.skipUpgrade) {
      process.stderr.write(
        `\n⚠ Storage migration detected: ${preflight.summary}\n`
        + `  Auto-upgrade skipped (--no-auto-upgrade).\n`
        + `  Run manually: cleo upgrade\n\n`,
      );
      cliOutput({
        postUpdate: true,
        upgradeSkipped: true,
        storagePreflight: {
          migrationNeeded: true,
          summary: preflight.summary,
          fix: preflight.fix,
        },
      }, { command: 'self-update', message: 'Post-update upgrade skipped.' });
      return;
    }

    process.stderr.write(
      `\n⚠ Storage migration detected: ${preflight.summary}\n`
      + `  Running automatic upgrade...\n\n`,
    );

    const result = await runUpgrade({ autoMigrate: true });

    // Show structured output of each action taken
    if (result.actions.length > 0) {
      process.stderr.write('Upgrade actions:\n');
      for (const action of result.actions) {
        const icon = action.status === 'applied' ? '  ✓' : action.status === 'error' ? '  ✗' : '  -';
        process.stderr.write(`${icon} ${action.action}: ${action.details}\n`);
      }
      process.stderr.write('\n');
    }

    cliOutput({
      postUpdate: true,
      upgrade: {
        success: result.success,
        applied: result.applied,
        actions: result.actions,
        storageMigration: result.storageMigration,
        errors: result.errors.length > 0 ? result.errors : undefined,
      },
    }, { command: 'self-update', message: result.success ? 'Post-update upgrade complete.' : 'Post-update upgrade had errors.' });

    if (!result.success) {
      process.stderr.write(
        `\n⚠ Some upgrade steps failed. Manual fix:\n`
        + `  ${preflight.fix}\n\n`,
      );
    }
  } else {
    cliOutput({
      postUpdate: true,
      storagePreflight: {
        migrationNeeded: false,
        summary: preflight.summary,
      },
    }, { command: 'self-update', message: 'No post-update actions needed.' });
  }
}
