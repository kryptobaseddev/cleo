/**
 * `cleo release cut <version>` — one-command release from the default branch's
 * newest commit with green CI (T14102 · epic T14099 · owner decision D11209).
 *
 * Replaces plan → open → bump-PR → hand-pushed tag. The cut:
 *   1. validates the CalVer version (strictly above every release tag and the
 *      default branch's package.json), then picks the newest first-parent
 *      commit of `origin/<default>` whose required checks
 *      (`release.prRequiredWorkflows`, app-pinned) all concluded `success` on
 *      its push run (an empty conclusion is not green), or verifies a pinned
 *      `--sha` the same way;
 *   2. renders the notes from the changesets added since the previous release
 *      tag, refusing a changeset no merged pull request brought in;
 *   3. reports the packages, new migrations and each named task's status
 *      (reported, never gated: green CI on the sha is the gate);
 *   4. creates the annotated tag `v<version>` on that sha through the GitHub
 *      API. Its message carries the hand-written lead (`--lead`). The tag push
 *      starts `release.yml`, which writes the CHANGELOG section
 *      ({@link releaseChangelog}), publishes, and opens the CHANGELOG + version
 *      PR. No test suite reruns: CI already passed that tree.
 *
 * @task T14102
 * @epic T14099
 */

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { ChangesetEntry, EngineResult } from '@cleocode/contracts';
import { engineError, engineSuccess } from '@cleocode/contracts/engine-result.js';
import {
  E_CHANGESET_YAML_INVALID,
  E_DOCS_ROT,
  E_GH_NOT_AUTHENTICATED,
  E_INVALID_STATE,
  E_RELEASE_NO_GREEN_COMMIT,
  E_RELEASE_NOT_AUTHORIZED,
  E_RELEASE_TAG_FAILED,
  E_RELEASE_UNMERGED_CHANGESET,
  ExitCode,
} from '@cleocode/contracts/exit-codes.js';
import type { MergeSweepOptions, MergeSweepResult } from '@cleocode/contracts/merge-close.js';
import type { DocsRotResult } from '@cleocode/contracts/operations/docs.js';
import type {
  MergedCleanupOpts,
  MergedCleanupResult,
} from '@cleocode/contracts/operations/worktree.js';
import { parseChangesetDir } from '../changesets/index.js';
import { scanDocsRot } from '../docs/rot.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { sweepMergedClosures } from '../tasks/merge-close.js';
import { cleanupMergedWork } from '../worktree/merged-cleanup.js';
import { AUTHORIZED_BY_TRAILER, releaseAuthorizationFor } from './authorization.js';
import { aggregateChangesetsForRelease } from './changesets-aggregator.js';
import { newestReachableReleaseTag, writeChangelogSection } from './plan.js';
import { readRequiredCheckPins, resolveRequiredWorkflows } from './pr-evidence.js';
import { readTtyConfirmation } from './tty-confirm.js';
import { normalizeVersion } from './version.js';

/** How many first-parent commits of the default branch the cut inspects for green CI. */
export const CUT_MAX_CANDIDATES = 30;

/** Per-cut audit log (ADR-099 §Consequences), relative to the project root. */
export const RELEASE_CUT_AUDIT_FILE = '.cleo/audit/release-cut.jsonl';

/** CalVer release version: `vYYYY.M.N`, optional `-suffix` (release.yml's Validate CalVer). */
const CALVER = /^v(\d{4})\.(\d{1,2})\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Subprocess runners, injectable for tests. */
export interface ReleaseCutRunner {
  /** Run `gh <args>` in `cwd`; returns trimmed stdout, throws on failure. */
  runGh: (args: readonly string[], cwd: string) => string;
  /** Run `git <args>` in `cwd`; returns stdout, throws on failure. */
  runGit: (args: readonly string[], cwd: string) => string;
}

/** Options for {@link releaseCut}. */
export interface ReleaseCutOptions {
  /** Version to release (`2026.10.28` or `v2026.10.28`). */
  version: string;
  /** Project whose task store, audit and grants the cut uses. */
  projectRoot: string;
  /**
   * The git checkout the cut runs in (T14160): every git and gh call, the
   * docs-rot scan and `checkoutAtMain` use it, and no other checkout is
   * touched. Default: `projectRoot`.
   */
  gitRoot?: string;
  /** Pin the commit instead of picking the newest green one; it must itself be green. */
  sha?: string;
  /** Markdown file whose content leads the notes ("Update now" + Highlights). */
  leadFile?: string;
  /** Show the commit, notes, packages and tasks without creating the tag. */
  dryRun?: boolean;
  /**
   * Confirm the tag (D11212). Without it the cut only reports, with the exact
   * confirm command. With it, a standing release authorization (T14141) or the
   * version typed on the controlling terminal (`/dev/tty`) allows the tag.
   */
  yes?: boolean;
  /** Default branch name (default `main`). */
  branch?: string;
  /** Test seam for the T14142 merged-work cleanup (default {@link cleanupMergedWork}). */
  cleanup?: (opts: MergedCleanupOpts) => Promise<MergedCleanupResult>;
  /** Test seam for the T14101 merge sweep (default {@link sweepMergedClosures}). */
  sweep?: (projectRoot: string, opts: MergeSweepOptions) => Promise<MergeSweepResult>;
  /** Test seam. */
  runner?: ReleaseCutRunner;
}

/** CI state of one candidate commit. */
export interface ReleaseCutCandidate {
  /** Commit sha. */
  sha: string;
  /** `success`, or the first required check that is not: `<name>: <state>`. */
  ci: string;
}

/** One task a changeset in range names, with its status at cut time. */
export interface ReleaseCutTask {
  /** Task id. */
  id: string;
  /** Store status, or `missing` when the task is not in this store. */
  status: string;
}

/** A published package and the version it ships at. */
export interface ReleaseCutPackage {
  /** Directory under `packages/`. */
  dir: string;
  /** npm name. */
  name: string;
  /** Version it publishes at. */
  version: string;
}

/** Result of {@link releaseCut}. */
export interface ReleaseCutResult {
  /** `v`-prefixed version. */
  version: string;
  /** Tag name (`v<version>`). */
  tag: string;
  /** Commit the release is cut from. */
  sha: string;
  /** Previous release tag the notes are computed from, or null for a first release. */
  previousTag: string | null;
  /** Commits checked for green CI, newest first, up to the chosen one. */
  candidates: ReleaseCutCandidate[];
  /** Changeset files in range. */
  changesets: string[];
  /** The rendered notes (lead first, then the generated sections). */
  notes: string;
  /** Packages `release.yml` publishes, at this version. */
  packages: ReleaseCutPackage[];
  /** Migration files added since the previous tag. */
  migrations: string[];
  /** Tasks the changesets name, with status (reported, not gated). */
  tasks: ReleaseCutTask[];
  /**
   * T14142 cleanup of the release's tasks: the plan on a report run, what was
   * removed after a confirmed tag. Besides the tasks' worktrees and `task/*`
   * branches it removes nested repository copies proven redundant (clean, every
   * ref on origin), only inside the worktrees of the release's done or
   * cancelled tasks. Null when the changesets name no task.
   */
  cleanup: MergedCleanupResult | null;
  /** The T14101 merge sweep run before the commit was picked (`swept: false` when it could not run). */
  sweep: MergeSweepResult;
  /** Docs rot of the project checkout (T14111); a real cut refuses when it has findings. */
  docsRot: DocsRotResult;
  /** Non-blocking findings, e.g. docs rot on a prerelease (it blocks only a stable cut). */
  warnings: string[];
  /** Whether the local checkout is at `origin/<default>` (the docs-rot scan reads it). */
  checkoutAtMain: boolean;
  /** The command that tags exactly this preview (pinned `--sha`), or null once tagged. */
  confirmCommand: string | null;
  /** True when no tag was created. */
  dryRun: boolean;
  /** True when this call created the tag (which starts `release.yml`). */
  tagCreated: boolean;
}

/** Options for {@link releaseChangelog}. */
export interface ReleaseChangelogOptions {
  /** Version whose section is written. */
  version: string;
  /** Git checkout whose `CHANGELOG.md` is written. */
  projectRoot: string;
  /** Commit the release was cut from (default: tag `v<version>` when it exists, else HEAD). */
  ref?: string;
  /** Test seam. */
  runner?: ReleaseCutRunner;
}

/** Result of {@link releaseChangelog}. */
export interface ReleaseChangelogResult {
  /** Path of the CHANGELOG. */
  changelogPath: string;
  /** False when the section already existed (a plan-PR release) or nothing changed. */
  written: boolean;
  /** Previous release tag the section was computed from. */
  previousTag: string | null;
  /** Changesets the section was built from. */
  changesetCount: number;
}

const SUBPROCESS_TIMEOUT_MS = 60_000;

function defaultRunner(): ReleaseCutRunner {
  const run = (bin: string) => (args: readonly string[], cwd: string) =>
    execFileSync(bin, [...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SUBPROCESS_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  return { runGh: run('gh'), runGit: run('git') };
}

/** A required check: its name and the app/workflow it must come from. */
interface RequiredCheck {
  name: string;
  app?: string | number;
  workflow?: string;
}

/**
 * The checks `release.prRequiredWorkflows` requires, with their pins, read from
 * the tracked `.cleo/project-context.json` at `ref`: the tree being released
 * decides what it must pass, not the caller's checkout.
 */
function requiredChecks(runner: ReleaseCutRunner, cwd: string, ref: string): RequiredCheck[] {
  let context: Record<string, unknown> | null = null;
  try {
    context = JSON.parse(runner.runGit(['show', `${ref}:.cleo/project-context.json`], cwd));
  } catch {
    context = null;
  }
  const pins = readRequiredCheckPins(context);
  return resolveRequiredWorkflows(process.env, context).map((name) => ({ name, ...pins[name] }));
}

/**
 * `success` when every required check concluded `success` on `sha`'s push run
 * of the default branch, else the first that did not (`<name>: <state>`). A
 * workflow-pinned check is read from that workflow's `push` run only, so a pull
 * request's run never counts; an unpinned one from the newest check run of
 * that name posted by its pinned app (default `github-actions`).
 */
function requiredCiState(
  runner: ReleaseCutRunner,
  cwd: string,
  sha: string,
  branch: string,
  checks: readonly RequiredCheck[],
): string {
  const jobsByWorkflow = new Map<string, Map<string, string> | string>();
  for (const check of checks) {
    const app = check.app ?? 'github-actions';
    const actions = app === 'github-actions' || app === 15368;
    if (!check.workflow) {
      const raw = runner.runGh(
        [
          'api',
          `repos/{owner}/{repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(check.name)}&per_page=100`,
        ],
        cwd,
      );
      const listed: {
        check_runs?: Array<{
          id: number;
          status: string;
          conclusion: string | null;
          app?: { slug?: string; id?: number };
        }>;
      } = JSON.parse(raw);
      const newest = (listed.check_runs ?? [])
        .filter((r) => r.app?.slug === app || r.app?.id === app)
        .sort((a, b) => b.id - a.id)[0];
      const state =
        newest === undefined
          ? 'none'
          : newest.status !== 'completed'
            ? newest.status
            : (newest.conclusion ?? 'none');
      if (state !== 'success') return `${check.name}: ${state}`;
      continue;
    }
    if (!actions) return `${check.name}: workflow check pinned to app ${app}`;
    let jobs = jobsByWorkflow.get(check.workflow);
    if (jobs === undefined) {
      jobs = pushRunJobs(runner, cwd, sha, branch, check.workflow);
      jobsByWorkflow.set(check.workflow, jobs);
    }
    if (typeof jobs === 'string') return `${check.name}: ${jobs}`;
    const state = jobs.get(check.name) ?? 'missing';
    if (state !== 'success') return `${check.name}: ${state}`;
  }
  return 'success';
}

/** Job name → state of the newest attempt of `workflow`'s push run on `sha`, or the run's own state. */
function pushRunJobs(
  runner: ReleaseCutRunner,
  cwd: string,
  sha: string,
  branch: string,
  workflow: string,
): Map<string, string> | string {
  const file = basename(workflow);
  const raw = runner.runGh(
    [
      'api',
      `repos/{owner}/{repo}/actions/workflows/${file}/runs?head_sha=${sha}&event=push&branch=${branch}&per_page=10`,
    ],
    cwd,
  );
  const listed: {
    workflow_runs?: Array<{
      id: number;
      run_attempt?: number;
      status: string;
      conclusion: string | null;
    }>;
  } = JSON.parse(raw);
  const run = (listed.workflow_runs ?? []).sort((a, b) => b.id - a.id)[0];
  if (run === undefined) return `no ${file} push run`;
  if (run.status !== 'completed') return run.status;
  const jobs = new Map<string, string>();
  for (let page = 1; page <= 5; page++) {
    const body: {
      total_count?: number;
      jobs?: Array<{ name: string; status: string; conclusion: string | null }>;
    } = JSON.parse(
      runner.runGh(
        [
          'api',
          `repos/{owner}/{repo}/actions/runs/${run.id}/attempts/${run.run_attempt ?? 1}/jobs?per_page=100&page=${page}`,
        ],
        cwd,
      ),
    );
    for (const job of body.jobs ?? []) {
      jobs.set(job.name, job.status !== 'completed' ? job.status : (job.conclusion ?? 'none'));
    }
    if ((body.jobs ?? []).length < 100) break;
  }
  return jobs;
}

/** True when `sha` is a first-parent commit of `origin/<branch>` (ADR-099 §2.2). */
function isFirstParent(
  runner: ReleaseCutRunner,
  cwd: string,
  sha: string,
  branch: string,
): boolean {
  return runner
    .runGit(['rev-list', '--first-parent', `origin/${branch}`], cwd)
    .split('\n')
    .includes(sha);
}

/** Order two `v`-prefixed CalVer versions; a stable version sorts above its own prereleases. */
function compareCalVer(a: string, b: string): number {
  const pa = CALVER.exec(a);
  const pb = CALVER.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (const k of [1, 2, 3]) {
    const d = Number(pa[k]) - Number(pb[k]);
    if (d !== 0) return d;
  }
  if (pa[4] === undefined || pb[4] === undefined)
    return pa[4] === pb[4] ? 0 : pa[4] === undefined ? 1 : -1;
  return pa[4].localeCompare(pb[4], undefined, { numeric: true });
}

/**
 * Why `version` cannot be released, or null: not CalVer, outside release.yml's
 * month window, not above every release tag, or not above the default
 * branch's package.json version.
 */
function versionProblem(
  runner: ReleaseCutRunner,
  cwd: string,
  version: string,
  ref: string,
): string | null {
  const m = CALVER.exec(version);
  if (!m) return `${version} is not CalVer vYYYY.M.N[-suffix]`;
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const [y, mo] = [Number(m[1]), Number(m[2])];
  const current = y === year && mo === month;
  if (m[4] === undefined ? !current : !current && !(y === next.year && mo === next.month)) {
    return `${version} is outside release.yml's CalVer window (${year}.${month}${m[4] === undefined ? '' : ` or ${next.year}.${next.month} for a prerelease`})`;
  }
  const newest = runner
    .runGit(['tag', '--list', 'v*'], cwd)
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => CALVER.test(t))
    .sort(compareCalVer)
    .at(-1);
  if (newest !== undefined && compareCalVer(version, newest) <= 0) {
    return `${version} is not above the newest release tag ${newest}`;
  }
  let manifest = '';
  try {
    manifest = runner.runGit(['show', `${ref}:package.json`], cwd);
  } catch {
    return null;
  }
  const base: { version?: string } = JSON.parse(manifest);
  if (base.version && compareCalVer(version, normalizeVersion(base.version)) <= 0) {
    return `${version} is not above package.json's ${base.version} on the default branch`;
  }
  return null;
}

/** Append one row to {@link RELEASE_CUT_AUDIT_FILE}; an audit failure never changes the result. */
function auditCut(cwd: string, row: Record<string, string | boolean | null>): void {
  try {
    const path = join(cwd, RELEASE_CUT_AUDIT_FILE);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, 'utf-8');
  } catch {
    // non-fatal: the GitHub tag is the release's own record
  }
}

/** Changeset paths added in `from..to` (top-level `.changeset/*.md`, README excluded). */
function changesetPathsInRange(
  runner: ReleaseCutRunner,
  cwd: string,
  from: string | null,
  to: string,
): string[] {
  const args = from
    ? ['diff', '--name-only', '--diff-filter=A', from, to, '--', '.changeset']
    : ['ls-tree', '-r', '--name-only', to, '--', '.changeset'];
  return runner
    .runGit(args, cwd)
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => /^\.changeset\/[^/]+\.md$/.test(p) && basename(p) !== 'README.md')
    .sort();
}

/** Parse the changesets as they are at `ref`, without touching the working tree. */
function parseChangesetsAt(
  runner: ReleaseCutRunner,
  cwd: string,
  ref: string,
  paths: readonly string[],
): ChangesetEntry[] {
  if (paths.length === 0) return [];
  const dir = mkdtempSync(join(tmpdir(), 'cleo-cut-changesets-'));
  try {
    for (const path of paths) {
      writeFileSync(join(dir, basename(path)), runner.runGit(['show', `${ref}:${path}`], cwd));
    }
    return parseChangesetDir(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Notes markdown: the lead, then the aggregated sections without their version header. */
function renderNotes(
  entries: ChangesetEntry[],
  version: string,
  date: string,
  lead: string,
): string {
  const body = aggregateChangesetsForRelease({ entries, version, date }).markdown.replace(
    /^\s*## [^\n]*\n+/,
    '',
  );
  return [lead.trim(), body.trim()].filter((part) => part.length > 0).join('\n\n');
}

function channelOf(version: string): string {
  return version.includes('-') ? 'prerelease' : 'latest';
}

/** Packages `release.yml` publishes (`publish_pkg <dir> [npmName]` lines, gate 9 SSoT). */
function publishedPackages(
  runner: ReleaseCutRunner,
  cwd: string,
  ref: string,
  version: string,
): ReleaseCutPackage[] {
  const workflow = runner.runGit(['show', `${ref}:.github/workflows/release.yml`], cwd);
  const packages: ReleaseCutPackage[] = [];
  for (const match of workflow.matchAll(/^\s*publish_pkg\s+([\w.-]+)(?:\s+(\S+))?\s*$/gm)) {
    const dir = match[1] ?? '';
    const manifest: { name?: string } = JSON.parse(
      runner.runGit(['show', `${ref}:packages/${dir}/package.json`], cwd),
    );
    packages.push({ dir, name: match[2] ?? manifest.name ?? dir, version });
  }
  return packages;
}

/**
 * Cut a release: tag the newest green default-branch commit and let
 * `release.yml` publish it. `dryRun` reports without tagging.
 *
 * @param opts - See {@link ReleaseCutOptions}.
 * @returns The chosen commit, notes, packages, migrations and task report.
 *
 * @example
 * ```ts
 * const preview = await releaseCut({ version: '2026.10.28', projectRoot, dryRun: true });
 * if (preview.success) console.log(preview.data.sha, preview.data.notes);
 * ```
 *
 * @task T14102
 */
export async function releaseCut(opts: ReleaseCutOptions): Promise<EngineResult<ReleaseCutResult>> {
  const runner = opts.runner ?? defaultRunner();
  // T14160: git work happens only in the invoking checkout; the store, audit
  // and grants belong to the project.
  const cwd = opts.gitRoot ?? opts.projectRoot;
  const storeRoot = opts.projectRoot;
  const version = normalizeVersion(opts.version);
  const bare = version.slice(1);
  const branch = opts.branch ?? 'main';
  // D11212: nothing is tagged without --yes; without it the cut is a preview.
  const dryRun = opts.dryRun === true || opts.yes !== true;

  try {
    runner.runGh(['auth', 'status'], cwd);
  } catch {
    return engineError(E_GH_NOT_AUTHENTICATED, 'gh is not installed or not authenticated', {
      exitCode: ExitCode.GENERAL_ERROR,
      fix: 'gh auth login',
    });
  }

  runner.runGit(['fetch', '--quiet', '--tags', 'origin', branch], cwd);
  const remoteTag = runner.runGit(['ls-remote', '--tags', 'origin', `refs/tags/${version}`], cwd);
  if (remoteTag.length > 0) {
    return engineError(E_INVALID_STATE, `Tag ${version} already exists on origin`, {
      exitCode: ExitCode.VALIDATION_ERROR,
      fix: `Pick the next version, or re-run the release workflow for ${version}: gh workflow run release.yml -f version=${bare}`,
      details: { tag: version },
    });
  }

  const badVersion = versionProblem(runner, cwd, version, `origin/${branch}`);
  if (badVersion !== null) {
    return engineError(E_INVALID_STATE, badVersion, {
      exitCode: ExitCode.VALIDATION_ERROR,
      fix: 'Pick a CalVer version for this month above the newest release tag',
      details: { version },
    });
  }

  // T14101: close what just merged, so the task report below is current.
  // The sweep runs gh and git in the project checkout; from another checkout
  // it is skipped and named, never run there (T14160).
  const sweep: MergeSweepResult =
    cwd === storeRoot
      ? await (opts.sweep ?? sweepMergedClosures)(storeRoot, { dryRun, force: true })
      : {
          swept: false,
          skippedReason: `cut runs in ${cwd}, not the project checkout ${storeRoot}; the merge sweep runs from the project checkout`,
          dryRun,
          prs: [],
          closed: [],
          bound: [],
          refused: [],
          waiting: 0,
          reran: 0,
        };

  const checks = requiredChecks(runner, cwd, `origin/${branch}`);
  const candidates: ReleaseCutCandidate[] = [];
  let sha: string | null = null;
  const pool = opts.sha
    ? [runner.runGit(['rev-parse', '--verify', `${opts.sha}^{commit}`], cwd).trim()]
    : runner
        .runGit(
          ['rev-list', '--first-parent', `--max-count=${CUT_MAX_CANDIDATES}`, `origin/${branch}`],
          cwd,
        )
        .split('\n')
        .filter((s) => s.length > 0);
  if (opts.sha && !isFirstParent(runner, cwd, pool[0] ?? '', branch)) {
    return engineError(
      E_INVALID_STATE,
      `${opts.sha} is not a first-parent commit of origin/${branch}`,
      {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix: `Pin a merge commit on origin/${branch} (git log --first-parent origin/${branch}), or omit --sha to take the newest green one`,
      },
    );
  }
  for (const candidate of pool) {
    const ci = requiredCiState(runner, cwd, candidate, branch, checks);
    candidates.push({ sha: candidate, ci });
    if (ci === 'success') {
      sha = candidate;
      break;
    }
  }
  if (sha === null) {
    return engineError(
      E_RELEASE_NO_GREEN_COMMIT,
      opts.sha
        ? `${opts.sha} is not green: ${candidates[0]?.ci ?? 'no checks'}`
        : `None of the last ${pool.length} first-parent commits of origin/${branch} has every required check green (${checks.map((c) => c.name).join(', ')})`,
      {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix: `Wait for the required checks to finish green on origin/${branch}, then re-run`,
        details: { candidates },
      },
    );
  }

  const previousTag = newestReachableReleaseTag(cwd, version, channelOf(version), sha);
  const paths = changesetPathsInRange(runner, cwd, previousTag, sha);

  // A changeset must arrive through a merged pull request: that is what makes
  // "green CI on the sha" the whole gate (D11209).
  const unmerged: Array<{ path: string; commit: string }> = [];
  for (const path of paths) {
    const commit = runner
      .runGit(
        [
          'log',
          '--diff-filter=A',
          '--format=%H',
          '-1',
          previousTag ? `${previousTag}..${sha}` : sha,
          '--',
          path,
        ],
        cwd,
      )
      .trim();
    const pulls: Array<{ merged_at: string | null }> = JSON.parse(
      runner.runGh(['api', `repos/{owner}/{repo}/commits/${commit}/pulls`], cwd),
    );
    if (!pulls.some((pr) => pr.merged_at !== null)) unmerged.push({ path, commit });
  }
  if (unmerged.length > 0) {
    return engineError(
      E_RELEASE_UNMERGED_CHANGESET,
      `${unmerged.length} changeset(s) did not arrive through a merged pull request: ${unmerged.map((u) => u.path).join(', ')}`,
      {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix: 'Land each changeset through a reviewed pull request, then re-run',
        details: { changesets: unmerged },
      },
    );
  }

  let entries: ChangesetEntry[];
  try {
    entries = parseChangesetsAt(runner, cwd, sha, paths);
  } catch (err) {
    return engineError(E_CHANGESET_YAML_INVALID, err instanceof Error ? err.message : String(err), {
      exitCode: ExitCode.VALIDATION_ERROR,
      fix: 'Run `node scripts/lint-changesets.mjs`, fix the entry on the default branch, then re-run',
    });
  }

  const lead = opts.leadFile ? readFileSync(opts.leadFile, 'utf-8') : '';
  const notes = renderNotes(entries, version, new Date().toISOString().slice(0, 10), lead);

  const migrations = runner
    .runGit(
      previousTag
        ? [
            'diff',
            '--name-only',
            '--diff-filter=A',
            previousTag,
            sha,
            '--',
            'packages/core/migrations',
          ]
        : ['ls-tree', '-r', '--name-only', sha, '--', 'packages/core/migrations'],
      cwd,
    )
    .split('\n')
    .filter((p) => p.length > 0);

  const taskIds = [...new Set(entries.flatMap((entry) => entry.tasks))].sort();
  const tasks: ReleaseCutTask[] = [];
  const accessor = await getTaskAccessor(storeRoot);
  try {
    for (const id of taskIds) {
      const task = await accessor.loadSingleTask(id);
      tasks.push({ id, status: task?.status ?? 'missing' });
    }
  } finally {
    await accessor.close();
  }

  // T14111: a release does not ship stale, duplicate or orphaned docs.
  // T14142: never fails the cut; an empty task set is skipped, because no
  // ids would widen the cleanup to every done task.
  const cleanupTasks = async (dry: boolean): Promise<MergedCleanupResult | null> => {
    if (taskIds.length === 0) return null;
    // The cleanup judges against the project checkout; from another checkout
    // it would run git there, so it is skipped and named instead (T14160).
    if (cwd !== storeRoot) {
      return {
        dryRun: dry,
        base: '',
        worktrees: [],
        localBranches: [],
        remoteBranches: [],
        nestedCopies: [],
        bytesReclaimed: 0,
        skippedReason: `cut runs in ${cwd}, not the project checkout ${storeRoot}; the merged-work cleanup runs from the project checkout`,
      };
    }
    try {
      return await (opts.cleanup ?? cleanupMergedWork)({ projectRoot: cwd, taskIds, dryRun: dry });
    } catch (err) {
      return {
        dryRun: dry,
        base: '',
        worktrees: [],
        localBranches: [],
        remoteBranches: [],
        nestedCopies: [],
        bytesReclaimed: 0,
        skippedReason: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const docsRot = scanDocsRot({ projectRoot: cwd });
  const rotFindings = docsRot.stale.length + docsRot.duplicates.length + docsRot.orphans.length;
  const checkoutAtMain =
    runner.runGit(['rev-parse', 'HEAD'], cwd).trim() ===
    runner.runGit(['rev-parse', `origin/${branch}`], cwd).trim();

  const result: ReleaseCutResult = {
    version,
    tag: version,
    sha,
    previousTag,
    candidates,
    changesets: paths,
    notes,
    packages: publishedPackages(runner, cwd, sha, bare),
    migrations,
    tasks,
    sweep,
    cleanup: dryRun ? await cleanupTasks(true) : null,
    docsRot,
    warnings:
      rotFindings > 0 && channelOf(version) !== 'latest'
        ? [`Docs rot (does not block a prerelease): ${docsRot.summary}`]
        : [],
    checkoutAtMain,
    confirmCommand: [
      'cleo release cut',
      version,
      `--sha ${sha}`,
      ...(opts.leadFile ? [`--lead ${resolve(opts.leadFile)}`] : []),
      '--yes',
    ].join(' '),
    dryRun,
    tagCreated: false,
  };
  if (dryRun) return engineSuccess(result);
  const refuse = (code: string, message: string, fix: string, details: Record<string, unknown>) => {
    auditCut(storeRoot, { version, sha, outcome: 'refused', code, reason: message });
    return engineError<ReleaseCutResult>(code, message, {
      exitCode: ExitCode.VALIDATION_ERROR,
      fix,
      details,
    });
  };
  if (!checkoutAtMain) {
    return refuse(
      E_INVALID_STATE,
      `The local checkout is not at origin/${branch}, and the docs-rot gate scans it`,
      `git switch ${branch} && git pull --ff-only, then re-run`,
      { branch },
    );
  }
  // A prerelease is a test release: docs rot warns there and blocks only stable.
  if (rotFindings > 0 && channelOf(version) === 'latest') {
    return refuse(
      E_DOCS_ROT,
      `Docs rot blocks the release: ${docsRot.summary}`,
      'cleo docs rot  (update the stale docs, merge the duplicates, fix or link the orphans), then re-run',
      { docsRot },
    );
  }
  // ADR-099 §2.5: CI is judged again right before the tag, never from an old read.
  const ciNow = requiredCiState(runner, cwd, sha, branch, checks);
  if (ciNow !== 'success') {
    return refuse(
      E_RELEASE_NO_GREEN_COMMIT,
      `${sha} is no longer green: ${ciNow}`,
      'Wait for the required checks on the default branch, then re-run',
      { sha, ci: ciNow },
    );
  }

  // D11212: a standing authorization (an agent), or the version typed on the
  // controlling terminal. Neither can be asserted by the caller.
  const authorization = await releaseAuthorizationFor(storeRoot, version, cwd);
  let allowedBy = authorization ? `authorization:${authorization.id}` : '';
  if (!authorization) {
    const typed = readTtyConfirmation(`Tag ${version} on ${sha}? Type ${version} to confirm: `);
    if (typed === null) {
      const neededScope =
        channelOf(version) === 'latest'
          ? 'stable'
          : /-canary\.\d+$/.test(version)
            ? 'canary'
            : 'prerelease';
      return refuse(
        E_RELEASE_NOT_AUTHORIZED,
        `No terminal to confirm ${version}, and no active standing release authorization covers scope ${neededScope} or ${version}`,
        `Run \`${result.confirmCommand}\` from a terminal, or ask the owner to grant one: cleo release authorize --scope ${neededScope} --expires 7d --reason "<why>"`,
        { version, sha, scope: neededScope },
      );
    }
    if (normalizeVersion(typed) !== version) {
      return refuse(
        E_RELEASE_NOT_AUTHORIZED,
        `The confirmation "${typed}" does not match ${version}`,
        `Re-run \`${result.confirmCommand}\` and type ${version} exactly`,
        { version, sha },
      );
    }
    allowedBy = 'tty-confirm';
  }

  // Created with the caller's token, the tag push triggers release.yml
  // (a GITHUB_TOKEN-created tag would not).
  let tagObject = '';
  try {
    const created: { sha: string } = JSON.parse(
      runner.runGh(
        [
          'api',
          '-X',
          'POST',
          'repos/{owner}/{repo}/git/tags',
          '-f',
          `tag=${version}`,
          '-f',
          `message=${[
            lead.trim() || `Release ${version}`,
            ...(authorization ? [`${AUTHORIZED_BY_TRAILER}: ${authorization.id}`] : []),
          ].join('\n\n')}`,
          '-f',
          `object=${sha}`,
          '-f',
          'type=commit',
        ],
        cwd,
      ),
    );
    tagObject = created.sha;
    runner.runGh(
      [
        'api',
        '-X',
        'POST',
        'repos/{owner}/{repo}/git/refs',
        '-f',
        `ref=refs/tags/${version}`,
        '-f',
        `sha=${tagObject}`,
      ],
      cwd,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    auditCut(storeRoot, { version, sha, outcome: 'failed', tagObject: tagObject || null, reason });
    return engineError(E_RELEASE_TAG_FAILED, `Creating tag ${version} failed: ${reason}`, {
      exitCode: ExitCode.GENERAL_ERROR,
      fix: tagObject
        ? `No refs/tags/${version} was created (the unreferenced tag object ${tagObject} is harmless); re-run the cut`
        : 're-run the cut',
      details: { sha, tagObject: tagObject || null },
    });
  }
  auditCut(storeRoot, { version, sha, outcome: 'tagged', tagObject, allowedBy });
  return engineSuccess({
    ...result,
    cleanup: await cleanupTasks(false),
    dryRun: false,
    confirmCommand: null,
    tagCreated: true,
  });
}

/** Result of {@link releaseVerifyTag}. */
export interface ReleaseVerifyTagResult {
  /** The tag checked. */
  tag: string;
  /** The commit it points at. */
  sha: string;
  /** Required checks that were green on its push run. */
  checks: string[];
}

/**
 * Refuse to publish a tag whose commit is not a first-parent commit of
 * `origin/<default>` with every required check green on its push run. Run by
 * `release.yml` before anything ships, so a hand-pushed tag or a dispatched
 * run never publishes an untested tree.
 *
 * @param opts - Version, project root, default branch, test seam.
 * @returns The tag, its commit and the checks found green.
 *
 * @example
 * ```ts
 * const ok = await releaseVerifyTag({ version: '2026.10.28', projectRoot: process.cwd() });
 * if (!ok.success) process.exit(1);
 * ```
 *
 * @task T14102
 */
export async function releaseVerifyTag(opts: {
  version: string;
  projectRoot: string;
  branch?: string;
  runner?: ReleaseCutRunner;
}): Promise<EngineResult<ReleaseVerifyTagResult>> {
  const runner = opts.runner ?? defaultRunner();
  const cwd = opts.projectRoot;
  const branch = opts.branch ?? 'main';
  const tag = normalizeVersion(opts.version);
  const sha = runner.runGit(['rev-parse', '--verify', `${tag}^{commit}`], cwd).trim();
  if (!isFirstParent(runner, cwd, sha, branch)) {
    return engineError(
      E_INVALID_STATE,
      `${tag} (${sha}) is not a first-parent commit of origin/${branch}`,
      {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix: `Delete the tag (git push origin :refs/tags/${tag}) and cut from origin/${branch}: cleo release cut ${tag}`,
        details: { tag, sha },
      },
    );
  }
  const checks = requiredChecks(runner, cwd, sha);
  const ci = requiredCiState(runner, cwd, sha, branch, checks);
  if (ci !== 'success') {
    return engineError(E_RELEASE_NO_GREEN_COMMIT, `${tag} (${sha}) is not green: ${ci}`, {
      exitCode: ExitCode.VALIDATION_ERROR,
      fix: `Wait for the required checks on ${sha}, then re-run this workflow; or delete the tag (git push origin :refs/tags/${tag})`,
      details: { tag, sha, ci },
    });
  }
  return engineSuccess({ tag, sha, checks: checks.map((c) => c.name) });
}

/**
 * Write the `## [<version>]` CHANGELOG section from the changesets added since
 * the previous release tag, led by the tag's annotation (the `--lead` the cut
 * recorded). Runs in `release.yml` on the tagged checkout. A section that
 * already exists (a plan-PR release) is left untouched.
 *
 * @param opts - See {@link ReleaseChangelogOptions}.
 * @returns Whether the section was written, and from what range.
 *
 * @example
 * ```ts
 * await releaseChangelog({ version: '2026.10.28', projectRoot: process.cwd() });
 * ```
 *
 * @task T14102
 */
export async function releaseChangelog(
  opts: ReleaseChangelogOptions,
): Promise<EngineResult<ReleaseChangelogResult>> {
  const runner = opts.runner ?? defaultRunner();
  const cwd = opts.projectRoot;
  const version = normalizeVersion(opts.version);
  const changelogPath = join(cwd, 'CHANGELOG.md');
  const tagRef = `refs/tags/${version}`;
  const tagged = runner.runGit(['tag', '--list', version], cwd).trim() === version;
  const ref = opts.ref ?? (tagged ? version : 'HEAD');
  const sha = runner.runGit(['rev-parse', '--verify', `${ref}^{commit}`], cwd).trim();
  const previousTag = newestReachableReleaseTag(cwd, version, channelOf(version), sha);

  let existing = '';
  try {
    existing = readFileSync(changelogPath, 'utf-8');
  } catch {
    existing = '';
  }
  const headerRe = new RegExp(
    `^## \\[${version.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`,
    'm',
  );
  if (headerRe.test(existing)) {
    return engineSuccess({ changelogPath, written: false, previousTag, changesetCount: 0 });
  }

  const paths = changesetPathsInRange(runner, cwd, previousTag, sha);
  let entries: ChangesetEntry[];
  try {
    entries = parseChangesetsAt(runner, cwd, sha, paths);
  } catch (err) {
    return engineError(E_CHANGESET_YAML_INVALID, err instanceof Error ? err.message : String(err), {
      exitCode: ExitCode.VALIDATION_ERROR,
      fix: 'Run `node scripts/lint-changesets.mjs`',
    });
  }
  // The tag message is the lead plus, for an authorized cut, its trailer (T14141).
  const lead = tagged
    ? runner
        .runGit(['tag', '--list', '--format=%(contents)', version], cwd)
        .replace(new RegExp(`^${AUTHORIZED_BY_TRAILER}: \\S+$`, 'm'), '')
    : '';
  const date = tagged
    ? runner.runGit(['for-each-ref', '--format=%(creatordate:short)', tagRef], cwd).trim()
    : new Date().toISOString().slice(0, 10);
  const notes = renderNotes(
    entries,
    version,
    date,
    lead.trim() === `Release ${version}` ? '' : lead,
  );
  const { written } = await writeChangelogSection({
    changelogPath,
    version,
    date,
    notesMarkdown: notes,
  });
  return engineSuccess({ changelogPath, written, previousTag, changesetCount: entries.length });
}
