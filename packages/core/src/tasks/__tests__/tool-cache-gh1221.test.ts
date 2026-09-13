/**
 * Regression tests for the evidence-cache cluster:
 * gh#1221 (cache never hits), gh#1220 / gh#1226 (tool runs in the wrong tree)
 * and gh#1230 (evidence captured from a tree other than the attested one).
 *
 * ## What gh#1221 actually was
 *
 * The reporter attributed the permanent miss to dirty-tree fingerprint churn
 * from peer agents editing a shared checkout. That was measured and refuted:
 * the fingerprint of the shared checkout was byte-identical across 60s with
 * 12 live sessions. Two deterministic causes explain the report on their own,
 * on an idle single-agent box:
 *
 *   1. DEADLINE UNDERSHOOT (dominant). `DEFAULT_SPAWN_TIMEOUT_MS` is 300s; a
 *      monorepo suite takes ~10 min. Every run is killed at 5 min and the
 *      timeout path deliberately writes no cache entry (T12025). So the cache
 *      cannot hit — not because the key moved, but because no entry is ever
 *      produced. Each attempt still burns the full deadline running the suite
 *      at full parallelism before discarding it. N agents x N tasks of
 *      guaranteed-discarded suites is the host-level load multiplier.
 *
 *   2. SELF-INVALIDATION. The fingerprint hashed `git status --porcelain`,
 *      which lists untracked files, so a tool emitting ANY untracked artifact
 *      changed the key that the next call computes. In this repo `coverage/`,
 *      `.vitest/` and `*.log` are not gitignored — one suite run suffices.
 *      A single one-line marker file suffices.
 *
 * @task T12112 (gh#1221, gh#1220, gh#1226, gh#1230)
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runToolCached } from '../tool-cache.js';
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

/**
 * Count of real spawns, observed via an append-only marker file.
 *
 * The marker MUST live outside the git repo under test: an untracked file
 * inside it would itself perturb the dirty-tree fingerprint and silently
 * contaminate every assertion here. That is cause 2 — and writing this helper
 * the naive way is how it was found.
 */
function spawnCount(markerDir: string): number {
  try {
    return readFileSync(join(markerDir, 'spawns.log'), 'utf-8').trim().split('\n').filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

let originalCleoHome: string | undefined;
let cleoHomeDir: string;
beforeAll(() => {
  originalCleoHome = process.env.CLEO_HOME;
  cleoHomeDir = mkdtempSync(join(tmpdir(), 'gh1221-cleohome-'));
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
let markerDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh1221-repo-'));
  markerDir = mkdtempSync(join(tmpdir(), 'gh1221-marker-'));
  initRepo(dir);
});
afterEach(() => {
  delete process.env.CLEO_EVIDENCE_FRESH;
  rmSync(dir, { recursive: true, force: true });
  rmSync(markerDir, { recursive: true, force: true });
});

describe('gh#1221 cause 1 — a tool slower than its deadline can never populate the cache', () => {
  // Characterisation, not a defect to fix here: NOT caching an unfinished run
  // is correct (T12025). What is wrong is shipping a default deadline below a
  // real suite duration, so this path fires forever. The deadline raise is
  // held behind the kernel memory bound; the error text is fixed in this PR to
  // stop telling the operator to retry unchanged.
  it('re-spawns the full tool on EVERY call when the run exceeds spawnTimeoutMs', async () => {
    const cmd = shCommand(`echo run >> "${markerDir}/spawns.log"; sleep 5`);

    const r1 = await runToolCached(cmd, dir, { spawnTimeoutMs: 400 });
    const r2 = await runToolCached(cmd, dir, { spawnTimeoutMs: 400 });
    const r3 = await runToolCached(cmd, dir, { spawnTimeoutMs: 400 });

    expect([r1.timedOut, r2.timedOut, r3.timedOut]).toEqual([true, true, true]);
    expect([r1.cacheHit, r2.cacheHit, r3.cacheHit]).toEqual([false, false, false]);
    // Three full-cost runs, nothing retained. This is the load multiplier.
    expect(spawnCount(markerDir)).toBe(3);
  }, 30_000);
});

describe('gh#1221 cause 2 — a tool must not invalidate its own cache by running', () => {
  it('hits on call #2 even though the tool emitted an untracked artifact', async () => {
    // Mirrors a suite emitting coverage/ — not gitignored in this repo.
    const cmd = shCommand(
      `echo run >> "${markerDir}/spawns.log"; mkdir -p "${dir}/coverage"; echo x > "${dir}/coverage/lcov.info"; exit 0`,
    );

    const r1 = await runToolCached(cmd, dir, { spawnTimeoutMs: 30_000 });
    const r2 = await runToolCached(cmd, dir, { spawnTimeoutMs: 30_000 });

    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
    expect(spawnCount(markerDir)).toBe(1);
  }, 30_000);

  it('still invalidates when a TRACKED file is modified', async () => {
    // Guards against over-correcting: the fix must not make the cache blind
    // to real edits of committed code.
    const cmd = shCommand(`echo run >> "${markerDir}/spawns.log"; exit 0`);

    await runToolCached(cmd, dir, { spawnTimeoutMs: 30_000 });
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    const r2 = await runToolCached(cmd, dir, { spawnTimeoutMs: 30_000 });

    expect(r2.cacheHit).toBe(false);
    expect(spawnCount(markerDir)).toBe(2);
  }, 30_000);

  it('TRADEOFF: a new UNTRACKED source file does NOT invalidate — CLEO_EVIDENCE_FRESH is the escape hatch', async () => {
    // Deliberate and documented. Excluding untracked files is what stops a
    // tool invalidating itself; the cost is that an uncommitted NEW file is
    // not seen either. Named loudly so the next reader meets the tradeoff
    // rather than discovering it as a stale pass.
    const cmd = shCommand(`echo run >> "${markerDir}/spawns.log"; exit 0`);

    await runToolCached(cmd, dir, { spawnTimeoutMs: 30_000 });
    writeFileSync(join(dir, 'new-feature.test.ts'), 'it("x", () => {});\n');

    const stale = await runToolCached(cmd, dir, { spawnTimeoutMs: 30_000 });
    expect(stale.cacheHit).toBe(true); // the tradeoff, pinned
    expect(spawnCount(markerDir)).toBe(1);

    process.env.CLEO_EVIDENCE_FRESH = '1';
    const fresh = await runToolCached(cmd, dir, { spawnTimeoutMs: 30_000 });
    expect(fresh.cacheHit).toBe(false);
    expect(spawnCount(markerDir)).toBe(2);
  }, 30_000);
});

describe('gh#1220 / gh#1226 / gh#1230 — evidence must describe the tree it was invoked from', () => {
  let worktree: string;
  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'gh1220-wt-'));
    rmSync(worktree, { recursive: true, force: true });
    git(dir, ['worktree', 'add', '-q', '-b', 'feature', worktree]);
  });
  afterEach(() => {
    try {
      git(dir, ['worktree', 'remove', '--force', worktree]);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('spawns the tool in executionRoot, not in the store root', async () => {
    const cmd = shCommand(`pwd > "${markerDir}/cwd.txt"; exit 0`);

    await runToolCached(cmd, dir, { executionRoot: worktree, spawnTimeoutMs: 30_000 });

    const ranIn = readFileSync(join(markerDir, 'cwd.txt'), 'utf-8').trim();
    expect(realpathSync(ranIn)).toBe(realpathSync(worktree));
    expect(realpathSync(ranIn)).not.toBe(realpathSync(dir));
  }, 30_000);

  it('reports executionRoot on the result so the operator can see which tree was measured', async () => {
    const cmd = shCommand('exit 0');
    const r = await runToolCached(cmd, dir, { executionRoot: worktree, spawnTimeoutMs: 30_000 });
    expect(r.executionRoot).toBe(worktree);
  }, 30_000);

  it('gh#1230: a dirty store root does not decide the result for a clean worktree', async () => {
    // The false-PASS direction is the dangerous one: before the fix, the tool
    // measured whatever the shared checkout happened to contain.
    writeFileSync(join(dir, 'a.txt'), 'peer edit in the shared checkout\n');

    const cmd = shCommand(`grep -q "peer edit" a.txt && exit 1; exit 0`);
    const r = await runToolCached(cmd, dir, { executionRoot: worktree, spawnTimeoutMs: 30_000 });

    // Runs against the worktree, where the peer's edit does not exist.
    expect(r.exitCode).toBe(0);
  }, 30_000);

  it('defaults executionRoot to projectRoot, preserving single-checkout behaviour', async () => {
    const cmd = shCommand(`pwd > "${markerDir}/cwd.txt"; exit 0`);
    const r = await runToolCached(cmd, dir, { spawnTimeoutMs: 30_000 });

    expect(r.executionRoot).toBe(dir);
    const ranIn = readFileSync(join(markerDir, 'cwd.txt'), 'utf-8').trim();
    expect(realpathSync(ranIn)).toBe(realpathSync(dir));
  }, 30_000);
});
