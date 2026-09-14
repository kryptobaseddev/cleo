/**
 * Regression tests for gh#1381 (a killed tool reported as a missing binary)
 * and gh#1380 (the result of a killed run persisted as a cache entry).
 *
 * ## The two defects are one incident
 *
 * `spawnCmd` bound only `code` from Node's `close` event:
 *
 * ```ts
 * child.on('close', (code) => finalise(code));   // signal dropped here
 * ```
 *
 * `close` fires with `(code, signal)` and exactly ONE of them is non-null. A
 * process killed by a signal therefore arrived at the caller as
 * `exitCode: null` — the same value produced by a spawn that never started —
 * one line after the two were distinguishable. `validateTool` then reported
 * it as `E_EVIDENCE_TOOL_UNAVAILABLE`, whose message is
 * "binary missing or spawn error".
 *
 * Measured in the field: a 41-minute monorepo suite, traced live in `/proc`
 * with seven vitest workers executing, reported as a missing binary. Three
 * operators independently went and verified that `npm` and `pnpm` resolved
 * under `env -i` before anyone questioned the message. The real cause was
 * `withMemoryLimit` (T12116), which runs `test` and `build` inside a systemd
 * scope with `MemorySwapMax=0` — so the kernel SIGKILLs the whole cgroup when
 * the suite exceeds the ceiling. The guard worked; the reporting did not.
 *
 * That `exitCode: null` was then WRITTEN to the evidence cache. The `timedOut`
 * branch already declined to persist a non-result; a signal kill that is not a
 * CLEO timeout had no equivalent guard. When the tool runs off a non-git root,
 * `head` and `dirtyFingerprint` are also null — and both are components of the
 * cache key, so the key cannot change. A key that cannot change can never be
 * invalidated by a commit or an edit, so one killed run serves a cached
 * "binary missing" forever without ever spawning again. A single false pass is
 * one wrong answer; a permanent false failure blocks every gate on that tool
 * and no amount of correct work clears it.
 *
 * ## Why these tests kill with SIGKILL from inside the tool
 *
 * The production trigger is a cgroup OOM kill, which cannot be provoked
 * portably or cheaply. What the code under test actually reacts to is the
 * `close` event's `signal` argument, and a script that kills its own process
 * group produces exactly that — the same event, the same arguments, in a
 * hundred milliseconds. Reproducing the memory pressure would test the kernel,
 * not this module.
 *
 * @task T12182 (gh#1381, gh#1380)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readCacheEntry, runToolCached } from '../tool-cache.js';
import type { ResolvedToolCommand } from '../tool-resolver.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString();
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'first']);
}

function shCommand(script: string, canonical = 'lint'): ResolvedToolCommand {
  return {
    canonical,
    displayName: canonical,
    cmd: 'sh',
    args: ['-c', script],
    source: 'language-default',
    primaryType: 'unknown',
  };
}

/**
 * A script that prints, then SIGKILLs itself.
 *
 * `kill -9 $$` targets the shell itself, so the child is terminated by a
 * signal rather than exiting — which is the exact shape of a cgroup OOM kill
 * as far as the `close` event is concerned.
 */
const SELF_KILL = 'echo running-before-the-kill; kill -9 $$';

/** Count entries in the project's evidence cache directory. */
function cacheEntryCount(projectRoot: string): number {
  const dir = join(projectRoot, '.cleo', 'cache', 'evidence');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

/** Every entry file in the cache, parsed. */
function cacheEntries(projectRoot: string): Array<Record<string, unknown>> {
  const dir = join(projectRoot, '.cleo', 'cache', 'evidence');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>);
}

let originalCleoHome: string | undefined;
let cleoHomeDir: string;
beforeAll(() => {
  originalCleoHome = process.env.CLEO_HOME;
  cleoHomeDir = mkdtempSync(join(tmpdir(), 'gh1381-cleohome-'));
  process.env.CLEO_HOME = cleoHomeDir;
  // Disable the global per-tool semaphore: these tests care about the close
  // event, not about cross-process scheduling, and a real slot would make them
  // wait on any other tool run on the machine.
  process.env.CLEO_TOOL_CONCURRENCY_LINT = '0';
  process.env.CLEO_TOOL_CONCURRENCY_TEST = '0';
});
afterAll(() => {
  rmSync(cleoHomeDir, { recursive: true, force: true });
  delete process.env.CLEO_TOOL_CONCURRENCY_LINT;
  delete process.env.CLEO_TOOL_CONCURRENCY_TEST;
  if (originalCleoHome === undefined) delete process.env.CLEO_HOME;
  else process.env.CLEO_HOME = originalCleoHome;
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh1381-repo-'));
  initRepo(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('gh#1381 — a killed tool is distinguishable from one that never started', () => {
  it('reports the signal that terminated the run', async () => {
    const result = await runToolCached(shCommand(SELF_KILL), dir);

    // THE assertion. Before the fix this was `undefined` — the field did not
    // exist — and the caller had no way to tell a kill from a missing binary.
    expect(result.signal).toBe('SIGKILL');
    expect(result.exitCode).toBeNull();
  });

  it('a tool that exits normally reports no signal', async () => {
    const ok = await runToolCached(shCommand('exit 0'), dir);
    expect(ok.signal).toBeNull();
    expect(ok.exitCode).toBe(0);

    const bad = await runToolCached(shCommand('exit 3'), dir);
    expect(bad.signal).toBeNull();
    expect(bad.exitCode).toBe(3);
  });

  it('a binary that does not exist reports no signal — it never ran', async () => {
    const missing: ResolvedToolCommand = {
      canonical: 'lint',
      displayName: 'lint',
      cmd: 'cleo-no-such-binary-9f3a2b',
      args: [],
      source: 'language-default',
      primaryType: 'unknown',
    };
    const result = await runToolCached(missing, dir);

    // Both cases give exitCode null. ONLY the signal separates them, which is
    // why dropping it collapsed two different facts into one message.
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
  });

  it('captures the output the tool produced before it was killed', async () => {
    const result = await runToolCached(shCommand(SELF_KILL), dir);

    // On a signal death the tail is not garbage — it is the last thing the
    // tool printed before the kernel intervened, which is where the diagnosis
    // lives. The pre-fix path discarded it.
    expect(result.stdoutTail).toContain('running-before-the-kill');
  });
});

describe('gh#1380 — the result of a killed run is never cached', () => {
  it('writes no cache entry when the tool was killed', async () => {
    expect(cacheEntryCount(dir)).toBe(0);

    const result = await runToolCached(shCommand(SELF_KILL), dir);
    expect(result.exitCode).toBeNull();
    expect(result.cacheHit).toBe(false);

    // A `{pending: true}` placeholder is written before the spawn to satisfy
    // proper-lockfile, and is allowed to remain — `readCacheEntry` refuses it.
    // What must NOT remain is a well-formed entry carrying a null exitCode.
    const persisted = cacheEntries(dir).filter((e) => e['pending'] !== true);
    expect(persisted).toEqual([]);
  });

  it('a killed run does not poison the next attempt', async () => {
    await runToolCached(shCommand(SELF_KILL), dir);

    // Same command, same tree, therefore the same cache key. If the killed
    // run had been cached, this would be served from it without spawning —
    // and in a non-git root, where head and dirtyFingerprint are both null,
    // the key never changes, so it would be served forever.
    const second = await runToolCached(shCommand(SELF_KILL), dir);
    expect(second.cacheHit).toBe(false);
  });

  it('a successful run IS cached — the guard is narrow', async () => {
    const first = await runToolCached(shCommand('exit 0'), dir);
    expect(first.cacheHit).toBe(false);

    const second = await runToolCached(shCommand('exit 0'), dir);
    expect(second.cacheHit).toBe(true);
    expect(second.exitCode).toBe(0);
  });

  it('a failing run IS cached — a non-zero exit is a real result', async () => {
    await runToolCached(shCommand('exit 7'), dir);
    const second = await runToolCached(shCommand('exit 7'), dir);

    // Distinguishing "the tool ran and failed" from "we do not know what
    // happened" is the whole point. The first is evidence and is cacheable.
    expect(second.cacheHit).toBe(true);
    expect(second.exitCode).toBe(7);
  });

  it('refuses a null-exitCode entry already on disk, so shipped ones retire', () => {
    // Entries written by <= 2026.9.1 cannot clean themselves up: with head and
    // dirtyFingerprint null the key is frozen, so nothing ever rotates them
    // out. Refusing them on READ is what retires them.
    const key = 'deadbeefcafe0001';
    const cacheDir = join(dir, '.cleo', 'cache', 'evidence');
    execFileSync('mkdir', ['-p', cacheDir]);
    writeFileSync(
      join(cacheDir, `${key}.json`),
      JSON.stringify({
        schemaVersion: 1,
        key,
        canonical: 'lint',
        displayName: 'lint',
        cmd: 'sh',
        args: ['-c', 'true'],
        source: 'language-default',
        head: null,
        dirtyFingerprint: null,
        exitCode: null,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 1,
        capturedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    expect(readCacheEntry(dir, key)).toBeNull();
  });

  it('still returns a well-formed entry with a real exit code', () => {
    const key = 'deadbeefcafe0002';
    const cacheDir = join(dir, '.cleo', 'cache', 'evidence');
    execFileSync('mkdir', ['-p', cacheDir]);
    writeFileSync(
      join(cacheDir, `${key}.json`),
      JSON.stringify({
        schemaVersion: 1,
        key,
        canonical: 'lint',
        displayName: 'lint',
        cmd: 'sh',
        args: ['-c', 'true'],
        source: 'language-default',
        head: 'abc123',
        dirtyFingerprint: 'def456',
        exitCode: 0,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 1,
        capturedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    // The read guard must not be so broad that it discards real results —
    // that would turn a fix for a permanent false red into a permanent cache
    // miss, which is the same class of overcorrection.
    expect(readCacheEntry(dir, key)?.exitCode).toBe(0);
  });
});
