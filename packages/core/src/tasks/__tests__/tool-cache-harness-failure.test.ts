/**
 * A harness that never started must not be reported as a failing tool
 * (gh#1397), and must not be cached as one.
 *
 * ## The defect
 *
 * `withMemoryLimit` (T12116) wraps `test` and `build` in a transient systemd
 * scope. `systemd-run --scope` is TRANSPARENT on success: it exits with the
 * wrapped command's status. Measured on systemd 259 — a scope that starts and
 * runs `sh -c 'exit 7'` makes `systemd-run` exit `7`.
 *
 * When it cannot create the unit it exits `1`, and the wrapped command never
 * runs:
 *
 * ```
 * $ systemd-run --user --scope --quiet --unit=taken.scope -- sh -c 'echo INNER; exit 0'
 * Failed to start transient scope unit: Unit taken.scope was already loaded or
 * has a fragment file.
 * $ echo $?
 * 1                      # and INNER was never printed
 * ```
 *
 * `1` is also the exit code of a suite with a failing test. So the two
 * outcomes CLEO most needs to tell apart — "the harness never started" and
 * "the suite ran and was red" — were identical in everything `validateTool`
 * looked at, and every harness failure was reported as
 * `E_EVIDENCE_TOOL_FAILED`: a suite that failed in about two seconds.
 *
 * That is why gh#1396 cost five occurrences and produced no diagnosis. The
 * detector was off. `E_EVIDENCE_TOOL_UNAVAILABLE` already existed and was
 * already the right answer — it was gated on `exitCode === null`, and
 * `systemd-run` itself starts perfectly well before failing, so nothing ever
 * reached it.
 *
 * ## Why the paired assertion is the point
 *
 * The two `validateAtom` cases below run a tool that exits `1` in BOTH cases.
 * Only the stderr differs. A fix that keyed on the exit code, the duration, or
 * the absence of stdout would pass one and fail the other. Asserting them as a
 * pair is what makes this a test of the discrimination rather than of one
 * branch.
 *
 * ## Deliberately independent of systemd
 *
 * `withMemoryLimit` degrades to an identity wrap where cgroup confinement is
 * unavailable, so a test that needed a real user systemd manager would SKIP on
 * CI and in containers — and a gate that does not run is not a gate. The mock
 * below produces the failure shape in every environment, for the same reason
 * `tool-cache-memory-limit-wiring.test.ts` mocks rather than probes.
 *
 * @task T12116 (gh#1397, the silencer over gh#1396)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateAtom } from '../evidence.js';
import { confinementStartupFailure, type LimitedCommand } from '../heavy-tool-limit.js';
import { readCacheEntry, runToolCached } from '../tool-cache.js';
import type { ResolvedToolCommand } from '../tool-resolver.js';

/** The exact diagnostic systemd emits, and the exact text of gh#1396. */
const GH1396_STDERR =
  'Failed to start transient scope unit: Unit run-p31337-i4242.scope was already ' +
  'loaded or has a fragment file.';

const hoisted = vi.hoisted(() => ({
  /** When true, the mocked wrapper fails to START (it never execs the tool). */
  wrapperFails: false,
}));

vi.mock('../heavy-tool-limit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../heavy-tool-limit.js')>();
  return {
    ...actual,
    withMemoryLimit: (
      _canonical: string,
      cmd: string,
      args: readonly string[],
    ): LimitedCommand => ({
      cmd: 'sh',
      args: hoisted.wrapperFails
        ? // Stands in for `systemd-run` refusing to create the unit: the
          // diagnostic goes to stderr, the exit code is 1, and — the load-
          // bearing part — the wrapped command is NEVER executed.
          ['-c', `printf '%s\\n' "$1" >&2; exit 1`, 'sh', GH1396_STDERR]
        : // Wrapper starts fine and is transparent: `exec` preserves the
          // tool's own argv and exit code, exactly as `systemd-run` does.
          ['-c', 'exec "$0" "$@"', cmd, ...args],
      confined: true,
      memoryMaxMb: 4_096,
      unitName: 'cleo-tool-test-00000000-00000000.scope',
    }),
  };
});

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'first']);
}

/** Point canonical `test` at a command that exits 1 — a genuinely red suite. */
function writeRedSuiteContext(dir: string): void {
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  writeFileSync(
    join(dir, '.cleo', 'project-context.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      detectedAt: '2026-01-01T00:00:00.000Z',
      projectTypes: ['node'],
      primaryType: 'node',
      testing: { command: 'false' },
    }),
  );
}

function heavyCommand(): ResolvedToolCommand {
  return {
    canonical: 'test',
    displayName: 'test',
    cmd: 'sh',
    args: ['-c', 'exit 0'],
    source: 'language-default',
    primaryType: 'unknown',
  };
}

let originalCleoHome: string | undefined;
let cleoHomeDir: string;
beforeAll(() => {
  originalCleoHome = process.env.CLEO_HOME;
  cleoHomeDir = mkdtempSync(join(tmpdir(), 'harness-fail-cleohome-'));
  process.env.CLEO_HOME = cleoHomeDir;
  process.env.CLEO_TOOL_CONCURRENCY_TEST = '0';
});
afterAll(() => {
  rmSync(cleoHomeDir, { recursive: true, force: true });
  delete process.env.CLEO_TOOL_CONCURRENCY_TEST;
  if (originalCleoHome === undefined) delete process.env.CLEO_HOME;
  else process.env.CLEO_HOME = originalCleoHome;
});

let dir: string;
beforeEach(() => {
  hoisted.wrapperFails = false;
  dir = mkdtempSync(join(tmpdir(), 'harness-fail-repo-'));
  initRepo(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('confinementStartupFailure (gh#1397)', () => {
  it('recognises the systemd diagnostic that is gh#1396', () => {
    expect(confinementStartupFailure(GH1396_STDERR, true)).toBe(GH1396_STDERR);
  });

  it('does NOT fire on ordinary test output that merely failed', () => {
    expect(confinementStartupFailure('2 tests failed\n  expected 1 to be 2', true)).toBeNull();
    expect(confinementStartupFailure('', true)).toBeNull();
  });

  it('does NOT fire when the spawn was not a systemd-run invocation', () => {
    // A spawn with no systemd-run in it has no scope to fail to create, so a
    // non-zero exit is the tool's own — even if the tool printed something
    // that looks like a systemd diagnostic.
    expect(confinementStartupFailure(GH1396_STDERR, false)).toBeNull();
  });

  it('DOES fire for a project that pinned its own systemd-run wrapper', () => {
    // Post-detection (gh#1396) CLEO declines to wrap a command that is already
    // systemd-run, so `limited.confined` is false for exactly the project whose
    // harness failures prompted gh#1397. Keying on `confined` alone would have
    // reintroduced the defect for that project via the fix for its sibling.
    expect(confinementStartupFailure(GH1396_STDERR, true)).toBe(GH1396_STDERR);
  });

  it('returns the matched line so the caller quotes rather than paraphrases', () => {
    const noisy = `warming up\n${GH1396_STDERR}\ntrailing noise`;
    expect(confinementStartupFailure(noisy, true)).toBe(GH1396_STDERR);
  });
});

describe('runToolCached: a wrapper that never started (gh#1397)', () => {
  it('reports harnessFailure instead of a tool verdict', async () => {
    hoisted.wrapperFails = true;
    const r = await runToolCached(heavyCommand(), dir, { spawnTimeoutMs: 30_000 });
    expect(r.harnessFailure).toBe(GH1396_STDERR);
  });

  it('caches NOTHING, so a retry re-runs instead of serving a fabricated failure', async () => {
    hoisted.wrapperFails = true;
    const r = await runToolCached(heavyCommand(), dir, { spawnTimeoutMs: 30_000 });
    // The cache key is (canonical, cmd, args, HEAD, dirty fingerprint). On an
    // unchanged tree it cannot rotate, so a persisted harness failure would be
    // served as "your tests failed" forever, without ever spawning again.
    expect(readCacheEntry(dir, r.entry.key)).toBeNull();

    const second = await runToolCached(heavyCommand(), dir, { spawnTimeoutMs: 30_000 });
    expect(second.cacheHit).toBe(false);
  });

  it('still caches a real result when the wrapper starts fine', async () => {
    hoisted.wrapperFails = false;
    const r = await runToolCached(heavyCommand(), dir, { spawnTimeoutMs: 30_000 });
    expect(r.harnessFailure).toBeNull();
    expect(r.exitCode).toBe(0);
    expect(readCacheEntry(dir, r.entry.key)?.exitCode).toBe(0);
  });
});

describe('validateAtom: the paired discrimination (gh#1397)', () => {
  // Both cases below exit 1. Only stderr differs. That is the whole test.

  it('a genuinely red suite stays E_EVIDENCE_TOOL_FAILED', async () => {
    hoisted.wrapperFails = false;
    writeRedSuiteContext(dir);
    const r = await validateAtom({ kind: 'tool', tool: 'test' }, dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codeName).toBe('E_EVIDENCE_TOOL_FAILED');
  });

  it('a harness that never started is E_EVIDENCE_TOOL_UNAVAILABLE, not FAILED', async () => {
    hoisted.wrapperFails = true;
    writeRedSuiteContext(dir);
    const r = await validateAtom({ kind: 'tool', tool: 'test' }, dir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codeName).toBe('E_EVIDENCE_TOOL_UNAVAILABLE');
      // The operator must be able to act on this, so the message has to carry
      // systemd's own words and say plainly that the suite never executed.
      expect(r.reason).toContain(GH1396_STDERR);
      expect(r.reason).toContain('did NOT run');
      expect(r.reason).toContain('CLEO_NO_TOOL_CGROUP');
    }
  });
});
