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
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getIvtrState } from '../lifecycle/ivtr-loop.js';
import { getLogger } from '../logger.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { resolveProjectRoot } from '../store/file-utils.js';
import { getDb } from '../store/sqlite.js';
import { releaseManifests } from '../store/tasks-schema.js';
import {
  channelToDistTag,
  type ReleaseChannel,
  resolveChannelFromBranch,
  validateVersionChannel,
} from './channel.js';
import {
  buildPRBody,
  createPullRequest,
  isGhCliAvailable,
  type PRResult,
  resolvePRLabels,
} from './github-pr.js';
import { checkDoubleListing, checkEpicCompleteness } from './guards.js';
import { getGitFlowConfig, getReleaseBranchConfig, loadReleaseConfig } from './release-config.js';
import {
  cancelRelease,
  commitRelease,
  generateReleaseChangelog,
  listManifestReleases,
  markReleasePushed,
  prepareRelease,
  pushRelease,
  type ReleaseListOptions,
  type ReleaseTaskRecord,
  rollbackRelease,
  runReleaseGates,
  showManifestRelease,
  tagRelease,
} from './release-manifest.js';
import { bumpVersionFromConfig, resolveVersionBumpTargets } from './version-bump.js';

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
    await showManifestRelease(version, projectRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load tasks via DataAccessor (SQLite).
 */
async function loadTasks(projectRoot?: string): Promise<ReleaseTaskRecord[]> {
  const root = projectRoot ?? resolveProjectRoot();
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
// Changelog-since helpers
// ---------------------------------------------------------------------------

interface ParsedCommit {
  sha: string;
  message: string;
  taskIds: string[];
  epicIds: string[];
  timestamp: string;
}

/**
 * Parse commit messages from `git log` output, extracting task/epic IDs.
 *
 * Returns a structured list of commits grouped by referenced task IDs.
 *
 * @task T820 RELEASE-02
 */
function parseGitLogCommits(raw: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  // Format: <sha>\x1f<timestamp>\x1f<message>
  const entries = raw.split('\x1e').filter(Boolean);
  const taskPattern = /\bT\d+\b/g;
  const epicPattern = /\bEpic\s+(T\d+)\b/gi;

  for (const entry of entries) {
    const parts = entry.trim().split('\x1f');
    if (parts.length < 3) continue;
    const [sha, timestamp, ...msgParts] = parts;
    if (!sha || !timestamp) continue;
    const message = msgParts.join('\x1f').trim();
    const taskIds = [...new Set([...(message.match(taskPattern) ?? [])])];
    const epicMatches = [...message.matchAll(epicPattern)];
    const epicIds = [...new Set(epicMatches.map((m) => m[1] ?? '').filter(Boolean))];

    commits.push({ sha: sha.trim(), message, taskIds, epicIds, timestamp: timestamp.trim() });
  }

  return commits;
}

// ---------------------------------------------------------------------------
// Composition chain helpers
// ---------------------------------------------------------------------------

/**
 * Composition chain for a release, linking the parent release protocol to the
 * cross-cutting sub-protocols (artifact-publish, provenance) per release.md.
 *
 * @task T260
 */
interface CompositionChain {
  subProtocols: ('artifact-publish' | 'provenance')[];
  artifactType: string | null;
  provenanceEnabled: boolean;
  slsaLevel: number | null;
  notes: string[];
}

/**
 * Resolve which cross-cutting sub-protocols apply to a release based on the
 * project's release config.
 *
 * Decision rules (matching release.md "Conditional Trigger Matrix"):
 * - `source-only` artifact type → no sub-protocols
 * - any non-`source-only` artifact type → artifact-publish required
 * - `security.enableProvenance: true` → provenance required (transitively)
 *
 * @task T260
 */
function resolveCompositionChain(cwd: string): CompositionChain {
  const config = loadReleaseConfig(cwd);
  const artifactType = config.artifactType ?? null;
  const provenanceEnabled = config.security?.enableProvenance === true;
  const slsaLevel = config.security?.slsaLevel ?? null;
  const notes: string[] = [];

  // Source-only releases (docs, chore bumps) declare no artifact handler
  // or use the sentinel `source-only` value. They skip both sub-protocols.
  if (!artifactType || artifactType === 'source-only') {
    return {
      subProtocols: [],
      artifactType,
      provenanceEnabled: false,
      slsaLevel: null,
      notes: [],
    };
  }

  const subProtocols: ('artifact-publish' | 'provenance')[] = ['artifact-publish'];
  notes.push(`artifact type: ${artifactType}`);

  if (provenanceEnabled) {
    subProtocols.push('provenance');
    if (slsaLevel != null) {
      notes.push(`provenance: SLSA L${slsaLevel}`);
    } else {
      notes.push('provenance: enabled');
    }
  } else {
    notes.push('provenance: disabled in config');
  }

  return {
    subProtocols,
    artifactType,
    provenanceEnabled,
    slsaLevel,
    notes,
  };
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

  const cwd = projectRoot ?? resolveProjectRoot();

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
 * @param taskId      - Task that just reached the `released` phase.
 * @param projectRoot - Optional working directory.
 * @returns EngineResult with IvtrAutoSuggestResult data.
 *
 * @task T820 RELEASE-07
 * @task T1416
 */
export async function releaseIvtrAutoSuggest(
  taskId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId) {
    return engineError('E_INVALID_INPUT', 'taskId is required');
  }

  const cwd = projectRoot ?? resolveProjectRoot();

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
 * release.changelog — Generate changelog.
 *
 * @task T4788
 */
export async function releaseChangelog(
  version: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const data = await generateReleaseChangelog(version, () => loadTasks(projectRoot), projectRoot);
    return { success: true, data };
  } catch (err: unknown) {
    const message = (err as Error).message;
    let code = 'E_CHANGELOG_FAILED';
    if (message.includes('required')) code = 'E_INVALID_INPUT';
    else if (message.includes('not found')) code = 'E_NOT_FOUND';
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
    const data = await listManifestReleases(options, effectiveProjectRoot);
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
    const data = await showManifestRelease(version, projectRoot);
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

  const cwd = projectRoot ?? resolveProjectRoot();
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
 * release.changelog.since — Auto-CHANGELOG from git log since last tag.
 *
 * Walks git log since `sinceTag`, parses epic/task IDs from each commit
 * message, groups commits by epic, and renders a structured changelog body.
 *
 * @task T820 RELEASE-02
 */
export async function releaseChangelogSince(
  sinceTag: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!sinceTag) {
    return engineError('E_INVALID_INPUT', 'sinceTag is required');
  }

  const cwd = projectRoot ?? resolveProjectRoot();

  try {
    // Walk git log since the given tag using a parseable format
    let rawLog: string;
    const logArgs = ['log', `${sinceTag}..HEAD`, '--pretty=format:%H\x1f%cI\x1f%s %b\x1e'];

    try {
      rawLog = execFileSync('git', logArgs, {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 60_000,
      });
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string; message?: string }).stderr ??
        (err as { message?: string }).message ??
        '';
      // If the tag doesn't exist, git will error — surface clearly
      return engineError(
        'E_NOT_FOUND',
        `Cannot walk git log since '${sinceTag}': ${msg.slice(0, 400)}`,
      );
    }

    const commits = parseGitLogCommits(rawLog);

    // Group commits by epic IDs (or 'uncategorized' if none found)
    const byEpic = new Map<string, ParsedCommit[]>();
    for (const commit of commits) {
      if (commit.epicIds.length > 0) {
        for (const epicId of commit.epicIds) {
          if (!byEpic.has(epicId)) byEpic.set(epicId, []);
          byEpic.get(epicId)!.push(commit);
        }
      } else {
        const key = commit.taskIds.length > 0 ? `tasks:${commit.taskIds[0]}` : 'uncategorized';
        if (!byEpic.has(key)) byEpic.set(key, []);
        byEpic.get(key)!.push(commit);
      }
    }

    // Render markdown changelog
    const lines: string[] = [
      `## Changelog since ${sinceTag}`,
      '',
      `> Auto-generated from \`git log ${sinceTag}..HEAD\``,
      `> ${commits.length} commit(s) found`,
      '',
    ];

    for (const [groupKey, groupCommits] of byEpic.entries()) {
      const isEpic = /^T\d+$/.test(groupKey);
      const header = isEpic ? `### Epic ${groupKey}` : `### ${groupKey}`;
      lines.push(header);
      for (const commit of groupCommits) {
        const taskRef = commit.taskIds.length > 0 ? ` (${commit.taskIds.join(', ')})` : '';
        lines.push(`- ${commit.message}${taskRef} [\`${commit.sha.slice(0, 8)}\`]`);
      }
      lines.push('');
    }

    const changelog = lines.join('\n');

    return {
      success: true,
      data: {
        sinceTag,
        commitCount: commits.length,
        epicCount: byEpic.size,
        changelog,
        commits: commits.map((c) => ({
          sha: c.sha.slice(0, 8),
          message: c.message,
          taskIds: c.taskIds,
          epicIds: c.epicIds,
        })),
      },
    };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message ?? String(err));
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
        cwd: projectRoot ?? process.cwd(),
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

/**
 * release.ship — Composite release operation (PR-required flow, T9095).
 *
 * Sequence:
 *   0.   Bump version files (optional)
 *   0.5. Auto-prepare release record
 *   1.   Validate release gates
 *   1.5. IVTR gate check
 *   2.   Check epic completeness
 *   3.   Check task double-listing
 *   4.   Generate CHANGELOG + lint check
 *   5.   Cut release branch + commit changes
 *   6.   Push release branch to remote
 *   7.   Open PR via gh CLI (MANDATORY — no direct push to main)
 *   8.   Wait for CI checks (15 min max)
 *   9.   Merge PR with --merge (preserves commit SHAs)
 *   10.  Tag from main + push tag
 *   11.  Cleanup release branch (local + remote)
 *   12.  Record provenance
 *
 * @task T5582
 * @task T5586
 * @task T9095 — PR-required flow
 * @epic T5576
 */
export async function releaseShip(
  params: {
    version: string;
    epicId: string;
    remote?: string;
    dryRun?: boolean;
    bump?: boolean;
    /** Skip IVTR gate check — requires owner confirmation (T820 RELEASE-03). */
    force?: boolean;
  },
  projectRoot?: string,
): Promise<EngineResult> {
  const { version, epicId, remote, dryRun = false, bump = true, force = false } = params;

  if (!version) {
    return engineError('E_INVALID_INPUT', 'version is required');
  }
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  const cwd = projectRoot ?? resolveProjectRoot();
  const gitRemote = remote ?? 'origin';

  /** Collected step log messages, included in every return value for CLI visibility. */
  const steps: string[] = [];

  /** Emit a step line for each release stage. Pushes to steps[] and logs via structured logger. */
  const logStep = (
    n: number,
    total: number,
    label: string,
    done?: boolean,
    error?: string,
  ): void => {
    let msg: string;
    if (done === undefined) {
      msg = `[Step ${n}/${total}] ${label}...`;
      log.info({ step: n, total, label, phase: 'start' }, msg);
    } else if (done) {
      msg = `  ✓ ${label}`;
      log.info({ step: n, total, label, phase: 'done' }, msg);
    } else {
      msg = `  ✗ ${label}: ${error ?? 'failed'}`;
      log.warn({ step: n, total, label, phase: 'failed', error }, msg);
    }
    steps.push(msg);
  };

  const { targets: bumpTargets, source: bumpSource } = resolveVersionBumpTargets(cwd);
  const shouldBump = bump && bumpTargets.length > 0;
  if (shouldBump && bumpSource === 'workspace') {
    const note =
      `  i Auto-discovered ${bumpTargets.length} workspace package.json file(s) for version bump ` +
      `(no release.versionBump.files in .cleo/config.json).`;
    steps.push(note);
    log.info(
      { bumpSource, fileCount: bumpTargets.length, files: bumpTargets.map((t) => t.file) },
      note,
    );
  }

  // Load config once up-front (used throughout the flow)
  const loadedConfig = loadReleaseConfig(cwd);
  const branchCfg = getReleaseBranchConfig(loadedConfig, cwd);
  const gitflowCfg = getGitFlowConfig(loadedConfig);

  // Normalised version (strip leading 'v' for consistency in messages)
  const cleanVersion = version.replace(/^v/, '');
  const gitTag = `v${cleanVersion}`;

  // Release branch name: e.g. release/v2026.5.43
  const releaseBranch = `${branchCfg.releaseBranchPrefix}${gitTag}`;

  // PR target branch is determined by branch model
  const prTargetBranch = branchCfg.prTargetBranch;

  // Enforce gh CLI availability — fail hard, no silent fallback (T9095)
  if (!dryRun && !isGhCliAvailable()) {
    return engineError(
      'E_GENERAL',
      'gh CLI is not available. Install it from https://cli.github.com and authenticate with `gh auth login`. ' +
        'Every release must go through a PR — no direct push is permitted.',
    );
  }

  try {
    // Step 0: Bump version files (if configured and bump not disabled)
    if (shouldBump) {
      logStep(0, 12, 'Bump version files');
      if (!dryRun) {
        const bumpResults = bumpVersionFromConfig(version, { dryRun: false }, cwd);
        if (!bumpResults.allSuccess) {
          const failed = bumpResults.results.filter((r) => !r.success).map((r) => r.file);
          steps.push(`  ! Version bump partial: failed for ${failed.join(', ')}`);
        } else {
          logStep(0, 12, 'Bump version files', true);
        }
      } else {
        logStep(0, 12, 'Bump version files', true);
      }
    }

    // Step 0.5: Ensure release record exists (auto-prepare if needed)
    // Since T5615 removed release.add/plan, ship must be self-contained
    try {
      await showManifestRelease(version, cwd);
    } catch {
      logStep(0, 12, 'Auto-prepare release record');
      if (!dryRun) {
        await prepareRelease(
          version,
          undefined,
          `Auto-prepared by release.ship (${epicId})`,
          () => loadTasks(projectRoot),
          cwd,
        );
        const normalizedVer = version.startsWith('v') ? version : `v${version}`;
        const db = await getDb(cwd);
        await db
          .update(releaseManifests)
          .set({ epicId })
          .where(eq(releaseManifests.version, normalizedVer))
          .run();
        await generateReleaseChangelog(version, () => loadTasks(projectRoot), cwd);
      }
      logStep(0, 12, 'Auto-prepare release record', true);
    }

    // Step 1: Run release gates
    logStep(1, 12, 'Validate release gates');
    const gatesResult = await runReleaseGates(version, () => loadTasks(projectRoot), projectRoot, {
      dryRun,
    });

    if (gatesResult && !gatesResult.allPassed) {
      const failedGates = gatesResult.gates.filter((g) => g.status === 'failed');
      logStep(1, 12, 'Validate release gates', false, failedGates.map((g) => g.name).join(', '));
      return engineError(
        'E_LIFECYCLE_GATE_FAILED',
        `Release gates failed for ${version}: ${failedGates.map((g) => g.name).join(', ')}`,
        { details: { gates: gatesResult.gates, failedCount: gatesResult.failedCount } },
      );
    }
    logStep(1, 12, 'Validate release gates', true);

    // Step 1.5 (T820 RELEASE-03): IVTR gate enforcement
    if (!force) {
      logStep(1, 12, 'Check IVTR gate for epic tasks');
      let epicTaskIds: string[] = [];
      try {
        const epicAccessorForIvtr = await getTaskAccessor(cwd);
        const epicResult = await epicAccessorForIvtr.queryTasks({ parentId: epicId });
        epicTaskIds = ((epicResult?.tasks as Array<{ id: string; type?: string }>) ?? [])
          .filter((t) => t.type !== 'epic')
          .map((t) => t.id);
      } catch {
        // If we cannot load tasks, skip IVTR check (project may not have them)
      }

      if (epicTaskIds.length > 0) {
        const { blocked, unchecked } = await checkIvtrGates(epicTaskIds, projectRoot);
        if (blocked.length > 0) {
          logStep(
            1,
            12,
            'Check IVTR gate for epic tasks',
            false,
            `${blocked.length} task(s) not released in IVTR`,
          );
          return engineError(
            'E_LIFECYCLE_GATE_FAILED',
            `IVTR gate rejected: ${blocked.length} task(s) in epic ${epicId} have not reached IVTR 'released' phase: ${blocked.join(', ')}. ` +
              'Run `cleo orchestrate ivtr <taskId> --release` for each blocking task, or pass --force to bypass with owner warning.',
            {
              fix: `cleo orchestrate ivtr ${blocked[0]} --release`,
              details: { blocked, unchecked, epicId },
            },
          );
        }
        if (unchecked.length > 0) {
          const w = `  ! IVTR gate: ${unchecked.length} task(s) have no IVTR state (non-blocking): ${unchecked.join(', ')}`;
          steps.push(w);
          log.warn({ epicId, unchecked, count: unchecked.length }, w);
        }
        logStep(1, 12, 'Check IVTR gate for epic tasks', true);
      } else {
        logStep(1, 12, 'Check IVTR gate for epic tasks', true);
      }
    } else {
      const w = `  ! --force: IVTR gate check BYPASSED. Owner-level override only.`;
      steps.push(w);
      log.warn({ epicId, forcedBypass: true }, w);
    }

    // Resolve release channel from the PR *target* branch — that determines
    // the npm dist-tag (e.g. main → latest, develop → beta).
    const targetChannelEnum: ReleaseChannel = resolveChannelFromBranch(prTargetBranch);
    const resolvedChannel = channelToDistTag(targetChannelEnum);

    // Validate version string matches the channel implied by the PR target.
    // Fails fast BEFORE any branch cut, commit, push, or PR is performed.
    if (!force) {
      const channelCheck = validateVersionChannel(cleanVersion, targetChannelEnum);
      if (!channelCheck.valid) {
        logStep(
          1,
          12,
          'Validate version against channel',
          false,
          `${channelCheck.message} (target=${prTargetBranch})`,
        );
        return engineError(
          'E_VALIDATION',
          `Version "${cleanVersion}" does not match channel "${resolvedChannel}" ` +
            `(PR target branch=${prTargetBranch}). ${channelCheck.message} ` +
            `Pass --force to override (owner-only).`,
          {
            details: {
              version: cleanVersion,
              channel: resolvedChannel,
              prTargetBranch,
              expected: channelCheck.expected,
              actual: channelCheck.actual,
            },
          },
        );
      }
    } else {
      const w = `  ! --force: channel/version validation BYPASSED for target '${prTargetBranch}'.`;
      steps.push(w);
      log.warn({ epicId, prTargetBranch, forcedBypass: true }, w);
    }

    // Step 2: Check epic completeness
    logStep(2, 12, 'Check epic completeness');
    let releaseTaskIds: string[] = [];
    try {
      const manifest = await showManifestRelease(version, projectRoot);
      releaseTaskIds = (manifest as { tasks?: string[] }).tasks ?? [];
    } catch {
      // Manifest may not exist yet; proceed
    }

    // Gather all task IDs that have already shipped in prior releases so the
    // completeness guard does not flag them as "missing" from the current release.
    const priorReleasesForGuard = await listManifestReleases(projectRoot);
    const priorReleasedTaskIds = (
      (priorReleasesForGuard as { releases?: Array<{ version: string; tasks?: string[] }> })
        .releases ?? []
    )
      .filter((r) => r.version !== version)
      .flatMap((r) => r.tasks ?? []);

    const epicAccessor = await getTaskAccessor(cwd);
    const epicCheck = await checkEpicCompleteness(
      releaseTaskIds,
      projectRoot,
      epicAccessor,
      priorReleasedTaskIds,
      epicId,
    );
    if (epicCheck.hasIncomplete) {
      const incomplete = epicCheck.epics
        .filter((e) => e.missingChildren.length > 0)
        .map((e) => `${e.epicId}: missing ${e.missingChildren.map((c) => c.id).join(', ')}`)
        .join('; ');
      logStep(2, 12, 'Check epic completeness', false, incomplete);
      return engineError(
        'E_LIFECYCLE_GATE_FAILED',
        `Epic completeness check failed: ${incomplete}`,
        { details: { epics: epicCheck.epics } },
      );
    }
    logStep(2, 12, 'Check epic completeness', true);

    // Step 3: Check for double-listing
    logStep(3, 12, 'Check task double-listing');
    const allReleases = await listManifestReleases(projectRoot);
    const existingReleases = (
      (allReleases as { releases?: Array<{ version: string; tasks?: string[] }> }).releases ?? []
    ).filter((r) => r.version !== version);

    const doubleCheck = checkDoubleListing(
      releaseTaskIds,
      existingReleases.map((r) => ({ version: r.version, tasks: r.tasks ?? [] })),
    );
    if (doubleCheck.hasDoubleListing) {
      const dupes = doubleCheck.duplicates
        .map((d) => `${d.taskId} (in ${d.releases.join(', ')})`)
        .join('; ');
      logStep(3, 12, 'Check task double-listing', false, dupes);
      return engineError('E_VALIDATION', `Double-listing detected: ${dupes}`, {
        details: { duplicates: doubleCheck.duplicates },
      });
    }
    logStep(3, 12, 'Check task double-listing', true);

    // DRY-RUN: preview what would happen and return early
    if (dryRun) {
      logStep(4, 12, 'Generate CHANGELOG');
      logStep(4, 12, 'Generate CHANGELOG', true);

      const filesToStagePreview = [
        'CHANGELOG.md',
        ...(shouldBump ? bumpTargets.map((t) => t.file) : []),
      ];
      const wouldDo: string[] = [];
      if (shouldBump) {
        wouldDo.push(
          `bump version files: ${bumpTargets.map((t) => t.file).join(', ')} → ${version}`,
        );
      }
      wouldDo.push(
        `write CHANGELOG.md: ## [${cleanVersion}] - ${new Date().toISOString().split('T')[0]} (preview only)`,
        `git checkout -b ${releaseBranch}`,
        `git add ${filesToStagePreview.join(' ')}`,
        `git commit -m "release: ship v${cleanVersion} (${epicId})"`,
        `git push -u ${gitRemote} ${releaseBranch}`,
        `gh pr create --base ${prTargetBranch} --head ${releaseBranch} --title "Release v${cleanVersion}"`,
        `gh pr checks <pr-url> --watch (max 15 min)`,
        `gh pr merge <pr-url> --merge`,
        `git checkout ${gitflowCfg.branches.main} && git pull`,
        `git tag -a ${gitTag} -m "Release ${gitTag}"`,
        `git push ${gitRemote} ${gitTag}`,
        `git branch -D ${releaseBranch} && git push ${gitRemote} --delete ${releaseBranch}`,
        'markReleasePushed(...)',
      );

      return {
        success: true,
        data: {
          version,
          epicId,
          dryRun: true,
          channel: resolvedChannel,
          branchModel: branchCfg.branchModel,
          prRequired: branchCfg.prRequired,
          releaseBranch,
          prTargetBranch,
          gitTag,
          wouldDo,
          steps,
        },
      };
    }

    // Step 4: Write CHANGELOG section
    logStep(4, 12, 'Generate CHANGELOG');
    await generateReleaseChangelog(version, () => loadTasks(projectRoot), projectRoot);
    const changelogPath = `${cwd}/CHANGELOG.md`;

    try {
      const changelogContent = readFileSync(changelogPath, 'utf8');
      if (!changelogContent.includes(`## [${cleanVersion}]`)) {
        logStep(
          4,
          12,
          'Generate CHANGELOG',
          false,
          `CHANGELOG.md missing ## [${cleanVersion}] section`,
        );
        return engineError(
          'E_VALIDATION',
          `CHANGELOG.md does not contain ## [${cleanVersion}] after generation.`,
        );
      }
    } catch (err: unknown) {
      const msg = (err as { message?: string }).message ?? String(err);
      logStep(4, 12, 'Generate CHANGELOG', false, `Cannot read CHANGELOG.md: ${msg}`);
      return engineError('E_GENERAL', `Cannot read CHANGELOG.md: ${msg}`);
    }
    logStep(4, 12, 'Generate CHANGELOG', true);

    // Step 4.5: Lint check — warn on errors but don't block release
    try {
      execFileSync('npx', ['biome', 'check', '--no-errors-on-unmatched', cwd], {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 30_000,
      });
      logStep(4, 12, 'Lint check', true);
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      if (execErr.status && execErr.status > 0) {
        const output = (execErr.stdout ?? execErr.stderr ?? '').slice(0, 500);
        const errorMatch = output.match(/Found (\d+) error/);
        const errorCount = errorMatch ? errorMatch[1] : 'unknown';
        logStep(4, 12, 'Lint check', true, `${errorCount} biome warning(s) — non-blocking`);
      }
    }

    const gitCwd = {
      cwd,
      encoding: 'utf-8' as const,
      stdio: 'pipe' as const,
      timeout: 60_000,
    };

    // Step 5: Cut release branch + commit changes on it
    logStep(5, 12, 'Cut release branch and commit');
    try {
      runGitWithLockRetry(['checkout', '-b', releaseBranch], gitCwd);
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string; message?: string }).stderr ??
        (err as { message?: string }).message ??
        String(err);
      logStep(5, 12, 'Cut release branch and commit', false, `git checkout -b failed: ${msg}`);
      return engineError('E_GENERAL', `Failed to create release branch ${releaseBranch}: ${msg}`);
    }

    const filesToStage = ['CHANGELOG.md', ...(shouldBump ? bumpTargets.map((t) => t.file) : [])];
    try {
      runGitWithLockRetry(['add', ...filesToStage], gitCwd);
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string; message?: string }).stderr ??
        (err as { message?: string }).message ??
        String(err);
      logStep(5, 12, 'Cut release branch and commit', false, `git add failed: ${msg}`);
      return engineError('E_GENERAL', `git add failed: ${msg}`);
    }

    try {
      runGitWithLockRetry(['commit', '-m', `release: ship v${cleanVersion} (${epicId})`], gitCwd);
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string; message?: string }).stderr ??
        (err as { message?: string }).message ??
        String(err);
      logStep(5, 12, 'Cut release branch and commit', false, `git commit failed: ${msg}`);
      return engineError('E_GENERAL', `git commit failed: ${msg}`);
    }
    logStep(5, 12, 'Cut release branch and commit', true);

    let commitSha: string | undefined;
    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], gitCwd).toString().trim();
    } catch {
      // Non-fatal
    }

    // Step 6: Push release branch to remote
    logStep(6, 12, 'Push release branch');
    try {
      runGitWithLockRetry(['push', '-u', gitRemote, releaseBranch], gitCwd);
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string; message?: string }).stderr ??
        (err as { message?: string }).message ??
        String(err);
      logStep(6, 12, 'Push release branch', false, `git push failed: ${msg}`);
      return engineError('E_GENERAL', `Failed to push release branch: ${msg}`);
    }
    logStep(6, 12, 'Push release branch', true);

    // Step 7: Create PR via gh CLI (MANDATORY — T9095)
    logStep(7, 12, 'Create PR');
    const prBody = buildPRBody({
      base: prTargetBranch,
      head: releaseBranch,
      title: `Release v${cleanVersion}`,
      body: '',
      version: cleanVersion,
      epicId,
      projectRoot: cwd,
    });

    const requestedLabels = ['release', resolvedChannel];
    const labelResolution = resolvePRLabels(requestedLabels, cwd);
    if (labelResolution.created.length > 0) {
      const m = `  i Auto-created ${labelResolution.created.length} GitHub label(s): ${labelResolution.created.join(', ')}`;
      steps.push(m);
      log.info({ step: 7, createdLabels: labelResolution.created }, m);
    }
    if (labelResolution.missing.length > 0) {
      const m = `  ! Dropped ${labelResolution.missing.length} unknown PR label(s): ${labelResolution.missing.join(', ')}`;
      steps.push(m);
      log.warn({ step: 7, droppedLabels: labelResolution.missing }, m);
    }

    const prResult: PRResult = await createPullRequest({
      base: prTargetBranch,
      head: releaseBranch,
      title: `Release v${cleanVersion}`,
      body: prBody,
      labels: labelResolution.labels,
      version: cleanVersion,
      epicId,
      projectRoot: cwd,
    });

    if (prResult.mode === 'manual') {
      logStep(7, 12, 'Create PR', false, prResult.error ?? 'gh pr create failed');
      return engineError(
        'E_GENERAL',
        `Failed to create PR: ${prResult.error ?? 'gh pr create returned non-zero'}. ` +
          `Fix the error and re-run, or create the PR manually:\n${prResult.instructions ?? ''}`,
      );
    }

    const prUrl = prResult.prUrl ?? '';
    if (prResult.mode === 'skipped') {
      const m = `  PR already exists: ${prUrl}`;
      steps.push(m);
      log.info({ step: 7, prMode: 'skipped', prUrl }, m);
    } else {
      const m = `  PR created: ${prUrl}`;
      steps.push(m);
      log.info({ step: 7, prMode: 'created', prUrl }, m);
    }
    logStep(7, 12, 'Create PR', true);

    // Step 8: Wait for CI checks to pass (15 min max, 30 s poll interval)
    logStep(8, 12, 'Wait for CI checks');
    const ciTimeoutMs = 15 * 60 * 1000;
    const ciPollMs = 30_000;
    const ciStart = Date.now();
    let ciPassed = false;
    let ciSkipped = false;

    if (!prUrl) {
      const w = '  ! No PR URL available — skipping CI wait';
      steps.push(w);
      log.warn({ step: 8 }, w);
      ciSkipped = true;
    } else {
      while (Date.now() - ciStart < ciTimeoutMs) {
        // `gh pr checks --json` exposes `name`/`state`/`bucket` — NOT
        // `status`/`conclusion` (that schema belongs to `gh pr view --json
        // statusCheckRollup`). `bucket` is gh's normalised state and is what
        // we should poll against: 'pass' | 'fail' | 'pending' | 'skipping' |
        // 'cancel'.
        const checksResult = spawnSync(
          'gh',
          ['pr', 'checks', prUrl, '--json', 'name,state,bucket'],
          { cwd, encoding: 'utf-8', timeout: 30_000 },
        );
        if (checksResult.status === 0 && checksResult.stdout) {
          let checks: Array<{ name: string; state: string; bucket: string }> = [];
          try {
            checks = JSON.parse(checksResult.stdout) as typeof checks;
          } catch {
            // malformed JSON — retry
          }
          const isPending = (c: { bucket: string }): boolean => c.bucket === 'pending';
          const isFailed = (c: { bucket: string }): boolean =>
            c.bucket === 'fail' || c.bucket === 'cancel';
          const allDone = checks.length > 0 && !checks.some(isPending);
          const anyFailed = checks.some(isFailed);
          if (anyFailed) {
            const failed = checks
              .filter(isFailed)
              .map((c) => `${c.name} (${c.bucket}/${c.state})`)
              .join(', ');
            logStep(8, 12, 'Wait for CI checks', false, `CI failed: ${failed}`);
            return engineError(
              'E_LIFECYCLE_GATE_FAILED',
              `CI checks failed on PR ${prUrl}: ${failed}. Fix the failures and re-run \`cleo release pr-status ${cleanVersion}\` to poll.`,
              { details: { prUrl, failedChecks: failed } },
            );
          }
          if (allDone) {
            ciPassed = true;
            break;
          }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, ciPollMs));
      }

      if (!ciPassed && !ciSkipped) {
        const elapsedMin = Math.round((Date.now() - ciStart) / 60_000);
        const m = `  ! CI checks did not complete within ${elapsedMin} min — proceeding anyway. Poll with: cleo release pr-status ${cleanVersion}`;
        steps.push(m);
        log.warn({ step: 8, prUrl, elapsedMin }, m);
        ciSkipped = true;
      } else if (ciPassed) {
        logStep(8, 12, 'Wait for CI checks', true);
      }
    }

    // Step 9: Merge PR with --merge (preserves commit SHAs)
    logStep(9, 12, 'Merge PR');
    if (prUrl) {
      try {
        execFileSync('gh', ['pr', 'merge', prUrl, '--merge', '--auto'], {
          ...gitCwd,
          timeout: 60_000,
        });
        logStep(9, 12, 'Merge PR', true);
      } catch (err: unknown) {
        const msg =
          (err as { stderr?: string; message?: string }).stderr ??
          (err as { message?: string }).message ??
          String(err);
        if (msg.includes('auto')) {
          try {
            execFileSync('gh', ['pr', 'merge', prUrl, '--merge'], { ...gitCwd, timeout: 60_000 });
            logStep(9, 12, 'Merge PR', true);
          } catch (err2: unknown) {
            const msg2 =
              (err2 as { stderr?: string; message?: string }).stderr ??
              (err2 as { message?: string }).message ??
              String(err2);
            logStep(9, 12, 'Merge PR', false, msg2.slice(0, 300));
            return engineError('E_GENERAL', `Failed to merge PR: ${msg2}`, { details: { prUrl } });
          }
        } else {
          logStep(9, 12, 'Merge PR', false, msg.slice(0, 300));
          return engineError('E_GENERAL', `Failed to merge PR: ${msg}`, { details: { prUrl } });
        }
      }
    } else {
      const m = '  ! No PR URL — skipping merge step';
      steps.push(m);
      log.warn({ step: 9 }, m);
    }

    // Step 10: Tag from main + push tag (idempotent: re-running on an
    // already-tagged release succeeds when the existing tag points at HEAD).
    logStep(10, 12, 'Tag from main and push');
    try {
      runGitWithLockRetry(['checkout', gitflowCfg.branches.main], gitCwd);
      runGitWithLockRetry(['pull', gitRemote, gitflowCfg.branches.main], gitCwd);

      // Resolve HEAD so we can compare against any pre-existing tag
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], gitCwd).toString().trim();

      // Check if the tag already exists locally
      let existingTagSha: string | undefined;
      try {
        existingTagSha = execFileSync('git', ['rev-list', '-n', '1', gitTag], gitCwd)
          .toString()
          .trim();
      } catch {
        // Tag does not exist locally — fall through to create it
      }

      if (existingTagSha) {
        if (existingTagSha === headSha) {
          const m = `  i Tag ${gitTag} already exists at HEAD (${headSha.slice(0, 8)}) — skipping create`;
          steps.push(m);
          log.info({ step: 10, gitTag, headSha }, m);
        } else {
          logStep(
            10,
            12,
            'Tag from main and push',
            false,
            `tag ${gitTag} already exists but points at ${existingTagSha.slice(0, 8)} (expected HEAD ${headSha.slice(0, 8)})`,
          );
          return engineError(
            'E_GENERAL',
            `Tag ${gitTag} already exists at ${existingTagSha} but HEAD is ${headSha}. ` +
              `Delete the stale tag (\`git tag -d ${gitTag} && git push origin :refs/tags/${gitTag}\`) and re-run.`,
            { details: { gitTag, headSha, existingTagSha } },
          );
        }
      } else {
        runGitWithLockRetry(['tag', '-a', gitTag, '-m', `Release ${gitTag}`], gitCwd);
      }

      // Push the tag. If it already exists on remote at the same SHA, gh treats
      // it as a no-op; if it exists at a different SHA, push fails (correctly).
      try {
        runGitWithLockRetry(['push', gitRemote, gitTag], gitCwd);
      } catch (pushErr: unknown) {
        const pushMsg =
          (pushErr as { stderr?: string; message?: string }).stderr ??
          (pushErr as { message?: string }).message ??
          String(pushErr);
        if (/already exists|up-to-date|stale/i.test(pushMsg)) {
          // Confirm the remote tag matches HEAD before declaring success
          let remoteTagSha = '';
          try {
            const out = execFileSync('git', ['ls-remote', '--tags', gitRemote, gitTag], gitCwd)
              .toString()
              .trim();
            remoteTagSha = out.split(/\s+/)[0] ?? '';
          } catch {
            // ignore
          }
          if (remoteTagSha && remoteTagSha === headSha) {
            const m = `  i Tag ${gitTag} already on remote at HEAD — push is no-op`;
            steps.push(m);
            log.info({ step: 10, gitTag, remoteTagSha }, m);
          } else {
            throw pushErr;
          }
        } else {
          throw pushErr;
        }
      }
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string; message?: string }).stderr ??
        (err as { message?: string }).message ??
        String(err);
      logStep(10, 12, 'Tag from main and push', false, msg.slice(0, 300));
      return engineError('E_GENERAL', `Failed to tag or push tag: ${msg}`, { details: { gitTag } });
    }
    logStep(10, 12, 'Tag from main and push', true);

    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], gitCwd).toString().trim();
    } catch {
      // Non-fatal
    }

    // Step 11: Cleanup release branch (local + remote)
    logStep(11, 12, 'Cleanup release branch');
    try {
      runGitWithLockRetry(['branch', '-D', releaseBranch], gitCwd);
    } catch {
      // Local branch may already be gone; non-fatal
    }
    try {
      runGitWithLockRetry(['push', gitRemote, '--delete', releaseBranch], gitCwd);
    } catch {
      // Remote branch may already be deleted by GitHub on PR merge; non-fatal
    }
    logStep(11, 12, 'Cleanup release branch', true);

    // Step 12: Record provenance
    const pushedAt = new Date().toISOString();
    await markReleasePushed(version, pushedAt, projectRoot, { commitSha, gitTag });

    const compositionChain = resolveCompositionChain(cwd);
    if (compositionChain.subProtocols.length > 0) {
      const list = compositionChain.subProtocols.join(' → ');
      const m = `  ✓ Composition chain expected: release → ${list}`;
      steps.push(m);
      log.info({ step: 12, subProtocols: compositionChain.subProtocols }, m);
      for (const note of compositionChain.notes) {
        const n = `    · ${note}`;
        steps.push(n);
        log.info({ step: 12, note }, n);
      }
    } else {
      const m = `  · Source-only release — no artifact-publish or provenance sub-protocols`;
      steps.push(m);
      log.info({ step: 12, subProtocols: [], artifactType: compositionChain.artifactType }, m);
    }

    return {
      success: true,
      data: {
        version,
        epicId,
        commitSha,
        gitTag,
        pushedAt,
        changelog: changelogPath,
        channel: resolvedChannel,
        branchModel: branchCfg.branchModel,
        releaseBranch,
        prTargetBranch,
        composition: compositionChain,
        steps,
        pr: { mode: prResult.mode, prUrl: prResult.prUrl, prNumber: prResult.prNumber },
      },
    };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message ?? String(err));
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

  const cwd = projectRoot ?? resolveProjectRoot();

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
