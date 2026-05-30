/**
 * Tests for scripts/lint-no-crate-publish.mjs (T11389 · E2 · SG-PACKAGE-ARCH).
 *
 * @task T11389
 * @saga T11387
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectCargoToml, scanCratePublish } from '../lint-no-crate-publish.mjs';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-no-crate-publish.mjs');

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-crate-publish-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeCrate(name, toml) {
  const dir = join(root, 'crates', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Cargo.toml'), toml, 'utf8');
}

describe('inspectCargoToml', () => {
  it('detects publish = false in [package]', () => {
    expect(inspectCargoToml('[package]\nname = "x"\npublish = false\n')).toEqual({
      name: 'x',
      publishFalse: true,
    });
  });

  it('reports publishFalse:false when the key is absent', () => {
    expect(inspectCargoToml('[package]\nname = "x"\n')).toEqual({ name: 'x', publishFalse: false });
  });

  it('does not treat a publish key in a later table as the package key', () => {
    const toml = '[package]\nname = "x"\n\n[other]\npublish = false\n';
    expect(inspectCargoToml(toml)).toEqual({ name: 'x', publishFalse: false });
  });
});

describe('scanCratePublish', () => {
  it('passes when every crate declares publish = false', () => {
    writeCrate('a', '[package]\nname = "a"\npublish = false\n');
    writeCrate('b', '[package]\nname = "b"\npublish = false\n[lib]\n');
    expect(scanCratePublish(root)).toEqual([]);
  });

  it('flags a crate that omits publish (Cargo default = publishable)', () => {
    writeCrate('a', '[package]\nname = "a"\npublish = false\n');
    writeCrate('leaky', '[package]\nname = "leaky"\n');
    expect(scanCratePublish(root)).toEqual(['crates/leaky:leaky']);
  });

  it('flags a crate that sets publish = true', () => {
    writeCrate('pub', '[package]\nname = "pub"\npublish = true\n');
    expect(scanCratePublish(root)).toEqual(['crates/pub:pub']);
  });
});

describe('integration: real repo tree', () => {
  it('every committed crate declares publish = false (exit 0)', () => {
    const res = spawnSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/zero crates\.io/);
  });
});
