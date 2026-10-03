/**
 * Tests for the heavy-command planner behind `cleo hook heavy-command` (T12983).
 *
 * Coverage:
 *   - recognition is run-class's (looksHeavy/resolveRunClass), checked here
 *     through the planner: the positives, and negatives where a tool name is
 *     only an argument, an info flag, or a watch/dev/serve/ui mode
 *   - planHeavyCommand: simple commands, assignments, `time`, wrappers,
 *     lists (`cd x && …`), pipelines and redirections wrapped in place, already
 *     governed commands, and every construct that must warn instead
 *   - heredocs and quoting are lexed, not guessed (a commit message that
 *     mentions `pnpm test` is never rewritten)
 *   - resolveHeavyHookMode / configuredHeavyHookMode / heavyHookProjectRoot /
 *     executableOnPath
 *   - heavyPressureNotice: a line at yellow (hold) and red (backoff) only
 *
 * @task T12983
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const monitor = vi.hoisted(() => ({
  state: 'ok' as 'ok' | 'hold' | 'backoff',
  sample: async (): Promise<object> => ({}),
}));
vi.mock('../monitor.js', () => ({
  defaultResourceBackend: () => ({ sample: () => monitor.sample() }),
  classifyPressure: () => ({ state: monitor.state, reason: 'memory some avg10 42' }),
}));

import {
  configuredHeavyHookMode,
  executableOnPath,
  heavyHookProjectRoot,
  heavyPressureNotice,
  planHeavyCommand,
  resolveHeavyHookMode,
} from '../heavy-command.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-heavy-command-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** What the planner does with one simple command line. */
const actionOf = (line: string, cwd: string): string => planHeavyCommand(line, { cwd }).action;

describe('recognition (run-class, through the planner)', () => {
  it('rewrites the test runners, compilers, builds and installs', () => {
    for (const line of [
      'vitest run a.test.ts',
      'npx vitest run',
      'jest',
      'tsc --noEmit',
      'npx tsc -b',
      'turbo run build',
      'next build',
      'vite build',
      'pnpm test',
      'pnpm run test',
      'npm run build',
      'yarn typecheck',
      'bun run test',
      'npm t',
      'pnpm install',
      'npm ci',
      'npm install',
      'yarn install',
      'cargo build',
      'cargo test',
      'go test ./...',
      'pytest -x',
      'env CI=1 pnpm vitest run',
      'nice -n 10 pnpm build',
      'pnpm -w run build',
    ]) {
      expect(actionOf(line, dir), line).toBe('rewrite');
    }
  });

  it('ignores a tool name that is only an argument', () => {
    for (const line of [
      'git commit -m vitest',
      'grep -rn tsc .',
      'rg vitest packages',
      'cd packages/next',
      'cat tsconfig.json',
      'which tsc',
      'echo pnpm test',
    ]) {
      expect(actionOf(line, dir), line).toBe('none');
    }
  });

  it('ignores info flags and watch, dev, serve and ui modes (they never exit)', () => {
    for (const line of [
      'tsc --version',
      'tsc -v',
      'npx vitest --help',
      'vitest --watch',
      'pnpm vitest --ui',
      'jest --watchAll',
      'tsc -w',
      'tsc --build --watch',
      'next dev',
      'next start',
      'vite',
      'vite preview',
      'pnpm dev',
      'npm run dev',
      'pnpm test:watch',
      'pnpm --filter web dev',
      'pnpm run test -- --watch',
      'nx serve app',
    ]) {
      expect(actionOf(line, dir), line).toBe('none');
    }
  });
});

/**
 * Run-class gaps found while wiring the hook and fixed in #1777 round 5
 * (they were pinned here as `it.fails` until the fix landed). Recognition
 * stays in run-class: the hook never patches around it.
 */
describe('recognition regressions fixed in #1777 round 5', () => {
  for (const line of [
    'turbo run dev',
    'turbo run start',
    'nx run-many -t serve',
    'nx affected -t dev',
  ]) {
    it(`never rewrites the dev server \`${line}\``, () => {
      expect(actionOf(line, dir)).toBe('none');
    });
  }

  for (const line of ['jest -v', 'vitest -v']) {
    it(`treats \`${line}\` as --version and leaves it alone`, () => {
      expect(actionOf(line, dir)).toBe('none');
    });
  }

  it('rewrites `pnpm build:dev` (a finite build, not a dev server)', () => {
    expect(actionOf('pnpm build:dev', dir)).toBe('rewrite');
  });
});

describe('planHeavyCommand — rewrites', () => {
  const plan = (command: string, waitTimeoutSec?: number) =>
    planHeavyCommand(command, {
      cwd: dir,
      ...(waitTimeoutSec === undefined ? {} : { waitTimeoutSec }),
    });

  it('prefixes a simple command and infers its class', () => {
    expect(plan('pnpm vitest run a.test.ts')).toEqual({
      action: 'rewrite',
      command: 'cleo run --wait --passthrough --class test -- pnpm vitest run a.test.ts',
      segments: [
        {
          text: 'pnpm vitest run a.test.ts',
          runClass: 'test',
          governed: 'cleo run --wait --passthrough --class test -- pnpm vitest run a.test.ts',
          argv: ['pnpm', 'vitest', 'run', 'a.test.ts'],
        },
      ],
    });
    const tsc = plan('npx tsc --noEmit', 300);
    expect(tsc.action === 'rewrite' && tsc.command).toBe(
      'cleo run --wait --passthrough --timeout 300 --class build -- npx tsc --noEmit',
    );
  });

  it('infers full-build for an unscoped build at a workspace root', () => {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
    const p = plan('pnpm run build');
    expect(p.action === 'rewrite' && p.command).toBe(
      'cleo run --wait --passthrough --class full-build -- pnpm run build',
    );
  });

  it('keeps leading assignments in front of cleo run', () => {
    const p = plan('CI=1 FOO="a b" pnpm test');
    expect(p.action === 'rewrite' && p.command).toBe(
      'CI=1 FOO="a b" cleo run --wait --passthrough --class test -- pnpm test',
    );
  });

  it('inserts after a time keyword and keeps wrappers inside', () => {
    const t = plan('time pnpm test');
    expect(t.action === 'rewrite' && t.command).toBe(
      'time cleo run --wait --passthrough --class test -- pnpm test',
    );
    const w = plan('env CI=1 nice -n 10 pnpm test');
    expect(w.action === 'rewrite' && w.command).toBe(
      'cleo run --wait --passthrough --class test -- env CI=1 nice -n 10 pnpm test',
    );
  });

  it('governs only the heavy elements of a list, so cd still moves the shell', () => {
    const p = plan('cd packages/core && pnpm vitest run src/x.test.ts; echo done');
    expect(p.action === 'rewrite' && p.command).toBe(
      'cd packages/core && cleo run --wait --passthrough --class test -- pnpm vitest run src/x.test.ts; echo done',
    );
    const two = plan('pnpm install && pnpm build');
    expect(two.action === 'rewrite' && two.command).toBe(
      'cleo run --wait --passthrough --class build -- pnpm install && cleo run --wait --passthrough --class build -- pnpm build',
    );
    expect(two.action === 'rewrite' && two.segments.length).toBe(2);
  });

  it('infers the class in the directory a literal cd moved to', () => {
    mkdirSync(join(dir, 'mono'));
    writeFileSync(join(dir, 'mono', 'turbo.json'), '{}\n');
    const p = plan('cd mono && pnpm build');
    expect(p.action === 'rewrite' && p.command).toBe(
      'cd mono && cleo run --wait --passthrough --class full-build -- pnpm build',
    );
  });

  it('wraps the heavy command in place and leaves pipes and redirections to the shell', () => {
    const p = plan('npx tsc --noEmit 2>&1 | head -50');
    expect(p.action === 'rewrite' && p.command).toBe(
      'cleo run --wait --passthrough --class build -- npx tsc --noEmit 2>&1 | head -50',
    );
    const r = plan("cd pkg && pnpm vitest run 'a b.test.ts' > out.log");
    expect(r.action === 'rewrite' && r.command).toBe(
      "cd pkg && cleo run --wait --passthrough --class test -- pnpm vitest run 'a b.test.ts' > out.log",
    );
    for (const [line, expected] of [
      ['pnpm test |& tail', 'cleo run --wait --passthrough --class test -- pnpm test |& tail'],
      [
        'pnpm test &> out.log',
        'cleo run --wait --passthrough --class test -- pnpm test &> out.log',
      ],
      [
        'pnpm test >& out.log',
        'cleo run --wait --passthrough --class test -- pnpm test >& out.log',
      ],
      [
        'set -o pipefail; pnpm test | tail',
        'set -o pipefail; cleo run --wait --passthrough --class test -- pnpm test | tail',
      ],
      [
        'git diff --name-only | pnpm vitest run $FILE | tail -5',
        'git diff --name-only | cleo run --wait --passthrough --class test -- pnpm vitest run $FILE | tail -5',
      ],
      [
        '>build.log 2>&1 cargo build',
        '>build.log 2>&1 cleo run --wait --passthrough --class build -- cargo build',
      ],
      [
        'pnpm install --frozen-lockfile 2>&1 | tail -20',
        'cleo run --wait --passthrough --class build -- pnpm install --frozen-lockfile 2>&1 | tail -20',
      ],
    ] as const) {
      const got = plan(line);
      expect(got.action === 'rewrite' && got.command, line).toBe(expected);
    }
  });

  it('keeps every byte of the line around the inserted prefix', () => {
    const line = `pnpm vitest run 'it'"'"'s a "test".ts' 2>&1 | grep -v 'x y' > out.log`;
    const p = plan(line);
    const prefix = 'cleo run --wait --passthrough --class test -- ';
    expect(p.action === 'rewrite' && p.command).toBe(`${prefix}${line}`);
  });

  it('allows an expansion in a simple command (the outer shell expands it)', () => {
    const p = plan('pnpm vitest run $(git diff --name-only | grep test)');
    expect(p.action === 'rewrite' && p.command).toBe(
      'cleo run --wait --passthrough --class test -- pnpm vitest run $(git diff --name-only | grep test)',
    );
  });
});

describe('planHeavyCommand — leaves alone', () => {
  const plan = (command: string) => planHeavyCommand(command, { cwd: dir });

  it('returns none for light commands', () => {
    for (const command of ['ls -la', 'git status', 'cleo show T1', 'echo "pnpm test"', '']) {
      expect(plan(command), command).toEqual({ action: 'none' });
    }
  });

  it('never re-wraps a governed command', () => {
    for (const command of [
      'cleo run --class test -- pnpm test',
      'cleo run --wait -- pnpm test | tail -5',
      '~/.cleo-heavy/run.sh pnpm install --frozen-lockfile',
      'CI=1 ~/.cleo-heavy/run.sh npx tsc -b',
      'ct run -- vitest run',
    ]) {
      expect(plan(command), command).toEqual({ action: 'none' });
    }
  });

  it('does not rewrite text inside a heredoc (a commit message that mentions pnpm test)', () => {
    const command = [
      "git commit -m \"$(cat <<'EOF'",
      'fix: do not run',
      'pnpm test',
      "in CI; it's slow",
      'EOF',
      ')"',
    ].join('\n');
    expect(plan(command)).toEqual({ action: 'none' });
    // Without apostrophes too, so the lexer cannot bail out on a stray quote.
    const plain = 'git commit -m "$(cat <<\'EOF\'\npnpm test\nEOF\n)"';
    expect(plan(plain)).toEqual({ action: 'none' });
    expect(plan('cat > notes.md <<EOF\npnpm test\nEOF\necho ok')).toEqual({ action: 'none' });
    const tabbed = plan('cat <<-END\n\tpnpm test\n\tEND\npnpm build');
    expect(tabbed.action === 'rewrite' && tabbed.command).toBe(
      'cat <<-END\n\tpnpm test\n\tEND\ncleo run --wait --passthrough --class build -- pnpm build',
    );
  });

  it('returns none for a line that is not valid shell', () => {
    expect(plan("pnpm test 'unterminated")).toEqual({ action: 'none' });
  });
});

describe('planHeavyCommand — warns instead of rewriting', () => {
  const reasonOf = (command: string): string => {
    const p = planHeavyCommand(command, { cwd: dir });
    expect(p.action, command).toBe('warn');
    return p.action === 'warn' ? p.reason : '';
  };

  it('a heavy command inside a command substitution', () => {
    expect(reasonOf('echo $(pnpm test)')).toMatch(/command substitution/);
    expect(reasonOf('x=`npx tsc --noEmit`')).toMatch(/command substitution/);
  });

  it('a background job, a subshell, a loop or a group', () => {
    expect(reasonOf('pnpm build &')).toMatch(/background/);
    expect(reasonOf('(cd pkg && pnpm test)')).toMatch(/subshell/);
    expect(reasonOf('(cd pkg; pnpm build; echo done)')).toMatch(/subshell/);
    expect(reasonOf('for f in a b; do pnpm test $f; done')).toMatch(/compound/);
    expect(reasonOf('if true; then echo x; pnpm build; fi')).toMatch(/compound/);
    expect(reasonOf('{ pnpm test; }')).toMatch(/compound/);
    expect(reasonOf('! pnpm test')).toMatch(/compound/);
  });

  it('two heavy commands in one pipeline (both would start at once)', () => {
    expect(reasonOf('pnpm build | pnpm test')).toMatch(/share one pipeline/);
  });

  it('a heavy command that reads a heredoc', () => {
    expect(reasonOf('pnpm vitest run <<EOF\nx\nEOF')).toMatch(/heredoc/);
  });

  it('names the governed form of the heavy command', () => {
    const p = planHeavyCommand('for f in a b; do pnpm test $f; done', { cwd: dir });
    expect(p.action === 'warn' && p.segments[0]?.governed).toBe(
      'cleo run --wait --passthrough --class test -- pnpm test $f',
    );
  });
});

/**
 * The rewrite must not change what a line does in the shell that runs it:
 * Claude Code runs Bash in the user's $SHELL (often zsh), Codex hands it to
 * a shell too, and /bin/sh is bash on macOS and dash on Debian/Ubuntu. Each
 * line runs twice in every shell present, as written and as rewritten, with
 * harmless stand-ins on PATH: `pnpm` / `cargo` print to stdout and stderr
 * and exit with $PNPM_EXIT, and `cleo` behaves like
 * `cleo run --passthrough` (drops its options up to `--`, then execs the
 * command with the same stdio, environment and exit code). Stdout, stderr,
 * exit code and any files written must match exactly.
 */
describe('rewritten lines behave like the originals in a real shell', () => {
  const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash', '/bin/zsh', '/usr/bin/zsh'].filter((s) =>
    existsSync(s),
  );
  const POSIX = (shell: string) => !/zsh|bash/.test(shell) || shell === '/bin/sh';
  /** `requires`: a snippet the shell must parse for the case to apply (bash 3.2 has no `|&`). */
  const CASES: readonly {
    readonly line: string;
    readonly bashOrZshOnly?: boolean;
    readonly requires?: string;
  }[] = [
    { line: 'pnpm test | tail -1' },
    { line: 'pnpm test 2>&1 | tail -2' },
    { line: 'PNPM_EXIT=3 pnpm test; echo "rc=$?"' },
    { line: 'FOO=from-assignment pnpm test' },
    { line: 'mkdir -p sub && cd sub && pnpm test && pwd' },
    { line: 'pnpm test > out.log; cat out.log' },
    { line: 'pnpm test && cargo build' },
    { line: 'PNPM_EXIT=2 pnpm test || echo failed' },
    { line: 'mkdir -p a/b && touch a/b/x.test.ts && pnpm vitest run **/*.test.ts' },
    { line: 'set -o pipefail; PNPM_EXIT=4 pnpm test | cat; echo "rc=$?"', bashOrZshOnly: true },
    { line: 'pnpm test |& cat', bashOrZshOnly: true, requires: 'true |& true' },
    { line: 'pnpm test &> out.log; cat out.log', bashOrZshOnly: true },
    { line: 'pnpm test >& out.log; cat out.log', bashOrZshOnly: true },
  ];

  let bin: string;
  beforeEach(() => {
    bin = join(dir, 'bin');
    mkdirSync(bin);
    const standIn =
      '#!/bin/sh\necho "out:$(basename "$0") $*"\necho "err:$(basename "$0")" >&2\n' +
      `echo "env:\${FOO:-}"\nexit "\${PNPM_EXIT:-0}"\n`;
    for (const name of ['pnpm', 'cargo']) {
      writeFileSync(join(bin, name), standIn);
      chmodSync(join(bin, name), 0o755);
    }
    writeFileSync(
      join(bin, 'cleo'),
      '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
    );
    chmodSync(join(bin, 'cleo'), 0o755);
  });

  function runIn(shell: string, line: string, cwd: string) {
    mkdirSync(cwd, { recursive: true });
    const r = spawnSync(shell, ['-c', line], {
      cwd,
      encoding: 'utf-8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: cwd, ZDOTDIR: cwd },
      timeout: 20_000,
    });
    const log = join(cwd, 'out.log');
    return {
      stdout: r.stdout.replaceAll(cwd, '<cwd>'),
      stderr: r.stderr.replaceAll(cwd, '<cwd>'),
      status: r.status,
      log: existsSync(log) ? 'exists' : 'absent',
    };
  }

  it('found at least one shell to run', () => {
    expect(SHELLS.length).toBeGreaterThan(0);
  });

  for (const shell of SHELLS) {
    for (const { line, bashOrZshOnly, requires } of CASES) {
      if (bashOrZshOnly && POSIX(shell)) continue;
      if (requires && spawnSync(shell, ['-c', requires]).status !== 0) continue;
      it(`${shell}: ${line}`, () => {
        const p = planHeavyCommand(line, { cwd: dir });
        expect(p.action, line).toBe('rewrite');
        const rewritten = p.action === 'rewrite' ? p.command : line;
        expect(rewritten).toContain('cleo run --wait --passthrough');
        expect(runIn(shell, rewritten, join(dir, 'b'))).toEqual(runIn(shell, line, join(dir, 'a')));
      });
    }
  }
});

describe('resolveHeavyHookMode', () => {
  it('prefers the environment, then config, then rewrite', () => {
    expect(resolveHeavyHookMode('off', 'rewrite')).toBe('off');
    expect(resolveHeavyHookMode(undefined, 'warn')).toBe('warn');
    expect(resolveHeavyHookMode(' WARN ', undefined)).toBe('warn');
    expect(resolveHeavyHookMode('bogus', 'off')).toBe('off');
    expect(resolveHeavyHookMode(undefined, undefined)).toBe('rewrite');
  });
});

describe('executableOnPath', () => {
  it('finds an executable and ignores a plain file', () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'cleo'), '#!/bin/sh\n');
    chmodSync(join(bin, 'cleo'), 0o755);
    writeFileSync(join(bin, 'notexec'), 'x');
    chmodSync(join(bin, 'notexec'), 0o644);
    expect(executableOnPath('cleo', `/nonexistent:${bin}`)).toBe(true);
    expect(executableOnPath('notexec', bin)).toBe(false);
    expect(executableOnPath('cleo', undefined)).toBe(false);
  });
});

describe('heavyHookProjectRoot', () => {
  it('finds the nearest directory holding .cleo, else keeps cwd', () => {
    const sub = join(dir, 'packages', 'core', 'src');
    mkdirSync(sub, { recursive: true });
    expect(heavyHookProjectRoot(sub)).toBe(sub);
    mkdirSync(join(dir, '.cleo'));
    expect(heavyHookProjectRoot(sub)).toBe(dir);
  });
});

describe('configuredHeavyHookMode', () => {
  it('reads resources.heavyCommandHook from the project config', async () => {
    expect(await configuredHeavyHookMode(dir)).toBeUndefined();
    mkdirSync(join(dir, '.cleo'));
    writeFileSync(
      join(dir, '.cleo', 'config.json'),
      JSON.stringify({ resources: { heavyCommandHook: 'warn' } }),
    );
    expect(await configuredHeavyHookMode(dir)).toBe('warn');
    writeFileSync(
      join(dir, '.cleo', 'config.json'),
      JSON.stringify({ resources: { heavyCommandHook: 'sometimes' } }),
    );
    expect(await configuredHeavyHookMode(dir)).toBeUndefined();
  });
});

describe('heavyPressureNotice', () => {
  afterEach(() => {
    monitor.state = 'ok';
    monitor.sample = async () => ({});
  });

  it('says nothing when pressure is ok', async () => {
    expect(await heavyPressureNotice()).toBeNull();
  });

  it('names yellow for hold and red for backoff', async () => {
    monitor.state = 'hold';
    expect(await heavyPressureNotice()).toMatch(
      /^\[cleo\] Machine pressure is yellow \(memory some avg10 42\)/,
    );
    monitor.state = 'backoff';
    expect(await heavyPressureNotice()).toMatch(/pressure is red/);
  });

  it('gives up on a slow or failing sample', async () => {
    monitor.state = 'backoff';
    monitor.sample = () => new Promise(() => {});
    expect(await heavyPressureNotice(20)).toBeNull();
    monitor.sample = async () => {
      throw new Error('sysctl failed');
    };
    expect(await heavyPressureNotice()).toBeNull();
  });
});
