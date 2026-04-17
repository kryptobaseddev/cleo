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

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { promisify } from 'node:util';
import { ExitCode } from '@cleocode/contracts';
import {
  BUILD_CONFIG,
  CleoError,
  checkStorageMigration,
  formatError,
  getCleoHome,
  getRuntimeDiagnostics,
  runUpgrade,
} from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { createSelfUpdateProgress } from '../progress.js';
import { cliOutput } from '../renderers/index.js';

const execAsync = promisify(execFile);

const GITHUB_REPO = BUILD_CONFIG.repository.fullName;

async function getCurrentVersion(): Promise<string> {
  const cleoHome = getCleoHome();
  try {
    const content = await readFile(join(cleoHome, 'VERSION'), 'utf-8');
    return (content.split('\n')[0] ?? 'unknown').trim();
  } catch {
    return 'unknown';
  }
}

async function getNpmInstalledVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('npm', [
      'ls',
      '-g',
      '@cleocode/cleo',
      '--depth=0',
      '--json',
    ]);
    const data = JSON.parse(stdout) as { dependencies?: Record<string, { version?: string }> };
    return data.dependencies?.['@cleocode/cleo']?.version ?? null;
  } catch {
    return null;
  }
}

async function getDistTagVersion(tag: 'latest' | 'beta'): Promise<string | null> {
  try {
    const { stdout } = await execAsync('npm', ['view', `@cleocode/cleo@${tag}`, 'version']);
    const v = stdout.trim();
    return v || null;
  } catch {
    // Fallback to GitHub latest for stable only
    if (tag === 'latest') {
      try {
        const { stdout } = await execAsync('curl', [
          '-sL',
          '--max-time',
          '10',
          `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        ]);
        const data = JSON.parse(stdout);
        return (data.tag_name as string)?.replace(/^v/, '') ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function writeRuntimeVersionMetadata(
  mode: 'prod-npm' | 'dev-ts',
  source: string,
  version: string,
): Promise<void> {
  const cleoHome = getCleoHome();
  const lines = [
    version,
    `mode=${mode}`,
    `source=${source}`,
    `installed=${new Date().toISOString()}`,
  ];
  await import('node:fs/promises').then(({ writeFile, mkdir }) =>
    mkdir(cleoHome, { recursive: true }).then(() =>
      writeFile(join(cleoHome, 'VERSION'), `${lines.join('\n')}\n`, 'utf-8'),
    ),
  );
}

/**
 * Native citty command for `cleo self-update`.
 *
 * Global output flags (--json, --human, --quiet) are declared in args so
 * citty parses them directly. This replaces the Commander.js optsWithGlobals()
 * pattern that is unavailable in native citty commands.
 */
export const selfUpdateCommand = defineCommand({
  meta: {
    name: 'self-update',
    description: 'Check for and install CLEO updates, then run post-update diagnostics',
  },
  args: {
    check: {
      type: 'boolean',
      description: 'Only check if update is available',
    },
    status: {
      type: 'boolean',
      description: 'Show current vs latest version',
    },
    version: {
      type: 'string',
      description: 'Update to specific version',
    },
    channel: {
      type: 'string',
      description: 'Update channel: stable|beta',
    },
    beta: {
      type: 'boolean',
      description: 'Shortcut for --channel beta',
    },
    force: {
      type: 'boolean',
      description: 'Force update even if same version',
    },
    'post-update': {
      type: 'boolean',
      description: 'Run post-update diagnostics and migration only',
    },
    'no-auto-upgrade': {
      type: 'boolean',
      description: 'Skip automatic upgrade after update',
    },
    'auto-migrate': {
      type: 'boolean',
      description: 'Automatically migrate storage without prompting',
    },
    // Global output format flags — read directly from args (no optsWithGlobals in citty)
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
    human: {
      type: 'boolean',
      description: 'Force human-readable output',
    },
    quiet: {
      type: 'boolean',
      description: 'Suppress non-essential output',
    },
  },
  async run({ args }) {
    const isHuman = args.human === true || (!!process.stdout.isTTY && args.json !== true);
    const progress = createSelfUpdateProgress(isHuman);

    try {
      const noAutoUpgrade = args['no-auto-upgrade'] === true;

      // --post-update: skip version check, just run diagnostics + upgrade
      if (args['post-update']) {
        progress.start();
        progress.step(4, 'Running post-update diagnostics');
        await runPostUpdateDiagnostics({
          skipUpgrade: noAutoUpgrade,
          autoMigrate: !!args['auto-migrate'] || !!args.force,
        });
        progress.complete('Post-update diagnostics complete');
        return;
      }

      progress.start();
      progress.step(0, 'Detecting installation type');
      const runtime = await getRuntimeDiagnostics();
      const script = runtime.invocation.script;
      const fromNodeModules =
        script.includes('/node_modules/@cleocode/cleo/') ||
        script.includes('\\node_modules\\@cleocode\\cleo\\');
      const isDev = runtime.channel === 'dev' && !fromNodeModules;

      progress.step(1, 'Checking current version');
      const currentVersion = isDev
        ? await getCurrentVersion()
        : ((await getNpmInstalledVersion()) ?? (await getCurrentVersion()));

      const rawChannel = (args.channel as string | undefined)?.toLowerCase();
      if (rawChannel && rawChannel !== 'stable' && rawChannel !== 'beta') {
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `Invalid --channel '${rawChannel}'. Expected stable|beta`,
        );
      }

      const requestedChannel: 'stable' | 'beta' = args.beta
        ? 'beta'
        : ((rawChannel as 'stable' | 'beta' | undefined) ??
          (runtime.channel === 'beta' ? 'beta' : 'stable'));

      if (isDev && !args.force) {
        // For dev installs, still run post-update diagnostics
        progress.step(4, 'Running post-update checks');
        const preflight = checkStorageMigration();
        cliOutput(
          {
            devMode: true,
            channel: runtime.channel,
            currentVersion,
            message: 'Dev install detected. Use git pull to update.',
            storagePreflight: {
              migrationNeeded: preflight.migrationNeeded,
              summary: preflight.summary,
              fix: preflight.fix,
            },
          },
          { command: 'self-update' },
        );
        if (preflight.migrationNeeded) {
          progress.error(`Storage migration needed: ${preflight.summary}`);
          process.stderr.write(
            `\n⚠ Storage migration needed: ${preflight.summary}\n` +
              `  Fix: ${preflight.fix}\n` +
              `  Or run: cleo upgrade\n\n`,
          );
        } else {
          progress.complete('Dev environment check complete');
        }
        process.exit(ExitCode.NO_DATA);
        return;
      }

      if (args.status || args.check) {
        progress.step(2, 'Querying npm registry');
        const latest = await getDistTagVersion(requestedChannel === 'beta' ? 'beta' : 'latest');
        if (!latest) {
          throw new CleoError(
            ExitCode.DEPENDENCY_ERROR,
            'Failed to check latest version from GitHub',
          );
        }

        progress.step(3, 'Comparing versions');
        const updateAvailable = latest !== currentVersion;
        const preflight = checkStorageMigration();

        cliOutput(
          {
            currentVersion,
            latestVersion: latest,
            channel: requestedChannel,
            updateAvailable,
            storagePreflight: {
              migrationNeeded: preflight.migrationNeeded,
              summary: preflight.summary,
              fix: preflight.fix,
            },
          },
          { command: 'self-update' },
        );

        if (args.check && updateAvailable) {
          process.exit(1); // exit 1 means update available for scripting
        }
        return;
      }

      // Actual update - delegated to shell for file system operations
      progress.step(2, 'Querying npm registry');
      const latest =
        (args.version as string | undefined) ??
        (await getDistTagVersion(requestedChannel === 'beta' ? 'beta' : 'latest'));
      if (!latest) {
        throw new CleoError(
          ExitCode.DEPENDENCY_ERROR,
          'Failed to check latest version from GitHub',
        );
      }

      progress.step(3, 'Comparing versions');
      if (latest === currentVersion && !args.force) {
        // Up to date - still run post-update diagnostics
        progress.step(4, 'Running post-update checks');
        await runPostUpdateDiagnostics({
          skipUpgrade: noAutoUpgrade,
          autoMigrate: !!args['auto-migrate'] || !!args.force,
        });
        progress.complete('Already up to date');
        cliOutput(
          {
            currentVersion,
            upToDate: true,
          },
          { command: 'self-update', message: 'Already up to date' },
        );
        return;
      }

      const spec = args.version
        ? `@cleocode/cleo@${latest}`
        : requestedChannel === 'beta'
          ? '@cleocode/cleo@beta'
          : '@cleocode/cleo@latest';

      progress.step(4, `Installing ${spec}`);
      await execAsync('npm', ['install', '-g', spec], { maxBuffer: 10 * 1024 * 1024 });
      await writeRuntimeVersionMetadata('prod-npm', 'npm', latest);

      progress.step(5, 'Finalizing');
      cliOutput(
        {
          currentVersion,
          targetVersion: latest,
          channel: requestedChannel,
          updated: true,
          command: `npm install -g ${spec}`,
        },
        { command: 'self-update', message: `Updated to ${latest}` },
      );

      await runPostUpdateDiagnostics({
        skipUpgrade: noAutoUpgrade,
        autoMigrate: !!args['auto-migrate'] || !!args.force,
      });
      progress.complete(`Updated to ${latest}`);
    } catch (err) {
      if (err instanceof CleoError) {
        progress.error(err.message);
        console.error(formatError(err));
        process.exit(err.code);
      }
      progress.error('Unexpected error during update');
      throw err;
    }
  },
});

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
async function runPostUpdateDiagnostics(opts?: {
  skipUpgrade?: boolean;
  autoMigrate?: boolean;
}): Promise<void> {
  const preflight = checkStorageMigration();

  if (preflight.migrationNeeded) {
    if (opts?.skipUpgrade) {
      process.stderr.write(
        `\n⚠ Storage migration detected: ${preflight.summary}\n` +
          `  Auto-upgrade skipped (--no-auto-upgrade).\n` +
          `  Run manually: cleo upgrade\n\n`,
      );
      cliOutput(
        {
          postUpdate: true,
          upgradeSkipped: true,
          storagePreflight: {
            migrationNeeded: true,
            summary: preflight.summary,
            fix: preflight.fix,
          },
        },
        { command: 'self-update', message: 'Post-update upgrade skipped.' },
      );
      return;
    }

    process.stderr.write(`\n⚠ Storage migration detected: ${preflight.summary}\n`);

    let shouldMigrate = !!opts?.autoMigrate;

    if (!shouldMigrate) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      shouldMigrate = await new Promise<boolean>((resolve) => {
        rl.question('  Do you want to run the upgrade now? [Y/n] ', (answer) => {
          rl.close();
          const clean = answer.trim().toLowerCase();
          resolve(clean === '' || clean === 'y' || clean === 'yes');
        });
      });
    }

    if (!shouldMigrate) {
      process.stderr.write(`\n  Upgrade skipped. Run manually later: cleo upgrade\n\n`);
      return;
    }

    process.stderr.write(`  Running upgrade...\n\n`);

    const result = await runUpgrade({ autoMigrate: true });

    // Show structured output of each action taken
    if (result.actions.length > 0) {
      process.stderr.write('Upgrade actions:\n');
      for (const action of result.actions) {
        const icon =
          action.status === 'applied' ? '  ✓' : action.status === 'error' ? '  ✗' : '  -';
        process.stderr.write(`${icon} ${action.action}: ${action.details}\n`);
      }
      process.stderr.write('\n');
    }

    cliOutput(
      {
        postUpdate: true,
        upgrade: {
          success: result.success,
          applied: result.applied,
          actions: result.actions,
          storageMigration: result.storageMigration,
          errors: result.errors.length > 0 ? result.errors : undefined,
        },
      },
      {
        command: 'self-update',
        message: result.success
          ? 'Post-update upgrade complete.'
          : 'Post-update upgrade had errors.',
      },
    );
    if (!result.success) {
      process.stderr.write(
        `\n⚠ Some upgrade steps failed. Manual fix:\n` + `  ${preflight.fix}\n\n`,
      );
    }
  } else {
    // No storage migration needed, but still run structural upgrade to ensure
    // all databases (brain.db, signaldock.db, conduit.db), adapters, schemas,
    // memory-bridge.md, and other scaffold items are up to date.
    if (!opts?.skipUpgrade) {
      const result = await runUpgrade({ autoMigrate: false });

      if (result.applied > 0 || result.errors.length > 0) {
        // Show structured output of each action taken
        if (result.actions.length > 0) {
          process.stderr.write('Post-update maintenance:\n');
          for (const action of result.actions) {
            if (action.status === 'skipped') continue;
            const icon =
              action.status === 'applied' ? '  ✓' : action.status === 'error' ? '  ✗' : '  -';
            process.stderr.write(`${icon} ${action.action}: ${action.details}\n`);
          }
          process.stderr.write('\n');
        }

        cliOutput(
          {
            postUpdate: true,
            upgrade: {
              success: result.success,
              applied: result.applied,
              actions: result.actions,
              errors: result.errors.length > 0 ? result.errors : undefined,
            },
          },
          {
            command: 'self-update',
            message: result.success
              ? `Post-update maintenance complete (${result.applied} action(s) applied).`
              : 'Post-update maintenance had errors.',
          },
        );
        return;
      }
    }

    cliOutput(
      {
        postUpdate: true,
        storagePreflight: {
          migrationNeeded: false,
          summary: preflight.summary,
        },
      },
      { command: 'self-update', message: 'No post-update actions needed.' },
    );
  }
}
