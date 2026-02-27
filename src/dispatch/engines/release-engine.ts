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

import { resolveProjectRoot, readJsonFile, getDataPath } from '../../core/platform.js';
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

import { engineError, type EngineResult } from './_error.js';

/**
 * Load tasks via DataAccessor (SQLite or JSON depending on engine config).
 * When projectRoot is explicitly provided (e.g., in tests), uses direct
 * JSON read to avoid requiring full CLEO initialization.
 */
async function loadTasks(projectRoot?: string): Promise<ReleaseTaskRecord[]> {
  if (projectRoot) {
    const taskPath = getDataPath(projectRoot, 'todo.json');
    const taskData = readJsonFile<{ tasks: ReleaseTaskRecord[] }>(taskPath);
    return taskData?.tasks ?? [];
  }
  try {
    const accessor = await getAccessor();
    const taskFile = await accessor.loadTaskFile();
    return (taskFile?.tasks as ReleaseTaskRecord[]) ?? [];
  } catch {
    const root = resolveProjectRoot();
    const taskPath = getDataPath(root, 'todo.json');
    const taskData = readJsonFile<{ tasks: ReleaseTaskRecord[] }>(taskPath);
    return taskData?.tasks ?? [];
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
 * @task T4788
 */
export async function releasePush(
  version: string,
  remote?: string,
  projectRoot?: string
): Promise<EngineResult> {
  try {
    const result = pushRelease(version, remote, projectRoot);
    // Update the manifest to record pushed status
    await markReleasePushed(result.version, result.pushedAt, projectRoot);
    return { success: true, data: result };
  } catch (err: unknown) {
    const execError = err as { status?: number; stderr?: string; message?: string };
    return engineError('E_GENERAL', `Git push failed: ${(execError.stderr ?? execError.message ?? '').slice(0, 500)}`, {
      details: { exitCode: execError.status },
    });
  }
}
