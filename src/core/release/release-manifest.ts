/**
 * Release manifest operations backed by the release_manifests SQLite table.
 *
 * Migrated from .cleo/releases.json to SQLite per T5580.
 * All reads/writes now go through Drizzle ORM via tasks.db.
 *
 * @task T5580
 * @task T4788
 */

import { existsSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../../store/sqlite.js';
import * as schema from '../../store/schema.js';
import { getCleoDirAbsolute, getProjectRoot } from '../paths.js';
import { readJson } from '../../store/json.js';
import { parseChangelogBlocks, writeChangelogSection } from './changelog-writer.js';

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
  commitSha?: string;
  gitTag?: string;
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

function isValidVersion(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version);
}

function normalizeVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

function rowToManifest(row: schema.ReleaseManifestRow): ReleaseManifest {
  return {
    version: row.version,
    status: row.status as ReleaseManifest['status'],
    createdAt: row.createdAt,
    preparedAt: row.preparedAt ?? undefined,
    committedAt: row.committedAt ?? undefined,
    taggedAt: row.taggedAt ?? undefined,
    pushedAt: row.pushedAt ?? undefined,
    tasks: JSON.parse(row.tasksJson) as string[],
    notes: row.notes ?? undefined,
    changelog: row.changelog ?? undefined,
    previousVersion: row.previousVersion ?? undefined,
    commitSha: row.commitSha ?? undefined,
    gitTag: row.gitTag ?? undefined,
  };
}

async function findLatestPushedVersion(cwd?: string): Promise<string | undefined> {
  const db = await getDb(cwd);
  const rows = await db
    .select({ version: schema.releaseManifests.version })
    .from(schema.releaseManifests)
    .where(eq(schema.releaseManifests.status, 'pushed'))
    .orderBy(desc(schema.releaseManifests.pushedAt))
    .limit(1)
    .all();
  return rows[0]?.version;
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
  const db = await getDb(cwd);

  const existing = await db
    .select()
    .from(schema.releaseManifests)
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .limit(1)
    .all();

  if (existing.length > 0) {
    throw new Error(`Release ${normalizedVersion} already exists (status: ${existing[0]!.status})`);
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

  const previousVersion = await findLatestPushedVersion(cwd);
  const now = new Date().toISOString();
  const id = `rel-${normalizedVersion.replace(/[^a-z0-9]/gi, '-')}`;

  await db.insert(schema.releaseManifests).values({
    id,
    version: normalizedVersion,
    status: 'prepared',
    tasksJson: JSON.stringify(releaseTasks),
    notes: notes ?? null,
    previousVersion: previousVersion ?? null,
    createdAt: now,
    preparedAt: now,
  }).run();

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
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.releaseManifests)
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  const row = rows[0]!;
  const releaseTasks: string[] = JSON.parse(row.tasksJson);

  const allTasks = await loadTasksFn();
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  const features: string[] = [];
  const fixes: string[] = [];
  const chores: string[] = [];
  const docs: string[] = [];
  const tests: string[] = [];
  const other: string[] = [];

  for (const taskId of releaseTasks) {
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

  if (row.notes) {
    sections.push(row.notes);
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

  await db
    .update(schema.releaseManifests)
    .set({ changelog })
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .run();

  // Write or update CHANGELOG.md with section-aware merge
  const changelogPath = join(cwd ?? process.cwd(), 'CHANGELOG.md');
  let existingChangelogContent = '';
  try {
    existingChangelogContent = await readFile(changelogPath, 'utf8');
  } catch {
    // File doesn't exist yet — start fresh
  }
  const { customBlocks } = parseChangelogBlocks(existingChangelogContent);

  // Build the changelog body (content after the ## header line)
  const changelogBody = sections.slice(2).join('\n'); // skip header + blank line
  await writeChangelogSection(normalizedVersion, changelogBody, customBlocks, changelogPath);

  return {
    version: normalizedVersion,
    changelog,
    taskCount: releaseTasks.length,
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
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.releaseManifests)
    .orderBy(desc(schema.releaseManifests.createdAt))
    .all();

  const latest = await findLatestPushedVersion(cwd);

  return {
    releases: rows.map((r) => ({
      version: r.version,
      status: r.status,
      createdAt: r.createdAt,
      taskCount: (JSON.parse(r.tasksJson) as string[]).length,
    })),
    total: rows.length,
    latest,
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
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.releaseManifests)
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  return rowToManifest(rows[0]!);
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
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.releaseManifests)
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  if (rows[0]!.status !== 'prepared') {
    throw new Error(`Release ${normalizedVersion} is in state '${rows[0]!.status}', expected 'prepared'`);
  }

  const committedAt = new Date().toISOString();
  await db
    .update(schema.releaseManifests)
    .set({ status: 'committed', committedAt })
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .run();

  return { version: normalizedVersion, status: 'committed', committedAt };
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
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.releaseManifests)
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  const taggedAt = new Date().toISOString();
  await db
    .update(schema.releaseManifests)
    .set({ status: 'tagged', taggedAt })
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .run();

  return { version: normalizedVersion, status: 'tagged', taggedAt };
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
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.releaseManifests)
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  const row = rows[0]!;
  const releaseTasks: string[] = JSON.parse(row.tasksJson);

  const gates: Array<{ name: string; status: 'passed' | 'failed'; message: string }> = [];

  gates.push({
    name: 'version_valid',
    status: isValidVersion(normalizedVersion) ? 'passed' : 'failed',
    message: isValidVersion(normalizedVersion) ? 'Version format is valid' : 'Invalid version format',
  });

  gates.push({
    name: 'has_tasks',
    status: releaseTasks.length > 0 ? 'passed' : 'failed',
    message: releaseTasks.length > 0 ? `${releaseTasks.length} tasks included` : 'No tasks in release',
  });

  gates.push({
    name: 'has_changelog',
    status: row.changelog ? 'passed' : 'failed',
    message: row.changelog ? 'Changelog generated' : 'No changelog generated. Run release.changelog first.',
  });

  const allTasks = await loadTasksFn();
  const incompleteTasks = releaseTasks.filter((id) => {
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
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.releaseManifests)
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  const previousStatus = rows[0]!.status;
  await db
    .update(schema.releaseManifests)
    .set({ status: 'rolled_back' })
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .run();

  return {
    version: normalizedVersion,
    previousStatus,
    status: 'rolled_back',
    reason: reason ?? 'No reason provided',
  };
}

/** Push policy configuration from config.release.push. */
export interface PushPolicy {
  enabled?: boolean;
  remote?: string;
  requireCleanTree?: boolean;
  allowedBranches?: string[];
}

/**
 * Read push policy from project config.
 * Returns undefined if no push config exists.
 */
async function readPushPolicy(cwd?: string): Promise<PushPolicy | undefined> {
  const configPath = join(getCleoDirAbsolute(cwd), 'config.json');
  const config = await readJson<Record<string, unknown>>(configPath);
  if (!config) return undefined;
  const release = config.release as Record<string, unknown> | undefined;
  if (!release) return undefined;
  return release.push as PushPolicy | undefined;
}

/**
 * Push release to remote via git.
 *
 * Respects config.release.push policy:
 * - remote: override default remote (fallback to 'origin')
 * - requireCleanTree: verify git working tree is clean before push
 * - allowedBranches: verify current branch is in the allowed list
 * - enabled: if false and no explicit push flag, caller should skip
 *
 * @task T4788
 * @task T4276
 */
export async function pushRelease(
  version: string,
  remote?: string,
  cwd?: string,
  opts?: { explicitPush?: boolean },
): Promise<{
  version: string;
  status: string;
  remote: string;
  pushedAt: string;
}> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const projectRoot = getProjectRoot(cwd);
  const pushPolicy = await readPushPolicy(cwd);

  // If push policy says disabled and caller didn't explicitly pass --push, skip
  if (pushPolicy && pushPolicy.enabled === false && !opts?.explicitPush) {
    throw new Error(
      'Push is disabled by config (release.push.enabled=false). Use --push to override.'
    );
  }

  // Determine remote: explicit param > config > 'origin'
  const targetRemote = remote ?? pushPolicy?.remote ?? 'origin';

  // Check requireCleanTree
  if (pushPolicy?.requireCleanTree) {
    const statusOutput = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (statusOutput.trim().length > 0) {
      throw new Error(
        'Git working tree is not clean. Commit or stash changes before pushing (config: release.push.requireCleanTree=true).'
      );
    }
  }

  // Check allowedBranches
  if (pushPolicy?.allowedBranches && pushPolicy.allowedBranches.length > 0) {
    const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectRoot,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!pushPolicy.allowedBranches.includes(currentBranch)) {
      throw new Error(
        `Current branch '${currentBranch}' is not in allowed branches: ${pushPolicy.allowedBranches.join(', ')} (config: release.push.allowedBranches).`
      );
    }
  }

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
 * Update release status after push, with optional provenance fields.
 * @task T4788
 * @task T5580
 */
export async function markReleasePushed(
  version: string,
  pushedAt: string,
  cwd?: string,
  provenance?: { commitSha?: string; gitTag?: string },
): Promise<void> {
  const normalizedVersion = normalizeVersion(version);
  const db = await getDb(cwd);
  await db
    .update(schema.releaseManifests)
    .set({
      status: 'pushed',
      pushedAt,
      ...(provenance?.commitSha != null ? { commitSha: provenance.commitSha } : {}),
      ...(provenance?.gitTag != null ? { gitTag: provenance.gitTag } : {}),
    })
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .run();
}

/**
 * One-time migration: read .cleo/releases.json and insert each release into
 * the release_manifests table. Renames the file to releases.json.migrated on success.
 *
 * @task T5580
 */
export async function migrateReleasesJsonToSqlite(
  projectRoot?: string,
): Promise<{ migrated: number }> {
  const releasesPath = join(getCleoDirAbsolute(projectRoot), 'releases.json');

  if (!existsSync(releasesPath)) {
    return { migrated: 0 };
  }

  interface LegacyReleasesIndex {
    releases: Array<{
      version: string;
      status: string;
      createdAt: string;
      preparedAt?: string;
      committedAt?: string;
      taggedAt?: string;
      pushedAt?: string;
      tasks: string[];
      notes?: string;
      changelog?: string;
      previousVersion?: string;
    }>;
    latest?: string;
  }

  const raw = await readJson<LegacyReleasesIndex>(releasesPath);
  if (!raw || !Array.isArray(raw.releases)) {
    return { migrated: 0 };
  }

  const db = await getDb(projectRoot);
  let migrated = 0;

  for (const r of raw.releases) {
    // Skip if already exists by version
    const existing = await db
      .select({ id: schema.releaseManifests.id })
      .from(schema.releaseManifests)
      .where(eq(schema.releaseManifests.version, r.version))
      .limit(1)
      .all();

    if (existing.length > 0) continue;

    const id = `rel-${r.version.replace(/[^a-z0-9]/gi, '-')}`;
    await db.insert(schema.releaseManifests).values({
      id,
      version: r.version,
      status: r.status,
      tasksJson: JSON.stringify(r.tasks ?? []),
      notes: r.notes ?? null,
      changelog: r.changelog ?? null,
      previousVersion: r.previousVersion ?? null,
      createdAt: r.createdAt,
      preparedAt: r.preparedAt ?? null,
      committedAt: r.committedAt ?? null,
      taggedAt: r.taggedAt ?? null,
      pushedAt: r.pushedAt ?? null,
    }).run();

    migrated++;
  }

  // Rename legacy file on success
  renameSync(releasesPath, releasesPath + '.migrated');

  return { migrated };
}
