/**
 * The dependency-free command recognizer (T12979; #1777 round 3 add-ons for
 * the T12983 hook): only the command word counts; --version/--help and
 * watch/dev/serve modes are never heavy.
 *
 * @task T12979
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commandTarget,
  isPausable,
  isWatchCommand,
  isWholeSuiteTestRun,
  looksHeavy,
  namedTestFileCount,
  resolveRunClass,
} from '../run-class.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-run-class-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('commandTarget', () => {
  it('finds the tool past env, nice and NAME=value prefixes', () => {
    expect(commandTarget(['env', 'CI=1', 'NODE_OPTIONS=x', 'tsc', '-b']).tool).toBe('tsc');
    expect(commandTarget(['nice', '-n', '10', 'vitest', 'run']).tool).toBe('vitest');
    expect(commandTarget(['FOO=bar', './node_modules/.bin/jest']).tool).toBe('jest');
  });

  it('resolves package-manager scripts and exec targets', () => {
    expect(commandTarget(['pnpm', '--filter', 'x', 'run', 'test:unit'])).toMatchObject({
      script: 'test:unit',
      scoped: true,
    });
    expect(commandTarget(['npx', '-y', 'vitest', 'run']).tool).toBe('vitest');
    expect(commandTarget(['pnpm', 'exec', 'tsc', '--noEmit']).tool).toBe('tsc');
    expect(commandTarget(['pnpm', 'dlx', 'eslint', '.']).tool).toBe('eslint');
    expect(commandTarget(['yarn', 'workspaces', 'foreach', '-A', 'run', 'build'])).toMatchObject({
      script: 'build',
      recursive: true,
    });
    expect(commandTarget(['pnpm', '-w', 'build']).script).toBe('build'); // pnpm -w is boolean
    expect(commandTarget(['npm', '-w', 'pkg', 'run', 'build']).script).toBe('build'); // npm -w takes a value
  });
});

describe('looksHeavy: only the command word counts', () => {
  it('flags real heavy commands', () => {
    for (const argv of [
      ['npx', 'vitest', 'run'],
      ['pnpm', 'vitest', 'run', 'a.test.ts'],
      ['tsc', '--noEmit'],
      ['pnpm', 'exec', 'tsc', '-b'],
      ['eslint', '.'],
      ['pnpm', 'install'],
      ['npm', 'ci'],
      ['npm', 't'],
      ['pnpm', '--filter', 'x', 'test'],
      ['bun', 'test'],
      ['next', 'build'],
      ['vite', 'build'],
      ['cargo', 'test'],
    ]) {
      expect(looksHeavy(argv), argv.join(' ')).toBe(true);
    }
  });

  it('never matches a tool name inside an argument', () => {
    for (const argv of [
      ['git', 'commit', '-m', 'fix vitest'],
      ['grep', '-rn', 'tsc', '.'],
      ['cd', 'packages/next'],
      ['cat', 'vitest.config.ts'],
      ['echo', 'pnpm build'],
      ['cleo', 'show', 'T1'],
    ]) {
      expect(looksHeavy(argv), argv.join(' ')).toBe(false);
    }
  });

  it('never flags --version/--help or watch/dev/serve modes', () => {
    for (const argv of [
      ['tsc', '--version'],
      ['vitest', '--help'],
      ['vitest', '--watch'],
      ['vitest', 'watch'],
      ['tsc', '-w'],
      ['jest', '--watchAll'],
      ['pnpm', 'dev'],
      ['npm', 'run', 'start'],
      ['next', 'dev'],
      ['vite'],
      ['pnpm', 'run', 'serve:docs'],
    ]) {
      expect(looksHeavy(argv), argv.join(' ')).toBe(false);
    }
  });
});

describe('resolveRunClass', () => {
  it('a tool name in an argument does not make a command a test run', () => {
    expect(resolveRunClass(undefined, ['git', 'commit', '-m', 'fix vitest'], dir)).toBe(
      'scoped-build',
    );
  });

  it('workspace-wide builds are full builds; scoping wins over recursion', () => {
    expect(resolveRunClass(undefined, ['npm', 'run', 'build', '--workspaces'], dir)).toBe(
      'full-build',
    );
    expect(resolveRunClass(undefined, ['yarn', 'workspaces', 'foreach', 'run', 'build'], dir)).toBe(
      'full-build',
    );
    expect(resolveRunClass(undefined, ['turbo', 'run', 'build'], dir)).toBe('full-build');
    expect(resolveRunClass(undefined, ['nx', 'run-many', '-t', 'build'], dir)).toBe('full-build');
    expect(resolveRunClass(undefined, ['pnpm', '-r', '--filter', 'x', 'build'], dir)).toBe(
      'scoped-build',
    );
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
    expect(resolveRunClass(undefined, ['pnpm', 'build'], dir)).toBe('full-build');
  });

  it('bun test and go test are test runs', () => {
    expect(resolveRunClass(undefined, ['bun', 'test'], dir)).toBe('test-run');
    expect(resolveRunClass(undefined, ['go', 'test', './...'], dir)).toBe('test-run');
  });
});

describe('isPausable', () => {
  it('cargo holds cache and target locks: never paused (L-6)', () => {
    expect(isPausable('test-run', ['cargo', 'test'])).toBe(false);
    expect(isPausable('scoped-build', ['cargo', 'build'])).toBe(false);
    expect(isPausable('test-run', ['npx', 'vitest', 'run'])).toBe(true);
  });
});

describe('round 4: watch false positives and recognizer false negatives', () => {
  it('watch scripts, -w/--watch/--ui and serve targets are never heavy', () => {
    for (const argv of [
      ['pnpm', 'test:watch'],
      ['npm', 'run', 'test:watch'],
      ['pnpm', 'build:watch'],
      ['rollup', '-c', '-w'],
      ['vitest', '--ui'],
      ['nx', 'run', 'app:serve'],
      ['tsc', '-w'],
    ]) {
      expect(looksHeavy(argv), argv.join(' ')).toBe(false);
    }
  });

  it('jest -w is maxWorkers, and -v is verbose for go test, pytest and cargo', () => {
    for (const argv of [
      ['jest', '-w', '2'],
      ['go', 'test', '-v', './...'],
      ['pytest', '-v'],
      ['cargo', 'test', '-v'],
    ]) {
      expect(looksHeavy(argv), argv.join(' ')).toBe(true);
    }
    expect(looksHeavy(['tsc', '-v'])).toBe(false); // version
  });

  it('dev as a flag value is not a dev mode', () => {
    expect(looksHeavy(['vite', 'build', '--mode', 'dev'])).toBe(true);
    expect(looksHeavy(['vitest', 'run', '--project', 'dev'])).toBe(true);
  });

  it('value-taking flags, npx -p and env -u resolve the real command word', () => {
    expect(commandTarget(['pnpm', 'run', '--filter', 'x', 'build'])).toMatchObject({
      script: 'build',
      scoped: true,
    });
    expect(commandTarget(['pnpm', '--reporter', 'append-only', 'test']).script).toBe('test');
    expect(commandTarget(['npx', '-p', 'typescript', 'tsc', '-b']).tool).toBe('tsc');
    expect(commandTarget(['env', '-u', 'FOO', 'tsc', '-b']).tool).toBe('tsc');
  });

  it('turbo and nx test tasks are test runs', () => {
    expect(resolveRunClass(undefined, ['turbo', 'run', 'test'], dir)).toBe('test-run');
    expect(resolveRunClass(undefined, ['turbo', 'test'], dir)).toBe('test-run');
    expect(resolveRunClass(undefined, ['nx', 'affected', '-t', 'test'], dir)).toBe('test-run');
    expect(resolveRunClass(undefined, ['turbo', 'run', 'build'], dir)).toBe('full-build');
  });
});

describe('round 5 (N5): classifier regressions', () => {
  it('turbo and nx watchers are never heavy: every task word and -t/--target value counts', () => {
    for (const argv of [
      ['turbo', 'run', 'dev'],
      ['npx', 'turbo', 'run', 'dev'],
      ['pnpm', 'turbo', 'run', 'dev'],
      ['turbo', 'run', 'start'],
      ['turbo', 'serve'],
      ['turbo', 'run', 'web#dev'],
      ['turbo', 'run', 'test:watch'],
      ['nx', 'run-many', '-t', 'serve'],
      ['nx', 'affected', '-t', 'dev'],
      ['nx', 'run-many', '--targets=build,serve'],
      ['nx', '--verbose', 'serve', 'app'],
      ['nx', 'run', 'app:serve:production'],
    ]) {
      expect(looksHeavy(argv), argv.join(' ')).toBe(false);
    }
  });

  it('dev/start/preview count only as the first segment; watch/serve anywhere', () => {
    for (const argv of [
      ['pnpm', 'build:dev'],
      ['npm', 'run', 'build:dev'],
      ['pnpm', 'build:preview'],
      ['pnpm', 'test:dev'],
      ['turbo', 'run', 'build:dev'],
      ['nx', 'run', 'web:build:dev'],
    ]) {
      expect(looksHeavy(argv), argv.join(' ')).toBe(true);
    }
    for (const argv of [
      ['pnpm', 'dev'],
      ['pnpm', 'dev:web'],
      ['pnpm', 'start'],
      ['pnpm', 'preview'],
      ['pnpm', 'docs:serve'],
      ['pnpm', 'build:watch'],
    ]) {
      expect(looksHeavy(argv), argv.join(' ')).toBe(false);
    }
  });

  it('-v / -V mean --version per tool', () => {
    for (const argv of [
      ['jest', '-v'],
      ['vitest', '-v'],
      ['pytest', '-V'],
      ['mocha', '-V'],
      ['cargo', '-V'],
      ['tsc', '-v'],
      ['tsc', '-V'],
    ]) {
      expect(looksHeavy(argv), argv.join(' ')).toBe(false);
    }
    for (const argv of [
      ['pytest', '-v'],
      ['cargo', 'test', '-v'],
      ['go', 'test', '-v', './...'],
      ['go', 'test', '-V'],
    ]) {
      expect(looksHeavy(argv), argv.join(' ')).toBe(true);
    }
  });

  it('a turbo/nx run with a build is a full build before any test rule', () => {
    expect(resolveRunClass(undefined, ['turbo', 'run', 'build', 'test'], dir)).toBe('full-build');
    expect(resolveRunClass(undefined, ['turbo', 'run', 'test', 'build'], dir)).toBe('full-build');
    expect(resolveRunClass(undefined, ['nx', 'run-many', '-t', 'build', 'test'], dir)).toBe(
      'full-build',
    );
    expect(resolveRunClass(undefined, ['nx', 'run-many', '--targets=test,lint'], dir)).toBe(
      'full-build',
    );
    expect(resolveRunClass(undefined, ['turbo', 'run', 'build', '--filter=web'], dir)).toBe(
      'scoped-build',
    );
    expect(
      resolveRunClass(undefined, ['nx', 'run-many', '-t', 'build', '--projects=a,b'], dir),
    ).toBe('scoped-build');
    expect(resolveRunClass(undefined, ['nx', 'build', 'app'], dir)).toBe('scoped-build');
  });

  it('nx run <proj>:test and nx <target> test are test runs; dlx -p resolves the tool', () => {
    expect(resolveRunClass(undefined, ['nx', 'run', 'web:test'], dir)).toBe('test-run');
    expect(resolveRunClass(undefined, ['nx', 'run', 'web:test:ci'], dir)).toBe('test-run');
    expect(resolveRunClass(undefined, ['nx', 'test', 'web'], dir)).toBe('test-run');
    expect(resolveRunClass(undefined, ['nx', 'run-many', '--target', 'test'], dir)).toBe(
      'test-run',
    );
    expect(commandTarget(['pnpm', 'dlx', '-p', 'typescript', 'tsc', '-b']).tool).toBe('tsc');
    expect(commandTarget(['pnpm', 'dlx', '--package', 'typescript', 'tsc']).tool).toBe('tsc');
    expect(looksHeavy(['pnpm', 'dlx', '-p', 'typescript', 'tsc', '-b'])).toBe(true);
  });
});

describe('round 6 (R6-3): turbo value flags, --ui per tool, admin subcommands', () => {
  it('turbo --ui and --global-deps take a value: the run stays heavy and keeps its class', () => {
    expect(looksHeavy(['turbo', 'run', 'build', '--ui', 'stream'])).toBe(true);
    expect(resolveRunClass(undefined, ['turbo', 'run', 'build', '--ui', 'stream'], dir)).toBe(
      'full-build',
    );
    expect(resolveRunClass(undefined, ['turbo', 'run', 'test', '--ui', 'stream'], dir)).toBe(
      'test-run',
    );
    expect(resolveRunClass(undefined, ['turbo', 'run', 'test', '--global-deps', 'x'], dir)).toBe(
      'test-run',
    );
    expect(looksHeavy(['turbo', 'run', 'build', '--ui=stream'])).toBe(true);
  });

  it('--ui is a watcher only for vitest and playwright', () => {
    expect(isWatchCommand(['vitest', '--ui'])).toBe(true);
    expect(isWatchCommand(['npx', 'playwright', 'test', '--ui'])).toBe(true);
    expect(isWatchCommand(['turbo', 'run', 'test', '--ui', 'tui'])).toBe(false);
  });

  it('turbo watch and nx watch are watchers; admin subcommands are not heavy', () => {
    expect(isWatchCommand(['turbo', 'watch', 'build'])).toBe(true);
    expect(isWatchCommand(['nx', 'watch', '--all', '--', 'echo'])).toBe(true);
    for (const argv of [
      ['turbo', 'login'],
      ['turbo', 'prune', 'web'],
      ['nx', 'graph'],
      ['nx', 'show', 'projects'],
      ['nx', 'reset'],
    ]) {
      expect(looksHeavy(argv), argv.join(' ')).toBe(false);
    }
    expect(looksHeavy(['turbo', 'run', 'build'])).toBe(true);
    expect(looksHeavy(['nx', 'build', 'web'])).toBe(true);
  });

  it('isWatchCommand matches every watcher looksHeavy rejects', () => {
    for (const argv of [
      ['pnpm', 'dev'],
      ['turbo', 'run', 'dev'],
      ['nx', 'run', 'app:serve'],
      ['tsc', '-w'],
      ['vite'],
    ]) {
      expect(isWatchCommand(argv), argv.join(' ')).toBe(true);
    }
    expect(isWatchCommand(['pnpm', 'build:dev'])).toBe(false);
  });
});

describe('round 7 (R7-1): CLEO commands are never paused', () => {
  it('cleo, ct, npx/pnpm cleo and node …/cleo: a lock holder whose heavy tool runs detached', () => {
    for (const argv of [
      ['cleo', 'verify', 'T1', '--gate', 'testsPassed', '--evidence', 'tool:test'],
      ['ct', 'verify', 'T1'],
      ['/usr/local/bin/cleo', 'verify', 'T1'],
      ['env', 'CLEO_SESSION_ID=s1', 'cleo', 'verify', 'T1'],
      ['npx', 'cleo', 'verify', 'T1'],
      ['npx', '-y', '@cleocode/cleo@latest', 'verify', 'T1'],
      ['pnpm', 'exec', 'cleo', 'verify', 'T1'],
      ['pnpm', 'dlx', '@cleocode/cleo', 'verify', 'T1'],
      ['pnpm', 'cleo', 'verify', 'T1'],
      ['node', '/opt/lib/node_modules/@cleocode/cleo/bin/cleo.js', 'verify', 'T1'],
      ['node', '--max-old-space-size=4096', 'packages/cleo/dist/cli/index.js', 'verify'],
      ['node', '-r', 'source-map-support/register', 'bin/cleo.js', 'verify'],
    ]) {
      expect(isPausable('test-run', argv), argv.join(' ')).toBe(false);
      expect(isPausable('scoped-build', argv), argv.join(' ')).toBe(false);
    }
  });

  it('cleo as an argument, a path segment or a package name changes nothing', () => {
    for (const argv of [
      ['npx', 'vitest', 'run', 'packages/cleo/src/cli/__tests__/run-command.test.ts'],
      ['pnpm', '--filter', '@cleocode/cleo', 'run', 'build'],
      ['node', 'scripts/build.mjs', 'cleo'],
      ['node', '-e', 'require("cleo")'],
      ['tsc', '-p', 'packages/cleo'],
    ]) {
      expect(isPausable('scoped-build', argv), argv.join(' ')).toBe(true);
    }
  });
});

describe('round 7 (R7-2): one-shot commands are not watchers', () => {
  it('--version/--help and one-shot next/vite subcommands', () => {
    for (const argv of [
      ['next', 'info'],
      ['next', 'telemetry'],
      ['next', '--help'],
      ['vite', '--version'],
    ]) {
      expect(isWatchCommand(argv), argv.join(' ')).toBe(false);
      expect(looksHeavy(argv), argv.join(' ')).toBe(false);
    }
    for (const argv of [
      ['next', 'lint'],
      ['next', 'build'],
      ['vite', 'build'],
      ['vite', 'optimize'],
      ['vite', '-c', 'vite.config.ts', 'build'],
    ]) {
      expect(isWatchCommand(argv), argv.join(' ')).toBe(false);
      expect(looksHeavy(argv), argv.join(' ')).toBe(true);
      expect(resolveRunClass(undefined, argv, dir), argv.join(' ')).toBe('scoped-build');
    }
  });

  it('next with no subcommand, dev or start, and vite unless it builds, still serve', () => {
    for (const argv of [
      ['next'],
      ['next', 'dev'],
      ['next', 'start'],
      ['npx', 'next', 'dev', '-p', '3000'],
      ['vite'],
      ['vite', 'dev'],
      ['vite', 'serve'],
      ['vite', 'preview'],
      ['vite', '--port', '4000'],
      ['vite', 'build', '--watch'],
      ['vite', 'build', '-w'],
    ]) {
      expect(isWatchCommand(argv), argv.join(' ')).toBe(true);
      expect(looksHeavy(argv), argv.join(' ')).toBe(false);
    }
  });

  it('a short flag value is not a watch subcommand', () => {
    for (const argv of [
      ['pytest', '-k', 'dev'],
      ['jest', '-t', 'start'],
      ['npx', 'vitest', '-t', 'serve'],
      ['vitest', 'run', '-t', 'dev'],
      ['mocha', '-g', 'watch'],
      ['pnpm', 'test', '-t', 'serve'],
    ]) {
      expect(isWatchCommand(argv), argv.join(' ')).toBe(false);
      expect(looksHeavy(argv), argv.join(' ')).toBe(true);
      expect(resolveRunClass(undefined, argv, dir), argv.join(' ')).toBe('test-run');
    }
    expect(isWatchCommand(['tsc', '-p', 'dev'])).toBe(false);
    expect(looksHeavy(['tsc', '-p', 'dev'])).toBe(true);
  });

  it('a real watch subcommand still counts', () => {
    for (const argv of [
      ['vitest', 'watch'],
      ['npx', 'vitest', '-t', 'x', 'dev'],
      ['webpack', 'serve'],
      ['cargo', 'watch'],
      ['pnpm', 'test', 'watch'],
      ['pnpm', 'dev', '--help'], // a script passes --help on to what it runs
    ]) {
      expect(isWatchCommand(argv), argv.join(' ')).toBe(true);
      expect(looksHeavy(argv), argv.join(' ')).toBe(false);
    }
  });

  it('-w is watch only for tools where it means --watch', () => {
    for (const argv of [
      ['npx', 'prettier', '-w', '.'],
      ['gofmt', '-w', '.'],
    ]) {
      expect(isWatchCommand(argv), argv.join(' ')).toBe(false);
      expect(looksHeavy(argv), argv.join(' ')).toBe(false);
    }
    expect(isWatchCommand(['jest', '-w', '2'])).toBe(false);
    for (const argv of [
      ['tsc', '-w'],
      ['rollup', '-c', '-w'],
      ['webpack', '-w'],
      ['vitest', '-w'],
      ['mocha', '-w'],
      ['sass', '-w', 'in.scss:out.css'],
      ['npx', 'tailwindcss', '-i', 'in.css', '-w'],
    ]) {
      expect(isWatchCommand(argv), argv.join(' ')).toBe(true);
    }
  });

  it('esbuild --serve serves', () => {
    expect(isWatchCommand(['esbuild', 'app.ts', '--serve'])).toBe(true);
    expect(isWatchCommand(['esbuild', 'app.ts', '--bundle', '--serve=8000'])).toBe(true);
    expect(looksHeavy(['esbuild', 'app.ts', '--serve=8000'])).toBe(false);
    expect(looksHeavy(['esbuild', 'app.ts', '--bundle'])).toBe(true);
  });
});

describe('namedTestFileCount (T13132)', () => {
  it('counts the test files a test run names', () => {
    expect(namedTestFileCount('test-run', ['pnpm', 'exec', 'vitest', 'run', 'src/a.test.ts'])).toBe(
      1,
    );
    expect(
      namedTestFileCount('test-run', [
        'npx',
        'vitest',
        'run',
        'a.spec.mjs',
        'b.test.tsx',
        '-t',
        'x',
      ]),
    ).toBe(2);
  });

  it('is null for a whole suite, a filter, or a run that is not a test run', () => {
    expect(namedTestFileCount('test-run', ['pnpm', 'test'])).toBeNull();
    expect(namedTestFileCount('test-run', ['npx', 'vitest', 'run', 'governor'])).toBeNull();
    expect(namedTestFileCount('scoped-build', ['tsc', 'a.test.ts'])).toBeNull();
  });

  it('skips the value of --exclude and gives up on a glob (#1865 LOW-3)', () => {
    expect(namedTestFileCount('test-run', ['vitest', 'run', '--exclude', 'a.test.ts'])).toBeNull();
    expect(
      namedTestFileCount('test-run', ['vitest', 'run', 'b.test.ts', '--exclude', 'a.test.ts']),
    ).toBe(1);
    expect(namedTestFileCount('test-run', ['vitest', 'run', 'src/**/*.test.ts'])).toBeNull();
  });
});

describe('isWholeSuiteTestRun (T13236)', () => {
  let pkgDir: string;
  beforeEach(() => {
    pkgDir = mkdtempSync(join(tmpdir(), 'cleo-whole-suite-'));
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'vitest run',
          'test:pkg': 'vitest run --project',
          'test:cleo': 'cd ../.. && vitest run packages/cleo/src',
          'test:node': 'node --test',
          'test:changed': 'pnpm --filter "...[HEAD~1]" run test',
        },
      }),
    );
  });
  afterEach(() => rmSync(pkgDir, { recursive: true, force: true }));

  it.each([
    [['vitest', 'run']],
    [['pnpm', 'exec', 'vitest', 'run']],
    [['npx', 'vitest', 'run']],
    [['pnpm', 'vitest', 'run']],
    [['pnpm', '--filter', '@cleocode/core', 'exec', 'vitest', 'run']],
    [['pnpm', 'exec', 'vitest', 'run', '--reporter', 'json']],
    [['pnpm', 'exec', 'vitest', 'run', '--reporter=json', '--maxWorkers', '2']],
    [['vitest', 'run', '--exclude', 'a.test.ts']],
    [['vitest', 'run', '--', '--silent']],
    // The quoted empty list and the current directory narrow nothing (#1897 review MED).
    [['pnpm', 'exec', 'vitest', 'run', '']],
    [['pnpm', 'exec', 'vitest', 'run', '   ']],
    [['pnpm', 'exec', 'vitest', 'run', '.']],
    [['pnpm', 'exec', 'vitest', 'run', './']],
    [['pnpm', 'exec', 'vitest', 'run', '', '--reporter', 'dot']],
    [['vitest', 'run', '-t', '']],
    [['vitest', 'run', '--project=']],
    // Package scripts that run vitest, with nothing narrowing them.
    [['pnpm', 'test']],
    [['pnpm', 'run', 'test']],
    [['pnpm', '-r', 'test']],
    [['pnpm', '--filter', '@cleocode/core', 'test']],
    [['npm', 'test']],
    [['pnpm', 'test', '']],
    [['pnpm', 'run', 'test:cleo']],
    [['pnpm', 'test:pkg']],
    // T13277: a script that delegates to `pnpm --filter <git selector> run test`
    // is followed; the git selector matches a superset, whose `test` runs vitest.
    [['pnpm', 'run', 'test:changed']],
  ])('%j is the whole suite', (argv) => {
    expect(isWholeSuiteTestRun(argv, pkgDir)).toBe(true);
  });

  it.each([
    [['vitest', 'run', 'src/a.test.ts']],
    [['pnpm', 'exec', 'vitest', 'run', 'src/cloud']],
    [['vitest', 'run', '--project', 'core']],
    [['vitest', 'run', '--project=core']],
    [['vitest', 'run', '-t', 'parses']],
    [['vitest', 'run', '--testNamePattern=parses']],
    [['vitest', 'run', '--changed']],
    [['vitest', 'related', 'src/a.ts']],
    [['vitest', 'list']],
    [['vitest', 'run', '--reporter', 'json', 'src/a.test.ts']],
    [['vitest', 'run', '--unknown-flag', 'value']],
    [['pnpm', 'test', 'src/a.test.ts']],
    [['pnpm', '--filter', '@cleocode/core', 'test', 'src/a.test.ts']],
    [['pnpm', 'test', '--', '-t', 'parses']],
    [['pnpm', 'test:pkg', '@cleocode/core']],
    [['pnpm', 'run', 'test:node']],
    [['pnpm', 'run', 'no-such-script']],
    [['tsc', '-b']],
    [['jest']],
  ])('%j is narrowed or not a vitest run', (argv) => {
    expect(isWholeSuiteTestRun(argv, pkgDir)).toBe(false);
  });

  it('a script with no package.json up the tree is not refused', () => {
    const bare = mkdtempSync(join(tmpdir(), 'cleo-no-pkg-'));
    try {
      expect(isWholeSuiteTestRun(['pnpm', 'test'], bare)).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('isWholeSuiteTestRun across a workspace (T13277)', () => {
  let ws: string;
  const write = (rel: string, body: string): void => {
    mkdirSync(join(ws, rel, '..'), { recursive: true });
    writeFileSync(join(ws, rel), body);
  };
  const pkg = (rel: string, name: string, test: string): void =>
    write(join(rel, 'package.json'), JSON.stringify({ name, scripts: { test } }));

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'cleo-whole-suite-ws-'));
    // A root whose `test` delegates, a vitest package and a non-vitest one.
    write('package.json', JSON.stringify({ name: 'root', scripts: { test: 'pnpm -r test' } }));
    write('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n  # comment\n  - tools/cli\n');
    pkg('packages/a', '@x/a', 'vitest run');
    pkg('packages/b', '@x/b', 'node --test');
    pkg('tools/cli', '@x/cli', 'cd ../.. && vitest run tools/cli/src');
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it.each([
    [['pnpm', '-r', 'test']],
    [['pnpm', 'test']], // the root delegates to `pnpm -r test`
    [['pnpm', '--filter', '@x/a', 'test']],
    [['pnpm', '--filter=@x/a', 'run', 'test']],
    [['pnpm', '-F', '@x/cli', 'test']],
    [['pnpm', '--filter', '@x/*', 'test']],
    [['pnpm', '--filter', './packages/a', 'test']],
    [['pnpm', '--filter', '{packages/a}', 'test']],
    [['pnpm', '--filter', '@x/b...', 'test']], // a graph selector: a superset
    [['pnpm', '--filter', '...[HEAD~1]', 'test']], // a git selector: a superset
    [['pnpm', '--filter', '@x/b', '--filter', '@x/a', 'test']],
    [['pnpm', '-C', 'packages/a', 'test']],
  ])('%j is the whole suite', (argv) => {
    expect(isWholeSuiteTestRun(argv, ws)).toBe(true);
  });

  it.each([
    [['pnpm', '--filter', '@x/b', 'test']],
    [['pnpm', '--filter', './packages/b', 'test']],
    [['pnpm', '--filter', '!@x/a', 'test']],
    [['pnpm', '--filter', '@x/nope', 'test']],
    [['pnpm', '--filter', '@x/a', 'test', 'src/a.test.ts']],
    [['pnpm', '-r', 'test', '--', '-t', 'parses']],
    [['pnpm', '-C', 'packages/b', 'test']],
  ])('%j is narrowed or runs no vitest suite', (argv) => {
    expect(isWholeSuiteTestRun(argv, ws)).toBe(false);
  });

  it('a workspace whose packages run no vitest is not refused, even recursively', () => {
    pkg('packages/a', '@x/a', 'node --test');
    pkg('tools/cli', '@x/cli', 'node --test');
    expect(isWholeSuiteTestRun(['pnpm', '-r', 'test'], ws)).toBe(false);
    expect(isWholeSuiteTestRun(['pnpm', 'test'], ws)).toBe(false);
  });

  it('npm/yarn `workspaces` globs are read when there is no pnpm-workspace.yaml', () => {
    rmSync(join(ws, 'pnpm-workspace.yaml'));
    write(
      'package.json',
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
        scripts: { test: 'node --test' },
      }),
    );
    expect(isWholeSuiteTestRun(['pnpm', '-r', 'test'], ws)).toBe(true);
    expect(isWholeSuiteTestRun(['pnpm', '--filter', '@x/b', 'test'], ws)).toBe(false);
  });

  it('a malformed package.json is skipped, not trusted', () => {
    write('packages/a/package.json', '{ not json');
    expect(isWholeSuiteTestRun(['pnpm', '--filter', '@x/a', 'test'], ws)).toBe(false);
  });
});
