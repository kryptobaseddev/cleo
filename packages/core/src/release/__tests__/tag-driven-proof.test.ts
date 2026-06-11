/**
 * Acceptance proof for T11977 / DHQ-080:
 * Demonstrates that `synthesizePlanForReconcile` correctly derives the
 * release-set for v2026.6.14 from the real git repository.
 *
 * This test runs against the ACTUAL repo (not a temp fixture) and prints
 * the derivation. It serves as the acceptance proof for the orchestrator —
 * the derived counts and PR numbers are the human-readable deliverable.
 *
 * NOTE: read-only — does NOT write to any DB.
 *
 * @task T11977
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { synthesizePlanForReconcile } from '../reconcile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The real project root for this worktree.  The main-repo root is 6 levels up
// from packages/core/src/release/__tests__/ in a standard checkout. In a
// worktree the path depth is the same.  CLEO_PROJECT_ROOT env overrides this
// so a CI runner can point at the real DB.
const REAL_PROJECT_ROOT =
  process.env['CLEO_PROJECT_ROOT'] || join(__dirname, '..', '..', '..', '..', '..', '..');

describe('T11977 acceptance proof — v2026.6.14 derivation (read-only)', () => {
  it('synthesizes a meaningful plan for v2026.6.14 with CHANGELOG + commit tokens', async () => {
    const version = 'v2026.6.14';

    const report = await synthesizePlanForReconcile(version, REAL_PROJECT_ROOT);

    // ── Print the derivation proof ──────────────────────────────────────────
    console.log('\n=== DHQ-080 Dry-run derivation proof for', version, '===');
    console.log('prevTag               :', report.prevTag);
    console.log('changelogSectionFound :', report.changelogSectionFound);
    console.log('changelogTaskIds      :', report.changelogTaskIds.length, 'IDs');
    console.log('                       ', report.changelogTaskIds.slice(0, 20).join(', '));
    console.log('commitTaskIds         :', report.commitTaskIds.length, 'IDs');
    console.log('discoveredPrNumbers   :', report.discoveredPrNumbers.length, 'PRs');
    console.log('                       ', report.discoveredPrNumbers.slice(0, 20).join(', '));
    console.log('planTaskCount         :', report.plan.tasks.length, 'tasks in synthesised plan');
    console.log(
      'planTaskIds (sample)  :',
      report.plan.tasks
        .slice(0, 10)
        .map((t) => t.id)
        .join(', '),
    );
    console.log('plan.createdBy        :', report.plan.createdBy);
    console.log(
      'plan.meta.origin      :',
      (report.plan.meta as Record<string, unknown>)?.['origin'],
    );
    console.log('====================================================\n');

    // ── Assertions ───────────────────────────────────────────────────────────

    // The previous tag must be v2026.6.13.
    expect(report.prevTag).toBe('v2026.6.13');

    // CHANGELOG.md section for 2026.6.14 must be found.
    expect(report.changelogSectionFound).toBe(true);

    // At least a handful of task IDs must be derived from CHANGELOG + git log.
    expect(report.changelogTaskIds.length).toBeGreaterThan(5);
    expect(report.commitTaskIds.length).toBeGreaterThan(5);

    // Multiple PRs must be discovered.
    expect(report.discoveredPrNumbers.length).toBeGreaterThan(5);

    // The plan must reference the canonical task IDs from the CHANGELOG section.
    // v2026.6.14 CHANGELOG mentions T11556, T11557, T11558, T11952 among others.
    const planTaskIds = report.plan.tasks.map((t) => t.id);
    // At least one of the known tasks must be in the plan.
    const knownV2026614Tasks = ['T11556', 'T11557', 'T11558', 'T11952', 'T11966', 'T11940'];
    const foundKnown = knownV2026614Tasks.filter((id) => planTaskIds.includes(id));
    expect(foundKnown.length).toBeGreaterThan(0);

    // Provenance origin flag.
    expect(report.plan.createdBy).toBe('tag-reconcile-synthesized');
    expect((report.plan.meta as Record<string, unknown>)?.['origin']).toBe(
      'tag-reconcile-synthesized',
    );
  });
});
