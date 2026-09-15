/**
 * Unit tests for the evidence-tool result cache + cross-process semaphore
 * (T1534 / ADR-061).
 *
 * Covers:
 *   - Cache hits return the prior result without re-spawning the tool.
 *   - Cache misses re-spawn and write a fresh entry.
 *   - HEAD changes invalidate the cache.
 *   - Uncommitted-tree edits invalidate the cache.
 *   - Two parallel `runToolCached` calls coalesce: only one spawn occurs;
 *     the second observer reads the result the first wrote.
 *   - `bypassCache: true` always re-spawns (and updates the cache).
 *   - `clearToolCache` removes all entries.
 *
 * @task T1534
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../../store/lock.js';
import {
  cacheEntryPath,
  captureDirtyFingerprint,
  captureHead,
  clearToolCache,
  computeCacheKey,
  DEFAULT_SPAWN_TIMEOUT_MS,
  readCacheEntry,
  resolveSpawnTimeoutMs,
  runToolCached,
} from '../tool-cache.js';
import type { ResolvedToolCommand } from '../tool-resolver.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString();
}

function initRepo(dir: string): string {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'first']);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/**
 * A tiny ResolvedToolCommand whose execution we can observe via side effects.
 * `cmd: 'sh', args: ['-c', '<script>']` lets each test write a marker file
 * to count actual spawns.
 */
function shCommand(script: string): ResolvedToolCommand {
  return {
    canonical: 'test',
    displayName: 'test',
    cmd: 'sh',
    args: ['-c', script],
    source: 'language-default',
    primaryType: 'unknown',
  };
}

// Isolate the global per-tool semaphore (tool-semaphore.ts) into a tmpdir
// so tests don't write to the user's real ~/.local/share/cleo/locks/.
let originalCleoHome: string | undefined;
let cleoHomeDir: string;
beforeAll(() => {
  originalCleoHome = process.env.CLEO_HOME;
  cleoHomeDir = mkdtempSync(join(tmpdir(), 'tool-cache-cleohome-'));
  process.env.CLEO_HOME = cleoHomeDir;
  // Disable the bound for the simple sequential / hit-miss tests; targeted
  // tests below override per-canonical concurrency where needed.
  process.env.CLEO_TOOL_CONCURRENCY_TEST = '0';
});
afterAll(() => {
  rmSync(cleoHomeDir, { recursive: true, force: true });
  delete process.env.CLEO_TOOL_CONCURRENCY_TEST;
  if (originalCleoHome === undefined) {
    delete process.env.CLEO_HOME;
  } else {
    process.env.CLEO_HOME = originalCleoHome;
  }
});

describe('captureHead + captureDirtyFingerprint', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-cache-fp-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the directory is not a git repo', async () => {
    expect(await captureHead(dir)).toBeNull();
    expect(await captureDirtyFingerprint(dir)).toBeNull();
  });

  it('captures HEAD sha for a real repo', async () => {
    const sha = initRepo(dir);
    const head = await captureHead(dir);
    expect(head).toBe(sha);
  });

  it('dirtyFingerprint changes when a TRACKED file is modified', async () => {
    initRepo(dir);
    const fp1 = await captureDirtyFingerprint(dir);
    writeFileSync(join(dir, 'a.txt'), 'edited\n'); // a.txt is committed by initRepo
    const fp2 = await captureDirtyFingerprint(dir);
    expect(fp1).not.toBe(fp2);
  });

  it('dirtyFingerprint IGNORES untracked files (gh#1221)', async () => {
    // Behaviour change, not a relaxation of rigour. While untracked files
    // counted, any tool that emitted one (coverage/, *.log, .vitest/ — none
    // gitignored here) changed the key the NEXT call computes, so the tool
    // invalidated its own cache entry merely by running and the cache could
    // never hit. The cost is pinned in tool-cache-gh1221.test.ts under
    // "TRADEOFF", with CLEO_EVIDENCE_FRESH as the escape hatch.
    initRepo(dir);
    const fp1 = await captureDirtyFingerprint(dir);
    writeFileSync(join(dir, 'b.txt'), 'untracked\n');
    const fp2 = await captureDirtyFingerprint(dir);
    expect(fp1).toBe(fp2);
  });
});

describe('computeCacheKey', () => {
  const cmd: ResolvedToolCommand = {
    canonical: 'test',
    displayName: 'test',
    cmd: 'echo',
    args: ['hi'],
    source: 'language-default',
  };
  const ROOT = '/tmp/cleo-key-root-a';

  it('differs for different HEAD shas', () => {
    const a = computeCacheKey(cmd, 'abc', 'x', ROOT);
    const b = computeCacheKey(cmd, 'def', 'x', ROOT);
    expect(a).not.toBe(b);
  });

  it('differs for different dirty fingerprints', () => {
    const a = computeCacheKey(cmd, 'abc', 'x', ROOT);
    const b = computeCacheKey(cmd, 'abc', 'y', ROOT);
    expect(a).not.toBe(b);
  });

  it('differs for different args', () => {
    const a = computeCacheKey(cmd, 'abc', null, ROOT);
    const b = computeCacheKey({ ...cmd, args: ['bye'] }, 'abc', null, ROOT);
    expect(a).not.toBe(b);
  });

  it('is stable for identical inputs', () => {
    const a = computeCacheKey(cmd, 'abc', 'x', ROOT);
    const b = computeCacheKey({ ...cmd }, 'abc', 'x', ROOT);
    expect(a).toBe(b);
  });
});

describe('runToolCached — cache hit/miss flow', () => {
  let dir: string;
  let markerDir: string;
  let markerFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-cache-run-'));
    initRepo(dir);
    // Marker file lives OUTSIDE the repo so spawn side-effects don't dirty
    // the tree and invalidate our own cache.
    markerDir = mkdtempSync(join(tmpdir(), 'tool-cache-marker-'));
    markerFile = join(markerDir, 'spawn-count.txt');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
  });

  it('first call is a cache miss; second is a hit and does not re-spawn', async () => {
    // Append "x" to markerFile each time the script runs.
    const cmd = shCommand(`printf x >> "${markerFile}"; echo done`);

    const r1 = await runToolCached(cmd, dir);
    expect(r1.cacheHit).toBe(false);
    expect(r1.exitCode).toBe(0);
    expect(r1.stdoutTail).toContain('done');

    const r2 = await runToolCached(cmd, dir);
    expect(r2.cacheHit).toBe(true);
    expect(r2.exitCode).toBe(0);

    // Marker file should have exactly ONE 'x' — the second call did not spawn.
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(markerFile, 'utf-8');
    expect(content).toBe('x');
  });

  it('writes a cache entry with metadata', async () => {
    const cmd = shCommand('echo ok');
    const r = await runToolCached(cmd, dir);
    expect(r.cacheHit).toBe(false);

    const path = cacheEntryPath(dir, r.entry.key);
    expect(existsSync(path)).toBe(true);

    const entry = readCacheEntry(dir, r.entry.key);
    expect(entry).not.toBeNull();
    expect(entry?.cmd).toBe('sh');
    expect(entry?.canonical).toBe('test');
    expect(entry?.exitCode).toBe(0);
    expect(typeof entry?.capturedAt).toBe('string');
  });

  it('captures non-zero exit codes in the cache', async () => {
    const cmd = shCommand('exit 7');
    const r = await runToolCached(cmd, dir);
    expect(r.exitCode).toBe(7);

    const r2 = await runToolCached(cmd, dir);
    expect(r2.cacheHit).toBe(true);
    expect(r2.exitCode).toBe(7);
  });

  it('bypassCache: true forces a re-spawn and refreshes the entry', async () => {
    const cmd = shCommand(`printf x >> "${markerFile}"; echo ok`);
    await runToolCached(cmd, dir);
    await runToolCached(cmd, dir, { bypassCache: true });
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(markerFile, 'utf-8')).toBe('xx');
  });
});

describe('runToolCached — invalidation', () => {
  let dir: string;
  let markerDir: string;
  let markerFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-cache-invalid-'));
    initRepo(dir);
    markerDir = mkdtempSync(join(tmpdir(), 'tool-cache-marker-'));
    markerFile = join(markerDir, 'spawn-count.txt');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
  });

  it('invalidates when HEAD changes (new commit)', async () => {
    const cmd = shCommand(`printf x >> "${markerFile}"; echo ok`);
    await runToolCached(cmd, dir);

    // Move HEAD: stage and commit a new file.
    writeFileSync(join(dir, 'c.txt'), 'two\n');
    git(dir, ['add', 'c.txt']);
    git(dir, ['commit', '-q', '-m', 'second']);

    const r2 = await runToolCached(cmd, dir);
    expect(r2.cacheHit).toBe(false);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(markerFile, 'utf-8')).toBe('xx');
  });

  it('invalidates when a TRACKED file is modified without committing', async () => {
    const cmd = shCommand(`printf x >> "${markerFile}"; echo ok`);
    await runToolCached(cmd, dir);

    // a.txt is tracked (committed by initRepo) — an uncommitted edit to it
    // must still invalidate, or the cache would hide real work in progress.
    writeFileSync(join(dir, 'a.txt'), 'uncommitted edit\n');

    const r2 = await runToolCached(cmd, dir);
    expect(r2.cacheHit).toBe(false);
  });

  it('does NOT invalidate when an untracked file is added (gh#1221 tradeoff)', async () => {
    // See captureDirtyFingerprint's docblock. Untracked output from the tool
    // itself is indistinguishable from untracked input by the operator, and
    // counting either one made caching impossible in practice.
    const cmd = shCommand(`printf x >> "${markerFile}"; echo ok`);
    await runToolCached(cmd, dir);

    writeFileSync(join(dir, 'untracked.txt'), 'hello\n');

    const r2 = await runToolCached(cmd, dir);
    expect(r2.cacheHit).toBe(true);
  });
});

describe('runToolCached — bounded stdout buffer (memory leak fix)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-cache-mem-'));
    initRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not retain unbounded stdout when the child emits megabytes of output', async () => {
    // Emit ~5 MB of output. Pre-T1534 this was held in resident memory.
    // Post-fix the spawn-time buffer is capped at 64 KB; the cached tail
    // is 512 bytes.
    const cmd: ResolvedToolCommand = {
      canonical: 'test',
      displayName: 'test',
      cmd: 'sh',
      args: ['-c', 'yes "abcdefghij" 2>/dev/null | head -c 5242880; echo END'],
      source: 'language-default',
      primaryType: 'unknown',
    };

    const before = process.memoryUsage().heapUsed;
    const r = await runToolCached(cmd, dir, { skipGlobalSemaphore: true });
    const after = process.memoryUsage().heapUsed;

    expect(r.exitCode).toBe(0);
    // The cached stdoutTail is bounded by `tailBytes` (default 512).
    expect(r.stdoutTail.length).toBeLessThanOrEqual(513); // +1 for the '…' marker
    expect(r.stdoutTail).toContain('END');
    // Heap growth should be bounded (well under the 5 MB streamed). We
    // give a 4 MB headroom for vitest harness churn — the pre-fix
    // behaviour exceeded 5 MB deterministically.
    expect(after - before).toBeLessThan(4 * 1024 * 1024);
  });
});

describe('runToolCached — concurrent coalescing', () => {
  let dir: string;
  let markerDir: string;
  let markerFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-cache-conc-'));
    initRepo(dir);
    markerDir = mkdtempSync(join(tmpdir(), 'tool-cache-marker-'));
    markerFile = join(markerDir, 'spawn-count.txt');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
  });

  it('two parallel calls share a single tool execution via the lock', async () => {
    // Slow script: sleeps 200 ms and increments marker once.
    const cmd = shCommand(`sleep 0.2; printf x >> "${markerFile}"; echo ok`);

    const [r1, r2] = await Promise.all([runToolCached(cmd, dir), runToolCached(cmd, dir)]);

    // Exactly one of them should have actually spawned (cacheHit=false);
    // the other observed the freshly-written entry under the lock.
    const hits = [r1.cacheHit, r2.cacheHit];
    expect(hits.filter((h) => h === false).length).toBe(1);
    expect(hits.filter((h) => h === true).length).toBe(1);

    const { readFileSync } = await import('node:fs');
    expect(readFileSync(markerFile, 'utf-8')).toBe('x');
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
  });
});

describe('runToolCached — global semaphore bounds cross-key concurrency (Scenario B)', () => {
  let dirA: string;
  let dirB: string;
  let dirC: string;
  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'tool-cache-sem-A-'));
    dirB = mkdtempSync(join(tmpdir(), 'tool-cache-sem-B-'));
    dirC = mkdtempSync(join(tmpdir(), 'tool-cache-sem-C-'));
    initRepo(dirA);
    initRepo(dirB);
    initRepo(dirC);
    // Force a 2-slot ceiling so at most 2 spawns can run concurrently.
    process.env.CLEO_TOOL_CONCURRENCY_TEST = '2';
  });
  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(dirC, { recursive: true, force: true });
    // Restore the suite-wide default (concurrency disabled).
    process.env.CLEO_TOOL_CONCURRENCY_TEST = '0';
  });

  it('three independent worktree-style repos — at most 2 spawns run at once', async () => {
    // Each repo writes its own arrival timestamp into a shared log so we
    // can reconstruct the timeline.  The script sleeps so concurrent
    // arrivals overlap in time.
    const logFile = join(tmpdir(), `sem-log-${process.pid}-${Date.now()}.txt`);
    const script = (label: string) =>
      `printf '%s START %s\\n' "$(date +%s%N)" ${label} >> "${logFile}"; ` +
      `sleep 0.4; ` +
      `printf '%s END   %s\\n' "$(date +%s%N)" ${label} >> "${logFile}"`;

    const cmdA: ResolvedToolCommand = {
      canonical: 'test',
      displayName: 'test',
      cmd: 'sh',
      args: ['-c', script('A')],
      source: 'language-default',
      primaryType: 'unknown',
    };
    const cmdB: ResolvedToolCommand = { ...cmdA, args: ['-c', script('B')] };
    const cmdC: ResolvedToolCommand = { ...cmdA, args: ['-c', script('C')] };

    const startedAt = Date.now();
    const [rA, rB, rC] = await Promise.all([
      runToolCached(cmdA, dirA, { semaphoreOptions: { pollMs: 20 } }),
      runToolCached(cmdB, dirB, { semaphoreOptions: { pollMs: 20 } }),
      runToolCached(cmdC, dirC, { semaphoreOptions: { pollMs: 20 } }),
    ]);
    const totalMs = Date.now() - startedAt;

    // All three ran the spawn (different repos → different cache keys).
    expect(rA.cacheHit).toBe(false);
    expect(rB.cacheHit).toBe(false);
    expect(rC.cacheHit).toBe(false);

    // With 3 spawns × 0.4 s and a 2-slot semaphore: the first two run in
    // parallel (~0.4 s wall), the third waits for one to finish then runs
    // alone (~0.4 s more) → expect ~0.8 s total. If the semaphore did
    // NOTHING, all three would overlap and total would be ~0.4 s.
    // We allow generous slack for slow CI: > 600 ms proves serialisation.
    expect(totalMs).toBeGreaterThan(600);

    // Verify via the timeline that no 3 spawns were ever simultaneously
    // in flight.
    const { readFileSync } = await import('node:fs');
    const events = readFileSync(logFile, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => {
        const [tsStr, kind, label] = line.split(/\s+/);
        return { ts: BigInt(tsStr ?? '0'), kind, label };
      })
      .sort((x, y) => (x.ts === y.ts ? 0 : x.ts < y.ts ? -1 : 1));

    let inFlight = 0;
    let maxInFlight = 0;
    for (const e of events) {
      if (e.kind === 'START') inFlight++;
      else inFlight--;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
    }
    expect(maxInFlight).toBeLessThanOrEqual(2);

    rmSync(logFile, { force: true });
  });
});

describe('clearToolCache', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-cache-clear-'));
    initRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes every cached entry', async () => {
    await runToolCached(shCommand('echo a'), dir);
    await runToolCached(shCommand('echo b'), dir);

    const cacheDir = join(dir, '.cleo', 'cache', 'evidence');
    const before = readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
    expect(before.length).toBeGreaterThanOrEqual(2);

    const r = clearToolCache(dir);
    expect(r.removed).toBe(before.length);

    const after = readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
    expect(after.length).toBe(0);
  });

  it('returns removed:0 when no cache exists', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'tool-cache-empty-'));
    try {
      const r = clearToolCache(fresh);
      expect(r.removed).toBe(0);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

/**
 * Build a ResolvedToolCommand that hangs forever (node event loop).
 * Responds correctly to SIGTERM across all platforms (unlike `sleep`
 * under `sh -c` which ignores signals in some environments).
 */
function hungCommand(): ResolvedToolCommand {
  return {
    canonical: 'test',
    displayName: 'test',
    cmd: 'node',
    args: ['-e', 'setTimeout(() => {}, 999999)'],
    source: 'language-default',
    primaryType: 'unknown',
  };
}

/**
 * Build a ResolvedToolCommand that hangs AND spawns a long-lived descendant
 * with inherited stdio (simulating `pnpm test` that forks workers).
 * Without process-group killing, the descendant keeps the pipe open and
 * Node's `close` never fires.
 *
 * @task T12025
 */
function hungWithDescendantCommand(): ResolvedToolCommand {
  return {
    canonical: 'test',
    displayName: 'test',
    cmd: 'node',
    args: [
      '-e',
      // Spawn a `sleep` descendant that inherits our stdio pipes,
      // then the parent hangs on the event loop. The double-fork
      // + unref ensures the descendant outlives the parent unless
      // the entire process group is killed.
      `const{spawn:c}=require("child_process");` +
        `const d=c("sleep",["999"],{stdio:"inherit"});` +
        `d.unref();` +
        `setTimeout(()=>{},999999)`,
    ],
    source: 'language-default',
    primaryType: 'unknown',
  };
}

// ---------------------------------------------------------------------------
// T12025: wall-clock child-process deadline + fail-fast timeout
// ---------------------------------------------------------------------------

describe('runToolCached — wall-clock spawn deadline (T12025)', () => {
  let dir: string;
  let markerDir: string;
  let markerFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-cache-timed-'));
    initRepo(dir);
    markerDir = mkdtempSync(join(tmpdir(), 'tool-cache-marker-'));
    markerFile = join(markerDir, 'spawn-count.txt');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
  });

  it('kills a hung child process and returns timedOut:true when the deadline fires', {
    timeout: 15_000,
  }, async () => {
    const r = await runToolCached(hungCommand(), dir, {
      spawnTimeoutMs: 300,
      skipGlobalSemaphore: true,
      lockStaleMs: 10_000,
    });

    expect(r.timedOut).toBe(true);
    expect(r.cacheHit).toBe(false);
  });

  it('releases the lock after timeout so a subsequent retry succeeds', {
    timeout: 15_000,
  }, async () => {
    // First call: hung process times out.
    const r1 = await runToolCached(hungCommand(), dir, {
      spawnTimeoutMs: 200,
      skipGlobalSemaphore: true,
      lockStaleMs: 10_000,
    });
    expect(r1.timedOut).toBe(true);

    // Second call: fast process, no timeout — must succeed because the
    // lock and semaphore were released after the first timeout.
    const r2 = await runToolCached(shCommand(`printf x >> "${markerFile}"; echo ok`), dir, {
      skipGlobalSemaphore: true,
    });
    expect(r2.timedOut).toBe(false);
    expect(r2.cacheHit).toBe(false);
    expect(r2.exitCode).toBe(0);

    const { readFileSync: rs } = await import('node:fs');
    expect(rs(markerFile, 'utf-8')).toBe('x');
  });

  it('no cached entry is written on timeout — retry triggers a fresh spawn', {
    timeout: 15_000,
  }, async () => {
    // Force timeout with a hung process on a different key pair.
    const r1 = await runToolCached(hungCommand(), dir, {
      spawnTimeoutMs: 200,
      skipGlobalSemaphore: true,
      lockStaleMs: 10_000,
    });
    expect(r1.timedOut).toBe(true);

    // Retry with a real command — must not see a stale cache entry
    // and must produce a real result (cacheHit: false, exitCode: 0).
    const r2 = await runToolCached(shCommand(`echo done`), dir, {
      skipGlobalSemaphore: true,
    });
    expect(r2.timedOut).toBe(false);
    expect(r2.cacheHit).toBe(false);
    expect(r2.exitCode).toBe(0);
  });

  it('normal (non-timeout) results have timedOut:false', async () => {
    const cmd = shCommand('echo ok');
    const r = await runToolCached(cmd, dir);
    expect(r.timedOut).toBe(false);
    expect(r.cacheHit).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('cache hits preserve timedOut:false', async () => {
    const cmd = shCommand('echo ok');
    await runToolCached(cmd, dir);
    const r = await runToolCached(cmd, dir);
    expect(r.cacheHit).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it('process-tree kill: timeout resolves when a descendant holds inherited stdio', {
    timeout: 15_000,
  }, async () => {
    // Descendant `sleep 999` inherits our pipe — without process-group
    // killing, the pipe stays open and Node's `close` never fires.
    const r1 = await runToolCached(hungWithDescendantCommand(), dir, {
      spawnTimeoutMs: 400,
      skipGlobalSemaphore: true,
      lockStaleMs: 10_000,
    });

    expect(r1.timedOut).toBe(true);
    expect(r1.cacheHit).toBe(false);

    // The `sleep` descendant was in the same process group and must be
    // dead — otherwise the lock would still be held.  Retry proves it.
    const r2 = await runToolCached(shCommand(`echo ok`), dir, {
      skipGlobalSemaphore: true,
    });
    expect(r2.timedOut).toBe(false);
    expect(r2.lockBusy).toBe(false);
    expect(r2.cacheHit).toBe(false);
    expect(r2.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T12025: lock contention — fail-fast typed busy outcome + retry recovery
// ---------------------------------------------------------------------------

describe('runToolCached — lock contention fail-fast (T12025)', () => {
  let dir: string;
  /**
   * Staleness window handed to `runToolCached`, and the bound the assertion
   * uses. ONE constant so the option and the assertion cannot drift apart —
   * a bound that silently stopped matching the option it describes would make
   * the test pass for the wrong reason (gh#1254).
   */
  const LOCK_STALE_MS = 10_000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-cache-busy-'));
    initRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The property under test is that a held lock makes `runToolCached` GIVE UP
   * rather than wait out `lockStaleMs`. It is NOT "this completes in under 2
   * seconds" (gh#1254).
   *
   * The old assertion was `elapsedMs < 2_000`, which measured module-resolution
   * cost as much as behaviour. Measured across four trees with the assertion
   * held constant:
   *
   *   main, shared checkout, real node_modules    PASS
   *   main, fresh worktree, SYMLINKED             FAIL (7.8 s)
   *   feature branch, worktree, symlinked         FAIL (5.5–8.9 s)
   *   feature branch, worktree, real install      PASS
   *
   * Row 2 is the one that matters: unmodified `main` failed its own test purely
   * because `node_modules` was a symlink to a shared store. So the test's
   * verdict was decided by how the tree was provisioned, and it cost two
   * sessions — the first three data points available all pointed at an innocent
   * feature branch, and a regression was nearly filed against it.
   *
   * **A test that can accuse an unrelated diff is worse than no test.**
   *
   * The bound is now `lockStaleMs`, which is what the behaviour actually
   * implies: had the code waited for the lock to go stale it would have taken
   * AT LEAST that long and then returned a real result rather than
   * `lockBusy: true`. That discriminates the two behaviours with a wide margin
   * instead of a coin flip, and no tighter wall-clock bound is testable without
   * re-introducing sensitivity to provisioning.
   */
  it('gives up instead of waiting out lockStaleMs when the cache lock is held externally', {
    timeout: 30_000,
  }, async () => {
    const cmd = shCommand('echo ok');

    // Pre-compute the exact cache path that runToolCached will target.
    const headVal = await captureHead(dir);
    const dirtyVal = await captureDirtyFingerprint(dir);
    const key = computeCacheKey(cmd, headVal, dirtyVal, dir);
    const cachePath = cacheEntryPath(dir, key);

    // Ensure the cache directory exists so the write succeeds.
    mkdirSync(join(dir, '.cleo', 'cache', 'evidence'), { recursive: true });

    // Write the pending entry so runToolCached doesn't re-create it.
    writeFileSync(cachePath, JSON.stringify({ schemaVersion: 2, key, pending: true }));

    // Hold the lock ourselves — simulates another process running the tool.
    const release = await acquireLock(cachePath, { retries: 0 });

    try {
      const startedAt = Date.now();
      const r = await runToolCached(cmd, dir, {
        lockStaleMs: LOCK_STALE_MS,
        skipGlobalSemaphore: true,
      });
      const elapsedMs = Date.now() - startedAt;

      expect(r.lockBusy).toBe(true);
      expect(r.timedOut).toBe(false);
      expect(r.cacheHit).toBe(false);
      // The behavioural bound: it must NOT have waited for the lock to go
      // stale. `lockStaleMs` is 10_000 above, so anything under that proves the
      // give-up path ran rather than the wait-and-acquire path — and it is
      // insensitive to module-resolution cost, which is what made the old 2 s
      // budget flip on `node_modules` layout (gh#1254).
      expect(elapsedMs).toBeLessThan(LOCK_STALE_MS);
    } finally {
      await release();
    }

    // After releasing the lock, a retry must succeed.
    const r2 = await runToolCached(cmd, dir, { skipGlobalSemaphore: true });
    expect(r2.lockBusy).toBe(false);
    expect(r2.timedOut).toBe(false);
    expect(r2.cacheHit).toBe(false);
    expect(r2.exitCode).toBe(0);
  });

  it('normal (non-contended) results have lockBusy:false', async () => {
    const r = await runToolCached(shCommand('echo ok'), dir, {
      skipGlobalSemaphore: true,
    });
    expect(r.lockBusy).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('cache hits preserve lockBusy:false', async () => {
    const cmd = shCommand('echo ok');
    await runToolCached(cmd, dir, { skipGlobalSemaphore: true });
    const r = await runToolCached(cmd, dir, { skipGlobalSemaphore: true });
    expect(r.cacheHit).toBe(true);
    expect(r.lockBusy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CLEO_TOOL_TIMEOUT_<TOOL> — wall-clock deadline resolution (T12105 / gh#1193)
// ---------------------------------------------------------------------------

describe('resolveSpawnTimeoutMs (T12105)', () => {
  it('returns the 300s default when the env var is unset', () => {
    expect(resolveSpawnTimeoutMs('typecheck', {})).toBe(DEFAULT_SPAWN_TIMEOUT_MS);
    expect(DEFAULT_SPAWN_TIMEOUT_MS).toBe(300_000);
  });

  it('returns the default when the env var is empty', () => {
    expect(resolveSpawnTimeoutMs('typecheck', { CLEO_TOOL_TIMEOUT_TYPECHECK: '' })).toBe(
      DEFAULT_SPAWN_TIMEOUT_MS,
    );
    expect(resolveSpawnTimeoutMs('typecheck', { CLEO_TOOL_TIMEOUT_TYPECHECK: '   ' })).toBe(
      DEFAULT_SPAWN_TIMEOUT_MS,
    );
  });

  it('honours a valid positive-integer override', () => {
    expect(resolveSpawnTimeoutMs('typecheck', { CLEO_TOOL_TIMEOUT_TYPECHECK: '600000' })).toBe(
      600_000,
    );
  });

  it('follows the concurrency-var naming convention (uppercase, dashes → underscores)', () => {
    expect(
      resolveSpawnTimeoutMs('security-scan', { CLEO_TOOL_TIMEOUT_SECURITY_SCAN: '900000' }),
    ).toBe(900_000);
    // The dashed spelling is NOT consulted — same convention as CLEO_TOOL_CONCURRENCY_*.
    expect(
      resolveSpawnTimeoutMs('security-scan', { 'CLEO_TOOL_TIMEOUT_SECURITY-SCAN': '900000' }),
    ).toBe(DEFAULT_SPAWN_TIMEOUT_MS);
  });

  it('rejects non-numeric values with a clear error (no silent fallback)', () => {
    expect(() =>
      resolveSpawnTimeoutMs('typecheck', { CLEO_TOOL_TIMEOUT_TYPECHECK: 'ten-minutes' }),
    ).toThrow(/CLEO_TOOL_TIMEOUT_TYPECHECK must be a positive integer/);
  });

  it('rejects zero and negative values with a clear error', () => {
    expect(() => resolveSpawnTimeoutMs('test', { CLEO_TOOL_TIMEOUT_TEST: '0' })).toThrow(
      /CLEO_TOOL_TIMEOUT_TEST must be greater than zero/,
    );
    expect(() => resolveSpawnTimeoutMs('test', { CLEO_TOOL_TIMEOUT_TEST: '-5000' })).toThrow(
      /CLEO_TOOL_TIMEOUT_TEST/,
    );
  });

  it('rejects fractional and unit-suffixed values', () => {
    expect(() => resolveSpawnTimeoutMs('lint', { CLEO_TOOL_TIMEOUT_LINT: '1.5' })).toThrow(
      /CLEO_TOOL_TIMEOUT_LINT/,
    );
    expect(() => resolveSpawnTimeoutMs('lint', { CLEO_TOOL_TIMEOUT_LINT: '600000ms' })).toThrow(
      /CLEO_TOOL_TIMEOUT_LINT/,
    );
  });
});
