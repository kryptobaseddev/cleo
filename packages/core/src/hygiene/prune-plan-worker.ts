/**
 * Worker-thread entry for the census's merged-branch probe (T14440, round 5).
 *
 * A REAL module file, not an eval script: an eval worker inherits the parent's
 * `--input-type=module` (the lazy census child spawns with it), which breaks
 * `require`-based bootstrap. This file is compiled to
 * `dist/hygiene/prune-plan-worker.js` by the standard core build (the hygiene
 * directory is a scanned subpath), so the census resolves it next to itself.
 *
 * The worker runs the synchronous SDK integration probe
 * (`buildGitAwarePrunePlan`) off the main thread so the census can terminate
 * it at the shared wall-clock deadline; it posts `{ plan }` on success and
 * `{ error }` on any failure — a failed probe is never a zero.
 *
 * @task T14440
 */

import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

interface PrunePlanWorkerData {
  /** Module base for resolving the workspace worktree package. */
  requireFrom: string;
  /** The repository root to probe. */
  repoRoot: string;
  /** The branch "merged" is tested against. */
  integrationTarget: string;
  /** Test hook: written markerDelayMs after the walk; absent when terminated. */
  markerPath?: string;
  /** Test hook: how long after the walk the marker is written. */
  markerDelayMs?: number;
}

interface PrunePlanCandidate {
  kind: string;
  branch?: string;
}

interface PrunePlan {
  candidates: PrunePlanCandidate[];
}

const data = workerData as PrunePlanWorkerData;

if (parentPort === null) {
  throw new Error('prune-plan-worker requires a parent port');
}

try {
  const worktree = createRequire(data.requireFrom)('@cleocode/worktree') as {
    buildGitAwarePrunePlan: (repoRoot: string, integrationTarget: string) => PrunePlan | null;
  };
  const plan = worktree.buildGitAwarePrunePlan(data.repoRoot, data.integrationTarget);
  parentPort.postMessage({ plan });
  // Test hook (T14440 round 6): the marker sits behind a timer the worker
  // only reaches after its walk AND the configured delay — a
  // deadline-terminated worker never fires it, and the test waits past the
  // delay before asserting absence.
  if (typeof data.markerPath === 'string') {
    const { writeFileSync } = await import('node:fs');
    const delay = typeof data.markerDelayMs === 'number' ? data.markerDelayMs : 0;
    // No unref: the timer must fire for the test hook; terminate() still kills it.
    setTimeout(() => writeFileSync(data.markerPath as string, 'done'), delay);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  parentPort.postMessage({ error: message });
}
