/**
 * Tests for scripts/migrate-rogue-worktrees.mjs (T12725).
 *
 * Incident: the migrator ignored `--check`, so an agent running "every script
 * in AGENTS.md" with `--check` unlocked and moved three live Agent-tool
 * worktrees. These tests pin the safe behaviour:
 *   - unknown flags are refused (exit 2) before any action;
 *   - the default run is a dry-run and moves nothing;
 *   - `--apply` moves an unlocked, unused rogue worktree;
 *   - `--apply` never unlocks or moves a locked worktree;
 *   - `--apply` skips a worktree a live process has as its cwd;
 *   - unavailable in-use detection means "in use" unless `--force-unused`.
 *
 * Every test builds a scratch repo in the OS tmpdir with real
 * `git worktree add` / `git worktree lock`, and points CLEO_HOME at the
 * scratch dir. Nothing touches the real repository or its worktrees.
 *
 * @task T12725
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const SCRIPT = resolve(__dirname, '..', 'migrate-rogue-worktrees.mjs');

/** Environment without inherited GIT_* variables (e.g. from a git hook). */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
    ...extra,
  };
}

let scratch;
let repo;
let cleoHome;
let rogue;
let canonicalDest;
let sleeper;

function git(args, cwd = repo) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function runMigrator(args = [], extraEnv = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv({ CLEO_HOME: cleoHome, ...extraEnv }),
    timeout: 90_000,
  });
}

function worktreeListed(path) {
  return git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .some((l) => l === `worktree ${path}`);
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-migrate-rogue-')));
  repo = join(scratch, 'repo');
  cleoHome = join(scratch, 'cleo-home');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['commit', '-q', '--allow-empty', '-m', 'init']);
  rogue = join(repo, '.claude', 'worktrees', 'agent-x');
  git(['worktree', 'add', '-q', '-b', 'task/T4242-x', rogue]);
  const hash = createHash('sha256').update(repo).digest('hex').slice(0, 16);
  canonicalDest = join(cleoHome, 'worktrees', hash, 'T4242');
  sleeper = null;
});

afterEach(() => {
  if (sleeper && sleeper.exitCode === null) sleeper.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});

describe('migrate-rogue-worktrees — argument handling', () => {
  it('refuses --check with a non-zero exit and usage, moving nothing', () => {
    const r = runMigrator(['--check', '--apply']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown argument(s): --check');
    expect(r.stderr).toContain('Usage:');
    expect(existsSync(rogue)).toBe(true);
    expect(existsSync(canonicalDest)).toBe(false);
    expect(worktreeListed(rogue)).toBe(true);
  });

  it('refuses --apply combined with --dry-run', () => {
    const r = runMigrator(['--apply', '--dry-run']);
    expect(r.status).toBe(2);
    expect(existsSync(rogue)).toBe(true);
  });
});

describe('migrate-rogue-worktrees — default dry-run', () => {
  it('reports the plan and moves nothing without --apply', () => {
    const r = runMigrator([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DRY-RUN');
    expect(r.stdout).toContain(rogue);
    expect(existsSync(rogue)).toBe(true);
    expect(existsSync(canonicalDest)).toBe(false);
    expect(worktreeListed(rogue)).toBe(true);
  });
});

describe('migrate-rogue-worktrees — --apply', () => {
  it('moves an unlocked, unused rogue worktree', () => {
    const r = runMigrator(['--apply', '--no-archive']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('1 migrated');
    expect(existsSync(rogue)).toBe(false);
    expect(existsSync(canonicalDest)).toBe(true);
    expect(worktreeListed(canonicalDest)).toBe(true);
  });

  it('never unlocks or moves a locked worktree', () => {
    git(['worktree', 'lock', '--reason', 'agent live', rogue]);
    const r = runMigrator(['--apply', '--no-archive', '--force-unused']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('SKIP: locked (agent live)');
    expect(r.stdout).toContain('0 migrated, 1 skipped');
    expect(existsSync(rogue)).toBe(true);
    expect(existsSync(canonicalDest)).toBe(false);
    const porcelain = git(['worktree', 'list', '--porcelain']);
    expect(porcelain).toContain('locked agent live');
  });

  it('skips a worktree that a running process uses as its cwd', async () => {
    sleeper = spawn('sleep', ['60'], { cwd: rogue, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    const r = runMigrator(['--apply', '--no-archive']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/SKIP: in use/);
    expect(existsSync(rogue)).toBe(true);
    expect(existsSync(canonicalDest)).toBe(false);
  });

  it('treats unavailable in-use detection as in use unless --force-unused', () => {
    const env = { MIGRATE_ROGUE_WORKTREES_NO_INUSE_PROBE: '1' };
    const skipped = runMigrator(['--apply', '--no-archive'], env);
    expect(skipped.status, skipped.stderr).toBe(0);
    expect(skipped.stdout).toContain('in-use detection unavailable');
    expect(existsSync(rogue)).toBe(true);

    const forced = runMigrator(['--apply', '--no-archive', '--force-unused'], env);
    expect(forced.status, forced.stderr).toBe(0);
    expect(existsSync(rogue)).toBe(false);
    expect(existsSync(canonicalDest)).toBe(true);
  });
});
