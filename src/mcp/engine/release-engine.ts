/**
 * Release Engine
 *
 * Native TypeScript implementation of release domain operations.
 * Manages release lifecycle: prepare, changelog generation, commit, tag.
 *
 * Note: Some operations (push, rollback) inherently require git CLI.
 * Those are handled as hybrid operations - native for data, CLI for git.
 *
 * @task T4476
 */

import { existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname } from 'path';
import { resolveProjectRoot, readJsonFile, writeJsonFileAtomic, getDataPath } from './store.js';
import { getAccessor } from '../../store/data-accessor.js';
import type { TaskRecord } from './task-engine.js';

/**
 * Engine result type
 */
interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * Release manifest structure
 */
interface ReleaseManifest {
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

/**
 * Release index structure stored in .cleo/releases.json
 */
interface ReleasesIndex {
  releases: ReleaseManifest[];
  latest?: string;
}

/**
 * Get the releases index path
 */
function getReleasesPath(projectRoot?: string): string {
  const root = projectRoot || resolveProjectRoot();
  return getDataPath(root, 'releases.json');
}

/**
 * Read releases index
 */
function readReleases(projectRoot?: string): ReleasesIndex {
  const releasesPath = getReleasesPath(projectRoot);
  const data = readJsonFile<ReleasesIndex>(releasesPath);
  return data || { releases: [] };
}

/**
 * Write releases index
 */
function writeReleases(index: ReleasesIndex, projectRoot?: string): void {
  const releasesPath = getReleasesPath(projectRoot);
  const dir = dirname(releasesPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeJsonFileAtomic(releasesPath, index);
}

/**
 * Validate version format (X.Y.Z or CalVer YYYY.M.patch, with optional pre-release/build).
 */
function isValidVersion(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version);
}


/**
 * Normalize version (ensure v prefix)
 */
function normalizeVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

/**
 * Load tasks via DataAccessor (SQLite or JSON depending on engine config).
 * When projectRoot is explicitly provided (e.g., in tests), uses direct
 * JSON read to avoid requiring full CLEO initialization.
 */
async function loadTasks(projectRoot?: string): Promise<TaskRecord[]> {
  if (projectRoot) {
    // Explicit root: direct JSON read (test path or custom root)
    const todoPath = getDataPath(projectRoot, 'todo.json');
    const todoData = readJsonFile<{ tasks: TaskRecord[] }>(todoPath);
    return todoData?.tasks || [];
  }
  try {
    const accessor = await getAccessor();
    const todoFile = await accessor.loadTodoFile();
    return (todoFile?.tasks as TaskRecord[]) || [];
  } catch {
    // Fallback: direct JSON read when accessor unavailable
    const root = resolveProjectRoot();
    const todoPath = getDataPath(root, 'todo.json');
    const todoData = readJsonFile<{ tasks: TaskRecord[] }>(todoPath);
    return todoData?.tasks || [];
  }
}

/**
 * release.prepare - Prepare a release
 * @task T4476
 */
export async function releasePrepare(
  version: string,
  tasks?: string[],
  notes?: string,
  projectRoot?: string
): Promise<EngineResult> {
  if (!version) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'version is required' } };
  }

  if (!isValidVersion(version)) {
    return {
      success: false,
      error: { code: 'E_INVALID_VERSION', message: `Invalid version format: ${version} (expected X.Y.Z or YYYY.M.patch)` },
    };
  }

  const normalizedVersion = normalizeVersion(version);
  const index = readReleases(projectRoot);

  // Check if version already exists
  const existing = index.releases.find((r) => r.version === normalizedVersion);
  if (existing) {
    return {
      success: false,
      error: {
        code: 'E_VERSION_EXISTS',
        message: `Release ${normalizedVersion} already exists (status: ${existing.status})`,
      },
    };
  }

  // Auto-discover completed tasks if none provided
  let releaseTasks = tasks || [];
  if (releaseTasks.length === 0) {
    const allTasks = await loadTasks(projectRoot);
    releaseTasks = allTasks
      .filter((t) => t.status === 'done' && t.completedAt)
      .map((t) => t.id);
  }

  // Filter out epic IDs (organizational only)
  const allTasks = await loadTasks(projectRoot);
  const epicIds = new Set(
    allTasks.filter((t) => allTasks.some((c) => c.parentId === t.id)).map((t) => t.id)
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
  writeReleases(index, projectRoot);

  return {
    success: true,
    data: {
      version: normalizedVersion,
      status: 'prepared',
      tasks: releaseTasks,
      taskCount: releaseTasks.length,
    },
  };
}

/**
 * release.changelog - Generate changelog
 * @task T4476
 */
export async function releaseChangelog(
  version: string,
  projectRoot?: string
): Promise<EngineResult> {
  if (!version) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'version is required' } };
  }

  const normalizedVersion = normalizeVersion(version);
  const index = readReleases(projectRoot);
  const release = index.releases.find((r) => r.version === normalizedVersion);

  if (!release) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Release ${normalizedVersion} not found` },
    };
  }

  // Load task details for changelog
  const allTasks = await loadTasks(projectRoot);
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  // Group tasks by type
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

  // Build changelog
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

  // Store changelog in release manifest
  release.changelog = changelog;
  writeReleases(index, projectRoot);

  return {
    success: true,
    data: {
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
    },
  };
}

/**
 * release.list - List all releases (query operation via data read)
 * @task T4476
 */
export function releaseList(
  projectRoot?: string
): EngineResult {
  const index = readReleases(projectRoot);

  return {
    success: true,
    data: {
      releases: index.releases.map((r) => ({
        version: r.version,
        status: r.status,
        createdAt: r.createdAt,
        taskCount: r.tasks.length,
      })),
      total: index.releases.length,
      latest: index.latest,
    },
  };
}

/**
 * release.show - Show release details (query operation via data read)
 * @task T4476
 */
export function releaseShow(
  version: string,
  projectRoot?: string
): EngineResult {
  if (!version) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'version is required' } };
  }

  const normalizedVersion = normalizeVersion(version);
  const index = readReleases(projectRoot);
  const release = index.releases.find((r) => r.version === normalizedVersion);

  if (!release) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Release ${normalizedVersion} not found` },
    };
  }

  return {
    success: true,
    data: release,
  };
}

/**
 * release.commit - Mark release as committed (metadata only)
 * @task T4476
 */
export function releaseCommit(
  version: string,
  projectRoot?: string
): EngineResult {
  if (!version) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'version is required' } };
  }

  const normalizedVersion = normalizeVersion(version);
  const index = readReleases(projectRoot);
  const release = index.releases.find((r) => r.version === normalizedVersion);

  if (!release) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Release ${normalizedVersion} not found` },
    };
  }

  if (release.status !== 'prepared') {
    return {
      success: false,
      error: {
        code: 'E_INVALID_STATE',
        message: `Release ${normalizedVersion} is in state '${release.status}', expected 'prepared'`,
      },
    };
  }

  release.status = 'committed';
  release.committedAt = new Date().toISOString();
  writeReleases(index, projectRoot);

  return {
    success: true,
    data: {
      version: normalizedVersion,
      status: 'committed',
      committedAt: release.committedAt,
    },
  };
}

/**
 * release.tag - Mark release as tagged (metadata only)
 * @task T4476
 */
export function releaseTag(
  version: string,
  projectRoot?: string
): EngineResult {
  if (!version) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'version is required' } };
  }

  const normalizedVersion = normalizeVersion(version);
  const index = readReleases(projectRoot);
  const release = index.releases.find((r) => r.version === normalizedVersion);

  if (!release) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Release ${normalizedVersion} not found` },
    };
  }

  release.status = 'tagged';
  release.taggedAt = new Date().toISOString();
  index.latest = normalizedVersion;
  writeReleases(index, projectRoot);

  return {
    success: true,
    data: {
      version: normalizedVersion,
      status: 'tagged',
      taggedAt: release.taggedAt,
    },
  };
}

/**
 * release.gates.run - Run release gates (validation checks)
 * @task T4476
 */
export async function releaseGatesRun(
  version: string,
  projectRoot?: string
): Promise<EngineResult> {
  if (!version) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'version is required' } };
  }

  const normalizedVersion = normalizeVersion(version);
  const index = readReleases(projectRoot);
  const release = index.releases.find((r) => r.version === normalizedVersion);

  if (!release) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Release ${normalizedVersion} not found` },
    };
  }

  const gates: Array<{ name: string; status: 'passed' | 'failed'; message: string }> = [];

  // Gate 1: Version is valid format (X.Y.Z or CalVer)
  gates.push({
    name: 'version_valid',
    status: isValidVersion(normalizedVersion) ? 'passed' : 'failed',
    message: isValidVersion(normalizedVersion) ? 'Version format is valid' : 'Invalid version format',
  });

  // Gate 2: Has tasks
  gates.push({
    name: 'has_tasks',
    status: release.tasks.length > 0 ? 'passed' : 'failed',
    message: release.tasks.length > 0 ? `${release.tasks.length} tasks included` : 'No tasks in release',
  });

  // Gate 3: Changelog exists
  gates.push({
    name: 'has_changelog',
    status: release.changelog ? 'passed' : 'failed',
    message: release.changelog ? 'Changelog generated' : 'No changelog generated. Run release.changelog first.',
  });

  // Gate 4: All tasks completed
  const allTasks = await loadTasks(projectRoot);
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
    success: true,
    data: {
      version: normalizedVersion,
      allPassed,
      gates,
      passedCount: gates.filter((g) => g.status === 'passed').length,
      failedCount: gates.filter((g) => g.status === 'failed').length,
    },
  };
}

/**
 * release.rollback - Rollback a release
 * @task T4476
 */
export function releaseRollback(
  version: string,
  reason?: string,
  projectRoot?: string
): EngineResult {
  if (!version) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'version is required' } };
  }

  const normalizedVersion = normalizeVersion(version);
  const index = readReleases(projectRoot);
  const release = index.releases.find((r) => r.version === normalizedVersion);

  if (!release) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Release ${normalizedVersion} not found` },
    };
  }

  const previousStatus = release.status;
  release.status = 'rolled_back';

  // If this was the latest, clear it
  if (index.latest === normalizedVersion) {
    // Find previous version
    const otherReleases = index.releases
      .filter((r) => r.version !== normalizedVersion && r.status !== 'rolled_back')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    index.latest = otherReleases[0]?.version;
  }

  writeReleases(index, projectRoot);

  return {
    success: true,
    data: {
      version: normalizedVersion,
      previousStatus,
      status: 'rolled_back',
      reason: reason || 'No reason provided',
    },
  };
}

/**
 * release.push - Push release to remote via git
 * Uses execFileSync (no shell) for safety.
 * @task T4632
 */
export function releasePush(
  version: string,
  remote?: string,
  projectRoot?: string
): EngineResult {
  if (!version) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'version is required' } };
  }

  const normalizedVersion = normalizeVersion(version);
  const root = projectRoot || resolveProjectRoot();
  const index = readReleases(root);
  const release = index.releases.find((r) => r.version === normalizedVersion);

  if (!release) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Release ${normalizedVersion} not found` },
    };
  }

  const targetRemote = remote || 'origin';

  try {
    // Push with follow-tags to include the release tag
    execFileSync('git', ['push', targetRemote, '--follow-tags'], {
      cwd: root,
      timeout: 60000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Update release status
    release.status = 'pushed';
    release.pushedAt = new Date().toISOString();
    writeReleases(index, root);

    return {
      success: true,
      data: {
        version: normalizedVersion,
        status: 'pushed',
        remote: targetRemote,
        pushedAt: release.pushedAt,
      },
    };
  } catch (error: unknown) {
    const execError = error as { status?: number; stderr?: string };
    return {
      success: false,
      error: {
        code: 'E_PUSH_FAILED',
        message: `Git push failed: ${(execError.stderr || '').slice(0, 500)}`,
        details: { exitCode: execError.status },
      },
    };
  }
}
