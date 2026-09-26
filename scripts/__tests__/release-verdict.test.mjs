/**
 * Regression tests for scripts/release-verdict.mjs (gh#1479, gh#1474).
 *
 * The verdict table is the artifact a human reads after a release night, so
 * these drive the real CLI against hand-built artifacts instead of
 * reimplementing the rendering: a test that re-rendered the table itself could
 * pass while the script still dropped the timestamp.
 *
 * @task gh#1479
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/release-verdict.mjs');

/**
 * Build the two input artifacts in a temp tree, run release-verdict against
 * them, and return what it wrote to GITHUB_STEP_SUMMARY. The `pending` class
 * exits non-zero and writes a tracking issue, so only the classes that render
 * without touching GitHub are exercised here.
 *
 * @param {{ summary: Record<string, any>, timeline?: string }} opts
 * @returns {string}
 */
function runVerdict({ summary, timeline }) {
  const version = summary.version;
  const postDir = mkdtempSync(path.join(tmpdir(), 'rv-post-'));
  const tlDir = mkdtempSync(path.join(tmpdir(), 'rv-tl-'));
  const summaryFile = path.join(mkdtempSync(path.join(tmpdir(), 'rv-out-')), 'summary.md');
  writeFileSync(
    path.join(postDir, `deploy-summary-${version}.json`),
    JSON.stringify(summary),
    'utf8',
  );
  if (timeline) {
    writeFileSync(path.join(tlDir, `publish-timeline-${version}.tsv`), timeline, 'utf8');
  }
  try {
    execFileSync('node', [SCRIPT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        VERSION: version,
        DIST_TAG: summary.distTag ?? 'latest',
        RELEASE_RESULT: 'success',
        POSTDEPLOY_DIR: postDir,
        PUBLISH_TIMELINE_DIR: tlDir,
        GITHUB_STEP_SUMMARY: summaryFile,
      },
      encoding: 'utf8',
    });
  } catch (err) {
    // `defect` renders the table and then exits 1 on purpose.
    if (err?.status !== 1) throw err;
  }
  return readFileSync(summaryFile, 'utf8');
}

const TIMELINE =
  'pkg\toutcome\tcall_ts\tdone_ts\n' +
  'cleo\tPUBLISHED\t2026-09-18T05:38:07.572Z\t2026-09-18T05:38:17.800Z\n';

describe('gh#1479 — the verdict table carries call -> created -> delay', () => {
  it("REGRESSION: renders npm's creation time and the delay from the publish call", () => {
    const out = runVerdict({
      summary: {
        version: '2026.9.18',
        distTag: 'latest',
        verdict: 'installable',
        budgetMs: 900_000,
        stats: { total: 1, verified: 1, failed: 0, slowestConvergenceMs: 60_000 },
        packages: [
          {
            name: '@cleocode/cleo',
            version: '2026.9.18',
            verified: true,
            convergedAfterMs: 60_000,
            rung: 'installable',
            createdAt: '2026-09-18T06:33:40.114Z',
          },
        ],
      },
      timeline: TIMELINE,
    });
    expect(out).toContain('| created (UTC) | delay |');
    expect(out).toContain(
      '| `@cleocode/cleo` | ✅ | installable | 60s | 2026-09-18T05:38:07.572Z | 2026-09-18T06:33:40.114Z | 55m33s |',
    );
  });

  it('leaves the delay blank when the publish timeline artifact is absent', () => {
    const out = runVerdict({
      summary: {
        version: '2026.9.18',
        distTag: 'latest',
        verdict: 'installable',
        budgetMs: 900_000,
        stats: { total: 1, verified: 1, failed: 0, slowestConvergenceMs: 60_000 },
        packages: [
          {
            name: '@cleocode/cleo',
            version: '2026.9.18',
            verified: true,
            convergedAfterMs: 60_000,
            rung: 'installable',
            createdAt: '2026-09-18T06:33:40.114Z',
          },
        ],
      },
    });
    expect(out).toContain('| 2026-09-18T06:33:40.114Z | — |');
  });

  it('a package that never became installable renders no creation time', () => {
    const out = runVerdict({
      summary: {
        version: '2026.9.18',
        distTag: 'latest',
        verdict: 'defect',
        budgetMs: 900_000,
        stats: { total: 1, verified: 0, failed: 1, slowestConvergenceMs: 0 },
        packages: [
          {
            name: '@cleocode/cleo',
            version: '2026.9.18',
            verified: false,
            convergedAfterMs: 0,
            rung: 'metadata',
            reason: 'metadata 404',
          },
        ],
      },
      timeline: TIMELINE,
    });
    expect(out).toContain(
      '| `@cleocode/cleo` | ❌ | metadata | 0s | 2026-09-18T05:38:07.572Z | — | — | metadata 404 |',
    );
  });

  it('keeps the existing columns the table already carried', () => {
    const out = runVerdict({
      summary: {
        version: '2026.9.18',
        distTag: 'latest',
        verdict: 'installable',
        budgetMs: 900_000,
        stats: { total: 1, verified: 1, failed: 0, slowestConvergenceMs: 60_000 },
        packages: [
          {
            name: '@cleocode/cleo',
            version: '2026.9.18',
            verified: true,
            convergedAfterMs: 60_000,
            rung: 'installable',
          },
        ],
      },
      timeline: TIMELINE,
    });
    expect(out).toContain('| package | installable | reached rung | at | publish call (UTC) |');
  });
});
