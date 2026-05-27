/**
 * Directory scaffolding: .cleo/ structure, git checkpoint repo, SQLite
 * databases (tasks + brain).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ScaffoldResult } from '@cleocode/contracts/scaffold-diagnostics';
import { resolveCanonicalCleoDir, resolveProjectByCwd, getCleoHome } from '../paths.js';
import { hasGitIdentity } from './init.js';

export { generateProjectHash } from '../nexus/hash.js';

const execFileAsync = promisify(execFile);

/** Required subdirectories under .cleo/. */
export const REQUIRED_CLEO_SUBDIRS = [
  'backups/operational',
  'backups/safety',
  'agent-outputs',
  'logs',
  'rcasd',
  'adrs',
] as const;

/**
 * Create .cleo/ directory and all required subdirectories.
 * Idempotent: skips directories that already exist.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Scaffold result indicating whether the directory was created or already existed
 */
export async function ensureCleoStructure(projectRoot: string): Promise<ScaffoldResult> {
  const resolvedRoot = resolve(projectRoot);
  if (resolvedRoot === resolve(getCleoHome())) {
    return {
      action: 'skipped',
      path: join(resolvedRoot, '.cleo'),
      details: 'Refused to scaffold project structure inside global CLEO home',
    };
  }

  const projectId = resolveProjectByCwd(projectRoot);
  const cleoDir = resolveCanonicalCleoDir(projectId);

  const alreadyExists = existsSync(cleoDir);
  await mkdir(cleoDir, { recursive: true });

  for (const subdir of REQUIRED_CLEO_SUBDIRS) {
    await mkdir(join(cleoDir, subdir), { recursive: true });
  }

  return {
    action: alreadyExists ? 'skipped' : 'created',
    path: cleoDir,
    details: alreadyExists
      ? 'Directory already existed, ensured subdirs'
      : `Created .cleo/ with ${REQUIRED_CLEO_SUBDIRS.length} subdirectories`,
  };
}

/**
 * Initialize isolated .cleo/.git checkpoint repository.
 * Idempotent: skips if .cleo/.git already exists.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Scaffold result indicating the action taken
 */
export async function ensureCleoGitRepo(projectRoot: string): Promise<ScaffoldResult> {
  const projectId = resolveProjectByCwd(projectRoot);
  const cleoDir = resolveCanonicalCleoDir(projectId);
  const cleoGitDir = join(cleoDir, '.git');

  if (existsSync(cleoGitDir)) {
    return { action: 'skipped', path: cleoGitDir, details: 'Already initialized' };
  }

  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_DIR: cleoGitDir,
    GIT_WORK_TREE: cleoDir,
  };

  await execFileAsync('git', ['init', '--quiet'], { cwd: cleoDir, env: gitEnv });
  if (!(await hasGitIdentity(cleoDir, 'user.email', gitEnv))) {
    await execFileAsync('git', ['config', 'user.email', 'cleo@local'], {
      cwd: cleoDir,
      env: gitEnv,
    });
  }
  if (!(await hasGitIdentity(cleoDir, 'user.name', gitEnv))) {
    await execFileAsync('git', ['config', 'user.name', 'CLEO'], { cwd: cleoDir, env: gitEnv });
  }

  return { action: 'created', path: cleoGitDir, details: 'Isolated checkpoint repository' };
}

/**
 * Ensure the project's git repository has at least one commit on HEAD.
 *
 * Idempotent — skips when the project root has no `.git` directory (not a
 * git repo) or HEAD already resolves to a commit.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Scaffold result indicating the action taken
 *
 * @task T1244
 */
export async function ensureProjectGitInitialCommit(projectRoot: string): Promise<ScaffoldResult> {
  const projectGitDir = join(projectRoot, '.git');

  if (!existsSync(projectGitDir)) {
    return {
      action: 'skipped',
      path: projectGitDir,
      details: 'No project-level .git directory — skipping initial commit',
    };
  }

  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  cleanEnv.GIT_DIR = undefined;
  cleanEnv.GIT_WORK_TREE = undefined;
  delete cleanEnv.GIT_DIR;
  delete cleanEnv.GIT_WORK_TREE;

  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: projectRoot,
      env: cleanEnv,
    });
    return {
      action: 'skipped',
      path: projectGitDir,
      details: 'HEAD already has a commit — no initial commit needed',
    };
  } catch {
    // HEAD unborn — fall through
  }

  if (!(await hasGitIdentity(projectRoot, 'user.email', cleanEnv))) {
    await execFileAsync('git', ['config', 'user.email', 'cleo@local'], {
      cwd: projectRoot,
      env: cleanEnv,
    });
  }
  if (!(await hasGitIdentity(projectRoot, 'user.name', cleanEnv))) {
    await execFileAsync('git', ['config', 'user.name', 'CLEO'], {
      cwd: projectRoot,
      env: cleanEnv,
    });
  }

  try {
    await execFileAsync('git', ['commit', '--allow-empty', '--quiet', '-m', 'initial: cleo init'], {
      cwd: projectRoot,
      env: cleanEnv,
    });
    return {
      action: 'created',
      path: projectGitDir,
      details: 'Empty initial commit created so HEAD resolves',
    };
  } catch (err) {
    return {
      action: 'skipped',
      path: projectGitDir,
      details: `Could not create initial commit: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Create SQLite tasks.db if missing.
 * Idempotent: skips if tasks.db already exists.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Scaffold result indicating the action taken
 */
export async function ensureSqliteDb(projectRoot: string): Promise<ScaffoldResult> {
  const projectId = resolveProjectByCwd(projectRoot);
  const cleoDir = resolveCanonicalCleoDir(projectId);
  const dbPath = join(cleoDir, 'tasks.db');

  if (existsSync(dbPath)) {
    return { action: 'skipped', path: dbPath, details: 'tasks.db already exists' };
  }

  try {
    const { getDb } = await import('../store/sqlite.js');
    await getDb(projectRoot);
    return { action: 'created', path: dbPath, details: 'SQLite database initialized' };
  } catch (err) {
    return {
      action: 'skipped',
      path: dbPath,
      details: `Failed to initialize SQLite: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Create brain.db if missing.
 * Idempotent: skips if brain.db already exists.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Scaffold result indicating the action taken
 */
export async function ensureBrainDb(projectRoot: string): Promise<ScaffoldResult> {
  const projectId = resolveProjectByCwd(projectRoot);
  const cleoDir = resolveCanonicalCleoDir(projectId);
  const dbPath = join(cleoDir, 'brain.db');

  if (existsSync(dbPath)) {
    try {
      const { getBrainNativeDb } = await import('../store/memory-sqlite.js');
      const nativeDb = getBrainNativeDb();
      if (nativeDb) {
        const { ensureFts5Tables } = await import('../memory/brain-search.js');
        ensureFts5Tables(nativeDb);
      }
    } catch {
      // Non-fatal
    }
    return { action: 'skipped', path: dbPath, details: 'brain.db already exists' };
  }

  try {
    const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
    await getBrainDb(projectRoot);

    try {
      const nativeDb = getBrainNativeDb();
      if (nativeDb) {
        const { ensureFts5Tables } = await import('../memory/brain-search.js');
        ensureFts5Tables(nativeDb);
      }
    } catch {
      // FTS5 may not be available — non-fatal
    }

    return { action: 'created', path: dbPath, details: 'Brain database initialized with FTS5' };
  } catch (err) {
    return {
      action: 'skipped',
      path: dbPath,
      details: `Failed to initialize brain.db: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}