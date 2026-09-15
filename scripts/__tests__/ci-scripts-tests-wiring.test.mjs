/**
 * Wiring assertions for the `Scripts Tests` CI job (gh#1403).
 *
 * Why a test about a workflow file
 * -------------------------------
 * `scripts/__tests__/*.test.mjs` is a real vitest project — name `scripts`,
 * listed in the root config's `projects:` array — but nothing ran it on a
 * scripts-only PR, because the `code` paths-filter that gates `unit-tests`
 * matches no path under `scripts/`. And the `ci` aggregate accepts `skipped`
 * as a pass, so such a PR rendered CLEAN with its tests never executed.
 *
 * Measured on #1401 — a PR whose entire content was 13 new tests — where
 * `Unit Tests`, `Type Check`, `Build & Verify` and `Install Test` all reported
 * `skipping` and `CI` reported `pass`.
 *
 * This is the third instance of that shape in this subsystem:
 *   - `packages/utils` was added in #842 and its vitest project was never
 *     attached, so its unit tests silently did not run.
 *   - `scripts/__tests__` detached when the root config moved to projects-mode
 *     and had to be re-attached (T10177).
 *   - gate 18 globbed root + `packages/*` only, so `scripts/vitest.config.ts`
 *     — in the SAME DIRECTORY as the tests it bounds — was the one file it
 *     could not see (gh#1354).
 *
 * Each time the tests existed, were correct, and something upstream of them
 * did not know. Each time the failure was silent and the PR was green. A
 * comment cannot catch the fourth instance; this file can.
 *
 * Self-proving: this file lives under `scripts/__tests__/`, so the job it
 * describes selects it. A PR that breaks the wiring while editing this file
 * fails on itself. That matters because a change to `ci.yml` alone cannot
 * prove anything — `ci.yml` is not under `scripts/**`, so the new job would
 * skip on the very PR that adds it, exactly as the tests did.
 *
 * @task gh#1403
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CI_YML = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const ci = readFileSync(CI_YML, 'utf8');

/**
 * Extract one top-level job block from ci.yml by name.
 * Jobs are indented two spaces; the block runs to the next two-space key.
 * @param {string} source - Full ci.yml text.
 * @param {string} name - Job key, e.g. "scripts-tests".
 * @returns {string} The job's YAML block, or '' when absent.
 */
function jobBlock(source, name) {
  const lines = source.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('gh#1403 — the scripts test project is reachable from CI', () => {
  it('declares a `scripts` paths-filter matching scripts/**', () => {
    // Scoped to the filter definition block, not the whole file: the word
    // "scripts" appears all over ci.yml, so a bare substring search here would
    // pass on prose and prove nothing.
    const changes = jobBlock(ci, 'changes');
    expect(changes, 'the changes job must exist').not.toBe('');
    expect(changes).toMatch(/^\s+scripts:\s*$/m);
    expect(changes).toMatch(/^\s+- 'scripts\/\*\*'\s*$/m);
  });

  it('re-runs when the test runner’s own memory bounds change', () => {
    // scripts/vitest.config.ts spreads MEMORY_SAFE_TEST_DEFAULTS from this
    // file. A change to it changes how every scripts test is bounded, so it
    // belongs in the filter even though it is not under scripts/.
    expect(jobBlock(ci, 'changes')).toMatch(/^\s+- 'vitest\.memory-safe\.js'\s*$/m);
  });

  it('exports the filter as a job output, or nothing can gate on it', () => {
    expect(jobBlock(ci, 'changes')).toMatch(
      /^\s+scripts: \$\{\{ steps\.filter\.outputs\.scripts \}\}\s*$/m,
    );
  });

  it('defines a scripts-tests job gated on that output', () => {
    const job = jobBlock(ci, 'scripts-tests');
    expect(job, 'the scripts-tests job must exist').not.toBe('');
    expect(job).toMatch(/if:\s*needs\.changes\.outputs\.scripts == 'true'/);
  });

  it('runs the scripts vitest project', () => {
    expect(jobBlock(ci, 'scripts-tests')).toMatch(/vitest run --project=scripts/);
  });

  it('runs SELECTED files, not the whole project', () => {
    // The project is red on main (16 failed / 472 passed, two of them
    // deliberately). Running it wholesale would block every scripts PR — the
    // exact mistake of wiring a gate without first running it.
    const job = jobBlock(ci, 'scripts-tests');
    expect(job).toMatch(/steps\.select\.outputs\.count/);
    expect(job, 'must not invoke the project with no file arguments').not.toMatch(
      /vitest run --project=scripts\s*$/m,
    );
  });

  it('picks up the sibling test of a changed script, not only changed tests', () => {
    // Without this the job only ever covers PRs that happen to edit a test,
    // and a change to scripts/lint-foo.mjs runs nothing.
    expect(jobBlock(ci, 'scripts-tests')).toMatch(/__tests__\/\$\(basename/);
  });

  it('builds before running, or a test that spawns a script cannot pass', () => {
    // The job installed but never built. Several scripts/ tests spawn a script
    // that imports `@cleocode/core`'s built output: lint-changesets.mjs exits 2
    // with "has not been built" before parsing anything, so all five of
    // lint-changesets.test.mjs's assertions (each expecting exit 0 or 1) fail.
    //
    // Nothing caught it because the sibling-test rule that selects that file is
    // itself new — the first PR to edit scripts/lint-changesets.mjs was the
    // first run that ever included it, and it failed on a missing prerequisite
    // rather than on its own change. Selecting a test the job cannot satisfy is
    // not coverage.
    const job = jobBlock(ci, 'scripts-tests');
    expect(job).toMatch(/run: pnpm run build/);
  });

  it('is in the ci aggregate’s needs, so its failure fails the merge bar', () => {
    // The aggregate accepts `skipped` as a pass — which is what let a
    // scripts-only PR go green. Being in `needs` is what makes a FAILURE here
    // red; without this line the job is decorative.
    const aggregate = jobBlock(ci, 'ci');
    expect(aggregate, 'the ci aggregate must exist').not.toBe('');
    expect(aggregate).toMatch(/^\s+- scripts-tests\s*$/m);
  });
});

describe('gh#1403 — the helper reads blocks, not the whole file', () => {
  it('returns empty for a job that does not exist', () => {
    // A block reader that silently returns the whole file would make every
    // assertion above pass on any ci.yml mentioning the right words anywhere.
    expect(jobBlock(ci, 'no-such-job-exists')).toBe('');
  });

  it('does not bleed one job into the next', () => {
    const changes = jobBlock(ci, 'changes');
    expect(changes).not.toMatch(/vitest run --project=scripts/);
  });
});
