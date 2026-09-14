/**
 * Tests for scripts/assert-vitest-collected.mjs (gh#1403 follow-up).
 *
 * The defect being guarded, measured 2026-09-14 against the `scripts` project:
 *
 *   vitest run --project=scripts <one non-collectable path>        -> rc=1
 *   vitest run --project=scripts <collectable> <non-collectable>   -> rc=0
 *                                          "Test Files  1 passed (1)"
 *
 * A TOTAL miss fails loudly. A PARTIAL miss exits **green** having silently
 * dropped a file it was explicitly told to run. The CI job selects files by
 * diffing against the PR base, so a rename or an include change makes it
 * report success for a shrinking set — and the number it prints is the count
 * of what it CHOSE, never of what RAN.
 *
 * The last test here reproduces that end-to-end against real vitest rather
 * than a fixture, because a fixture asserts the shape I believe the reporter
 * emits, which is the same side of the question as the code under test.
 *
 * @task gh#1403
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectedFiles, main, missingFiles } from '../assert-vitest-collected.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Build a minimal vitest-shaped JSON report naming the given files.
 * @param {string[]} names - Absolute test file paths.
 * @returns {{ testResults: { name: string }[] }}
 */
function report(names) {
  return { testResults: names.map((name) => ({ name })) };
}

describe('collectedFiles', () => {
  it('reads the file names a report says it ran', () => {
    expect(collectedFiles(report(['/a/x.test.mjs', '/a/y.test.mjs']))).toEqual([
      '/a/x.test.mjs',
      '/a/y.test.mjs',
    ]);
  });

  it('returns [] for a report with no testResults — never a pass', () => {
    // A shape change in the reporter must read as "collected nothing", which
    // fails, not as "nothing to check", which would pass.
    expect(collectedFiles({})).toEqual([]);
    expect(collectedFiles(null)).toEqual([]);
    expect(collectedFiles({ testResults: 'not-an-array' })).toEqual([]);
  });
});

describe('missingFiles', () => {
  it('matches a repo-relative expectation against an absolute collected path', () => {
    const abs = path.join(REPO_ROOT, 'scripts/__tests__/x.test.mjs');
    expect(missingFiles(['scripts/__tests__/x.test.mjs'], [abs], REPO_ROOT)).toEqual([]);
  });

  it('names the file that was selected but never ran', () => {
    const ran = path.join(REPO_ROOT, 'scripts/__tests__/ran.test.mjs');
    const missing = missingFiles(
      ['scripts/__tests__/ran.test.mjs', 'scripts/__tests__/dropped.test.mjs'],
      [ran],
      REPO_ROOT,
    );
    expect(missing).toEqual(['scripts/__tests__/dropped.test.mjs']);
  });
});

describe('main — exit codes', () => {
  /**
   * @param {string[]} collected
   * @param {string[]} expected
   * @returns {Promise<number>}
   */
  async function runMain(collected, expected) {
    const dir = await mkdtemp(path.join(tmpdir(), 'avc-'));
    const p = path.join(dir, 'report.json');
    await writeFile(p, JSON.stringify(report(collected)), 'utf8');
    return main([p, ...expected]);
  }

  it('exits 0 when everything selected was collected', async () => {
    const f = path.join(REPO_ROOT, 'scripts/__tests__/a.test.mjs');
    expect(await runMain([f], [f])).toBe(0);
  });

  it('exits 1 on a PARTIAL collection — the silent-green case', async () => {
    const ran = path.join(REPO_ROOT, 'scripts/__tests__/a.test.mjs');
    const dropped = path.join(REPO_ROOT, 'scripts/__tests__/b.test.mjs');
    expect(await runMain([ran], [ran, dropped])).toBe(1);
  });

  it('exits 2 when the report is unreadable — fails closed', () => {
    // An unreadable report is not evidence that everything ran.
    expect(main([path.join(tmpdir(), 'no-such-report-xyz.json'), 'a.test.mjs'])).toBe(2);
  });

  it('exits 2 when called with no expectations, rather than passing vacuously', () => {
    expect(main([])).toBe(2);
  });
});

describe('end-to-end against real vitest (the actual defect)', () => {
  it('catches a partial collection that vitest itself reports as success', () => {
    // Runs against the REAL `scripts` project, not a fixture.
    //
    // Two fixtures were tried first and BOTH exited 1 on a partial collection,
    // which would have argued that no hole exists. Neither single-config nor
    // multi-project fixtures reproduce it; the behaviour depends on something
    // in this project's actual configuration that a minimal reconstruction
    // does not carry. A fixture that disagrees with a replicated direct
    // measurement is evidence about the fixture, not about the defect — so the
    // test uses the configuration the guard actually protects.
    //
    // Direct measurement, replicated with the exit code captured outside any
    // pipe: `vitest run --project=scripts <real> <phantom>` exits 0 having run
    // only the real file.
    //
    // Cost: ~48s locally, dominated by vitest startup over the FUSE mount this
    // repo lives on; far cheaper on a CI runner.
    const real = 'scripts/__tests__/lint-no-crate-publish.test.mjs';
    const phantom = 'scripts/__tests__/phantom-does-not-exist.test.mjs';
    const reportPath = path.join(tmpdir(), `avc-e2e-${process.pid}.json`);

    let vitestCode = 0;
    try {
      execFileSync(
        'pnpm',
        [
          'exec',
          'vitest',
          'run',
          '--project=scripts',
          '--reporter=json',
          `--outputFile=${reportPath}`,
          real,
          phantom,
        ],
        { cwd: REPO_ROOT, stdio: 'pipe', timeout: 240_000 },
      );
    } catch (err) {
      vitestCode = typeof err?.status === 'number' ? err.status : 1;
    }

    // The premise this guard exists for: vitest is GREEN despite being handed a
    // path it never ran. Asserted rather than assumed — if vitest ever fixes
    // the partial case upstream, this fails and tells us, instead of the guard
    // quietly protecting against nothing.
    expect(vitestCode, 'vitest should exit 0 on a partial collection').toBe(0);

    // And the guard disagrees with it.
    expect(main([reportPath, real, phantom])).toBe(1);
  }, 300_000);
});
