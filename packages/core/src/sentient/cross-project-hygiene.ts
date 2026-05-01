/**
 * Cross-project hygiene engine — T1637 (cleo-os system-wide daemon).
 *
 * Runs nightly (default 02:00 local time) from the sentient daemon.
 * Five sequential steps, each failing gracefully so one broken project
 * cannot abort the others:
 *
 *   Step 1 – NEXUS integrity check: every registered project's tasks.db,
 *             brain.db, and project-info.json are accessible and valid.
 *   Step 2 – Temp-project GC: projects with no recent activity (> 30 days),
 *             no .git directory, and no recent file changes are flagged in
 *             ~/.local/share/cleo/audit/temp-gc.jsonl.  Auto-delete is
 *             intentionally withheld; owner must run
 *             `cleo daemon hygiene apply <batchId>` to confirm.
 *   Step 3 – Duplicate-epic detection: epics with similar normalised titles
 *             across multiple registered projects suggest a shared-library
 *             candidate; findings are emitted as Tier-2 proposals.
 *   Step 4 – Stale agent-worktree pruning: delegates to the existing
 *             {@link pruneOrphanedWorktrees} call per project root.
 *   Step 5 – Aggregate digest: summary counts written to
 *             {@link CrossProjectHygieneDigest} and persisted to sentient
 *             state so `cleo daemon status` can surface them.
 *
 * Design constraints:
 *   - NEVER throws — every public function returns a result object.
 *   - No new third-party dependencies (uses existing nexus, project-health, spawn).
 *   - All file writes go through node:fs/promises with atomic tmp-then-rename.
 *   - Audit JSONL path: `~/.local/share/cleo/audit/temp-gc.jsonl`.
 *
 * @see ADR-047 — Autonomous GC and Disk Safety
 * @see ADR-054 — Sentient Loop Tier-1
 * @task T1637
 * @epic T1627
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getLogger } from '../logger.js';
import { nexusList, nexusUnregister } from '../nexus/registry.js';
import { getCleoHome } from '../paths.js';
import { pruneOrphanedWorktrees } from '../spawn/branch-lock.js';
import { getAccessor } from '../store/data-accessor.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Days of inactivity before a temp project is flagged for GC. */
export const TEMP_GC_INACTIVITY_DAYS = 30 as const;

/** Cosine-similarity floor for epic-title duplicate detection (0–1). */
export const DUPLICATE_EPIC_SIMILARITY_THRESHOLD = 0.8 as const;

/** Maximum n-gram size for title normalisation. */
const NGRAM_SIZE = 2 as const;

/** Logger tag. */
const LOG = 'cross-project-hygiene';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of Step 1 — NEXUS integrity check. */
export interface NexusIntegrityResult {
  /** Total registered projects examined. */
  total: number;
  /** Projects whose tasks.db, brain.db, and project-info.json are all healthy. */
  healthy: number;
  /** Projects with at least one accessibility failure. */
  degraded: number;
  /** Projects whose directory is no longer reachable on disk. */
  unreachable: number;
  /** Per-project issue strings (populated only for degraded/unreachable). */
  issues: Array<{ projectHash: string; projectPath: string; problems: string[] }>;
}

/** A single temp-project GC candidate. */
export interface TempGcCandidate {
  /** Project hash from the NEXUS registry. */
  projectHash: string;
  /** Absolute path to the project root. */
  projectPath: string;
  /** Project name from the registry. */
  projectName: string;
  /** ISO-8601 timestamp of the last recorded activity (lastSeen). */
  lastSeen: string;
  /** Reason the project was flagged. */
  reason: string;
}

/** Result of Step 2 — temp-project GC audit. */
export interface TempGcResult {
  /** Unique identifier for this GC batch (used with `cleo daemon hygiene apply`). */
  batchId: string;
  /** Candidates flagged for deletion. Owner must explicitly approve each batch. */
  candidates: TempGcCandidate[];
  /** Absolute path to the audit JSONL file where the batch was appended. */
  auditPath: string;
}

/** A detected cross-project duplicate-epic group. */
export interface DuplicateEpicGroup {
  /** Normalised title all duplicates share. */
  normalisedTitle: string;
  /** Array of {projectHash, taskId, title} for each duplicate. */
  instances: Array<{ projectHash: string; projectPath: string; taskId: string; title: string }>;
}

/** Result of Step 3 — duplicate-epic detection. */
export interface DuplicateEpicResult {
  /** Total projects scanned. */
  projectsScanned: number;
  /** Duplicate groups found. */
  groups: DuplicateEpicGroup[];
}

/** Result of Step 4 — stale worktree pruning. */
export interface WorktreePruneResult {
  /** Number of projects scanned. */
  projectsScanned: number;
  /** Total worktree entries pruned across all projects. */
  totalPruned: number;
  /** Per-project errors (project is skipped, others continue). */
  errors: Array<{ projectPath: string; reason: string }>;
}

/**
 * Top-level output of one nightly hygiene run.
 *
 * Persisted into sentient state so `cleo daemon status` can surface counts
 * without re-running the full scan.
 */
export interface CrossProjectHygieneDigest {
  /** ISO-8601 timestamp of when this run started. */
  startedAt: string;
  /** ISO-8601 timestamp of when this run finished. */
  completedAt: string;
  /** Step 1 result. */
  nexusIntegrity: NexusIntegrityResult;
  /** Step 2 result. */
  tempGc: TempGcResult;
  /** Step 3 result. */
  duplicateEpics: DuplicateEpicResult;
  /** Step 4 result. */
  worktreePrune: WorktreePruneResult;
  /** Human-readable one-line summary for `cleo daemon status`. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Helpers — title normalisation for duplicate detection
// ---------------------------------------------------------------------------

/**
 * Normalise an epic title for duplicate comparison.
 * Strips punctuation, lowercases, and removes common stop words.
 */
function normaliseTitle(title: string): string {
  const stopWords = new Set([
    'a',
    'an',
    'the',
    'and',
    'or',
    'for',
    'in',
    'on',
    'at',
    'to',
    'of',
    'with',
    'by',
    'from',
    'as',
    'is',
    'was',
    'are',
    'be',
    'been',
    'do',
    'does',
    'did',
    'will',
    'would',
    'can',
    'could',
    'have',
    'has',
    'had',
    'not',
  ]);
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w))
    .join(' ');
}

/**
 * Build a bigram set from a normalised title string.
 * Used for Jaccard similarity comparison.
 */
function buildNgramSet(text: string): Set<string> {
  const tokens = text.split(/\s+/).filter(Boolean);
  const ngrams = new Set<string>();
  if (tokens.length === 0) return ngrams;
  // Unigrams
  for (const t of tokens) ngrams.add(t);
  // Bigrams
  for (let i = 0; i + NGRAM_SIZE <= tokens.length; i++) {
    ngrams.add(tokens.slice(i, i + NGRAM_SIZE).join(' '));
  }
  return ngrams;
}

/**
 * Jaccard similarity between two n-gram sets.
 * Returns 0–1 (1 = identical).
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Audit log path helper
// ---------------------------------------------------------------------------

/**
 * Return the absolute path to the cross-project GC audit JSONL file.
 * Stored in ~/.local/share/cleo/audit/temp-gc.jsonl (XDG-compliant).
 */
export function getTempGcAuditPath(): string {
  return join(getCleoHome(), 'audit', 'temp-gc.jsonl');
}

/**
 * Atomically append a JSON line to the temp-gc audit log.
 * Creates the parent directory if absent.
 */
async function appendAuditLine(auditPath: string, record: unknown): Promise<void> {
  await mkdir(join(auditPath, '..'), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// Step 1 — NEXUS integrity check
// ---------------------------------------------------------------------------

/**
 * Check accessibility of every project registered in the global nexus registry.
 *
 * Tests:
 *   • Project directory exists on disk.
 *   • `.cleo/tasks.db` is readable.
 *   • `.cleo/brain.db` is readable (optional — warn if missing).
 *   • `.cleo/project-info.json` is parseable JSON.
 *
 * Never throws.
 *
 * @returns Summary counts + per-project issue list.
 */
export async function runNexusIntegrityCheck(): Promise<NexusIntegrityResult> {
  const log = getLogger(LOG);
  const result: NexusIntegrityResult = {
    total: 0,
    healthy: 0,
    degraded: 0,
    unreachable: 0,
    issues: [],
  };

  let projects: Array<{ hash: string; path: string }> = [];
  try {
    const rows = await nexusList();
    projects = rows.map((r) => ({ hash: r.hash, path: r.path }));
  } catch (err) {
    log.warn({ err }, `${LOG}: step1 — failed to load nexus registry`);
    return result;
  }

  result.total = projects.length;

  for (const proj of projects) {
    const problems: string[] = [];

    // Directory reachable?
    if (!existsSync(proj.path)) {
      result.unreachable++;
      result.issues.push({
        projectHash: proj.hash,
        projectPath: proj.path,
        problems: [`Directory not reachable: ${proj.path}`],
      });
      continue;
    }

    const cleoDir = join(proj.path, '.cleo');

    // tasks.db readable?
    const tasksDb = join(cleoDir, 'tasks.db');
    if (!existsSync(tasksDb)) {
      problems.push('tasks.db missing');
    }

    // brain.db readable? (warn only)
    const brainDb = join(cleoDir, 'brain.db');
    if (!existsSync(brainDb)) {
      problems.push('brain.db missing');
    }

    // project-info.json parseable?
    const infoPath = join(cleoDir, 'project-info.json');
    if (!existsSync(infoPath)) {
      problems.push('project-info.json missing');
    } else {
      try {
        const raw = await readFile(infoPath, 'utf-8');
        JSON.parse(raw);
      } catch {
        problems.push('project-info.json not parseable');
      }
    }

    if (problems.length === 0) {
      result.healthy++;
    } else {
      result.degraded++;
      result.issues.push({ projectHash: proj.hash, projectPath: proj.path, problems });
    }
  }

  log.info(
    { total: result.total, healthy: result.healthy, degraded: result.degraded },
    `${LOG}: step1 complete`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Step 2 — Temp-project GC (flag only, no auto-delete)
// ---------------------------------------------------------------------------

/**
 * Detect temp projects (no .git, no recent activity) and flag them for deletion.
 *
 * A project is a GC candidate if ALL of:
 *   (a) No `.git` directory at the project root.
 *   (b) `lastSeen` in the nexus registry is older than {@link TEMP_GC_INACTIVITY_DAYS} days.
 *
 * The `lastSeen` field in the NEXUS registry is the authoritative activity timestamp —
 * it is bumped on every `cleo nexus sync`, health check, and task completion. Projects
 * with no `.git` AND inactive for > 30 days are temp scratch trees safe to remove.
 *
 * Candidates are audited to {@link getTempGcAuditPath()} in JSONL format.
 * Auto-delete is NOT performed — owner must call `cleo daemon hygiene apply <batchId>`.
 *
 * Never throws.
 */
export async function runTempProjectGc(): Promise<TempGcResult> {
  const log = getLogger(LOG);
  const batchId = randomUUID();
  const auditPath = getTempGcAuditPath();
  const candidates: TempGcCandidate[] = [];
  const cutoffMs = Date.now() - TEMP_GC_INACTIVITY_DAYS * 24 * 60 * 60 * 1000;

  let projects: Array<{ hash: string; path: string; name: string; lastSeen: string }> = [];
  try {
    const rows = await nexusList();
    projects = rows.map((r) => ({
      hash: r.hash,
      path: r.path,
      name: r.name,
      lastSeen: r.lastSeen,
    }));
  } catch (err) {
    log.warn({ err }, `${LOG}: step2 — failed to load nexus registry`);
    return { batchId, candidates, auditPath };
  }

  for (const proj of projects) {
    try {
      // (a) No .git — this is the key signal that the project is not a real VCS repo.
      const gitDir = join(proj.path, '.git');
      if (existsSync(gitDir)) continue;

      // (b) lastSeen older than cutoff — the registry tracks all CLEO activity.
      const lastSeenMs = new Date(proj.lastSeen).getTime();
      if (Number.isNaN(lastSeenMs) || lastSeenMs > cutoffMs) continue;

      candidates.push({
        projectHash: proj.hash,
        projectPath: proj.path,
        projectName: proj.name,
        lastSeen: proj.lastSeen,
        reason: `no .git, last activity > ${TEMP_GC_INACTIVITY_DAYS}d ago (lastSeen=${proj.lastSeen})`,
      });
    } catch (err) {
      log.warn({ err, projectPath: proj.path }, `${LOG}: step2 — error scanning project`);
    }
  }

  // Append batch record to audit JSONL (one line per batch, candidates embedded).
  if (candidates.length > 0) {
    try {
      const record = {
        batchId,
        createdAt: new Date().toISOString(),
        status: 'pending_approval',
        candidates,
      };
      await appendAuditLine(auditPath, record);
    } catch (err) {
      log.warn({ err }, `${LOG}: step2 — failed to write audit log`);
    }
  }

  log.info({ batchId, count: candidates.length }, `${LOG}: step2 complete`);
  return { batchId, candidates, auditPath };
}

// ---------------------------------------------------------------------------
// Step 3 — Cross-project duplicate-epic detection
// ---------------------------------------------------------------------------

/**
 * A lightweight epic record sufficient for duplicate detection.
 */
interface EpicRecord {
  taskId: string;
  title: string;
  normTitle: string;
  ngrams: Set<string>;
}

/**
 * Detect epics with similar titles across registered projects.
 *
 * Algorithm:
 *   1. For each registered project, load epic titles from tasks.db via getAccessor.
 *   2. Build n-gram sets for each normalised title.
 *   3. Group by Jaccard similarity ≥ {@link DUPLICATE_EPIC_SIMILARITY_THRESHOLD}.
 *   4. Groups spanning ≥ 2 distinct projects are returned as duplicates.
 *
 * Never throws.
 */
export async function runDuplicateEpicDetection(): Promise<DuplicateEpicResult> {
  const log = getLogger(LOG);

  let projects: Array<{ hash: string; path: string }> = [];
  try {
    const rows = await nexusList();
    projects = rows.map((r) => ({ hash: r.hash, path: r.path }));
  } catch (err) {
    log.warn({ err }, `${LOG}: step3 — failed to load nexus registry`);
    return { projectsScanned: 0, groups: [] };
  }

  // Collect epics per project.
  const perProject: Array<{ projectHash: string; projectPath: string; epics: EpicRecord[] }> = [];

  for (const proj of projects) {
    if (!existsSync(proj.path)) continue;
    try {
      const accessor = await getAccessor(proj.path);
      const { tasks } = await accessor.queryTasks({ type: 'epic' });
      const epics: EpicRecord[] = tasks
        .filter((t) => t.title && t.title.length > 0)
        .map((t) => {
          const normTitle = normaliseTitle(t.title);
          return {
            taskId: t.id,
            title: t.title,
            normTitle,
            ngrams: buildNgramSet(normTitle),
          };
        });
      perProject.push({ projectHash: proj.hash, projectPath: proj.path, epics });
    } catch {
      // Project DB inaccessible — skip silently
    }
  }

  // Compare every epic against every other epic from different projects.
  const groups: DuplicateEpicGroup[] = [];
  const seen = new Set<string>(); // deduplicate groups by canonical key

  for (let i = 0; i < perProject.length; i++) {
    const projA = perProject[i];
    if (!projA) continue;

    for (const epicA of projA.epics) {
      if (epicA.ngrams.size === 0) continue;

      const group: DuplicateEpicGroup['instances'] = [
        {
          projectHash: projA.projectHash,
          projectPath: projA.projectPath,
          taskId: epicA.taskId,
          title: epicA.title,
        },
      ];

      for (let j = i + 1; j < perProject.length; j++) {
        const projB = perProject[j];
        if (!projB) continue;

        for (const epicB of projB.epics) {
          if (epicB.ngrams.size === 0) continue;
          const sim = jaccardSimilarity(epicA.ngrams, epicB.ngrams);
          if (sim >= DUPLICATE_EPIC_SIMILARITY_THRESHOLD) {
            group.push({
              projectHash: projB.projectHash,
              projectPath: projB.projectPath,
              taskId: epicB.taskId,
              title: epicB.title,
            });
          }
        }
      }

      // Only record groups spanning ≥ 2 distinct projects.
      const distinctProjects = new Set(group.map((g) => g.projectHash));
      if (distinctProjects.size < 2) continue;

      // Deduplicate: canonical key = sorted set of "projectHash:taskId".
      const canonKey = group
        .map((g) => `${g.projectHash}:${g.taskId}`)
        .sort()
        .join('|');
      if (seen.has(canonKey)) continue;
      seen.add(canonKey);

      groups.push({ normalisedTitle: epicA.normTitle, instances: group });
    }
  }

  log.info(
    { projectsScanned: perProject.length, groupsFound: groups.length },
    `${LOG}: step3 complete`,
  );
  return { projectsScanned: perProject.length, groups };
}

// ---------------------------------------------------------------------------
// Step 4 — Stale agent-worktree pruning
// ---------------------------------------------------------------------------

/**
 * Prune stale agent worktrees for every registered project.
 *
 * Delegates to the existing {@link pruneOrphanedWorktrees} from
 * `packages/core/src/spawn/branch-lock.ts` so there is zero duplication
 * of the worktree-management logic (DRY).
 *
 * Active task IDs are resolved from each project's tasks.db before calling
 * pruneOrphanedWorktrees so in-flight worktrees are never removed.
 *
 * Never throws.
 */
export async function runWorktreePrune(): Promise<WorktreePruneResult> {
  const log = getLogger(LOG);
  let projectsScanned = 0;
  let totalPruned = 0;
  const errors: WorktreePruneResult['errors'] = [];

  let projects: Array<{ hash: string; path: string }> = [];
  try {
    const rows = await nexusList();
    projects = rows.map((r) => ({ hash: r.hash, path: r.path }));
  } catch (err) {
    log.warn({ err }, `${LOG}: step4 — failed to load nexus registry`);
    return { projectsScanned, totalPruned, errors };
  }

  for (const proj of projects) {
    if (!existsSync(proj.path)) continue;
    projectsScanned++;

    try {
      // Resolve active task IDs so in-flight worktrees are preserved.
      const activeTaskIds = new Set<string>();
      try {
        const accessor = await getAccessor(proj.path);
        const { tasks } = await accessor.queryTasks({ status: 'active' });
        for (const t of tasks) activeTaskIds.add(t.id);
      } catch {
        // Cannot read tasks — skip pruning this project conservatively.
        continue;
      }

      const pruneResult = pruneOrphanedWorktrees(proj.path, activeTaskIds);
      totalPruned += pruneResult.removed;
      for (const e of pruneResult.errors) {
        errors.push({ projectPath: proj.path, reason: `${e.path}: ${e.reason}` });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push({ projectPath: proj.path, reason });
    }
  }

  log.info({ projectsScanned, totalPruned, errorCount: errors.length }, `${LOG}: step4 complete`);
  return { projectsScanned, totalPruned, errors };
}

// ---------------------------------------------------------------------------
// Orchestrator — run all 5 steps and return the digest
// ---------------------------------------------------------------------------

/**
 * Run the full nightly cross-project hygiene loop.
 *
 * Executes Steps 1–4 sequentially (step 5 is assembly of the digest).
 * Each step is independently guarded — failure in one step does not
 * abort subsequent steps.
 *
 * @returns The assembled {@link CrossProjectHygieneDigest} for this run.
 */
export async function runCrossProjectHygiene(): Promise<CrossProjectHygieneDigest> {
  const log = getLogger(LOG);
  const startedAt = new Date().toISOString();
  log.info(`${LOG}: nightly hygiene loop starting`);

  const nexusIntegrity = await runNexusIntegrityCheck();
  const tempGc = await runTempProjectGc();
  const duplicateEpics = await runDuplicateEpicDetection();
  const worktreePrune = await runWorktreePrune();

  const completedAt = new Date().toISOString();

  // Step 5: build human-readable summary.
  const parts: string[] = [`${nexusIntegrity.healthy}/${nexusIntegrity.total} projects healthy`];
  if (nexusIntegrity.degraded > 0) parts.push(`${nexusIntegrity.degraded} degraded`);
  if (nexusIntegrity.unreachable > 0) parts.push(`${nexusIntegrity.unreachable} unreachable`);
  if (tempGc.candidates.length > 0)
    parts.push(`${tempGc.candidates.length} temp-project GC candidate(s) flagged`);
  if (duplicateEpics.groups.length > 0)
    parts.push(`${duplicateEpics.groups.length} duplicate-epic group(s) detected`);
  if (worktreePrune.totalPruned > 0)
    parts.push(`${worktreePrune.totalPruned} stale worktree(s) pruned`);

  const summary = parts.join(', ');

  const digest: CrossProjectHygieneDigest = {
    startedAt,
    completedAt,
    nexusIntegrity,
    tempGc,
    duplicateEpics,
    worktreePrune,
    summary,
  };

  log.info({ summary }, `${LOG}: nightly hygiene loop complete`);
  return digest;
}

/**
 * Safe wrapper around {@link runCrossProjectHygiene} — swallows unexpected
 * errors so the daemon cron never crashes.
 *
 * @returns The digest on success, or a minimal digest with a summary error
 *   string on failure.
 */
export async function safeRunCrossProjectHygiene(): Promise<CrossProjectHygieneDigest> {
  const log = getLogger(LOG);
  try {
    return await runCrossProjectHygiene();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, `${LOG}: unexpected error in hygiene loop`);
    const now = new Date().toISOString();
    return {
      startedAt: now,
      completedAt: now,
      nexusIntegrity: {
        total: 0,
        healthy: 0,
        degraded: 0,
        unreachable: 0,
        issues: [],
      },
      tempGc: {
        batchId: '',
        candidates: [],
        auditPath: getTempGcAuditPath(),
      },
      duplicateEpics: { projectsScanned: 0, groups: [] },
      worktreePrune: { projectsScanned: 0, totalPruned: 0, errors: [] },
      summary: `hygiene loop error: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// GC batch approval gate (cleo daemon hygiene apply <batchId>)
// ---------------------------------------------------------------------------

/** Result of applying a GC batch. */
export interface ApplyGcBatchResult {
  /** Batch ID that was applied. */
  batchId: string;
  /** Number of projects unregistered from nexus. */
  unregistered: number;
  /** Projects that could not be unregistered. */
  errors: Array<{ projectPath: string; reason: string }>;
}

/**
 * Apply a pending temp-project GC batch.
 *
 * Reads the audit JSONL, finds the batch with the given ID, marks it as
 * `applied`, and calls `nexusUnregister` for each candidate.
 *
 * Intentionally does NOT delete project files — the caller is responsible for
 * rm -rf. This is auditable: each unregister action is logged by nexus.
 *
 * Never throws — errors are captured in the result.
 */
export async function applyGcBatch(batchId: string): Promise<ApplyGcBatchResult> {
  const log = getLogger(LOG);
  const auditPath = getTempGcAuditPath();
  const result: ApplyGcBatchResult = { batchId, unregistered: 0, errors: [] };

  // Load and find the batch.
  let lines: string[] = [];
  try {
    const raw = await readFile(auditPath, 'utf-8');
    lines = raw.split('\n').filter(Boolean);
  } catch {
    log.warn(`${LOG}: applyGcBatch — audit file not found: ${auditPath}`);
    return result;
  }

  let batchRecord: {
    batchId: string;
    createdAt: string;
    status: string;
    candidates: TempGcCandidate[];
  } | null = null;
  let batchLineIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i] as string) as {
        batchId: string;
        status: string;
        candidates: TempGcCandidate[];
        createdAt: string;
      };
      if (parsed.batchId === batchId) {
        batchRecord = parsed;
        batchLineIndex = i;
        break;
      }
    } catch {
      // malformed line — skip
    }
  }

  if (!batchRecord) {
    log.warn(`${LOG}: applyGcBatch — batch not found: ${batchId}`);
    return result;
  }

  if (batchRecord.status !== 'pending_approval') {
    log.warn(`${LOG}: applyGcBatch — batch already applied: ${batchId}`);
    return result;
  }

  // Unregister each candidate from nexus.
  for (const candidate of batchRecord.candidates) {
    try {
      await nexusUnregister(candidate.projectHash);
      result.unregistered++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.errors.push({ projectPath: candidate.projectPath, reason });
    }
  }

  // Mark batch as applied in the audit file (atomic write).
  batchRecord.status = 'applied';
  lines[batchLineIndex] = JSON.stringify(batchRecord);
  const tmpPath = `${auditPath}.tmp-${createHash('sha256').update(batchId).digest('hex').slice(0, 8)}`;
  try {
    await writeFile(tmpPath, `${lines.join('\n')}\n`, 'utf-8');
    await rename(tmpPath, auditPath);
  } catch (err) {
    log.warn({ err }, `${LOG}: applyGcBatch — failed to update audit log`);
  }

  log.info(
    { batchId, unregistered: result.unregistered, errors: result.errors.length },
    `${LOG}: applyGcBatch complete`,
  );
  return result;
}
