/**
 * CLI claude-migrate command - detect and migrate legacy installations.
 * Ported from scripts/claude-migrate.sh
 * @task T4551
 * @epic T4545
 */

import { Command } from 'commander';
import { stat, readdir, rename, cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoHome, getCleoDir } from '../../core/paths.js';

/** Legacy CLEO file names migrated from .claude/ */
const CLEO_FILES = ['todo.json', 'todo-config.json', 'todo-log.json', 'todo-log.jsonl', 'todo-archive.json'];

/** Detection result for a legacy path. */
interface DetectionResult {
  found: boolean;
  path: string;
  fileCount?: number;
  hasTodo?: boolean;
  hasConfig?: boolean;
  hasLog?: boolean;
  hasArchive?: boolean;
}

/** Detection result for legacy environment variables. */
interface EnvDetectionResult {
  found: boolean;
  count: number;
  variables: string[];
}

/**
 * Get the legacy global home directory path.
 * @task T4551
 */
function getLegacyGlobalHome(): string {
  return join(homedir(), '.claude-todo');
}

/**
 * Get the legacy project directory path.
 * @task T4551
 */
function getLegacyProjectDir(): string {
  return '.claude';
}

/**
 * Check if a path exists and is a directory.
 * @task T4551
 */
async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a file exists.
 * @task T4551
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Count files recursively in a directory.
 * @task T4551
 */
async function countFiles(dirPath: string): Promise<number> {
  let count = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile()) count++;
    }
  } catch {
    // ignore
  }
  return count;
}

/**
 * Detect legacy global installation.
 * @task T4551
 */
async function detectLegacyGlobal(): Promise<DetectionResult> {
  const legacyPath = getLegacyGlobalHome();
  if (!(await dirExists(legacyPath))) {
    return { found: false, path: legacyPath };
  }

  return {
    found: true,
    path: legacyPath,
    fileCount: await countFiles(legacyPath),
    hasTodo: await fileExists(join(legacyPath, 'todo.json')),
    hasConfig: await fileExists(join(legacyPath, 'todo-config.json')),
  };
}

/**
 * Detect legacy project directory.
 * @task T4551
 */
async function detectLegacyProject(): Promise<DetectionResult> {
  const legacyPath = getLegacyProjectDir();
  if (!(await dirExists(legacyPath))) {
    return { found: false, path: legacyPath };
  }

  return {
    found: true,
    path: legacyPath,
    fileCount: await countFiles(legacyPath),
    hasTodo: await fileExists(join(legacyPath, 'todo.json')),
    hasConfig: await fileExists(join(legacyPath, 'todo-config.json')),
    hasLog: await fileExists(join(legacyPath, 'todo-log.json')),
    hasArchive: await fileExists(join(legacyPath, 'todo-archive.json')),
  };
}

/**
 * Detect legacy environment variables.
 * @task T4551
 */
function detectLegacyEnv(): EnvDetectionResult {
  const legacyVars = ['CLAUDE_TODO_HOME', 'CLAUDE_TODO_DIR', 'CLAUDE_TODO_FORMAT', 'CLAUDE_TODO_DEBUG'];
  const found = legacyVars.filter((v) => process.env[v] !== undefined);

  return {
    found: found.length > 0,
    count: found.length,
    variables: found,
  };
}

/**
 * Check if legacy project dir has CLEO files.
 * @task T4551
 */
async function hasCleoFilesInLegacy(legacyPath: string): Promise<boolean> {
  for (const file of CLEO_FILES) {
    if (await fileExists(join(legacyPath, file))) return true;
  }
  return false;
}

/**
 * Run check mode - detect legacy installations.
 * @task T4551
 */
async function runCheckMode(): Promise<{
  migrationNeeded: boolean;
  global: DetectionResult;
  project: DetectionResult;
  environment: EnvDetectionResult;
}> {
  const globalResult = await detectLegacyGlobal();
  const projectResult = await detectLegacyProject();
  const envResult = detectLegacyEnv();

  return {
    migrationNeeded: globalResult.found || projectResult.found || envResult.found,
    global: globalResult,
    project: projectResult,
    environment: envResult,
  };
}

/**
 * Migrate global installation.
 * @task T4551
 */
async function runGlobalMigration(force: boolean): Promise<Record<string, unknown>> {
  const legacyPath = getLegacyGlobalHome();
  const targetPath = getCleoHome();

  if (!(await dirExists(legacyPath))) {
    throw new CleoError(ExitCode.NOT_FOUND, `No legacy global installation found at ${legacyPath}`);
  }

  if (await dirExists(targetPath)) {
    const targetFileCount = await countFiles(targetPath);
    if (targetFileCount > 0 && !force) {
      throw new CleoError(ExitCode.VALIDATION_ERROR, `Target path already exists with data: ${targetPath}`, {
        fix: 'Use --force to merge',
      });
    }
  }

  // Move or merge
  if (await dirExists(targetPath) && force) {
    await cp(legacyPath, targetPath, { recursive: true });
    await rm(legacyPath, { recursive: true, force: true });
  } else {
    await rename(legacyPath, targetPath);
  }

  // Rename config files
  const configOld = join(targetPath, 'todo-config.json');
  const configNew = join(targetPath, 'config.json');
  let configsRenamed = 0;
  if (await fileExists(configOld)) {
    await rename(configOld, configNew);
    configsRenamed++;
  }

  const migratedCount = await countFiles(targetPath);

  return {
    type: 'global',
    source: legacyPath,
    target: targetPath,
    fileCount: migratedCount,
    configsRenamed,
  };
}

/**
 * Migrate project directory.
 * @task T4551
 */
async function runProjectMigration(force: boolean): Promise<Record<string, unknown>> {
  const legacyPath = getLegacyProjectDir();
  const targetPath = getCleoDir();

  if (!(await dirExists(legacyPath))) {
    throw new CleoError(ExitCode.NOT_FOUND, `No legacy project directory found at ${legacyPath}`);
  }

  if (!(await hasCleoFilesInLegacy(legacyPath))) {
    throw new CleoError(ExitCode.NOT_FOUND, 'No CLEO files found in .claude/');
  }

  if (await dirExists(targetPath)) {
    const targetFileCount = await countFiles(targetPath);
    if (targetFileCount > 0 && !force) {
      throw new CleoError(ExitCode.VALIDATION_ERROR, `Target path already exists with data: ${targetPath}`, {
        fix: 'Use --force to merge',
      });
    }
  }

  await mkdir(targetPath, { recursive: true });

  // Move only CLEO-specific files
  let filesMoved = 0;
  for (const file of CLEO_FILES) {
    const src = join(legacyPath, file);
    if (await fileExists(src)) {
      await rename(src, join(targetPath, file));
      filesMoved++;
    }
  }

  // Move backups directory if exists
  if (await dirExists(join(legacyPath, 'backups'))) {
    await mkdir(join(targetPath, 'backups'), { recursive: true });
    await cp(join(legacyPath, 'backups'), join(targetPath, 'backups'), { recursive: true });
    await rm(join(legacyPath, 'backups'), { recursive: true, force: true });
  }

  // Rename config files
  const configOld = join(targetPath, 'todo-config.json');
  const configNew = join(targetPath, 'config.json');
  let configsRenamed = 0;
  if (await fileExists(configOld)) {
    await rename(configOld, configNew);
    configsRenamed++;
  }

  // Update .gitignore
  let gitignoreUpdated = false;
  try {
    const gitignorePath = '.gitignore';
    if (await fileExists(gitignorePath)) {
      const content = await readFile(gitignorePath, 'utf-8');
      if (content.includes('.claude')) {
        const updated = content.replace(/\.claude/g, '.cleo');
        await writeFile(gitignorePath, updated);
        gitignoreUpdated = true;
      }
    }
  } catch {
    // ignore
  }

  // Clean up empty legacy dir
  const remainingCount = await countFiles(legacyPath);
  if (remainingCount === 0) {
    try { await rm(legacyPath, { recursive: true }); } catch { /* ignore */ }
  }

  const migratedCount = await countFiles(targetPath);

  return {
    type: 'project',
    source: legacyPath,
    target: targetPath,
    fileCount: migratedCount,
    filesMoved,
    configsRenamed,
    gitignoreUpdated,
    remainingInClaude: remainingCount,
  };
}

/**
 * Register the claude-migrate command.
 * @task T4551
 */
export function registerClaudeMigrateCommand(program: Command): void {
  program
    .command('claude-migrate')
    .description('Detect and migrate legacy claude-todo installations to CLEO format')
    .option('--check', 'Detect legacy installations (read-only)')
    .option('--global', 'Migrate global: ~/.claude-todo -> ~/.cleo')
    .option('--project', 'Migrate project: .claude -> .cleo')
    .option('--all', 'Migrate both global and project')
    .option('--force', 'Merge into existing target')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const force = opts['force'] as boolean ?? false;

        if (opts['check']) {
          const result = await runCheckMode();
          console.log(formatSuccess(result));
          // Exit 0 if legacy found, 1 if clean (grep-like semantics)
          if (!result.migrationNeeded) {
            process.exit(1);
          }
          return;
        }

        if (opts['global']) {
          const result = await runGlobalMigration(force);
          console.log(formatSuccess({ migration: result }));
          return;
        }

        if (opts['project']) {
          const result = await runProjectMigration(force);
          console.log(formatSuccess({ migration: result }));
          return;
        }

        if (opts['all']) {
          const results: Record<string, unknown> = {};
          let globalSuccess = false;
          let projectSuccess = false;

          try {
            results['global'] = await runGlobalMigration(force);
            globalSuccess = true;
          } catch (err) {
            if (err instanceof CleoError && err.code === ExitCode.NOT_FOUND) {
              results['global'] = { skipped: true, reason: 'No legacy installation found' };
            } else {
              throw err;
            }
          }

          try {
            results['project'] = await runProjectMigration(force);
            projectSuccess = true;
          } catch (err) {
            if (err instanceof CleoError && err.code === ExitCode.NOT_FOUND) {
              results['project'] = { skipped: true, reason: 'No legacy installation found' };
            } else {
              throw err;
            }
          }

          if (!globalSuccess && !projectSuccess) {
            throw new CleoError(ExitCode.NOT_FOUND, 'No legacy installations found');
          }

          console.log(formatSuccess({ migrations: results }));
          return;
        }

        // No mode specified
        throw new CleoError(ExitCode.INVALID_INPUT, 'Must specify --check, --global, --project, or --all');
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
