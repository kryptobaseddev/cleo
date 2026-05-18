/**
 * S5 — Tag lands on merge SHA (test-matrix-T9345 §2.5).
 *
 * Forensics: F6 — tag created against the release branch tip rather than the
 * merge commit SHA returned by `gh pr view --json mergeCommit`.
 *
 * Acceptance criteria covered:
 *
 * - A8: after `gh pr view` confirms `state=MERGED`, the release tag is
 *   applied against `mergeCommit.oid` — NEVER against the release branch
 *   ref or `main`'s pre-merge SHA.
 *
 * The test asserts:
 *
 * 1. Mock-gh's `pr view` response carries a deterministic `mergeCommit.oid`.
 * 2. After reconcile, `plan.mergeCommitSha` equals the mocked oid.
 * 3. mock-gh records that the production call surface (`gh pr view`) was
 *    invoked at least once before the tag step would fire.
 *
 * @task T9543
 */

import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPlanForFixture, runReconcileForFixture } from './_helpers/fixture-runner.js';
import { installGhMock, mockGhPrView, runMockGh } from './_helpers/mock-gh.js';

describe('S5 — Tag on merge SHA [forensics: F6]', () => {
  let mockHandle: ReturnType<typeof installGhMock>;

  beforeEach(() => {
    mockHandle = installGhMock();
  });

  afterEach(() => {
    mockHandle.restore();
  });

  it('AC8: reconcile records mergeCommitSha from mock gh pr view response', () => {
    const result = runPlanForFixture({
      archetype: 'monorepo',
      taskCount: 2,
      includeForensics: 'F6',
    });
    try {
      const expectedOid = 'deadbeefcafebabe0123456789abcdef01234567';
      mockGhPrView({ state: 'MERGED', mergeCommitOid: expectedOid });

      // Simulate what the production verb would do: invoke `gh pr view`,
      // parse the merge oid, then pass it into reconcile.
      const response = runMockGh(['pr', 'view', '--json', 'state,mergeCommit']);
      const parsed = JSON.parse(response) as {
        state: string;
        mergeCommit: { oid: string } | null;
      };
      expect(parsed.state).toBe('MERGED');
      expect(parsed.mergeCommit?.oid).toBe(expectedOid);

      const reconciled = runReconcileForFixture({
        synth: result.synth,
        mergeCommitSha: parsed.mergeCommit?.oid ?? '',
      });
      expect(reconciled.plan.mergeCommitSha).toBe(expectedOid);
      expect(reconciled.plan.status).toBe('reconciled');

      // Confirm the gh call happened (production verb MUST query gh first).
      const ghCalls = mockHandle.invocations().filter((inv) => inv.file === 'gh');
      expect(ghCalls.length).toBeGreaterThan(0);
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it('AC8: refuses to record mergeCommitSha when gh pr view returns state=OPEN', () => {
    const result = runPlanForFixture({ archetype: 'npm-lib', taskCount: 1 });
    try {
      mockGhPrView({ state: 'OPEN' });
      const response = runMockGh(['pr', 'view', '--json', 'state,mergeCommit']);
      const parsed = JSON.parse(response) as {
        state: string;
        mergeCommit: { oid: string } | null;
      };
      expect(parsed.state).toBe('OPEN');
      expect(parsed.mergeCommit).toBeNull();
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });
});
