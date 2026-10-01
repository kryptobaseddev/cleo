/**
 * T12958 — a tool run's cache entry is keyed on the tracked TREE CONTENT it
 * measured, not on HEAD plus the directory it ran in.
 *
 * ## Why the key changed
 *
 * gh#1419 keyed the cache on `{canonical, cmd, args, head, dirtyFingerprint,
 * executionRoot}`. That stopped two worktrees at one HEAD sharing a result,
 * but it also made every worktree and every commit a miss: N agents in N
 * worktrees at the same content each ran the full suite, and so did a rebase,
 * an amend or an empty commit that left the content byte-identical.
 *
 * The key is now `{canonical, cmd, args, treeHash}`, where `treeHash` is the
 * git tree of the tracked content as it sits in the working tree. Two trees
 * share a result exactly when they hold the same tracked content.
 *
 * ## What this file protects
 *
 *   - `captureTreeHash` semantics: clean tree = HEAD^{tree}, tracked edits
 *     rotate it, reverting restores it, staging does not matter, untracked
 *     not-ignored files count, gitignored files / `.cleo/` / tool output do
 *     not (gh#1221), and a racy same-size edit is seen.
 *   - Worktree sharing, dirty-tree and untracked-file invalidation,
 *     empty-commit, commit-the-measured-content and rebase hits.
 *   - The environment fingerprint: build-output tools share only between
 *     equally installed and built checkouts.
 *   - A result from a deleted worktree is refused (gh#1419), though its tree
 *     object stays auditable.
 *   - Concurrent identical runs coalesce on the per-key lock.
 *   - The structural guard carried over from gh#1419: every member of
 *     TOOL_RUN_IDENTITY_FIELDS changes the key, and `isEntryUsable` requires
 *     every one.
 *
 * @task T12958
 * @task T12190 (gh#1419)
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { acquireLock } from '../../store/lock.js';
import {
  cacheEntryPath,
  captureTreeHash,
  computeCacheKey,
  isEntryUsable,
  readCacheEntry,
  runToolCached,
  TOOL_RUN_IDENTITY_FIELDS,
} from '../tool-cache.js';
import { captureEnvFingerprint } from '../tool-cache-env.js';
import type { ResolvedToolCommand } from '../tool-resolver.js';

function shCommand(script: string): ResolvedToolCommand {
  return {
    canonical: 'lint',
    displayName: 'lint',
    cmd: 'sh',
    args: ['-c', script],
    source: 'language-default',
  };
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

/** A git repo with one commit, so HEAD is real and the tree is clean. */
function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  writeFileSync(join(dir, 'b.txt'), 'world\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
}

let originalCleoHome: string | undefined;
let cleoHomeDir: string;
beforeAll(() => {
  originalCleoHome = process.env['CLEO_HOME'];
  cleoHomeDir = mkdtempSync(join(tmpdir(), 'tree-id-cleohome-'));
  process.env['CLEO_HOME'] = cleoHomeDir;
});
afterAll(() => {
  rmSync(cleoHomeDir, { recursive: true, force: true });
  if (originalCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = originalCleoHome;
});

describe('captureTreeHash', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tree-hash-'));
    initRepo(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a clean tree hashes to exactly HEAD^{tree}', async () => {
    expect(await captureTreeHash(dir)).toBe(git(dir, 'rev-parse', 'HEAD^{tree}'));
  });

  it('rotates on an unstaged tracked edit and returns when it is reverted', async () => {
    const clean = await captureTreeHash(dir);
    writeFileSync(join(dir, 'a.txt'), 'edited\n');
    const dirty = await captureTreeHash(dir);
    expect(dirty).not.toBe(clean);
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    expect(await captureTreeHash(dir)).toBe(clean);
  });

  it('distinguishes two different edits to the same file (content, not dirtiness)', async () => {
    writeFileSync(join(dir, 'a.txt'), 'broken\n');
    const broken = await captureTreeHash(dir);
    writeFileSync(join(dir, 'a.txt'), 'fixed\n');
    expect(await captureTreeHash(dir)).not.toBe(broken);
  });

  it('staged and unstaged copies of the same content hash the same', async () => {
    writeFileSync(join(dir, 'a.txt'), 'edited\n');
    const unstaged = await captureTreeHash(dir);
    git(dir, 'add', 'a.txt');
    expect(await captureTreeHash(dir)).toBe(unstaged);
  });

  it('sees a tracked deletion', async () => {
    const clean = await captureTreeHash(dir);
    rmSync(join(dir, 'b.txt'));
    expect(await captureTreeHash(dir)).not.toBe(clean);
  });

  it('COUNTS an untracked, not-ignored file (review of #1774)', async () => {
    const clean = await captureTreeHash(dir);
    writeFileSync(join(dir, 'new-module.ts'), 'export const x = 1;\n');
    expect(await captureTreeHash(dir)).not.toBe(clean);
  });

  it('ignores gitignored files, untracked .cleo/ state and tool output (gh#1221)', async () => {
    writeFileSync(join(dir, '.gitignore'), 'dist/\n');
    git(dir, 'add', '.gitignore');
    git(dir, 'commit', '-qm', 'ignore');
    const clean = await captureTreeHash(dir);
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'index.js'), 'built\n');
    mkdirSync(join(dir, '.cleo', 'cache'), { recursive: true });
    writeFileSync(join(dir, '.cleo', 'cache', 'x.json'), '{}');
    mkdirSync(join(dir, 'coverage'));
    writeFileSync(join(dir, 'coverage', 'lcov.info'), 'x');
    writeFileSync(join(dir, 'vitest.log'), 'x');
    expect(await captureTreeHash(dir)).toBe(clean);
  });

  it('sees a same-size edit with an unchanged mtime (racy-clean index copy)', async () => {
    // With ctime ignored, a same-size in-place rewrite whose mtime equals the
    // index entry's is invisible to git's stat check; only the racy-clean rule
    // (entry mtime >= index FILE mtime) forces a re-hash. A copy of the index
    // with a fresh mtime defeats that rule.
    git(dir, 'config', 'core.trustctime', 'false');
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'a.txt'), past, past);
    git(dir, 'update-index', '--refresh');
    const indexPath = join(dir, '.git', 'index');
    utimesSync(indexPath, past, past);
    const before = await captureTreeHash(dir);

    writeFileSync(join(dir, 'a.txt'), 'HELLO\n'); // same size as 'hello\n'
    utimesSync(join(dir, 'a.txt'), past, past);
    const after = await captureTreeHash(dir);
    expect(after).not.toBe(before);
  });

  it('never touches the real index', async () => {
    writeFileSync(join(dir, 'a.txt'), 'edited\n');
    await captureTreeHash(dir);
    // Still unstaged: the edit was staged into a private copy only.
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(dir, 'diff', '--name-only')).toBe('a.txt');
  });

  it('is null off git', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'tree-hash-plain-'));
    try {
      expect(await captureTreeHash(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('T12958 — runs are shared by content across worktrees and commits', () => {
  let repo: string;
  let wtParent: string;
  let wt: string;
  let markerDir: string;
  let marker: string;
  let cmd: ResolvedToolCommand;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'tree-share-repo-'));
    initRepo(repo);
    wtParent = mkdtempSync(join(tmpdir(), 'tree-share-wt-'));
    wt = join(wtParent, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
    markerDir = mkdtempSync(join(tmpdir(), 'tree-share-marker-'));
    marker = join(markerDir, 'spawns.txt');
    cmd = shCommand(`printf x >> "${marker}"; echo ok`);
  });
  afterEach(() => {
    for (const d of [repo, wtParent, markerDir]) rmSync(d, { recursive: true, force: true });
  });

  const spawns = (): number => (existsSync(marker) ? readFileSync(marker, 'utf-8').length : 0);

  it('a second worktree with identical content HITS the first one’s result', async () => {
    const first = await runToolCached(cmd, repo, { executionRoot: repo });
    expect(first.cacheHit).toBe(false);

    const second = await runToolCached(cmd, repo, { executionRoot: wt });
    expect(second.cacheHit).toBe(true);
    expect(second.entry.key).toBe(first.entry.key);
    // The result names the tree that asked, not the one that ran.
    expect(second.executionRoot).toBe(wt);
    expect(spawns()).toBe(1);
  });

  it('a dirty tracked change in one worktree MISSES', async () => {
    await runToolCached(cmd, repo, { executionRoot: repo });
    writeFileSync(join(wt, 'a.txt'), 'changed in the worktree\n');
    const r = await runToolCached(cmd, repo, { executionRoot: wt });
    expect(r.cacheHit).toBe(false);
    expect(spawns()).toBe(2);
  });

  it('an untracked failing test in worktree B MISSES worktree A’s entry (review of #1774)', async () => {
    // The false pass this guards: B's new, uncommitted test leaves the
    // tracked tree equal to A's, so a tracked-only key served A's pass.
    await runToolCached(cmd, repo, { executionRoot: repo });
    writeFileSync(join(wt, 'new.test.ts'), 'throw new Error("red");\n');
    const r = await runToolCached(cmd, repo, { executionRoot: wt });
    expect(r.cacheHit).toBe(false);
    expect(spawns()).toBe(2);
  });

  it('untracked tool output in worktree B still HITS (gh#1221)', async () => {
    await runToolCached(cmd, repo, { executionRoot: repo });
    writeFileSync(join(wt, 'scratch.log'), 'untracked\n');
    const r = await runToolCached(cmd, repo, { executionRoot: wt });
    expect(r.cacheHit).toBe(true);
    expect(spawns()).toBe(1);
  });

  it('an empty commit leaves the tree unchanged and HITS', async () => {
    await runToolCached(cmd, repo, { executionRoot: wt });
    git(wt, 'commit', '-q', '--allow-empty', '-m', 'empty');
    const r = await runToolCached(cmd, repo, { executionRoot: wt });
    expect(r.cacheHit).toBe(true);
    expect(spawns()).toBe(1);
  });

  it('committing exactly the dirty content that was measured HITS', async () => {
    writeFileSync(join(wt, 'a.txt'), 'work in progress\n');
    await runToolCached(cmd, repo, { executionRoot: wt });
    git(wt, 'commit', '-qam', 'wip');
    const r = await runToolCached(cmd, repo, { executionRoot: wt });
    expect(r.cacheHit).toBe(true);
    expect(spawns()).toBe(1);
  });

  it('a rebase that reproduces already-measured content HITS', async () => {
    // feature edits a.txt; main moves b.txt. After the rebase the feature
    // tree is main's b.txt + feature's a.txt — measured beforehand in the
    // main checkout as a dirty tree with the same content.
    writeFileSync(join(wt, 'a.txt'), 'feature\n');
    git(wt, 'commit', '-qam', 'feature');
    writeFileSync(join(repo, 'b.txt'), 'main moved\n');
    git(repo, 'commit', '-qam', 'main moved');
    writeFileSync(join(repo, 'a.txt'), 'feature\n');
    await runToolCached(cmd, repo, { executionRoot: repo });
    git(repo, 'checkout', '-q', '--', 'a.txt');

    git(wt, 'rebase', '-q', 'main');
    const r = await runToolCached(cmd, repo, { executionRoot: wt });
    expect(r.cacheHit).toBe(true);
    expect(spawns()).toBe(1);
  });

  it('a result from a DELETED worktree is refused, but its tree stays auditable', async () => {
    const first = await runToolCached(cmd, repo, { executionRoot: wt });
    git(repo, 'worktree', 'remove', '--force', wt);
    expect(existsSync(wt)).toBe(false);

    // gh#1419's refusal is kept: the recorded checkout is gone.
    const r = await runToolCached(cmd, repo, { executionRoot: repo });
    expect(r.cacheHit).toBe(false);
    expect(spawns()).toBe(2);
    // The tree object is still in the shared object database (until gc).
    const treeHash = first.entry.treeHash as string;
    expect(git(repo, 'cat-file', '-t', treeHash)).toBe('tree');
    expect(git(repo, 'ls-tree', '--name-only', treeHash)).toContain('a.txt');
  });

  it('the stored record carries the tree hash, HEAD and the tree that ran', async () => {
    const r = await runToolCached(cmd, repo, { executionRoot: wt });
    const onDisk = JSON.parse(readFileSync(cacheEntryPath(repo, r.entry.key), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(onDisk['schemaVersion']).toBe(3);
    expect(onDisk['treeHash']).toBe(git(wt, 'rev-parse', 'HEAD^{tree}'));
    expect(onDisk['head']).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(existsSync(onDisk['executionRoot'] as string)).toBe(true);
  });

  it('refuses a pre-T12958 (schema 2) entry even when its key matches', async () => {
    const r = await runToolCached(cmd, repo, { executionRoot: repo });
    const path = cacheEntryPath(repo, r.entry.key);
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...onDisk, schemaVersion: 2 }));
    expect(readCacheEntry(repo, r.entry.key)).toBeNull();
  });
});

describe('T12958 — concurrent identical runs coalesce on the per-key lock', () => {
  let repo: string;
  let wtParent: string;
  let wt: string;
  let markerDir: string;
  let marker: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'tree-lock-repo-'));
    initRepo(repo);
    wtParent = mkdtempSync(join(tmpdir(), 'tree-lock-wt-'));
    wt = join(wtParent, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
    markerDir = mkdtempSync(join(tmpdir(), 'tree-lock-marker-'));
    marker = join(markerDir, 'spawns.txt');
  });
  afterEach(() => {
    for (const d of [repo, wtParent, markerDir]) rmSync(d, { recursive: true, force: true });
  });

  const spawns = (): number => (existsSync(marker) ? readFileSync(marker, 'utf-8').length : 0);

  it('two worktrees verifying the same content at once spawn ONE run; the second waits and reuses it', {
    timeout: 30_000,
  }, async () => {
    // Longer than the ~0.7 s lock-acquire retry window, so the second caller
    // genuinely finds the lock held and has to wait.
    const cmd = shCommand(`printf x >> "${marker}"; sleep 2; echo ok`);
    const opts = { skipGlobalSemaphore: true, lockPollMs: 50 };
    const [a, b] = await Promise.all([
      runToolCached(cmd, repo, { ...opts, executionRoot: repo }),
      runToolCached(cmd, repo, { ...opts, executionRoot: wt }),
    ]);
    expect(spawns()).toBe(1);
    expect([a.cacheHit, b.cacheHit].sort()).toEqual([false, true]);
    expect(a.lockBusy || b.lockBusy).toBe(false);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.entry.key).toBe(b.entry.key);
  });

  it('a waiter whose holder releases WITHOUT a result runs the tool itself', {
    timeout: 30_000,
  }, async () => {
    const cmd = shCommand(`printf x >> "${marker}"; echo ok`);
    const key = computeCacheKey(cmd, await captureTreeHash(repo), 'none');
    const path = cacheEntryPath(repo, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ schemaVersion: 3, key, pending: true }));
    // Stands in for a holder that timed out or crashed: it holds the lock,
    // then lets go having written nothing.
    const release = await acquireLock(path, { retries: 0, stale: 10_000 });
    const releaseLater = new Promise<void>((r) =>
      setTimeout(() => {
        void release().then(r);
      }, 1_500),
    );

    const r = await runToolCached(cmd, repo, {
      skipGlobalSemaphore: true,
      lockStaleMs: 10_000,
      lockPollMs: 50,
    });
    await releaseLater;
    expect(r.lockBusy).toBe(false);
    expect(r.cacheHit).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(spawns()).toBe(1);
  });
});

describe('T12958 — the environment fingerprint gates sharing for build-output tools', () => {
  let repo: string;
  let wtParent: string;
  let wt: string;
  let markerDir: string;
  let marker: string;
  const testCmd = (): ResolvedToolCommand => ({
    canonical: 'test',
    displayName: 'test',
    cmd: 'sh',
    args: ['-c', `printf x >> "${marker}"; echo ok`],
    source: 'language-default',
  });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'tree-env-repo-'));
    initRepo(repo);
    writeFileSync(join(repo, 'package.json'), '{"name":"root"}\n');
    mkdirSync(join(repo, 'pkg'));
    writeFileSync(join(repo, 'pkg', 'package.json'), '{"name":"pkg"}\n');
    writeFileSync(join(repo, '.gitignore'), 'dist/\nnode_modules/\n.env\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'pkgs');
    wtParent = mkdtempSync(join(tmpdir(), 'tree-env-wt-'));
    wt = join(wtParent, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
    markerDir = mkdtempSync(join(tmpdir(), 'tree-env-marker-'));
    marker = join(markerDir, 'spawns.txt');
    for (const root of [repo, wt]) {
      mkdirSync(join(root, 'pkg', 'dist'), { recursive: true });
      writeFileSync(join(root, 'pkg', 'dist', 'index.js'), 'export const v = 1;\n');
      mkdirSync(join(root, 'node_modules', '.pnpm'), { recursive: true });
      writeFileSync(join(root, 'node_modules', '.pnpm', 'lock.yaml'), 'lockfileVersion: 9\n');
    }
  });
  afterEach(() => {
    for (const d of [repo, wtParent, markerDir]) rmSync(d, { recursive: true, force: true });
  });

  const spawns = (): number => (existsSync(marker) ? readFileSync(marker, 'utf-8').length : 0);

  it('equally built and installed worktrees share a `test` result', async () => {
    expect(captureEnvFingerprint(repo, 'test')).toBe(captureEnvFingerprint(wt, 'test'));
    await runToolCached(testCmd(), repo, { executionRoot: repo });
    const r = await runToolCached(testCmd(), repo, { executionRoot: wt });
    expect(r.cacheHit).toBe(true);
    expect(spawns()).toBe(1);
  });

  it('a stale gitignored dist/ in worktree B misses', async () => {
    await runToolCached(testCmd(), repo, { executionRoot: repo });
    writeFileSync(join(wt, 'pkg', 'dist', 'index.js'), 'export const v = 1; // stale build\n');
    const r = await runToolCached(testCmd(), repo, { executionRoot: wt });
    expect(r.cacheHit).toBe(false);
    expect(spawns()).toBe(2);
  });

  it('a different or missing install in worktree B misses', async () => {
    await runToolCached(testCmd(), repo, { executionRoot: repo });
    rmSync(join(wt, 'node_modules'), { recursive: true, force: true });
    const r = await runToolCached(testCmd(), repo, { executionRoot: wt });
    expect(r.cacheHit).toBe(false);
  });

  it('a different gitignored .env in worktree B misses', async () => {
    await runToolCached(testCmd(), repo, { executionRoot: repo });
    writeFileSync(join(wt, '.env'), 'API=other\n');
    const r = await runToolCached(testCmd(), repo, { executionRoot: wt });
    expect(r.cacheHit).toBe(false);
  });

  it('source-only tools ignore the environment', () => {
    expect(captureEnvFingerprint(repo, 'lint')).toBe('none');
  });
});

describe('the identity list is the single source of truth', () => {
  interface Identity {
    canonical: ResolvedToolCommand['canonical'];
    cmd: string;
    args: string[];
    treeHash: string;
    envFingerprint: string;
  }
  const base: Identity = {
    canonical: 'lint',
    cmd: 'sh',
    args: ['-c', 'true'],
    treeHash: 'a'.repeat(40),
    envFingerprint: 'none',
  };

  it('every identity field is actually in the key', () => {
    // Iterating the exported array rather than naming fields means a field
    // added to the identity but not to the hashed payload fails here — the
    // mistake gh#1419 made with `executionRoot`.
    const keyOf = (o: Identity): string =>
      computeCacheKey(
        {
          canonical: o.canonical,
          displayName: o.canonical,
          cmd: o.cmd,
          args: [...o.args],
          source: 'language-default',
        },
        o.treeHash,
        o.envFingerprint,
      );
    const reference = keyOf(base);

    const perturb: Record<(typeof TOOL_RUN_IDENTITY_FIELDS)[number], Identity> = {
      canonical: { ...base, canonical: 'typecheck' },
      cmd: { ...base, cmd: 'bash' },
      args: { ...base, args: ['-c', 'false'] },
      treeHash: { ...base, treeHash: 'b'.repeat(40) },
      envFingerprint: { ...base, envFingerprint: 'e'.repeat(32) },
    };

    // Guards the map itself: a new identity field with no perturbation here
    // would otherwise be silently unchecked.
    expect(Object.keys(perturb).sort()).toEqual([...TOOL_RUN_IDENTITY_FIELDS].sort());

    for (const field of TOOL_RUN_IDENTITY_FIELDS) {
      expect(keyOf(perturb[field]), `${field} must change the cache key`).not.toBe(reference);
    }
  });

  const complete = {
    ...base,
    displayName: 'lint',
    source: 'language-default',
    schemaVersion: 3 as const,
    key: 'k',
    head: 'c'.repeat(40) as string | null,
    executionRoot: '/tmp/tree-a',
    exitCode: 0 as number | null,
    stdoutTail: '',
    stderrTail: '',
    durationMs: 1,
    capturedAt: '2026-10-01T00:00:00.000Z',
    args: [...base.args],
  };

  it('isEntryUsable rejects an entry missing ANY identity field', () => {
    expect(isEntryUsable(complete)).toBe(true);
    for (const field of TOOL_RUN_IDENTITY_FIELDS) {
      const missing = { ...complete } as Record<string, unknown>;
      delete missing[field];
      expect(isEntryUsable(missing), `missing ${field} must be unusable`).toBe(false);

      const nulled = { ...complete, [field]: null } as Record<string, unknown>;
      expect(isEntryUsable(nulled), `null ${field} must be unusable`).toBe(false);
    }
  });

  it('isEntryUsable rejects an unknown outcome even with a complete identity', () => {
    // gh#1380 preserved: `exitCode` is a RESULT, deliberately not identity.
    expect(isEntryUsable({ ...complete, exitCode: null })).toBe(false);
  });

  it('head and executionRoot are NOT identity: a null head is still usable', () => {
    expect(isEntryUsable({ ...complete, head: null })).toBe(true);
  });
});
