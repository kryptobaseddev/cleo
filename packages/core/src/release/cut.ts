/**
 * `cleo release cut <version>` — one-command release from the default branch's
 * newest commit with green CI (T14102 · epic T14099 · owner decision D11209).
 *
 * Replaces plan → open → bump-PR → hand-pushed tag. The cut:
 *   1. picks the newest first-parent commit of `origin/<default>` whose
 *      required `CI` check run concluded `success` (an empty conclusion is not
 *      green), or verifies a pinned `--sha`;
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ChangesetEntry, EngineResult } from '@cleocode/contracts';
import { engineError, engineSuccess } from '@cleocode/contracts/engine-result.js';
import {
  E_CHANGESET_YAML_INVALID,
  E_GH_NOT_AUTHENTICATED,
  E_INVALID_STATE,
  E_RELEASE_NO_GREEN_COMMIT,
  E_RELEASE_UNMERGED_CHANGESET,
  ExitCode,
} from '@cleocode/contracts/exit-codes.js';
import { eq } from 'drizzle-orm';
import { parseChangesetDir } from '../changesets/index.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getDb } from '../store/sqlite.js';
import * as schema from '../store/tasks-schema.js';
import { aggregateChangesetsForRelease } from './changesets-aggregator.js';
import { newestReachableReleaseTag, writeChangelogSection } from './plan.js';
import { releaseReconcileV2 } from './reconcile.js';
import { normalizeVersion } from './version.js';

/** How many first-parent commits of the default branch the cut inspects for green CI. */
export const CUT_MAX_CANDIDATES = 30;

/** The required check run whose `success` makes a commit releasable. */
export const CUT_CI_CHECK_NAME = 'CI';

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
  /** Git checkout of the project. */
  projectRoot: string;
  /** Pin the commit instead of picking the newest green one; it must itself be green. */
  sha?: string;
  /** Markdown file whose content leads the notes ("Update now" + Highlights). */
  leadFile?: string;
  /** Show the commit, notes, packages and tasks without creating the tag. */
  dryRun?: boolean;
  /** Default branch name (default `main`). */
  branch?: string;
  /** T14101 merge sweep, run before the commit is picked so the task report shows fresh closures. */
  sweep?: ReleaseCutSweep;
  /** Test seam. */
  runner?: ReleaseCutRunner;
}

/**
 * What the cut reads from T14101's merge sweep (`sweepMergedClosures`).
 *
 * shortcut: mirrors the fields of the coming contracts `MergeSweepResult`;
 * replace with that type when lane-e2's T14101 PR lands.
 */
export interface ReleaseCutSweepResult {
  /** False when the sweep was skipped (gh unavailable, offline). */
  swept: boolean;
  /** Why it was skipped. */
  skippedReason?: string;
  /** Task ids the sweep closed (or would close, under dry run). */
  closed: string[];
  /** Task ids bound by `Refs:` and left open. */
  bound: string[];
  /** Closures the sweep refused, with the reason. */
  refused: Array<{ taskId: string; prNumber: number; reason: string }>;
}

/** The T14101 merge sweep as the cut calls it. */
export type ReleaseCutSweep = (
  projectRoot: string,
  opts: { dryRun: boolean; force: boolean },
) => Promise<ReleaseCutSweepResult>;

/** CI state of one candidate commit. */
export interface ReleaseCutCandidate {
  /** Commit sha. */
  sha: string;
  /** `success`, another conclusion, `in_progress`/`queued`, or `none` (no CI check run). */
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
  /** The merge sweep run before the commit was picked, or null when none is wired. */
  sweep: ReleaseCutSweepResult | null;
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

/** Newest `CI` check run state on `sha` (`none` when there is none). */
function ciStateOf(runner: ReleaseCutRunner, cwd: string, sha: string): string {
  const raw = runner.runGh(
    [
      'api',
      `repos/{owner}/{repo}/commits/${sha}/check-runs?check_name=${CUT_CI_CHECK_NAME}&per_page=100`,
    ],
    cwd,
  );
  const parsed: { check_runs?: Array<{ id: number; status: string; conclusion: string | null }> } =
    JSON.parse(raw);
  const runs = [...(parsed.check_runs ?? [])].sort((a, b) => b.id - a.id);
  const newest = runs[0];
  if (newest === undefined) return 'none';
  if (newest.status !== 'completed') return newest.status;
  return newest.conclusion ?? 'none';
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
  const cwd = opts.projectRoot;
  const version = normalizeVersion(opts.version);
  const bare = version.slice(1);
  const branch = opts.branch ?? 'main';
  const dryRun = opts.dryRun === true;

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

  const sweep = opts.sweep ? await opts.sweep(cwd, { dryRun, force: true }) : null;

  const candidates: ReleaseCutCandidate[] = [];
  let sha: string | null = null;
  const pool = opts.sha
    ? [runner.runGit(['rev-parse', '--verify', `${opts.sha}^{commit}`], cwd)]
    : runner
        .runGit(
          ['rev-list', '--first-parent', `--max-count=${CUT_MAX_CANDIDATES}`, `origin/${branch}`],
          cwd,
        )
        .split('\n')
        .filter((s) => s.length > 0);
  if (opts.sha) {
    try {
      runner.runGit(['merge-base', '--is-ancestor', pool[0] ?? '', `origin/${branch}`], cwd);
    } catch {
      return engineError(E_INVALID_STATE, `${opts.sha} is not on origin/${branch}`, {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix: `Pin a commit of origin/${branch}, or omit --sha to take the newest green one`,
      });
    }
  }
  for (const candidate of pool) {
    const ci = ciStateOf(runner, cwd, candidate);
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
        ? `${opts.sha} has no successful ${CUT_CI_CHECK_NAME} check run`
        : `None of the last ${pool.length} commits of origin/${branch} has a successful ${CUT_CI_CHECK_NAME} check run`,
      {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix: `Wait for ${CUT_CI_CHECK_NAME} to finish green on origin/${branch}, then re-run`,
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
  } catch (err: unknown) {
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
  const accessor = await getTaskAccessor(cwd);
  try {
    for (const id of taskIds) {
      const task = await accessor.loadSingleTask(id);
      tasks.push({ id, status: task?.status ?? 'missing' });
    }
  } finally {
    await accessor.close();
  }

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
    dryRun,
    tagCreated: false,
  };
  if (dryRun) return engineSuccess(result);

  // Created with the caller's token, the tag push triggers release.yml
  // (a GITHUB_TOKEN-created tag would not).
  const tagObject: { sha: string } = JSON.parse(
    runner.runGh(
      [
        'api',
        '-X',
        'POST',
        'repos/{owner}/{repo}/git/tags',
        '-f',
        `tag=${version}`,
        '-f',
        `message=${lead.trim() || `Release ${version}`}`,
        '-f',
        `object=${sha}`,
        '-f',
        'type=commit',
      ],
      cwd,
    ),
  );
  runner.runGh(
    [
      'api',
      '-X',
      'POST',
      'repos/{owner}/{repo}/git/refs',
      '-f',
      `ref=refs/tags/${version}`,
      '-f',
      `sha=${tagObject.sha}`,
    ],
    cwd,
  );
  return engineSuccess({ ...result, tagCreated: true });
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
  } catch (err: unknown) {
    return engineError(E_CHANGESET_YAML_INVALID, err instanceof Error ? err.message : String(err), {
      exitCode: ExitCode.VALIDATION_ERROR,
      fix: 'Run `node scripts/lint-changesets.mjs`',
    });
  }
  const lead = tagged ? runner.runGit(['tag', '--list', '--format=%(contents)', version], cwd) : '';
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

/** Outcome of {@link reconcileLatestRelease}. */
export interface ReconcileLatestResult {
  /** Newest stable release tag on origin/main, or null when there is none. */
  version: string | null;
  /** What happened: reconciled now, already reconciled, not yet published, or no tag. */
  action: 'reconciled' | 'already' | 'unpublished' | 'none' | 'failed';
  /** Why reconcile failed, when `action` is `failed`. */
  reason?: string;
}

/**
 * Reconcile the newest published release when its provenance is missing, so
 * a cut release never depends on someone remembering `cleo release reconcile`.
 * Called from T14101's lazy merge sweep. Never throws.
 *
 * @param projectRoot - Git checkout and store of the project.
 * @param runner - Test seam.
 * @returns The tag looked at and what was done.
 *
 * @example
 * ```ts
 * const r = await reconcileLatestRelease(projectRoot);
 * if (r.action === 'reconciled') console.log(`provenance recorded for ${r.version}`);
 * ```
 *
 * @task T14102
 */
export async function reconcileLatestRelease(
  projectRoot: string,
  runner: ReleaseCutRunner = defaultRunner(),
): Promise<ReconcileLatestResult> {
  try {
    runner.runGit(['fetch', '--quiet', '--tags', 'origin'], projectRoot);
  } catch {
    // Offline: judge the tags already present.
  }
  const version = newestReachableReleaseTag(projectRoot, 'v9999.99.99', 'latest', 'origin/main');
  if (version === null) return { version: null, action: 'none' };
  const db = await getDb(projectRoot);
  const row = await db
    .select({ status: schema.releases.status })
    .from(schema.releases)
    .where(eq(schema.releases.version, version))
    .get();
  if (row?.status === 'reconciled') return { version, action: 'already' };
  try {
    runner.runGh(['release', 'view', version, '--json', 'tagName'], projectRoot);
  } catch {
    return { version, action: 'unpublished' };
  }
  const result = await releaseReconcileV2(version, { projectRoot });
  return result.success
    ? { version, action: 'reconciled' }
    : { version, action: 'failed', reason: result.error.message };
}
