/**
 * CLI init command - project initialization.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { saveJson } from '../../store/json.js';
import { getCleoDirAbsolute, getTodoPath, getConfigPath, getProjectRoot } from '../../core/paths.js';
import { mkdir, access, writeFile, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import type { TodoFile } from '../../types/task.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function createDefaultTodo(projectName: string): TodoFile {
  const now = new Date().toISOString();
  return {
    version: '2.10.0',
    project: {
      name: projectName,
      currentPhase: null,
      phases: {},
    },
    lastUpdated: now,
    _meta: {
      schemaVersion: '2.10.0',
      checksum: '',
      configVersion: '2.10.0',
    },
    focus: {
      currentTask: null,
    },
    tasks: [],
  };
}

function createDefaultConfig(): Record<string, unknown> {
  return {
    version: '2.10.0',
    output: {
      defaultFormat: 'json',
      showColor: true,
      showUnicode: true,
      dateFormat: 'relative',
    },
    backup: {
      maxOperationalBackups: 10,
      maxSafetyBackups: 5,
    },
    hierarchy: {
      maxDepth: 3,
      maxSiblings: 7,
    },
    session: {
      autoFocus: false,
      multiSession: false,
    },
    lifecycle: {
      mode: 'strict',
    },
  };
}

/**
 * Default content for .cleo/.gitignore.
 * Tracks core task/config files while ignoring transient data.
 * @task T4640
 * @epic T4637
 */
const CLEO_GITIGNORE_CONTENT = `# CLEO Project Data - Selective Git Tracking
#
# Strategy: Track core task/config files, ignore transient/generated data.
#
# TRACKED (not listed here, so git picks them up):
#   todo.json, todo-archive.json, config.json, sessions.json,
#   project-context.json, todo-log.jsonl, .sequence,
#   templates/, schemas/
#
# IGNORED (listed below):

# Lock and temp files
*.lock
*.tmp

# Operational backups (runtime safety nets, not source)
.backups/
backups/

# Metrics and telemetry exports
metrics/

# Audit logs (high-volume, session-specific)
audit-log-*.json

# Context state (transient session data)
.context-state.json
.context-state-session_*.json
context-states/

# SQLite WAL/journal files (transient database state)
*.db-journal
*.db-wal
*.db-shm

# Research artifacts (agent working data)
research/

# RCSD pipeline state (generated per-epic)
rcsd/

# Session working files
.current-session
.git-checkpoint-state

# Backup metadata
backup-metadata.json

# Corrupted/backup copies of data files
*.corrupted
*.bak
*.bak*
*.backup-*

# Cache directories
.cache/

# Uncomment to ignore SQLite databases (when using SQLite storage):
# tasks.db
`;

/**
 * Create the .cleo/.gitignore file from embedded template.
 * @task T4640
 * @epic T4637
 */
async function createCleoGitignore(cleoDir: string, force: boolean): Promise<boolean> {
  const gitignorePath = join(cleoDir, '.gitignore');
  if (await fileExists(gitignorePath) && !force) {
    return false;
  }
  await writeFile(gitignorePath, CLEO_GITIGNORE_CONTENT);
  return true;
}

/**
 * Remove .cleo/ or .cleo entries from the project root .gitignore.
 * Returns true if any lines were removed.
 * @task T4641
 * @epic T4637
 */
async function removeCleoFromRootGitignore(projectRoot: string): Promise<boolean> {
  const rootGitignorePath = join(projectRoot, '.gitignore');
  if (!(await fileExists(rootGitignorePath))) {
    return false;
  }

  const content = await readFile(rootGitignorePath, 'utf-8');
  const lines = content.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    // Match lines that ignore the entire .cleo directory:
    // .cleo, .cleo/, .cleo/*, /.cleo, /.cleo/
    return !/^\/?\.cleo\/?(\*)?$/.test(trimmed);
  });

  if (filtered.length === lines.length) {
    return false;
  }

  await writeFile(rootGitignorePath, filtered.join('\n'));
  return true;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize CLEO in a project directory')
    .option('--name <name>', 'Project name')
    .option('--force', 'Overwrite existing files')
    .option('--detect', 'Auto-detect project configuration')
    .option('--update-docs', 'Update agent documentation injections')
    .option('--json', 'Output in JSON format (default)')
    .argument('[projectName]', 'Project name (alternative to --name)')
    .action(async (projectName: string | undefined, opts: Record<string, unknown>) => {
      try {
        const cleoDir = getCleoDirAbsolute();
        const todoPath = getTodoPath();
        const configPath = getConfigPath();

        const created: string[] = [];
        const skipped: string[] = [];

        // Create .cleo directory
        await mkdir(cleoDir, { recursive: true });

        // Create todo.json
        if (await fileExists(todoPath) && !opts['force']) {
          skipped.push('todo.json');
        } else {
          const pName = (opts['name'] as string) || projectName || 'My Project';
          const todoData = createDefaultTodo(pName);
          await saveJson(todoPath, todoData);
          created.push('todo.json');
        }

        // Create config.json
        if (await fileExists(configPath) && !opts['force']) {
          skipped.push('config.json');
        } else {
          const configData = createDefaultConfig();
          await saveJson(configPath, configData);
          created.push('config.json');
        }

        // Create backups directory
        const backupDir = `${cleoDir}/backups`;
        await mkdir(`${backupDir}/operational`, { recursive: true });
        await mkdir(`${backupDir}/safety`, { recursive: true });

        // Create log file if not exists
        const logPath = `${cleoDir}/todo-log.jsonl`;
        if (!(await fileExists(logPath))) {
          // Migrate legacy todo-log.json if it exists
          const legacyLogPath = `${cleoDir}/todo-log.json`;
          if (await fileExists(legacyLogPath)) {
            const { rename: renameFile } = await import('node:fs/promises');
            await renameFile(legacyLogPath, logPath);
            created.push('todo-log.jsonl (migrated from todo-log.json)');
          } else {
            await writeFile(logPath, '');
            created.push('todo-log.jsonl');
          }
        }

        // Create archive file if not exists
        const archivePath = `${cleoDir}/todo-archive.json`;
        if (!(await fileExists(archivePath))) {
          await writeFile(archivePath, JSON.stringify({
            version: '2.10.0',
            _meta: { schemaVersion: '2.10.0' },
            archivedTasks: [],
          }, null, 2));
          created.push('todo-archive.json');
        }

        // Create .cleo/.gitignore
        const force = !!opts['force'];
        if (await createCleoGitignore(cleoDir, force)) {
          created.push('.gitignore');
        } else {
          skipped.push('.gitignore');
        }

        // Remove .cleo/ from root .gitignore if present
        const warnings: string[] = [];
        const projRoot = getProjectRoot();
        const rootGitignoreChanged = await removeCleoFromRootGitignore(projRoot);
        if (rootGitignoreChanged) {
          warnings.push('.cleo/ was found in root .gitignore and has been removed. CLEO uses .cleo/.gitignore for selective tracking.');
        }

        console.log(formatSuccess({
          initialized: true,
          directory: cleoDir,
          created,
          skipped,
          ...(warnings.length > 0 ? { warnings } : {}),
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
