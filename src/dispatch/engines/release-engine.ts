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
import { resolveProjectRoot } from '../../core/platform.js';
import { getAccessor } from '../../store/data-accessor.js';
import {
  prepareRelease,
  generateReleaseChangelog,
  listManifestReleases,
  showManifestRelease,
  commitRelease,
  tagRelease,
  runReleaseGates,
  rollbackRelease,
  pushRelease,
  markReleasePushed,
  type ReleaseTaskRecord,
} from '../../core/release/release-manifest.js';

import { writeChangelogSection } from '../../core/release/changelog-writer.js';
import { checkEpicCompleteness, checkDoubleListing } from '../../core/release/guards.js';

import { engineError, type EngineResult } from './_error.js';

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
    const taskFile = await accessor.loadTaskFile();
    return (taskFile?.tasks as ReleaseTaskRecord[]) ?? [];
  } catch (error: unknown) {
    throw new Error(`Failed to load task data: ${(error as Error).message}`);
  }
}

/**
 * release.prepare - Prepare a release
 * @task T4788
 */
export async function releasePrepare(
  version: string,
  tasks?: string[],
  notes?: string,
  projectRoot?: string
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
  projectRoot?: string
): Promise<EngineResult> {
  try {
    const data = await generateReleaseChangelog(
      version,
      () => loadTasks(projectRoot),
      projectRoot,
    );
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
  projectRoot?: string
): Promise<EngineResult> {
  try {
    const data = await listManifestReleases(projectRoot);
    return { success: true, data };
  } catch (err: unknown) {
    return engineError('E_LIST_FAILED', (err as Error).message);
  }
}

/**
 * release.show - Show release details (query operation via data read)
 * @task T4788
 */
export async function releaseShow(
  version: string,
  projectRoot?: string
): Promise<EngineResult> {
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
export async function releaseCommit(
  version: string,
  projectRoot?: string
): Promise<EngineResult> {
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
export async function releaseTag(
  version: string,
  projectRoot?: string
): Promise<EngineResult> {
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
  projectRoot?: string
): Promise<EngineResult> {
  try {
    const data = await runReleaseGates(
      version,
      () => loadTasks(projectRoot),
      projectRoot,
    );
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
  projectRoot?: string
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
      return engineError('E_PROTOCOL_RELEASE',
        `Agent protocol violation: no release manifest entry for '${version}'. ` +
        'Use the full release.ship workflow (release.prepare -> release.commit -> release.tag -> release.push) ' +
        'to ensure provenance tracking. Direct release.push is not allowed in agent context without a manifest entry.',
        {
          fix: `ct release add ${version} && ct release ship ${version} --push`,
          alternatives: [
            { action: 'Prepare release first', command: `ct release add ${version}` },
            { action: 'Use full ship workflow', command: `ct release ship ${version} --push` },
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
      }).toString().trim();
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
    if (execError.message?.includes('disabled by config') || execError.message?.includes('not in allowed branches') || execError.message?.includes('not clean')) {
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
 * write CHANGELOG → git commit/tag/push → record provenance
 *
 * @task T5582
 * @epic T5576
 */
export async function releaseShip(
  params: {
    version: string;
    epicId: string;
    remote?: string;
    dryRun?: boolean;
  },
  projectRoot?: string,
): Promise<EngineResult> {
  const { version, epicId, remote, dryRun = false } = params;

  if (!version) {
    return engineError('E_INVALID_INPUT', 'version is required');
  }
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  const cwd = projectRoot ?? resolveProjectRoot();

  try {
    // Step 1: Run release gates
    const gatesResult = await runReleaseGates(
      version,
      () => loadTasks(projectRoot),
      projectRoot,
    );

    if (gatesResult && !gatesResult.allPassed) {
      const failedGates = gatesResult.gates.filter((g) => g.status === 'failed');
      return engineError('E_LIFECYCLE_GATE_FAILED', `Release gates failed for ${version}: ${failedGates.map((g) => g.name).join(', ')}`, {
        details: { gates: gatesResult.gates, failedCount: gatesResult.failedCount },
      });
    }

    // Step 2: Check epic completeness — load release tasks from manifest
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
      return engineError('E_LIFECYCLE_GATE_FAILED', `Epic completeness check failed: ${incomplete}`, {
        details: { epics: epicCheck.epics },
      });
    }

    // Step 3: Check for double-listing
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
      return engineError('E_VALIDATION', `Double-listing detected: ${dupes}`, {
        details: { duplicates: doubleCheck.duplicates },
      });
    }

    // Step 4: Write CHANGELOG section
    const changelogResult = await generateReleaseChangelog(
      version,
      () => loadTasks(projectRoot),
      projectRoot,
    );
    const changelogPath = `${cwd}/CHANGELOG.md`;
    const generatedContent = (changelogResult as { changelog?: string }).changelog ?? '';

    if (dryRun) {
      return {
        success: true,
        data: {
          version,
          epicId,
          dryRun: true,
          wouldDo: [
            `write CHANGELOG section for ${version} (${generatedContent.length} chars)`,
            'git add CHANGELOG.md',
            `git commit -m "release: ship v${version} (${epicId})"`,
            `git tag -a v${version} -m "Release v${version}"`,
            `git push ${remote ?? 'origin'} --follow-tags`,
            'markReleasePushed(...)',
          ],
        },
      };
    }

    await writeChangelogSection(version, generatedContent, [], changelogPath);

    // Step 5: Git operations
    const gitCwd = { cwd, encoding: 'utf-8' as const, stdio: 'pipe' as const };

    try {
      execFileSync('git', ['add', 'CHANGELOG.md'], gitCwd);
    } catch (err: unknown) {
      const msg = (err as { message?: string }).message ?? String(err);
      return engineError('E_GENERAL', `git add failed: ${msg}`);
    }

    try {
      execFileSync(
        'git',
        ['commit', '-m', `release: ship v${version} (${epicId})`],
        gitCwd,
      );
    } catch (err: unknown) {
      const msg = (err as { stderr?: string; message?: string }).stderr
        ?? (err as { message?: string }).message
        ?? String(err);
      return engineError('E_GENERAL', `git commit failed: ${msg}`);
    }

    let commitSha: string | undefined;
    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], gitCwd).toString().trim();
    } catch {
      // Non-fatal
    }

    const gitTag = `v${version.replace(/^v/, '')}`;
    try {
      execFileSync('git', ['tag', '-a', gitTag, '-m', `Release ${gitTag}`], gitCwd);
    } catch (err: unknown) {
      const msg = (err as { stderr?: string; message?: string }).stderr
        ?? (err as { message?: string }).message
        ?? String(err);
      return engineError('E_GENERAL', `git tag failed: ${msg}`);
    }

    try {
      execFileSync('git', ['push', remote ?? 'origin', '--follow-tags'], gitCwd);
    } catch (err: unknown) {
      const execError = err as { status?: number; stderr?: string; message?: string };
      const msg = (execError.stderr ?? execError.message ?? '').slice(0, 500);
      return engineError('E_GENERAL', `git push failed: ${msg}`, {
        details: { exitCode: execError.status },
      });
    }

    // Step 6: Record provenance
    const pushedAt = new Date().toISOString();
    await markReleasePushed(version, pushedAt, projectRoot, { commitSha, gitTag });

    return {
      success: true,
      data: {
        version,
        epicId,
        commitSha,
        gitTag,
        pushedAt,
        changelog: changelogPath,
      },
    };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message ?? String(err));
  }
}
