/**
 * Release Engine
 *
 * Thin wrapper around core release manifest operations.
 * Business logic lives in src/core/release/release-manifest.ts.
 *
 * Note: Some operations (push, rollback) inherently require git CLI.
 * Those are handled as hybrid operations - native for data, CLI for git.
 *
 * @task T4788
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  buildPRBody,
  bumpVersionFromConfig,
  cancelRelease,
  channelToDistTag,
  checkDoubleListing,
  checkEpicCompleteness,
  commitRelease,
  createPullRequest,
  generateReleaseChangelog,
  getAccessor,
  getGitFlowConfig,
  getIvtrState,
  getPushMode,
  getVersionBumpConfig,
  isGhCliAvailable,
  listManifestReleases,
  loadReleaseConfig,
  markReleasePushed,
  type PRResult,
  prepareRelease,
  pushRelease,
  type ReleaseListOptions,
  type ReleaseTaskRecord,
  resolveChannelFromBranch,
  resolveProjectRoot,
  rollbackRelease,
  runReleaseGates,
  showManifestRelease,
  tagRelease,
} from '@cleocode/core/internal';

import { type EngineResult, engineError } from './_error.js';

/**
 * Detect whether the current execution context is an AI agent.
 * Checks for CLEO_SESSION_ID or CLAUDE_AGENT_TYPE environment variables.
 * @task T4279
 */
function isAgentContext(): boolean {
  return !!(process.env['CLEO_SESSION_ID'] || process.env['CLAUDE_AGENT_TYPE']);
}

/**
 * Verify that a release manifest entry exists for the given version.
 * Used as a protocol guard to ensure agents go through the proper
 * release.ship workflow rather than calling release.push directly.
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
    const accessor = await getAccessor(root);
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
 * release.prepare - Prepare a release
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
 * release.changelog - Generate changelog
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
 * release.list - List all releases (query operation via data read)
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
 * release.show - Show release details (query operation via data read)
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
 * release.commit - Mark release as committed (metadata only)
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
 * release.tag - Mark release as tagged (metadata only)
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
 * release.gates.run - Run release gates (validation checks)
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
 * release.rollback - Rollback a release
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
 * release.rollback.full - Full rollback: delete git tag, revert commit,
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
  const gitCwd = { cwd, encoding: 'utf-8' as const, stdio: 'pipe' as const };
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
 * Parse commit messages from `git log` output, extracting task/epic IDs.
 *
 * Returns a structured list of commits grouped by referenced task IDs.
 *
 * @task T820 RELEASE-02
 */
interface ParsedCommit {
  sha: string;
  message: string;
  taskIds: string[];
  epicIds: string[];
  timestamp: string;
}

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

/**
 * release.changelog.since - Auto-CHANGELOG from git log since last tag.
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
 * release.cancel - Cancel and remove a release in draft or prepared state
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
 * release.push - Push release to remote via git
 * Uses execFileSync (no shell) for safety.
 * Respects config.release.push policy.
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
 * release.ship - Composite release operation
 *
 * Sequence: validate gates → epic completeness → double-listing check →
 * write CHANGELOG → git commit/tag/push (or PR) → record provenance
 *
 * @task T5582
 * @task T5586
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

  /** Collected step log messages, included in every return value for CLI visibility. */
  const steps: string[] = [];

  /** Emit a step line for each release stage. Pushes to steps[] and console.log for CLI. */
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
    } else if (done) {
      msg = `  ✓ ${label}`;
    } else {
      msg = `  ✗ ${label}: ${error ?? 'failed'}`;
    }
    steps.push(msg);
    console.log(msg);
  };

  const bumpTargets = getVersionBumpConfig(cwd);
  const shouldBump = bump && bumpTargets.length > 0;

  try {
    // Step 0: Bump version files (if configured and bump not disabled)
    if (shouldBump) {
      logStep(0, 8, 'Bump version files');
      if (!dryRun) {
        const bumpResults = bumpVersionFromConfig(version, { dryRun: false }, cwd);
        if (!bumpResults.allSuccess) {
          const failed = bumpResults.results.filter((r) => !r.success).map((r) => r.file);
          steps.push(`  ! Version bump partial: failed for ${failed.join(', ')}`);
        } else {
          logStep(0, 8, 'Bump version files', true);
        }
      } else {
        logStep(0, 8, 'Bump version files', true);
      }
    }

    // Step 0.5: Ensure release record exists (auto-prepare if needed)
    // Since T5615 removed release.add/plan, ship must be self-contained
    try {
      await showManifestRelease(version, cwd);
    } catch {
      // Release record doesn't exist yet — create it
      logStep(0, 8, 'Auto-prepare release record');
      if (!dryRun) {
        await prepareRelease(
          version,
          undefined,
          `Auto-prepared by release.ship (${epicId})`,
          () => loadTasks(projectRoot),
          cwd,
        );
        // Set epicId on the newly created record (prepareRelease doesn't accept it)
        const { getDb } = await import('@cleocode/core/internal');
        const { releaseManifests } = await import('@cleocode/core/internal');
        const { eq } = await import('drizzle-orm');
        const normalizedVer = version.startsWith('v') ? version : `v${version}`;
        const db = await getDb(cwd);
        await db
          .update(releaseManifests)
          .set({ epicId })
          .where(eq(releaseManifests.version, normalizedVer))
          .run();

        // Pre-generate changelog so has_changelog gate passes
        await generateReleaseChangelog(version, () => loadTasks(projectRoot), cwd);
      }
      logStep(0, 8, 'Auto-prepare release record', true);
    }

    // Step 1: Run release gates
    logStep(1, 8, 'Validate release gates');
    const gatesResult = await runReleaseGates(version, () => loadTasks(projectRoot), projectRoot, {
      dryRun,
    });

    if (gatesResult && !gatesResult.allPassed) {
      const failedGates = gatesResult.gates.filter((g) => g.status === 'failed');
      logStep(1, 8, 'Validate release gates', false, failedGates.map((g) => g.name).join(', '));
      return engineError(
        'E_LIFECYCLE_GATE_FAILED',
        `Release gates failed for ${version}: ${failedGates.map((g) => g.name).join(', ')}`,
        {
          details: { gates: gatesResult.gates, failedCount: gatesResult.failedCount },
        },
      );
    }
    logStep(1, 8, 'Validate release gates', true);

    // Step 1.5 (T820 RELEASE-03): IVTR gate enforcement
    // Load epic task IDs to check their IVTR state before proceeding.
    // --force bypasses with a loud warning.
    if (!force) {
      logStep(1, 8, 'Check IVTR gate for epic tasks');
      let epicTaskIds: string[] = [];
      try {
        const epicAccessorForIvtr = await getAccessor(cwd);
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
            8,
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
          // Warn but don't block — tasks without IVTR are allowed (e.g. docs tasks)
          const w = `  ! IVTR gate: ${unchecked.length} task(s) have no IVTR state (non-blocking): ${unchecked.join(', ')}`;
          steps.push(w);
          console.log(w);
        }
        logStep(1, 8, 'Check IVTR gate for epic tasks', true);
      } else {
        logStep(1, 8, 'Check IVTR gate for epic tasks', true);
      }
    } else {
      const w = `  ! --force: IVTR gate check BYPASSED. Owner-level override only.`;
      steps.push(w);
      console.warn(w);
    }

    // Resolve release channel from current branch (after gates, which read the branch)
    let resolvedChannel: string = 'latest';
    let currentBranchForPR = 'HEAD';
    try {
      const branchName = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
      currentBranchForPR = branchName;
      const channelEnum = resolveChannelFromBranch(branchName);
      resolvedChannel = channelToDistTag(channelEnum);
    } catch {
      // git unavailable — keep default
    }

    // Prefer metadata from gates result if available (B4 populates this)
    const gateMetadata = gatesResult.metadata;
    const requiresPRFromGates = gateMetadata?.requiresPR ?? false;
    const targetBranchFromGates = gateMetadata?.targetBranch;
    if (gateMetadata?.currentBranch) {
      currentBranchForPR = gateMetadata.currentBranch;
    }

    // Step 2: Check epic completeness — load release tasks from manifest
    logStep(2, 8, 'Check epic completeness');
    let releaseTaskIds: string[] = [];
    try {
      const manifest = await showManifestRelease(version, projectRoot);
      releaseTaskIds = (manifest as { tasks?: string[] }).tasks ?? [];
    } catch {
      // Manifest may not exist yet if prepare hasn't been called; proceed
    }

    const epicAccessor = await getAccessor(cwd);
    const epicCheck = await checkEpicCompleteness(releaseTaskIds, projectRoot, epicAccessor);
    if (epicCheck.hasIncomplete) {
      const incomplete = epicCheck.epics
        .filter((e) => e.missingChildren.length > 0)
        .map((e) => `${e.epicId}: missing ${e.missingChildren.map((c) => c.id).join(', ')}`)
        .join('; ');
      logStep(2, 8, 'Check epic completeness', false, incomplete);
      return engineError(
        'E_LIFECYCLE_GATE_FAILED',
        `Epic completeness check failed: ${incomplete}`,
        {
          details: { epics: epicCheck.epics },
        },
      );
    }
    logStep(2, 8, 'Check epic completeness', true);

    // Step 3: Check for double-listing
    logStep(3, 8, 'Check task double-listing');
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
      logStep(3, 8, 'Check task double-listing', false, dupes);
      return engineError('E_VALIDATION', `Double-listing detected: ${dupes}`, {
        details: { duplicates: doubleCheck.duplicates },
      });
    }
    logStep(3, 8, 'Check task double-listing', true);

    // Resolve push mode for dry-run and PR logic
    const loadedConfig = loadReleaseConfig(cwd);
    const pushMode = getPushMode(loadedConfig);
    const gitflowCfg = getGitFlowConfig(loadedConfig);
    const targetBranch = targetBranchFromGates ?? gitflowCfg.branches.main;

    if (dryRun) {
      // Step 4 (dry-run): Preview CHANGELOG generation without writing to disk
      logStep(4, 8, 'Generate CHANGELOG');
      logStep(4, 8, 'Generate CHANGELOG', true);

      const wouldCreatePR = requiresPRFromGates || pushMode === 'pr';
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
        `write CHANGELOG.md: ## [${version}] - ${new Date().toISOString().split('T')[0]} (preview only, not written in dry-run)`,
        `git add ${filesToStagePreview.join(' ')}`,
        `git commit -m "release: ship v${version} (${epicId})"`,
        `git tag -a v${version} -m "Release v${version}"`,
      );
      const dryRunOutput: Record<string, unknown> = {
        version,
        epicId,
        dryRun: true,
        channel: resolvedChannel,
        pushMode,
        wouldDo,
      };

      if (wouldCreatePR) {
        const ghAvailable = isGhCliAvailable();
        (dryRunOutput['wouldDo'] as string[]).push(
          ghAvailable
            ? `gh pr create --base ${targetBranch} --head ${currentBranchForPR} --title "release: ship v${version}"`
            : `manual PR: ${currentBranchForPR} → ${targetBranch} (gh CLI not available)`,
        );
        dryRunOutput['wouldCreatePR'] = true;
        dryRunOutput['prTitle'] = `release: ship v${version}`;
        dryRunOutput['prTargetBranch'] = targetBranch;
      } else {
        (dryRunOutput['wouldDo'] as string[]).push(`git push ${remote ?? 'origin'} --follow-tags`);
        dryRunOutput['wouldCreatePR'] = false;
      }

      (dryRunOutput['wouldDo'] as string[]).push('markReleasePushed(...)');

      return { success: true, data: { ...dryRunOutput, steps } };
    }

    // Step 4: Write CHANGELOG section (non-dry-run only)
    logStep(4, 8, 'Generate CHANGELOG');
    await generateReleaseChangelog(version, () => loadTasks(projectRoot), projectRoot);
    const changelogPath = `${cwd}/CHANGELOG.md`;

    // Verify CHANGELOG.md actually contains ## [VERSION] — CI will reject without it
    const cleanVersion = version.replace(/^v/, '');
    try {
      const changelogContent = readFileSync(changelogPath, 'utf8');
      if (!changelogContent.includes(`## [${cleanVersion}]`)) {
        logStep(
          4,
          8,
          'Generate CHANGELOG',
          false,
          `CHANGELOG.md missing ## [${cleanVersion}] section`,
        );
        return engineError(
          'E_VALIDATION',
          `CHANGELOG.md does not contain ## [${cleanVersion}] after generation. ` +
            `This will cause the release workflow to fail.`,
        );
      }
    } catch (err: unknown) {
      const msg = (err as { message?: string }).message ?? String(err);
      logStep(4, 8, 'Generate CHANGELOG', false, `Cannot read CHANGELOG.md: ${msg}`);
      return engineError('E_GENERAL', `Cannot read CHANGELOG.md: ${msg}`);
    }
    logStep(4, 8, 'Generate CHANGELOG', true);

    // Step 4.5: Lint check — warn on biome errors but don't block release
    try {
      execFileSync('npx', ['biome', 'check', '--no-errors-on-unmatched', cwd], {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 30_000,
      });
      logStep(4, 8, 'Lint check', true);
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      if (execErr.status && execErr.status > 0) {
        const output = (execErr.stdout ?? execErr.stderr ?? '').slice(0, 500);
        const errorMatch = output.match(/Found (\d+) error/);
        const errorCount = errorMatch ? errorMatch[1] : 'unknown';
        logStep(4, 8, 'Lint check', true, `${errorCount} biome warning(s) — non-blocking`);
      }
    }

    // Step 5: Git commit
    logStep(5, 8, 'Commit release');
    const gitCwd = { cwd, encoding: 'utf-8' as const, stdio: 'pipe' as const };

    const filesToStage = ['CHANGELOG.md', ...(shouldBump ? bumpTargets.map((t) => t.file) : [])];
    try {
      execFileSync('git', ['add', ...filesToStage], gitCwd);
    } catch (err: unknown) {
      const msg = (err as { message?: string }).message ?? String(err);
      logStep(5, 8, 'Commit release', false, `git add failed: ${msg}`);
      return engineError('E_GENERAL', `git add failed: ${msg}`);
    }

    try {
      execFileSync('git', ['commit', '-m', `release: ship v${version} (${epicId})`], gitCwd);
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string; message?: string }).stderr ??
        (err as { message?: string }).message ??
        String(err);
      logStep(5, 8, 'Commit release', false, `git commit failed: ${msg}`);
      return engineError('E_GENERAL', `git commit failed: ${msg}`);
    }
    logStep(5, 8, 'Commit release', true);

    let commitSha: string | undefined;
    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], gitCwd).toString().trim();
    } catch {
      // Non-fatal
    }

    // Step 6: Tag release
    logStep(6, 8, 'Tag release');
    const gitTag = `v${version.replace(/^v/, '')}`;
    try {
      execFileSync('git', ['tag', '-a', gitTag, '-m', `Release ${gitTag}`], gitCwd);
    } catch (err: unknown) {
      const msg =
        (err as { stderr?: string; message?: string }).stderr ??
        (err as { message?: string }).message ??
        String(err);
      logStep(6, 8, 'Tag release', false, `git tag failed: ${msg}`);
      return engineError('E_GENERAL', `git tag failed: ${msg}`);
    }
    logStep(6, 8, 'Tag release', true);

    // Step 7: Push or create PR
    logStep(7, 8, 'Push / create PR');
    let prResult: PRResult | null = null;

    // First attempt the core pushRelease (which may signal requiresPR)
    const pushResult = await pushRelease(version, remote, projectRoot, {
      explicitPush: true,
      mode: pushMode,
    });

    if (pushResult.requiresPR || requiresPRFromGates) {
      // Branch is protected — create PR instead of direct push
      const prBody = buildPRBody({
        base: targetBranch,
        head: currentBranchForPR,
        title: `release: ship v${version}`,
        body: '',
        version,
        epicId,
        projectRoot: cwd,
      });

      prResult = await createPullRequest({
        base: targetBranch,
        head: currentBranchForPR,
        title: `release: ship v${version}`,
        body: prBody,
        labels: ['release', resolvedChannel],
        version,
        epicId,
        projectRoot: cwd,
      });

      if (prResult.mode === 'created') {
        const m1 = `  ✓ Push / create PR`;
        const m2 = `  PR created: ${prResult.prUrl}`;
        const m3 = `  → Next: merge the PR, then CI will publish to npm @${resolvedChannel}`;
        steps.push(m1, m2, m3);
        console.log(m1);
        console.log(m2);
        console.log(m3);
      } else if (prResult.mode === 'skipped') {
        const m1 = `  ✓ Push / create PR`;
        const m2 = `  PR already exists: ${prResult.prUrl}`;
        steps.push(m1, m2);
        console.log(m1);
        console.log(m2);
      } else {
        const m1 = `  ! Push / create PR — manual PR required:`;
        const m2 = prResult.instructions ?? '';
        steps.push(m1, m2);
        console.log(m1);
        console.log(m2);
      }
    } else {
      // Direct push path (pushRelease already ran, but it skips the actual push
      // when requiresPR is false — so we do the git push here directly)
      try {
        execFileSync('git', ['push', remote ?? 'origin', '--follow-tags'], gitCwd);
        logStep(7, 8, 'Push / create PR', true);
      } catch (err: unknown) {
        const execError = err as { status?: number; stderr?: string; message?: string };
        const msg = (execError.stderr ?? execError.message ?? '').slice(0, 500);
        logStep(7, 8, 'Push / create PR', false, `git push failed: ${msg}`);
        return engineError('E_GENERAL', `git push failed: ${msg}`, {
          details: { exitCode: execError.status },
        });
      }
    }

    // Step 8 (internal): Record provenance for the release manifest entry
    const pushedAt = new Date().toISOString();
    await markReleasePushed(version, pushedAt, projectRoot, { commitSha, gitTag });

    // ────────────────────────────────────────────────────────────────────
    // Step 9: Resolve the cross-cutting sub-protocol composition chain
    //
    // Per release.md (Composition with Cross-Cutting Sub-Protocols) the
    // release protocol is the parent of artifact-publish and provenance.
    // Not every release needs both — source-only releases skip them, and
    // releases with security.enableProvenance=false skip provenance.
    //
    // The actual `npm publish --provenance` still happens in CI (see
    // .github/workflows/release.yml line 295) — this step records the
    // EXPECTED chain so the release manifest entry is linked to the
    // artifact-publish and provenance manifest entries that CI will
    // produce. This satisfies COMP-005 from release.md (full chain
    // traceability) and gives the operator a single command to inspect
    // the planned distribution flow.
    //
    // @task T260 — wire conditional composition with artifact-publish + provenance
    // ────────────────────────────────────────────────────────────────────
    const compositionChain = resolveCompositionChain(cwd);
    if (compositionChain.subProtocols.length > 0) {
      const list = compositionChain.subProtocols.join(' → ');
      const m = `  ✓ Composition chain expected: release → ${list}`;
      steps.push(m);
      console.log(m);
      if (compositionChain.notes.length > 0) {
        for (const note of compositionChain.notes) {
          const n = `    · ${note}`;
          steps.push(n);
          console.log(n);
        }
      }
    } else {
      const m = `  · Source-only release — no artifact-publish or provenance sub-protocols`;
      steps.push(m);
      console.log(m);
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
        composition: compositionChain,
        steps,
        ...(prResult
          ? {
              pr: {
                mode: prResult.mode,
                prUrl: prResult.prUrl,
                prNumber: prResult.prNumber,
                instructions: prResult.instructions,
              },
            }
          : {}),
      },
    };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message ?? String(err));
  }
}

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
 * The CI workflow (`.github/workflows/release.yml`) currently uses
 * `npm publish --provenance` which satisfies the SLSA L3 attestation
 * requirement automatically; this resolver only records the EXPECTED
 * chain so the release manifest entry can be linked to the resulting
 * sub-protocol manifest entries.
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
