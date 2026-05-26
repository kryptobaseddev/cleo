/**
 * T10574 — acceptance_json deprecation/removal policy guardrails.
 *
 * The legacy `tasks.acceptance_json` column is retained only as a storage and
 * one-time backfill compatibility surface. Completion readiness and AC coverage
 * must use `task_acceptance_criteria` + `evidence_ac_bindings` after the
 * migration cutover.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = join(here, '..', '..');

function readCoreSource(relativePath: string): string {
  return readFileSync(join(coreSrc, relativePath), 'utf8');
}

describe('T10574 acceptance_json deprecation policy', () => {
  it('completion and readiness logic do not read the legacy tasks.acceptance_json column', () => {
    const completionCriticalFiles = [
      'tasks/complete.ts',
      'tasks/compute-task-view.ts',
      'tasks/ac-coverage-gate.ts',
    ];

    for (const relativePath of completionCriticalFiles) {
      const source = readCoreSource(relativePath);
      expect(source, `${relativePath} must not query tasks.acceptance_json`).not.toMatch(
        /\bacceptance_?json\b/i,
      );
    }
  });

  it('the user-facing show path documents canonical AC rows instead of legacy completion fallback', () => {
    const source = readCoreSource('tasks/show.ts');

    expect(source).toContain('Reads from `task_acceptance_criteria`');
    expect(source).toContain('NOT the legacy `tasks.acceptance` JSON string');
  });

  it('schema comments record the retention window and removal trigger', () => {
    const source = readCoreSource('store/schema/tasks.ts');

    expect(source).toContain('T10574 deprecation policy');
    expect(source).toContain('retained only for legacy import/backfill');
    expect(source).toContain('compatibility and historical migrations');
    expect(source).toContain('Post-migration completion and');
    expect(source).toContain('AC coverage must not read this column');
  });
});
