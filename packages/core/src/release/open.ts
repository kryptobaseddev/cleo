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
import { releases } from '../store/tasks-schema.js';
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
   *
   * T12092: the claim this doc used to carry — "the workflow can re-derive the
   * plan from `releases` + tasks.db" — is false. `.cleo/cleo.db` is gitignored
   * (ADR-013 §9), so a runner has no task store and `cleo release plan` cannot
   * run there. Committing the plan is the only way a task- or epic-scoped
   * release can be planned.
   *
   * gh#1375: committing is necessary and NOT sufficient. The plan has to reach
   * the branch `workflow_dispatch` checks out, and this module never pushes —
   * so `releaseOpen` verifies the plan's presence and content on that remote
   * ref and refuses before dispatching rather than after a full preflight.
   */
  commitPlan?: boolean;
  /**
   * Epic task ID forwarded to the workflow's `epic` input (T12089).
   *
   * The workflow regenerates the plan when no `plan-blob-sha256` is supplied,
   * and `cleo release plan` REQUIRES a scope — so without this (or
   * {@link tasks}) the dispatched run dies at "Prepare bump-PR" after a full
   * green preflight.
   */
  epic?: string;
  /**
   * Comma-separated task IDs forwarded to the workflow's `tasks` input (T12089).
   *
   * Use for a task-scoped release, where an epic would drag in sibling tasks
   * that legitimately have no evidence yet and fail the plan with
   * `E_EVIDENCE_INSUFFICIENT`.
   */
  tasks?: string;
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
  /**
   * Plan file sha256, computed for downstream provenance tracking and
   * returned in the result envelope. Per T10105 this is NO LONGER passed
   * as a `--field` to `gh workflow run`, because the
   * `release-prepare.yml workflow_dispatch.inputs` block does not declare
   * the field and the GitHub Actions API rejected the dispatch with
   * HTTP 422 "Unexpected inputs provided" during the v2026.5.100 ship.
   */
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
    .update(releases)
    .set({
      status: 'pr-opened',
      workflowRunUrl,
      prOpenedAt: new Date().toISOString(),
    })
    .where(eq(releases.version, version))
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
    .select({ status: releases.status, workflowRunUrl: releases.workflowRunUrl })
    .from(releases)
    .where(eq(releases.version, version))
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
 * supplied.
 *
 * T12092: the old doc claimed "the workflow can re-derive the plan envelope
 * from `releases` + tasks.db without it". It cannot. `.cleo/tasks.db` is
 * deliberately gitignored (ADR-013 §9 — committing it is the T5158 data-loss
 * vector), so a CI runner has NO task database and `cleo release plan --tasks
 * …` exits 4 (`E_NOT_FOUND`) there. Committing the plan is therefore the ONLY
 * way a task- or epic-scoped release can be planned, not an optional extra.
 *
 * The plan lives under `.cleo/`, which is gitignored, so staging REQUIRES
 * `-f`. Without it `git add` refuses the path and this function committed
 * nothing while reporting success.
 *
 * @internal
 */
function toRepoRelative(planPath: string, projectRoot: string): string {
  return planPath.startsWith(projectRoot)
    ? planPath.slice(projectRoot.length).replace(/^\/+/, '')
    : planPath;
}

/**
 * Resolve the branch `workflow_dispatch` will check out.
 *
 * A `workflow_dispatch` with no explicit ref runs against the repository's
 * DEFAULT branch, so that — not the caller's current branch — is where the
 * plan file has to be. Prefer GitHub's own answer; fall back to the local
 * `origin/HEAD` symref when `gh` cannot answer.
 *
 * @internal
 */
function resolveDispatchBranch(runner: ReleaseOpenRunner, projectRoot: string): string | null {
  try {
    const name = runner
      .runGh(
        ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
        projectRoot,
      )
      .trim();
    if (name !== '') return name;
  } catch {
    // fall through to the local symref
  }
  try {
    const ref = runGitWithLockRetry(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: SUBPROCESS_TIMEOUT_MS,
    }).trim();
    return ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref || null;
  } catch {
    return null;
  }
}

/**
 * gh#1375: read the plan blob as it exists on the remote dispatch branch.
 *
 * Returns `null` when the path is absent there — which is the state a local
 * `--commit-plan` leaves behind, because `commitPlanFile` commits and there is
 * no push anywhere in this module.
 *
 * @internal
 */
function readPlanBlobOnRemote(relPath: string, projectRoot: string, branch: string): Buffer | null {
  try {
    runGitWithLockRetry(['fetch', '--quiet', 'origin', branch], {
      cwd: projectRoot,
      stdio: 'pipe',
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
  } catch {
    // A failed fetch leaves the remote-tracking ref stale rather than absent;
    // the cat-file below still answers, just against older data. Reporting
    // "absent" from a stale ref is the safe direction — it refuses, it does
    // not dispatch.
  }
  try {
    // No `encoding`, so this is the raw blob: the workflow hashes bytes.
    return execFileSync('git', ['cat-file', 'blob', `origin/${branch}:${relPath}`], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: SUBPROCESS_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function commitPlanFile(planPath: string, version: string, projectRoot: string): void {
  // Stage the plan file. Use a relative path so git accepts it inside the worktree.
  const relPath = toRepoRelative(planPath, projectRoot);
  // `-f`: the plan lives under the gitignored `.cleo/`, so a plain `git add`
  // refuses it ("use -f if you really want to add them") and the commit below
  // would then have nothing staged.
  runGitWithLockRetry(['add', '-f', relPath], {
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

  // ── R-060 / T10105 / T12089: dispatch the workflow ────────────────────
  // Canonical input schema for `release-prepare.yml workflow_dispatch.inputs`:
  //   - `version` (string, required) — CalVer release version with v-prefix
  //   - `epic`  (string, optional)   — plan scope
  //   - `tasks` (string, optional)   — plan scope (comma-separated)
  //
  // T12089: sending ONLY `version` made every release fail. With no
  // `plan-blob-sha256` the workflow regenerates the plan, and `cleo release
  // plan` requires `--saga | --epic | --tasks`, so it exited 2 at "Prepare
  // bump-PR" — after lint, typecheck, both test shards and build had all
  // passed. The scope must ride along.
  //
  // `plan-blob-sha256` is still NOT forwarded: the verify branch needs the plan
  // FILE present in the workflow checkout, and `.cleo/` is gitignored, so the
  // hash alone cannot be validated there. Use `--commit-plan` for that path.
  //
  // Keep this `--field` set in lockstep with the YAML inputs declaration and
  // the `release-open-field-schema.test.ts` parity check.
  const dispatchFields = ['--field', `version=${opts.version}`];
  // T12092: forward the plan hash ONLY when the plan was committed. The
  // workflow's verify branch reads the plan FILE from its checkout, so the hash
  // is meaningful exactly when the file is present there — and committing is a
  // NECESSARY step toward that, since `.cleo/` is gitignored. It is not a
  // sufficient one (gh#1375): a local commit is invisible to the runner, so the
  // guard below checks the remote ref rather than trusting the commit.
  if (commitPlan) {
    // gh#1375: committing is NECESSARY and NOT SUFFICIENT. `commitPlanFile`
    // runs `git add -f` and `git commit` and nothing else — there is no push
    // anywhere in this module — so the plan sits in a LOCAL commit while the
    // workflow checks out the remote default branch and reports
    //   ::error::Plan file .cleo/release/<v>.plan.json not found
    // after lint, typecheck, both test shards and build have already run. The
    // whole cost of the mistake is paid before the mistake is visible.
    //
    // So verify the claim the dispatch depends on — the plan file is present,
    // with THIS content, on the ref the workflow will read — rather than the
    // proxy for it (that a commit command exited 0). The two differ exactly in
    // the case that has been failing.
    const relPath = toRepoRelative(planPath, projectRoot);
    const dispatchBranch = resolveDispatchBranch(runner, projectRoot);
    if (dispatchBranch === null) {
      return engineError<ReleaseOpenResult>(
        E_INVALID_STATE,
        'Cannot determine the default branch that workflow_dispatch will check out, so ' +
          `the presence of ${relPath} there cannot be verified`,
        {
          exitCode: ExitCode.VALIDATION_ERROR,
          fix: "Check 'gh repo view --json defaultBranchRef' and that 'origin' is configured",
          details: { version: opts.version, planPath: relPath },
        },
      );
    }
    const remoteBlob = readPlanBlobOnRemote(relPath, projectRoot, dispatchBranch);
    if (remoteBlob === null) {
      return engineError<ReleaseOpenResult>(
        E_INVALID_STATE,
        `--commit-plan committed ${relPath} locally, but it is absent from ` +
          `origin/${dispatchBranch} — the ref workflow_dispatch checks out. The dispatch ` +
          'would fail its plan-verify step after a full preflight.',
        {
          exitCode: ExitCode.VALIDATION_ERROR,
          fix:
            `Get the plan commit onto ${dispatchBranch} first — open a PR carrying ${relPath}, ` +
            `or push the branch that holds it — then re-run 'cleo release open ${opts.version}'.`,
          details: {
            version: opts.version,
            planPath: relPath,
            dispatchBranch,
            planBlobSha256,
          },
        },
      );
    }
    const remoteSha256 = createHash('sha256').update(remoteBlob).digest('hex');
    if (remoteSha256 !== planBlobSha256) {
      return engineError<ReleaseOpenResult>(
        E_INVALID_STATE,
        `${relPath} on origin/${dispatchBranch} does not match the local plan ` +
          `(remote sha256 ${remoteSha256}, local ${planBlobSha256}). The workflow would ` +
          'verify the remote copy and reject the hash this command is about to send.',
        {
          exitCode: ExitCode.VALIDATION_ERROR,
          fix:
            `Push the current plan to ${dispatchBranch} (or re-run 'cleo release plan ` +
            `${opts.version}' if the remote copy is the newer one), then re-run this command.`,
          details: {
            version: opts.version,
            planPath: relPath,
            dispatchBranch,
            localSha256: planBlobSha256,
            remoteSha256,
          },
        },
      );
    }
    dispatchFields.push('--field', `plan-blob-sha256=${planBlobSha256}`);
  }
  if (opts.epic !== undefined && opts.epic !== '') {
    dispatchFields.push('--field', `epic=${opts.epic}`);
  }
  if (opts.tasks !== undefined && opts.tasks !== '') {
    dispatchFields.push('--field', `tasks=${opts.tasks}`);
  }
  try {
    runner.runGh(['workflow', 'run', workflow, ...dispatchFields], projectRoot);
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
