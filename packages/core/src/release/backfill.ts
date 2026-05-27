/**
 * `cleo provenance backfill --since <version>` — Phase 2 of T9493 (T9528).
 *
 * Walks historical git tags from a starting version forward and populates the
 * 11 provenance tables (commits, task_commits, commit_files, pull_requests,
 * pr_commits, pr_tasks, releases, release_commits, release_changes,
 * release_artifacts, brain_release_links) for every release in the range.
 *
 * Design:
 *
 *   - Enumerates tags via `git tag --list --sort=creatordate` (handles both
 *     annotated and lightweight tags — `committerdate` silently drops
 *     annotated tags because they have no committerdate of their own).
 *   - For each tag, synthesises a minimal release plan (T#### tokens extracted
 *     from `git log`, tasks resolved against `tasks.db`) when no plan file
 *     already exists, then invokes {@link releaseReconcileV2} with the
 *     `backfill: true` flag (skips the ADR-051 staleness gate per T9528 design).
 *   - Restartable via `.cleo/release/backfill-state.json` checkpoint — every
 *     successfully-reconciled tag is appended to `completedTags[]` before the
 *     next iteration starts. On Ctrl-C the next invocation resumes from where
 *     the previous one left off.
 *   - Idempotent: re-running over already-reconciled tags is a no-op because
 *     reconcile's `releases.status='reconciled'` short-circuit applies.
 *   - `--force-overwrite` clears the checkpoint AND signals downstream
 *     reconcile to UPDATE existing rows (current SQL is UPSERT, so the effect
 *     is informational + audit-logged).
 *   - `--dry-run` enumerates the tag set and returns it without writing to DB
 *     or disk.
 *
 * @task T9528
 * @epic T9493
 * @adr  ADR-T9345 (IVTR-release-overhaul)
 * @spec .cleo/rcasd/T9345/research/SPEC-T9345-release-pipeline-v2.md §8.3
 * @spec .cleo/rcasd/T9345/research/provenance-graph-design.md §4.4
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getLogger } from '../logger.js';
import { getProjectRoot } from '../paths.js';
import { getDb } from '../store/sqlite.js';
import * as schema from '../store/tasks-schema.js';
import { releaseReconcileV2 } from './reconcile.js';

const log = getLogger('release:backfill');

/** Default subprocess timeout for git/gh calls (60s per task rules). */
const SUBPROCESS_TIMEOUT_MS = 60_000;

/** Plan-file dir relative to project root. */
const PLAN_DIR_REL = '.cleo/release';

/** Checkpoint file relative to project root. */
const CHECKPOINT_REL = '.cleo/release/backfill-state.json';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Options for {@link provenanceBackfill}.
 *
 * `since` is the lower-bound version (exclusive — matches `git log A..B`
 * range semantics). Tags whose committer date is strictly greater than
 * `since` are enumerated forward to HEAD.
 */
export interface BackfillOptions {
  /** Starting version (exclusive). Empty string = walk every reachable tag. */
  since: string;
  /** Project root override (defaults to CLEO_ROOT or cwd). */
  projectRoot?: string;
  /** When true, signals downstream reconcile to UPDATE existing rows. */
  forceOverwrite?: boolean;
  /** When true, enumerates tags and returns the plan without DB writes. */
  dryRun?: boolean;
  /** When true, clears any existing checkpoint before starting. */
  resetCheckpoint?: boolean;
}

/**
 * Per-tag outcome — captured in the {@link BackfillResult.results} array so
 * callers can surface per-tag success / failure detail without re-loading the
 * checkpoint file.
 */
export interface BackfillTagResult {
  tag: string;
  status: 'reconciled' | 'skipped' | 'failed';
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
}

/** Result envelope for {@link provenanceBackfill}. */
export interface BackfillResult {
  /** Lower-bound version that was passed in via `--since`. */
  since: string;
  /** All historical tags discovered in the `since..HEAD` range. */
  totalTags: string[];
  /** Tags successfully reconciled (one row per tag). */
  completedTags: string[];
  /** Tags that failed reconcile (re-runnable). */
  failedTags: { tag: string; errorCode: string; errorMessage: string }[];
  /** Per-tag detailed results. */
  results: BackfillTagResult[];
  /** True when `--dry-run` skipped DB writes. */
  dryRun?: boolean;
  /** Path to the checkpoint file (relative or absolute). Null when dry-run. */
  checkpointPath: string | null;
  /** Total wall-clock duration in ms. */
  durationMs?: number;
}

// ─── Internal — checkpoint state ─────────────────────────────────────────────

/**
 * On-disk shape of `.cleo/release/backfill-state.json`. Holds enough state
 * for a fresh process to resume mid-walk after Ctrl-C / crash.
 */
interface CheckpointState {
  /** Lower-bound version passed via `--since` for the original invocation. */
  since: string;
  /** Tag list captured up-front (so resume sees the same plan). */
  totalTags: string[];
  /** Tags successfully reconciled so far. */
  completedTags: string[];
  /** Tags that failed (re-runnable). */
  failedTags: { tag: string; errorCode: string; errorMessage: string }[];
  /** Last tag attempted (success or failure). Null before first iteration. */
  lastProcessedTag: string | null;
  /** ISO-8601 timestamp the original walk started. */
  startedAt: string;
  /** ISO-8601 timestamp of the most recent checkpoint save. */
  lastSavedAt: string;
  /** Forced-overwrite flag carried through across resume. */
  forceOverwrite: boolean;
}

// ─── Subprocess wrappers ────────────────────────────────────────────────────

/**
 * Run `git <args>` synchronously with the standard 60s timeout. Returns the
 * trimmed stdout string. Throws on non-zero exit — callers MUST wrap with
 * their own try/catch when they expect failure.
 */
function runGit(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SUBPROCESS_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

// ─── Internal — tag enumeration ──────────────────────────────────────────────

/**
 * Enumerate all git tags newer than `since` in creator-date order
 * (oldest-first). When `since` is the empty string the full tag list is
 * returned.
 *
 * Implementation: `git tag --list --sort=creatordate` — `creatordate`
 * returns the tagger date for annotated tags and the committer date for
 * lightweight tags, so the same sort order applies uniformly. Using
 * `committerdate` silently drops every annotated tag from the result
 * because annotated tags have no committerdate of their own (the empty
 * string sorts ahead of every real timestamp).
 */
export function enumerateHistoricalTags(since: string, projectRoot: string): string[] {
  // List ALL tags ordered by creatordate ascending. `creatordate` handles
  // BOTH annotated and lightweight tags — see the C1 bug fix in the
  // file's task header.
  const raw = runGit(['tag', '--list', '--sort=creatordate'], projectRoot);
  const tags = raw
    .split('\n')
    .map((t: string) => t.trim())
    .filter((t: string) => t.length > 0);

  if (!since) return tags;

  // Find the index of `since`; everything strictly after is in-scope.
  const idx = tags.indexOf(since);
  if (idx < 0) {
    // `since` not found — treat as "tag does not exist yet" and walk all.
    return tags;
  }
  return tags.slice(idx + 1);
}

// ─── Internal — checkpoint I/O ──────────────────────────────────────────────

/**
 * Load the checkpoint state from disk, or null when the file does not exist.
 * Returns null (not throws) on parse errors so the caller can fall back to a
 * fresh walk; the corrupt file is logged at warn level.
 */
export function loadCheckpoint(projectRoot: string): CheckpointState | null {
  const path = join(projectRoot, CHECKPOINT_REL);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as CheckpointState;
    // Basic shape validation — reject anything missing the load-bearing keys.
    if (
      typeof parsed.since !== 'string' ||
      !Array.isArray(parsed.totalTags) ||
      !Array.isArray(parsed.completedTags) ||
      !Array.isArray(parsed.failedTags)
    ) {
      log.warn({ path }, 'backfill checkpoint missing required keys — ignoring');
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn(
      { path, err: err instanceof Error ? err.message : String(err) },
      'backfill checkpoint unreadable — ignoring',
    );
    return null;
  }
}

/**
 * Atomically write the checkpoint state to disk via tmp-then-rename. The
 * directory is created on demand.
 */
export function saveCheckpoint(state: CheckpointState, projectRoot: string): void {
  const path = join(projectRoot, CHECKPOINT_REL);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

/** Remove the checkpoint file on successful completion. Idempotent. */
export function clearCheckpoint(projectRoot: string): void {
  const path = join(projectRoot, CHECKPOINT_REL);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch (err) {
    log.warn(
      { path, err: err instanceof Error ? err.message : String(err) },
      'failed to clear backfill checkpoint — non-fatal',
    );
  }
}

// ─── Internal — synthetic plan generation ───────────────────────────────────

/** T#### regex used to extract task tokens from commit subjects. */
const TASK_TOKEN_RE = /\bT\d{1,5}\b/g;

/** Detect conventional-commits prefix in a subject. */
const CC_RE =
  /^(feat|fix|chore|docs|refactor|test|perf|build|ci|revert|breaking|style)(?:\(([^)]+)\))?!?:\s/i;

/**
 * Parse the conventional-commits type from a subject. Returns the normalised
 * lowercase string or `null` when the subject is not CC-formatted.
 */
function parseConventionalType(subject: string): string | null {
  const m = subject.match(CC_RE);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/**
 * Map a conventional-commit type to a {@link ReleasePlan} `task.kind` literal.
 * Defaults to 'chore' for unrecognised inputs to keep historical plans
 * parseable.
 */
function ccTypeToTaskKind(ccType: string | null): SyntheticTaskKind {
  switch (ccType) {
    case 'feat':
      return 'feat';
    case 'fix':
      return 'fix';
    case 'docs':
      return 'docs';
    case 'refactor':
      return 'refactor';
    case 'test':
      return 'test';
    case 'perf':
      return 'perf';
    case 'revert':
      return 'revert';
    case 'breaking':
      return 'breaking';
    default:
      return 'chore';
  }
}

type SyntheticTaskKind =
  | 'feat'
  | 'fix'
  | 'chore'
  | 'docs'
  | 'refactor'
  | 'test'
  | 'perf'
  | 'revert'
  | 'breaking'
  | 'hotfix';

/**
 * Synthesise a minimal release plan for a historical tag and write it to
 * `.cleo/release/<tag>.plan.json` so {@link releaseReconcileV2} can consume
 * it. The plan is bare-bones — non-empty `tasks[]` derived from T#### tokens
 * in the `prevTag..tag` git log, intersected with valid task IDs in tasks.db.
 *
 * Returns the absolute path to the plan file written (or already on disk).
 * When `prevTag` is null, walks from the beginning of history.
 */
export async function synthesizePlanFromTag(
  tag: string,
  prevTag: string | null,
  projectRoot: string,
): Promise<string> {
  const planPath = join(projectRoot, PLAN_DIR_REL, `${tag}.plan.json`);
  if (existsSync(planPath)) {
    // Already present — caller / reconcile will reuse.
    return planPath;
  }

  // Walk the commit range. We only need subjects + bodies for T#### extraction.
  const range = prevTag ? `${prevTag}..${tag}` : tag;
  let logOut = '';
  try {
    logOut = runGit(['log', '--pretty=format:%s%n%b%n---', range], projectRoot);
  } catch (err) {
    log.warn(
      { tag, prevTag, err: err instanceof Error ? err.message : String(err) },
      'synthesizePlanFromTag: git log failed — using empty task set',
    );
  }

  // Extract unique T#### tokens preserving first-appearance order.
  const tokens = new Set<string>();
  let m: RegExpExecArray | null = TASK_TOKEN_RE.exec(logOut);
  while (m !== null) {
    tokens.add(m[0]);
    m = TASK_TOKEN_RE.exec(logOut);
  }

  // Intersect with valid tasks.id to avoid synthesizing fake task rows.
  const db = await getDb(projectRoot);
  const validIds = new Set<string>();
  if (tokens.size > 0) {
    const rows = await db.select({ id: schema.tasks.id }).from(schema.tasks).all();
    for (const r of rows) {
      if (typeof r.id === 'string' && tokens.has(r.id)) {
        validIds.add(r.id);
      }
    }
  }

  // Pick the FIRST commit's CC type as the "release-wide" kind heuristic.
  const firstSubjectMatch = logOut.split('\n').find((line: string) => line.trim().length > 0);
  const seedKind = ccTypeToTaskKind(parseConventionalType(firstSubjectMatch ?? ''));

  // Determine an `epicId`: prefer the first token if present, else a synthetic
  // sentinel value that's still a non-empty string for the contract.
  const epicId =
    validIds.size > 0 ? Array.from(validIds)[0] : `BACKFILL-${tag.replace(/[^A-Z0-9]/gi, '')}`;

  // Build task entries — one row per valid token. When no tokens resolve, fall
  // back to a synthetic placeholder task so `releaseChanges` still receives at
  // least one row per release (matches reconcile expectations).
  const taskEntries =
    validIds.size > 0
      ? Array.from(validIds).map((id) => ({
          id,
          kind: seedKind,
          impact: 'patch' as const,
          userFacingSummary: `${id} — backfilled from ${tag}`,
          evidenceAtoms: [`note:backfilled-from-${tag}`],
          epicAncestor: epicId,
        }))
      : [
          {
            id: `BACKFILL-${tag.replace(/[^A-Z0-9]/gi, '')}-PLACEHOLDER`,
            kind: 'chore' as const,
            impact: 'patch' as const,
            userFacingSummary: `Historical release ${tag} (no task tokens found)`,
            evidenceAtoms: [`note:backfilled-from-${tag}`],
            epicAncestor: epicId,
          },
        ];

  // Bucket task IDs into the changelog sections per kind.
  const changelog: {
    features: string[];
    fixes: string[];
    chores: string[];
    breaking: string[];
  } = { features: [], fixes: [], chores: [], breaking: [] };
  for (const t of taskEntries) {
    if (t.kind === 'feat') changelog.features.push(t.id);
    else if (t.kind === 'fix' || t.kind === 'hotfix') changelog.fixes.push(t.id);
    else if (t.kind === 'breaking' || t.kind === 'revert') changelog.breaking.push(t.id);
    else changelog.chores.push(t.id);
  }

  const nowIso = new Date().toISOString();
  const plan = {
    $schema: 'https://cleocode.io/schemas/release-plan/v1.json',
    version: tag,
    resolvedVersion: tag,
    suffixApplied: false,
    scheme: 'calver' as const,
    channel: 'latest' as const,
    epicId,
    releaseKind: 'regular' as const,
    createdAt: nowIso,
    createdBy: 'provenance-backfill',
    previousVersion: prevTag,
    previousTag: prevTag,
    previousShippedAt: null as string | null,
    tasks: taskEntries,
    changelog,
    gates: [] as never[],
    platformMatrix: [
      {
        platform: 'any' as const,
        publisher: 'npm' as const,
        package: '@cleocode/cleo',
        smoke: false,
      },
    ],
    preflightSummary: {
      esbuildExternalsDrift: false,
      lockfileDrift: false,
      epicCompletenessClean: true,
      doubleListingClean: true,
      preflightWarnings: ['synthesized-by-backfill'],
    },
    workflowRunUrl: null as string | null,
    prUrl: null as string | null,
    mergeCommitSha: null as string | null,
    status: 'published' as const,
    meta: {
      firstEverRelease: prevTag === null,
      backfilled: true,
      backfilledAt: nowIso,
    },
  };

  mkdirSync(dirname(planPath), { recursive: true });
  // Atomic tmp-then-rename so a concurrent reader never sees a partial file.
  const tmp = `${planPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(plan, null, 2));
  renameSync(tmp, planPath);
  return planPath;
}

// ─── Internal — audit log emission ──────────────────────────────────────────

/**
 * Append a per-tag audit-log row to tasks.db for forensic traceability. Uses
 * a synthetic task ID (`BACKFILL-<tag>`) when the synthesised plan had no
 * resolvable T#### token (audit-log requires task_id non-null).
 *
 * Best-effort — errors are logged but do not fail the verb.
 */
async function appendBackfillAudit(
  tag: string,
  status: 'reconciled' | 'skipped' | 'failed',
  details: Record<string, unknown>,
  projectRoot: string,
): Promise<void> {
  try {
    const db = await getDb(projectRoot);
    const id = `backfill-${tag}-${Date.now()}`;
    const taskId = `BACKFILL-${tag}`;
    await db.run(
      sql`INSERT INTO audit_log (id, action, task_id, actor, details_json, domain, operation, success)
          VALUES (${id}, ${`provenance.backfill.${status}`}, ${taskId}, ${'provenance-backfill'},
                  ${JSON.stringify(details)}, ${'provenance'}, ${'backfill'},
                  ${status === 'failed' ? 0 : 1})`,
    );
  } catch (err) {
    log.warn(
      { tag, err: err instanceof Error ? err.message : String(err) },
      'backfill audit-log append failed — non-fatal',
    );
  }
}

// ─── Main entrypoint ────────────────────────────────────────────────────────

/**
 * Walk historical git tags from `opts.since` forward and populate the 11
 * provenance tables for every release in the range.
 *
 * On success returns `engineSuccess(BackfillResult)`. On structural failure
 * (e.g. git repo missing) returns `engineError(<code>, ...)`. Per-tag
 * reconcile failures are aggregated into `BackfillResult.failedTags` — the
 * verb itself still returns success when at least one tag completed.
 *
 * @param opts — see {@link BackfillOptions}.
 * @returns EngineResult envelope.
 */
export async function provenanceBackfill(
  opts: BackfillOptions,
): Promise<EngineResult<BackfillResult>> {
  const startedAt = Date.now();
  const projectRoot = getProjectRoot(opts.projectRoot);
  const since = opts.since;
  const dryRun = opts.dryRun === true;
  const forceOverwrite = opts.forceOverwrite === true;

  // 0. Optional checkpoint reset.
  if (opts.resetCheckpoint) {
    clearCheckpoint(projectRoot);
  }

  // 1. Resume from checkpoint when present.
  let checkpoint = loadCheckpoint(projectRoot);

  let totalTags: string[];
  if (checkpoint && checkpoint.since === since) {
    totalTags = checkpoint.totalTags;
    log.info(
      {
        since,
        completedSoFar: checkpoint.completedTags.length,
        total: totalTags.length,
      },
      'resuming backfill from checkpoint',
    );
  } else {
    // Fresh walk — enumerate tags now.
    try {
      totalTags = enumerateHistoricalTags(since, projectRoot);
    } catch (err) {
      return engineError(
        'E_GIT_TAG_ENUM_FAILED',
        `Failed to enumerate historical tags: ${err instanceof Error ? err.message : String(err)}`,
        { details: { since } },
      );
    }
    checkpoint = {
      since,
      totalTags,
      completedTags: [],
      failedTags: [],
      lastProcessedTag: null,
      startedAt: new Date().toISOString(),
      lastSavedAt: new Date().toISOString(),
      forceOverwrite,
    };
  }

  // 2. Dry-run short-circuit.
  if (dryRun) {
    const result: BackfillResult = {
      since,
      totalTags,
      completedTags: [],
      failedTags: [],
      results: totalTags.map((t) => ({ tag: t, status: 'skipped' as const })),
      dryRun: true,
      checkpointPath: null,
      durationMs: Date.now() - startedAt,
    };
    return engineSuccess(result);
  }

  // 3. Persist initial checkpoint before any reconcile so resume sees the
  //    same tag plan even if the very first reconcile fails partway.
  saveCheckpoint(checkpoint, projectRoot);

  const completedSet = new Set(checkpoint.completedTags);
  const failedSet = new Map(checkpoint.failedTags.map((f) => [f.tag, f]));
  const results: BackfillTagResult[] = [];

  // Pre-load completed/failed results into output so re-runs surface them too.
  for (const t of checkpoint.completedTags) {
    results.push({ tag: t, status: 'reconciled' });
  }
  for (const f of checkpoint.failedTags) {
    results.push({
      tag: f.tag,
      status: 'failed',
      errorCode: f.errorCode,
      errorMessage: f.errorMessage,
    });
  }

  // 4. Iterate tags. For each, synth-plan + reconcile + checkpoint.
  for (let i = 0; i < totalTags.length; i++) {
    const tag = totalTags[i];
    if (!tag) continue;
    if (completedSet.has(tag)) continue;

    const prevTag = i === 0 ? since || null : (totalTags[i - 1] ?? null);
    const tagStarted = Date.now();

    // Synthesise plan if missing — reconcile loads from disk so we must
    // write SOMETHING under .cleo/release/<tag>.plan.json.
    let planPath: string;
    try {
      planPath = await synthesizePlanFromTag(tag, prevTag, projectRoot);
    } catch (err) {
      const errorCode = 'E_PLAN_SYNTH_FAILED';
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error({ tag, err: errorMessage }, 'synthesizePlanFromTag failed');
      failedSet.set(tag, { tag, errorCode, errorMessage });
      results.push({ tag, status: 'failed', errorCode, errorMessage });
      await appendBackfillAudit(tag, 'failed', { errorCode, errorMessage }, projectRoot);
      // Update + persist checkpoint and continue.
      checkpoint.failedTags = Array.from(failedSet.values());
      checkpoint.lastProcessedTag = tag;
      checkpoint.lastSavedAt = new Date().toISOString();
      saveCheckpoint(checkpoint, projectRoot);
      continue;
    }

    // Reconcile this tag with backfill=true (skips staleness gate).
    const reconcileRes = await releaseReconcileV2(tag, {
      projectRoot,
      fromWorkflow: false,
      rollback: false,
      backfill: true,
      forceOverwrite,
    });

    const duration = Date.now() - tagStarted;

    if (reconcileRes.success) {
      completedSet.add(tag);
      results.push({ tag, status: 'reconciled', durationMs: duration });
      await appendBackfillAudit(
        tag,
        'reconciled',
        {
          version: tag,
          commitCount: reconcileRes.data.commitCount,
          taskCount: reconcileRes.data.taskCount,
          changeCount: reconcileRes.data.changeCount,
          planPath,
          forceOverwrite,
        },
        projectRoot,
      );
      log.info(
        {
          tag,
          progress: `${completedSet.size}/${totalTags.length}`,
          commitCount: reconcileRes.data.commitCount,
          taskCount: reconcileRes.data.taskCount,
        },
        'backfill: reconciled tag',
      );
    } else {
      const errorCode = reconcileRes.error.code;
      const errorMessage = reconcileRes.error.message;
      failedSet.set(tag, { tag, errorCode, errorMessage });
      results.push({ tag, status: 'failed', durationMs: duration, errorCode, errorMessage });
      await appendBackfillAudit(tag, 'failed', { errorCode, errorMessage }, projectRoot);
      log.warn({ tag, errorCode, errorMessage }, 'backfill: reconcile failed for tag');
    }

    // Persist checkpoint after EVERY iteration so Ctrl-C is recoverable.
    checkpoint.completedTags = Array.from(completedSet);
    checkpoint.failedTags = Array.from(failedSet.values());
    checkpoint.lastProcessedTag = tag;
    checkpoint.lastSavedAt = new Date().toISOString();
    saveCheckpoint(checkpoint, projectRoot);
  }

  // 5. Final result + cleanup. Only delete the checkpoint when EVERY tag
  //    succeeded — leaving it in place when failures remain lets the operator
  //    re-run to retry the failed ones.
  const checkpointPath = join(projectRoot, CHECKPOINT_REL);
  if (failedSet.size === 0) {
    clearCheckpoint(projectRoot);
  }

  const result: BackfillResult = {
    since,
    totalTags,
    completedTags: Array.from(completedSet),
    failedTags: Array.from(failedSet.values()),
    results,
    checkpointPath: failedSet.size === 0 ? null : checkpointPath,
    durationMs: Date.now() - startedAt,
  };

  return engineSuccess(result);
}
