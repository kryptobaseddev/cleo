/**
 * S12 — Project-agnostic: rust crate ships (test-matrix-T9345 §2.12).
 *
 * Archetype: A3 — release-test-rust-crate.
 *
 * Acceptance criteria covered:
 *
 * - A3 (per SPEC §1.3): pipeline runs end-to-end on a single Rust crate
 *   targeting cargo, producing per-platform artifacts (linux-x64,
 *   linux-arm64) per the matrix declared in release-config.json.
 *
 * The test asserts:
 *
 * 1. The rust-crate fixture's release-config.json declares `archetype:
 *    single-rust-crate` and a 2-entry platformMatrix for cargo.
 * 2. The synthetic plan's platformMatrix matches that 2-entry shape.
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

const ARCHETYPE: SyntheticArchetype = 'rust-crate';

interface ReleaseConfigShape {
  archetype: string;
  platformMatrix: Array<{ publisher: string; package: string; platform: string }>;
}

describe('S12 — rust-crate archetype ships end-to-end [A3]', () => {
  let mockHandle: ReturnType<typeof installGhMock>;

  beforeEach(() => {
    mockHandle = installGhMock();
  });

  afterEach(() => {
    mockHandle.restore();
  });

  it('A3: fixture declares single-rust-crate archetype + 2-entry cargo matrix', () => {
    const fixtureRoot = fixturePathFor(ARCHETYPE);
    const configPath = join(fixtureRoot, '.cleo', 'release-config.json');
    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw) as ReleaseConfigShape;
    expect(config.archetype).toBe('single-rust-crate');
    expect(config.platformMatrix).toHaveLength(2);
    for (const entry of config.platformMatrix) {
      expect(entry.publisher).toBe('cargo');
    }
  });

  it('A3: synthetic plan for rust-crate carries a 2-entry cargo platformMatrix', () => {
    const result = runPlanForFixture({ archetype: ARCHETYPE, taskCount: 2 });
    try {
      expect(result.plan.platformMatrix).toHaveLength(2);
      const publishers = result.plan.platformMatrix.map((e) => e.publisher);
      expect(publishers.every((p) => p === 'cargo')).toBe(true);
      const platforms = new Set(result.plan.platformMatrix.map((e) => e.platform));
      expect(platforms.has('linux-x64')).toBe(true);
      expect(platforms.has('linux-arm64')).toBe(true);
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it('A3: reconcile advances status to reconciled with mergeCommitSha', () => {
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
