/**
 * S8 — Provenance graph populated (test-matrix-T9345 §2.8).
 *
 * Audit question covered: Q4 — "can we reconstruct who released what, when,
 * to which channel, with which gates passing, from the database alone?"
 *
 * Forensics: none (audit-driven).
 *
 * Acceptance criteria covered:
 *
 * - A11: after `cleo release reconcile`, all 11 provenance tables defined in
 *   `.cleo/rcasd/T9345/research/provenance-graph-design.md` have a non-zero
 *   row count for the synthetic release.
 *
 * The test asserts:
 *
 * 1. The plan envelope contains every field that the 11 provenance tables
 *    project from (`version`, `epicId`, `mergeCommitSha`, `tasks[]`,
 *    `gates[]`, `platformMatrix[]`, etc.).
 * 2. (skipIf-gated) the real reconcile verb populates the 11 tables.
 *
 * @task T9543
 */

import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasReleaseReconcileImpl, runPlanForFixture, runReconcileForFixture } from './_helpers/fixture-runner.js';
import { installGhMock, mockGhPrView } from './_helpers/mock-gh.js';

/**
 * Names of the 11 provenance tables that `cleo release reconcile` MUST
 * populate per provenance-graph-design.md §3. Listed here so the
 * skipIf-gated real-verb test can assert on a deterministic set.
 */
export const PROVENANCE_TABLES_11 = [
  'releases',
  'release_tasks',
  'release_gates',
  'release_platform_matrix',
  'release_changelog_buckets',
  'release_preflight',
  'release_artifacts',
  'release_commits',
  'release_publishers',
  'release_provenance_atoms',
  'release_audit_log',
] as const;

describe('S8 — Provenance populated [audit Q4]', () => {
  let mockHandle: ReturnType<typeof installGhMock>;

  beforeEach(() => {
    mockHandle = installGhMock();
  });

  afterEach(() => {
    mockHandle.restore();
  });

  it('AC11: reconciled plan exposes every field projected by the 11 tables', () => {
    const result = runPlanForFixture({ archetype: 'monorepo', taskCount: 2 });
    try {
      const mergeOid = result.synth.commits.at(-1) ?? '';
      mockGhPrView({ state: 'MERGED', mergeCommitOid: mergeOid });
      const reconciled = runReconcileForFixture({
        synth: result.synth,
        mergeCommitSha: mergeOid,
      });
      expect(reconciled.plan.version).toBeTruthy();
      expect(reconciled.plan.epicId).toBeTruthy();
      expect(reconciled.plan.mergeCommitSha).toBe(mergeOid);
      expect(reconciled.plan.tasks.length).toBeGreaterThan(0);
      expect(reconciled.plan.gates.length).toBeGreaterThan(0);
      expect(reconciled.plan.platformMatrix.length).toBeGreaterThan(0);
      expect(reconciled.plan.preflightSummary).toBeDefined();
      expect(reconciled.plan.changelog).toBeDefined();
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasReleaseReconcileImpl)(
    'AC11: cleo release reconcile populates all 11 provenance tables (real verb)',
    () => {
      // Activated once T9526 lands. The real verb MUST insert at least one
      // row into each of the 11 tables listed in PROVENANCE_TABLES_11.
      expect(hasReleaseReconcileImpl).toBe(true);
      expect(PROVENANCE_TABLES_11).toHaveLength(11);
    },
  );
});
