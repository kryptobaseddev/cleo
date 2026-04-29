/**
 * Tests for `hooks-install.ts` (T1588).
 *
 * Covers:
 *  - Project-agnostic install on a fresh `git init` repo.
 *  - Idempotent re-install (CLEO sentinel detected).
 *  - Refusal to clobber non-CLEO hooks unless `force`.
 *  - Hook accept/reject behaviour invoked as a real subprocess
 *    (so we test the actual POSIX shell script, not a JS proxy).
 *  - Project-agnostic: works in a non-node project (no package.json).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLEO_HOOK_NAMES,
  CLEO_HOOK_SENTINEL,
  installCleoHooks,
  isCleoManagedHook,
} from '../hooks-install.js';

/**
 * Repo-source templates dir. We pass this explicitly so tests don't
 * depend on the default-resolution walk.
 */
const REPO_TEMPLATES_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'cleo',
  'templates',
  'hooks',
);

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-hooks-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; tmpfs cleans itself on reboot.
  }
});

/** Initialise a bare git repo at `dir`. Returns the dir for chaining. */
function gitInit(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  // Standard config so commits succeed without global identity.
  execFileSync('git', ['config', 'user.email', 'test@cleo.dev'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'cleo-test'], { cwd: dir });
  // commit.gpgsign off + disable any global hookspath inheritance.
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

/**
 * Run the commit-msg hook script directly with a given subject. Returns
 * the exit code (0 = pass). Subject is written to a temp file fed as $1.
 */
function runCommitMsgHook(repo: string, subject: string): number {
  const msgFile = path.join(repo, '.git', 'COMMIT_EDITMSG.test');
  fs.writeFileSync(msgFile, subject);
  const hook = path.join(repo, '.git', 'hooks', 'commit-msg');
  try {
    execFileSync('/bin/sh', [hook, msgFile], {
      cwd: repo,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return 0;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number };
    return typeof e.status === 'number' ? e.status : 1;
  }
}

describe('installCleoHooks (T1588)', () => {
  it('installs both hooks cleanly on a fresh git repo', async () => {
    const repo = gitInit(path.join(tmpRoot, 'fresh'));

    const res = await installCleoHooks(repo, {
      templatesDir: REPO_TEMPLATES_DIR,
    });

    expect(res.installed.sort()).toEqual([...CLEO_HOOK_NAMES].sort());
    expect(res.skipped).toEqual([]);

    for (const name of CLEO_HOOK_NAMES) {
      const dst = path.join(repo, '.git', 'hooks', name);
      expect(fs.existsSync(dst)).toBe(true);
      const stat = fs.statSync(dst);
      // Owner-execute bit must be set.
      expect((stat.mode & 0o100) !== 0).toBe(true);
      const body = fs.readFileSync(dst, 'utf8');
      expect(body).toContain(CLEO_HOOK_SENTINEL);
    }
  });

  it('is idempotent: re-installing leaves hooks unchanged', async () => {
    const repo = gitInit(path.join(tmpRoot, 'idem'));

    await installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR });

    const dst = path.join(repo, '.git', 'hooks', 'commit-msg');
    const firstStat = fs.statSync(dst);
    const firstBody = fs.readFileSync(dst, 'utf8');

    // Second install — sentinel-based detection means it overwrites
    // the same content, no skip, no change.
    const res = await installCleoHooks(repo, {
      templatesDir: REPO_TEMPLATES_DIR,
    });
    expect(res.installed).toContain('commit-msg');
    expect(res.skipped).toEqual([]);

    const secondBody = fs.readFileSync(dst, 'utf8');
    expect(secondBody).toBe(firstBody);
    // Mode preserved.
    const secondStat = fs.statSync(dst);
    expect((secondStat.mode & 0o100) !== 0).toBe(true);
    // Don't compare full mode — some filesystems flap user/group bits.
    void firstStat;
  });

  it('refuses to clobber a non-CLEO hook unless force:true', async () => {
    const repo = gitInit(path.join(tmpRoot, 'clobber'));
    const hooksDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    const userHook = path.join(hooksDir, 'commit-msg');
    fs.writeFileSync(userHook, '#!/bin/sh\n# user-owned hook\nexit 0\n', {
      mode: 0o755,
    });

    // Without force → skip.
    const res1 = await installCleoHooks(repo, {
      templatesDir: REPO_TEMPLATES_DIR,
    });
    expect(res1.skipped).toContain('commit-msg');
    expect(res1.skipReasons['commit-msg']).toMatch(/non-CLEO/);
    const stillUser = fs.readFileSync(userHook, 'utf8');
    expect(stillUser).toContain('user-owned hook');

    // With force → overwrite.
    const res2 = await installCleoHooks(repo, {
      templatesDir: REPO_TEMPLATES_DIR,
      force: true,
    });
    expect(res2.installed).toContain('commit-msg');
    expect(res2.skipped).not.toContain('commit-msg');
    const overwritten = fs.readFileSync(userHook, 'utf8');
    expect(overwritten).toContain(CLEO_HOOK_SENTINEL);
  });

  it('works in a project-agnostic (non-node) repo with no package.json', async () => {
    // Simulate a Rust / Python / bare repo: just `git init` and a single
    // README, no package.json, no node_modules.
    const repo = gitInit(path.join(tmpRoot, 'rusty'));
    fs.writeFileSync(path.join(repo, 'README.md'), '# rusty crate\n');

    const res = await installCleoHooks(repo, {
      templatesDir: REPO_TEMPLATES_DIR,
    });

    expect(res.installed.sort()).toEqual([...CLEO_HOOK_NAMES].sort());
    // Hooks must run with /bin/sh — no node dep.
    expect(runCommitMsgHook(repo, 'T1588: ship hooks installer')).toBe(0);
  });

  it('rejects projects that are not git repos', async () => {
    const notRepo = path.join(tmpRoot, 'not-a-repo');
    fs.mkdirSync(notRepo, { recursive: true });
    await expect(installCleoHooks(notRepo, { templatesDir: REPO_TEMPLATES_DIR })).rejects.toThrow(
      /not inside a git repository/,
    );
  });
});

describe('commit-msg hook subject regex (T1588)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = gitInit(path.join(tmpRoot, 'subj'));
    await installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR });
  });

  it.each([
    'T1588: foo',
    'feat(T1588): add hooks',
    'fix: T1588 typo',
    'T1: minimum digits',
    'T123456789: many digits',
    'chore — T1588 — done',
    'T1588',
  ])('accepts subject with T-ID: %s', (subject) => {
    expect(runCommitMsgHook(repo, subject)).toBe(0);
  });

  it.each([
    'fix bug',
    'feat: add new feature',
    'chore: bump deps',
    'WIP',
    'TIP: not a task ID', // T followed by non-digit letter then space
    'task1234: not a T ID',
  ])('rejects subject without T-ID: %s', (subject) => {
    expect(runCommitMsgHook(repo, subject)).not.toBe(0);
  });

  it.each([
    'Merge branch task/T1244',
    'Merge pull request #42',
    'Revert "some commit"',
    'fixup! earlier commit',
    'squash! earlier commit',
    'amend! earlier commit',
  ])('bypasses merge/revert/fixup/squash/amend: %s', (subject) => {
    expect(runCommitMsgHook(repo, subject)).toBe(0);
  });

  it('rejects an empty commit subject', () => {
    expect(runCommitMsgHook(repo, '')).not.toBe(0);
  });

  it('ignores leading comment lines and blank lines when finding subject', () => {
    // git's stock commit message often starts with `# Please enter…`.
    // We must skip them and read the first real subject line.
    expect(runCommitMsgHook(repo, '# comment\n\nT1588: real subject\n')).toBe(0);
    expect(runCommitMsgHook(repo, '# comment\n\nno tid here\n')).not.toBe(0);
  });
});

describe('isCleoManagedHook', () => {
  it('returns true for files containing the sentinel in the head', () => {
    const f = path.join(tmpRoot, 'managed.sh');
    fs.writeFileSync(f, `#!/bin/sh\n${CLEO_HOOK_SENTINEL}\necho hi\n`);
    expect(isCleoManagedHook(f)).toBe(true);
  });

  it('returns false for files without the sentinel', () => {
    const f = path.join(tmpRoot, 'user.sh');
    fs.writeFileSync(f, '#!/bin/sh\necho hi\n');
    expect(isCleoManagedHook(f)).toBe(false);
  });

  it('returns false for non-existent files', () => {
    expect(isCleoManagedHook(path.join(tmpRoot, 'nope.sh'))).toBe(false);
  });
});
