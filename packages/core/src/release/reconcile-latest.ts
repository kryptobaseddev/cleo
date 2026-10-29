/**
 * Automatic provenance for cut releases (T14102 · ADR-099): the T14101 merge
 * sweep calls {@link reconcileLatestRelease}, so a release never depends on
 * someone remembering `cleo release reconcile`. Kept apart from `cut.ts` so
 * the sweep's write path does not pull in the release planner.
 *
 * @task T14102
 */

import { execFileSync } from 'node:child_process';
import type { MergeSweepReconcile } from '@cleocode/contracts/merge-close.js';
import { eq } from 'drizzle-orm';
import { getDb } from '../store/sqlite.js';
import * as schema from '../store/tasks-schema.js';
import type { ReleaseCutRunner } from './cut.js';
import { releaseReconcileV2 } from './reconcile.js';

const run = (bin: string) => (args: readonly string[], cwd: string) =>
  execFileSync(bin, [...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  }).trim();

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
  runner: ReleaseCutRunner = { runGh: run('gh'), runGit: run('git') },
): Promise<MergeSweepReconcile> {
  try {
    runner.runGit(['fetch', '--quiet', '--tags', 'origin'], projectRoot);
  } catch {
    // Offline: judge the tags already present.
  }
  // Stable tags only (no `-` suffix), newest by git's version sort.
  const version =
    runner
      .runGit(['tag', '--merged', 'origin/main', '--list', 'v*', '--sort=-v:refname'], projectRoot)
      .split('\n')
      .map((t) => t.trim())
      .find((t) => /^v\d+(\.\d+){1,3}$/.test(t)) ?? null;
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
