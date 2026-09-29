/**
 * Tests for scripts/native-source-hash.mjs — the SOURCE hash that stamps and
 * keys the cached native binaries the release bundles.
 *
 * Each property is proven in both directions: an input that reaches the
 * binary moves the hash, and an input that does not (the release's version
 * sync) leaves it alone — a hash that moved on everything would never hit the
 * cache, and one that moved on nothing would publish stale binaries.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeNativeSourceHash } from '../native-source-hash.mjs';

let root;

function write(rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function git(...args) {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

function commitAll() {
  git('add', '-A');
  git('commit', '-q', '-m', 'x', '--allow-empty');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'native-source-hash-'));
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('Cargo.lock', 'lock v1\n');
  write('Cargo.toml', '[workspace]\n');
  write('rust-toolchain.toml', '[toolchain]\nchannel = "1.94.0"\n');
  write('crates/cant-core/src/lib.rs', 'pub fn a() {}\n');
  write('crates/cant-napi/src/lib.rs', 'pub fn b() {}\n');
  write('crates/worktree-napi/src/lib.rs', 'pub fn c() {}\n');
  write('crates/worktrunk-core/src/lib.rs', 'pub fn d() {}\n');
  write(
    'crates/worktree-napi/package.json',
    JSON.stringify({ version: '1.0.0', napi: { binaryName: 'worktree-napi' } }),
  );
  write(
    'packages/cant/package.json',
    JSON.stringify({
      version: '1.0.0',
      scripts: { 'build:napi': 'napi build', test: 'vitest' },
      napi: { binaryName: 'cant' },
    }),
  );
  commitAll();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('computeNativeSourceHash', () => {
  it('is deterministic and differs per addon', () => {
    const cant = computeNativeSourceHash('cant', root);
    expect(cant).toMatch(/^[0-9a-f]{64}$/);
    expect(computeNativeSourceHash('cant', root)).toBe(cant);
    expect(computeNativeSourceHash('worktree', root)).not.toBe(cant);
  });

  it('moves when a crate source, Cargo.lock or the toolchain changes', () => {
    const before = computeNativeSourceHash('cant', root);
    write('crates/cant-core/src/lib.rs', 'pub fn a() { let _ = 1; }\n');
    commitAll();
    const afterSource = computeNativeSourceHash('cant', root);
    expect(afterSource).not.toBe(before);

    write('Cargo.lock', 'lock v2\n');
    commitAll();
    const afterLock = computeNativeSourceHash('cant', root);
    expect(afterLock).not.toBe(afterSource);

    write('rust-toolchain.toml', '[toolchain]\nchannel = "1.95.0"\n');
    commitAll();
    expect(computeNativeSourceHash('cant', root)).not.toBe(afterLock);
  });

  it('covers worktrunk-core, the path dependency of worktree-napi', () => {
    const before = computeNativeSourceHash('worktree', root);
    write('crates/worktrunk-core/src/lib.rs', 'pub fn d() { let _ = 2; }\n');
    commitAll();
    expect(computeNativeSourceHash('worktree', root)).not.toBe(before);
  });

  it('ignores the release version sync but not the napi build config', () => {
    const cant = computeNativeSourceHash('cant', root);
    const worktree = computeNativeSourceHash('worktree', root);

    for (const rel of ['packages/cant/package.json', 'crates/worktree-napi/package.json']) {
      const manifest = JSON.parse(readFileSync(join(root, rel), 'utf8'));
      manifest.version = '2.0.0';
      if (manifest.scripts) manifest.scripts.test = 'vitest run';
      write(rel, JSON.stringify(manifest));
    }
    commitAll();
    expect(computeNativeSourceHash('cant', root)).toBe(cant);
    expect(computeNativeSourceHash('worktree', root)).toBe(worktree);

    const cantManifest = JSON.parse(readFileSync(join(root, 'packages/cant/package.json'), 'utf8'));
    cantManifest.scripts['build:napi'] = 'napi build --release';
    write('packages/cant/package.json', JSON.stringify(cantManifest));
    commitAll();
    expect(computeNativeSourceHash('cant', root)).not.toBe(cant);
  });

  it('hashes committed content, not an uncommitted working-tree edit', () => {
    const before = computeNativeSourceHash('cant', root);
    write('crates/cant-napi/src/lib.rs', 'dirty\n');
    expect(computeNativeSourceHash('cant', root)).toBe(before);
  });

  it('rejects an unknown addon', () => {
    expect(() => computeNativeSourceHash('bogus', root)).toThrow(/unknown addon/);
  });
});
