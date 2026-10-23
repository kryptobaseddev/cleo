/**
 * A git hook's measured peak, keyed by repository and real hook content
 * (T13921, review of #2386).
 *
 * @task T13921
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOOK_MIN_RUNS,
  HOOK_MIN_SAMPLES,
  hookFootprintKey,
  readHookPeak,
  recordHookPeak,
} from '../hook-footprint.js';

const GIB = 1024 ** 3;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-t13921-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fresh repository with `hook` installed as `.git/hooks/<name>`. */
function repo(name: string, hook?: string): string {
  const dir = join(root, name);
  execFileSync('git', ['init', '-q', dir]);
  if (hook !== undefined) {
    const path = join(dir, '.git', 'hooks', 'pre-push');
    writeFileSync(path, hook);
    chmodSync(path, 0o755);
  }
  return dir;
}

/** Record `n` counted runs. */
async function runs(key: string, peak: number, n: number, dir: string): Promise<void> {
  for (let i = 0; i < n; i++) await recordHookPeak(key, peak, HOOK_MIN_SAMPLES, dir, i);
}

describe('hook keys (T13921)', () => {
  it('cover the repository and the hook content: an edit or another repo is a new key', () => {
    const a = repo('a', '#!/bin/sh\npnpm typecheck\n');
    const b = repo('b', '#!/bin/sh\npnpm typecheck\n');
    expect(hookFootprintKey(repo('none'), 'pre-push')).toBeNull(); // no hook file
    const first = hookFootprintKey(a, 'pre-push');
    expect(first).toMatch(/^pre-push:[0-9a-f]{64}$/);
    // The same script in another repository never shares a measurement.
    expect(hookFootprintKey(b, 'pre-push')).not.toBe(first);
    writeFileSync(join(a, '.git', 'hooks', 'pre-push'), '#!/bin/sh\npnpm test\n');
    expect(hookFootprintKey(a, 'pre-push')).not.toBe(first);
  });

  it('a husky shim is keyed by the real .husky script; a missing one is never measured', () => {
    const shim = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n# husky\n';
    const dir = repo('husky', shim);
    // No .husky/pre-push and no package.json: the real script is unknown.
    expect(hookFootprintKey(dir, 'pre-push')).toBeNull();
    mkdirSync(join(dir, '.husky'));
    writeFileSync(join(dir, '.husky', 'pre-push'), 'pnpm typecheck\n');
    const light = hookFootprintKey(dir, 'pre-push');
    expect(light).not.toBeNull();
    writeFileSync(join(dir, '.husky', 'pre-push'), 'pnpm test\n');
    expect(hookFootprintKey(dir, 'pre-push')).not.toBe(light);
  });

  it('a lefthook shim is keyed by its config; without one it is never measured', () => {
    const dir = repo('lefthook', '#!/bin/sh\nlefthook run "pre-push" "$@"\n');
    expect(hookFootprintKey(dir, 'pre-push')).toBeNull();
    writeFileSync(join(dir, 'lefthook.yml'), 'pre-push:\n  commands:\n    t:\n      run: pnpm t\n');
    const first = hookFootprintKey(dir, 'pre-push');
    expect(first).not.toBeNull();
    writeFileSync(join(dir, 'lefthook.yml'), 'pre-push:\n  commands:\n    b:\n      run: pnpm b\n');
    expect(hookFootprintKey(dir, 'pre-push')).not.toBe(first);
  });
});

describe('hook switches and provisional charges (T13972)', () => {
  it('folds hook-disabling environment variables into the key', () => {
    const dir = repo('env', '#!/bin/sh\npnpm typecheck\n');
    const full = hookFootprintKey(dir, 'pre-push', [], {});
    expect(hookFootprintKey(dir, 'pre-push', [], { HUSKY: '0' })).not.toBe(full);
    expect(hookFootprintKey(dir, 'pre-push', [], { LEFTHOOK: '0' })).not.toBe(full);
    expect(hookFootprintKey(dir, 'pre-push', [], { UNRELATED: '1' })).toBe(full);
  });

  it('a plain hook that runs package scripts is keyed by package.json too (T13974)', () => {
    const dir = repo('scripts', '#!/bin/sh\npnpm typecheck\n');
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"typecheck":"tsc --noEmit"}}');
    const first = hookFootprintKey(dir, 'pre-push', [], {});
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"typecheck":"tsc -b"}}');
    expect(hookFootprintKey(dir, 'pre-push', [], {})).not.toBe(first);
  });

  it('one run above the charge restores the plan until enough runs again', async () => {
    const dir = join(root, 'admission');
    await runs('k', GIB, HOOK_MIN_RUNS, dir);
    expect(readHookPeak('k', dir)).toBe(GIB);
    await runs('k', 4 * GIB, 1, dir); // above GIB * margin: provisional charge revoked
    expect(readHookPeak('k', dir)).toBeNull();
    await runs('k', GIB, HOOK_MIN_RUNS - 1, dir);
    expect(readHookPeak('k', dir)).toBe(4 * GIB);
  });
});

describe('hook measurements (T13921)', () => {
  it('charge after enough counted runs, keep the largest peak, skip short runs', async () => {
    const dir = join(root, 'admission');
    await recordHookPeak('k', 9 * GIB, HOOK_MIN_SAMPLES - 1, dir); // too short to count
    await runs('k', 3 * GIB, HOOK_MIN_RUNS - 1, dir);
    expect(readHookPeak('k', dir)).toBeNull();
    await runs('k', GIB, 1, dir); // a light run never lowers it
    expect(readHookPeak('k', dir)).toBe(3 * GIB);
    await recordHookPeak('k', 0, HOOK_MIN_SAMPLES, dir);
    expect(readHookPeak('k', dir)).toBe(3 * GIB);
  });

  it('a corrupt file reads as not measured', async () => {
    const dir = join(root, 'admission');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hook-footprints.json'), '{not json');
    expect(readHookPeak('k', dir)).toBeNull();
    await runs('k', GIB, HOOK_MIN_RUNS, dir);
    expect(readHookPeak('k', dir)).toBe(GIB);
  });

  it('concurrent writers lose no run and no peak', async () => {
    const dir = join(root, 'admission');
    const peaks = [1, 2, 3, 4, 5, 6, 7, 8].map((g) => g * GIB);
    await Promise.all(peaks.map((p) => recordHookPeak('k', p, HOOK_MIN_SAMPLES, dir)));
    expect(readHookPeak('k', dir)).toBe(8 * GIB);
    const { readFileSync } = await import('node:fs');
    const doc = JSON.parse(readFileSync(join(dir, 'hook-footprints.json'), 'utf8'));
    expect(doc.k.runs).toBe(peaks.length);
  });
});
