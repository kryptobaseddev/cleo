/**
 * S1 — Happy-path release (test-matrix-T9345 §2.1).
 *
 * Acceptance criteria covered:
 *
 * - A1: pipeline runs end-to-end with no failures injected
 * - A2 / A3: applies across all 3 archetypes (monorepo, npm-lib, rust-crate)
 *
 * Forensics: none — this scenario is the baseline. All other S2..S10
 * scenarios mutate from this happy path.
 *
 * The test asserts:
 *
 * 1. Synthetic plan parses cleanly against `ReleasePlanSchema`.
 * 2. Plan has the requested tasks, gates, and platform matrix.
 * 3. After a stubbed reconcile, status advances to `reconciled` and
 *    `mergeCommitSha` is populated from the mock-gh response.
 *
 * @task T9543
 */

import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReleasePlanSchema } from '@cleocode/contracts';
import { runPlanForFixture, runReconcileForFixture } from './_helpers/fixture-runner.js';
import { installGhMock, mockGhPrView } from './_helpers/mock-gh.js';
import type { SyntheticArchetype } from './_helpers/synthetic-release.js';

const ARCHETYPES: SyntheticArchetype[] = ['monorepo', 'npm-lib', 'rust-crate'];

describe('S1 — Happy-path release [forensics: none]', () => {
  let mockHandle: ReturnType<typeof installGhMock>;

  beforeEach(() => {
    mockHandle = installGhMock();
  });

  afterEach(() => {
    mockHandle.restore();
  });

  for (const archetype of ARCHETYPES) {
    it(`[${archetype}] AC1: plan → mock open → mock publish → reconcile end-to-end`, () => {
      const result = runPlanForFixture({ archetype, taskCount: 3 });
      try {
        expect(() => ReleasePlanSchema.parse(result.plan)).not.toThrow();
        expect(result.plan.tasks).toHaveLength(3);
        expect(result.plan.status).toBe('planned');
        expect(result.plan.gates.length).toBeGreaterThan(0);
        expect(result.plan.platformMatrix.length).toBeGreaterThan(0);

        const mergeOid = result.synth.commits.at(-1) ?? '';
        mockGhPrView({ state: 'MERGED', mergeCommitOid: mergeOid });

        const reconciled = runReconcileForFixture({
          synth: result.synth,
          mergeCommitSha: mergeOid,
        });
        expect(reconciled.plan.status).toBe('reconciled');
        expect(reconciled.plan.mergeCommitSha).toBe(mergeOid);
      } finally {
        rmSync(result.synth.tmpDir, { recursive: true, force: true });
      }
    });
  }
});
