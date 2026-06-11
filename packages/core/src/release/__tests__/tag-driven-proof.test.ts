/**
 * Acceptance proof for T11977 / DHQ-080:
 * Demonstrates that `synthesizePlanForReconcile` correctly derives the
 * release-set for v2026.6.14 from the real git repository.
 *
 * This test runs against the ACTUAL repo (not a temp fixture) and prints
 * the derivation. It serves as the acceptance proof for the orchestrator —
 * the derived counts and PR numbers are the human-readable deliverable.
 *
 * Self-skipping: the suite skips automatically when either prerequisite is
 * absent:
 *   - No `.cleo` directory at the resolved project root (CI has no CLEO project).
 *   - Required git tags (v2026.6.14, v2026.6.13) are missing from the git dir.
 *
 * This lets the test run in a developer worktree or against the real repo
 * while remaining harmless in CI where no live .cleo project is present.
 * The 7 fixture-based regression tests in tag-driven-reconcile.test.ts are
 * the CI coverage; this file is the local acceptance proof only.
 *
 * NOTE: read-only — does NOT write to any DB.
 *
 * @task T11977
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { synthesizePlanForReconcile } from '../reconcile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve the project root to test against.  Priority order:
//   1. CLEO_PROOF_ROOT env var — explicit override for targeted local runs.
//   2. 6 levels up from __dirname — resolves to the repo root in a standard
//      checkout or worktree (packages/core/src/release/__tests__ → repo root).
// Do NOT read CLEO_PROJECT_ROOT here: that env var is also consumed by
// getProjectRoot() inside paths.ts and would affect DB resolution in every
// other test file sharing this vitest worker process (isolation violation).
const REAL_PROJECT_ROOT =
  process.env['CLEO_PROOF_ROOT'] || join(__dirname, '..', '..', '..', '..', '..', '..');

const REQUIRED_TAGS = ['v2026.6.14', 'v2026.6.13'];

/**
 * Compute whether the proof prerequisites are satisfied:
 *   1. A `.cleo` directory exists at the resolved project root (CLEO project present).
 *   2. Both required git tags exist in the git dir at that root.
 *
 * Wrapped in try/catch so any resolution failure is treated as "cannot run"
 * rather than a test failure.
 */
function computeCanRunProof(): { ok: boolean; reason: string } {
  // (1) Check .cleo directory exists (proxy for a real CLEO project).
  const cleoDir = join(REAL_PROJECT_ROOT, '.cleo');
  if (!existsSync(cleoDir)) {
    return {
      ok: false,
      reason: `no .cleo directory at ${REAL_PROJECT_ROOT} — skipping real-repo proof (CI environment or non-CLEO checkout)`,
    };
  }

  // (2) Check git tags exist.
  try {
    const raw = execFileSync('git', ['tag', '--list', ...REQUIRED_TAGS], {
      cwd: REAL_PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    }).trim();
    const found = raw
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const missing = REQUIRED_TAGS.filter((t) => !found.includes(t));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `git tags missing: ${missing.join(', ')} — skipping real-repo proof`,
      };
    }
  } catch {
    return {
      ok: false,
      reason: 'git tag check failed (no git repo at project root) — skipping real-repo proof',
    };
  }

  return { ok: true, reason: '' };
}

const proofPrereqs = computeCanRunProof();

if (!proofPrereqs.ok) {
  console.log(`[tag-driven-proof] ${proofPrereqs.reason}`);
}

describe.skipIf(!proofPrereqs.ok)(
  'T11977 acceptance proof — v2026.6.14 derivation (read-only)',
  () => {
    // Extend the sqlite isolation guard's allowlist to include the real project
    // DB path.  This runs in its own vitest fork (pool:'forks', one file per
    // worker) so the env mutation is fully contained — it cannot affect the
    // fixture-based tests in tag-driven-reconcile.test.ts which run in a
    // separate fork.
    beforeAll(() => {
      const existing = process.env['CLEO_TEST_ALLOWED_DB_ROOTS'] ?? '';
      const cleoDir = join(REAL_PROJECT_ROOT, '.cleo');
      if (!existing.split(':').includes(cleoDir)) {
        process.env['CLEO_TEST_ALLOWED_DB_ROOTS'] = existing ? `${existing}:${cleoDir}` : cleoDir;
      }
    });

    it('synthesizes a meaningful plan for v2026.6.14 with CHANGELOG + commit tokens', async () => {
      const version = 'v2026.6.14';

      const report = await synthesizePlanForReconcile(version, REAL_PROJECT_ROOT);

      // ── Print the derivation proof ────────────────────────────────────────
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

      // ── Assertions ─────────────────────────────────────────────────────────

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
  },
);
