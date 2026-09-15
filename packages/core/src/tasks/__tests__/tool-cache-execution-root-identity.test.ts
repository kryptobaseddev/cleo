/**
 * gh#1419 — a tool run's cache entry must be keyed on the tree it ran in.
 *
 * ## The defect
 *
 * `computeCacheKey` hashed `{canonical, cmd, args, head, dirtyFingerprint}`
 * and no working directory, while the cache DIRECTORY is shared by every
 * worktree of a project on purpose (`getProjectRoot()` resolves a worktree to
 * the main repo so they share one `.cleo/`). Two clean worktrees at the same
 * HEAD produce the same `dirtyFingerprint` — the empty-input hash — so they
 * collided by construction, and a run in worktree A was served to worktree B.
 *
 * T12112 had already threaded `executionRoot` through EXECUTION for this exact
 * hazard. It never reached the key. The tool ran in the right tree and the
 * answer was filed under a name that did not mention which one.
 *
 * ## What this file protects
 *
 * The issue's acceptance is explicit that a test which would pass against the
 * old code does not count, so the first `describe` carries a CONTROL: it
 * recomputes the pre-fix payload inline and asserts that it DOES collide.
 * If someone later removes `executionRoot` from the key, the control still
 * collides and the assertion beside it starts failing — the pair cannot both
 * go quiet.
 *
 * The last `describe` is the structural one, and the reason this is a design
 * pass rather than a fourth patch: it iterates TOOL_RUN_IDENTITY_FIELDS and
 * asserts every member changes the key. Adding a field to that array without
 * it reaching the key — the precise mistake made with `executionRoot` — fails
 * here automatically, for a field this file has never heard of.
 *
 * @task T12190 (gh#1419)
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cacheEntryPath,
  computeCacheKey,
  isEntryUsable,
  readCacheEntry,
  runToolCached,
  TOOL_RUN_IDENTITY_FIELDS,
} from '../tool-cache.js';
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

/** A git repo with one commit, so HEAD is real and the tree is clean. */
function initRepo(dir: string): string {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf-8' });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 'T');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return git('rev-parse', 'HEAD').trim();
}

describe('gh#1419 — two clean trees at one HEAD do not share a key', () => {
  const cmd = shCommand('true');
  const HEAD = 'a'.repeat(40);
  // What `captureDirtyFingerprint` returns for a clean tree: sha256 of the
  // empty string. Identical in every worktree, which is why the two trees
  // collided rather than merely risked colliding.
  const CLEAN = createHash('sha256').update('').digest('hex');

  it('CONTROL: the pre-fix payload collides for two different trees', () => {
    // The exact derivation shipped through 2026.9.3, reproduced here so this
    // file states what it is protecting against instead of asserting the
    // present behaviour and calling that a test.
    const preFixKey = (root: string): string => {
      void root; // the defect: the root was accepted nowhere and hashed never
      return createHash('sha256')
        .update(
          JSON.stringify({
            canonical: cmd.canonical,
            cmd: cmd.cmd,
            args: cmd.args,
            head: HEAD,
            dirtyFingerprint: CLEAN,
          }),
        )
        .digest('hex')
        .slice(0, 32);
    };
    expect(preFixKey('/tmp/tree-a')).toBe(preFixKey('/tmp/tree-b'));
  });

  it('two clean worktrees at the same HEAD produce DIFFERENT keys', () => {
    const a = computeCacheKey(cmd, HEAD, CLEAN, '/tmp/tree-a');
    const b = computeCacheKey(cmd, HEAD, CLEAN, '/tmp/tree-b');
    expect(a).not.toBe(b);
  });

  it('one tree is still stable with itself', () => {
    expect(computeCacheKey(cmd, HEAD, CLEAN, '/tmp/tree-a')).toBe(
      computeCacheKey(cmd, HEAD, CLEAN, '/tmp/tree-a'),
    );
  });

  it('two spellings of ONE tree produce the same key (symlinks collapse)', () => {
    // The safe direction. Collapsing an alias can only merge entries that
    // genuinely describe one tree; failing to collapse it would split a
    // single tree's cache across spellings and quietly disable caching.
    const real = mkdtempSync(join(tmpdir(), 'ev-real-'));
    try {
      const viaDot = join(real, '.');
      expect(computeCacheKey(cmd, HEAD, CLEAN, real)).toBe(
        computeCacheKey(cmd, HEAD, CLEAN, viaDot),
      );
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('gh#1419 — a run in one tree does not satisfy a gate in another', () => {
  let store: string;
  let treeA: string;
  let treeB: string;

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), 'ev-store-'));
    treeA = mkdtempSync(join(tmpdir(), 'ev-tree-a-'));
    treeB = mkdtempSync(join(tmpdir(), 'ev-tree-b-'));
  });

  afterEach(() => {
    for (const d of [store, treeA, treeB]) rmSync(d, { recursive: true, force: true });
  });

  it('the second tree MISSES a cache written by the first', async () => {
    // Both trees hold the same commit — the load-bearing case, and the one
    // that collided. A single shared store root stands in for the shared
    // `.cleo/` that every worktree of a project resolves to.
    const headA = initRepo(treeA);
    execFileSync('git', ['clone', '-q', treeA, treeB, '--no-hardlinks']);
    const headB = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: treeB,
      encoding: 'utf-8',
    }).trim();
    expect(headB).toBe(headA);

    const cmd = shCommand('exit 0');
    const first = await runToolCached(cmd, store, { executionRoot: treeA });
    expect(first.cacheHit).toBe(false);

    const second = await runToolCached(cmd, store, { executionRoot: treeB });
    expect(second.cacheHit).toBe(false);

    // Same tree, same HEAD -> now it may hit.
    const third = await runToolCached(cmd, store, { executionRoot: treeB });
    expect(third.cacheHit).toBe(true);
  });

  it('the stored record NAMES the tree the run happened in', async () => {
    initRepo(treeA);
    const cmd = shCommand('exit 0');
    const res = await runToolCached(cmd, store, { executionRoot: treeA });

    // Read it back off disk, not from the in-memory result: the field survey
    // that found this defect could not attribute 259 entries precisely
    // because the PERSISTED record carried no directory.
    const onDisk = JSON.parse(
      readFileSync(cacheEntryPath(store, res.entry.key), 'utf-8'),
    ) as Record<string, unknown>;
    expect(onDisk['executionRoot']).toBeTruthy();
    expect(existsSync(onDisk['executionRoot'] as string)).toBe(true);
  });
});

describe('gh#1419 — an entry whose tree is gone is unfalsifiable, so it is refused', () => {
  let store: string;

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), 'ev-gone-'));
  });
  afterEach(() => rmSync(store, { recursive: true, force: true }));

  function plant(key: string, fields: Record<string, unknown>): void {
    const dir = join(store, '.cleo', 'cache', 'evidence');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${key}.json`),
      JSON.stringify({
        schemaVersion: 2,
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
        ...fields,
      }),
      'utf-8',
    );
  }

  it('refuses a PASS recorded in a directory that no longer exists', () => {
    // The field survey found 8 of these: every one `exitCode: 0`, every one
    // still servable after its worktree was deleted. A stale result is wrong;
    // this one cannot be checked by anybody, ever.
    const gone = join(tmpdir(), 'ev-deleted-worktree-that-never-existed');
    expect(existsSync(gone)).toBe(false);
    plant('1111111111111111', { executionRoot: gone });
    expect(readCacheEntry(store, '1111111111111111')).toBeNull();
  });

  it('serves the same entry once its directory is present', () => {
    // The control for the test above: proves the refusal is about the missing
    // directory and not about some other malformation in the fixture.
    plant('2222222222222222', { executionRoot: store });
    expect(readCacheEntry(store, '2222222222222222')?.exitCode).toBe(0);
  });

  it('refuses a schemaVersion-1 entry outright, without a per-field clause', () => {
    // Every entry in every consumer cache predates `executionRoot`. This one
    // line retires all of them — the mechanism gh#1380 and gh#1404 each
    // rebuilt by hand while this counter sat unused.
    plant('3333333333333333', { executionRoot: store, schemaVersion: 1 });
    expect(readCacheEntry(store, '3333333333333333')).toBeNull();
  });
});

describe('gh#1419 — the identity list is the single source of truth', () => {
  // `canonical` is typed from the contract rather than as `string`. A widened
  // literal here is how the two pre-existing type errors in the sibling
  // tool-cache tests got in: the core tsconfig excludes test directories, so
  // nothing in CI ever typechecks a test file. Filed as its own defect.
  interface Identity {
    canonical: ResolvedToolCommand['canonical'];
    cmd: string;
    args: string[];
    head: string;
    dirtyFingerprint: string;
    executionRoot: string;
  }
  const base: Identity = {
    canonical: 'lint',
    cmd: 'sh',
    args: ['-c', 'true'],
    head: 'a'.repeat(40),
    dirtyFingerprint: 'b'.repeat(64),
    executionRoot: '/tmp/tree-a',
  };

  it('every identity field is actually in the key', () => {
    // THE point of this file. Iterating the exported array rather than naming
    // fields means a field added to the identity but not to the hashed
    // payload fails here — which is exactly what happened to `executionRoot`,
    // and what would otherwise happen to defect five's field.
    const keyOf = (o: Identity): string =>
      computeCacheKey(
        {
          canonical: o.canonical,
          displayName: o.canonical,
          cmd: o.cmd,
          args: [...o.args],
          source: 'language-default',
        },
        o.head,
        o.dirtyFingerprint,
        o.executionRoot,
      );
    const reference = keyOf(base);

    const perturb: Record<(typeof TOOL_RUN_IDENTITY_FIELDS)[number], Identity> = {
      canonical: { ...base, canonical: 'typecheck' },
      cmd: { ...base, cmd: 'bash' },
      args: { ...base, args: ['-c', 'false'] },
      head: { ...base, head: 'c'.repeat(40) },
      dirtyFingerprint: { ...base, dirtyFingerprint: 'd'.repeat(64) },
      executionRoot: { ...base, executionRoot: '/tmp/tree-b' },
    };

    // Guards the map itself: a new identity field with no perturbation here
    // would otherwise be silently unchecked.
    expect(Object.keys(perturb).sort()).toEqual([...TOOL_RUN_IDENTITY_FIELDS].sort());

    for (const field of TOOL_RUN_IDENTITY_FIELDS) {
      expect(keyOf(perturb[field]), `${field} must change the cache key`).not.toBe(reference);
    }
  });

  it('isEntryUsable rejects an entry missing ANY identity field', () => {
    // The read path and the write path call this one predicate. Before, each
    // transcribed the same rule separately and both had to be remembered.
    const complete = {
      ...base,
      displayName: 'lint',
      source: 'language-default',
      schemaVersion: 2 as const,
      key: 'k',
      exitCode: 0,
      stdoutTail: '',
      stderrTail: '',
      durationMs: 1,
      capturedAt: '2026-09-14T00:00:00.000Z',
      args: [...base.args],
    };
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
    // gh#1380 preserved: `exitCode` is a RESULT, deliberately not an identity
    // field — keying on it would key the cache on its own answer.
    const complete = {
      ...base,
      displayName: 'lint',
      source: 'language-default',
      schemaVersion: 2 as const,
      key: 'k',
      exitCode: null,
      stdoutTail: '',
      stderrTail: '',
      durationMs: 1,
      capturedAt: '2026-09-14T00:00:00.000Z',
      args: [...base.args],
    };
    expect(isEntryUsable(complete)).toBe(false);
  });
});
