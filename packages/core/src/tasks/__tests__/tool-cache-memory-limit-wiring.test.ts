/**
 * The heavy-tool memory bound must be APPLIED by `runToolCached`, not merely
 * computed by it (T12116 · gh#1221 merge).
 *
 * ## Why this file exists
 *
 * `heavy-tool-limit.test.ts` and `heavy-tool-confinement.test.ts` prove that
 * {@link withMemoryLimit} builds a correct `systemd-run` scope and that the
 * kernel kills a child which breaches it. Neither calls `runToolCached`. So
 * every property of the bound was covered except the one that decides whether
 * it exists at runtime: **that the spawn uses the wrapped command.**
 *
 * That gap was found by a merge conflict, not by a test. Two branches changed
 * the same `spawnCmd` call — one to pass `limited.cmd`, one still passing
 * `command.cmd` — and resolving it the wrong way leaves
 *
 *     const limited = withMemoryLimit(command.canonical, command.cmd, command.args);
 *     await spawnCmd(command.cmd, command.args, …);   // ← limited discarded
 *
 * which computes the ceiling, throws it away, and spawns unbounded. 242 tests
 * across the tool-cache and heavy-tool suites stayed green against exactly
 * that. A guard that is present but not installed is the failure mode this
 * file closes: it asserts the *wiring*, so the next person to touch that call
 * site is told by a test rather than by a conflict marker.
 *
 * Deliberately independent of systemd. `withMemoryLimit` degrades to an
 * identity wrap where cgroup confinement is unavailable, so asserting on
 * `systemd-run` would pass vacuously on CI and in containers. The mock returns
 * a command that is observably different from the original in every
 * environment, which is what makes the assertion mean the same thing
 * everywhere.
 *
 * @task T12116 — the mechanism this guards (the kernel-enforced ceiling).
 *   Added while resolving the #1259 merge, where the conflict over this exact
 *   call site is what revealed the gap.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimitedCommand } from '../heavy-tool-limit.js';
import { runToolCached } from '../tool-cache.js';
import type { ResolvedToolCommand } from '../tool-resolver.js';

/**
 * Shared with the hoisted `vi.mock` factory below. `vi.mock` is lifted above
 * the imports, so the marker path cannot be a plain `let` from `beforeEach` —
 * it has to live in a holder the factory can close over.
 */
const hoisted = vi.hoisted(() => ({
  /** Absolute path the wrapped command appends to when it runs. */
  markerPath: '',
  /** Canonical tool names `withMemoryLimit` was asked about. */
  canonicals: [] as string[],
}));

vi.mock('../heavy-tool-limit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../heavy-tool-limit.js')>();
  return {
    ...actual,
    withMemoryLimit: (canonical: string, cmd: string, args: readonly string[]): LimitedCommand => {
      hoisted.canonicals.push(canonical);
      // A wrapper that is distinguishable from the original REGARDLESS of
      // whether systemd is present: it records that it ran, then execs the
      // command it was handed. `$0`/`$@` keep the original argv intact, so a
      // caller that honours the wrapper still gets the tool's real exit code.
      return {
        cmd: 'sh',
        args: [
          '-c',
          `printf 'wrapped\\n' >> '${hoisted.markerPath}'; exec "$0" "$@"`,
          cmd,
          ...args,
        ],
        confined: true,
        memoryMaxMb: 4_096,
      };
    },
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

/** A trivially-succeeding `test` tool — `test` is heavy, so it is confined. */
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
  cleoHomeDir = mkdtempSync(join(tmpdir(), 'limit-wiring-cleohome-'));
  process.env.CLEO_HOME = cleoHomeDir;
  // Serialise: the global semaphore is irrelevant here and its lock directory
  // is shared across worktrees.
  process.env.CLEO_TOOL_CONCURRENCY_TEST = '0';
});
afterAll(() => {
  rmSync(cleoHomeDir, { recursive: true, force: true });
  delete process.env.CLEO_TOOL_CONCURRENCY_TEST;
  if (originalCleoHome === undefined) delete process.env.CLEO_HOME;
  else process.env.CLEO_HOME = originalCleoHome;
});

let dir: string;
let markerDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'limit-wiring-repo-'));
  // The marker MUST live outside the repo under test: an untracked file inside
  // it perturbs the dirty-tree fingerprint and would invalidate the cache key
  // between calls (gh#1221 cause 2).
  markerDir = mkdtempSync(join(tmpdir(), 'limit-wiring-marker-'));
  hoisted.markerPath = join(markerDir, 'wrapped.log');
  hoisted.canonicals.length = 0;
  initRepo(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(markerDir, { recursive: true, force: true });
});

describe('runToolCached applies the memory limit it computes', () => {
  it('spawns the WRAPPED command, not the original', async () => {
    const result = await runToolCached(heavyCommand(), dir, {
      bypassCache: true,
      spawnTimeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(0);
    // The whole point: computing `limited` and spawning `command` would still
    // give exitCode 0 and leave this file absent.
    expect(existsSync(hoisted.markerPath)).toBe(true);
    expect(readFileSync(hoisted.markerPath, 'utf-8')).toContain('wrapped');
  });

  it('asks about the canonical tool being run, so the heavy/light split applies', async () => {
    await runToolCached(heavyCommand(), dir, { bypassCache: true, spawnTimeoutMs: 30_000 });

    // `withMemoryLimit` decides confinement from `isHeavyTool(canonical)`. Pass
    // the wrong canonical and every tool silently becomes light.
    expect(hoisted.canonicals).toContain('test');
  });

  it('preserves the wrapped tool exit code rather than the wrapper own', async () => {
    const failing: ResolvedToolCommand = { ...heavyCommand(), args: ['-c', 'exit 7'] };

    const result = await runToolCached(failing, dir, { bypassCache: true, spawnTimeoutMs: 30_000 });

    // A wrapper that swallowed the child status would turn a failed evidence
    // run into a passing one — the exact shape of E_EVIDENCE_TESTS_FAILED
    // never firing.
    expect(result.exitCode).toBe(7);
    expect(existsSync(hoisted.markerPath)).toBe(true);
  });
});
