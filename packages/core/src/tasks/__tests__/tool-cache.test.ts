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
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cacheEntryPath,
  captureDirtyFingerprint,
  captureHead,
  clearToolCache,
  computeCacheKey,
  readCacheEntry,
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

  it('dirtyFingerprint changes when the tree is edited', async () => {
    initRepo(dir);
    const fp1 = await captureDirtyFingerprint(dir);
    writeFileSync(join(dir, 'b.txt'), 'untracked\n');
    const fp2 = await captureDirtyFingerprint(dir);
    expect(fp1).not.toBe(fp2);
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

  it('differs for different HEAD shas', () => {
    const a = computeCacheKey(cmd, 'abc', 'x');
    const b = computeCacheKey(cmd, 'def', 'x');
    expect(a).not.toBe(b);
  });

  it('differs for different dirty fingerprints', () => {
    const a = computeCacheKey(cmd, 'abc', 'x');
    const b = computeCacheKey(cmd, 'abc', 'y');
    expect(a).not.toBe(b);
  });

  it('differs for different args', () => {
    const a = computeCacheKey(cmd, 'abc', null);
    const b = computeCacheKey({ ...cmd, args: ['bye'] }, 'abc', null);
    expect(a).not.toBe(b);
  });

  it('is stable for identical inputs', () => {
    const a = computeCacheKey(cmd, 'abc', 'x');
    const b = computeCacheKey({ ...cmd }, 'abc', 'x');
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

  it('invalidates when an uncommitted file is added', async () => {
    const cmd = shCommand(`printf x >> "${markerFile}"; echo ok`);
    await runToolCached(cmd, dir);

    writeFileSync(join(dir, 'untracked.txt'), 'hello\n');

    const r2 = await runToolCached(cmd, dir);
    expect(r2.cacheHit).toBe(false);
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
