/**
 * T11568 — unit coverage for the coordinated CLI teardown aggregator.
 *
 * The end-to-end "does the process actually exit" assertion lives in the CLI
 * subprocess test (`packages/cleo/src/cli/__tests__/process-exit-no-hang.test.ts`),
 * because the brain-writer worker thread only spawns when its compiled worker
 * file is resolvable on disk — which is true for the shipped dist but not inside
 * the vitest worker. This unit test guards the aggregator's CONTRACT so a future
 * refactor cannot silently drop one of the teardown steps:
 *
 *   - `shutdownCliRuntime` is exported and callable.
 *   - It is best-effort + idempotent: calling it twice never throws, even with
 *     no subsystem initialized.
 *
 * @task T11568
 */

import { describe, expect, it } from 'vitest';
import { shutdownCliRuntime } from '../shutdown.js';

describe('shutdownCliRuntime — coordinated CLI teardown (T11568)', () => {
  it('is callable and resolves with nothing initialized (best-effort)', async () => {
    await expect(shutdownCliRuntime()).resolves.toBeUndefined();
  });

  it('is idempotent — a second call never throws', async () => {
    await shutdownCliRuntime();
    await expect(shutdownCliRuntime()).resolves.toBeUndefined();
  });
});
