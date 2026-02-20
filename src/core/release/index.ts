/**
 * Release management - create, plan, ship, changelog.
 * @task T4467
 * @epic T4454
 */

import { readJsonRequired, saveJson, computeChecksum } from '../../store/json.js';
import { atomicWrite } from '../../store/atomic.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Release, TaskFile } from '../../types/task.js';
import { getTaskPath, getBackupDir, getLogPath, getProjectRoot } from '../paths.js';
import { logOperation } from '../tasks/add.js';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { DataAccessor } from '../../store/data-accessor.js';
import { bumpVersionFromConfig, isVersionBumpConfigured } from './version-bump.js';
import type { BumpResult } from './version-bump.js';

/** Options for creating a release. */
export interface CreateReleaseOptions {
  version: string;
  tasks?: string[];
  notes?: string;
  targetDate?: string;
}

/** Options for planning a release. */
export interface PlanReleaseOptions {
  version: string;
  tasks?: string[];
  removeTasks?: string[];
  notes?: string;
}

/** Ship release options. */
export interface ShipReleaseOptions {
  version: string;
  bumpVersion?: boolean;
  createTag?: boolean;
  push?: boolean;
  dryRun?: boolean;
}

/** Release show result. */
export interface ReleaseShowResult {
  version: string;
  status: string;
  tasks: Array<{ id: string; title: string; status: string }>;
  notes: string | null;
  targetDate: string | null;
  releasedAt: string | null;
  changelog: string | null;
}

/**
 * Validate version format (X.Y.Z, CalVer YYYY.M.patch, with optional pre-release/build metadata).
 * @task T4467
 */
export function validateVersion(version: string): void {
  if (!/^v?\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/.test(version)) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, `Invalid version format: ${version} (expected X.Y.Z or YYYY.M.patch)`);
  }
}

/**
 * Validate version format (legacy alias).
 * @deprecated Use validateVersion instead.
 * @task T4467
 */
export const validateSemver = validateVersion;

/**
 * Normalize version string (strip leading v).
 * @task T4467
 */
function normalizeVersion(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version;
}

/**
 * Create a new release.
 * @task T4467
 */
export async function createRelease(options: CreateReleaseOptions, cwd?: string, accessor?: DataAccessor): Promise<Release> {
  validateVersion(options.version);
  const version = normalizeVersion(options.version);

  const todoPath = getTaskPath(cwd);
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(todoPath);

  // Ensure releases array exists
  if (!data.project.releases) {
    data.project.releases = [];
  }

  // Check for duplicate
  if (data.project.releases.some(r => normalizeVersion(r.version) === version)) {
    throw new CleoError(ExitCode.ALREADY_EXISTS, `Release ${version} already exists`);
  }

  // Validate task IDs
  const taskIds = options.tasks ?? [];
  for (const taskId of taskIds) {
    if (!data.tasks.find(t => t.id === taskId)) {
      throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`);
    }
  }

  const release: Release = {
    version,
    status: 'planned',
    tasks: taskIds,
    notes: options.notes ?? null,
    targetDate: options.targetDate ?? null,
    releasedAt: null,
  };

  data.project.releases.push(release);
  data.lastUpdated = new Date().toISOString();
  data._meta.checksum = computeChecksum(data.tasks);

  if (accessor) {
    await accessor.saveTaskFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir: getBackupDir(cwd) });
  }
  await logOperation(getLogPath(cwd), 'release_created', version, {
    tasks: taskIds,
  }, accessor);

  return release;
}

/**
 * Plan/update a release - add or remove tasks.
 * @task T4467
 */
export async function planRelease(options: PlanReleaseOptions, cwd?: string, accessor?: DataAccessor): Promise<Release> {
  const version = normalizeVersion(options.version);
  const todoPath = getTaskPath(cwd);
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(todoPath);

  const releases = data.project.releases ?? [];
  const release = releases.find(r => normalizeVersion(r.version) === version);

  if (!release) {
    throw new CleoError(ExitCode.NOT_FOUND, `Release ${version} not found`);
  }

  if (release.status === 'released') {
    throw new CleoError(ExitCode.VALIDATION_ERROR, `Release ${version} is already released`);
  }

  // Add tasks (deduplicate)
  if (options.tasks?.length) {
    for (const taskId of options.tasks) {
      if (!data.tasks.find(t => t.id === taskId)) {
        throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`);
      }
      if (!release.tasks.includes(taskId)) {
        release.tasks.push(taskId);
      }
    }
  }

  // Remove tasks
  if (options.removeTasks?.length) {
    release.tasks = release.tasks.filter(id => !options.removeTasks!.includes(id));
  }

  // Update notes
  if (options.notes !== undefined) {
    release.notes = options.notes;
  }

  data.lastUpdated = new Date().toISOString();
  data._meta.checksum = computeChecksum(data.tasks);

  if (accessor) {
    await accessor.saveTaskFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir: getBackupDir(cwd) });
  }

  return release;
}

/** Result of shipping a release. */
export interface ShipReleaseResult {
  release: Release;
  changelog: string;
  dryRun: boolean;
  bumpResults?: BumpResult[];
  changelogWritten?: boolean;
  gitCommit?: string;
  gitTag?: string;
  gitPushed?: boolean;
}

/**
 * Ship a release - mark as released, generate changelog, bump versions, and optionally git commit/tag/push.
 * @task T4467
 */
export async function shipRelease(options: ShipReleaseOptions, cwd?: string, accessor?: DataAccessor): Promise<ShipReleaseResult> {
  const version = normalizeVersion(options.version);
  const todoPath = getTaskPath(cwd);
  const projectRoot = getProjectRoot(cwd);
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(todoPath);

  const releases = data.project.releases ?? [];
  const release = releases.find(r => normalizeVersion(r.version) === version);

  if (!release) {
    throw new CleoError(ExitCode.NOT_FOUND, `Release ${version} not found`);
  }

  if (release.status === 'released') {
    throw new CleoError(ExitCode.VALIDATION_ERROR, `Release ${version} is already released`);
  }

  // Auto-populate tasks if empty
  if (release.tasks.length === 0) {
    const completedTasks = data.tasks
      .filter(t => t.status === 'done' && t.type !== 'epic')
      .map(t => t.id);
    release.tasks = completedTasks;
  }

  // Generate changelog
  const changelog = generateChangelog(version, release.tasks, data);

  if (options.dryRun) {
    const result: ShipReleaseResult = { release, changelog, dryRun: true };

    // Show what version bump would do
    if (options.bumpVersion) {
      if (isVersionBumpConfigured(cwd)) {
        const { results } = bumpVersionFromConfig(version, { dryRun: true }, cwd);
        result.bumpResults = results;
      } else {
        // Default: VERSION file + package.json if it exists
        const bumpResults: BumpResult[] = [
          { file: 'VERSION', strategy: 'plain', success: true, newVersion: version },
        ];
        const pkgPath = join(projectRoot, 'package.json');
        if (existsSync(pkgPath)) {
          bumpResults.push({ file: 'package.json', strategy: 'json', success: true, newVersion: version });
        }
        result.bumpResults = bumpResults;
      }
      result.changelogWritten = true;
    }

    return result;
  }

  // Mark as released
  release.status = 'released';
  release.releasedAt = new Date().toISOString();
  release.changelog = changelog;

  // Update version in data if bump requested
  if (options.bumpVersion) {
    data.version = version;
  }

  data.lastUpdated = new Date().toISOString();
  data._meta.checksum = computeChecksum(data.tasks);

  if (accessor) {
    await accessor.saveTaskFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir: getBackupDir(cwd) });
  }

  const result: ShipReleaseResult = { release, changelog, dryRun: false };

  // Bump version files
  if (options.bumpVersion) {
    if (isVersionBumpConfigured(cwd)) {
      // Use config-driven bump (handles VERSION, package.json, and any other configured files)
      try {
        const { results } = bumpVersionFromConfig(version, {}, cwd);
        result.bumpResults = results;
      } catch {
        // Config-driven bump failed, fall back to direct writes
        result.bumpResults = await bumpVersionFallback(version, projectRoot);
      }
    } else {
      // No config: fall back to direct VERSION + package.json writes
      result.bumpResults = await bumpVersionFallback(version, projectRoot);
    }
  }

  // Write CHANGELOG.md
  result.changelogWritten = await writeChangelogFile(version, changelog, projectRoot);

  // Git operations: commit, tag, push
  if (options.createTag || options.push) {
    const gitResult = performGitOperations(version, projectRoot, {
      createTag: options.createTag,
      push: options.push,
    });
    result.gitCommit = gitResult.commit;
    result.gitTag = gitResult.tag;
    result.gitPushed = gitResult.pushed;
  } else if (options.bumpVersion) {
    // Even without explicit --create-tag/--push, commit version metadata files
    const gitResult = performGitOperations(version, projectRoot, {
      createTag: false,
      push: false,
    });
    result.gitCommit = gitResult.commit;
  }

  return result;
}

/**
 * Fallback version bump: write VERSION file + package.json directly.
 * Used when no config-driven bump targets are defined.
 * @task T4467
 */
async function bumpVersionFallback(version: string, projectRoot: string): Promise<BumpResult[]> {
  const results: BumpResult[] = [];

  // Write VERSION file
  try {
    const versionPath = join(projectRoot, 'VERSION');
    await atomicWrite(versionPath, version + '\n');
    results.push({ file: 'VERSION', strategy: 'plain', success: true, newVersion: version });
  } catch (err) {
    results.push({ file: 'VERSION', strategy: 'plain', success: false, error: String(err) });
  }

  // Update package.json if it exists
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkgContent = await readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(pkgContent);
      const previousVersion = pkg.version;
      pkg.version = version;
      await atomicWrite(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      results.push({ file: 'package.json', strategy: 'json', success: true, previousVersion, newVersion: version });
    } catch (err) {
      results.push({ file: 'package.json', strategy: 'json', success: false, error: String(err) });
    }
  }

  return results;
}

/**
 * Write CHANGELOG.md, prepending the new release section.
 * Reads existing file as plain text (not JSON).
 * @task T4467
 */
async function writeChangelogFile(version: string, changelog: string, projectRoot: string): Promise<boolean> {
  try {
    const changelogPath = join(projectRoot, 'CHANGELOG.md');
    let existingContent = '';
    try {
      existingContent = await readFile(changelogPath, 'utf-8');
    } catch {
      // File doesn't exist yet, start fresh
    }
    const newSection = `# ${version}\n\n${changelog}\n`;
    const newContent = existingContent
      ? `${newSection}\n${existingContent}`
      : newSection;
    await atomicWrite(changelogPath, newContent);
    return true;
  } catch {
    // Changelog write failure is non-fatal
    return false;
  }
}

/**
 * Perform git operations: stage version files, commit, tag, push.
 * @task T4467
 */
function performGitOperations(
  version: string,
  projectRoot: string,
  opts: { createTag?: boolean; push?: boolean },
): { commit?: string; tag?: string; pushed?: boolean } {
  const result: { commit?: string; tag?: string; pushed?: boolean } = {};

  try {
    // Stage version-related files (only those that exist)
    const filesToStage = [
      'VERSION',
      'CHANGELOG.md',
      'package.json',
      'mcp-server/package.json',
      'README.md',
      '.cleo/todo.json',
      '.cleo/config.json',
    ].filter(f => existsSync(join(projectRoot, f)));

    if (filesToStage.length === 0) return result;

    execFileSync('git', ['add', ...filesToStage], { cwd: projectRoot, stdio: 'pipe' });

    // Check if there are staged changes
    try {
      execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: projectRoot, stdio: 'pipe' });
      // Exit code 0 means no staged changes -- nothing to commit
      return result;
    } catch {
      // Exit code 1 means there are staged changes -- proceed with commit
    }

    // Commit (use --no-verify to bypass task-ID hook for release metadata commits)
    const commitMsg = `chore(release): v${version}`;
    execFileSync('git', ['commit', '--no-verify', '-m', commitMsg], { cwd: projectRoot, stdio: 'pipe' });
    const commitHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot, stdio: 'pipe' })
      .toString().trim();
    result.commit = commitHash;

    // Tag
    if (opts.createTag) {
      const tagName = `v${version}`;
      execFileSync('git', ['tag', '-a', tagName, '-m', `Release ${tagName}`], { cwd: projectRoot, stdio: 'pipe' });
      result.tag = tagName;
    }

    // Push
    if (opts.push) {
      execFileSync('git', ['push'], { cwd: projectRoot, stdio: 'pipe' });
      if (opts.createTag) {
        execFileSync('git', ['push', '--tags'], { cwd: projectRoot, stdio: 'pipe' });
      }
      result.pushed = true;
    }
  } catch {
    // Git operations are non-fatal; return what we managed
  }

  return result;
}

/**
 * List all releases.
 * @task T4467
 */
export async function listReleases(cwd?: string, accessor?: DataAccessor): Promise<Release[]> {
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(getTaskPath(cwd));
  return data.project.releases ?? [];
}

/**
 * Show a specific release.
 * @task T4467
 */
export async function showRelease(version: string, cwd?: string, accessor?: DataAccessor): Promise<ReleaseShowResult> {
  const normalizedVersion = normalizeVersion(version);
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(getTaskPath(cwd));
  const releases = data.project.releases ?? [];
  const release = releases.find(r => normalizeVersion(r.version) === normalizedVersion);

  if (!release) {
    throw new CleoError(ExitCode.NOT_FOUND, `Release ${version} not found`);
  }

  const tasks = release.tasks.map(taskId => {
    const task = data.tasks.find(t => t.id === taskId);
    return task
      ? { id: task.id, title: task.title, status: task.status }
      : { id: taskId, title: 'Unknown', status: 'unknown' };
  });

  return {
    version: release.version,
    status: release.status,
    tasks,
    notes: release.notes ?? null,
    targetDate: release.targetDate ?? null,
    releasedAt: release.releasedAt ?? null,
    changelog: release.changelog ?? null,
  };
}

/**
 * Get changelog for a release.
 * @task T4467
 */
export async function getChangelog(version: string, cwd?: string, accessor?: DataAccessor): Promise<string> {
  const normalizedVersion = normalizeVersion(version);
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(getTaskPath(cwd));
  const releases = data.project.releases ?? [];
  const release = releases.find(r => normalizeVersion(r.version) === normalizedVersion);

  if (!release) {
    throw new CleoError(ExitCode.NOT_FOUND, `Release ${version} not found`);
  }

  if (release.changelog) {
    return release.changelog;
  }

  return generateChangelog(normalizedVersion, release.tasks, data);
}

/**
 * Generate changelog from release tasks.
 * @task T4467
 */
function generateChangelog(_version: string, taskIds: string[], data: TaskFile): string {
  const lines: string[] = [];
  const feats: string[] = [];
  const fixes: string[] = [];
  const other: string[] = [];

  for (const taskId of taskIds) {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) continue;

    // Skip epics (organizational only)
    if (task.type === 'epic') continue;

    const entry = `- ${task.title} (${taskId})`;

    // Categorize by labels or title keywords
    const text = `${task.title} ${(task.labels ?? []).join(' ')}`.toLowerCase();
    if (text.includes('fix') || text.includes('bug')) {
      fixes.push(entry);
    } else if (text.includes('feat') || text.includes('add') || text.includes('implement')) {
      feats.push(entry);
    } else {
      other.push(entry);
    }
  }

  if (feats.length > 0) {
    lines.push('### Features', '', ...feats, '');
  }
  if (fixes.length > 0) {
    lines.push('### Bug Fixes', '', ...fixes, '');
  }
  if (other.length > 0) {
    lines.push('### Other Changes', '', ...other, '');
  }

  if (lines.length === 0) {
    lines.push('No changes recorded.');
  }

  return lines.join('\n');
}
