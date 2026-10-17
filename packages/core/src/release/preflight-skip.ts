/**
 * Decide which `release-prepare.yml` preflight test suites a `cleo release open`
 * dispatch may skip, from CI results GitHub already holds for the SAME commit.
 *
 * `release-prepare` re-runs the full Linux test sweep on the commit it
 * checks out — main's HEAD — which is the commit main's own push CI has
 * already tested. When that push run is green, the release-prepare shards
 * prove nothing new and cost ~20 minutes of the release's critical path.
 * Likewise the macOS shards, which moved from every main push to nightly +
 * release: when the nightly macOS jobs for the exact commit are green, the
 * release has nothing left to learn from them.
 *
 * Every decision is forwarded to the workflow with ONE commit SHA, main's
 * HEAD, as `verified-sha`. The workflow honours a skip only when it checked
 * out that same commit, so a push to main between this check and the dispatch
 * cannot borrow a green result from a different tree. Any failure to answer —
 * `gh` error, timeout, unparseable output, no run, a run still in progress —
 * resolves to "run the tests", never to "skip".
 *
 * T13140: the release's own HEAD is usually the merge of the release-plan PR,
 * whose diff (the plan file, CHANGELOG.md, `.changeset/` moves) is not code.
 * Main's push CI for it is green but its `Detect Changes` gate skipped every
 * `Unit Tests` shard, so HEAD itself never carries a tested run, and every
 * release re-ran the whole suite. A test result is therefore borrowed from an
 * ANCESTOR whose tree is test-equivalent: walking first parents from HEAD,
 * each step is taken only past a RELEASE-PLAN commit (every file it changes
 * against its parent is under `.cleo/release/`, `.changeset/` or a
 * `CHANGELOG.md`, see {@link isReleasePlanPath}) whose push run is green,
 * whose `Detect Changes` job succeeded and whose every `Unit Tests` job was
 * skipped, until a commit whose push run ran every Linux shard green. The
 * changes gate's verdict alone is not trusted for a step: unit tests also read
 * repo files outside its `code` filter, and this preflight was their backstop.
 * The walk is bounded by {@link MAX_EQUIVALENT_ANCESTORS}, the whole decision
 * by {@link PREFLIGHT_DEADLINE_MS}, and the commits it took are named in the
 * reason. For macOS, the NEWEST completed `push` or `schedule` run with macOS
 * jobs (ci.yml or T13143's main-push workflow, {@link MACOS_WORKFLOWS}) of any
 * commit on that walk decides.
 *
 * T13823: `cleo release open` usually runs seconds after the release-plan PR
 * merges, while main's push CI for that very commit is still queued. With
 * {@link PreflightSkipOptions.inFlightWaitMs} set, a queued or in-progress
 * push run is polled until it completes (bounded) instead of being read as
 * "run the tests". The run that proved the Linux shards is returned as
 * {@link PreflightSkipDecision.testedRunId} and forwarded as `reused-ci-run`,
 * which `release-prepare` re-verifies before it skips anything. Job lists are
 * read page by page: a ci.yml run that ran its shards has more than 100 jobs.
 *
 * Each `gh` call is bounded by {@link PREFLIGHT_CHECK_TIMEOUT_MS}.
 *
 * @task release-speed
 */

import { execFileSync } from 'node:child_process';

/** Timeout for each `gh` call made while deciding preflight skips (ms). */
export const PREFLIGHT_CHECK_TIMEOUT_MS = 15_000;

/** Workflow file whose `push` run on main carries the Linux test shards. */
export const MAIN_CI_WORKFLOW = 'ci.yml' as const;

/** Most runs whose jobs are inspected for macOS results (bounds `gh` calls). */
const MAX_MACOS_CANDIDATE_RUNS = 5;

/**
 * Most first-parent steps taken from HEAD to a commit whose push CI tested the
 * tree (each step through a push run CI judged test-irrelevant). Bounds `gh`
 * calls; a longer run of non-code commits simply runs the tests.
 */
export const MAX_EQUIVALENT_ANCESTORS = 10;

/** The `ci.yml` job that decides whether a push changed anything the tests read. */
const CHANGES_JOB = 'Detect Changes';

/**
 * Overall budget for every `gh` call one decision makes (ms). A slow API can
 * otherwise block `cleo release open` for minutes; whatever is left when it
 * runs out resolves to "run the tests".
 */
export const PREFLIGHT_DEADLINE_MS = 60_000;

/**
 * How long `cleo release open` waits for a queued or in-progress push run of
 * {@link MAIN_CI_WORKFLOW} to finish before deciding (ms). Main CI for a
 * release-plan merge takes about 4 minutes; the preflight shards it can spare
 * take about 13 (T13823).
 */
export const PREFLIGHT_IN_FLIGHT_WAIT_MS = 10 * 60_000;

/** Poll interval while waiting for an in-flight push run (ms). */
export const PREFLIGHT_IN_FLIGHT_POLL_MS = 30_000;

/** Most pages of 100 jobs read for one run (a run listing more jobs is unreadable). */
const MAX_JOB_PAGES = 3;

/** Workflows whose `push`/`schedule` runs carry macOS test jobs (T13143's main-push workflow too). */
export const MACOS_WORKFLOWS: readonly string[] = ['ci.yml', 'macos-main.yml'];

/** The compare API lists at most this many files; a list that long may be truncated. */
const MAX_COMPARE_FILES = 300;

/** Options for {@link decidePreflightSkips}. */
export interface PreflightSkipOptions {
  /** Overall budget (default {@link PREFLIGHT_DEADLINE_MS}). */
  deadlineMs?: number;
  /** Clock (tests). */
  now?: () => number;
  /**
   * Commits from `from` to `to` (T13187: how far the newest green macOS commit
   * is behind HEAD); defaults to `git rev-list --count` in `cwd`, null when unknown.
   */
  commitsBehind?: (from: string, to: string, cwd: string) => number | null;
  /**
   * T13823: how long to wait for a queued or in-progress push run to complete
   * (default 0: an unfinished run means the tests run). Waiting time does not
   * count against {@link deadlineMs}.
   */
  inFlightWaitMs?: number;
  /** Blocks for `ms` (tests); defaults to a synchronous sleep. */
  sleep?: (ms: number) => void;
}

/** Blocks the thread for `ms` (the decision is synchronous, like its `gh` calls). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A path a release-plan PR changes: the plan file, a changelog, a changeset.
 * Nothing a test reads (T13140 review).
 */
export function isReleasePlanPath(path: string): boolean {
  return (
    path.startsWith('.cleo/release/') ||
    path.startsWith('.changeset/') ||
    path === 'CHANGELOG.md' ||
    path.endsWith('/CHANGELOG.md')
  );
}

/** The files `commit` changes against `parent`, or `null` when unknown or possibly truncated. */
function changedFiles(
  gh: (args: readonly string[]) => string | null,
  parent: string,
  commit: string,
): string[] | null {
  const raw = gh([
    'api',
    `repos/{owner}/{repo}/compare/${parent}...${commit}`,
    '--jq',
    // A rename lists its old path too: a code file renamed into .changeset/
    // is not a release-plan change (T13140 review).
    '[.files[] | .filename, (.previous_filename // empty)]',
  ]);
  const parsed = raw === null ? null : parseJson(raw);
  if (!Array.isArray(parsed) || !parsed.every((f): f is string => typeof f === 'string'))
    return null;
  return parsed.length >= MAX_COMPARE_FILES ? null : parsed;
}

/**
 * Runs `gh <args>` in `cwd` with a timeout and returns stdout. Throws on a
 * non-zero exit or timeout.
 */
export type PreflightGhRunner = (args: readonly string[], cwd: string, timeoutMs: number) => string;

/**
 * The outcome of {@link decidePreflightSkips}, forwarded to the workflow and
 * returned in the `cleo release open` result.
 */
export interface PreflightSkipDecision {
  /** Commit the decisions hold for and are forwarded with (main's HEAD), or `null` if unresolved. */
  verifiedSha: string | null;
  /**
   * True iff main's push CI ran every Linux Unit Tests shard green for
   * {@link verifiedSha}, or for {@link testedSha}, an ancestor CI judged
   * test-equivalent (T13140).
   */
  skipTests: boolean;
  /**
   * The commit whose push run proved the Linux shards: {@link verifiedSha}
   * itself, an equivalent ancestor, or `null` when the tests run.
   */
  testedSha: string | null;
  /**
   * T13823: id of the {@link MAIN_CI_WORKFLOW} push run that proved the Linux
   * shards for {@link testedSha}, forwarded as `reused-ci-run`; `null` when the tests run.
   */
  testedRunId: number | null;
  /** True iff every macOS job of a nightly (or push) run for {@link verifiedSha} or an equivalent ancestor succeeded. */
  skipMacosTests: boolean;
  /** Human-readable account of both decisions (lands in the run summary). */
  reason: string;
}

/** A workflow run as returned by the GitHub Actions REST API (fields we read). */
interface WorkflowRunSummary {
  id: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  event: string;
  url: string;
  /** Workflow file (`.github/workflows/ci.yml`), or `''`. */
  path: string;
}

/** A job as returned by `GET /actions/runs/{id}/jobs` (fields we read). */
interface JobSummary {
  name: string;
  conclusion: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Extract `workflow_runs[]` from a runs-list response, dropping malformed rows. */
function parseRuns(raw: string): WorkflowRunSummary[] {
  const body = parseJson(raw);
  if (!isRecord(body) || !Array.isArray(body['workflow_runs'])) return [];
  const runs: WorkflowRunSummary[] = [];
  for (const row of body['workflow_runs']) {
    if (!isRecord(row)) continue;
    const { id, head_sha, status, conclusion, event, html_url, path } = row;
    if (typeof id !== 'number' || typeof head_sha !== 'string' || typeof status !== 'string') {
      continue;
    }
    runs.push({
      id,
      headSha: head_sha,
      status,
      conclusion: typeof conclusion === 'string' ? conclusion : null,
      event: typeof event === 'string' ? event : '',
      url: typeof html_url === 'string' ? html_url : `run ${id}`,
      path: typeof path === 'string' ? path : '',
    });
  }
  // Newest first: a re-run or a later attempt supersedes an earlier result.
  return runs.sort((a, b) => b.id - a.id);
}

/**
 * Read every job of run `id`, page by page, dropping malformed rows.
 *
 * Returns `null` when a page cannot be read or is not a jobs page, or when the
 * pages read (at most {@link MAX_JOB_PAGES}) hold fewer jobs than
 * `total_count`, so a caller can never judge a run from a partial job list.
 * T13823: a ci.yml run that ran its unit-test shards lists 102-104 jobs, so a
 * single `per_page=100` page made every such run unreadable.
 */
function fetchJobs(
  gh: (args: readonly string[]) => string | null,
  id: number,
): JobSummary[] | null {
  const jobs: JobSummary[] = [];
  let rows = 0;
  for (let page = 1; page <= MAX_JOB_PAGES; page++) {
    const raw = gh([
      'api',
      `repos/{owner}/{repo}/actions/runs/${id}/jobs?per_page=100&page=${page}`,
    ]);
    const body = raw === null ? null : parseJson(raw);
    if (!isRecord(body) || !Array.isArray(body['jobs'])) return null;
    rows += body['jobs'].length;
    for (const row of body['jobs']) {
      if (!isRecord(row) || typeof row['name'] !== 'string') continue;
      const conclusion = row['conclusion'];
      jobs.push({
        name: row['name'],
        conclusion: typeof conclusion === 'string' ? conclusion : null,
      });
    }
    const total = body['total_count'];
    if (typeof total !== 'number' || rows >= total) return jobs;
    if (body['jobs'].length === 0) return null;
  }
  return null;
}

/** A `Unit Tests (<os>, shard <n>)` job from {@link MAIN_CI_WORKFLOW}, any OS. */
function isUnitTestJob(name: string): boolean {
  return /^Unit Tests\b/.test(name);
}

/**
 * The newest successful run among per-workflow listings of macOS verdicts
 * (T13187): the main-push macOS workflow's runs, and ci.yml's nightly
 * `schedule` runs. A ci.yml push run is Linux-only, so it is never listed.
 * One listing per workflow, so a busy day of other workflows' runs cannot
 * push the macOS run off the page (T13187 review).
 *
 * @param raws - `GET /actions/workflows/<file>/runs?...&status=success` bodies, or null.
 * @returns The newest run, or undefined when none is listed.
 */
function newestGreenMacosRun(raws: ReadonlyArray<string | null>): WorkflowRunSummary | undefined {
  return raws
    .flatMap((raw) => (raw === null ? [] : parseRuns(raw)))
    .filter((run) => run.conclusion === 'success')
    .sort((a, b) => b.id - a.id)[0];
}

/**
 * Commits between `from` and `to` in the local clone (`git rev-list --count`),
 * or null when either is not in local history.
 */
function defaultCommitsBehind(from: string, to: string, cwd: string): number | null {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${from}..${to}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    return /^\d+$/.test(out) ? Number(out) : null;
  } catch {
    return null;
  }
}

/** A job that ran the test suite on macOS, by the name GitHub renders for it. */
function isMacosJob(name: string): boolean {
  return /mac\s*os/i.test(name);
}

/**
 * Judge whether a run's Linux `Unit Tests` shards prove the tree was tested.
 * Returns `null` when they do, otherwise why not (for the run summary).
 *
 * Requires at least one Linux shard, every one concluded `success`, and the
 * shard numbers form the complete set `1..N` (a missing shard is not a pass).
 */
function judgeLinuxUnitTests(jobs: JobSummary[] | null): string | null {
  if (jobs === null) return 'its job list could not be read';
  const linux = jobs.filter((j) => isUnitTestJob(j.name) && !isMacosJob(j.name));
  if (linux.length === 0) return 'it ran no Linux Unit Tests jobs';
  const notGreen = linux.filter((j) => j.conclusion !== 'success');
  if (notGreen.length > 0) {
    return `${notGreen.length} Linux Unit Tests job(s) did not succeed (${notGreen
      .map((j) => `${j.name}: ${j.conclusion ?? 'no conclusion'}`)
      .join(', ')})`;
  }
  const shards = new Set<number>();
  for (const job of linux) {
    const match = /shard\s+(\d+)/i.exec(job.name);
    if (match === null) return `Linux job "${job.name}" names no shard`;
    shards.add(Number(match[1]));
  }
  const max = Math.max(...shards);
  for (let n = 1; n <= max; n++) {
    if (!shards.has(n)) return `Linux Unit Tests shard ${n} of ${max} is missing`;
  }
  return null;
}

/**
 * Whether CI itself judged a green push run test-irrelevant: its
 * `Detect Changes` job succeeded and every `Unit Tests` job it lists (the
 * gated-off matrix renders as one skipped job) was skipped.
 */
function unitTestsGatedOff(jobs: JobSummary[] | null): boolean {
  if (jobs === null) return false;
  const changes = jobs.find((j) => j.name === CHANGES_JOB);
  const unit = jobs.filter((j) => isUnitTestJob(j.name));
  return (
    changes?.conclusion === 'success' &&
    unit.length > 0 &&
    unit.every((j) => j.conclusion === 'skipped')
  );
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/**
 * Check GitHub for CI results on the dispatch branch's HEAD and decide which
 * `release-prepare` preflight test suites may be skipped.
 *
 * - Linux: skipped iff the newest `push` run of {@link MAIN_CI_WORKFLOW} on
 *   `branch` for HEAD's SHA is `completed` + `success` AND its Linux
 *   `Unit Tests` jobs exist, cover shards `1..N`, and all succeeded. A green
 *   run whose tests CI gated off (`Detect Changes` succeeded and every
 *   `Unit Tests` job was skipped) of a release-plan commit does not qualify by
 *   itself; the same check then runs on its first parent, up to
 *   {@link MAX_EQUIVALENT_ANCESTORS} steps (T13140).
 * - macOS: skipped iff the newest completed `schedule` or `push` run with
 *   macOS jobs, of HEAD or a commit that walk took, has every macOS job
 *   concluded `success`.
 *
 * Never throws: any error, or the {@link PREFLIGHT_DEADLINE_MS} budget running
 * out, resolves to running the suite.
 *
 * @param runGh - bounded `gh` runner (see {@link PreflightGhRunner})
 * @param cwd - repository checkout the `gh` calls resolve `{owner}/{repo}` from
 * @param branch - the branch `workflow_dispatch` checks out (the default branch)
 * @param options - overall budget and clock (tests)
 * @returns the decision, including the SHA it is valid for
 *
 * @example
 * ```ts
 * const decision = decidePreflightSkips(runGh, projectRoot, 'main');
 * if (decision.skipTests) fields.push('--field', 'skip-tests=true');
 * ```
 */
export function decidePreflightSkips(
  runGh: PreflightGhRunner,
  cwd: string,
  branch: string,
  options: PreflightSkipOptions = {},
): PreflightSkipDecision {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepSync;
  const waitBudget = options.inFlightWaitMs ?? 0;
  /** Time spent waiting on in-flight runs, which extends the `gh` budget. */
  let waited = 0;
  const deadline = now() + (options.deadlineMs ?? PREFLIGHT_DEADLINE_MS);
  let timedOut = false;
  const gh = (args: readonly string[]): string | null => {
    const left = deadline + waited - now();
    if (left <= 0) {
      timedOut = true;
      return null;
    }
    try {
      return runGh(args, cwd, Math.min(PREFLIGHT_CHECK_TIMEOUT_MS, left));
    } catch {
      return null;
    }
  };
  const outOfTime = `the ${PREFLIGHT_DEADLINE_MS / 1000}s budget for these checks ran out`;

  const shaRaw = gh(['api', `repos/{owner}/{repo}/commits/${branch}`, '--jq', '.sha']);
  const sha = shaRaw?.trim() ?? '';
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return {
      verifiedSha: null,
      skipTests: false,
      testedSha: null,
      testedRunId: null,
      skipMacosTests: false,
      reason: `Could not resolve the HEAD of ${branch} via gh; running every preflight suite.`,
    };
  }

  // ── Linux: main's push CI for HEAD, or for an ancestor CI judged equivalent ──
  const pushRunFor = (
    commit: string,
  ): { ok: true; run: WorkflowRunSummary | undefined } | { ok: false } => {
    const raw = gh([
      'api',
      `repos/{owner}/{repo}/actions/workflows/${MAIN_CI_WORKFLOW}/runs?head_sha=${commit}&event=push&branch=${branch}&per_page=20`,
    ]);
    if (raw === null) return { ok: false };
    return { ok: true, run: parseRuns(raw).find((r) => r.headSha === commit) };
  };
  /** Commits whose tree is test-equivalent to HEAD's, HEAD first. */
  const equivalent: string[] = [sha];
  let skipTests = false;
  let testedSha: string | null = null;
  let testedRunId: number | null = null;
  let linuxReason = '';
  let cur = sha;
  for (;;) {
    const at = cur === sha ? shortSha(sha) : `${shortSha(cur)} (an ancestor of ${shortSha(sha)})`;
    let found = pushRunFor(cur);
    // T13823: a run still queued or in progress is waited for, within budget.
    while (
      found.ok &&
      found.run !== undefined &&
      found.run.status !== 'completed' &&
      waited < waitBudget
    ) {
      const pause = Math.min(PREFLIGHT_IN_FLIGHT_POLL_MS, waitBudget - waited);
      const before = now();
      sleep(pause);
      waited += Math.max(now() - before, pause);
      found = pushRunFor(cur);
    }
    if (!found.ok) {
      linuxReason = `Linux tests run: ${timedOut ? outOfTime : `could not query ${MAIN_CI_WORKFLOW} runs for ${at}`}.`;
      break;
    }
    const pushRun = found.run;
    if (pushRun === undefined) {
      linuxReason = `Linux tests run: no ${MAIN_CI_WORKFLOW} push run on ${branch} for ${at}.`;
      break;
    }
    if (pushRun.status !== 'completed') {
      linuxReason = `Linux tests run: ${MAIN_CI_WORKFLOW} push run for ${at} is ${pushRun.status} (${pushRun.url})${waitBudget > 0 ? ` after waiting ${Math.round(waited / 1000)}s` : ''}.`;
      break;
    }
    if (pushRun.conclusion !== 'success') {
      linuxReason = `Linux tests run: ${MAIN_CI_WORKFLOW} push run for ${at} concluded ${pushRun.conclusion ?? 'without a conclusion'} (${pushRun.url}).`;
      break;
    }
    // A green run is not a tested run: a docs-only push skips `Unit Tests`
    // (the `changes` gate) and still concludes `success`. Only green Linux
    // `Unit Tests` jobs — every shard present and successful — prove the
    // tree was tested.
    const jobs = fetchJobs(gh, pushRun.id);
    const verdict = judgeLinuxUnitTests(jobs);
    if (verdict === null) {
      skipTests = true;
      testedSha = cur;
      testedRunId = pushRun.id;
      const via =
        cur === sha
          ? ''
          : ` ${shortSha(sha)} differs from it only by ${equivalent.length - 1} release-plan commit(s) whose push CI ran no Unit Tests (${equivalent
              .slice(0, -1)
              .map(shortSha)
              .join(', ')}).`;
      linuxReason = `Linux tests skipped: every Linux Unit Tests shard of the ${MAIN_CI_WORKFLOW} push run for ${at} is green (${pushRun.url}).${via}`;
      break;
    }
    if (!unitTestsGatedOff(jobs)) {
      linuxReason = `Linux tests run: ${MAIN_CI_WORKFLOW} push run for ${at} is green but ${verdict} (${pushRun.url}).`;
      break;
    }
    if (equivalent.length > MAX_EQUIVALENT_ANCESTORS) {
      linuxReason = `Linux tests run: no tested ${MAIN_CI_WORKFLOW} push run within ${MAX_EQUIVALENT_ANCESTORS} release-plan commits of ${shortSha(sha)}.`;
      break;
    }
    const parentRaw = gh(['api', `repos/{owner}/{repo}/commits/${cur}`, '--jq', '.parents[0].sha']);
    const parent = parentRaw?.trim() ?? '';
    if (!/^[0-9a-f]{40}$/.test(parent) || equivalent.includes(parent)) {
      linuxReason = `Linux tests run: ${timedOut ? outOfTime : `${MAIN_CI_WORKFLOW} push run for ${at} ran no Unit Tests, and its parent commit could not be resolved`}.`;
      break;
    }
    // T13140 review: a step is taken only past a release-plan commit. The
    // changes gate's verdict alone is not enough: unit tests also read repo
    // files outside its `code` filter, and this preflight was their backstop.
    const files = changedFiles(gh, parent, cur);
    if (files === null) {
      linuxReason = `Linux tests run: ${timedOut ? outOfTime : `the files ${at} changes could not be listed (or there are too many)`}.`;
      break;
    }
    const other = files.find((f) => !isReleasePlanPath(f));
    if (other !== undefined || files.length === 0) {
      linuxReason = `Linux tests run: ${MAIN_CI_WORKFLOW} push run for ${at} ran no Unit Tests, but ${at} is not a release-plan commit (${other ?? 'it changes no file'}), so its tree is not borrowed from an older run.`;
      break;
    }
    equivalent.push(parent);
    cur = parent;
  }

  // ── macOS: the NEWEST completed run with macOS jobs, of any equivalent commit ──
  const candidates: WorkflowRunSummary[] = [];
  for (const commit of equivalent) {
    const raw = gh(['api', `repos/{owner}/{repo}/actions/runs?head_sha=${commit}&per_page=50`]);
    if (raw === null) continue;
    for (const run of parseRuns(raw)) {
      if (
        run.headSha === commit &&
        run.status === 'completed' &&
        (run.event === 'schedule' || run.event === 'push') &&
        MACOS_WORKFLOWS.some((w) => run.path.endsWith(`/${w}`))
      )
        candidates.push(run);
    }
  }
  // Newest first: a later failure outranks an older pass of an equivalent tree.
  candidates.sort((a, b) => b.id - a.id);
  let skipMacosTests = false;
  let macosReason = `macOS tests run: ${timedOut ? outOfTime : `no completed run with macOS jobs for ${shortSha(sha)}${equivalent.length > 1 ? ` or the ${equivalent.length - 1} equivalent ancestor(s)` : ''}`}.`;
  for (const run of candidates.slice(0, MAX_MACOS_CANDIDATE_RUNS)) {
    const jobs = fetchJobs(gh, run.id);
    if (jobs === null) continue;
    const macosJobs = jobs.filter((j) => isMacosJob(j.name));
    if (macosJobs.length === 0) continue;
    const failed = macosJobs.filter((j) => j.conclusion !== 'success');
    if (failed.length === 0) {
      skipMacosTests = true;
      macosReason = `macOS tests skipped: all ${macosJobs.length} macOS job(s) of the newest ${run.event} run for ${shortSha(run.headSha)} are green (${run.url}).`;
    } else {
      macosReason = `macOS tests run: ${failed.length} macOS job(s) of the newest ${run.event} run for ${shortSha(run.headSha)} did not succeed (${run.url}).`;
    }
    break;
  }
  // T13187: when the shards run, name the newest main commit that does have a
  // green macOS run, so the operator can see how far behind it is (or tag that
  // commit's equivalent instead of waiting).
  if (!skipMacosTests && !timedOut) {
    const green = newestGreenMacosRun([
      gh([
        'api',
        `repos/{owner}/{repo}/actions/workflows/macos-main.yml/runs?branch=${branch}&status=success&per_page=1`,
      ]),
      gh([
        'api',
        `repos/{owner}/{repo}/actions/workflows/${MAIN_CI_WORKFLOW}/runs?branch=${branch}&event=schedule&status=success&per_page=1`,
      ]),
    ]);
    if (green) {
      const behind = (options.commitsBehind ?? defaultCommitsBehind)(green.headSha, sha, cwd);
      macosReason += ` Newest ${branch} commit with a green macOS run: ${shortSha(green.headSha)}${behind === null ? '' : `, ${behind} commit(s) behind ${shortSha(sha)}`} (${green.url}).`;
    } else {
      macosReason += ` No recent green macOS run on ${branch} was found.`;
    }
  }

  return {
    verifiedSha: sha,
    skipTests,
    testedSha,
    testedRunId,
    skipMacosTests,
    reason: `${linuxReason} ${macosReason}`,
  };
}

/**
 * Carry a default-branch decision over to a release-plan branch (T13825).
 *
 * The single release PR dispatches `release-prepare` on `release/plan-<v>`,
 * a branch holding one commit on top of the default branch's HEAD: the plan
 * file and CHANGELOG.md. The workflow honours skips only for the commit it
 * checks out, so the decision is re-keyed to `refSha` — and its skips are kept
 * only when GitHub's compare shows `refSha` strictly ahead of
 * `decision.verifiedSha` by release-plan paths alone ({@link isReleasePlanPath}).
 * Anything else, or a failed compare, keeps `refSha` and drops every skip.
 *
 * @param decision - {@link decidePreflightSkips} for the default branch
 * @param runGh - bounded `gh` runner
 * @param cwd - repository checkout the `gh` calls resolve `{owner}/{repo}` from
 * @param ref - the plan branch name (for the reason)
 * @param refSha - the plan branch's HEAD commit
 * @returns the decision, valid for `refSha`
 */
export function retargetPreflightSkips(
  decision: PreflightSkipDecision,
  runGh: PreflightGhRunner,
  cwd: string,
  ref: string,
  refSha: string,
): PreflightSkipDecision {
  const drop = (why: string): PreflightSkipDecision => ({
    verifiedSha: refSha,
    skipTests: false,
    testedSha: null,
    testedRunId: null,
    skipMacosTests: false,
    reason: `Every preflight suite runs on ${ref} (${shortSha(refSha)}): ${why}`,
  });
  if (decision.verifiedSha === null) return drop(decision.reason);
  if (!decision.skipTests && !decision.skipMacosTests) return { ...decision, verifiedSha: refSha };
  let body: unknown = null;
  try {
    body = parseJson(
      runGh(
        [
          'api',
          `repos/{owner}/{repo}/compare/${decision.verifiedSha}...${refSha}`,
          '--jq',
          '{status: .status, files: [.files[] | .filename, (.previous_filename // empty)]}',
        ],
        cwd,
        PREFLIGHT_CHECK_TIMEOUT_MS,
      ),
    );
  } catch {
    return drop(`the compare to ${shortSha(decision.verifiedSha)} failed.`);
  }
  const files = isRecord(body) && Array.isArray(body['files']) ? body['files'] : null;
  if (
    !isRecord(body) ||
    body['status'] !== 'ahead' ||
    files === null ||
    files.length === 0 ||
    files.length >= MAX_COMPARE_FILES ||
    !files.every((f): f is string => typeof f === 'string' && isReleasePlanPath(f))
  ) {
    return drop(
      `it is not ${shortSha(decision.verifiedSha)} plus release-plan files only, so the default branch's results do not carry over.`,
    );
  }
  return {
    ...decision,
    verifiedSha: refSha,
    reason: `${decision.reason} ${ref} (${shortSha(refSha)}) adds only release-plan files to ${shortSha(decision.verifiedSha)}, so these results carry over.`,
  };
}
