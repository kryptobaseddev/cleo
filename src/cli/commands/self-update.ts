/**
 * CLI self-update command - check for and install updates.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoHome } from '../../core/paths.js';
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
    .description('Check for and install CLEO updates')
    .option('--check', 'Only check if update is available')
    .option('--status', 'Show current vs latest version')
    .option('--version <ver>', 'Update to specific version')
    .option('--force', 'Force update even if same version')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const currentVersion = await getCurrentVersion();
        const isDev = await isDevInstall();

        if (isDev && !opts['force']) {
          console.log(formatSuccess({
            devMode: true,
            currentVersion,
            message: 'Dev install detected. Use git pull to update.',
          }));
          process.exit(ExitCode.NO_DATA);
          return;
        }

        if (opts['status'] || opts['check']) {
          const latest = await getLatestVersion();
          if (!latest) {
            throw new CleoError(ExitCode.DEPENDENCY_ERROR, 'Failed to check latest version from GitHub');
          }

          const updateAvailable = latest !== currentVersion;

          console.log(formatSuccess({
            currentVersion,
            latestVersion: latest,
            updateAvailable,
          }));

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
          console.log(formatSuccess({
            currentVersion,
            upToDate: true,
          }, 'Already up to date'));
          return;
        }

        // For the TS port, self-update delegates the heavy lifting
        // to the install script since we need to replace files on disk
        console.log(formatSuccess({
          currentVersion,
          targetVersion: latest,
          message: 'Run the install script to update: curl -fsSL https://raw.githubusercontent.com/kryptobaseddev/cleo/main/install.sh | bash',
        }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
