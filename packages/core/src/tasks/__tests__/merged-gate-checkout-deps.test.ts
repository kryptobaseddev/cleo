/**
 * T14625: the merge-commit gate checkout printed by `mergedGateVerifyCommand`
 * must give every workspace package its dependencies, not only the root's.
 *
 * A pnpm workspace whose package `a` depends on workspace package `b`: pnpm
 * links `b` into `packages/a/node_modules` only. The printed command runs with
 * a stub `cleo` on PATH (`run` executes its command, `verify` records whether
 * `b` resolves from `packages/a` and whether the tree is clean and equal to
 * the merge tree).
 *
 * @task T14625
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergedGateVerifyCommand } from '../gate-runner.js';

let base: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cleo-t14625-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('mergedGateVerifyCommand dependency layout (T14625)', () => {
  it('gives each workspace package its own node_modules and keeps the merge tree clean', () => {
    const root = join(base, 'repo');
    write(join(root, 'package.json'), '{"name":"ws","private":true}\n');
    write(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    write(join(root, '.gitignore'), 'node_modules/\n.pnpm-store/\n');
    write(
      join(root, 'packages/a/package.json'),
      '{"name":"a","version":"1.0.0","private":true,"dependencies":{"b":"workspace:*"}}\n',
    );
    write(
      join(root, 'packages/b/package.json'),
      '{"name":"b","version":"1.0.0","private":true,"main":"index.js"}\n',
    );
    write(join(root, 'packages/b/index.js'), 'module.exports = 1;\n');
    execFileSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'ignore' });
    // The source checkout has deps installed: only its root node_modules could be linked.
    execFileSync('pnpm', ['install', '--offline'], { cwd: root, stdio: 'ignore' });
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '-A']);
    git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'merge']);
    const merge = git(root, ['rev-parse', 'HEAD']);

    const bin = join(base, 'bin');
    const report = join(base, 'report.json');
    write(
      join(bin, 'cleo'),
      [
        '#!/bin/sh',
        'if [ "$1" = run ]; then',
        '  while [ "$1" != -- ]; do shift; done; shift; exec "$@"',
        'fi',
        `resolves=$(cd packages/a && node -e "try{require.resolve('b');process.stdout.write('yes')}catch{process.stdout.write('no')}")`,
        'dirty=$(git status --porcelain --untracked-files=no)',
        'tree=$(git rev-parse HEAD^{tree})',
        `printf '{"resolves":"%s","dirty":"%s","tree":"%s"}' "$resolves" "$dirty" "$tree" > ${JSON.stringify(report)}`,
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'cleo'), 0o755);

    const command = mergedGateVerifyCommand('T1', root, merge);
    execFileSync('/bin/sh', ['-c', command], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, TMPDIR: base },
      stdio: 'ignore',
    });

    const result = JSON.parse(readFileSync(report, 'utf-8')) as {
      resolves: string;
      dirty: string;
      tree: string;
    };
    expect(result).toEqual({
      resolves: 'yes',
      dirty: '',
      tree: git(root, ['rev-parse', `${merge}^{tree}`]),
    });
  }, 60_000);
});
