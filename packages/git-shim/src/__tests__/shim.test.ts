import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
let root: string;
let shim: string;
let sentry: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-git-identity-'));
  shim = join(root, 'package', 'dist', 'shim.mjs');
  buildSync({
    entryPoints: [join(repo, 'packages/git-shim/src/shim.ts')],
    outfile: shim,
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: {
      '@cleocode/paths': join(repo, 'packages/paths/src/index.ts'),
      '@cleocode/contracts': join(repo, 'packages/contracts/src/index.ts'),
    },
  });
  chmodSync(shim, 0o755);
  sentry = join(root, 'sentry.mjs');
  // Independent safety control: even defective source can launch at most five
  // successive Node children. No tested production guard is trusted for cleanup.
  writeFileSync(
    sentry,
    "const n=Number(process.env.SHIM_TEST_DEPTH??'0')+1;" +
      "process.env.SHIM_TEST_DEPTH=String(n);if(n>5){process.stderr.write('RECURSION_SENTRY');process.exit(88);}",
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(): string {
  const directory = mkdtempSync(join(root, 'case-'));
  mkdirSync(join(directory, 'bin'));
  symlinkSync(process.execPath, join(directory, 'bin', 'node'));
  return directory;
}

function realGit(directory: string): string {
  const binary = join(directory, 'git');
  writeFileSync(binary, '#!/bin/sh\nprintf "REAL_GIT:%s\\n" "$*"\n');
  chmodSync(binary, 0o755);
  return binary;
}

async function invoke(
  directory: string,
  entry: string,
  path: string[],
  args = ['--version'],
  extra: NodeJS.ProcessEnv = {},
): Promise<[number | null, string, string]> {
  const child = spawn(entry, args, {
    cwd: directory,
    detached: true,
    env: {
      HOME: directory,
      XDG_DATA_HOME: directory,
      PATH: [...path, join(directory, 'bin')].join(':'),
      NODE_OPTIONS: `--import=${sentry} --max-old-space-size=128`,
      CLEO_AUDIT_LOG_PATH: join(directory, 'audit.jsonl'),
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const killOwned = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    killOwned();
  }, 4000);
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.length > 32768) killOwned();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 32768) killOwned();
  });
  try {
    const status = await new Promise<number | null>((resolveStatus, reject) => {
      child.once('error', reject);
      child.once('close', resolveStatus);
    });
    expect(timedOut).toBe(false);
    return [status, stdout, stderr];
  } finally {
    clearTimeout(timeout);
    killOwned();
  }
}

describe('installed executable identity', () => {
  it('skips the npm .bin symlink and delegates to a later executable', async () => {
    const dir = fixture();
    const bin = join(dir, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(shim, join(bin, 'git'));
    realGit(dir);
    expect(await invoke(dir, join(bin, 'git'), [bin, dir])).toEqual([
      0,
      'REAL_GIT:--version\n',
      '',
    ]);
  });

  it('skips a pnpm .bin/git shell wrapper that runs the shim (T12652)', async () => {
    // pnpm layout: node_modules/@cleocode/git-shim is a link to the package,
    // and node_modules/.bin/git is a regular-file sh wrapper (own inode) that
    // execs node on "$basedir/../@cleocode/git-shim/dist/shim.js".
    const dir = fixture();
    const modules = join(dir, 'node_modules');
    const bin = join(modules, '.bin');
    const pkgDist = join(modules, '@cleocode', 'git-shim', 'dist');
    mkdirSync(bin, { recursive: true });
    mkdirSync(pkgDist, { recursive: true });
    symlinkSync(shim, join(pkgDist, 'shim.js'));
    const wrapper = join(bin, 'git');
    writeFileSync(
      wrapper,
      '#!/bin/sh\n' +
        // pnpm computes this with dirname/sed; the test PATH has neither.
        'basedir=${0%/*}\n' +
        'if [ -x "$basedir/node" ]; then\n' +
        '  exec "$basedir/node"  "$basedir/../@cleocode/git-shim/dist/shim.js" "$@"\n' +
        'else\n' +
        '  exec node  "$basedir/../@cleocode/git-shim/dist/shim.js" "$@"\n' +
        'fi\n',
    );
    chmodSync(wrapper, 0o755);
    realGit(dir);
    // The wrapper is FIRST on PATH, exactly as under `pnpm exec`.
    expect(await invoke(dir, wrapper, [bin, dir])).toEqual([0, 'REAL_GIT:--version\n', '']);
  });

  it('still delegates to a non-shim script launcher on PATH', async () => {
    const dir = fixture();
    const other = join(dir, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'tool.js'), "process.stdout.write('OTHER_LAUNCHER\\n');\n");
    const launcher = join(other, 'git');
    writeFileSync(launcher, '#!/bin/sh\nbasedir=${0%/*}\nexec node "$basedir/tool.js" "$@"\n');
    chmodSync(launcher, 0o755);
    expect(await invoke(dir, shim, [other])).toEqual([0, 'OTHER_LAUNCHER\n', '']);
  });

  it('skips a hardlink of the executing shim', async () => {
    const dir = fixture();
    linkSync(shim, join(dir, 'bin', 'git'));
    realGit(dir);
    expect(await invoke(dir, shim, [join(dir, 'bin'), dir])).toEqual([
      0,
      'REAL_GIT:--version\n',
      '',
    ]);
  });

  it.each(['symlink', 'hardlink'])('rejects explicit self via %s', async (kind) => {
    const dir = fixture();
    const alias = join(dir, 'self');
    if (kind === 'symlink') symlinkSync(shim, alias);
    else linkSync(shim, alias);
    const [status, stdout, stderr] = await invoke(dir, shim, [], ['--version'], {
      CLEO_REAL_GIT_PATH: alias,
    });
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('CLEO_REAL_GIT_PATH');
    expect(stderr).not.toContain('RECURSION_SENTRY');
  });

  it('carries identities through two different shim copies without bouncing', async () => {
    const dir = fixture();
    const second = join(dir, 'second');
    mkdirSync(second);
    copyFileSync(shim, join(second, 'git'));
    chmodSync(join(second, 'git'), 0o755);
    symlinkSync(shim, join(dir, 'bin', 'git'));
    realGit(dir);
    expect(await invoke(dir, shim, [second, join(dir, 'bin'), dir])).toEqual([
      0,
      'REAL_GIT:--version\n',
      '',
    ]);
  });

  it('rejects a two-copy explicit override loop without exhausting the sentry', async () => {
    const dir = fixture();
    const second = join(dir, 'second.mjs');
    copyFileSync(shim, second);
    chmodSync(second, 0o755);
    const [status, , stderr] = await invoke(dir, shim, [], ['--version'], {
      CLEO_REAL_GIT_PATH: second,
    });
    expect(status).toBe(1);
    expect(stderr).toContain('CLEO_REAL_GIT_PATH');
    expect(stderr).not.toContain('RECURSION_SENTRY');
  });

  it.each(['file', 'directory'])('skips a non-executable %s PATH candidate', async (kind) => {
    const dir = fixture();
    const candidate = join(dir, 'bin', 'git');
    if (kind === 'file') writeFileSync(candidate, 'not executable', { mode: 0o644 });
    else mkdirSync(candidate);
    realGit(dir);
    expect(await invoke(dir, shim, [join(dir, 'bin'), dir])).toEqual([
      0,
      'REAL_GIT:--version\n',
      '',
    ]);
  });

  it('rejects an invalid explicit executable instead of silently selecting another', async () => {
    const dir = fixture();
    const invalid = join(dir, 'invalid');
    writeFileSync(invalid, 'not executable', { mode: 0o644 });
    realGit(dir);
    const [status, stdout, stderr] = await invoke(dir, shim, [dir], ['--version'], {
      CLEO_REAL_GIT_PATH: invalid,
    });
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('CLEO_REAL_GIT_PATH');
  });

  it.each([
    'invalid',
    Array.from({ length: 16 }, () => '1:2').join(';'),
  ])('refuses malformed or exhausted delegation history', async (chain) => {
    const dir = fixture();
    realGit(dir);
    const [status, stdout, stderr] = await invoke(dir, shim, [dir], ['--version'], {
      CLEO_GIT_SHIM_CHAIN: chain,
      CLEO_GIT_SHIM_PARENT_PID: String(process.pid),
    });
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('delegation chain');
  });

  it('retains a valid explicit Git override', async () => {
    const dir = fixture();
    expect(
      await invoke(dir, shim, [], ['--version'], { CLEO_REAL_GIT_PATH: realGit(dir) }),
    ).toEqual([0, 'REAL_GIT:--version\n', '']);
  });

  it('allows a real Git hook to invoke Git again across the executable boundary', async () => {
    const dir = fixture();
    const git = realGit(dir);
    writeFileSync(
      git,
      '#!/bin/sh\nif [ "$1" = hook ]; then "$SHIM_TEST_ENTRY" --version; else printf "REAL_GIT:%s\\n" "$*"; fi\n',
    );
    symlinkSync(shim, join(dir, 'bin', 'git'));
    expect(
      await invoke(dir, shim, [join(dir, 'bin'), dir], ['hook'], {
        SHIM_TEST_ENTRY: shim,
      }),
    ).toEqual([0, 'REAL_GIT:--version\n', '']);
  });

  it('uses identity protection on no-argument and allowed worker passthrough paths', async () => {
    const dir = fixture();
    symlinkSync(shim, join(dir, 'bin', 'git'));
    realGit(dir);
    expect(await invoke(dir, shim, [join(dir, 'bin'), dir], [])).toEqual([0, 'REAL_GIT:\n', '']);
    expect(
      await invoke(dir, shim, [join(dir, 'bin'), dir], ['status'], {
        CLEO_AGENT_ROLE: 'worker',
      }),
    ).toEqual([0, 'REAL_GIT:status\n', '']);
  });

  it('retains worker policy and audit before delegation', async () => {
    const dir = fixture();
    realGit(dir);
    const [status, stdout, stderr] = await invoke(dir, shim, [dir], ['checkout', 'main'], {
      CLEO_AGENT_ROLE: 'worker',
    });
    expect(status).toBe(77);
    expect(stdout).toBe('');
    expect(stderr).toContain('BLOCKED');
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).toContain('blocked');
  });
});
