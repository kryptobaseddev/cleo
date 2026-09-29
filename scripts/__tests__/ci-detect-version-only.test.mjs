/**
 * Fixture tests for the version-only PR detector used by the `changes` job in
 * `.github/workflows/ci.yml`. A false POSITIVE here skips the unit tests on a
 * PR that changes behaviour, so most cases below pin the rejections.
 *
 * @task ci-speed-shards
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyChanges,
  classifyPath,
  isVersionOnlyPatch,
  parseNameStatus,
} from '../ci-detect-version-only.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../ci-detect-version-only.mjs');

const BUMP_PATCH = [
  'diff --git a/packages/core/package.json b/packages/core/package.json',
  '--- a/packages/core/package.json',
  '+++ b/packages/core/package.json',
  '@@ -3 +3 @@',
  '-  "version": "2026.9.22",',
  '+  "version": "2026.9.23",',
].join('\n');

describe('classifyPath', () => {
  it('recognises the three allowed path kinds', () => {
    expect(classifyPath('package.json')).toBe('package-json');
    expect(classifyPath('packages/core/package.json')).toBe('package-json');
    expect(classifyPath('CHANGELOG.md')).toBe('free');
    expect(classifyPath('packages/cleo/CHANGELOG.md')).toBe('free');
    expect(classifyPath('.changeset/foo.md')).toBe('free');
  });
  it('rejects everything else, including look-alikes', () => {
    expect(classifyPath('packages/core/src/index.ts')).toBeNull();
    expect(classifyPath('pnpm-lock.yaml')).toBeNull();
    expect(classifyPath('package.json.bak')).toBeNull();
    expect(classifyPath('docs/CHANGELOG.md.orig')).toBeNull();
    expect(classifyPath('x/.changeset/foo.md')).toBeNull();
  });
});

describe('isVersionOnlyPatch', () => {
  it('accepts a pure version bump', () => {
    expect(isVersionOnlyPatch(BUMP_PATCH)).toBe(true);
  });
  it('rejects a dependency change riding along with the bump', () => {
    const patch = `${BUMP_PATCH}\n@@ -20 +20 @@\n-    "zod": "^3.0.0",\n+    "zod": "^4.0.0",`;
    expect(isVersionOnlyPatch(patch)).toBe(false);
  });
  it('rejects a script change', () => {
    expect(isVersionOnlyPatch('@@ -5 +5 @@\n-    "build": "a",\n+    "build": "b",')).toBe(false);
  });
  it('rejects a nested "version" key that is not a plain string line', () => {
    expect(isVersionOnlyPatch('@@ -5 +5 @@\n-  "version": { "a": 1 },\n+  "version": 2,')).toBe(
      false,
    );
  });
  it('rejects an empty or binary patch', () => {
    expect(isVersionOnlyPatch('')).toBe(false);
    expect(isVersionOnlyPatch('Binary files a/package.json and b/package.json differ')).toBe(false);
  });
});

describe('parseNameStatus', () => {
  it('parses modifications, additions and renames from -z output', () => {
    const raw = [
      'M',
      'package.json',
      'R100',
      '.changeset/a.md',
      '.changeset/shipped/a.md',
      'A',
      'CHANGELOG.md',
      '',
    ].join('\0');
    expect(parseNameStatus(raw)).toEqual([
      { status: 'M', path: 'package.json' },
      { status: 'R', path: '.changeset/shipped/a.md', oldPath: '.changeset/a.md' },
      { status: 'A', path: 'CHANGELOG.md' },
    ]);
  });
});

describe('classifyChanges', () => {
  const patches = { 'package.json': BUMP_PATCH, 'packages/core/package.json': BUMP_PATCH };
  const patchFor = (path) => patches[path] ?? '';

  it('accepts the release bump-PR shape', () => {
    const result = classifyChanges(
      [
        { status: 'M', path: 'package.json' },
        { status: 'M', path: 'packages/core/package.json' },
        { status: 'M', path: 'CHANGELOG.md' },
        { status: 'D', path: '.changeset/foo.md' },
        { status: 'R', path: '.changeset/shipped/v1/bar.md', oldPath: '.changeset/bar.md' },
      ],
      patchFor,
    );
    expect(result.versionOnly).toBe(true);
  });
  it('rejects an empty diff', () => {
    expect(classifyChanges([], patchFor).versionOnly).toBe(false);
  });
  it('rejects any source file', () => {
    const result = classifyChanges(
      [
        { status: 'M', path: 'package.json' },
        { status: 'M', path: 'packages/core/src/index.ts' },
      ],
      patchFor,
    );
    expect(result.versionOnly).toBe(false);
    expect(result.reason).toContain('packages/core/src/index.ts');
  });
  it('rejects a rename out of .changeset/', () => {
    const result = classifyChanges(
      [{ status: 'R', path: 'packages/core/src/x.md', oldPath: '.changeset/x.md' }],
      patchFor,
    );
    expect(result.versionOnly).toBe(false);
  });
  it('rejects an added or deleted package.json', () => {
    expect(
      classifyChanges([{ status: 'A', path: 'packages/new/package.json' }], patchFor).versionOnly,
    ).toBe(false);
    expect(
      classifyChanges([{ status: 'D', path: 'packages/core/package.json' }], patchFor).versionOnly,
    ).toBe(false);
  });
  it('rejects a package.json whose patch has a non-version line', () => {
    const result = classifyChanges(
      [{ status: 'M', path: 'packages/x/package.json' }],
      () => '@@ -1 +1 @@\n-  "private": true,\n+  "private": false,',
    );
    expect(result.versionOnly).toBe(false);
  });
});

describe('end to end against a real git repository', () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'ci-version-only-'));
    const run = (...args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    run('init', '-q');
    run('config', 'user.email', 't@example.com');
    run('config', 'user.name', 't');
    mkdirSync(join(dir, 'packages/core/src'), { recursive: true });
    mkdirSync(join(dir, '.changeset'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      '{\n  "name": "root",\n  "version": "1.0.0",\n  "private": true\n}\n',
    );
    writeFileSync(
      join(dir, 'packages/core/package.json'),
      '{\n  "name": "core",\n  "version": "1.0.0"\n}\n',
    );
    writeFileSync(join(dir, 'packages/core/src/index.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, '.changeset/a.md'), '---\ncore: patch\n---\nfix\n');
    run('add', '-A');
    run('commit', '-qm', 'base');
    return { dir, run, base: run('rev-parse', 'HEAD') };
  }
  function detect(dir, base) {
    const r = spawnSync(process.execPath, [SCRIPT, base, 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: join(dir, '.gh-output') },
    });
    expect(r.status).toBe(0);
    return readFileSync(join(dir, '.gh-output'), 'utf8').trim();
  }

  it('reports true for a bump + changeset archive move', () => {
    const { dir, run, base } = repo();
    try {
      for (const file of ['package.json', 'packages/core/package.json']) {
        const path = join(dir, file);
        writeFileSync(path, readFileSync(path, 'utf8').replace('"1.0.0"', '"1.0.1"'));
      }
      mkdirSync(join(dir, '.changeset/shipped'), { recursive: true });
      run('mv', '.changeset/a.md', '.changeset/shipped/a.md');
      writeFileSync(join(dir, 'CHANGELOG.md'), '# 1.0.1\n- fix\n');
      run('add', '-A');
      run('commit', '-qm', 'bump');
      expect(detect(dir, base)).toBe('version_only=true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports false when a source file changes alongside the bump', () => {
    const { dir, run, base } = repo();
    try {
      const path = join(dir, 'package.json');
      writeFileSync(path, readFileSync(path, 'utf8').replace('"1.0.0"', '"1.0.1"'));
      writeFileSync(join(dir, 'packages/core/src/index.ts'), 'export const x = 2;\n');
      run('add', '-A');
      run('commit', '-qm', 'bump + code');
      expect(detect(dir, base)).toBe('version_only=false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports false, and still exits 0, on an unknown ref', () => {
    const { dir } = repo();
    try {
      expect(detect(dir, 'no-such-ref')).toBe('version_only=false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
