/**
 * Tests for `hooks-install.ts` (T1588) and diff-scope validation (T1608).
 *
 * Covers:
 *  - Project-agnostic install on a fresh `git init` repo.
 *  - Idempotent re-install (content and receipt verified).
 *  - Preservation of foreign and customized hooks, including with `force`.
 *  - Hook accept/reject behaviour invoked as a real subprocess
 *    (so we test the actual POSIX shell script, not a JS proxy).
 *  - Project-agnostic: works in a non-node project (no package.json).
 *  - T1608 diff-scope: warns when >50% staged files are out-of-scope.
 *  - T1608 diff-scope: skips gracefully when cleo absent or task has no files[].
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import releasedTemplates from './fixtures/released-hook-templates.json' with { type: 'json' };

function privateReceiptPath(
  repo: string,
  hooksDir = path.join(repo, '.git', 'hooks'),
  bare = false,
): string {
  const canonical = fs.realpathSync(hooksDir);
  const id = createHash('sha256').update(canonical).digest('hex');
  return path.join(repo, bare ? '' : '.git', 'cleo-git-hooks', `install-${id}.json`);
}

/**
 * Repo-source templates dir. We pass this explicitly so tests don't
 * depend on the default-resolution walk.
 *
 * T9858 relocated the git-hook templates from
 * `packages/cleo/templates/hooks/` to `packages/core/templates/git-hooks/`
 * per the Package-Boundary Check, so this resolver now walks UP to
 * `packages/core/` and DOWN into `templates/git-hooks/`.
 */
const REPO_TEMPLATES_DIR = path.resolve(__dirname, '..', '..', '..', 'templates', 'git-hooks');

let tmpRoot: string;

function commandPath(command: string): string {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const output = execFileSync(finder, [command], { encoding: 'utf8' });
  return output.split(/\r?\n/).find(Boolean) ?? command;
}

function posixShell(): string {
  if (process.platform !== 'win32' && fs.existsSync('/bin/sh')) return '/bin/sh';
  return commandPath('sh');
}

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
    execFileSync(posixShell(), [hook, msgFile], {
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
  it('installs all three hooks cleanly on a fresh git repo', async () => {
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

    // Second install — content/receipt validation means it refreshes
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

  it('preserves foreign hooks even when the compatibility force flag is set', async () => {
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

    // Force no longer bypasses ownership validation (T13349).
    const res2 = await installCleoHooks(repo, {
      templatesDir: REPO_TEMPLATES_DIR,
      force: true,
    });
    expect(res2.skipped).toContain('commit-msg');
    expect(fs.readFileSync(userHook, 'utf8')).toBe(stillUser);
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

// ---------------------------------------------------------------------------
// T1608 — diff-scope validation tests
// ---------------------------------------------------------------------------

/**
 * Build a fake `cleo` shell script that, when called with `show <TASK_ID>`,
 * emits a JSON payload containing the provided files array. Any other
 * invocation prints `{}` and exits 0 (graceful noop).
 *
 * @param binDir  Directory where the fake `cleo` binary will be written.
 * @param taskId  Task ID the fake binary recognises (e.g. "T1608").
 * @param files   File paths to embed in the `data.task.files` array.
 */
function writeFakeCleo(binDir: string, taskId: string, files: string[]): string {
  const filesJson = JSON.stringify(files);
  const script = `#!/bin/sh
# Fake cleo stub for T1608 diff-scope tests.
if [ "$1" = "show" ] && [ "$2" = "${taskId}" ]; then
  printf '%s\\n' '{"success":true,"data":{"task":{"id":"${taskId}","files":${filesJson}}}}'
else
  printf '%s\\n' '{}'
fi
`;
  const binPath = path.join(binDir, 'cleo');
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

/**
 * Run the commit-msg hook with an explicit staged-files list injected via
 * a fake `git diff --cached --name-only` environment. We achieve this by
 * prepending a fake `git` stub to PATH that intercepts the diff command.
 *
 * Uses `spawnSync` (not `execFileSync`) so stderr is captured even when
 * the hook exits 0 (which is the case for drift warnings).
 *
 * Returns `{ exitCode, stderr }`.
 */
function runCommitMsgHookWithDiff(
  repo: string,
  subject: string,
  stagedFiles: string[],
  cleoBin: string,
): { exitCode: number; stderr: string } {
  // Write a fake `git` wrapper that handles `diff --cached --name-only`
  // and delegates everything else to the real git.
  const fakeGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-fakegit-'));
  const stagedOutput = stagedFiles.join('\n');
  const fakeGit = path.join(fakeGitDir, 'git');
  const realGit = commandPath('git').replace(/'/g, "'\\''");
  fs.writeFileSync(
    fakeGit,
    `#!/bin/sh
# Fake git stub for diff-scope tests.
if [ "$1" = "diff" ] && [ "$2" = "--cached" ] && [ "$3" = "--name-only" ]; then
  printf '%s\\n' '${stagedOutput.replace(/'/g, "'\\''")}'
  exit 0
fi
# Delegate to real git for everything else.
exec '${realGit}' "$@"
`,
    { mode: 0o755 },
  );

  const msgFile = path.join(repo, '.git', 'COMMIT_EDITMSG.test');
  fs.writeFileSync(msgFile, subject);
  const hook = path.join(repo, '.git', 'hooks', 'commit-msg');

  const result = spawnSync(posixShell(), [hook, msgFile], {
    cwd: repo,
    // Prepend fake git dir + cleo dir to PATH so stubs take precedence.
    env: {
      ...process.env,
      PATH: [fakeGitDir, path.dirname(cleoBin), process.env['PATH'] ?? '/usr/bin:/bin'].join(
        path.delimiter,
      ),
      CLEO_BIN: cleoBin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    fs.rmSync(fakeGitDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }

  const exitCode = result.status ?? 1;
  const stderr = result.stderr?.toString() ?? '';
  return { exitCode, stderr };
}

describe('commit-msg hook diff-scope validation (T1608)', () => {
  let repo: string;
  let fakeBinDir: string;

  beforeEach(async () => {
    repo = gitInit(path.join(tmpRoot, 'scope'));
    await installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR });
    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-fakebin-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(fakeBinDir, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  });

  it('exits 0 with no warning when all staged files are in-scope', () => {
    const cleoBin = writeFakeCleo(fakeBinDir, 'T9001', ['src/foo.ts', 'src/bar.ts']);
    const { exitCode, stderr } = runCommitMsgHookWithDiff(
      repo,
      'feat(T9001): add foo and bar',
      ['src/foo.ts', 'src/bar.ts'],
      cleoBin,
    );
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/drift/i);
    expect(stderr).not.toMatch(/WARNING/);
  });

  it('exits 0 with no warning when drift is exactly at threshold (50%)', () => {
    // 2 staged, 1 in-scope, 1 out-of-scope → 50% drift, NOT > 50%.
    const cleoBin = writeFakeCleo(fakeBinDir, 'T9002', ['src/foo.ts']);
    const { exitCode, stderr } = runCommitMsgHookWithDiff(
      repo,
      'feat(T9002): in and out',
      ['src/foo.ts', 'src/unrelated.ts'],
      cleoBin,
    );
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/WARNING/);
  });

  it('exits 0 with WARNING on stderr when drift exceeds 50%', () => {
    // 3 staged, 1 in-scope, 2 out-of-scope → 66% drift > 50%.
    const cleoBin = writeFakeCleo(fakeBinDir, 'T9003', ['src/target.ts']);
    const { exitCode, stderr } = runCommitMsgHookWithDiff(
      repo,
      'fix(T9003): scoped change',
      ['src/target.ts', 'src/other-a.ts', 'src/other-b.ts'],
      cleoBin,
    );
    expect(exitCode).toBe(0); // Warning only — NOT a hard block.
    expect(stderr).toMatch(/drift WARNING/i);
    expect(stderr).toMatch(/T9003/);
    expect(stderr).toMatch(/src\/other-a\.ts/);
    expect(stderr).toMatch(/src\/other-b\.ts/);
  });

  it('exits 0 silently when cleo is absent (project-agnostic degradation)', () => {
    // No fake cleo in PATH — use CLEO_BIN pointing to a non-existent binary.
    const { exitCode, stderr } = runCommitMsgHookWithDiff(
      repo,
      'feat(T9004): no cleo available',
      ['src/anything.ts'],
      '/nonexistent/cleo',
    );
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/drift/i);
    expect(stderr).not.toMatch(/WARNING/);
  });

  it('exits 0 silently when task has no files[] (scope undefined)', () => {
    // Fake cleo returns empty files[] — no scope to validate against.
    const cleoBin = writeFakeCleo(fakeBinDir, 'T9005', []);
    const { exitCode, stderr } = runCommitMsgHookWithDiff(
      repo,
      'feat(T9005): broad work',
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      cleoBin,
    );
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/drift/i);
  });

  it('exits 0 silently when no files are staged (message-only amend)', () => {
    // Empty staged files list — nothing to compare against scope.
    const cleoBin = writeFakeCleo(fakeBinDir, 'T9006', ['src/foo.ts']);
    const { exitCode, stderr } = runCommitMsgHookWithDiff(
      repo,
      'fix(T9006): amend message',
      [], // no staged files
      cleoBin,
    );
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/drift/i);
  });

  it('matches directory-prefix scope (staged file under task scope dir)', () => {
    // Task scope is a directory; staged file is inside it — in-scope.
    const cleoBin = writeFakeCleo(fakeBinDir, 'T9007', ['packages/core/src/git/']);
    const { exitCode, stderr } = runCommitMsgHookWithDiff(
      repo,
      'refactor(T9007): git internals',
      ['packages/core/src/git/hooks-install.ts', 'packages/core/src/git/utils.ts'],
      cleoBin,
    );
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/WARNING/);
  });

  it('warns when drift > 50% with directory-prefix scope', () => {
    // Task scope is packages/core/; 3 staged files: 1 inside, 2 outside.
    const cleoBin = writeFakeCleo(fakeBinDir, 'T9008', ['packages/core/']);
    const { exitCode, stderr } = runCommitMsgHookWithDiff(
      repo,
      'chore(T9008): scope test',
      ['packages/core/src/foo.ts', 'packages/studio/index.ts', 'packages/cleo/bar.ts'],
      cleoBin,
    );
    expect(exitCode).toBe(0); // WARNING only.
    expect(stderr).toMatch(/drift WARNING/i);
    expect(stderr).toMatch(/packages\/studio\/index\.ts/);
    expect(stderr).toMatch(/packages\/cleo\/bar\.ts/);
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

describe('Git-native installation and recovery (T13349)', () => {
  it('uses the shared Git directory from a linked checkout and nested directory', async () => {
    const repo = gitInit(path.join(tmpRoot, 'main'));
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'T13349 initial'],
      { cwd: repo },
    );
    const linked = path.join(tmpRoot, 'linked checkout');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'linked', linked], { cwd: repo });
    fs.mkdirSync(path.join(linked, 'nested'));
    const result = await installCleoHooks(path.join(linked, 'nested'), {
      templatesDir: REPO_TEMPLATES_DIR,
    });
    expect(result.hooksDir).toBe(path.join(fs.realpathSync(repo), '.git', 'hooks'));
  });

  it.each(['relative hooks', 'absolute'])('respects %s core.hooksPath', async (configured) => {
    const repo = gitInit(path.join(tmpRoot, 'custom'));
    const hooks = configured === 'absolute' ? path.join(tmpRoot, 'absolute hooks') : configured;
    execFileSync('git', ['config', 'core.hooksPath', hooks], { cwd: repo });
    const result = await installCleoHooks(repo, {
      templatesDir: REPO_TEMPLATES_DIR,
      allowTrackedHooksPath: true,
    });
    expect(result.hooksDir).toBe(
      path.isAbsolute(hooks) ? hooks : path.resolve(fs.realpathSync(repo), hooks),
    );
  });

  it('preserves a customized file despite its CLEO marker and previous receipt', async () => {
    const repo = gitInit(path.join(tmpRoot, 'customized'));
    await installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR });
    const target = path.join(repo, '.git', 'hooks', 'pre-push');
    fs.appendFileSync(target, '\n# team customization\n');
    const customized = fs.readFileSync(target, 'utf8');
    const result = await installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR, force: true });
    expect(result.skipped).toContain('pre-push');
    expect(fs.readFileSync(target, 'utf8')).toBe(customized);
  });

  it('does not overwrite hooks or foreign metadata when the receipt is invalid', async () => {
    const repo = gitInit(path.join(tmpRoot, 'invalid-receipt'));
    const receipt = privateReceiptPath(repo);
    fs.mkdirSync(path.dirname(receipt));
    fs.writeFileSync(receipt, '[]');
    await expect(installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR })).rejects.toThrow(
      'receipt is invalid',
    );
    expect(fs.readFileSync(receipt, 'utf8')).toBe('[]');
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'commit-msg'))).toBe(false);
  });

  it('recognizes an exact legacy pre-commit template without a marker', async () => {
    const repo = gitInit(path.join(tmpRoot, 'legacy'));
    const target = path.join(repo, '.git', 'hooks', 'pre-commit');
    const legacy = fs
      .readFileSync(path.join(REPO_TEMPLATES_DIR, 'pre-commit'), 'utf8')
      .replace(`${CLEO_HOOK_SENTINEL}\n`, '');
    fs.writeFileSync(target, legacy);
    const result = await installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR });
    expect(result.installed).toContain('pre-commit');
    expect(fs.readFileSync(target, 'utf8')).toContain(CLEO_HOOK_SENTINEL);
  });

  it('preserves symbolic hooks rather than writing through or replacing them', async () => {
    const repo = gitInit(path.join(tmpRoot, 'symlink'));
    const file = path.join(tmpRoot, 'team-hook');
    fs.copyFileSync(path.join(REPO_TEMPLATES_DIR, 'pre-push'), file);
    fs.symlinkSync(file, path.join(repo, '.git', 'hooks', 'pre-push'));
    const result = await installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR });
    expect(result.skipped).toContain('pre-push');
    expect(fs.lstatSync(path.join(repo, '.git', 'hooks', 'pre-push')).isSymbolicLink()).toBe(true);
  });

  it('serializes concurrent installations and rolls back only matching images', async () => {
    const repo = gitInit(path.join(tmpRoot, 'concurrent'));
    const results = await Promise.all([
      installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR }),
      installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR }),
    ]);
    const first = results.find((result) =>
      result.receipt?.changes.every((change) => change.before === null),
    );
    expect(first?.receipt).toBeDefined();
    const customized = path.join(repo, '.git', 'hooks', 'pre-push');
    fs.appendFileSync(customized, '# custom\n');
    const rollback = await installCleoHooks(repo, {
      templatesDir: REPO_TEMPLATES_DIR,
      rollbackReceipt: first?.receipt,
    });
    expect(rollback.skipped).toEqual(['pre-push']);
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'commit-msg'))).toBe(false);
    expect(fs.readFileSync(customized, 'utf8')).toContain('# custom');
  });

  it.each(releasedTemplates)('refreshes exact released $name template $hash', async (released) => {
    const repo = gitInit(path.join(tmpRoot, 'released'));
    const target = path.join(repo, '.git', 'hooks', released.name);
    fs.writeFileSync(target, released.body);
    const result = await installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR });
    expect(result.installed).toContain(released.name);
    expect(fs.readFileSync(target, 'utf8')).toBe(
      fs.readFileSync(path.join(REPO_TEMPLATES_DIR, released.name), 'utf8'),
    );
    fs.appendFileSync(target, '# customization\n');
    expect((await installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR })).skipped).toContain(
      released.name,
    );
  });

  it('isolates private receipts for different linked-worktree hooksPath destinations', async () => {
    const repo = gitInit(path.join(tmpRoot, 'linked-receipts'));
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'T13349 initial'],
      { cwd: repo },
    );
    const linked = path.join(tmpRoot, 'other checkout');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'other', linked], { cwd: repo });
    execFileSync('git', ['config', 'core.hooksPath', 'team-hooks'], { cwd: repo });
    const options = { templatesDir: REPO_TEMPLATES_DIR, allowTrackedHooksPath: true };
    expect((await installCleoHooks(repo, options)).installed).toHaveLength(3);
    expect((await installCleoHooks(linked, options)).installed).toHaveLength(3);
    expect((await installCleoHooks(repo, options)).installed).toHaveLength(3);
    expect(
      fs
        .readdirSync(path.join(repo, '.git', 'cleo-git-hooks'))
        .filter((file) => file.endsWith('.json')),
    ).toHaveLength(2);
    expect(fs.readdirSync(path.join(linked, 'team-hooks')).sort()).toEqual([
      'commit-msg',
      'pre-commit',
      'pre-push',
    ]);
  });

  it('keeps bare repository installation Git-private', async () => {
    const repo = path.join(tmpRoot, 'bare.git');
    execFileSync('git', ['init', '--bare', '-q', repo]);
    const result = await installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR });
    expect(result.installed).toEqual([...CLEO_HOOK_NAMES]);
    expect(fs.existsSync(privateReceiptPath(repo, path.join(repo, 'hooks'), true))).toBe(true);
  });

  it('preserves tracked hooksPath by default and keeps opted-in receipts Git-private', async () => {
    const repo = gitInit(path.join(tmpRoot, 'tracked-hooks'));
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: repo });
    const hooks = path.join(repo, '.husky');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'pre-push'), 'echo team-policy\n');
    execFileSync('git', ['add', '.husky/pre-push'], { cwd: repo });
    const original = fs.readFileSync(path.join(hooks, 'pre-push'), 'utf8');
    const skipped = await installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR, force: true });
    expect(skipped.installed).toEqual([]);
    expect(skipped.skipReasons['pre-push']).toContain(
      'cleo init --git-hooks-only --allow-tracked-hooks-path',
    );
    expect(fs.readdirSync(hooks)).toEqual(['pre-push']);
    expect(fs.readFileSync(path.join(hooks, 'pre-push'), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(repo, '.git', 'cleo-git-hooks'))).toBe(false);
    const result = await installCleoHooks(repo, {
      templatesDir: REPO_TEMPLATES_DIR,
      allowTrackedHooksPath: true,
    });
    expect(result.installed).toEqual(['commit-msg', 'pre-commit']);
    expect(result.skipped).toEqual(['pre-push']);
    expect(fs.existsSync(privateReceiptPath(repo, hooks))).toBe(true);
    expect(fs.readdirSync(hooks).sort()).toEqual(['commit-msg', 'pre-commit', 'pre-push']);
    const rollback = await installCleoHooks(repo, {
      templatesDir: REPO_TEMPLATES_DIR,
      allowTrackedHooksPath: true,
      rollbackReceipt: result.receipt,
    });
    expect(rollback.installed).toEqual(['commit-msg', 'pre-commit']);
    expect(fs.readFileSync(path.join(hooks, 'pre-push'), 'utf8')).toBe(original);
  });

  it('standalone pre-push never invokes a project runner', async () => {
    const repo = gitInit(path.join(tmpRoot, 'standalone'));
    await installCleoHooks(repo, { templatesDir: REPO_TEMPLATES_DIR });
    const bin = path.join(tmpRoot, 'bin');
    fs.mkdirSync(bin);
    const marker = path.join(tmpRoot, 'called');
    fs.writeFileSync(path.join(bin, 'cleo'), '#!/bin/sh\necho called > "$CALLED"\nexit 1\n', {
      mode: 0o755,
    });
    const zero = '0'.repeat(40);
    const result = spawnSync(posixShell(), [path.join(repo, '.git', 'hooks', 'pre-push')], {
      cwd: repo,
      input: `refs/heads/a ${zero} refs/heads/a ${zero}\nrefs/heads/b ${zero} refs/heads/b ${zero}\n`,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CALLED: marker },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
