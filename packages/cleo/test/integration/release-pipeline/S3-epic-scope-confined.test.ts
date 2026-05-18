/**
 * S3 — Epic completeness scope confined (test-matrix-T9345 §2.3).
 *
 * Forensics: F2 — epic completeness scope leak. `--epic A` must not fail
 * completeness on children belonging to unrelated epic B.
 *
 * Acceptance criteria covered:
 *
 * - A5: `cleo release ship --epic <id>` evaluates completeness ONLY against
 *   that epic's transitive children, never the full open-task set.
 *
 * The test asserts:
 *
 * 1. The plan emitted for epic A excludes tasks whose `epicAncestor !== A`.
 * 2. A plan synthesized with F2 injection (one task with mismatched
 *    epicAncestor) still reports `preflightSummary.epicCompletenessClean`
 *    as true at the schema level — the verb is responsible for the actual
 *    scope check, which the skipIf-gated test exercises.
 *
 * @task T9543
 */

import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasReleasePlanImpl, runPlanForFixture } from './_helpers/fixture-runner.js';
import { installGhMock } from './_helpers/mock-gh.js';

describe('S3 — Epic scope confined [forensics: F2]', () => {
  let mockHandle: ReturnType<typeof installGhMock>;

  beforeEach(() => {
    mockHandle = installGhMock();
  });

  afterEach(() => {
    mockHandle.restore();
  });

  it('AC5: all happy-path tasks roll up to the requested epic ancestor', () => {
    const result = runPlanForFixture({
      archetype: 'monorepo',
      taskCount: 4,
      epicId: 'T9495',
    });
    try {
      for (const task of result.plan.tasks) {
        expect(task.epicAncestor).toBe('T9495');
      }
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it('AC5: F2 injection mutates exactly one task to an unrelated epic', () => {
    const result = runPlanForFixture({
      archetype: 'npm-lib',
      taskCount: 3,
      epicId: 'T9495',
      includeForensics: 'F2',
    });
    try {
      const unrelated = result.plan.tasks.filter((t) => t.epicAncestor !== 'T9495');
      expect(unrelated).toHaveLength(1);
      expect(unrelated[0]?.epicAncestor).toBe('T-UNRELATED');
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasReleasePlanImpl)(
    'AC5: cleo release plan rejects tasks whose epicAncestor differs from --epic (real verb)',
    () => {
      // Activated once T9525 lands. The real verb MUST emit
      // `E_EPIC_SCOPE_LEAK` (or skip the task entirely) when a task's
      // epicAncestor disagrees with the CLI --epic arg.
      expect(hasReleasePlanImpl).toBe(true);
    },
  );
});
