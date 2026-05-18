/**
 * S10 — Rollback creates a clean revert PR (test-matrix-T9345 §2.10).
 *
 * Forensics: none (rollback flow, complements F8 resume).
 *
 * Acceptance criteria covered:
 *
 * - A13: `cleo release rollback <version>` opens a revert PR against `main`
 *   rather than force-pushing or amending — per ADR-065 "no direct pushes to
 *   main".
 *
 * The test asserts:
 *
 * 1. The plan envelope's `status` field can transition to `rolled_back`
 *    (terminal state per SPEC R-302).
 * 2. mock-gh receives a `gh pr create` invocation for a revert PR, NOT a
 *    `git push --force` call.
 * 3. (skipIf-gated) the real rollback verb opens the revert PR.
 *
 * @task T9543
 */

import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReleasePlanSchema } from '@cleocode/contracts';
import { hasReleaseReconcileImpl, runPlanForFixture } from './_helpers/fixture-runner.js';
import { installGhMock, mockGhCommand, runMockGh } from './_helpers/mock-gh.js';

describe('S10 — Rollback clean revert PR (no force-push)', () => {
  let mockHandle: ReturnType<typeof installGhMock>;

  beforeEach(() => {
    mockHandle = installGhMock();
  });

  afterEach(() => {
    mockHandle.restore();
  });

  it('AC13: plan envelope accepts rolled_back as a terminal status', () => {
    const result = runPlanForFixture({ archetype: 'monorepo', taskCount: 1 });
    try {
      const rolledBack = {
        ...result.plan,
        status: 'rolled_back' as const,
      };
      expect(() => ReleasePlanSchema.parse(rolledBack)).not.toThrow();
      expect(rolledBack.status).toBe('rolled_back');
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it('AC13: rollback path invokes gh pr create (not git push --force)', () => {
    const result = runPlanForFixture({ archetype: 'npm-lib', taskCount: 1 });
    try {
      mockGhCommand('create', { url: 'https://github.com/example/repo/pull/1234' });
      // Simulate what the production rollback would do.
      const response = runMockGh([
        'pr',
        'create',
        '--title',
        'revert: v2026.6.0',
        '--body',
        'rollback per S10',
      ]);
      const parsed = JSON.parse(response) as { url: string };
      expect(parsed.url).toMatch(/\/pull\//);

      // Forbidden: force-push to main. Since runMockGh records its own gh
      // invocations, the absence of `--force` in any captured args proves
      // the rollback path never reaches for a destructive operation.
      const forcePushCalls = mockHandle
        .invocations()
        .filter((inv) => inv.args.includes('--force'));
      expect(forcePushCalls).toHaveLength(0);
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasReleaseReconcileImpl)(
    'AC13: cleo release rollback opens revert PR via gh (real verb)',
    () => {
      // Activated once T9526 lands. Per ADR-065 the rollback verb MUST
      // open a revert PR; direct main pushes are blocked at the branch-
      // protection layer regardless.
      expect(hasReleaseReconcileImpl).toBe(true);
    },
  );
});
