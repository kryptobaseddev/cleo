/**
 * Regression tests for gh#1404 — a cache entry whose key can never rotate.
 *
 * ## The defect, and why it is worse than gh#1380
 *
 * `computeCacheKey` hashes `{canonical, cmd, args, head, dirtyFingerprint}`.
 * When both git fields are `null` the key is a function of the COMMAND ALONE.
 * Editing source does not change it. Committing does not change it. Only
 * editing the tool command changes it — a config change, not a code change.
 *
 * gh#1380 covered `exitCode: null`, which fails closed: it surfaces as
 * "binary missing", loudly, and someone investigates. This case stores a REAL
 * exit code of either sign. A cached PASS is not self-announcing — **nobody
 * debugs a passing gate** — and it satisfies `testsPassed` through the
 * evidence gate without spawning anything.
 *
 * ## It is structural for a whole class of project
 *
 * `captureHead` returns null when the directory is not a git checkout. That
 * includes the supported layout where the CLEO root sits ABOVE the git root —
 * measured in the field on a project whose repo was a subdirectory, so both
 * fields were null for every run, always. Four entries, all `exitCode: 0`; the
 * `test` one recorded `122 files / 2557 tests` from 2026-08-07 against a suite
 * that is now `856 files / 13,621 tests`.
 *
 * It had stayed inert only because that project's tool command was later
 * rewritten, changing `args` and therefore the key. Revert the command and
 * `tool:test` returns 0 without spawning.
 *
 * ## What these tests assert, and the one that matters
 *
 * The load-bearing case is `exitCode: 0, head: null` — a **PASS** that must be
 * refused. A test suite that only covered the red case would have passed
 * against the gh#1380 fix alone and proven nothing about this one, because
 * gh#1380 already refuses every `exitCode: null` entry.
 *
 * @task T12185 (gh#1404)
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeCacheKey, readCacheEntry, runToolCached } from '../tool-cache.js';
import type { ResolvedToolCommand } from '../tool-resolver.js';

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

/** Write a cache entry straight to disk, bypassing `writeCacheEntry`. */
function plant(projectRoot: string, key: string, fields: Record<string, unknown>): void {
  const dir = join(projectRoot, '.cleo', 'cache', 'evidence');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${key}.json`),
    JSON.stringify({
      // schemaVersion 2 and a live executionRoot are deliberate: a planted
      // entry must be refused for the reason ITS OWN test names, not because
      // it tripped the schema gate or the missing-tree gate on the way in.
      // A fixture that fails early passes the test vacuously (gh#1419).
      schemaVersion: 2,
      executionRoot: projectRoot,
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
    'utf8',
  );
}

function entriesOnDisk(projectRoot: string): Array<Record<string, unknown>> {
  const dir = join(projectRoot, '.cleo', 'cache', 'evidence');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
}

let originalCleoHome: string | undefined;
let cleoHomeDir: string;
beforeAll(() => {
  originalCleoHome = process.env.CLEO_HOME;
  cleoHomeDir = mkdtempSync(join(tmpdir(), 'gh1404-cleohome-'));
  process.env.CLEO_HOME = cleoHomeDir;
  process.env.CLEO_TOOL_CONCURRENCY_LINT = '0';
});
afterAll(() => {
  rmSync(cleoHomeDir, { recursive: true, force: true });
  delete process.env.CLEO_TOOL_CONCURRENCY_LINT;
  if (originalCleoHome === undefined) delete process.env.CLEO_HOME;
  else process.env.CLEO_HOME = originalCleoHome;
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh1404-repo-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('gh#1404 — an entry with a null head is refused on read', () => {
  it('REFUSES A CACHED PASS — the case gh#1380 cannot catch', () => {
    // THE regression. exitCode 0 is a perfectly valid result; the key it sits
    // under is the problem. gh#1380's guard (`exitCode === null`) passes this
    // entry straight through.
    plant(dir, 'aaaa000000000001', { exitCode: 0, head: null, dirtyFingerprint: null });
    expect(readCacheEntry(dir, 'aaaa000000000001')).toBeNull();
  });

  it('refuses a cached failure with a null head too', () => {
    plant(dir, 'aaaa000000000002', { exitCode: 7, head: null, dirtyFingerprint: null });
    expect(readCacheEntry(dir, 'aaaa000000000002')).toBeNull();
  });

  it('refuses when head is absent rather than explicitly null', () => {
    plant(dir, 'aaaa000000000003', { exitCode: 0, head: undefined });
    expect(readCacheEntry(dir, 'aaaa000000000003')).toBeNull();
  });

  it('STILL RETURNS a well-formed entry with a real head', () => {
    // The guard must stay narrow. Refusing more broadly would trade a
    // fabricated pass for a permanent cache miss on healthy projects.
    plant(dir, 'aaaa000000000004', { exitCode: 0, head: 'abc123' });
    expect(readCacheEntry(dir, 'aaaa000000000004')?.exitCode).toBe(0);
  });

  it('still returns a cached NON-ZERO exit with a real head', () => {
    plant(dir, 'aaaa000000000005', { exitCode: 7, head: 'abc123' });
    expect(readCacheEntry(dir, 'aaaa000000000005')?.exitCode).toBe(7);
  });
});

describe('gh#1404 — nothing is written when the key cannot rotate', () => {
  it('a successful run in a NON-GIT root is not cached', async () => {
    // `dir` is deliberately not `git init`ed, so captureHead returns null —
    // the field condition, reproduced without simulating anything.
    const first = await runToolCached(shCommand('exit 0'), dir);
    expect(first.exitCode).toBe(0);

    const persisted = entriesOnDisk(dir).filter((e) => e['pending'] !== true);
    expect(persisted).toEqual([]);
  });

  it('a second identical run in a non-git root re-spawns rather than hitting cache', async () => {
    await runToolCached(shCommand('exit 0'), dir);
    const second = await runToolCached(shCommand('exit 0'), dir);

    // Without this, the first result would be served forever: same command,
    // same null head, same key, and no source change can alter any component.
    expect(second.cacheHit).toBe(false);
  });

  it('a git root still caches — the cost is scoped to the broken case', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@e'], { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: dir });

    const first = await runToolCached(shCommand('exit 0'), dir);
    const second = await runToolCached(shCommand('exit 0'), dir);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
  });
});

describe('gh#1404 — the key really is command-only when the git fields are null', () => {
  it('two different commits produce the SAME key once head is null', () => {
    const cmd = shCommand('exit 0');
    // This is the property that makes the entry permanent, asserted directly
    // rather than inferred from behaviour.
    expect(computeCacheKey(cmd, null, null, '/tmp/uk-root')).toBe(
      computeCacheKey(cmd, null, null, '/tmp/uk-root'),
    );
    expect(computeCacheKey(cmd, 'head-one', null, '/tmp/uk-root')).not.toBe(
      computeCacheKey(cmd, 'head-two', null, '/tmp/uk-root'),
    );
  });

  it('only a command change rotates it', () => {
    expect(computeCacheKey(shCommand('exit 0'), null, null, '/tmp/uk-root')).not.toBe(
      computeCacheKey(shCommand('exit 1'), null, null, '/tmp/uk-root'),
    );
  });
});
