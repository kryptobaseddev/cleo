/**
 * T12312 — a slow git must not kill the whole index rebuild.
 *
 * `cleo nexus analyze` allowed each `git check-ignore` batch a flat 2 s and
 * threw `result.error` verbatim on an overrun. Reproduced 2026-09-23 on a
 * fuseblk mount:
 *
 *   {"code":1,"message":"spawnSync git ETIMEDOUT","codeName":"E_PIPELINE_FAILED"}
 *
 * Measured warm-cache on an idle machine, the budget was already 85 % consumed
 * by a single batch (797/974/1701 ms over 256 paths), and a 9 141-file
 * repository rolls that budget 36 times per analyze. The failure was therefore
 * intermittent by construction — which is why it reproduced for one agent and
 * not the next — and its message named no invocation, no budget and no remedy.
 *
 * These tests drive a real `git` on PATH rather than a mocked module, because
 * the defect is entirely about how a spawned process behaves under time
 * pressure; a stubbed spawnSync would encode the assumption under test.
 *
 * @task T12312
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GIT_IGNORE_TIMEOUT_ENV, walkRepositoryPaths } from '../pipeline/filesystem-walker.js';

let root = '';
let binDir = '';
let repo = '';
const originalPath = process.env['PATH'];

/**
 * Install a `git` shim that answers the two subcommands the walker uses.
 *
 * @param delayMs - Seconds-resolution sleep before `check-ignore` answers.
 * @param slowCalls - How many leading `check-ignore` calls are slow; later
 *   calls answer immediately, which is what a transient load spike looks like.
 */
function installGitShim(delayMs: number, slowCalls: number): void {
  const counter = join(root, 'calls');
  writeFileSync(counter, '0');
  const script = `#!/usr/bin/env bash
case "$1" in
  rev-parse) echo true; exit 0 ;;
  check-ignore)
    n=$(cat ${counter}); n=$((n+1)); echo $n > ${counter}
    if [ "$n" -le ${slowCalls} ]; then sleep ${(delayMs / 1000).toFixed(3)}; fi
    cat > /dev/null
    exit 1 ;;
  *) exit 0 ;;
esac
`;
  writeFileSync(join(binDir, 'git'), script);
  chmodSync(join(binDir, 'git'), 0o755);
  process.env['PATH'] = `${binDir}:${originalPath ?? ''}`;
}

beforeEach(() => {
  root = join(
    tmpdir(),
    `cleo-t12312-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  binDir = join(root, 'bin');
  repo = join(root, 'repo');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'b.ts'), 'export const b = 2;\n');
});

afterEach(() => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
  delete process.env[GIT_IGNORE_TIMEOUT_ENV];
  rmSync(root, { recursive: true, force: true });
});

describe('T12312 AC2 — a transient overrun is retried, not fatal', () => {
  it('completes the scan when the first attempt overruns and the retry does not', async () => {
    // Budget 800ms, retry 4x = 3200ms. The first call sleeps 2500ms: over the
    // first budget AND over the old flat 2000ms constant, but inside the
    // retry's. Exactly the shape of a load spike — and chosen above 2000ms so
    // this case cannot pass on the pre-fix code by accident.
    process.env[GIT_IGNORE_TIMEOUT_ENV] = '800';
    installGitShim(2500, 1);

    const files = await walkRepositoryPaths(repo);
    expect(files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts']);
  }, 20_000);
});

describe('T12312 AC3 — an exhausted budget explains itself', () => {
  it('names the invocation, both budgets, the batch and the override', async () => {
    // 200ms then 800ms on retry; the shim sleeps 1.5s, so neither completes.
    process.env[GIT_IGNORE_TIMEOUT_ENV] = '200';
    installGitShim(1500, 99);

    const failure = await walkRepositoryPaths(repo).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = failure?.message ?? '';

    // The old behaviour was the bare Node string and nothing else.
    expect(message).not.toBe('spawnSync git ETIMEDOUT');
    expect(message).toContain('git check-ignore');
    expect(message).toContain('200ms');
    expect(message).toContain('800ms');
    expect(message).toContain('batch 1 of');
    expect(message).toContain(GIT_IGNORE_TIMEOUT_ENV);
    // Abandoning is deliberate: a batch git could not classify must not be
    // indexed as though nothing in it were ignored.
    expect(message).toMatch(/abandoned/i);
  }, 20_000);
});

describe('T12312 AC1 — the budget is operator-overridable', () => {
  it('honours the override instead of a compiled-in constant', async () => {
    // A budget far below any real git call proves the override is consulted:
    // with the old flat 2000ms constant this scan would have succeeded.
    process.env[GIT_IGNORE_TIMEOUT_ENV] = '1';
    installGitShim(1200, 99);

    const failure = await walkRepositoryPaths(repo).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain('allowed 1ms');
  }, 20_000);
});
