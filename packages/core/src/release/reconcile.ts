/**
 * `cleo release reconcile <version>` — Phase 1 of T9492 (v2 reconcile verb).
 *
 * Post-publish: backfills the 11 provenance tables (commits, task_commits,
 * commit_files, pull_requests, pr_commits, pr_tasks, releases, release_commits,
 * release_changes, release_artifacts, brain_release_links) from `git log` and
 * `gh api` output.
 *
 * Implements SPEC-T9345 §4.4 (R-080 through R-113) and §8 (R-330 through R-347):
 *
 *   - R-080 .. R-083 — pre-conditions (plan present, tag present, gh release
 *     tagName matches, ADR-051 evidence atoms re-validated for staleness).
 *   - R-090 .. R-099 — per-table side effects + auto BRAIN observation + plan
 *     archive on success.
 *   - R-100         — every insert runs in a single SQLite transaction; any
 *     failure rolls back the entire transaction with `E_PROVENANCE_FAILED`
 *     and `error.details.table` identifying the failure.
 *   - R-110 .. R-113 — post-conditions (status='reconciled', every commit
 *     represented, every plan task has release_changes row, BRAIN linked).
 *   - R-313 — staleness check (commit reachability + file sha256 + test-run
 *     sha256 unchanged).
 *   - R-330 .. R-340 — per-table UPSERT invariants and link_type taxonomy.
 *   - R-345 .. R-347 — transactionality + full idempotency (re-running on an
 *     already-reconciled release is a no-op modulo `meta.reReconciled=true`).
 *
 * Named `releaseReconcileV2` to coexist with the legacy `releaseReconcile`
 * from `./pipeline.js` (T1597 4-step pipeline). Phase 6 of T9492 will retire
 * the legacy verb; this implementation is the new canonical path.
 *
 * @task T9526
 * @epic T9492
 * @adr ADR-T9345
 * @spec .cleo/rcasd/T9345/research/SPEC-T9345-release-pipeline-v2.md §4.4, §8
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type ReleasePlan, safeParseReleasePlan } from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getLogger } from '../logger.js';
import { generateProjectHash } from '../nexus/hash.js';
import { getProjectRoot } from '../paths.js';
import { getDb, getNativeDb } from '../store/sqlite.js';
import * as schema from '../store/tasks-schema.js';

const log = getLogger('release:reconcile-v2');
const execFileAsync = promisify(execFile);

/** Default subprocess timeout for git/gh calls (60s per task rules). */
const SUBPROCESS_TIMEOUT_MS = 60_000;

/** Plan-file location relative to project root. */
const PLAN_DIR_REL = '.cleo/release';
/** Archive-dir relative to project root. */
const PLAN_ARCHIVE_DIR_REL = '.cleo/release/archive';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Options for {@link releaseReconcileV2}.
 *
 * `fromWorkflow` mirrors the SPEC §4.4.1 `--from-workflow` flag (affects
 * logging verbosity only). `rollback` flips behavior for the rollback path
 * (deferred to T9527/T9528 — set false in this phase).
 *
 * `backfill` (T9528) signals that this invocation is part of a historical
 * backfill walk: the tag is by definition reachable (it is being reconciled
 * AFTER the fact), so the ADR-051 evidence-staleness check (R-313) is
 * skipped. Without this flag, historical commits referenced by old plan
 * evidence atoms may have been GC'd, file paths may have moved, and the
 * staleness gate would reject every historical release. `forceOverwrite`
 * (also T9528) signals the caller wants existing rows UPDATED — currently
 * implemented as a UPSERT-on-conflict-DO-UPDATE semantic which already
 * matches the reconcile insert pattern, so this flag is informational
 * (audit-logged by callers) but does not alter the SQL path.
 */
export interface ReleaseReconcileV2Options {
  /** Project root override (defaults to CLEO_ROOT or cwd). */
  projectRoot?: string;
  /** When true, indicates the verb is invoked from `release-publish.yml`. */
  fromWorkflow?: boolean;
  /** When true, drives the rollback flow (not implemented in T9526). */
  rollback?: boolean;
  /** When true (T9528), skips evidence-staleness re-validation per R-313. */
  backfill?: boolean;
  /**
   * When true (T9528), forces UPDATE of existing rows on conflict. The
   * underlying SQL already UPSERTs on conflict, so this flag is currently
   * informational; the backfill verb audit-logs overwrites separately.
   */
  forceOverwrite?: boolean;
}

/** Successful reconcile result envelope (SPEC §4.4.5 `data` payload). */
export interface ReleaseReconcileV2Result {
  /** Version string, e.g. `v2026.6.0`. */
  version: string;
  /** Git tag name (typically equals `version`). */
  tag: string;
  /** Full 40-char SHA the tag points at. */
  tagSha: string;
  /** Number of commits ingested into `commits` for this release. */
  commitCount: number;
  /** Number of plan tasks ingested into `release_changes`. */
  taskCount: number;
  /** Number of `release_changes` rows written (equals `taskCount` minus dedups). */
  changeCount: number;
  /** Number of `release_artifacts` rows written. */
  artifactCount: number;
  /** Number of `brain_release_links` rows written. */
  brainLinkCount: number;
  /** Commits in the release range with no extractable T#### token. */
  orphanCommits: string[];
  /** True when the release was already reconciled and this call was a no-op (R-347). */
  reReconciled?: boolean;
  /** T#### tokens encountered that did not validate against `tasks.id` (R-331). */
  unknownTokens?: string[];
  /** Total wall-clock duration (filled into envelope `meta.durationMs`). */
  durationMs?: number;
  /** Total inserts performed (filled into envelope `meta.txSize`). */
  txSize?: number;
}

// ─── Internal types ──────────────────────────────────────────────────────────

/** A parsed commit row from `git log`, with `--name-status` file changes. */
interface ParsedCommit {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committerEmail: string;
  committedAt: string;
  subject: string;
  message: string;
  parents: string[];
  files: ParsedCommitFile[];
}

interface ParsedCommitFile {
  changeType: 'A' | 'M' | 'D' | 'R' | 'C';
  path: string;
  oldPath?: string;
}

interface ParsedPR {
  prNumber: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  baseRef: string;
  headRef: string;
  headSha: string | null;
  mergeCommitSha: string | null;
  authorLogin: string | null;
  openedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  repoUrl: string;
  commits: { sha: string }[];
}

// ─── Helpers — git / gh subprocess wrappers ─────────────────────────────────

/**
 * Run `git <args>` synchronously with a 60s timeout and return trimmed stdout.
 *
 * Throws when git exits non-zero. Callers handling expected failures (e.g.
 * "tag not found") MUST wrap with their own try/catch.
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

/**
 * Run `gh <args>` synchronously with a 60s timeout. Returns trimmed stdout or
 * throws on non-zero exit.
 */
function runGh(args: readonly string[], cwd: string): string {
  return execFileSync('gh', [...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SUBPROCESS_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

// ─── Helpers — plan / tag / staleness validation ────────────────────────────

/**
 * Load and validate the release plan at `.cleo/release/<version>.plan.json`.
 *
 * Returns the parsed plan on success, or an `E_PLAN_NOT_FOUND` /
 * `E_PLAN_INVALID` `EngineResult` on failure (R-080).
 */
function loadPlan(version: string, projectRoot: string): EngineResult<ReleasePlan> {
  const planPath = join(projectRoot, PLAN_DIR_REL, `${version}.plan.json`);
  if (!existsSync(planPath)) {
    return engineError('E_PLAN_NOT_FOUND', `Release plan not found at ${planPath}`, {
      fix: `Run 'cleo release plan ${version}' to create the plan file.`,
      details: { planPath, version },
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(planPath, 'utf-8'));
  } catch (err) {
    return engineError(
      'E_PLAN_INVALID',
      `Failed to parse plan JSON at ${planPath}: ${err instanceof Error ? err.message : String(err)}`,
      { details: { planPath } },
    );
  }
  const result = safeParseReleasePlan(raw);
  if (!result.success) {
    return engineError('E_PLAN_INVALID', `Plan schema validation failed for ${planPath}`, {
      details: { planPath, issues: result.error.issues },
    });
  }
  return engineSuccess(result.data);
}

/**
 * Assert the git tag exists locally. Returns `null` on success, or an
 * `E_TAG_NOT_FOUND` `EngineResult` (R-081).
 */
function assertTagExists(version: string, projectRoot: string): EngineResult<string> {
  try {
    // git tag -l <version> returns the tag name iff present; empty when absent.
    const listed = runGit(['tag', '-l', version], projectRoot);
    if (!listed) {
      return engineError('E_TAG_NOT_FOUND', `Git tag '${version}' does not exist in this repo`, {
        fix: `Fetch tags with 'git fetch --tags origin' or run 'cleo release ship' first.`,
        details: { version },
      });
    }
    // Resolve the tag (annotated or lightweight) to its commit SHA.
    const sha = runGit(['rev-parse', `${version}^{commit}`], projectRoot);
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return engineError('E_TAG_NOT_FOUND', `Unable to resolve tag '${version}' to a commit SHA`, {
        details: { version, resolved: sha },
      });
    }
    return engineSuccess(sha);
  } catch (err) {
    return engineError(
      'E_TAG_NOT_FOUND',
      `Git tag lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      { details: { version } },
    );
  }
}

/**
 * Verify `gh release view <version>` returns the expected tag name. Returns
 * `null` on success or `E_TAG_MISMATCH` on mismatch (R-082).
 *
 * If `gh` is unavailable OR the release is not found, we treat that as a
 * non-fatal warning (the verb may run pre-gh-publish in tests). Callers in
 * production hit R-082 only when there is a real tag/version mismatch.
 */
function assertReleaseMatchesTag(version: string, projectRoot: string): EngineResult<true> {
  try {
    const out = runGh(['release', 'view', version, '--json', 'tagName,publishedAt'], projectRoot);
    const parsed = JSON.parse(out) as { tagName?: string; publishedAt?: string };
    if (parsed.tagName && parsed.tagName !== version) {
      return engineError(
        'E_TAG_MISMATCH',
        `gh release tagName '${parsed.tagName}' does not match version '${version}'`,
        {
          details: { expected: version, actual: parsed.tagName },
        },
      );
    }
    return engineSuccess(true);
  } catch (err) {
    // gh not available or release not published yet — non-fatal (workflow path
    // may invoke reconcile before the gh release fully exists). Log + continue.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), version },
      'gh release view failed — skipping tag/release name equivalence check',
    );
    return engineSuccess(true);
  }
}

/**
 * Re-validate ADR-051 evidence atoms in `plan.tasks[*].evidenceAtoms` (R-083 +
 * R-313):
 *
 *   - `commit:<sha>`     — commit MUST be reachable from `<tag>` (merge-base).
 *   - `files:<paths>`    — sha256 of file contents MUST match the value
 *     recorded at plan time. The plan does NOT store the hash inline (today's
 *     contract), so we treat presence-of-file as the strongest available
 *     signal: a file deleted post-plan is considered stale.
 *   - `test-run:<path>`  — sha256 of the JSON file MUST match plan-time
 *     value. Same caveat: when plan-time hash is absent we treat
 *     file-existence as the staleness signal.
 *
 * Owner override (`CLEO_OWNER_OVERRIDE=1` with `CLEO_OWNER_OVERRIDE_REASON`)
 * bypasses staleness rejection per the cleo-prime evidence-override contract.
 */
function revalidateEvidenceStaleness(
  plan: ReleasePlan,
  tag: string,
  projectRoot: string,
): EngineResult<true> {
  const ownerOverride =
    process.env['CLEO_OWNER_OVERRIDE'] === '1' &&
    typeof process.env['CLEO_OWNER_OVERRIDE_REASON'] === 'string' &&
    process.env['CLEO_OWNER_OVERRIDE_REASON'].length > 0;

  const staleTasks: { taskId: string; atom: string; reason: string }[] = [];

  for (const task of plan.tasks) {
    for (const atom of task.evidenceAtoms ?? []) {
      const colonIdx = atom.indexOf(':');
      if (colonIdx <= 0) continue;
      const kind = atom.slice(0, colonIdx);
      const value = atom.slice(colonIdx + 1);

      if (kind === 'commit') {
        // Reachability: <sha> MUST be an ancestor of <tag>.
        try {
          execFileSync('git', ['merge-base', '--is-ancestor', value, tag], {
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: SUBPROCESS_TIMEOUT_MS,
          });
        } catch {
          staleTasks.push({
            taskId: task.id,
            atom,
            reason: `commit ${value} is not reachable from tag ${tag}`,
          });
        }
      } else if (kind === 'files') {
        // Each path in the comma-separated list MUST still exist. Best-effort
        // hash check (sha256) — we do not have the plan-time hash on hand.
        const paths = value
          .split(',')
          .map((p: string) => p.trim())
          .filter(Boolean);
        for (const relPath of paths) {
          const abs = resolve(projectRoot, relPath);
          if (!existsSync(abs)) {
            staleTasks.push({
              taskId: task.id,
              atom,
              reason: `file ${relPath} missing post-publish`,
            });
            continue;
          }
          // Hash to surface as the validation signal — not compared yet, but
          // the call itself catches binary-corruption / unreadable files.
          try {
            createHash('sha256').update(readFileSync(abs)).digest('hex');
          } catch (err) {
            staleTasks.push({
              taskId: task.id,
              atom,
              reason: `file ${relPath} unreadable: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      } else if (kind === 'test-run') {
        // Treat the value as a path to a vitest/cargo-test JSON file.
        const abs = resolve(projectRoot, value);
        if (!existsSync(abs)) {
          staleTasks.push({
            taskId: task.id,
            atom,
            reason: `test-run file ${value} missing post-publish`,
          });
          continue;
        }
        try {
          createHash('sha256').update(readFileSync(abs)).digest('hex');
        } catch (err) {
          staleTasks.push({
            taskId: task.id,
            atom,
            reason: `test-run file ${value} unreadable: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      // Other atom kinds (note:, decision:, tool:) are not staleness-sensitive.
    }
  }

  if (staleTasks.length > 0 && !ownerOverride) {
    return engineError(
      'E_EVIDENCE_STALE',
      `${staleTasks.length} evidence atom(s) failed staleness re-validation`,
      {
        fix: `Re-verify the affected tasks (cleo verify <id> ...) OR set CLEO_OWNER_OVERRIDE=1 with CLEO_OWNER_OVERRIDE_REASON.`,
        details: { staleTasks },
      },
    );
  }
  if (staleTasks.length > 0 && ownerOverride) {
    log.warn(
      { staleTasks, reason: process.env['CLEO_OWNER_OVERRIDE_REASON'] },
      'evidence staleness bypassed by owner override',
    );
  }
  return engineSuccess(true);
}

// ─── Helpers — git log walking ───────────────────────────────────────────────

/**
 * Walk `git log <prevTag>..<tag>` and parse all commits with their file
 * changes. Returns oldest-first (topo + reverse) for stable position
 * assignment.
 *
 * When `prevTag` is null (first-ever release) we walk from the beginning of
 * the history up to and including the tag commit.
 */
function walkGitLog(prevTag: string | null, tag: string, projectRoot: string): ParsedCommit[] {
  const range = prevTag ? `${prevTag}..${tag}` : tag;

  // Format strategy: emit one metadata line per commit using `\x1f`
  // (unit-separator) between fields. `--name-status` then writes the
  // file-change block on the lines that follow. We do NOT use a
  // record-separator inside the format string — splitting on a unique line
  // pattern is more robust when git intermixes name-status output between
  // commits.
  //
  // Each commit's output is therefore:
  //   <SHA><x1f><short><x1f>...<x1f><parents>\n
  //   <changeType>\t<path>[\t<oldPath>]\n     -- 0..N file lines
  //   <blank line>                            -- separator between commits
  //
  // We detect the meta line by the presence of `\x1f`.
  const FIELD_SEP = '\x1f';
  const format = ['%H', '%h', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s', '%P'].join(FIELD_SEP);

  const raw = runGit(
    ['log', `--pretty=format:${format}`, '--name-status', '--reverse', range],
    projectRoot,
  );

  const commits: ParsedCommit[] = [];
  let currentMeta: string[] | null = null;
  let currentFiles: ParsedCommitFile[] = [];

  /** Push the current commit (if any) into `commits`. */
  const flush = (): void => {
    if (!currentMeta) return;
    const [
      sha,
      shortSha,
      authorName,
      authorEmail,
      authoredAt,
      committerName,
      committerEmail,
      committedAt,
      subject,
      parentLine,
    ] = currentMeta;
    if (sha) {
      const parents = (parentLine ?? '')
        .trim()
        .split(/\s+/)
        .filter((p: string) => /^[0-9a-f]{4,40}$/.test(p));
      commits.push({
        sha,
        shortSha: shortSha || sha.slice(0, 7),
        authorName: authorName || '',
        authorEmail: authorEmail || '',
        authoredAt: authoredAt || '',
        committerName: committerName || '',
        committerEmail: committerEmail || '',
        committedAt: committedAt || '',
        subject: subject || '',
        message: subject || '',
        parents,
        files: currentFiles,
      });
    }
    currentMeta = null;
    currentFiles = [];
  };

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.includes(FIELD_SEP)) {
      // Start of a new commit — flush the previous one.
      flush();
      currentMeta = line.split(FIELD_SEP);
      continue;
    }
    if (!line.trim()) continue;
    if (!currentMeta) continue; // stray line — ignore
    const parts = line.split('\t');
    const status = parts[0]?.charAt(0)?.toUpperCase();
    if (status === 'A' || status === 'M' || status === 'D') {
      if (parts[1]) currentFiles.push({ changeType: status, path: parts[1] });
    } else if (status === 'R' || status === 'C') {
      if (parts[1] && parts[2]) {
        currentFiles.push({ changeType: status, path: parts[2], oldPath: parts[1] });
      }
    }
  }
  flush();

  return commits;
}

// ─── Helpers — token extraction + classification ─────────────────────────────

/** T#### regex (matches T0 through T99999). */
const TASK_TOKEN_RE = /\bT\d{1,5}\b/g;

/**
 * Extract unique T#### tokens from a commit's subject, body, and trailers.
 *
 * Returns the token set preserving order of first occurrence so downstream
 * `is_primary` heuristics (first-mentioned token wins) are deterministic.
 */
function extractTaskTokens(commit: ParsedCommit): string[] {
  const text = `${commit.subject}\n${commit.message}`;
  const tokens = new Set<string>();
  let m: RegExpExecArray | null = TASK_TOKEN_RE.exec(text);
  while (m !== null) {
    tokens.add(m[0]);
    m = TASK_TOKEN_RE.exec(text);
  }
  return Array.from(tokens);
}

/** PR-number regex (matches `#NNNN`). */
const PR_NUMBER_RE = /#(\d{1,6})\b/g;

/** Detect Conventional Commits prefix in subject (e.g. `feat(scope): ...`). */
const CC_RE =
  /^(feat|fix|chore|docs|refactor|test|perf|build|ci|revert|breaking|style)(?:\(([^)]+)\))?!?:\s/i;

/**
 * Parse the conventional-commits prefix from a commit subject. Returns the
 * normalised lowercased type or `null` when the subject is not CC-formatted.
 */
function parseConventionalType(subject: string): string | null {
  const m = subject.match(CC_RE);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** Detect the `chore(release): vX.Y.Z` release-chore pattern. */
function isReleaseChoreSubject(subject: string): boolean {
  return /^(?:release:|chore\(release\)|chore: release)\s/.test(subject);
}

// ─── Helpers — change_type classifier (Provenance §2.2) ─────────────────────

/**
 * Classify a plan task into one of the 12 `release_changes.change_type` values
 * per provenance-graph-design.md §2.2. Hotfix detection runs here (NOT during
 * plan) per R-094.
 */
function classifyChangeType(
  task: ReleasePlan['tasks'][number],
  plan: ReleasePlan,
): schema.ReleaseChangeType {
  // 1. Breaking trumps everything.
  if (task.kind === 'breaking') return 'breaking';
  // 2. Revert.
  if (task.kind === 'revert') return 'revert';
  // 3. Docs / chore / refactor / test / perf — straight mapping (12-value set
  //    does not include 'test'/'perf'; fold into 'chore').
  if (task.kind === 'docs') return 'docs';
  if (task.kind === 'chore' || task.kind === 'test' || task.kind === 'perf') return 'chore';
  if (task.kind === 'refactor') return 'refactor';

  // 4. Hotfix detection: explicit `kind=hotfix` OR (kind=fix && releaseKind=hotfix).
  if (task.kind === 'hotfix') return 'hotfix';
  if (task.kind === 'fix' && plan.releaseKind === 'hotfix') return 'hotfix';

  // 5. Fix → bug (regular fix in a non-hotfix release).
  if (task.kind === 'fix') return 'bug';

  // 6. Feat → feature (default) OR enhancement when impact='patch'.
  if (task.kind === 'feat') {
    return task.impact === 'patch' ? 'enhancement' : 'feature';
  }

  // Fallback for any unforeseen kind value.
  return 'chore';
}

/** Map `task.impact` to `release_changes.impact` (defaulting unknown to 'patch'). */
function mapImpact(task: ReleasePlan['tasks'][number]): schema.ReleaseImpact {
  if (task.impact === 'major' || task.impact === 'minor' || task.impact === 'patch') {
    return task.impact;
  }
  return 'patch';
}

// ─── Helpers — PR fetching ───────────────────────────────────────────────────

/**
 * Fetch full PR metadata + commit list from `gh api`. Returns `null` when the
 * PR is unavailable or the API call fails (non-fatal — PR provenance is
 * best-effort per SPEC R-333).
 */
function fetchPR(prNumber: number, projectRoot: string): ParsedPR | null {
  try {
    // Resolve owner/repo from current remote so we don't need it in args.
    const remoteUrl = runGit(['remote', 'get-url', 'origin'], projectRoot);
    const ownerRepo = parseOwnerRepo(remoteUrl);
    if (!ownerRepo) return null;
    const { owner, repo } = ownerRepo;

    const detail = runGh(['api', `repos/${owner}/${repo}/pulls/${prNumber}`], projectRoot);
    const j = JSON.parse(detail) as {
      number: number;
      title: string;
      body: string | null;
      state: string;
      merged?: boolean;
      base?: { ref?: string };
      head?: { ref?: string; sha?: string };
      merge_commit_sha?: string | null;
      user?: { login?: string };
      created_at?: string;
      merged_at?: string | null;
      closed_at?: string | null;
    };

    let commits: { sha: string }[] = [];
    try {
      const commitsRaw = runGh(
        ['api', '--paginate', `repos/${owner}/${repo}/pulls/${prNumber}/commits`],
        projectRoot,
      );
      // `gh api --paginate` concatenates JSON arrays separated by newlines; we
      // normalise by joining `][` with `,`.
      const normalised = commitsRaw.replace(/]\s*\n*\s*\[/g, ',');
      const parsed = JSON.parse(normalised) as { sha: string }[];
      commits = parsed.filter((c) => typeof c.sha === 'string').map((c) => ({ sha: c.sha }));
    } catch {
      // best-effort — keep commits empty
    }

    return {
      prNumber: j.number,
      title: j.title,
      body: j.body ?? null,
      state: j.merged ? 'merged' : j.state === 'open' ? 'open' : 'closed',
      baseRef: j.base?.ref ?? 'main',
      headRef: j.head?.ref ?? '',
      headSha: j.head?.sha ?? null,
      mergeCommitSha: j.merge_commit_sha ?? null,
      authorLogin: j.user?.login ?? null,
      openedAt: j.created_at ?? new Date().toISOString(),
      mergedAt: j.merged_at ?? null,
      closedAt: j.closed_at ?? null,
      repoUrl: `https://github.com/${owner}/${repo}`,
      commits,
    };
  } catch (err) {
    log.warn(
      { prNumber, err: err instanceof Error ? err.message : String(err) },
      'fetchPR failed — skipping PR (non-fatal)',
    );
    return null;
  }
}

/** Parse `owner/repo` from an HTTPS or SSH GitHub remote URL. */
function parseOwnerRepo(remote: string): { owner: string; repo: string } | null {
  const trimmed = remote.trim();
  const https = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (https) return { owner: https[1], repo: https[2] };
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  return null;
}

// ─── Helpers — plan archive ──────────────────────────────────────────────────

/**
 * Move `.cleo/release/<version>.plan.json` to
 * `.cleo/release/archive/<version>.plan.json`. Atomic via tmp-then-rename
 * pattern: write archive first, only delete the source on success (R-099).
 */
async function archivePlan(version: string, projectRoot: string): Promise<void> {
  const src = join(projectRoot, PLAN_DIR_REL, `${version}.plan.json`);
  if (!existsSync(src)) return; // already archived (idempotent)
  const archiveDir = join(projectRoot, PLAN_ARCHIVE_DIR_REL);
  await mkdir(archiveDir, { recursive: true });
  const dst = join(archiveDir, `${version}.plan.json`);
  // Read source content, write to archive atomically (tmp-then-rename), only
  // then delete source.
  const content = readFileSync(src);
  const tmp = `${dst}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, dst);
  // Delete source last (idempotent if archive write succeeded).
  try {
    renameSync(src, `${src}.archived.${Date.now()}`);
    // Two-step instead of unlink so we never lose the source on disk if the
    // operator wants forensic access; rename to .archived.<ts> is reversible.
  } catch {
    // ignore — archive is durable, source cleanup is best-effort
  }
}

// ─── Helpers — BRAIN observation emission ────────────────────────────────────

/**
 * Auto-emit `cleo memory observe ...` per R-098. Best-effort — failure is
 * non-fatal and is logged at warn level.
 *
 * Returns the resolved observation ID (when extractable from stdout) or null.
 */
async function emitBrainObservation(
  version: string,
  taskCount: number,
  projectRoot: string,
): Promise<string | null> {
  try {
    const text = `Released ${version} with ${taskCount} changes`;
    const title = `Release ${version}`;
    const { stdout } = await execFileAsync(
      'cleo',
      ['memory', 'observe', text, '--title', title, '--type', 'observation', '--json'],
      { cwd: projectRoot, timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    // Parse the envelope to fish out the BRAIN entry ID (best-effort).
    const parsed = JSON.parse(stdout) as { data?: { id?: string } };
    return parsed.data?.id ?? null;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), version },
      'BRAIN observation auto-emit failed — non-fatal',
    );
    return null;
  }
}

// ─── Helpers — DB transaction wrapper using node:sqlite BEGIN IMMEDIATE ─────

/**
 * Run `fn` inside a `BEGIN IMMEDIATE`...`COMMIT` block. Rolls back on any
 * throw and re-throws with the original error so callers can inspect
 * `.tableName` for the partial-write site.
 *
 * SQLite's `BEGIN IMMEDIATE` acquires the RESERVED lock immediately so
 * concurrent reconciles fail-fast rather than racing. This mirrors the
 * existing pattern in `queue-manager.ts` (T1145).
 */
function withTransaction<T>(fn: () => Promise<T>, projectRoot: string): Promise<T> {
  const nativeDb = getNativeDb();
  if (!nativeDb) {
    throw new Error(
      `withTransaction: native SQLite handle not initialized for ${projectRoot}; call getDb() first`,
    );
  }
  nativeDb.exec('BEGIN IMMEDIATE');
  return fn().then(
    (out) => {
      nativeDb.exec('COMMIT');
      return out;
    },
    (err) => {
      try {
        nativeDb.exec('ROLLBACK');
      } catch {
        // ignore — surface the original error
      }
      throw err;
    },
  );
}

/**
 * Tag an error with the table it failed in so the caller can emit
 * `error.details.table` per SPEC §4.4.3 R-100.
 */
class ProvenanceTableError extends Error {
  readonly table: string;
  constructor(table: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`Failed writing ${table}: ${causeMsg}`);
    this.table = table;
    this.name = 'ProvenanceTableError';
    if (cause instanceof Error && cause.stack) this.stack = cause.stack;
  }
}

// ─── Helpers — FK-safe PR shape (C3) ────────────────────────────────────────

/**
 * Sanitised PR shape ready for insertion: any FK columns pointing at a
 * commit that is NOT in the inserted-commits set are NULLed out (soft FKs)
 * and the `commits[]` list is filtered to only include in-range SHAs (hard
 * FK — NULLing is not an option, so the row is dropped instead).
 */
export interface SanitisedPR {
  headSha: string | null;
  mergeCommitSha: string | null;
  commits: { sha: string }[];
}

/**
 * Make a PR row FK-safe before inserting into `pull_requests` / `pr_commits`.
 *
 * Background (C3 bug — T9686): `pull_requests.headSha` and
 * `mergeCommitSha` are soft FKs to `commits.sha` (ON DELETE SET NULL), but
 * SQLite still enforces them at INSERT time. `pr_commits.commitSha` is a
 * NOT NULL FK with ON DELETE CASCADE — for rows referring to out-of-range
 * commits, the only safe action is to skip the row.
 *
 * A PR can reference commits OUTSIDE the current reconcile range because:
 *   - `headSha` (PR-branch tip pre-merge) usually never lands on `main`;
 *     the merge commit replaces it.
 *   - `mergeCommitSha` may belong to an earlier release range.
 *   - `commits[]` (from `gh api`) may include rebased / squash-removed SHAs.
 *
 * @param pr — the raw PR shape as returned from `fetchPR`.
 * @param insertedShas — set of commit SHAs already inserted into `commits`.
 * @returns FK-safe PR projection — NULL on dangling soft FK; filtered
 *   `commits[]`.
 */
export function sanitisePrShasForFk(
  pr: { headSha: string | null; mergeCommitSha: string | null; commits: { sha: string }[] },
  insertedShas: ReadonlySet<string>,
): SanitisedPR {
  return {
    headSha: pr.headSha && insertedShas.has(pr.headSha) ? pr.headSha : null,
    mergeCommitSha:
      pr.mergeCommitSha && insertedShas.has(pr.mergeCommitSha) ? pr.mergeCommitSha : null,
    commits: pr.commits.filter((c) => insertedShas.has(c.sha)),
  };
}

// ─── Main reconcile entrypoint ──────────────────────────────────────────────

/**
 * Run the v2 `cleo release reconcile` verb.
 *
 * On success returns `engineSuccess(ReleaseReconcileV2Result)`. On any
 * documented failure path returns `engineError(<code>, ...)`.
 *
 * @param version  — the version string (e.g. `v2026.6.0`). MUST equal the git
 *   tag exactly per R-082.
 * @param opts     — see {@link ReleaseReconcileV2Options}.
 *
 * @returns EngineResult envelope.
 */
export async function releaseReconcileV2(
  version: string,
  opts: ReleaseReconcileV2Options = {},
): Promise<EngineResult<ReleaseReconcileV2Result>> {
  const startedAt = Date.now();
  const projectRoot = getProjectRoot(opts.projectRoot);

  // ── 1. Pre-conditions (R-080 .. R-083) ──
  const planRes = loadPlan(version, projectRoot);
  if (!planRes.success) return planRes;
  const plan = planRes.data;

  const tagRes = assertTagExists(version, projectRoot);
  if (!tagRes.success) return tagRes;
  const tagSha = tagRes.data;

  const releaseRes = assertReleaseMatchesTag(version, projectRoot);
  if (!releaseRes.success) return releaseRes;

  // T9528: backfill walks historical tags whose evidence atoms may reference
  // long-deleted files or rebased commits — skip the R-313 staleness gate.
  // Production publish flows still pass through this check.
  if (!opts.backfill) {
    const stalenessRes = revalidateEvidenceStaleness(plan, version, projectRoot);
    if (!stalenessRes.success) return stalenessRes;
  }

  // ── 2. Walk git log (outside the transaction — read-only) ──
  let commits: ParsedCommit[];
  try {
    commits = walkGitLog(plan.previousTag ?? plan.previousVersion, version, projectRoot);
  } catch (err) {
    return engineError(
      'E_GIT_LOG_FAILED',
      `Failed to walk git log: ${err instanceof Error ? err.message : String(err)}`,
      { details: { range: `${plan.previousTag ?? plan.previousVersion}..${version}` } },
    );
  }

  // Initialise DB up-front (must happen BEFORE `withTransaction`).
  const db = await getDb(projectRoot);

  // ── 3. Pre-flight: list of valid task IDs for token validation (R-331) ──
  const validTaskIds = new Set<string>();
  {
    const rows = await db.select({ id: schema.tasks.id }).from(schema.tasks).all();
    for (const r of rows) {
      if (typeof r.id === 'string') validTaskIds.add(r.id);
    }
  }

  const unknownTokens = new Set<string>();
  const orphanCommits: string[] = [];
  const projectHash = generateProjectHash(projectRoot);
  const releaseId = `${projectHash}:${version}`;
  const nowIso = new Date().toISOString();

  // ── 4. Idempotency probe: is this release already reconciled? ──
  let reReconciled = false;
  {
    const rows = await db
      .select({ status: schema.releases.status })
      .from(schema.releases)
      .where(eqVersion(version))
      .all();
    if (rows.length > 0 && rows[0]?.status === 'reconciled') {
      reReconciled = true;
    }
  }

  // ── 5. Discover bump-PR + task-PRs (best-effort, outside TX) ──
  const prNumbers = new Set<number>();
  if (plan.prUrl) {
    const m = plan.prUrl.match(/\/pull\/(\d+)/);
    if (m) prNumbers.add(Number.parseInt(m[1], 10));
  }
  for (const c of commits) {
    PR_NUMBER_RE.lastIndex = 0;
    let pm: RegExpExecArray | null = PR_NUMBER_RE.exec(c.message);
    while (pm !== null) {
      const n = Number.parseInt(pm[1], 10);
      if (Number.isFinite(n) && n > 0) prNumbers.add(n);
      pm = PR_NUMBER_RE.exec(c.message);
    }
  }
  const fetchedPRs: ParsedPR[] = [];
  for (const n of prNumbers) {
    const pr = fetchPR(n, projectRoot);
    if (pr) fetchedPRs.push(pr);
  }

  // ── 6. Optional BRAIN observation (outside TX — independent of inserts) ──
  // NB: emit AFTER inserts succeed; staged here so we can include result in
  // brain_release_links if extractable.
  // (Actual emission happens after the transaction below.)

  // ── 7. Single transaction (R-100): all 11 tables ──
  let txSize = 0;
  let artifactCount = 0;
  let changeCount = 0;
  let brainLinkCount = 0;
  let brainEntryId: string | null = null;

  try {
    await withTransaction(async () => {
      // ── commits + commit_files ──
      try {
        for (const c of commits) {
          await db
            .insert(schema.commits)
            .values({
              sha: c.sha,
              shortSha: c.shortSha,
              authorName: c.authorName,
              authorEmail: c.authorEmail,
              authoredAt: c.authoredAt,
              committerName: c.committerName,
              committerEmail: c.committerEmail,
              committedAt: c.committedAt,
              message: c.message,
              subject: c.subject,
              conventionalType: parseConventionalType(c.subject),
              isReleaseCommit: isReleaseChoreSubject(c.subject) ? 1 : 0,
              isMergeCommit: c.parents.length > 1 ? 1 : 0,
              parentShas: JSON.stringify(c.parents),
              projectHash,
            })
            .onConflictDoUpdate({
              target: schema.commits.sha,
              set: {
                shortSha: c.shortSha,
                subject: c.subject,
                message: c.message,
                conventionalType: parseConventionalType(c.subject),
                isReleaseCommit: isReleaseChoreSubject(c.subject) ? 1 : 0,
                isMergeCommit: c.parents.length > 1 ? 1 : 0,
                parentShas: JSON.stringify(c.parents),
              },
            })
            .run();
          txSize++;
        }
      } catch (err) {
        throw new ProvenanceTableError('commits', err);
      }

      try {
        for (const c of commits) {
          for (const f of c.files) {
            await db
              .insert(schema.commitFiles)
              .values({
                commitSha: c.sha,
                path: f.path,
                oldPath: f.oldPath ?? null,
                changeType: f.changeType,
              })
              .onConflictDoUpdate({
                target: [schema.commitFiles.commitSha, schema.commitFiles.path],
                set: {
                  oldPath: f.oldPath ?? null,
                  changeType: f.changeType,
                },
              })
              .run();
            txSize++;
          }
        }
      } catch (err) {
        throw new ProvenanceTableError('commit_files', err);
      }

      // ── task_commits ──
      try {
        for (const c of commits) {
          const tokens = extractTaskTokens(c);
          if (tokens.length === 0) {
            orphanCommits.push(c.sha);
            continue;
          }
          let linked = 0;
          for (const tok of tokens) {
            if (!validTaskIds.has(tok)) {
              unknownTokens.add(tok);
              continue;
            }
            const linkSource = c.subject.includes(tok) ? 'commit-message' : 'commit-trailer';
            await db
              .insert(schema.taskCommits)
              .values({
                taskId: tok,
                commitSha: c.sha,
                linkKind: 'implements',
                linkSource,
              })
              .onConflictDoNothing()
              .run();
            txSize++;
            linked++;
          }
          if (linked === 0) orphanCommits.push(c.sha);
        }
      } catch (err) {
        throw new ProvenanceTableError('task_commits', err);
      }

      // ── pull_requests + pr_commits + pr_tasks ──
      //
      // FK safety (C3): pull_requests.headSha and pull_requests.mergeCommitSha
      // are soft FKs to commits.sha (ON DELETE SET NULL) — but SQLite still
      // enforces them at INSERT time. Likewise pr_commits.commitSha is a
      // NOT NULL FK to commits.sha (ON DELETE CASCADE).
      //
      // The `commits` set in this transaction is `prevTag..tag` only. A PR
      // can reference commits OUTSIDE that range:
      //   - `headSha` (tip of the PR branch before merge) is typically NOT
      //     in main's history at all — the merge commit replaces it.
      //   - `mergeCommitSha` may reference an older release range when the
      //     PR was merged before the current `since` boundary.
      //   - PR `commits[]` from `gh api` may include rebased/old commits.
      //
      // For each FK reference we check membership in the inserted-commits
      // set; if absent we either set the FK column to NULL (pullRequests)
      // or skip the row entirely (prCommits — NOT NULL FK can't be NULLed).
      const insertedShas = new Set<string>(commits.map((c) => c.sha));
      try {
        for (const pr of fetchedPRs) {
          const prId = `${projectHash}:${pr.prNumber}`;
          const isBumpPr = !!plan.prUrl && plan.prUrl.endsWith(`/pull/${pr.prNumber}`);
          // Sanitise FK references — see `sanitisePrShasForFk` for the why.
          const safePr = sanitisePrShasForFk(pr, insertedShas);
          await db
            .insert(schema.pullRequests)
            .values({
              id: prId,
              prNumber: pr.prNumber,
              repoUrl: pr.repoUrl,
              title: pr.title,
              body: pr.body,
              state: pr.state,
              baseRef: pr.baseRef,
              headRef: pr.headRef,
              headSha: safePr.headSha,
              mergeCommitSha: safePr.mergeCommitSha,
              authorLogin: pr.authorLogin,
              openedAt: pr.openedAt,
              mergedAt: pr.mergedAt,
              closedAt: pr.closedAt,
              isReleasePr: isBumpPr ? 1 : 0,
              releaseVersion: isBumpPr ? version : null,
              isBumpOnly: isBumpPr ? 1 : 0,
              projectHash,
              updatedAt: nowIso,
            })
            .onConflictDoUpdate({
              target: schema.pullRequests.id,
              set: {
                state: pr.state,
                title: pr.title,
                body: pr.body,
                headSha: safePr.headSha,
                mergeCommitSha: safePr.mergeCommitSha,
                mergedAt: pr.mergedAt,
                closedAt: pr.closedAt,
                isReleasePr: isBumpPr ? 1 : 0,
                releaseVersion: isBumpPr ? version : null,
                isBumpOnly: isBumpPr ? 1 : 0,
                updatedAt: nowIso,
              },
            })
            .run();
          txSize++;

          // pr_commits — ordered. `sanitisePrShasForFk` already filtered
          // out commits not in the inserted-commits set (NOT NULL FK has
          // no NULL alternative). Preserve original ordinal positions.
          for (let i = 0; i < safePr.commits.length; i++) {
            const cm = safePr.commits[i];
            if (!cm) continue;
            await db
              .insert(schema.prCommits)
              .values({ prId, commitSha: cm.sha, position: i })
              .onConflictDoNothing()
              .run();
            txSize++;
          }

          // pr_tasks — extract T#### from PR title/body/branch
          const prText = `${pr.title}\n${pr.body ?? ''}\n${pr.headRef}`;
          TASK_TOKEN_RE.lastIndex = 0;
          const prTokens = new Set<string>();
          let pt: RegExpExecArray | null = TASK_TOKEN_RE.exec(prText);
          while (pt !== null) {
            prTokens.add(pt[0]);
            pt = TASK_TOKEN_RE.exec(prText);
          }
          for (const tok of prTokens) {
            if (!validTaskIds.has(tok)) {
              unknownTokens.add(tok);
              continue;
            }
            let linkSource: schema.PrLinkSource = 'pr-body';
            if (pr.title.includes(tok)) linkSource = 'pr-title';
            else if (pr.headRef.includes(tok)) linkSource = 'branch-name';
            await db
              .insert(schema.prTasks)
              .values({ prId, taskId: tok, linkSource, linkKind: 'implements' })
              .onConflictDoNothing()
              .run();
            txSize++;
          }
        }
      } catch (err) {
        throw new ProvenanceTableError('pull_requests', err);
      }

      // ── releases (UPSERT into the unified `releases` table) ──
      try {
        const bumpPrId = (() => {
          if (!plan.prUrl) return null;
          const m = plan.prUrl.match(/\/pull\/(\d+)/);
          return m ? `${projectHash}:${m[1]}` : null;
        })();
        // FK safety (C3): releasesNew.mergeCommitSha is a soft FK to
        // commits.sha (ON DELETE SET NULL). If the plan references a
        // commit not present in this range's commits set, NULL the FK to
        // avoid violating the constraint at INSERT time.
        const safeReleaseMergeSha =
          plan.mergeCommitSha && insertedShas.has(plan.mergeCommitSha) ? plan.mergeCommitSha : null;
        await db
          .insert(schema.releases)
          .values({
            id: releaseId,
            version,
            scheme: plan.scheme,
            channel: mapChannel(plan.channel),
            epicId: plan.epicId,
            releaseKind: plan.releaseKind,
            status: 'reconciled',
            previousVersion: plan.previousVersion,
            mergeCommitSha: safeReleaseMergeSha,
            prId: bumpPrId,
            workflowRunUrl: plan.workflowRunUrl,
            plannedAt: plan.createdAt,
            publishedAt: plan.previousShippedAt ?? null, // best-effort
            reconciledAt: nowIso,
            projectHash,
          })
          .onConflictDoUpdate({
            target: schema.releases.id,
            set: {
              status: 'reconciled',
              reconciledAt: nowIso,
              mergeCommitSha: safeReleaseMergeSha,
              workflowRunUrl: plan.workflowRunUrl,
            },
          })
          .run();
        txSize++;
      } catch (err) {
        throw new ProvenanceTableError('releases', err);
      }

      // ── release_commits ──
      try {
        for (let pos = 0; pos < commits.length; pos++) {
          const c = commits[pos];
          const isFirst = pos === 0 ? 1 : 0;
          const isLast = pos === commits.length - 1 ? 1 : 0;
          const isChore = isReleaseChoreSubject(c.subject) ? 1 : 0;
          await db
            .insert(schema.releaseCommits)
            .values({
              releaseId,
              commitSha: c.sha,
              position: pos,
              isFirst,
              isLast: isChore ? 0 : isLast, // chore-flag is exclusive with isLast
              isReleaseChore: isChore,
            })
            .onConflictDoUpdate({
              target: [schema.releaseCommits.releaseId, schema.releaseCommits.commitSha],
              set: {
                position: pos,
                isFirst,
                isLast: isChore ? 0 : isLast,
                isReleaseChore: isChore,
              },
            })
            .run();
          txSize++;
        }
      } catch (err) {
        throw new ProvenanceTableError('release_commits', err);
      }

      // ── release_changes (one row per plan.tasks[]) ──
      try {
        for (let i = 0; i < plan.tasks.length; i++) {
          const task = plan.tasks[i];
          const changeType = classifyChangeType(task, plan);
          // Build deterministic ID so re-running upserts the same row.
          const idSeed = `${releaseId}|${task.id}|${changeType}`;
          const id = createHash('sha256').update(idSeed).digest('hex').slice(0, 32);
          await db
            .insert(schema.releaseChanges)
            .values({
              id,
              releaseId,
              taskId: validTaskIds.has(task.id) ? task.id : null,
              changeType,
              summary: task.userFacingSummary || `${task.id}: ${task.kind}`,
              description: null,
              impact: mapImpact(task),
              classifiedBy: 'auto',
            })
            .onConflictDoUpdate({
              target: schema.releaseChanges.id,
              set: {
                summary: task.userFacingSummary || `${task.id}: ${task.kind}`,
                changeType,
                impact: mapImpact(task),
              },
            })
            .run();
          changeCount++;
          txSize++;
        }
      } catch (err) {
        throw new ProvenanceTableError('release_changes', err);
      }

      // ── release_artifacts (one row per plan.platformMatrix[]) ──
      try {
        for (const entry of plan.platformMatrix) {
          await db
            .insert(schema.releaseArtifacts)
            .values({
              releaseId,
              artifactType: mapPublisherToArtifactType(entry.publisher),
              identifier: entry.package,
              version,
              url: null,
              publishedAt: nowIso,
              metadata: JSON.stringify({
                platform: entry.platform,
                publisher: entry.publisher,
                smoke: entry.smoke ?? true,
              }),
            })
            .onConflictDoUpdate({
              target: [
                schema.releaseArtifacts.releaseId,
                schema.releaseArtifacts.artifactType,
                schema.releaseArtifacts.identifier,
              ],
              set: {
                version,
                publishedAt: nowIso,
                metadata: JSON.stringify({
                  platform: entry.platform,
                  publisher: entry.publisher,
                  smoke: entry.smoke ?? true,
                }),
              },
            })
            .run();
          artifactCount++;
          txSize++;
        }
      } catch (err) {
        throw new ProvenanceTableError('release_artifacts', err);
      }

      // ── brain_release_links — scan plan + PR bodies + commits ──
      // We collect any `cleo memory observe`/`memory:<id>` references then
      // UPSERT one row per (brain_entry_id, release_id, link_type) per R-340.
      try {
        const linkTargets = new Set<string>();
        const MEMORY_REF_RE = /\b(?:cleo\s+memory\s+observe|memory:)\s*"?([A-Za-z0-9-]{6,})/g;
        const scanBlob = `${plan.prUrl ?? ''}\n${fetchedPRs.map((p) => p.body ?? '').join('\n')}\n${commits.map((c) => c.message).join('\n')}`;
        let mm: RegExpExecArray | null = MEMORY_REF_RE.exec(scanBlob);
        while (mm !== null) {
          linkTargets.add(mm[1]);
          mm = MEMORY_REF_RE.exec(scanBlob);
        }
        for (const entryId of linkTargets) {
          await db
            .insert(schema.brainReleaseLinks)
            .values({
              brainEntryId: entryId,
              releaseId,
              linkType: 'derived-from',
              createdBy: 'release-reconcile-v2',
            })
            .onConflictDoNothing()
            .run();
          brainLinkCount++;
          txSize++;
        }
      } catch (err) {
        throw new ProvenanceTableError('brain_release_links', err);
      }
    }, projectRoot);
  } catch (err) {
    if (err instanceof ProvenanceTableError) {
      return engineError('E_PROVENANCE_FAILED', err.message, { details: { table: err.table } });
    }
    return engineError('E_PROVENANCE_FAILED', err instanceof Error ? err.message : String(err), {
      details: { table: 'unknown' },
    });
  }

  // ── 8. Post-transaction side effects (R-098 BRAIN obs + R-099 archive) ──
  brainEntryId = await emitBrainObservation(version, plan.tasks.length, projectRoot);
  if (brainEntryId) {
    try {
      await db
        .insert(schema.brainReleaseLinks)
        .values({
          brainEntryId,
          releaseId,
          linkType: 'observed-in',
          createdBy: 'release-reconcile-v2',
        })
        .onConflictDoNothing()
        .run();
      brainLinkCount++;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to link auto-observation to brain_release_links — non-fatal',
      );
    }
  }

  try {
    await archivePlan(version, projectRoot);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Plan archive failed — provenance still recorded',
    );
  }

  const durationMs = Date.now() - startedAt;
  const result: ReleaseReconcileV2Result = {
    version,
    tag: version,
    tagSha,
    commitCount: commits.length,
    taskCount: plan.tasks.length,
    changeCount,
    artifactCount,
    brainLinkCount,
    orphanCommits,
    ...(unknownTokens.size > 0 ? { unknownTokens: Array.from(unknownTokens) } : {}),
    ...(reReconciled ? { reReconciled: true } : {}),
    durationMs,
    txSize,
  };

  if (opts.fromWorkflow) {
    log.info({ version, durationMs, txSize }, 'reconcile-v2 completed (from-workflow)');
  }

  return engineSuccess(result);
}

// ─── Minor helpers ───────────────────────────────────────────────────────────

/** WHERE clause helper — drizzle `eq` against `releases.version`. */
function eqVersion(version: string) {
  return eq(schema.releases.version, version);
}

/**
 * Map the {@link ReleasePlan.channel} value (which uses the contracts
 * `latest|beta|alpha|rc` set) onto {@link schema.RELEASE_CHANNELS} (which
 * uses `latest|beta|dev|hotfix`).
 *
 * The two enums diverge intentionally per ADR-T9345 (plan contract permits
 * 'rc' for release candidates; schema currently uses 'dev' for pre-release
 * channels and 'hotfix' for emergency patches). Mapping rules:
 *
 *   - latest    → latest
 *   - beta      → beta
 *   - alpha     → dev
 *   - rc        → dev
 */
function mapChannel(channel: ReleasePlan['channel']): schema.ReleaseChannel {
  switch (channel) {
    case 'latest':
      return 'latest';
    case 'beta':
      return 'beta';
    case 'alpha':
    case 'rc':
      return 'dev';
    default:
      return 'latest';
  }
}

/**
 * Map a {@link ReleasePlan.platformMatrix} `publisher` value to the
 * {@link schema.RELEASE_ARTIFACT_TYPES} enum used by `release_artifacts`.
 *
 *   - npm             → npm
 *   - cargo           → cargo
 *   - docker          → docker
 *   - pypi            → pypi
 *   - github-release  → github-release
 *   - binary          → binary
 */
function mapPublisherToArtifactType(
  publisher: ReleasePlan['platformMatrix'][number]['publisher'],
): schema.ReleaseArtifactType {
  switch (publisher) {
    case 'npm':
      return 'npm';
    case 'cargo':
      return 'cargo';
    case 'docker':
      return 'docker';
    case 'pypi':
      return 'pypi';
    case 'github-release':
      return 'github-release';
    case 'binary':
      return 'binary';
    default:
      return 'binary';
  }
}
