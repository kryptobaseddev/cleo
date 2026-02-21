/**
 * Release manifest operations for the releases.json data model.
 *
 * These functions manage the separate .cleo/releases.json file used by
 * the MCP release domain. This is distinct from the todo.json-based
 * release tracking in index.ts.
 *
 * @task T4788
 */

import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { readJson, saveJson } from '../../store/json.js';
import { getCleoDirAbsolute, getProjectRoot } from '../paths.js';

// ── Types ────────────────────────────────────────────────────────────

/** Release manifest structure. */
export interface ReleaseManifest {
  version: string;
  status: 'draft' | 'prepared' | 'committed' | 'tagged' | 'pushed' | 'rolled_back';
  createdAt: string;
  preparedAt?: string;
  committedAt?: string;
  taggedAt?: string;
  pushedAt?: string;
  tasks: string[];
  notes?: string;
  changelog?: string;
  previousVersion?: string;
}

/** Release index structure stored in .cleo/releases.json. */
export interface ReleasesIndex {
  releases: ReleaseManifest[];
  latest?: string;
}

/** Task record shape needed for release operations. */
export interface ReleaseTaskRecord {
  id: string;
  title: string;
  status: string;
  parentId?: string;
  completedAt?: string | null;
  labels?: string[];
}

// ── Internal helpers ─────────────────────────────────────────────────

function getReleasesPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'releases.json');
}

async function readReleases(cwd?: string): Promise<ReleasesIndex> {
  const data = await readJson<ReleasesIndex>(getReleasesPath(cwd));
  return data ?? { releases: [] };
}

async function writeReleases(index: ReleasesIndex, cwd?: string): Promise<void> {
  const releasesPath = getReleasesPath(cwd);
  const dir = dirname(releasesPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  await saveJson(releasesPath, index);
}

function isValidVersion(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version);
}

function normalizeVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Prepare a release (create a release manifest entry).
 * @task T4788
 */
export async function prepareRelease(
  version: string,
  tasks: string[] | undefined,
  notes: string | undefined,
  loadTasksFn: () => Promise<ReleaseTaskRecord[]>,
  cwd?: string,
): Promise<{
  version: string;
  status: string;
  tasks: string[];
  taskCount: number;
}> {
  if (!version) {
    throw new Error('version is required');
  }
  if (!isValidVersion(version)) {
    throw new Error(`Invalid version format: ${version} (expected X.Y.Z or YYYY.M.patch)`);
  }

  const normalizedVersion = normalizeVersion(version);
  const index = await readReleases(cwd);

  const existing = index.releases.find((r) => r.version === normalizedVersion);
  if (existing) {
    throw new Error(`Release ${normalizedVersion} already exists (status: ${existing.status})`);
  }

  let releaseTasks = tasks ?? [];
  if (releaseTasks.length === 0) {
    const allTasks = await loadTasksFn();
    releaseTasks = allTasks
      .filter((t) => t.status === 'done' && t.completedAt)
      .map((t) => t.id);
  }

  // Filter out epic IDs
  const allTasks = await loadTasksFn();
  const epicIds = new Set(
    allTasks.filter((t) => allTasks.some((c) => c.parentId === t.id)).map((t) => t.id),
  );
  releaseTasks = releaseTasks.filter((id) => !epicIds.has(id));

  const release: ReleaseManifest = {
    version: normalizedVersion,
    status: 'prepared',
    createdAt: new Date().toISOString(),
    preparedAt: new Date().toISOString(),
    tasks: releaseTasks,
    notes,
    previousVersion: index.latest,
  };

  index.releases.push(release);
  await writeReleases(index, cwd);

  return {
    version: normalizedVersion,
    status: 'prepared',
    tasks: releaseTasks,
    taskCount: releaseTasks.length,
  };
}

/**
 * Generate changelog for a release.
 * @task T4788
 */
export async function generateReleaseChangelog(
  version: string,
  loadTasksFn: () => Promise<ReleaseTaskRecord[]>,
  cwd?: string,
): Promise<{
  version: string;
  changelog: string;
  taskCount: number;
  sections: Record<string, number>;
}> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const index = await readReleases(cwd);
  const release = index.releases.find((r) => r.version === normalizedVersion);

  if (!release) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  const allTasks = await loadTasksFn();
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  const features: string[] = [];
  const fixes: string[] = [];
  const chores: string[] = [];
  const docs: string[] = [];
  const tests: string[] = [];
  const other: string[] = [];

  for (const taskId of release.tasks) {
    const task = taskMap.get(taskId);
    if (!task) continue;

    const titleLower = task.title.toLowerCase();
    const entry = `- ${task.title} (${task.id})`;

    if (titleLower.startsWith('feat') || titleLower.includes('add ') || titleLower.includes('implement')) {
      features.push(entry);
    } else if (titleLower.startsWith('fix') || titleLower.includes('bug')) {
      fixes.push(entry);
    } else if (titleLower.startsWith('doc') || titleLower.includes('documentation')) {
      docs.push(entry);
    } else if (titleLower.startsWith('test') || titleLower.includes('test')) {
      tests.push(entry);
    } else if (titleLower.startsWith('chore') || titleLower.includes('refactor')) {
      chores.push(entry);
    } else {
      other.push(entry);
    }
  }

  const sections: string[] = [];
  const date = new Date().toISOString().split('T')[0];
  sections.push(`## ${normalizedVersion} (${date})`);
  sections.push('');

  if (release.notes) {
    sections.push(release.notes);
    sections.push('');
  }

  if (features.length > 0) {
    sections.push('### Features');
    sections.push(...features);
    sections.push('');
  }
  if (fixes.length > 0) {
    sections.push('### Bug Fixes');
    sections.push(...fixes);
    sections.push('');
  }
  if (docs.length > 0) {
    sections.push('### Documentation');
    sections.push(...docs);
    sections.push('');
  }
  if (tests.length > 0) {
    sections.push('### Tests');
    sections.push(...tests);
    sections.push('');
  }
  if (chores.length > 0) {
    sections.push('### Chores');
    sections.push(...chores);
    sections.push('');
  }
  if (other.length > 0) {
    sections.push('### Other');
    sections.push(...other);
    sections.push('');
  }

  const changelog = sections.join('\n');

  release.changelog = changelog;
  await writeReleases(index, cwd);

  return {
    version: normalizedVersion,
    changelog,
    taskCount: release.tasks.length,
    sections: {
      features: features.length,
      fixes: fixes.length,
      docs: docs.length,
      tests: tests.length,
      chores: chores.length,
      other: other.length,
    },
  };
}

/**
 * List all releases.
 * @task T4788
 */
export async function listManifestReleases(
  cwd?: string,
): Promise<{
  releases: Array<{ version: string; status: string; createdAt: string; taskCount: number }>;
  total: number;
  latest?: string;
}> {
  const index = await readReleases(cwd);

  return {
    releases: index.releases.map((r) => ({
      version: r.version,
      status: r.status,
      createdAt: r.createdAt,
      taskCount: r.tasks.length,
    })),
    total: index.releases.length,
    latest: index.latest,
  };
}

/**
 * Show release details.
 * @task T4788
 */
export async function showManifestRelease(
  version: string,
  cwd?: string,
): Promise<ReleaseManifest> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const index = await readReleases(cwd);
  const release = index.releases.find((r) => r.version === normalizedVersion);

  if (!release) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  return release;
}

/**
 * Mark release as committed (metadata only).
 * @task T4788
 */
export async function commitRelease(
  version: string,
  cwd?: string,
): Promise<{ version: string; status: string; committedAt: string }> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const index = await readReleases(cwd);
  const release = index.releases.find((r) => r.version === normalizedVersion);

  if (!release) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  if (release.status !== 'prepared') {
    throw new Error(`Release ${normalizedVersion} is in state '${release.status}', expected 'prepared'`);
  }

  release.status = 'committed';
  release.committedAt = new Date().toISOString();
  await writeReleases(index, cwd);

  return {
    version: normalizedVersion,
    status: 'committed',
    committedAt: release.committedAt,
  };
}

/**
 * Mark release as tagged (metadata only).
 * @task T4788
 */
export async function tagRelease(
  version: string,
  cwd?: string,
): Promise<{ version: string; status: string; taggedAt: string }> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const index = await readReleases(cwd);
  const release = index.releases.find((r) => r.version === normalizedVersion);

  if (!release) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  release.status = 'tagged';
  release.taggedAt = new Date().toISOString();
  index.latest = normalizedVersion;
  await writeReleases(index, cwd);

  return {
    version: normalizedVersion,
    status: 'tagged',
    taggedAt: release.taggedAt,
  };
}

/**
 * Run release validation gates.
 * @task T4788
 */
export async function runReleaseGates(
  version: string,
  loadTasksFn: () => Promise<ReleaseTaskRecord[]>,
  cwd?: string,
): Promise<{
  version: string;
  allPassed: boolean;
  gates: Array<{ name: string; status: 'passed' | 'failed'; message: string }>;
  passedCount: number;
  failedCount: number;
}> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const index = await readReleases(cwd);
  const release = index.releases.find((r) => r.version === normalizedVersion);

  if (!release) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  const gates: Array<{ name: string; status: 'passed' | 'failed'; message: string }> = [];

  gates.push({
    name: 'version_valid',
    status: isValidVersion(normalizedVersion) ? 'passed' : 'failed',
    message: isValidVersion(normalizedVersion) ? 'Version format is valid' : 'Invalid version format',
  });

  gates.push({
    name: 'has_tasks',
    status: release.tasks.length > 0 ? 'passed' : 'failed',
    message: release.tasks.length > 0 ? `${release.tasks.length} tasks included` : 'No tasks in release',
  });

  gates.push({
    name: 'has_changelog',
    status: release.changelog ? 'passed' : 'failed',
    message: release.changelog ? 'Changelog generated' : 'No changelog generated. Run release.changelog first.',
  });

  const allTasks = await loadTasksFn();
  const incompleteTasks = release.tasks.filter((id) => {
    const task = allTasks.find((t) => t.id === id);
    return task && task.status !== 'done';
  });

  gates.push({
    name: 'tasks_complete',
    status: incompleteTasks.length === 0 ? 'passed' : 'failed',
    message: incompleteTasks.length === 0
      ? 'All tasks completed'
      : `${incompleteTasks.length} tasks not completed: ${incompleteTasks.join(', ')}`,
  });

  const allPassed = gates.every((g) => g.status === 'passed');

  return {
    version: normalizedVersion,
    allPassed,
    gates,
    passedCount: gates.filter((g) => g.status === 'passed').length,
    failedCount: gates.filter((g) => g.status === 'failed').length,
  };
}

/**
 * Rollback a release.
 * @task T4788
 */
export async function rollbackRelease(
  version: string,
  reason?: string,
  cwd?: string,
): Promise<{
  version: string;
  previousStatus: string;
  status: string;
  reason: string;
}> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const index = await readReleases(cwd);
  const release = index.releases.find((r) => r.version === normalizedVersion);

  if (!release) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  const previousStatus = release.status;
  release.status = 'rolled_back';

  if (index.latest === normalizedVersion) {
    const otherReleases = index.releases
      .filter((r) => r.version !== normalizedVersion && r.status !== 'rolled_back')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    index.latest = otherReleases[0]?.version;
  }

  await writeReleases(index, cwd);

  return {
    version: normalizedVersion,
    previousStatus,
    status: 'rolled_back',
    reason: reason ?? 'No reason provided',
  };
}

/**
 * Push release to remote via git.
 * @task T4788
 */
export function pushRelease(
  version: string,
  remote?: string,
  cwd?: string,
): {
  version: string;
  status: string;
  remote: string;
  pushedAt: string;
} {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const projectRoot = getProjectRoot(cwd);
  const targetRemote = remote ?? 'origin';

  // Note: We don't update releases.json here synchronously since the
  // caller (engine) can handle status update after this returns.
  // The git push is the critical operation.
  execFileSync('git', ['push', targetRemote, '--follow-tags'], {
    cwd: projectRoot,
    timeout: 60000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    version: normalizedVersion,
    status: 'pushed',
    remote: targetRemote,
    pushedAt: new Date().toISOString(),
  };
}

/**
 * Update release status after push.
 * @task T4788
 */
export async function markReleasePushed(
  version: string,
  pushedAt: string,
  cwd?: string,
): Promise<void> {
  const normalizedVersion = normalizeVersion(version);
  const index = await readReleases(cwd);
  const release = index.releases.find((r) => r.version === normalizedVersion);
  if (release) {
    release.status = 'pushed';
    release.pushedAt = pushedAt;
    await writeReleases(index, cwd);
  }
}
