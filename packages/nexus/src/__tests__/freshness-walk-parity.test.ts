/**
 * T12348 — the freshness walk must see exactly the files the index walk sees.
 *
 * `cleo nexus status` spent 60 s of a 107 s run in `git check-ignore` and 10 s
 * in `fs.glob`'s serial directory reads plus a synchronous nested-repository
 * probe per directory. A freshness walk (`knownFiles` given) now reads
 * directories in parallel and asks git only about files the manifest does not
 * know. That is safe only if both traversals produce the same file set, so this
 * test drives a real `git` over a tree with every shape the glob traversal
 * treats specially: dot entries, default-excluded directories, nested
 * repositories, root and nested ignore files with negation, `.git/info/exclude`,
 * and a symbolic link to a file.
 *
 * @task T12348
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type KnownFileFingerprint,
  type ScannedFile,
  walkRepositoryPaths,
} from '../pipeline/filesystem-walker.js';

let repo = '';

/** Write a file, creating its parent directories. */
function put(relPath: string, content = 'export const x = 1;\n'): void {
  const full = join(repo, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'nexus-freshness-walk-'));
  execFileSync('git', ['init', '--quiet'], { cwd: repo });
  put('.gitignore', 'ignored/\n*.log\n');
  put('src/a.ts');
  put('src/deep/b.ts');
  put('src/app.log');
  put('src/.hidden.ts');
  put('.dotdir/c.ts');
  put('ignored/d.ts');
  put('node_modules/pkg/e.ts');
  put('dist/f.js');
  put('sub/.gitignore', 'local.ts\n!keep.log\n');
  put('sub/local.ts');
  put('sub/keep.log');
  put('sub/g.ts');
  put('info-excluded.ts');
  put('.git/info/exclude', 'info-excluded.ts\n');
  put('nested/n.ts');
  mkdirSync(join(repo, 'nested', '.git'));
  put('target/top.ts');
  put('target/inner/t.ts');
  symlinkSync(join(repo, 'src', 'a.ts'), join(repo, 'src', 'linkfile.ts'));
  // Dangling links and links to directories are deliberately absent: the index
  // walk already rejects on both (a failed stat, and `git check-ignore`'s
  // "beyond a symbolic link"), which predates T12348, so there is no
  // successful index walk to compare against.
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Stable comparison key: path, size and content hash. */
const identity = (files: readonly ScannedFile[]): string[] =>
  files.map((file) => `${file.path} ${file.size} ${file.contentHash}`);

describe('freshness walk parity (T12348)', () => {
  it('yields the same files as the index walk, whether or not files are known', async () => {
    const indexWalk = await walkRepositoryPaths(repo);
    const coldFreshness = await walkRepositoryPaths(repo, undefined, undefined, [], {
      knownFiles: new Map(),
    });
    const known = new Map<string, KnownFileFingerprint>(
      indexWalk.map((file) => [
        file.path,
        { size: file.size, mtimeMs: file.mtimeMs ?? 0, contentHash: file.contentHash ?? '' },
      ]),
    );
    const hashed: string[] = [];
    const warmFreshness = await walkRepositoryPaths(repo, undefined, undefined, [], {
      knownFiles: known,
      onHashed: (path) => hashed.push(path),
    });

    expect(indexWalk.map((file) => file.path)).toEqual([
      'src/a.ts',
      'src/deep/b.ts',
      'src/linkfile.ts',
      'sub/g.ts',
      'sub/keep.log',
    ]);
    expect(identity(coldFreshness)).toEqual(identity(indexWalk));
    expect(identity(warmFreshness)).toEqual(identity(indexWalk));
    // Unchanged metadata reuses the recorded hash instead of reading the file.
    expect(hashed).toEqual([]);
  });

  it('includes an explicitly included nested repository in both walks', async () => {
    const indexWalk = await walkRepositoryPaths(repo, undefined, undefined, ['nested']);
    const freshness = await walkRepositoryPaths(repo, undefined, undefined, ['nested'], {
      knownFiles: new Map(),
    });
    expect(indexWalk.map((file) => file.path)).toContain('nested/n.ts');
    expect(identity(freshness)).toEqual(identity(indexWalk));
  });
});
