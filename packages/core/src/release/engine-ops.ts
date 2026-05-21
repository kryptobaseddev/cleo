/**
 * Release engine operations — business logic layer.
 *
 * Contains all release domain logic migrated from
 * `packages/cleo/src/dispatch/engines/release-engine.ts` (ENG-MIG-5 / T1572).
 *
 * Each exported function returns `EngineResult` and is importable from
 * `@cleocode/core/internal` so the CLI dispatch layer can call them without
 * any intermediate engine file.
 *
 * Functions that require git CLI interaction (push, tag, commit, rollback-full,
 * changelog-since, ship) use `execFileSync` from `node:child_process` — the
 * same pattern already present in `release-manifest.ts`.
 *
 * @task T1572 — ENG-MIG-5
 * @epic T1566
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getIvtrState } from '../lifecycle/ivtr-loop.js';
import { getLogger } from '../logger.js';
import { getProjectRoot } from '../paths.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { isGhCliAvailable } from './github-pr.js';
import { getReleaseBranchConfig, loadReleaseConfig } from './release-config.js';
import {
  cancelRelease,
  commitRelease,
  listReleases,
  markReleasePushed,
  prepareRelease,
  pushRelease,
  type ReleaseListOptions,
  type ReleaseTaskRecord,
  rollbackRelease,
  runReleaseGates,
  showRelease,
  tagRelease,
} from './release-manifest.js';

const log = getLogger('release');

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Run a `git` invocation with stale-`.git/index.lock` recovery.
 *
 * Some developer environments (IDE indexers, shell prompts, status-line
 * scripts) race against the release engine's git operations and momentarily
 * hold the index lock, causing git to fail with
 * `fatal: Unable to create '.git/index.lock': File exists`.
 *
 * The CLEO release pipeline is a long-running multi-step flow — a transient
 * lock contention should not fail the whole release. This helper detects the
 * lock-conflict signature, removes a stale lock file (only if no other git
 * process is observed in stderr), waits briefly, and retries up to `maxRetries`.
 *
 * @param args Arguments for `git` (e.g. `['add', 'CHANGELOG.md']`).
 * @param opts Options passed to `execFileSync` (cwd, encoding, stdio…).
 * @param maxRetries How many times to retry on a lock conflict (default 3).
 * @returns The output of the successful invocation.
 * @throws The last error from `execFileSync` if all retries are exhausted.
 */
/**
 * @internal Exported for unit testing only. Not part of the public API.
 */
export function runGitWithLockRetry(
  args: readonly string[],
  opts: Parameters<typeof execFileSync>[2],
  maxRetries = 6,
): string {
  const lockErrorPattern = /Unable to create '.+\.git\/index\.lock': File exists/;
  // Exponential backoff: 100ms, 250ms, 500ms, 1s, 2s, 4s → ~7.85s total.
  // Tuned to survive concurrent prompt-status scripts and the cleo sentient
  // daemon's git calls which typically hold the index lock for 100-300ms.
  const backoffSchedule = [100, 250, 500, 1000, 2000, 4000] as const;

  // Ensure a supervisor timeout is always set. Callers may omit it, but we
  // must never allow a hung git child process to wedge the parent forever.
  // Default: 60s. Callers that pass an explicit timeout in opts take precedence.
  const effectiveOpts: Parameters<typeof execFileSync>[2] =
    typeof opts === 'object' && opts !== null
      ? 'timeout' in opts
        ? opts
        : { ...opts, timeout: 60_000 }
      : { timeout: 60_000 };

  // Extract cwd once — used for lock-file cleanup on both timeout and lock errors.
  const cwdStr =
    typeof effectiveOpts === 'object' && effectiveOpts !== null && 'cwd' in effectiveOpts
      ? String((effectiveOpts as { cwd?: unknown }).cwd ?? '')
      : '';

  /** Best-effort removal of `.git/index.lock` under `cwdStr`. */
  const removeStaleLock = (): void => {
    try {
      if (cwdStr) {
        const lockPath = `${cwdStr.replace(/\/+$/, '')}/.git/index.lock`;
        spawnSync('rm', ['-f', lockPath], { stdio: 'pipe' });
      }
    } catch {
      // ignore — surfacing the primary error is more important
    }
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return execFileSync('git', [...args], effectiveOpts) as unknown as string;
    } catch (err: unknown) {
      lastErr = err;
      const errCode = (err as NodeJS.ErrnoException).code ?? '';
      const stderr =
        err instanceof Error && 'stderr' in err
          ? String((err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '')
          : err instanceof Error
            ? err.message
            : String(err);

      // Detect a subprocess timeout (Node.js sets code ETIMEDOUT or kills with SIGTERM).
      // When git itself hangs (not a lock conflict), we must NOT retry — surface
      // a clear error immediately and clean up any stale lock file.
      const isTimeout =
        errCode === 'ETIMEDOUT' ||
        (err instanceof Error && err.message.includes('spawnSync git ETIMEDOUT')) ||
        (err instanceof Error && err.message.includes('Command timed out')) ||
        (err instanceof Error && (err as { killed?: boolean }).killed === true);

      if (isTimeout) {
        removeStaleLock();
        const cmd = `git ${args.join(' ')}`;
        const timeoutMs =
          typeof effectiveOpts === 'object' && effectiveOpts !== null && 'timeout' in effectiveOpts
            ? ((effectiveOpts as { timeout?: number }).timeout ?? 60_000)
            : 60_000;
        const timeoutSec = Math.round(timeoutMs / 1000);
        throw new Error(`git timeout after ${timeoutSec}s: ${cmd}`);
      }

      // Only retry on the specific stale-lock signature
      if (!lockErrorPattern.test(stderr) || attempt === maxRetries) {
        throw err;
      }

      // Best-effort: remove a stale lock file if it still exists. We only do
      // this when the error indicates the lock was the blocker — never blindly.
      removeStaleLock();

      const backoffMs = backoffSchedule[attempt] ?? 4000;
      log.warn(
        { attempt: attempt + 1, maxRetries, args: args.join(' '), backoffMs },
        `  ! Transient git lock conflict — retrying in ${backoffMs}ms`,
      );
      // Synchronous sleep via Atomics.wait — zero-dep, no setTimeout.
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, backoffMs);
    }
  }
  throw lastErr ?? new Error('runGitWithLockRetry exhausted retries');
}

/**
 * Result returned by {@link pollPrMerged} on success.
 */
export interface PollPrMergedResult {
  /** The canonical merge commit OID returned by GitHub (40-char hex). */
  mergeCommitOid: string;
}

/**
 * Poll `gh pr view <prUrl> --json state,mergeCommit` until the PR reaches
 * `state === "MERGED"` with a non-empty `mergeCommit.oid`, then return
 * the merge-commit OID.
 *
 * This prevents the tag-after-merge race where `git rev-parse HEAD` is
 * called before GitHub has landed the merge commit on the target branch
 * (T9504).
 *
 * @param prUrl     The GitHub PR URL (or `owner/repo#number` form).
 * @param opts      Polling options.
 * @param opts.pollIntervalMs  Delay between polls. Default: 5 000.
 * @param opts.timeoutMs       Total wait budget. Default: 300 000.
 * @param opts.cwd             Working directory for `gh` invocation.
 * @returns `{ mergeCommitOid }` on success, `null` on timeout.
 *
 * @task T9504
 */
export function pollPrMerged(
  prUrl: string,
  opts: { pollIntervalMs?: number; timeoutMs?: number; cwd?: string } = {},
): PollPrMergedResult | null {
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const execOpts = {
    cwd: opts.cwd,
    encoding: 'utf-8' as const,
    stdio: 'pipe' as const,
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let raw: string;
    try {
      raw = execFileSync(
        'gh',
        ['pr', 'view', prUrl, '--json', 'state,mergeCommit'],
        execOpts,
      ) as unknown as string;
    } catch {
      // Transient gh CLI error — keep polling
      raw = '';
    }

    if (raw) {
      let parsed: { state?: string; mergeCommit?: { oid?: string } | null };
      try {
        parsed = JSON.parse(raw) as { state?: string; mergeCommit?: { oid?: string } | null };
      } catch {
        parsed = {};
      }

      if (parsed.state === 'MERGED' && parsed.mergeCommit?.oid) {
        return { mergeCommitOid: parsed.mergeCommit.oid };
      }
    }

    // Synchronous sleep between polls — keeps the release engine single-threaded.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const sleepMs = Math.min(pollIntervalMs, remaining);
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, sleepMs);
  }

  return null;
}

/**
 * Detect whether the current execution context is an AI agent.
 * Checks for CLEO_SESSION_ID or CLAUDE_AGENT_TYPE environment variables.
 *
 * @task T4279
 */
function isAgentContext(): boolean {
  return !!(process.env['CLEO_SESSION_ID'] || process.env['CLAUDE_AGENT_TYPE']);
}

/**
 * Verify that a release manifest entry exists for the given version.
 * Used as a protocol guard to ensure agents go through the proper
 * release.ship workflow rather than calling release.push directly.
 *
 * @task T4279
 */
async function hasManifestEntry(version: string, projectRoot?: string): Promise<boolean> {
  try {
    await showRelease(version, projectRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load tasks via DataAccessor (SQLite).
 */
async function loadTasks(projectRoot?: string): Promise<ReleaseTaskRecord[]> {
  const root = getProjectRoot(projectRoot);
  try {
    const accessor = await getTaskAccessor(root);
    const result = await accessor.queryTasks({});
    return (result?.tasks as ReleaseTaskRecord[]) ?? [];
  } catch (error: unknown) {
    throw new Error(`Failed to load task data: ${(error as Error).message}`);
  }
}

/**
 * Check IVTR gate for all tasks in a release epic.
 *
 * Returns a list of task IDs whose ivtr_state.currentPhase is not 'released'.
 * An empty list means all tasks are cleared.
 *
 * @task T820 RELEASE-03
 */
async function checkIvtrGates(
  taskIds: string[],
  projectRoot?: string,
): Promise<{ blocked: string[]; unchecked: string[] }> {
  const blocked: string[] = [];
  const unchecked: string[] = [];

  for (const taskId of taskIds) {
    try {
      const state = await getIvtrState(taskId, { cwd: projectRoot });
      if (state === null) {
        // No IVTR state started — not blocked but flagged as unchecked
        unchecked.push(taskId);
      } else if (state.currentPhase !== 'released') {
        blocked.push(taskId);
      }
    } catch {
      unchecked.push(taskId);
    }
  }

  return { blocked, unchecked };
}

/**
 * Project-relative audit sentinel that proves the IVTR decoupling has run at
 * least once for a project. First-run also appends a JSONL audit row so the
 * decoupling event is traceable (matches the convention used by
 * `force-bypass.jsonl`, `worker-mismatch.jsonl`, etc.).
 *
 * @task T9537
 */
export const IVTR_DECOUPLED_SENTINEL_FILE = '.cleo/audit/ivtr-decoupled.flag';

/**
 * Project-relative JSONL audit log for IVTR-decoupling events. Appended once
 * on the first {@link releaseShip} invocation per project; subsequent runs are
 * no-ops because the sentinel file already exists.
 *
 * @task T9537
 */
export const IVTR_DECOUPLED_AUDIT_FILE = '.cleo/audit/ivtr-decoupled.jsonl';

/**
 * Write a one-time audit entry confirming the IVTR gate has been decoupled
 * from the release pipeline per T9537. The sentinel file
 * `.cleo/audit/ivtr-decoupled.flag` prevents re-logging on subsequent runs.
 *
 * Best-effort: never throws — release flow must not fail because the audit
 * directory is read-only or missing.
 *
 * @task T9537
 */
export function writeIvtrDecouplingAuditOnce(cwd: string, epicId: string): boolean {
  try {
    const sentinelPath = join(cwd, IVTR_DECOUPLED_SENTINEL_FILE);
    if (existsSync(sentinelPath)) {
      return false;
    }
    mkdirSync(dirname(sentinelPath), { recursive: true });
    const payload = {
      ts: new Date().toISOString(),
      event: 'ivtr-decoupled',
      task: 'T9537',
      spec: 'SPEC-T9345 §7 / ivtr-conflation-audit.md Priority 1',
      firstEpic: epicId,
      message:
        'IVTR decoupled from release per T9537 (Phase 5 of T9498). task.ivtr_state is observation-only; ADR-051 evidence atoms are the sole gate.',
    };
    writeFileSync(sentinelPath, `${JSON.stringify(payload)}\n`, 'utf-8');
    const auditPath = join(cwd, IVTR_DECOUPLED_AUDIT_FILE);
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, `${JSON.stringify(payload)}\n`, 'utf-8');
    log.info(
      { audit: 'ivtr-decoupled', task: 'T9537', epicId, sentinel: IVTR_DECOUPLED_SENTINEL_FILE },
      'IVTR decoupled from release per T9537 — sentinel written.',
    );
    return true;
  } catch (err: unknown) {
    // Audit writes are best-effort; never fail the release on filesystem errors.
    log.debug(
      { audit: 'ivtr-decoupled', task: 'T9537', error: (err as Error).message ?? String(err) },
      'IVTR-decoupled audit write failed (non-blocking)',
    );
    return false;
  }
}

/**
 * Build a per-task IVTR status list for the given task IDs.
 *
 * Each entry carries the task ID, current IVTR phase (or null), and whether
 * the task is blocking release.
 */
async function buildTaskStatusList(
  taskIds: string[],
  projectRoot?: string,
): Promise<Array<{ taskId: string; currentPhase: string | null; blocking: boolean }>> {
  const result: Array<{ taskId: string; currentPhase: string | null; blocking: boolean }> = [];
  for (const taskId of taskIds) {
    try {
      const state = await getIvtrState(taskId, { cwd: projectRoot });
      if (state === null) {
        result.push({ taskId, currentPhase: null, blocking: false });
      } else {
        const blocking = state.currentPhase !== 'released';
        result.push({ taskId, currentPhase: state.currentPhase, blocking });
      }
    } catch {
      result.push({ taskId, currentPhase: null, blocking: false });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exported engine operations
// ---------------------------------------------------------------------------

/**
 * release.gate — Standalone IVTR phase gate check (RELEASE-03).
 *
 * Inspects all child tasks of the given epic and verifies that every task
 * whose IVTR loop has been started has reached the `released` phase. Tasks
 * without an IVTR loop (docs, chores) are reported as `unchecked` but are
 * NOT blocking.
 *
 * The `--force` flag bypasses the gate with a loud warning (owner-level
 * override only).
 *
 * @param epicId      - Epic whose child tasks are inspected.
 * @param force       - Bypass gate; emits owner-level warning.
 * @param projectRoot - Optional working directory.
 * @returns EngineResult with ReleaseGateCheckResult on success.
 *
 * @task T820 RELEASE-03
 * @task T1416
 */
export async function releaseGateCheck(
  epicId: string,
  force: boolean,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  const cwd = getProjectRoot(projectRoot);

  // Bypass: loud warning, return pass with forcedBypass flag.
  if (force) {
    const warning =
      `IVTR gate check BYPASSED via --force for epic ${epicId}. ` +
      'This is an owner-level override. All tasks should have reached IVTR released phase before shipping.';
    log.warn({ epicId, forcedBypass: true }, warning);
    return {
      success: true,
      data: {
        epicId,
        passed: true,
        forcedBypass: true,
        blocked: [],
        unchecked: [],
        tasks: [],
        summary: warning,
      },
    };
  }

  try {
    // Load epic child tasks.
    let epicTaskIds: string[] = [];
    try {
      const accessor = await getTaskAccessor(cwd);
      const epicResult = await accessor.queryTasks({ parentId: epicId });
      epicTaskIds = ((epicResult?.tasks as Array<{ id: string; type?: string }>) ?? [])
        .filter((t) => t.type !== 'epic')
        .map((t) => t.id);
    } catch {
      // If task loading fails, treat as no tasks (project may not have them).
    }

    if (epicTaskIds.length === 0) {
      return {
        success: true,
        data: {
          epicId,
          passed: true,
          forcedBypass: false,
          blocked: [],
          unchecked: [],
          tasks: [],
          summary: `Epic ${epicId} has no child tasks to check.`,
        },
      };
    }

    const { blocked, unchecked } = await checkIvtrGates(epicTaskIds, projectRoot);
    const released = epicTaskIds.filter((id) => !blocked.includes(id) && !unchecked.includes(id));
    const passed = blocked.length === 0;

    // Build per-task status array.
    const tasks = await buildTaskStatusList(epicTaskIds, projectRoot);

    const summary = passed
      ? unchecked.length > 0
        ? `IVTR gate passed for epic ${epicId}. ${released.length} task(s) released, ${unchecked.length} unchecked (non-blocking).`
        : `IVTR gate passed for epic ${epicId}. All ${released.length} task(s) are in released phase.`
      : `IVTR gate FAILED for epic ${epicId}. ${blocked.length} task(s) not yet released: ${blocked.join(', ')}.` +
        ` Run \`cleo orchestrate ivtr <taskId> --release\` for each blocking task, or pass --force to bypass.`;

    if (!passed) {
      return engineError('E_IVTR_INCOMPLETE', summary, {
        fix: `cleo orchestrate ivtr ${blocked[0]} --release`,
        details: { blocked, unchecked, epicId, tasks },
      });
    }

    return {
      success: true,
      data: {
        epicId,
        passed,
        forcedBypass: false,
        blocked,
        unchecked,
        tasks,
        summary,
      },
    };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message ?? String(err));
  }
}

/**
 * release.ivtr-suggest — IVTR → release auto-suggest (RELEASE-07).
 *
 * Called after an IVTR loop transitions to `released` for a given task.
 * Checks whether all sibling tasks in the parent epic are also released. If
 * so, emits a `suggestedCommand` pointing the operator toward `release ship`.
 *
 * @deprecated As of T9537 (Phase 5 of T9498), the IVTR gate has been
 * decoupled from the release pipeline per SPEC-T9345 §7 / ivtr-conflation-audit.md
 * Priority 1. This function still works for telemetry and external callers,
 * but `releaseShip` no longer reads or recommends it. ADR-051 evidence atoms
 * (validated by `runReleaseGates`) are the sole gate execution surface.
 * Remove in a future major version once all external integrations migrate.
 *
 * @param taskId      - Task that just reached the `released` phase.
 * @param projectRoot - Optional working directory.
 * @returns EngineResult with IvtrAutoSuggestResult data.
 *
 * @task T820 RELEASE-07
 * @task T1416
 * @task T9537 — deprecated marker (decoupled from releaseShip)
 */
export async function releaseIvtrAutoSuggest(
  taskId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId) {
    return engineError('E_INVALID_INPUT', 'taskId is required');
  }

  const cwd = getProjectRoot(projectRoot);

  try {
    // Find the parent epic for this task.
    const accessor = await getTaskAccessor(cwd);
    const tasks = await accessor.loadTasks([taskId]);
    const taskRecord = tasks[0];

    if (!taskRecord) {
      return engineError('E_NOT_FOUND', `Task ${taskId} not found`);
    }

    const epicId = taskRecord.parentId ?? null;

    if (!epicId) {
      // No parent epic — standalone task, no suggest possible.
      return {
        success: true,
        data: {
          taskId,
          epicId: null,
          epicFullyReleased: false,
          suggestedCommand: null,
          message: `Task ${taskId} has no parent epic. No release suggestion available.`,
        },
      };
    }

    // Load all sibling tasks in the epic.
    const epicResult = await accessor.queryTasks({ parentId: epicId });
    const siblings = ((epicResult?.tasks as Array<{ id: string; type?: string }>) ?? []).filter(
      (t) => t.type !== 'epic',
    );
    const siblingIds = siblings.map((t) => t.id);

    if (siblingIds.length === 0) {
      return {
        success: true,
        data: {
          taskId,
          epicId,
          epicFullyReleased: false,
          suggestedCommand: null,
          message: `Epic ${epicId} has no child tasks.`,
        },
      };
    }

    // Check IVTR state for all siblings.
    const { blocked, unchecked } = await checkIvtrGates(siblingIds, projectRoot);
    const epicFullyReleased = blocked.length === 0 && unchecked.length === 0;

    const suggestedCommand = epicFullyReleased
      ? `cleo release ship <version> --epic ${epicId}`
      : null;

    const stillBlocked = blocked.length + unchecked.length;
    const message = epicFullyReleased
      ? `All ${siblingIds.length} task(s) in epic ${epicId} have reached IVTR released phase. ` +
        `Next step: run \`${suggestedCommand}\` to publish the release.`
      : `Task ${taskId} released. ${stillBlocked} sibling task(s) in epic ${epicId} still pending IVTR release ` +
        `(blocked: ${blocked.length}, unchecked: ${unchecked.length}).`;

    return {
      success: true,
      data: {
        taskId,
        epicId,
        epicFullyReleased,
        suggestedCommand,
        message,
      },
    };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message ?? String(err));
  }
}

/**
 * release.prepare — Prepare a release.
 *
 * @task T4788
 */
export async function releasePrepare(
  version: string,
  tasks?: string[],
  notes?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const data = await prepareRelease(
      version,
      tasks,
      notes,
      () => loadTasks(projectRoot),
      projectRoot,
    );
    return { success: true, data };
  } catch (err: unknown) {
    const message = (err as Error).message;
    let code = 'E_RELEASE_PREPARE_FAILED';
    if (message.includes('required')) code = 'E_INVALID_INPUT';
    else if (message.includes('Invalid version')) code = 'E_INVALID_VERSION';
    else if (message.includes('already exists')) code = 'E_VERSION_EXISTS';
    return engineError(code, message);
  }
}

/**
 * release.list — List all releases (query operation via data read).
 *
 * @task T4788
 */
export async function releaseList(
  optionsOrProjectRoot?: ReleaseListOptions | string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const options =
      typeof optionsOrProjectRoot === 'string' || optionsOrProjectRoot === undefined
        ? {}
        : optionsOrProjectRoot;
    const effectiveProjectRoot =
      typeof optionsOrProjectRoot === 'string' ? optionsOrProjectRoot : projectRoot;
    const data = await listReleases(options, effectiveProjectRoot);
    return {
      success: true,
      data: {
        releases: data.releases,
        total: data.total,
        filtered: data.filtered,
        latest: data.latest,
      },
      page: data.page,
    };
  } catch (err: unknown) {
    return engineError('E_LIST_FAILED', (err as Error).message);
  }
}

/**
 * release.show — Show release details (query operation via data read).
 *
 * @task T4788
 */
export async function releaseShow(version: string, projectRoot?: string): Promise<EngineResult> {
  try {
    const data = await showRelease(version, projectRoot);
    return { success: true, data };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_SHOW_FAILED';
    return engineError(code, message);
  }
}

/**
 * release.commit — Mark release as committed (metadata only).
 *
 * @task T4788
 */
export async function releaseCommit(version: string, projectRoot?: string): Promise<EngineResult> {
  try {
    const data = await commitRelease(version, projectRoot);
    return { success: true, data };
  } catch (err: unknown) {
    const message = (err as Error).message;
    let code = 'E_COMMIT_FAILED';
    if (message.includes('not found')) code = 'E_NOT_FOUND';
    else if (message.includes('expected')) code = 'E_INVALID_STATE';
    return engineError(code, message);
  }
}

/**
 * release.tag — Mark release as tagged (metadata only).
 *
 * @task T4788
 */
export async function releaseTag(version: string, projectRoot?: string): Promise<EngineResult> {
  try {
    const data = await tagRelease(version, projectRoot);
    return { success: true, data };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_TAG_FAILED';
    return engineError(code, message);
  }
}

/**
 * release.gates.run — Run release gates (validation checks).
 *
 * @task T4788
 */
export async function releaseGatesRun(
  version: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const data = await runReleaseGates(version, () => loadTasks(projectRoot), projectRoot);
    return { success: true, data };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_GATES_FAILED';
    return engineError(code, message);
  }
}

/**
 * release.rollback — Rollback a release.
 *
 * @task T4788
 */
export async function releaseRollback(
  version: string,
  reason?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const data = await rollbackRelease(version, reason, projectRoot);
    return { success: true, data };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_ROLLBACK_FAILED';
    return engineError(code, message);
  }
}

/**
 * release.rollback.full — Full rollback: delete git tag, revert commit,
 * remove release record from DB, and optionally unpublish from npm.
 *
 * Sequence:
 *   1. Delete remote git tag (if pushed)
 *   2. Delete local git tag
 *   3. Revert the release commit (creates a new revert commit)
 *   4. Remove/flip release record in DB to 'rolled_back'
 *   5. (Optional) npm deprecate if npm registry is configured
 *
 * @task T820 RELEASE-05
 */
export async function releaseRollbackFull(
  version: string,
  options: { reason?: string; force?: boolean; unpublish?: boolean },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!version) {
    return engineError('E_INVALID_INPUT', 'version is required');
  }

  const cwd = getProjectRoot(projectRoot);
  const gitTag = `v${version.replace(/^v/, '')}`;
  const reason = options.reason ?? 'Rollback via cleo release rollback';
  const gitCwd = {
    cwd,
    encoding: 'utf-8' as const,
    stdio: 'pipe' as const,
    timeout: 60_000,
  };
  const steps: string[] = [];

  try {
    // Step 1: Delete remote git tag (best-effort; may not exist if push failed)
    try {
      execFileSync('git', ['push', 'origin', `--delete`, gitTag], gitCwd);
      steps.push(`Deleted remote tag ${gitTag}`);
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string; message?: string }).stderr ??
        (err as { message?: string }).message ??
        '';
      if (msg.includes('remote ref does not exist') || msg.includes('error: unable to delete')) {
        steps.push(`Remote tag ${gitTag} not found — skipping remote delete`);
      } else {
        steps.push(`Warning: could not delete remote tag ${gitTag}: ${msg.slice(0, 200)}`);
      }
    }

    // Step 2: Delete local git tag
    try {
      execFileSync('git', ['tag', '-d', gitTag], gitCwd);
      steps.push(`Deleted local tag ${gitTag}`);
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string; message?: string }).stderr ??
        (err as { message?: string }).message ??
        '';
      steps.push(`Warning: could not delete local tag ${gitTag}: ${msg.slice(0, 200)}`);
    }

    // Step 3: Revert the release commit (find the most recent commit with our message)
    let revertSha: string | undefined;
    try {
      const logOut = execFileSync(
        'git',
        ['log', '--oneline', '--grep', `release: ship v${version}`, '-1'],
        gitCwd,
      )
        .toString()
        .trim();

      if (logOut) {
        revertSha = logOut.split(' ')[0];
        execFileSync('git', ['revert', '--no-edit', revertSha!], gitCwd);
        steps.push(`Reverted release commit ${revertSha}`);
      } else {
        steps.push(`No release commit found for ${version} — skipping revert`);
      }
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string; message?: string }).stderr ??
        (err as { message?: string }).message ??
        '';
      steps.push(`Warning: could not revert release commit: ${msg.slice(0, 200)}`);
    }

    // Step 4: Mark release as rolled_back in DB
    const dbResult = await rollbackRelease(version, reason, projectRoot);
    steps.push(
      `Marked release ${dbResult.version} as rolled_back in DB (was: ${dbResult.previousStatus})`,
    );

    // Step 5: Optional npm deprecate (best-effort, non-blocking)
    if (options.unpublish) {
      try {
        const config = loadReleaseConfig(cwd);
        if (config.registries?.includes('npm')) {
          const pkgJson = JSON.parse(readFileSync(`${cwd}/package.json`, 'utf-8')) as {
            name?: string;
          };
          const pkgName = pkgJson.name;
          if (pkgName) {
            execFileSync('npm', ['deprecate', `${pkgName}@${version}`, `Rolled back: ${reason}`], {
              cwd,
              encoding: 'utf-8',
              stdio: 'pipe',
            });
            steps.push(`npm deprecated ${pkgName}@${version}`);
          }
        }
      } catch (err: unknown) {
        const msg = (err as { message?: string }).message ?? String(err);
        steps.push(`Warning: npm deprecate failed (non-blocking): ${msg.slice(0, 200)}`);
      }
    }

    return {
      success: true,
      data: {
        version: dbResult.version,
        previousStatus: dbResult.previousStatus,
        status: dbResult.status,
        reason,
        gitTag,
        revertSha,
        steps,
      },
    };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_ROLLBACK_FAILED';
    return engineError(code, message);
  }
}

/**
 * release.cancel — Cancel and remove a release in draft or prepared state.
 *
 * @task T5602
 */
export async function releaseCancel(version: string, projectRoot?: string): Promise<EngineResult> {
  if (!version) {
    return engineError('E_INVALID_INPUT', 'version is required');
  }
  try {
    const result = await cancelRelease(version, projectRoot);
    if (!result.success) {
      const code = result.message.includes('not found') ? 'E_NOT_FOUND' : 'E_INVALID_STATE';
      return engineError(code, result.message);
    }
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_CANCEL_FAILED';
    return engineError(code, message);
  }
}

/**
 * release.push — Push release to remote via git.
 *
 * Uses execFileSync (no shell) for safety. Respects config.release.push policy.
 *
 * Agent protocol guard (T4279): When running in agent context
 * (detected via CLEO_SESSION_ID or CLAUDE_AGENT_TYPE env vars),
 * requires a release manifest entry for the version. This ensures
 * agents go through the proper release.ship workflow rather than
 * calling release.push directly, maintaining provenance tracking.
 *
 * @task T4788
 * @task T4276
 * @task T4279
 */
export async function releasePush(
  version: string,
  remote?: string,
  projectRoot?: string,
  opts?: { explicitPush?: boolean },
): Promise<EngineResult> {
  // Agent protocol guard: require manifest entry when in agent context
  if (isAgentContext()) {
    const hasEntry = await hasManifestEntry(version, projectRoot);
    if (!hasEntry) {
      return engineError(
        'E_PROTOCOL_RELEASE',
        `Agent protocol violation: no release manifest entry for '${version}'. ` +
          'Use the full release.ship workflow to ensure provenance tracking. ' +
          'Direct release.push is not allowed in agent context without a manifest entry.',
        {
          exitCode: 66,
          fix: `ct release ship ${version} --epic T####`,
          alternatives: [
            {
              action: 'Use full ship workflow',
              command: `ct release ship ${version} --epic T####`,
            },
          ],
        },
      );
    }
  }

  try {
    const result = await pushRelease(version, remote, projectRoot, opts);
    // Capture commit SHA for provenance and update the manifest
    let commitSha: string | undefined;
    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: getProjectRoot(projectRoot),
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 60_000,
      })
        .toString()
        .trim();
    } catch {
      // Non-fatal: provenance capture is best-effort
    }
    const gitTag = `v${result.version.replace(/^v/, '')}`;
    await markReleasePushed(result.version, result.pushedAt, projectRoot, { commitSha, gitTag });
    return { success: true, data: result };
  } catch (err: unknown) {
    const execError = err as { status?: number; stderr?: string; message?: string };
    const message = (execError.stderr ?? execError.message ?? '').slice(0, 500);
    // Distinguish config policy errors from git errors
    if (
      execError.message?.includes('disabled by config') ||
      execError.message?.includes('not in allowed branches') ||
      execError.message?.includes('not clean')
    ) {
      return engineError('E_VALIDATION', message);
    }
    return engineError('E_GENERAL', `Git push failed: ${message}`, {
      details: { exitCode: execError.status },
    });
  }
}

// ---------------------------------------------------------------------------
// release.pr-status — manual CI poll for an in-progress release PR (T9095)
// ---------------------------------------------------------------------------

/** A single CI check status entry returned by release.pr-status. */
export interface PRCheckStatus {
  /** Check name (e.g. 'build', 'test'). */
  name: string;
  /** GitHub check run status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED'. */
  status: string;
  /** GitHub check run conclusion: 'SUCCESS' | 'FAILURE' | 'CANCELLED' | null. */
  conclusion: string | null;
}

/** Result shape for release.pr-status. */
export interface PRStatusResult {
  /** The version queried. */
  version: string;
  /** The release branch name (e.g. release/v2026.5.43). */
  releaseBranch: string;
  /** The PR URL resolved from the release branch. */
  prUrl: string | null;
  /** All CI check statuses from gh pr checks. */
  checks: PRCheckStatus[];
  /** Whether all checks have completed successfully. */
  allPassed: boolean;
  /** Whether any check has failed or been cancelled. */
  anyFailed: boolean;
}

/**
 * release.pr-status — Resolve the open PR for a release branch and return
 * the current CI check statuses.
 *
 * Provides a way to manually poll after `release ship` is interrupted or
 * times out waiting for CI.
 *
 * @param version     - Release version (with or without leading 'v').
 * @param projectRoot - Optional working directory.
 * @returns EngineResult with PRStatusResult.
 *
 * @task T9095
 */
export async function releasePrStatus(
  version: string,
  projectRoot?: string,
): Promise<EngineResult<PRStatusResult>> {
  if (!version) {
    return engineError('E_INVALID_INPUT', 'version is required');
  }

  const cwd = getProjectRoot(projectRoot);

  if (!isGhCliAvailable()) {
    return engineError(
      'E_GENERAL',
      'gh CLI is not available. Install it from https://cli.github.com.',
    );
  }

  const cfg = loadReleaseConfig(cwd);
  const branchCfg = getReleaseBranchConfig(cfg, cwd);
  const cleanVersion = version.replace(/^v/, '');
  const releaseBranch = `${branchCfg.releaseBranchPrefix}v${cleanVersion}`;

  let prUrl: string | null = null;
  try {
    const viewResult = spawnSync(
      'gh',
      ['pr', 'view', releaseBranch, '--json', 'url', '--jq', '.url'],
      { cwd, encoding: 'utf-8', timeout: 15_000 },
    );
    if (viewResult.status === 0 && viewResult.stdout.trim()) {
      prUrl = viewResult.stdout.trim();
    }
  } catch {
    // Non-fatal
  }

  if (!prUrl) {
    return engineError(
      'E_NOT_FOUND',
      `No open PR found for release branch '${releaseBranch}'. Verify the branch exists on the remote or the PR has not been merged/closed.`,
    );
  }

  let checks: PRCheckStatus[] = [];
  try {
    const checksResult = spawnSync(
      'gh',
      ['pr', 'checks', prUrl, '--json', 'name,status,conclusion'],
      { cwd, encoding: 'utf-8', timeout: 30_000 },
    );
    if (checksResult.status === 0 && checksResult.stdout) {
      const raw = JSON.parse(checksResult.stdout) as Array<{
        name: string;
        status: string;
        conclusion: string | null;
      }>;
      checks = raw.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }));
    }
  } catch {
    // Non-fatal — return empty checks
  }

  const allPassed =
    checks.length > 0 &&
    checks.every((c) => c.status === 'COMPLETED' && c.conclusion === 'SUCCESS');
  const anyFailed = checks.some((c) => c.conclusion === 'FAILURE' || c.conclusion === 'CANCELLED');

  return engineSuccess<PRStatusResult>({
    version: cleanVersion,
    releaseBranch,
    prUrl,
    checks,
    allPassed,
    anyFailed,
  });
}
