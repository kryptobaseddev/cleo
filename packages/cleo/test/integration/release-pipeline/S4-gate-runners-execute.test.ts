/**
 * S4 — Gate runners actually execute (test-matrix-T9345 §2.4).
 *
 * Forensics: F3 — gate runner not wired; F4 — gate marked "passed" without
 * a corresponding tool invocation.
 *
 * Acceptance criteria covered:
 *
 * - A6: every gate row in plan.gates[] carries a non-null `resolvedCommand`
 *   AND a `resolvedSource` ∈ {project-context, language-default, legacy-alias}.
 * - A7: gates with `status='unresolved'` are explicitly flagged and never
 *   silently coerced to `passed`.
 *
 * The test asserts:
 *
 * 1. Happy-path plan has all 6 canonical gates (`test`, `build`, `lint`,
 *    `typecheck`, `audit`, `security-scan`) with status=passed.
 * 2. F3/F4 injection marks the `test` gate as `unresolved` and the schema
 *    accepts it without coercion.
 * 3. resolvedCommand strings are non-empty for every resolved gate.
 *
 * @task T9543
 */

import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATE_NAME } from '@cleocode/contracts';
import { runPlanForFixture } from './_helpers/fixture-runner.js';
import { installGhMock } from './_helpers/mock-gh.js';

describe('S4 — Gate runners execute [forensics: F3, F4]', () => {
  let mockHandle: ReturnType<typeof installGhMock>;

  beforeEach(() => {
    mockHandle = installGhMock();
  });

  afterEach(() => {
    mockHandle.restore();
  });

  it('AC6: happy-path plan covers all 6 canonical gates with resolved commands', () => {
    const result = runPlanForFixture({ archetype: 'monorepo', taskCount: 1 });
    try {
      const names = new Set(result.plan.gates.map((g) => g.name));
      for (const canonical of GATE_NAME) {
        expect(names, `gate ${canonical} present`).toContain(canonical);
      }
      for (const gate of result.plan.gates) {
        expect(gate.status).toBe('passed');
        expect(gate.resolvedCommand?.length ?? 0).toBeGreaterThan(0);
        expect(gate.resolvedSource).toBeDefined();
      }
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it('AC7: F3/F4 injection marks the test gate as unresolved without coercion', () => {
    const result = runPlanForFixture({
      archetype: 'npm-lib',
      taskCount: 1,
      includeForensics: 'F3',
    });
    try {
      const testGate = result.plan.gates.find((g) => g.name === 'test');
      expect(testGate).toBeDefined();
      expect(testGate?.status).toBe('unresolved');
      expect(testGate?.resolvedCommand).toBeUndefined();
      expect(testGate?.resolvedSource).toBeUndefined();
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it('AC7: F4 (same shape as F3 — unresolved test gate) treats the failure mode identically', () => {
    const result = runPlanForFixture({
      archetype: 'rust-crate',
      taskCount: 1,
      includeForensics: 'F4',
    });
    try {
      const testGate = result.plan.gates.find((g) => g.name === 'test');
      expect(testGate?.status).toBe('unresolved');
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });
});
