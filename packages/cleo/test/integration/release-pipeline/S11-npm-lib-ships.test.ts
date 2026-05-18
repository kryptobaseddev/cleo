/**
 * S11 — Project-agnostic: single npm lib ships (test-matrix-T9345 §2.11).
 *
 * Archetype: A2 — release-test-npm-lib.
 *
 * Acceptance criteria covered:
 *
 * - A2 (per SPEC §1.2): pipeline runs end-to-end on a single-package npm
 *   library with no monorepo workspaces and no Rust crates.
 *
 * The test asserts:
 *
 * 1. The npm-lib fixture's release-config.json declares `archetype:
 *    single-npm-lib` and a single-entry platformMatrix.
 * 2. The synthetic plan's platformMatrix matches that single-entry shape.
 * 3. Reconcile against the synthetic merge oid advances status correctly.
 *
 * @task T9543
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fixturePathFor,
  type SyntheticArchetype,
} from './_helpers/synthetic-release.js';
import { runPlanForFixture, runReconcileForFixture } from './_helpers/fixture-runner.js';
import { installGhMock, mockGhPrView } from './_helpers/mock-gh.js';

const ARCHETYPE: SyntheticArchetype = 'npm-lib';

interface ReleaseConfigShape {
  archetype: string;
  platformMatrix: Array<{ publisher: string; package: string; platform: string }>;
}

describe('S11 — npm-lib archetype ships end-to-end [A2]', () => {
  let mockHandle: ReturnType<typeof installGhMock>;

  beforeEach(() => {
    mockHandle = installGhMock();
  });

  afterEach(() => {
    mockHandle.restore();
  });

  it('A2: fixture declares single-npm-lib archetype + 1-entry matrix', () => {
    const fixtureRoot = fixturePathFor(ARCHETYPE);
    const configPath = join(fixtureRoot, '.cleo', 'release-config.json');
    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw) as ReleaseConfigShape;
    expect(config.archetype).toBe('single-npm-lib');
    expect(config.platformMatrix).toHaveLength(1);
    expect(config.platformMatrix[0]?.publisher).toBe('npm');
  });

  it('A2: synthetic plan for npm-lib carries a single-entry platformMatrix', () => {
    const result = runPlanForFixture({ archetype: ARCHETYPE, taskCount: 2 });
    try {
      expect(result.plan.platformMatrix).toHaveLength(1);
      expect(result.plan.platformMatrix[0]?.publisher).toBe('npm');
      expect(result.plan.platformMatrix[0]?.package).toBe('release-test-npm-lib');
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it('A2: reconcile advances status to reconciled with mergeCommitSha', () => {
    const result = runPlanForFixture({ archetype: ARCHETYPE, taskCount: 1 });
    try {
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
});
