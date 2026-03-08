/**
 * Release manifest operations backed by the release_manifests SQLite table.
 *
 * Migrated from .cleo/releases.json to SQLite per T5580.
 * All reads/writes now go through Drizzle ORM via tasks.db.
 *
 * @task T5580
 * @task T4788
 */

import { execFileSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, count, desc, eq } from 'drizzle-orm';
import { readJson } from '../../store/json.js';
import { getDb } from '../../store/sqlite.js';
import * as schema from '../../store/tasks-schema.js';
import { createPage } from '../pagination.js';
import { getCleoDirAbsolute, getProjectRoot } from '../paths.js';
import { parseChangelogBlocks, writeChangelogSection } from './changelog-writer.js';
import type { ReleaseChannel } from './channel.js';
import { resolveChannelFromBranch } from './channel.js';
import type { BranchProtectionResult } from './github-pr.js';
import { detectBranchProtection } from './github-pr.js';
import type { PushMode } from './release-config.js';
import {
  getChannelConfig,
  getGitFlowConfig,
  getPushMode,
  loadReleaseConfig,
} from './release-config.js';

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

export interface ReleaseListOptions {
  status?: ReleaseManifest['status'];
  limit?: number;
  offset?: number;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  return typeof limit === 'number' && limit > 0 ? limit : undefined;
}

function normalizeOffset(offset: number | undefined): number | undefined {
  return typeof offset === 'number' && offset > 0 ? offset : undefined;
}

function effectivePageLimit(
  limit: number | undefined,
  offset: number | undefined,
): number | undefined {
  return limit ?? (offset !== undefined ? 50 : undefined);
}

/** Task record shape needed for release operations. */
export interface ReleaseTaskRecord {
  id: string;
  title: string;
  status: string;
  parentId?: string;
  completedAt?: string | null;
  labels?: string[];
  /** Structured task type — 'epic' | 'task' | 'subtask'. Used for changelog filtering and categorization. */
  type?: string;
  /** Task description. Used to enrich changelog entries when meaningfully different from the title. */
  description?: string;
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
    releaseTasks = allTasks.filter((t) => t.status === 'done' && t.completedAt).map((t) => t.id);
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

  await db
    .insert(schema.releaseManifests)
    .values({
      id,
      version: normalizedVersion,
      status: 'prepared',
      tasksJson: JSON.stringify(releaseTasks),
      notes: notes ?? null,
      previousVersion: previousVersion ?? null,
      createdAt: now,
      preparedAt: now,
    })
    .run();

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
  const changes: string[] = [];

  /**
   * Strip conventional commit prefixes from task titles.
   * e.g. "feat: add auth" → "Add auth", "fix(ui): button" → "Button"
   */
  function stripConventionalPrefix(title: string): string {
    return title.replace(
      /^(feat|fix|docs?|test|chore|refactor|style|ci|build|perf)(\([^)]+\))?:\s*/i,
      '',
    );
  }

  /**
   * Capitalize the first character of a string.
   */
  function capitalize(s: string): string {
    return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
  }

  /**
   * Build a changelog entry line for a task.
   * Uses description to enrich the entry when it's meaningfully different from the title.
   */
  function buildEntry(task: ReleaseTaskRecord): string {
    const cleanTitle = capitalize(stripConventionalPrefix(task.title));
    // Strip newlines and collapse whitespace in description
    const safeDesc = task.description
      ?.replace(/\r?\n/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const desc = safeDesc;

    // Include description only when it's non-trivial and adds information beyond the title.
    // Skip if: description is empty, identical to title, or a minor rephrasing (≤10% longer, no new words).
    const shouldIncludeDesc = ((): boolean => {
      if (!desc || desc.length === 0) return false;
      const titleNorm = cleanTitle
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim();
      const descNorm = desc
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim();
      if (titleNorm === descNorm) return false;
      if (descNorm.startsWith(titleNorm) && descNorm.length < titleNorm.length * 1.3) return false;
      // Require description to be at least 20 chars and contain different content
      return desc.length >= 20;
    })();

    if (shouldIncludeDesc) {
      // Truncate long descriptions to keep changelog readable
      const descDisplay = desc!.length > 150 ? desc!.slice(0, 147) + '...' : desc!;
      return `- **${cleanTitle}**: ${descDisplay} (${task.id})`;
    }

    return `- ${cleanTitle} (${task.id})`;
  }

  /**
   * Categorize a task into a changelog section.
   * Priority order:
   *   1. task.type field ('epic' → skip, others are hints for 'task'/'subtask')
   *   2. task.labels array
   *   3. Title keyword scan (with conventional prefix stripped)
   */
  function categorizeTask(
    task: ReleaseTaskRecord,
  ): 'features' | 'fixes' | 'docs' | 'tests' | 'chores' | 'changes' {
    // Fix A: Skip epics entirely — they are parent containers, not deliverables
    if (task.type === 'epic') return 'changes'; // Will be filtered out by the caller

    // Priority 1: task.type field is the most authoritative signal
    const taskType = (task.type ?? '').toLowerCase();
    if (taskType === 'test') return 'tests';
    if (taskType === 'fix' || taskType === 'bugfix') return 'fixes';
    if (taskType === 'feat' || taskType === 'feature') return 'features';
    if (taskType === 'docs' || taskType === 'doc') return 'docs';
    if (taskType === 'chore' || taskType === 'refactor') return 'chores';

    // Priority 2: conventional commit prefix in raw title
    if (/^feat(\([^)]+\))?:/.test(task.title.toLowerCase())) return 'features';
    if (/^fix(\([^)]+\))?:/.test(task.title.toLowerCase())) return 'fixes';
    if (/^docs?(\([^)]+\))?:/.test(task.title.toLowerCase())) return 'docs';
    if (/^test(\([^)]+\))?:/.test(task.title.toLowerCase())) return 'tests';
    if (/^(chore|refactor|style|ci|build|perf)(\([^)]+\))?:/.test(task.title.toLowerCase()))
      return 'chores';

    // Priority 3: labels for strong category signals
    const labels = task.labels ?? [];
    if (labels.some((l) => ['test', 'testing'].includes(l.toLowerCase()))) return 'tests';
    if (labels.some((l) => ['fix', 'bug', 'bugfix', 'regression'].includes(l.toLowerCase())))
      return 'fixes';
    if (labels.some((l) => ['feat', 'feature', 'enhancement', 'add'].includes(l.toLowerCase())))
      return 'features';
    if (labels.some((l) => ['docs', 'documentation'].includes(l.toLowerCase()))) return 'docs';
    if (
      labels.some((l) => ['chore', 'refactor', 'cleanup', 'maintenance'].includes(l.toLowerCase()))
    )
      return 'chores';

    // Priority 4: keyword scan on the cleaned title
    const titleLower = stripConventionalPrefix(task.title).toLowerCase();
    const rawTitleLower = task.title.toLowerCase();
    if (
      titleLower.startsWith('test') ||
      (titleLower.includes('test') && titleLower.includes('add'))
    )
      return 'tests';
    if (
      titleLower.includes('bug') ||
      titleLower.startsWith('fix') ||
      titleLower.includes('regression') ||
      titleLower.includes('broken')
    )
      return 'fixes';
    if (
      titleLower.startsWith('add ') ||
      titleLower.includes('implement') ||
      titleLower.startsWith('create ') ||
      titleLower.startsWith('introduce ')
    )
      return 'features';
    if (
      titleLower.startsWith('doc') ||
      titleLower.includes('documentation') ||
      titleLower.includes('readme') ||
      titleLower.includes('changelog')
    )
      return 'docs';
    if (
      titleLower.startsWith('chore') ||
      titleLower.includes('refactor') ||
      titleLower.includes('cleanup') ||
      titleLower.includes('migrate') ||
      titleLower.includes('upgrade') ||
      titleLower.includes('remove ') ||
      titleLower.startsWith('audit')
    )
      return 'chores';

    // Raw title scan for backward compat
    if (rawTitleLower.startsWith('feat')) return 'features';

    return 'changes';
  }

  for (const taskId of releaseTasks) {
    const task = taskMap.get(taskId);
    if (!task) continue;

    // Fix A: Filter out epics — they are containers, not changelog entries
    if (task.type === 'epic') continue;
    // Also filter by label in case type field is not populated
    if (task.labels?.some((l) => l.toLowerCase() === 'epic')) continue;
    // Heuristic: titles starting with "EPIC:" are epics even without type field
    if (/^epic:/i.test(task.title.trim())) continue;

    // Filter out research/internal/spike/audit tasks — not user-facing deliverables
    const labelsLower = (task.labels ?? []).map((l) => l.toLowerCase());
    if (labelsLower.some((l) => ['research', 'internal', 'spike', 'audit'].includes(l))) continue;
    if (['spike', 'research'].includes((task.type ?? '').toLowerCase())) continue;
    if (/^(research|investigate|audit|spike)\s/i.test(task.title.trim())) continue;

    const category = categorizeTask(task);
    const entry = buildEntry(task);

    if (category === 'features') features.push(entry);
    else if (category === 'fixes') fixes.push(entry);
    else if (category === 'docs') docs.push(entry);
    else if (category === 'tests') tests.push(entry);
    else if (category === 'chores') chores.push(entry);
    else changes.push(entry);
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
  if (changes.length > 0) {
    sections.push('### Changes');
    sections.push(...changes);
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
  await writeChangelogSection(
    normalizedVersion.replace(/^v/, ''),
    changelogBody,
    customBlocks,
    changelogPath,
  );

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
      changes: changes.length,
    },
  };
}

/**
 * List all releases.
 * @task T4788
 */
export async function listManifestReleases(
  optionsOrCwd?: ReleaseListOptions | string,
  cwd?: string,
): Promise<{
  releases: Array<{ version: string; status: string; createdAt: string; taskCount: number }>;
  total: number;
  filtered: number;
  latest?: string;
  page: ReturnType<typeof createPage>;
}> {
  const options =
    typeof optionsOrCwd === 'string' || optionsOrCwd === undefined ? {} : optionsOrCwd;
  const effectiveCwd = typeof optionsOrCwd === 'string' ? optionsOrCwd : cwd;
  const limit = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.offset);
  const pageLimit = effectivePageLimit(limit, offset);

  const db = await getDb(effectiveCwd);
  const totalRow = await db.select({ count: count() }).from(schema.releaseManifests).get();
  const total = totalRow?.count ?? 0;

  const conditions = options.status ? [eq(schema.releaseManifests.status, options.status)] : [];
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const filteredRow = await db
    .select({ count: count() })
    .from(schema.releaseManifests)
    .where(whereClause)
    .get();
  const filtered = filteredRow?.count ?? 0;

  let query = db
    .select()
    .from(schema.releaseManifests)
    .where(whereClause)
    .orderBy(desc(schema.releaseManifests.createdAt));

  if (pageLimit !== undefined) {
    query = query.limit(pageLimit) as typeof query;
  }
  if (offset !== undefined) {
    query = query.offset(offset) as typeof query;
  }

  const rows = await query.all();

  const latest = await findLatestPushedVersion(effectiveCwd);

  return {
    releases: rows.map((r) => ({
      version: r.version,
      status: r.status,
      createdAt: r.createdAt,
      taskCount: (JSON.parse(r.tasksJson) as string[]).length,
    })),
    total,
    filtered,
    latest,
    page: createPage({ total: filtered, limit: pageLimit, offset }),
  };
}

/**
 * Show release details.
 * @task T4788
 */
export async function showManifestRelease(version: string, cwd?: string): Promise<ReleaseManifest> {
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
    throw new Error(
      `Release ${normalizedVersion} is in state '${rows[0]!.status}', expected 'prepared'`,
    );
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
 * @task T5586
 */
export async function runReleaseGates(
  version: string,
  loadTasksFn: () => Promise<ReleaseTaskRecord[]>,
  cwd?: string,
  opts?: { dryRun?: boolean },
): Promise<{
  version: string;
  allPassed: boolean;
  gates: Array<{ name: string; status: 'passed' | 'failed'; message: string }>;
  passedCount: number;
  failedCount: number;
  metadata: ReleaseGateMetadata;
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
    message: isValidVersion(normalizedVersion)
      ? 'Version format is valid'
      : 'Invalid version format',
  });

  gates.push({
    name: 'has_tasks',
    status: releaseTasks.length > 0 ? 'passed' : 'failed',
    message:
      releaseTasks.length > 0 ? `${releaseTasks.length} tasks included` : 'No tasks in release',
  });

  gates.push({
    name: 'has_changelog',
    status: row.changelog ? 'passed' : 'failed',
    message: row.changelog
      ? 'Changelog generated'
      : 'No changelog generated. Run release.changelog first.',
  });

  const allTasks = await loadTasksFn();
  const incompleteTasks = releaseTasks.filter((id) => {
    const task = allTasks.find((t) => t.id === id);
    return task && task.status !== 'done';
  });

  gates.push({
    name: 'tasks_complete',
    status: incompleteTasks.length === 0 ? 'passed' : 'failed',
    message:
      incompleteTasks.length === 0
        ? 'All tasks completed'
        : `${incompleteTasks.length} tasks not completed: ${incompleteTasks.join(', ')}`,
  });

  // G2: Build artifact — dist/cli/index.js must exist (Node projects only)
  const projectRoot = cwd ?? getProjectRoot();
  const distPath = join(projectRoot, 'dist', 'cli', 'index.js');
  const isNodeProject = existsSync(join(projectRoot, 'package.json'));
  if (isNodeProject) {
    gates.push({
      name: 'build_artifact',
      status: existsSync(distPath) ? 'passed' : 'failed',
      message: existsSync(distPath)
        ? 'dist/cli/index.js present'
        : 'dist/ not built — run: npm run build',
    });
  }

  // GD1: Clean working tree (CHANGELOG.md and VERSION are allowed to be dirty)
  // Skipped in dry-run mode — dry-run makes no commits so tree cleanliness is irrelevant.
  // Untracked files (?? lines) are excluded from the dirty check — they do not affect git
  // commit/tag operations and must not block releases.
  if (opts?.dryRun) {
    gates.push({
      name: 'clean_working_tree',
      status: 'passed',
      message: 'Skipped in dry-run mode',
    });
  } else {
    let workingTreeClean = true;
    let dirtyFiles: string[] = [];
    try {
      const porcelain = execFileSync('git', ['status', '--porcelain'], {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      dirtyFiles = porcelain
        .split('\n')
        .filter((l) => l.trim())
        // Exclude untracked files (?? prefix) — they don't affect commits or tags
        .filter((l) => !l.startsWith('?? '))
        .map((l) => l.slice(3).trim())
        .filter((f) => f !== 'CHANGELOG.md' && f !== 'VERSION' && f !== 'package.json');
      workingTreeClean = dirtyFiles.length === 0;
    } catch {
      /* git not available — skip */
    }
    gates.push({
      name: 'clean_working_tree',
      status: workingTreeClean ? 'passed' : 'failed',
      message: workingTreeClean
        ? 'Working tree clean (excluding CHANGELOG.md, VERSION, package.json)'
        : `Uncommitted changes in: ${dirtyFiles.slice(0, 5).join(', ')}${dirtyFiles.length > 5 ? ` (+${dirtyFiles.length - 5} more)` : ''}`,
    });
  }

  // GD2: Branch target — use GitFlow config if available, else defaults
  const isPreRelease = normalizedVersion.includes('-');
  let currentBranch = '';
  try {
    currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch {
    /* git not available — skip */
  }

  const releaseConfig = loadReleaseConfig(cwd);
  const gitFlowCfg = getGitFlowConfig(releaseConfig);
  const channelCfg = getChannelConfig(releaseConfig);

  const expectedBranch = isPreRelease ? gitFlowCfg.branches.develop : gitFlowCfg.branches.main;

  const isFeatureBranch =
    currentBranch.startsWith(gitFlowCfg.branches.featurePrefix) ||
    currentBranch.startsWith(gitFlowCfg.branches.hotfixPrefix) ||
    currentBranch.startsWith(gitFlowCfg.branches.releasePrefix);

  const branchOk =
    !currentBranch || // git unavailable → pass
    currentBranch === 'HEAD' || // detached HEAD → pass
    currentBranch === expectedBranch || // exactly right branch → pass
    (isPreRelease && isFeatureBranch); // feature/hotfix/release branch with pre-release → pass

  // Resolve channel from current branch
  const detectedChannel: ReleaseChannel = currentBranch
    ? resolveChannelFromBranch(currentBranch, channelCfg)
    : isPreRelease
      ? 'beta'
      : 'latest';

  gates.push({
    name: 'branch_target',
    status: branchOk ? 'passed' : 'failed',
    message: branchOk
      ? `On correct branch: ${currentBranch} (channel: ${detectedChannel})`
      : `Expected branch '${expectedBranch}' for ${isPreRelease ? 'pre-release' : 'stable'} release, but on '${currentBranch}'`,
  });

  // GD3: Branch protection — detect if push requires a PR (informational, never fails)
  const pushMode = getPushMode(releaseConfig);
  let requiresPR = false;
  if (pushMode === 'pr') {
    requiresPR = true;
  } else if (pushMode === 'auto') {
    try {
      const protectionResult: BranchProtectionResult = await detectBranchProtection(
        expectedBranch,
        'origin',
        projectRoot,
      );
      requiresPR = protectionResult.protected;
    } catch {
      // Branch protection detection is best-effort; never block release
      requiresPR = false;
    }
  }
  gates.push({
    name: 'branch_protection',
    status: 'passed',
    message: requiresPR
      ? `Branch '${expectedBranch}' is protected — release.ship will create a PR`
      : `Branch '${expectedBranch}' allows direct push`,
  });

  const allPassed = gates.every((g) => g.status === 'passed');

  const metadata: ReleaseGateMetadata = {
    channel: detectedChannel,
    requiresPR,
    targetBranch: expectedBranch,
    currentBranch,
  };

  return {
    version: normalizedVersion,
    allPassed,
    gates,
    passedCount: gates.filter((g) => g.status === 'passed').length,
    failedCount: gates.filter((g) => g.status === 'failed').length,
    metadata,
  };
}

/**
 * Cancel and remove a release in draft or prepared state.
 * Only releases that have not yet been committed to git can be cancelled.
 * For committed/tagged/pushed releases, use rollbackRelease() instead.
 *
 * @task T5602
 */
export async function cancelRelease(
  version: string,
  projectRoot?: string,
): Promise<{ success: boolean; message: string; version: string }> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const db = await getDb(projectRoot);
  const rows = await db
    .select()
    .from(schema.releaseManifests)
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    return {
      success: false,
      message: `Release ${normalizedVersion} not found`,
      version: normalizedVersion,
    };
  }

  const status = rows[0]!.status;
  const cancellableStates = ['draft', 'prepared'] as const;

  if (!(cancellableStates as readonly string[]).includes(status)) {
    return {
      success: false,
      message: `Cannot cancel a release in '${status}' state. Use 'release rollback' instead.`,
      version: normalizedVersion,
    };
  }

  await db
    .delete(schema.releaseManifests)
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .run();

  return {
    success: true,
    message: `Release ${normalizedVersion} cancelled and removed`,
    version: normalizedVersion,
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

/**
 * Metadata captured during gate evaluation, returned alongside gate results.
 * Downstream (engine layer) uses this to determine PR vs direct push.
 */
export interface ReleaseGateMetadata {
  /** npm dist-tag channel resolved from the current branch. */
  channel: ReleaseChannel;
  /** Whether the target branch requires a PR (branch protection detected or mode='pr'). */
  requiresPR: boolean;
  /** Branch that should be targeted for this release type. */
  targetBranch: string;
  /** Branch the repo is currently on. */
  currentBranch: string;
}

/** Push policy configuration from config.release.push. */
export interface PushPolicy {
  enabled?: boolean;
  remote?: string;
  requireCleanTree?: boolean;
  allowedBranches?: string[];
  /** Push mode override: 'direct' | 'pr' | 'auto' (default: 'direct'). */
  mode?: PushMode;
  /** Override PR target branch (default: auto-detected from GitFlow config). */
  prBase?: string;
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
  opts?: {
    explicitPush?: boolean;
    mode?: PushMode;
    prBase?: string;
    epicId?: string;
    guided?: boolean;
  },
): Promise<{
  version: string;
  status: string;
  remote: string;
  pushedAt: string;
  requiresPR?: boolean;
}> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const projectRoot = getProjectRoot(cwd);
  const pushPolicy = await readPushPolicy(cwd);

  // Resolve effective push mode: opts.mode > pushPolicy.mode > config > 'direct'
  const configPushMode = getPushMode(loadReleaseConfig(cwd));
  const effectivePushMode: PushMode = opts?.mode ?? pushPolicy?.mode ?? configPushMode;

  // If branch protection detected and mode allows PR creation, signal PR required
  if (effectivePushMode === 'pr' || effectivePushMode === 'auto') {
    const targetRemoteForCheck = remote ?? pushPolicy?.remote ?? 'origin';
    let branchIsProtected = effectivePushMode === 'pr'; // 'pr' always requires PR
    if (effectivePushMode === 'auto') {
      try {
        const protection = await detectBranchProtection(
          pushPolicy?.allowedBranches?.[0] ?? 'main',
          targetRemoteForCheck,
          projectRoot,
        );
        branchIsProtected = protection.protected;
      } catch {
        // Best-effort; default to direct push if detection fails
        branchIsProtected = false;
      }
    }
    if (branchIsProtected) {
      return {
        version: normalizedVersion,
        status: 'requires_pr',
        remote: targetRemoteForCheck,
        pushedAt: new Date().toISOString(),
        requiresPR: true,
      };
    }
  }

  // If push policy says disabled and caller didn't explicitly pass --push, skip
  if (pushPolicy && pushPolicy.enabled === false && !opts?.explicitPush) {
    throw new Error(
      'Push is disabled by config (release.push.enabled=false). Use --push to override.',
    );
  }

  // Determine remote: explicit param > config > 'origin'
  const targetRemote = remote ?? pushPolicy?.remote ?? 'origin';

  // Check requireCleanTree
  // Untracked files (?? lines) are excluded — they do not affect push operations.
  if (pushPolicy?.requireCleanTree) {
    const statusOutput = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const trackedDirty = statusOutput
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('?? '))
      .join('\n');
    if (trackedDirty.trim().length > 0) {
      throw new Error(
        'Git working tree is not clean. Commit or stash changes before pushing (config: release.push.requireCleanTree=true).',
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
        `Current branch '${currentBranch}' is not in allowed branches: ${pushPolicy.allowedBranches.join(', ')} (config: release.push.allowedBranches).`,
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
    await db
      .insert(schema.releaseManifests)
      .values({
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
      })
      .run();

    migrated++;
  }

  // Rename legacy file on success
  renameSync(releasesPath, releasesPath + '.migrated');

  return { migrated };
}
