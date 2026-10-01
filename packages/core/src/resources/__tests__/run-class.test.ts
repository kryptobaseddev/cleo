/**
 * The dependency-free command recognizer (T12979; #1777 round 3 add-ons for
 * the T12983 hook): only the command word counts; --version/--help and
 * watch/dev/serve modes are never heavy.
 *
 * @task T12979
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandTarget, isPausable, looksHeavy, resolveRunClass } from '../run-class.js';

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
