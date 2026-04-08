/**
 * CLI backup command - add, list, and export backups.
 *
 * @task T4454
 * @task T4903
 * @task T306 — added --global flag to backup add; --scope filter to backup list (epic T299)
 * @task T359 — added `cleo backup export` subcommand (epic T311)
 */

import readline from 'node:readline';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

// ---------------------------------------------------------------------------
// Internal helper — passphrase prompt (TTY only; agents use env var)
// ---------------------------------------------------------------------------

/**
 * Prompt for a passphrase on stdin (TTY) without echoing input.
 *
 * Agents MUST set `CLEO_BACKUP_PASSPHRASE` instead of relying on this prompt
 * because they typically run without a TTY.
 *
 * @returns The trimmed passphrase string entered by the user.
 * @throws {Error} When stdin is not a TTY (non-interactive / agent context).
 *
 * @task T359
 * @epic T311
 */
async function promptPassphrase(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Cannot prompt for passphrase: stdin is not a TTY. ' +
        'Set the CLEO_BACKUP_PASSPHRASE environment variable for non-interactive use.',
    );
  }
  return new Promise<string>((resolve) => {
    process.stdout.write('Passphrase: ');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function registerBackupCommand(program: Command): void {
  const backup = program
    .command('backup')
    .description('Add backup of todo files or list available backups');

  backup
    .command('add')
    .alias('create')
    .description('Add a new backup of all CLEO data files')
    .option('--destination <dir>', 'Backup destination directory')
    .option('--global', 'Also snapshot global-tier databases (nexus.db)')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'backup',
        {
          type: 'snapshot',
          note: opts['destination'] ? `destination:${opts['destination']}` : undefined,
          includeGlobal: opts['global'] === true,
        },
        { command: 'backup' },
      );
    });

  backup
    .command('list')
    .description('List available backups')
    .option(
      '--scope <scope>',
      'Filter by backup scope: project, global, or all (default: all)',
      'all',
    )
    .action(async (opts: Record<string, unknown>) => {
      const scope = (opts['scope'] as string) || 'all';
      await dispatchFromCli(
        'query',
        'admin',
        'backup',
        {
          type: 'list',
          scope,
        },
        { command: 'backup' },
      );
    });

  // ---------------------------------------------------------------------------
  // cleo backup export <name> [--scope project|global|all] [--encrypt] [--out <path>]
  // ---------------------------------------------------------------------------

  /**
   * Export project + global state to a portable .cleobundle.tar.gz archive.
   *
   * Delegates to {@link packBundle} from `@cleocode/core/internal`. When
   * `--encrypt` is requested, the passphrase is read from the
   * `CLEO_BACKUP_PASSPHRASE` environment variable (agent-friendly) or prompted
   * interactively on a TTY.
   *
   * @task T359
   * @epic T311
   */
  backup
    .command('export <name>')
    .description('Export project + global state to a portable .cleobundle.tar.gz')
    .option('--scope <scope>', 'project | global | all', 'project')
    .option('--encrypt', 'Encrypt bundle with passphrase (AES-256-GCM via scrypt)')
    .option('--out <path>', 'Output bundle path (default: ./<name>[.enc].cleobundle.tar.gz)')
    .action(
      async (
        name: string,
        opts: { scope: string; encrypt?: boolean; out?: string },
      ): Promise<void> => {
        const scope = opts.scope as 'project' | 'global' | 'all';

        const { packBundle, getProjectRoot } = await import('@cleocode/core/internal');

        const includesProject = scope === 'project' || scope === 'all';
        const projectRoot = includesProject ? getProjectRoot() : undefined;

        let passphrase: string | undefined;
        if (opts.encrypt === true) {
          passphrase = process.env['CLEO_BACKUP_PASSPHRASE'];
          if (!passphrase) {
            try {
              passphrase = await promptPassphrase();
            } catch (promptErr) {
              const msg = promptErr instanceof Error ? promptErr.message : String(promptErr);
              process.stderr.write(
                JSON.stringify({ success: false, error: { code: 6, message: msg } }) + '\n',
              );
              process.exitCode = 6;
              return;
            }
          }
          if (!passphrase) {
            process.stderr.write(
              JSON.stringify({
                success: false,
                error: { code: 6, message: '--encrypt requires a passphrase' },
              }) + '\n',
            );
            process.exitCode = 6;
            return;
          }
        }

        const encSuffix = opts.encrypt === true ? 'enc.' : '';
        const outputPath = opts.out ?? `./${name}.${encSuffix}cleobundle.tar.gz`;

        try {
          const result = await packBundle({
            scope,
            projectRoot,
            outputPath,
            encrypt: opts.encrypt === true,
            passphrase,
            projectName: name,
          });
          process.stdout.write(
            JSON.stringify({
              ok: true,
              r: {
                bundlePath: result.bundlePath,
                size: result.size,
                fileCount: result.fileCount,
                scope,
                encrypted: opts.encrypt === true,
              },
            }) + '\n',
          );
          process.stderr.write(
            `Bundle written to ${result.bundlePath} (${result.size} bytes, ${result.fileCount} files)\n`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            JSON.stringify({ success: false, error: { code: 1, message } }) + '\n',
          );
          process.exitCode = 1;
        }
      },
    );

  // Default action: add backup
  backup.action(async () => {
    await dispatchFromCli('mutate', 'admin', 'backup', {}, { command: 'backup' });
  });
}
