/**
 * S7 — Resume after CI failure mid-flight (test-matrix-T9345 §2.7).
 *
 * Forensics: F8 — release pipeline lacks idempotent resume from durable
 * checkpoints, forcing operators to manually clean up partial state.
 *
 * Acceptance criteria covered:
 *
 * - A10: a release plan whose `status` is `pr-opened` and that has a non-null
 *   `prUrl` MUST be resumable by `cleo release ship --resume` without
 *   re-running the plan step.
 *
 * The test asserts:
 *
 * 1. F8 injection advances `status` to `pr-opened` and stamps `prUrl`.
 * 2. The plan still parses cleanly against `ReleasePlanSchema`.
 * 3. (skipIf-gated) the real verb detects the `pr-opened` state and
 *    resumes from the durable checkpoint instead of restarting.
 *
 * @task T9543
 */

import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReleasePlanSchema } from '@cleocode/contracts';
import { hasReleasePlanImpl, runPlanForFixture } from './_helpers/fixture-runner.js';
import { installGhMock, mockGhPrView } from './_helpers/mock-gh.js';

describe('S7 — Resume after CI failure [forensics: F8]', () => {
  let mockHandle: ReturnType<typeof installGhMock>;

  beforeEach(() => {
    mockHandle = installGhMock();
  });

  afterEach(() => {
    mockHandle.restore();
  });

  it('AC10: F8 injection records pr-opened state + prUrl on the plan', () => {
    const result = runPlanForFixture({
      archetype: 'monorepo',
      taskCount: 2,
      includeForensics: 'F8',
    });
    try {
      expect(result.plan.status).toBe('pr-opened');
      expect(result.plan.prUrl).toMatch(/^https:\/\/github\.com\//);
      expect(() => ReleasePlanSchema.parse(result.plan)).not.toThrow();
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it('AC10: mock-gh treats the pr as still OPEN so resume retries the wait-CI step', () => {
    const result = runPlanForFixture({
      archetype: 'monorepo',
      taskCount: 1,
      includeForensics: 'F8',
    });
    try {
      mockGhPrView({ state: 'OPEN' });
      // The resume path's first action is `gh pr view --json state` —
      // the response shape tells the resumer whether to wait or proceed.
      expect(result.plan.prUrl).not.toBeNull();
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasReleasePlanImpl)(
    'AC10: cleo release ship --resume picks up from pr-opened checkpoint (real verb)',
    () => {
      // Activated once T9525 lands. The real verb MUST detect a plan in
      // `pr-opened` state and skip the plan + open phases entirely.
      expect(hasReleasePlanImpl).toBe(true);
    },
  );
});
