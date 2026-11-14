/**
 * A git hook's measured peak, keyed by repository and real hook content
 * (T13921, review of #2386).
 *
 * @task T13921
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMAND_KEY_PREFIX,
  commandChargeKey,
  hookFootprintKey,
  MEASURED_MIN_RUNS,
  MEASURED_MIN_SAMPLES,
  MEASURED_WINDOW,
  prepareGitPushHook,
  readCountedPeak,
  readMeasuredPeak,
  recordRunPeak,
  scriptFootprint,
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
  for (let i = 0; i < n; i++) await recordRunPeak(key, peak, MEASURED_MIN_SAMPLES, dir, i);
}

describe('push hook admission (T14555)', () => {
  it('separates hook execution, preserving paths, arguments, stdin and a rejecting exit', () => {
    const project = repo("a quoted ' repository", '#!/bin/sh\nprintf "%s\\n" "$@"\ncat\nexit 12\n');
    const called = join(root, 'called.json');
    const runner = join(root, 'runner.cjs');
    writeFileSync(
      runner,
      `const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(called)}, JSON.stringify(args));
const at = args.indexOf('--');
const child = spawnSync(args[at + 1], args.slice(at + 2), { stdio: 'inherit' });
process.exit(child.status ?? 1);
`,
    );
    const prepared = prepareGitPushHook(['git', '-C', project, 'push'], root, [
      process.execPath,
      runner,
      'run',
      '--wait',
    ]);
    expect(prepared).not.toBeNull();
    if (prepared === null) throw new Error('expected a wrapped push');
    const config = prepared.argv.find((word) => word.startsWith('core.hooksPath='));
    if (config === undefined) throw new Error('expected temporary hooks directory');
    const temporary = config.slice('core.hooksPath='.length);
    try {
      const result = spawnSync(join(temporary, 'pre-push'), ['remote name', 'url with spaces'], {
        cwd: project,
        input: 'refs/heads/main abc refs/heads/main def\n',
        encoding: 'utf8',
      });
      expect(result.status).toBe(12);
      expect(result.stderr).toBe(
        'remote name\nurl with spaces\nrefs/heads/main abc refs/heads/main def\n',
      );
      expect(JSON.parse(readFileSync(called, 'utf8'))).toEqual([
        'run',
        '--wait',
        '--passthrough',
        '--class',
        'build',
        '--',
        'git',
        '-c',
        `core.hooksPath=${join(project, '.git', 'hooks')}`,
        'hook',
        'run',
        expect.stringMatching(/^--to-stdin=/),
        'pre-push',
        '--',
        'remote name',
        'url with spaces',
      ]);
    } finally {
      prepared.release();
    }
    expect(existsSync(temporary)).toBe(false);
  });

  it('leaves hook-free, skipped and command-running pushes on their existing admission path', () => {
    const project = repo('plain');
    expect(prepareGitPushHook(['git', 'push'], project, ['cleo'])).toBeNull();
    expect(prepareGitPushHook(['git', 'push', '--no-verify'], project, ['cleo'])).toBeNull();
    expect(
      prepareGitPushHook(['git', '-c', 'core.sshCommand=custom', 'push'], project, ['cleo']),
    ).toBeNull();
  });
});

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
    await runs('k', GIB, MEASURED_MIN_RUNS, dir);
    expect(readCountedPeak('k', dir)).toBe(GIB);
    await runs('k', 4 * GIB, 1, dir); // above GIB * margin: provisional charge revoked
    expect(readCountedPeak('k', dir)).toBeNull();
    await runs('k', GIB, MEASURED_MIN_RUNS - 1, dir);
    expect(readCountedPeak('k', dir)).toBe(4 * GIB);
  });
});

describe('hook measurements (T13921)', () => {
  it('charge after enough counted runs, keep the largest peak, skip short runs', async () => {
    const dir = join(root, 'admission');
    await recordRunPeak('k', 9 * GIB, MEASURED_MIN_SAMPLES - 1, dir); // too short to count
    await runs('k', 3 * GIB, MEASURED_MIN_RUNS - 1, dir);
    expect(readCountedPeak('k', dir)).toBeNull();
    await runs('k', GIB, 1, dir); // a light run never lowers it
    expect(readCountedPeak('k', dir)).toBe(3 * GIB);
    await recordRunPeak('k', 0, MEASURED_MIN_SAMPLES, dir);
    expect(readCountedPeak('k', dir)).toBe(3 * GIB);
  });

  it('a corrupt file reads as not measured', async () => {
    const dir = join(root, 'admission');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'charges.json'), '{not json');
    expect(readCountedPeak('k', dir)).toBeNull();
    await runs('k', GIB, MEASURED_MIN_RUNS, dir);
    expect(readCountedPeak('k', dir)).toBe(GIB);
  });

  it('concurrent writers lose no run and no peak', async () => {
    const dir = join(root, 'admission');
    // Peaks within the 25% margin of each other, so no run resets the count
    // (a run above the charge does, T13972).
    const peaks = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => GIB + i * 32 * 1024 ** 2);
    await Promise.all(peaks.map((p) => recordRunPeak('k', p, MEASURED_MIN_SAMPLES, dir)));
    expect(readCountedPeak('k', dir)).toBe(GIB + 7 * 32 * 1024 ** 2);
    const { readFileSync } = await import('node:fs');
    const doc = JSON.parse(readFileSync(join(dir, 'charges.json'), 'utf8'));
    expect(doc.k.runs).toBe(peaks.length);
  });
});

describe('a node script is keyed by its path and content, and names the heavy tool it loads (T14050)', () => {
  it('a script that builds a TypeScript program loads typescript; a plain one loads none', () => {
    mkdirSync(join(root, 'scripts', 'typecheck'), { recursive: true });
    const program = join('scripts', 'typecheck', 'full-program.cjs');
    writeFileSync(
      join(root, program),
      "const ts = require('typescript');\nts.createProgram(['a.ts'], {}).emit();\n",
    );
    writeFileSync(join(root, 'gen.mjs'), "import { writeFileSync } from 'node:fs';\n");
    writeFileSync(join(root, 'inline.mjs'), 'const p = api.createProgram (files, opts);\n');
    const heavy = scriptFootprint(root, program);
    expect(heavy?.heavyTool).toBe('typescript');
    expect(heavy?.key).toMatch(/^full-program\.cjs:[0-9a-f]{64}$/);
    expect(scriptFootprint(root, 'gen.mjs')?.heavyTool).toBeNull();
    expect(scriptFootprint(root, 'inline.mjs')?.heavyTool).toBe('typescript');
    // An edited script is measured afresh; an unreadable one is never measured.
    writeFileSync(join(root, program), "require('typescript');\n");
    expect(scriptFootprint(root, program)?.key).not.toBe(heavy?.key);
    expect(scriptFootprint(root, 'missing.mjs')).toBeNull();
  });
});

describe('one measured-charge store for every command (T14281)', () => {
  it('the charge is the largest of the last 10 counted peaks', async () => {
    const dir = join(root, 'run');
    await recordRunPeak('k', 3 * GIB, MEASURED_MIN_SAMPLES, dir, 0);
    for (let i = 1; i <= MEASURED_WINDOW; i++) {
      await recordRunPeak('k', 2.5 * GIB, MEASURED_MIN_SAMPLES, dir, i);
    }
    // The 3 GiB run left the window: ten 2.5 GiB runs remain.
    expect(readCountedPeak('k', dir)).toBe(2.5 * GIB);
  });

  it('a failed run above the charge resets the count; its excess raises the next charge', async () => {
    const dir = join(root, 'run');
    await runs('k', GIB, MEASURED_MIN_RUNS, dir);
    expect(readCountedPeak('k', dir)).toBe(GIB);
    await recordRunPeak('k', 4 * GIB, MEASURED_MIN_SAMPLES, dir, 10, false);
    expect(readCountedPeak('k', dir)).toBeNull();
    expect(readMeasuredPeak('k', dir)).toBe(4 * GIB);
  });

  it('the pre-T14281 hook store is read until the first write of the new one', async () => {
    const dir = join(root, 'run');
    mkdirSync(join(root, 'admission'), { recursive: true });
    writeFileSync(
      join(root, 'admission', 'hook-footprints.json'),
      JSON.stringify({ 'pre-push:abc': { peakBytes: 2 * GIB, runs: 3, measuredAtMs: 1 } }),
    );
    expect(readCountedPeak('pre-push:abc', dir)).toBe(2 * GIB);
    await recordRunPeak('other', GIB, MEASURED_MIN_SAMPLES, dir, 2);
    // Carried into charges.json by that write; the old file is no longer read.
    writeFileSync(join(root, 'admission', 'hook-footprints.json'), '{}');
    expect(readCountedPeak('pre-push:abc', dir)).toBe(2 * GIB);
  });

  it('a plain command is keyed by project and argv, leading assignments and padding ignored', () => {
    const key = commandChargeKey('/repo', ['pnpm', 'exec', 'tsc', '-b']);
    expect(key.startsWith(`${COMMAND_KEY_PREFIX}:`)).toBe(true);
    expect(commandChargeKey('/repo', ['FOO=1', 'pnpm', 'exec', ' tsc ', '-b'])).toBe(key);
    expect(commandChargeKey('/other', ['pnpm', 'exec', 'tsc', '-b'])).not.toBe(key);
    expect(commandChargeKey('/repo', ['pnpm', 'exec', 'tsc', '-p', 'a'])).not.toBe(key);
  });
});
