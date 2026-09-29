/**
 * `projectHash` is a write-once identity key, stable across worktrees and
 * symlinked spellings of one project (T12557).
 *
 * The audit middleware (`dispatch/middleware/audit.ts`), idempotency keys and
 * release ids all read `getProjectInfoSync()?.projectHash`. When `cleo init`
 * stopped persisting it and readers derived it from the caller's root, a
 * command run from a task worktree wrote a different `project_hash` than the
 * main checkout, and `/tmp/x` and `/private/tmp/x` forked it too.
 *
 * T12716: a freshly MINTED identity persists sha256('project-id:'+id), which
 * no path spelling or worktree can fork; every project with a prior identity
 * keeps the path-derived value its keys were built from.
 *
 * @task T12557
 * @task T12716
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateProjectHash } from '../nexus/hash.js';
import { getProjectInfoSync } from '../project-info.js';
import { ensureProjectInfo } from '../scaffold/ensure-config.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

let sandbox: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' });
}

/** A committed git repo with `.cleo/`; `info` is written verbatim when given. */
function mainCheckout(info?: Record<string, unknown>): string {
  const root = join(sandbox, 'main');
  mkdirSync(join(root, '.cleo'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'x\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '--no-verify', '-m', 'init');
  if (info) writeFileSync(join(root, '.cleo', 'project-info.json'), JSON.stringify(info));
  return root;
}

/**
 * A linked worktree provisioned the way `cleo orchestrate spawn` does it: a
 * sibling checkout with the parent's `project-info.json` seeded for identity,
 * entered with the spawn environment.
 */
function spawnWorktree(main: string): string {
  const wt = join(sandbox, 'worktrees', 'abc123', 'T1');
  git(main, 'worktree', 'add', '-q', '-b', 'task/T1', wt);
  mkdirSync(join(wt, '.cleo'), { recursive: true });
  copyFileSync(join(main, '.cleo', 'project-info.json'), join(wt, '.cleo', 'project-info.json'));
  vi.stubEnv('CLEO_WORKTREE_ROOT', wt);
  vi.stubEnv('CLEO_WORKTREE_BRANCH', 'task/T1');
  vi.stubEnv('CLEO_AGENT_ROLE', 'worker');
  vi.stubEnv('CLEO_PROJECT_HASH', 'abc123');
  vi.stubEnv('CLEO_AGENT_ID', 'agent-t1');
  return wt;
}

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t12557-')));
  vi.stubEnv('CLEO_HOME', join(sandbox, 'cleo-home'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('T12557: projectHash is stable across worktrees', () => {
  it('fresh init: a command in a spawned worktree reads the same audit project_hash as main', async () => {
    const main = mainCheckout();
    await ensureProjectInfo(main);
    const { projectHash: persisted, projectId } = JSON.parse(
      readFileSync(join(main, '.cleo', 'project-info.json'), 'utf-8'),
    ) as { projectHash?: string; projectId: string };
    // T12716: a freshly MINTED identity's hash derives from its id, not the
    // path (review finding 1 keeps the path hash for every prior identity).
    expect(persisted).toBe(generateProjectHash(`project-id:${projectId}`));

    const mainHash = getProjectInfoSync(main)?.projectHash;
    const wt = spawnWorktree(main);
    expect(getProjectInfoSync(wt)?.projectHash).toBe(mainHash);
    expect(mainHash).toBe(persisted);
  });

  it('legacy file without a hash: worktree and main derive the MAIN checkout hash', () => {
    const main = mainCheckout({ projectId: 'legacy-id', name: 'main' });
    const wt = spawnWorktree(main);
    const expected = generateProjectHash(main);
    expect(getProjectInfoSync(wt)?.projectHash).toBe(expected);
    expect(getProjectInfoSync(main)?.projectHash).toBe(expected);
  });
});

describe('T12557: projectHash is stable across symlinked spellings', () => {
  it('a legacy file read through a symlink and through its real path gets one hash', () => {
    const real = join(sandbox, 'real');
    mkdirSync(join(real, '.cleo'), { recursive: true });
    const link = join(sandbox, 'link');
    symlinkSync(real, link);
    const infoPath = join(real, '.cleo', 'project-info.json');
    const legacy = JSON.stringify({ projectId: 'legacy-id', name: 'real' });

    writeFileSync(infoPath, legacy);
    const viaLink = getProjectInfoSync(link)?.projectHash;
    writeFileSync(infoPath, legacy);
    const viaReal = getProjectInfoSync(real)?.projectHash;
    expect(viaLink).toBe(generateProjectHash(real));
    expect(viaReal).toBe(viaLink);
  });

  it('init through a symlink persists one hash for both spellings', async () => {
    const real = join(sandbox, 'real');
    mkdirSync(join(real, '.cleo'), { recursive: true });
    const link = join(sandbox, 'link');
    symlinkSync(real, link);
    await ensureProjectInfo(link);
    // T12716: a freshly minted identity's hash derives from its id, so no
    // spelling of the path can fork it.
    const { projectId } = JSON.parse(
      readFileSync(join(real, '.cleo', 'project-info.json'), 'utf-8'),
    ) as { projectId: string };
    const expected = generateProjectHash(`project-id:${projectId}`);
    expect(getProjectInfoSync(link)?.projectHash).toBe(expected);
    expect(getProjectInfoSync(real)?.projectHash).toBe(expected);
  });
});
