/**
 * CLI backup command — add, list, export, import, and inspect backups.
 *
 * @task T4454
 * @task T4903
 * @task T306 — added --global flag to backup add; --scope filter to backup list (epic T299)
 * @task T359 — added `cleo backup export` subcommand (epic T311)
 * @task T361 — added `cleo backup import` subcommand with A/B restore and conflict report (epic T311)
 * @task T363 — added `backup inspect` subcommand (epic T311)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { backupInspectSubCommand } from './backup-inspect.js';

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

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/**
 * `cleo backup add` — snapshot all CLEO data files.
 *
 * Also aliased as `cleo backup create` via the duplicate `subCommands.create`
 * key on the root backup command.
 *
 * @task T306
 * @epic T299
 */
const addCommand = defineCommand({
  meta: {
    name: 'add',
    description:
      'Add a new backup of all CLEO data files (backup create is an alias for backup add)',
  },
  args: {
    destination: {
      type: 'string',
      description: 'Backup destination directory',
    },
    global: {
      type: 'boolean',
      description: 'Also snapshot global-tier databases (nexus.db)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'admin',
      'backup',
      {
        type: 'snapshot',
        note: args.destination ? `destination:${args.destination}` : undefined,
        includeGlobal: args.global === true,
      },
      { command: 'backup' },
    );
  },
});

/**
 * `cleo backup list` — list available backups.
 *
 * @task T306
 * @epic T299
 */
const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List available backups',
  },
  args: {
    scope: {
      type: 'string',
      description: 'Filter by backup scope: project, global, or all (default: all)',
      default: 'all',
    },
  },
  async run({ args }) {
    const scope = args.scope || 'all';
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
  },
});

/**
 * `cleo backup export <name>` — export project + global state to a portable archive.
 *
 * Delegates to `packBundle` from `@cleocode/core/internal`. When `--encrypt`
 * is requested, the passphrase is read from the `CLEO_BACKUP_PASSPHRASE`
 * environment variable (agent-friendly) or prompted interactively on a TTY.
 *
 * @task T359
 * @epic T311
 */
const exportCommand = defineCommand({
  meta: {
    name: 'export',
    description: 'Export project + global state to a portable .cleobundle.tar.gz',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Bundle name (used as filename stem)',
      required: true,
    },
    scope: {
      type: 'string',
      description: 'project | global | all',
      default: 'project',
    },
    encrypt: {
      type: 'boolean',
      description: 'Encrypt bundle with passphrase (AES-256-GCM via scrypt)',
    },
    out: {
      type: 'string',
      description: 'Output bundle path (default: ./<name>[.enc].cleobundle.tar.gz)',
    },
  },
  async run({ args }): Promise<void> {
    const scope = args.scope as 'project' | 'global' | 'all';

    const { packBundle, getProjectRoot } = await import('@cleocode/core/internal');

    const includesProject = scope === 'project' || scope === 'all';
    const projectRoot = includesProject ? getProjectRoot() : undefined;

    let passphrase: string | undefined;
    if (args.encrypt === true) {
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

    const encSuffix = args.encrypt === true ? 'enc.' : '';
    const outputPath = args.out ?? `./${args.name}.${encSuffix}cleobundle.tar.gz`;

    try {
      const result = await packBundle({
        scope,
        projectRoot,
        outputPath,
        encrypt: args.encrypt === true,
        passphrase,
        projectName: args.name,
      });
      process.stdout.write(
        JSON.stringify({
          ok: true,
          r: {
            bundlePath: result.bundlePath,
            size: result.size,
            fileCount: result.fileCount,
            scope,
            encrypted: args.encrypt === true,
          },
        }) + '\n',
      );
      process.stderr.write(
        `Bundle written to ${result.bundlePath} (${result.size} bytes, ${result.fileCount} files)\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(JSON.stringify({ success: false, error: { code: 1, message } }) + '\n');
      process.exitCode = 1;
    }
  },
});

/**
 * `cleo backup import <bundle>` — import a `.cleobundle.tar.gz` into the current project.
 *
 * Flow (spec §5.2):
 *   1. Pre-check for existing live data files (unless --force).
 *   2. Detect encryption from bundle header bytes.
 *   3. Unpack + verify all 6 integrity layers via `unpackBundle`.
 *   4. Copy DBs atomically to target paths; clear WAL sidecars.
 *   5. Run A/B regenerate-and-compare for each JSON file.
 *   6. Write .cleo/restore-conflicts.md.
 *   7. Move raw imported JSON files to .cleo/restore-imported/.
 *   8. Log completion.
 *
 * @task T361
 * @epic T311
 */
const importCommand = defineCommand({
  meta: {
    name: 'import',
    description: 'Import a .cleobundle.tar.gz into the current project (and/or global tier)',
  },
  args: {
    bundle: {
      type: 'positional',
      description: 'Path to the .cleobundle.tar.gz file',
      required: true,
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing live data at target without aborting',
    },
  },
  async run({ args }): Promise<void> {
    const bundlePath = args.bundle;
    const core = await import('@cleocode/core/internal');

    const projectRoot = core.getProjectRoot();

    // -----------------------------------------------------------------------
    // Step 1: Pre-check existing data (skip when --force)
    // -----------------------------------------------------------------------
    if (args.force !== true) {
      const existing = checkForExistingData(projectRoot, core.getCleoHome());
      if (existing.length > 0) {
        process.stderr.write(
          JSON.stringify({
            success: false,
            error: {
              code: 78,
              codeName: 'E_DATA_EXISTS',
              message: `Target has existing data: ${existing.join(', ')}. Use --force to overwrite.`,
            },
          }) + '\n',
        );
        process.exitCode = 78;
        return;
      }
    }

    // -----------------------------------------------------------------------
    // Step 2: Detect encryption from bundle header
    // -----------------------------------------------------------------------
    let passphrase: string | undefined;
    if (isBundleEncrypted(bundlePath)) {
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
    }

    // -----------------------------------------------------------------------
    // Step 3: Unpack + verify (layers 1–6 delegated to unpackBundle)
    // -----------------------------------------------------------------------
    let result: Awaited<ReturnType<typeof core.unpackBundle>>;
    try {
      result = await core.unpackBundle({ bundlePath, passphrase });
    } catch (err) {
      if (err instanceof core.BundleError) {
        process.stderr.write(
          JSON.stringify({
            success: false,
            error: { code: err.code, codeName: err.codeName, message: err.message },
          }) + '\n',
        );
        process.exitCode = err.code;
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(JSON.stringify({ success: false, error: { code: 1, message } }) + '\n');
      process.exitCode = 1;
      return;
    }

    const { stagingDir, manifest, warnings } = result;

    try {
      // -----------------------------------------------------------------------
      // Step 4: Atomic DB restore — copy + clear WAL sidecars
      // -----------------------------------------------------------------------
      for (const dbEntry of manifest.databases) {
        const src = path.join(stagingDir, dbEntry.filename);
        if (!fs.existsSync(src)) continue;
        const dst = resolveDbTarget(projectRoot, dbEntry.name, core.getCleoHome());
        fs.mkdirSync(path.dirname(dst), { recursive: true });

        // Atomic: write to tmp then rename
        const tmpDst = `${dst}.import-tmp-${Date.now()}`;
        fs.copyFileSync(src, tmpDst);
        fs.renameSync(tmpDst, dst);

        // Clear stale WAL sidecars
        for (const sidecar of [`${dst}-wal`, `${dst}-shm`]) {
          if (fs.existsSync(sidecar)) {
            try {
              fs.unlinkSync(sidecar);
            } catch {
              // best-effort
            }
          }
        }
      }

      // -----------------------------------------------------------------------
      // Step 5: A/B regenerate-and-compare for JSON files
      // -----------------------------------------------------------------------
      const jsonReports: Array<ReturnType<typeof core.regenerateAndCompare>> = [];

      for (const jsonEntry of manifest.json) {
        const importedPath = path.join(stagingDir, jsonEntry.filename);
        if (!fs.existsSync(importedPath)) continue;

        const imported: unknown = JSON.parse(fs.readFileSync(importedPath, 'utf-8'));

        // manifest json filenames may include a path prefix (e.g. "json/config.json").
        // Extract only the basename to match the FilenameForRestore constraint.
        const basename = path.basename(jsonEntry.filename) as
          | 'config.json'
          | 'project-info.json'
          | 'project-context.json';

        let localGenerated: unknown;
        if (basename === 'config.json') {
          localGenerated = core.regenerateConfigJson(projectRoot).content;
        } else if (basename === 'project-info.json') {
          localGenerated = core.regenerateProjectInfoJson(projectRoot).content;
        } else {
          localGenerated = core.regenerateProjectContextJson(projectRoot).content;
        }

        const report = core.regenerateAndCompare({
          filename: basename,
          imported,
          localGenerated,
        });
        jsonReports.push(report);

        // Write the applied merge to disk (always to .cleo/<basename>)
        const targetPath = path.join(projectRoot, '.cleo', basename);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, JSON.stringify(report.applied, null, 2), 'utf-8');
      }

      // -----------------------------------------------------------------------
      // Step 6: Write .cleo/restore-conflicts.md
      // -----------------------------------------------------------------------
      const cleoVersion = core.getCleoVersion();
      const conflictMd = core.buildConflictReport({
        reports: jsonReports,
        bundlePath,
        sourceMachineFingerprint: manifest.backup.machineFingerprint,
        targetMachineFingerprint: sha256OfMachineKey(core.getCleoHome()),
        cleoVersion,
        schemaWarnings: warnings.map((w) => ({
          db: w.db,
          bundleVersion: w.bundleVersion,
          localVersion: w.localVersion,
          severity: w.severity,
        })),
      });
      core.writeConflictReport(projectRoot, conflictMd);

      // -----------------------------------------------------------------------
      // Step 7: Move raw imported JSON files to .cleo/restore-imported/
      // -----------------------------------------------------------------------
      const importedDir = path.join(projectRoot, '.cleo', 'restore-imported');
      fs.mkdirSync(importedDir, { recursive: true });
      for (const jsonEntry of manifest.json) {
        const src = path.join(stagingDir, jsonEntry.filename);
        if (!fs.existsSync(src)) continue;
        // Preserve the bundle-relative path inside restore-imported/ so that
        // multiple imports with different prefixes do not collide.
        const dst = path.join(importedDir, jsonEntry.filename);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }

      // -----------------------------------------------------------------------
      // Step 8: Log completion
      // -----------------------------------------------------------------------
      const totalConflicts = jsonReports.reduce((sum, r) => sum + r.conflictCount, 0);
      const conflictReportPath = path.join(projectRoot, '.cleo', 'restore-conflicts.md');

      process.stdout.write(
        JSON.stringify({
          ok: true,
          r: {
            imported: bundlePath,
            dbsRestored: manifest.databases.length,
            jsonReports: jsonReports.map((r) => ({
              filename: r.filename,
              conflicts: r.conflictCount,
            })),
            totalConflicts,
            conflictReportPath,
          },
        }) + '\n',
      );

      if (totalConflicts > 0) {
        process.stderr.write(
          `Restore complete with ${totalConflicts} unresolved conflict(s). ` +
            `Run 'cleo restore finalize' after resolving ${conflictReportPath}\n`,
        );
      } else {
        process.stderr.write(`Restore complete. Review ${conflictReportPath} for details.\n`);
      }
    } catch (restoreErr) {
      // Surface mid-restore errors with exit code 79 (E_RESTORE_PARTIAL)
      const message = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      process.stderr.write(
        JSON.stringify({
          success: false,
          error: { code: 79, codeName: 'E_RESTORE_PARTIAL', message },
        }) + '\n',
      );
      process.exitCode = 79;
    } finally {
      // Always clean up staging dir regardless of success or failure
      core.cleanupStaging(stagingDir);
    }
  },
});

// ---------------------------------------------------------------------------
// Root backup command
// ---------------------------------------------------------------------------

/**
 * Root backup command group — add, list, export, import, and inspect backups.
 *
 * The `create` key duplicates `add` to preserve backward-compatible alias behaviour.
 * The `bak` key provides the top-level alias.
 *
 * Default action (no subcommand): snapshot all CLEO data files.
 *
 * @task T4454
 * @task T4903
 */
export const backupCommand = defineCommand({
  meta: {
    name: 'backup',
    description: 'Add backup of todo files or list available backups',
  },
  subCommands: {
    add: addCommand,
    // 'create' is an alias for 'add' (citty duplicate-key pattern)
    create: addCommand,
    list: listCommand,
    export: exportCommand,
    import: importCommand,
    inspect: backupInspectSubCommand,
  },
  async run() {
    await dispatchFromCli('mutate', 'admin', 'backup', {}, { command: 'backup' });
  },
});

// ---------------------------------------------------------------------------
// T361 private helpers
// ---------------------------------------------------------------------------

/**
 * Returns the list of live CLEO data files that already exist at the target.
 *
 * Checks both project-tier files (`.cleo/<name>`) and global-tier databases
 * (`$XDG_DATA_HOME/cleo/<name>.db`). An empty array means the target is fresh.
 *
 * @param projectRoot - Absolute path to the current project root.
 * @param cleoHome    - Absolute path to the global CLEO home directory.
 * @returns Array of relative (project) or absolute (global) paths that exist.
 *
 * @task T361
 * @epic T311
 */
function checkForExistingData(projectRoot: string, cleoHome: string): string[] {
  const projectFiles = [
    '.cleo/tasks.db',
    '.cleo/brain.db',
    '.cleo/conduit.db',
    '.cleo/config.json',
    '.cleo/project-info.json',
    '.cleo/project-context.json',
  ];
  const globalFiles = ['nexus.db', 'signaldock.db'];

  const found: string[] = [];
  for (const f of projectFiles) {
    if (fs.existsSync(path.join(projectRoot, f))) found.push(f);
  }
  for (const f of globalFiles) {
    const abs = path.join(cleoHome, f);
    if (fs.existsSync(abs)) found.push(abs);
  }
  return found;
}

/**
 * Resolve the absolute destination path for a named database.
 *
 * Global-tier databases (`nexus`, `signaldock`) are stored under `cleoHome`.
 * All other databases are stored under `<projectRoot>/.cleo/`.
 *
 * @param projectRoot - Absolute path to the current project root.
 * @param name        - Logical database name from the manifest (e.g. `"tasks"`).
 * @param cleoHome    - Absolute path to the global CLEO home directory.
 * @returns Absolute path for the destination `.db` file.
 *
 * @task T361
 * @epic T311
 */
function resolveDbTarget(projectRoot: string, name: string, cleoHome: string): string {
  if (name === 'nexus' || name === 'signaldock') {
    return path.join(cleoHome, `${name}.db`);
  }
  return path.join(projectRoot, '.cleo', `${name}.db`);
}

/**
 * Detect whether a bundle file is encrypted by inspecting its first 8 bytes.
 *
 * Reads the 8-byte magic header from the bundle file on disk and delegates to
 * the same detection logic used inside `unpackBundle`.
 *
 * Magic: `CLEOENC1` (ASCII) at offset 0 indicates an encrypted bundle.
 *
 * @param bundlePath - Absolute path to the bundle file.
 * @returns `true` when the bundle header matches the CLEOENC1 magic string.
 *
 * @task T361
 * @epic T311
 */
function isBundleEncrypted(bundlePath: string): boolean {
  try {
    const header = Buffer.alloc(8);
    const fd = fs.openSync(bundlePath, 'r');
    fs.readSync(fd, header, 0, 8, 0);
    fs.closeSync(fd);
    return header.toString('utf8') === 'CLEOENC1';
  } catch {
    // If the file cannot be read, treat as unencrypted — unpackBundle will
    // surface any real errors during the full verification pass.
    return false;
  }
}

/**
 * Compute SHA-256 of the local machine-key file at `<cleoHome>/machine-key`.
 *
 * Returns a placeholder hash of all zeros when the machine-key file does not
 * yet exist (fresh installation, no key generated).
 *
 * @param cleoHome - Absolute path to the global CLEO home directory.
 * @returns 64-character lowercase hex SHA-256 string.
 *
 * @task T361
 * @epic T311
 */
function sha256OfMachineKey(cleoHome: string): string {
  const keyPath = path.join(cleoHome, 'machine-key');
  if (!fs.existsSync(keyPath)) {
    return '0'.repeat(64);
  }
  return crypto.createHash('sha256').update(fs.readFileSync(keyPath)).digest('hex');
}
