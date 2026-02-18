/**
 * Release management - create, plan, ship, changelog.
 * @task T4467
 * @epic T4454
 */

import { readJsonRequired, saveJson, computeChecksum, readJson } from '../../store/json.js';
import { atomicWrite } from '../../store/atomic.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Release, TodoFile } from '../../types/task.js';
import { getTodoPath, getBackupDir, getLogPath, getProjectRoot } from '../paths.js';
import { logOperation } from '../tasks/add.js';
import { join } from 'node:path';
import type { DataAccessor } from '../../store/data-accessor.js';

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

  const todoPath = getTodoPath(cwd);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);

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
    await accessor.saveTodoFile(data);
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
  const todoPath = getTodoPath(cwd);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);

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
    await accessor.saveTodoFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir: getBackupDir(cwd) });
  }

  return release;
}

/**
 * Ship a release - mark as released and generate changelog.
 * @task T4467
 */
export async function shipRelease(options: ShipReleaseOptions, cwd?: string, accessor?: DataAccessor): Promise<{
  release: Release;
  changelog: string;
  dryRun: boolean;
}> {
  const version = normalizeVersion(options.version);
  const todoPath = getTodoPath(cwd);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);

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
    return { release, changelog, dryRun: true };
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
    await accessor.saveTodoFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir: getBackupDir(cwd) });
  }

  // Write VERSION file if bumping
  if (options.bumpVersion) {
    try {
      const versionPath = join(getProjectRoot(cwd), 'VERSION');
      await atomicWrite(versionPath, version + '\n');
    } catch {
      // VERSION file write failure is non-fatal
    }
  }

  // Write CHANGELOG.md
  try {
    const changelogPath = join(getProjectRoot(cwd), 'CHANGELOG.md');
    const existingChangelog = await readJson<string>(changelogPath);
    const newContent = `# ${version}\n\n${changelog}\n\n${existingChangelog ?? ''}`;
    await atomicWrite(changelogPath, newContent);
  } catch {
    // Changelog write failure is non-fatal
  }

  return { release, changelog, dryRun: false };
}

/**
 * List all releases.
 * @task T4467
 */
export async function listReleases(cwd?: string, accessor?: DataAccessor): Promise<Release[]> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(getTodoPath(cwd));
  return data.project.releases ?? [];
}

/**
 * Show a specific release.
 * @task T4467
 */
export async function showRelease(version: string, cwd?: string, accessor?: DataAccessor): Promise<ReleaseShowResult> {
  const normalizedVersion = normalizeVersion(version);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(getTodoPath(cwd));
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
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(getTodoPath(cwd));
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
function generateChangelog(_version: string, taskIds: string[], data: TodoFile): string {
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
