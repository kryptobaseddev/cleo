/**
 * `cleo release open` — Phase 3 verb of the new release pipeline.
 *
 * Consumes the plan file at `.cleo/release/<version>.plan.json` (written by
 * {@link releasePlan} in T9525) and dispatches the `release-prepare.yml`
 * GitHub Actions workflow via `gh workflow run`. UPDATEs the `releases`
 * row's `status` to `pr-opened` and persists the resolved workflow run URL
 * into `releases.workflow_run_url`.
 *
 * This verb is **side-effectful** — it shells out to `gh` and writes one
 * row to the `releases` table. It does NOT push commits, mutate any
 * source files, or invoke npm/cargo publish.
 *
 * Implements SPEC-T9345 §4.3 (R-050 through R-071):
 *
 *   - R-050 .. R-053 — pre-condition gates (plan exists, releases status,
 *     gh auth, workflow file).
 *   - R-060 .. R-062 — side effects (gh workflow run + DB update; optional
 *     plan-commit when `--commit-plan` is supplied).
 *   - R-070 .. R-071 — post-conditions (status='pr-opened', workflow_run_url
 *     is a valid gh run URL).
 *
 * All `gh` and `git` subprocesses run with a 60s timeout per task rules.
 *
 * @task T9530
 * @epic T9494
 * @adr ADR-T9345
 * @spec .cleo/rcasd/T9345/research/SPEC-T9345-release-pipeline-v2.md §4.3
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  E_GH_NOT_AUTHENTICATED,
  E_INVALID_STATE,
  E_PLAN_NOT_FOUND,
  E_RELEASE_PLAN_INVALID,
  E_WORKFLOW_NOT_FOUND,
  type EngineResult,
  ExitCode,
  engineError,
  engineSuccess,
  safeParseReleasePlan,
} from '@cleocode/contracts';
import { eq } from 'drizzle-orm';

import { getLogger } from '../logger.js';
import { getProjectRoot } from '../paths.js';
import { getDb } from '../store/sqlite.js';
import { releasesNew } from '../store/tasks-schema.js';
import { runGitWithLockRetry } from './engine-ops.js';

const log = getLogger('release:open');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default subprocess timeout for git/gh calls (60s per task rules). */
const SUBPROCESS_TIMEOUT_MS = 60_000;

/** Relative location of the plan file. */
const PLAN_DIR_REL = '.cleo/release';

/** Relative location of the dispatched workflow file. */
const WORKFLOW_DIR_REL = '.github/workflows';

/** Default workflow file name dispatched by `cleo release open`. */
export const DEFAULT_OPEN_WORKFLOW = 'release-prepare.yml' as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link releaseOpen}.
 *
 * @task T9530
 */
export interface ReleaseOpenOptions {
  /** The release version, e.g. `v2026.6.0`. Required positional input. */
  version: string;
  /** Workflow file name to dispatch. Defaults to `release-prepare.yml`. */
  workflow?: string;
  /** When true, poll `gh run watch` until the run reaches a terminal state. */
  watch?: boolean;
  /**
   * When true, commit the plan file to the active branch before dispatching.
   * NOT the default — the workflow can re-derive the plan from `releases` + tasks.db.
   */
  commitPlan?: boolean;
  /**
   * Project root override. Defaults to the canonical project root resolved
   * via {@link getProjectRoot} (walks up from `process.cwd()` for monorepo
   * subdir invocations; honours `CLEO_ROOT` / `CLEO_PROJECT_ROOT`).
   *
   * @task T9583
   */
  projectRoot?: string;
}

/**
 * Data payload returned by {@link releaseOpen} on success.
 *
 * @task T9530
 */
export interface ReleaseOpenResult {
  /** The version dispatched (matches input). */
  version: string;
  /** The GitHub Actions run URL recorded into `releases.workflow_run_url`. */
  workflowRunUrl: string;
  /** True iff `--watch` was supplied (caller waited for the run). */
  watching: boolean;
  /** True iff this invocation was a no-op because status was already `pr-opened`. */
  idempotent?: boolean;
  /** Plan file sha256, supplied as `plan-blob-sha256` field to the workflow dispatch. */
  planBlobSha256: string;
}

// ---------------------------------------------------------------------------
// Helpers — subprocess wrappers (mockable in tests)
// ---------------------------------------------------------------------------

/**
 * Internal handle to subprocess runners. Public via {@link __test__} so unit
 * tests can swap out the real `gh` / `git` callers without `vi.mock` plumbing.
 *
 * @internal
 */
export interface ReleaseOpenRunner {
  /** Run `gh <args>` and return trimmed stdout. Throws on non-zero exit. */
  runGh: (args: readonly string[], cwd: string) => string;
  /** Test whether `gh auth status` exits 0. Returns the boolean directly. */
  checkGhAuth: (cwd: string) => boolean;
}

/**
 * Default runner — invokes the real `gh` binary on PATH with a 60s timeout.
 *
 * @internal
 */
function makeDefaultRunner(): ReleaseOpenRunner {
  return {
    runGh: (args, cwd) =>
      execFileSync('gh', [...args], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SUBPROCESS_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      }).trim(),
    checkGhAuth: (cwd) => {
      try {
        execFileSync('gh', ['auth', 'status'], {
          cwd,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: SUBPROCESS_TIMEOUT_MS,
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — pre-condition validators
// ---------------------------------------------------------------------------

/**
 * R-050: load and validate the plan file at
 * `.cleo/release/<version>.plan.json`.
 *
 * Returns the raw JSON body (for sha256 hashing) AND the parsed plan, or an
 * `E_PLAN_NOT_FOUND` / `E_RELEASE_PLAN_INVALID` envelope on failure.
 *
 * @internal
 */
function loadPlanForOpen(
  version: string,
  projectRoot: string,
): EngineResult<{ rawBody: string; planPath: string }> {
  const planPath = join(projectRoot, PLAN_DIR_REL, `${version}.plan.json`);
  if (!existsSync(planPath)) {
    return engineError<{ rawBody: string; planPath: string }>(
      E_PLAN_NOT_FOUND,
      `Release plan not found at ${planPath}`,
      {
        exitCode: ExitCode.NOT_FOUND,
        fix: `cleo release plan ${version} --epic <id>`,
        details: { planPath, version },
      },
    );
  }
  let rawBody: string;
  try {
    rawBody = readFileSync(planPath, 'utf-8');
  } catch (err) {
    return engineError<{ rawBody: string; planPath: string }>(
      E_RELEASE_PLAN_INVALID,
      `Failed to read plan at ${planPath}: ${err instanceof Error ? err.message : String(err)}`,
      {
        exitCode: ExitCode.FILE_ERROR,
        fix: 'Inspect the plan file permissions and re-run',
        details: { planPath },
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    return engineError<{ rawBody: string; planPath: string }>(
      E_RELEASE_PLAN_INVALID,
      `Plan file at ${planPath} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix: `Re-run cleo release plan ${version} --epic <id>`,
        details: { planPath },
      },
    );
  }
  const validation = safeParseReleasePlan(parsed);
  if (!validation.success) {
    return engineError<{ rawBody: string; planPath: string }>(
      E_RELEASE_PLAN_INVALID,
      `Plan schema validation failed for ${planPath}`,
      {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix: `Re-run cleo release plan ${version} --epic <id>`,
        details: { planPath, issues: validation.error.issues },
      },
    );
  }
  return engineSuccess({ rawBody, planPath });
}

/**
 * R-053: assert the workflow file exists under `.github/workflows/`.
 *
 * @internal
 */
function assertWorkflowFile(
  workflow: string,
  projectRoot: string,
): EngineResult<{ workflowPath: string }> {
  const workflowPath = join(projectRoot, WORKFLOW_DIR_REL, workflow);
  if (!existsSync(workflowPath)) {
    return engineError<{ workflowPath: string }>(
      E_WORKFLOW_NOT_FOUND,
      `Workflow file '${workflow}' not found at ${workflowPath}`,
      {
        exitCode: ExitCode.NOT_FOUND,
        fix: `Ensure '${workflow}' is committed to ${WORKFLOW_DIR_REL}/`,
        details: { workflow, workflowPath },
      },
    );
  }
  return engineSuccess({ workflowPath });
}

// ---------------------------------------------------------------------------
// Helpers — workflow dispatch + run URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the most recent workflow run URL for the given workflow file after
 * dispatch. Returns the URL string or `null` if `gh run list` yields nothing.
 *
 * Polls up to {@link maxAttempts} times because `gh workflow run` returns
 * BEFORE the run is registered in `gh run list` (the API has a small lag).
 *
 * @internal
 */
function resolveLatestRunUrl(
  workflow: string,
  cwd: string,
  runner: ReleaseOpenRunner,
  maxAttempts = 5,
): string | null {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const raw = runner.runGh(
        ['run', 'list', '--workflow', workflow, '--limit', '1', '--json', 'url,databaseId,status'],
        cwd,
      );
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0];
        if (
          first !== null &&
          typeof first === 'object' &&
          'url' in first &&
          typeof first.url === 'string' &&
          first.url.length > 0
        ) {
          return first.url;
        }
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), attempt, workflow },
        'gh run list attempt failed; retrying',
      );
    }
    // Bounded backoff — total worst case ~1.5s across all attempts.
    if (attempt < maxAttempts - 1) {
      const waitMs = 100 * 2 ** attempt;
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        /* tight wait — synchronous to keep this function callable in non-async contexts */
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers — DB UPDATE
// ---------------------------------------------------------------------------

/**
 * UPDATE the `releases` row to `status='pr-opened'` and persist the
 * resolved workflow run URL (R-061 + R-070 + R-071).
 *
 * @internal
 */
async function updateReleaseRow(
  version: string,
  workflowRunUrl: string,
  projectRoot: string,
): Promise<void> {
  const db = await getDb(projectRoot);
  await db
    .update(releasesNew)
    .set({
      status: 'pr-opened',
      workflowRunUrl,
      prOpenedAt: new Date().toISOString(),
    })
    .where(eq(releasesNew.version, version))
    .run();
}

/**
 * Read the current status + workflow_run_url of the releases row for a version.
 *
 * @internal
 */
async function readReleaseStatus(
  version: string,
  projectRoot: string,
): Promise<{ status: string; workflowRunUrl: string | null } | null> {
  const db = await getDb(projectRoot);
  const rows = await db
    .select({ status: releasesNew.status, workflowRunUrl: releasesNew.workflowRunUrl })
    .from(releasesNew)
    .where(eq(releasesNew.version, version))
    .all();
  const row = rows[0];
  if (!row) return null;
  return { status: row.status, workflowRunUrl: row.workflowRunUrl };
}

// ---------------------------------------------------------------------------
// Helpers — plan commit (--commit-plan)
// ---------------------------------------------------------------------------

/**
 * R-062: commit the plan file to the active branch when `--commit-plan` is
 * supplied. The default flow leaves the plan uncommitted; the workflow can
 * re-derive the plan envelope from `releases` + tasks.db without it.
 *
 * @internal
 */
function commitPlanFile(planPath: string, version: string, projectRoot: string): void {
  // Stage the plan file. Use a relative path so git accepts it inside the worktree.
  const relPath = planPath.startsWith(projectRoot)
    ? planPath.slice(projectRoot.length).replace(/^\/+/, '')
    : planPath;
  runGitWithLockRetry(['add', relPath], {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  runGitWithLockRetry(
    ['commit', '-m', `chore(release): attach plan for ${version}`, '--', relPath],
    {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: SUBPROCESS_TIMEOUT_MS,
    },
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dispatch the `release-prepare.yml` workflow for the given version and
 * UPDATE the `releases` row to `status='pr-opened'`.
 *
 * Idempotency: if the row is ALREADY at `status='pr-opened'` AND has a
 * non-null `workflow_run_url`, the verb is a no-op modulo `meta.idempotent=true`
 * (returns the existing URL without re-dispatching).
 *
 * @example
 * ```ts
 * const result = await releaseOpen({ version: 'v2026.6.0' });
 * if (result.success) {
 *   console.log(`Dispatched: ${result.data.workflowRunUrl}`);
 * }
 * ```
 *
 * @task T9530
 */
export async function releaseOpen(
  opts: ReleaseOpenOptions,
  runnerOverride?: ReleaseOpenRunner,
): Promise<EngineResult<ReleaseOpenResult>> {
  const projectRoot = getProjectRoot(opts.projectRoot);
  const workflow = opts.workflow ?? DEFAULT_OPEN_WORKFLOW;
  const watch = opts.watch === true;
  const commitPlan = opts.commitPlan === true;
  const runner: ReleaseOpenRunner = runnerOverride ?? makeDefaultRunner();

  // ── R-050: plan file must exist + parse + schema-validate ─────────────
  const planLoad = loadPlanForOpen(opts.version, projectRoot);
  if (!planLoad.success) {
    return engineError<ReleaseOpenResult>(planLoad.error.code, planLoad.error.message, {
      exitCode: planLoad.error.exitCode,
      fix: planLoad.error.fix,
      details: planLoad.error.details,
    });
  }
  const { rawBody, planPath } = planLoad.data;
  const planBlobSha256 = createHash('sha256').update(rawBody).digest('hex');

  // ── R-051: releases.status MUST be 'planned' (or already pr-opened ⇒ idempotent) ──
  const current = await readReleaseStatus(opts.version, projectRoot);
  if (!current) {
    return engineError<ReleaseOpenResult>(
      E_INVALID_STATE,
      `No releases row for version '${opts.version}'; run cleo release plan first`,
      {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix: `cleo release plan ${opts.version} --epic <id>`,
        details: {
          version: opts.version,
          currentStatus: null,
          expectedStatus: ['planned'],
        },
      },
    );
  }

  // Idempotency short-circuit: already opened.
  if (current.status === 'pr-opened' && current.workflowRunUrl) {
    log.info(
      { version: opts.version, workflowRunUrl: current.workflowRunUrl },
      'release.open: idempotent re-invocation; status already pr-opened',
    );
    return engineSuccess<ReleaseOpenResult>({
      version: opts.version,
      workflowRunUrl: current.workflowRunUrl,
      watching: false,
      idempotent: true,
      planBlobSha256,
    });
  }

  if (current.status !== 'planned') {
    return engineError<ReleaseOpenResult>(
      E_INVALID_STATE,
      `releases.status for '${opts.version}' is '${current.status}'; expected 'planned'`,
      {
        exitCode: ExitCode.VALIDATION_ERROR,
        fix:
          current.status === 'pr-merged' || current.status === 'published'
            ? `Use cleo release reconcile ${opts.version} for the post-publish flow`
            : `Reset the release with cleo release cancel ${opts.version} OR start a fresh plan`,
        details: {
          version: opts.version,
          currentStatus: current.status,
          expectedStatus: ['planned'],
        },
      },
    );
  }

  // ── R-053: workflow file must exist ───────────────────────────────────
  const workflowCheck = assertWorkflowFile(workflow, projectRoot);
  if (!workflowCheck.success) {
    return engineError<ReleaseOpenResult>(workflowCheck.error.code, workflowCheck.error.message, {
      exitCode: workflowCheck.error.exitCode,
      fix: workflowCheck.error.fix,
      details: workflowCheck.error.details,
    });
  }

  // ── R-052: gh auth must succeed ───────────────────────────────────────
  if (!runner.checkGhAuth(projectRoot)) {
    return engineError<ReleaseOpenResult>(
      E_GH_NOT_AUTHENTICATED,
      'GitHub CLI is not authenticated (gh auth status exited non-zero)',
      {
        exitCode: ExitCode.DEPENDENCY_ERROR,
        fix: "Run 'gh auth login' to authenticate",
        details: { hostname: 'github.com' },
      },
    );
  }

  // ── R-062 (optional): commit the plan file to the active branch ───────
  if (commitPlan) {
    try {
      commitPlanFile(planPath, opts.version, projectRoot);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'commit-plan failed; continuing without staged plan',
      );
    }
  }

  // ── R-060: dispatch the workflow ──────────────────────────────────────
  try {
    runner.runGh(
      [
        'workflow',
        'run',
        workflow,
        '--field',
        `version=${opts.version}`,
        '--field',
        `plan-blob-sha256=${planBlobSha256}`,
      ],
      projectRoot,
    );
  } catch (err) {
    return engineError<ReleaseOpenResult>(
      E_GH_NOT_AUTHENTICATED,
      `gh workflow run failed: ${err instanceof Error ? err.message : String(err)}`,
      {
        exitCode: ExitCode.DEPENDENCY_ERROR,
        fix: "Check 'gh workflow list' and ensure the workflow is enabled on this repo",
        details: { workflow, version: opts.version },
      },
    );
  }

  // Resolve the run URL via `gh run list`. May lag for a few hundred ms.
  const runUrl = resolveLatestRunUrl(workflow, projectRoot, runner);
  if (!runUrl) {
    return engineError<ReleaseOpenResult>(
      E_GH_NOT_AUTHENTICATED,
      'Workflow dispatched but no run URL surfaced from gh run list',
      {
        exitCode: ExitCode.DEPENDENCY_ERROR,
        fix: 'Check the Actions tab on GitHub; the dispatch succeeded but URL resolution failed',
        details: { workflow, version: opts.version },
      },
    );
  }

  // ── R-061 / R-070 / R-071: UPDATE releases row ────────────────────────
  await updateReleaseRow(opts.version, runUrl, projectRoot);

  // ── Optional --watch: invoke gh run watch ─────────────────────────────
  if (watch) {
    try {
      // Best-effort poll — non-fatal if the run terminates before we ask.
      runner.runGh(['run', 'watch', '--exit-status', runUrl], projectRoot);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), runUrl },
        'gh run watch exited non-zero; workflow may have failed',
      );
    }
  }

  return engineSuccess<ReleaseOpenResult>({
    version: opts.version,
    workflowRunUrl: runUrl,
    watching: watch,
    planBlobSha256,
  });
}

// ---------------------------------------------------------------------------
// Internal exports — testing only
// ---------------------------------------------------------------------------

/**
 * Internal helpers exposed for unit testing. NOT part of the public API.
 *
 * @internal
 */
export const __test__ = {
  assertWorkflowFile,
  commitPlanFile,
  loadPlanForOpen,
  makeDefaultRunner,
  readReleaseStatus,
  resolveLatestRunUrl,
  updateReleaseRow,
};
