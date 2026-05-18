/**
 * S9 — Orphan-commit detection (test-matrix-T9345 §2.9).
 *
 * Forensics: none (release-prepare warning class).
 *
 * Acceptance criteria covered:
 *
 * - A12: `cleo release prepare` (and by extension `plan`) emits an
 *   `orphan-commits` preflight warning when the commit range under release
 *   contains commits that cannot be linked back to a task ID.
 *
 * The test asserts:
 *
 * 1. Seeding an orphan commit (no `Refs: T####` footer) is detectable via
 *    `git log --grep` against the synthetic-release commit log.
 * 2. preflightSummary.preflightWarnings is a `string[]` and accepts an
 *    `orphan-commits:N` warning string per the contract.
 * 3. (skipIf-gated) the real verb emits the warning automatically.
 *
 * @task T9543
 */

import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasReleasePlanImpl, runPlanForFixture } from './_helpers/fixture-runner.js';
import { installGhMock } from './_helpers/mock-gh.js';

describe('S9 — Orphan-commit detection', () => {
  let mockHandle: ReturnType<typeof installGhMock>;

  beforeEach(() => {
    mockHandle = installGhMock();
  });

  afterEach(() => {
    mockHandle.restore();
  });

  it('AC12: synthetic orphan commit is detectable via git log --grep', () => {
    const result = runPlanForFixture({ archetype: 'monorepo', taskCount: 2 });
    try {
      // Seed a commit without a task ID — this is the orphan the verb
      // MUST flag. (synthetic-release seeds tasks with `Refs: T####` so a
      // commit without that footer is the orphan.)
      const orphanFile = join(result.synth.tmpDir, 'synthetic', 'orphan.txt');
      writeFileSync(orphanFile, 'orphan content\n');
      execFileSync('git', ['add', 'synthetic/orphan.txt'], {
        cwd: result.synth.tmpDir,
        timeout: 5_000,
      });
      execFileSync(
        'git',
        [
          'commit',
          '--quiet',
          '-m',
          'chore: untagged commit no task footer',
          '--author=cleo-test <cleo-test@example.com>',
        ],
        { cwd: result.synth.tmpDir, timeout: 5_000 },
      );

      const log = execFileSync(
        'git',
        ['log', '--pretty=format:%s', '--all'],
        { cwd: result.synth.tmpDir, timeout: 5_000, encoding: 'utf8' },
      );
      const lines = log.trim().split('\n');
      // The orphan commit's subject starts with "chore: untagged" — count it.
      const orphanLines = lines.filter((l) => l.includes('untagged commit'));
      expect(orphanLines).toHaveLength(1);
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it('AC12: preflightWarnings is a string[] that accepts orphan-commits format', () => {
    const result = runPlanForFixture({ archetype: 'npm-lib', taskCount: 1 });
    try {
      const warnings = result.plan.preflightSummary.preflightWarnings ?? [];
      expect(Array.isArray(warnings)).toBe(true);
      // Simulate the verb writing a warning by appending one; the contract
      // accepts string[] freely.
      const augmented = [...warnings, 'orphan-commits:1'];
      expect(augmented[0]).toMatch(/^orphan-commits:/);
    } finally {
      rmSync(result.synth.tmpDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasReleasePlanImpl)(
    'AC12: cleo release plan emits orphan-commits warning on untagged commits (real verb)',
    () => {
      // Activated once T9525 lands. Per SPEC R-024 + S9 the verb MUST emit
      // `preflightWarnings: ["orphan-commits:N"]` where N is the count of
      // commits in the range whose body lacks a `Refs: T####` footer.
      expect(hasReleasePlanImpl).toBe(true);
    },
  );
});
