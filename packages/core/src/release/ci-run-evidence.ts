/**
 * `ci-run:<runId>` evidence (T14149): a green run of
 * `.github/workflows/repeat-run.yml`, which runs one test file N times on the
 * default branch. It replaces the owner AC waiver for criteria that need a
 * heavy or repeated run the owner rule forbids locally.
 *
 * Validated only from GitHub, never from a file the agent supplies:
 *
 * - the run is this workflow, dispatched (`workflow_dispatch`) on the
 *   repository's default branch, and its latest attempt concluded `success`;
 * - its title names the test file and run count, and the run's uploaded
 *   `repeat-report` artifact agrees: the same file, count and commit, every
 *   run green (GitHub does not return dispatch inputs on the run);
 * - the test file is relevant: one the task changed, or one a criterion this
 *   write links names (by path or file name), so a trivial test repeated N
 *   times cannot stand for an unrelated criterion.
 *
 * That the run's commit contains the task's implemented work is checked with
 * the other bound runs (`boundHeadGapReason`). `cleo complete` re-reads the
 * run, and a newer attempt that is not green refuses it.
 *
 * @task T14149
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { EvidenceAtom } from '@cleocode/contracts';
import type { EvidenceRoots } from '../tasks/evidence.js';

/** A validated `ci-run:` atom. */
export type CiRunEvidenceAtom = Extract<EvidenceAtom, { kind: 'ci-run' }>;

/** The workflow whose runs `ci-run:` accepts. */
export const REPEAT_RUN_WORKFLOW = '.github/workflows/repeat-run.yml';

/** The artifact the workflow uploads. */
export const REPEAT_RUN_ARTIFACT = 'repeat-report';

/** The parts of a GitHub Actions run record a `ci-run:` atom judges. */
export interface CiRunRecord {
  readonly path: string;
  readonly event: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly attempt: number;
  readonly displayTitle: string;
  readonly defaultBranch: string;
}

/** The report `scripts/ci-repeat-run.mjs` uploads. */
export interface RepeatReport {
  readonly test: string;
  readonly runs: number;
  readonly sha: string | null;
  readonly iterations: ReadonlyArray<{
    readonly run: number;
    readonly exitCode: number | null;
    readonly numPassedTests: number;
    readonly numFailedTests: number;
  }>;
}

/** Inputs of {@link resolveCiRunEvidenceAtom}. */
export interface ResolveCiRunOptions {
  /** Task the atom is verified for. */
  readonly taskId: string;
  /** Repo-relative paths the task's change touches (declared files and implemented evidence). */
  readonly changedPaths: readonly string[];
  /** Text of the criteria this write links with `satisfies:`. */
  readonly criteriaTexts: readonly string[];
  /** The run's record; defaults to `gh api …/actions/runs/<id>`. */
  readonly fetchRun?: (runId: number, cwd: string) => CiRunRecord | null;
  /** The run's uploaded report; defaults to `gh run download`. */
  readonly fetchReport?: (runId: number, cwd: string) => RepeatReport | null;
}

/** A refusal. */
export interface CiRunRefusal {
  readonly ok: false;
  readonly reason: string;
  readonly codeName: 'E_EVIDENCE_INVALID' | 'E_EVIDENCE_TESTS_FAILED' | 'E_EVIDENCE_INSUFFICIENT';
}

/** `repeat-run <test> x<N>`, the workflow's `run-name`. */
const TITLE = /^repeat-run (\S+) x([0-9]+)$/;

/** Whether `record` is a finished, green run of the repeat-run workflow on the default branch. */
function runRefusal(runId: number, record: CiRunRecord): CiRunRefusal | null {
  const refuse = (reason: string, codeName: CiRunRefusal['codeName'] = 'E_EVIDENCE_INVALID') => ({
    ok: false as const,
    reason: `ci-run:${runId} ${reason}`,
    codeName,
  });
  if (record.path.replace(/@.*$/, '') !== REPEAT_RUN_WORKFLOW)
    return refuse(`is a run of ${record.path}, not ${REPEAT_RUN_WORKFLOW}`);
  if (record.event !== 'workflow_dispatch')
    return refuse(`was started by ${record.event}, not a workflow_dispatch`);
  if (record.headBranch !== record.defaultBranch)
    return refuse(
      `ran on ${record.headBranch}, not the default branch ${record.defaultBranch}; dispatch it on ${record.defaultBranch}`,
    );
  if (record.status !== 'completed')
    return refuse(`is still ${record.status}; wait for it to finish, then verify again`);
  if (record.conclusion !== 'success')
    return refuse(
      `attempt ${record.attempt} concluded ${record.conclusion ?? 'with no conclusion'}, not success`,
      // @sync-invariant none:input-shape a red repeat-run is refused before anything is written
      'E_EVIDENCE_TESTS_FAILED',
    );
  return null;
}

/**
 * Validate a `ci-run:<runId>` atom for a task (T14149).
 *
 * @param runId - The GitHub Actions run id.
 * @param roots - The evidence roots; `gh` runs in the execution root.
 * @param options - Task context and injected fetchers.
 * @returns The validated atom, or why it is refused.
 * @task T14149
 */
export async function resolveCiRunEvidenceAtom(
  runId: number,
  roots: EvidenceRoots,
  options: ResolveCiRunOptions,
): Promise<{ ok: true; atom: CiRunEvidenceAtom } | CiRunRefusal> {
  const cwd = roots.executionRoot;
  const record = (options.fetchRun ?? defaultFetchRun)(runId, cwd);
  if (record === null)
    return {
      ok: false,
      reason: `ci-run:${runId} cannot be read from GitHub (gh api actions/runs/${runId} failed)`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  const refused = runRefusal(runId, record);
  if (refused) return refused;
  const title = TITLE.exec(record.displayTitle);
  if (!title)
    return {
      ok: false,
      reason: `ci-run:${runId}'s title "${record.displayTitle}" does not name a test file and run count`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  const test = title[1]!;
  const runs = Number(title[2]);
  // GitHub does not return dispatch inputs on a run, so the title is
  // cross-checked against what the job itself recorded.
  const report = (options.fetchReport ?? defaultFetchReport)(runId, cwd);
  if (report === null)
    return {
      ok: false,
      reason: `ci-run:${runId} has no readable ${REPEAT_RUN_ARTIFACT} artifact (expired, or the job uploaded none), so its counts cannot be checked`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  const mismatch =
    report.test !== test
      ? `its report ran ${report.test}, but its title names ${test}`
      : report.runs !== runs
        ? `its report asked for ${report.runs} runs, but its title names ${runs}`
        : report.sha !== record.headSha
          ? `its report tested ${report.sha ?? 'an unknown commit'}, not the run's commit ${record.headSha}`
          : report.iterations.length !== runs
            ? `its report records ${report.iterations.length} runs, not ${runs}`
            : null;
  if (mismatch)
    return { ok: false, reason: `ci-run:${runId}: ${mismatch}`, codeName: 'E_EVIDENCE_INVALID' };
  const bad = report.iterations.find(
    (i) => i.exitCode !== 0 || i.numFailedTests > 0 || i.numPassedTests === 0,
  );
  if (bad)
    return {
      ok: false,
      reason: `ci-run:${runId}: run ${bad.run} of ${runs} did not pass (exit ${bad.exitCode}, ${bad.numFailedTests} failed, ${bad.numPassedTests} passed)`,
      // @sync-invariant none:input-shape a red repeat-run is refused before anything is written
      codeName: 'E_EVIDENCE_TESTS_FAILED',
    };
  // Relevance: the repeated file is part of the task's change, or a linked
  // criterion names it.
  const changed = options.changedPaths.map((p) => p.replace(/^\.\//, ''));
  const named = options.criteriaTexts.some(
    (text) => text.includes(test) || text.includes(basename(test)),
  );
  if (!changed.includes(test) && !named)
    return {
      ok: false,
      reason:
        `ci-run:${runId} repeated ${test}, which ${options.taskId} did not change and no criterion ` +
        `this write links (satisfies:${options.taskId}#AC<n>) names. Repeat the test that proves the ` +
        'criterion, or name its file in the criterion.',
      codeName: 'E_EVIDENCE_INSUFFICIENT',
    };
  return {
    ok: true,
    atom: {
      kind: 'ci-run',
      runId,
      headSha: record.headSha,
      test,
      runs,
      attempt: record.attempt,
      workflow: REPEAT_RUN_WORKFLOW,
      taskId: options.taskId,
    },
  };
}

/**
 * Re-check a recorded `ci-run:` atom at `cleo complete` (T14149): the run's
 * latest attempt must still be a green run of the workflow on the default
 * branch, at the same commit. A re-run that went red refuses.
 *
 * @param atom - The recorded atom.
 * @param cwd - Repository work tree for `gh`.
 * @param fetchRun - The run's record; defaults to the GitHub REST API.
 * @returns Ok, or why the atom no longer stands.
 * @task T14149
 */
export function recheckCiRunAtom(
  atom: CiRunEvidenceAtom,
  cwd: string,
  fetchRun: (runId: number, cwd: string) => CiRunRecord | null = defaultFetchRun,
): { ok: true } | { ok: false; reason: string } {
  const record = fetchRun(atom.runId, cwd);
  if (record === null)
    return { ok: false, reason: `ci-run:${atom.runId} cannot be re-read from GitHub` };
  const refused = runRefusal(atom.runId, record);
  if (refused) return { ok: false, reason: refused.reason };
  if (record.headSha !== atom.headSha)
    return {
      ok: false,
      reason: `ci-run:${atom.runId} now reports commit ${record.headSha}, not the recorded ${atom.headSha}`,
    };
  return { ok: true };
}

/** Run one `gh` command and parse its JSON output; null on any failure. */
function ghJson(args: readonly string[], cwd: string): unknown {
  try {
    return JSON.parse(
      execFileSync('gh', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30_000,
      }),
    );
  } catch {
    return null;
  }
}

/** Default {@link ResolveCiRunOptions.fetchRun}: `gh api repos/{owner}/{repo}/actions/runs/<id>`. */
function defaultFetchRun(runId: number, cwd: string): CiRunRecord | null {
  const run = ghJson(['api', `repos/{owner}/{repo}/actions/runs/${runId}`], cwd) as Record<
    string,
    unknown
  > | null;
  if (run === null || typeof run !== 'object') return null;
  const repository = run.repository as { default_branch?: unknown } | undefined;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    path: str(run.path),
    event: str(run.event),
    headBranch: str(run.head_branch),
    headSha: str(run.head_sha),
    status: str(run.status),
    conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
    attempt: typeof run.run_attempt === 'number' ? run.run_attempt : 1,
    displayTitle: str(run.display_title),
    defaultBranch: str(repository?.default_branch),
  };
}

/** Default {@link ResolveCiRunOptions.fetchReport}: `gh run download <id> -n repeat-report`. */
function defaultFetchReport(runId: number, cwd: string): RepeatReport | null {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-ci-run-'));
  try {
    execFileSync('gh', ['run', 'download', String(runId), '-n', REPEAT_RUN_ARTIFACT, '-D', dir], {
      cwd,
      stdio: 'ignore',
      timeout: 60_000,
    });
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'repeat-report.json'), 'utf-8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const r = parsed as Record<string, unknown>;
    if (typeof r.test !== 'string' || typeof r.runs !== 'number' || !Array.isArray(r.iterations))
      return null;
    return {
      test: r.test,
      runs: r.runs,
      sha: typeof r.sha === 'string' ? r.sha : null,
      iterations: r.iterations.map((raw: unknown) => {
        const i = (raw ?? {}) as Record<string, unknown>;
        return {
        run: typeof i.run === 'number' ? i.run : 0,
        exitCode: typeof i.exitCode === 'number' ? i.exitCode : null,
        numPassedTests: typeof i.numPassedTests === 'number' ? i.numPassedTests : 0,
        numFailedTests: typeof i.numFailedTests === 'number' ? i.numFailedTests : 0,
        };
      }),
    };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
