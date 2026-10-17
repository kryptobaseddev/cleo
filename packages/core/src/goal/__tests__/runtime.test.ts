/**
 * Goal runtime detection for `cleo go` (T13821): OpenCode-Goal is found by its
 * `ocg` binary or the plugin in an OpenCode config; when missing, the install
 * commands come back, never run.
 *
 * @task T13821
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectGoalRuntime, goalRuntimeHandoff, OCG_RELEASE_TAG } from '../runtime.js';

let root: string;
let home: string;
let bin: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'cleo-goal-runtime-'));
  root = join(base, 'project');
  home = join(base, 'home');
  bin = join(base, 'bin');
  for (const d of [root, home, bin]) mkdirSync(d, { recursive: true });
});

afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
});

describe('detectGoalRuntime (T13821)', () => {
  it('missing: returns the pinned install commands and the next step, runs nothing', () => {
    const rt = detectGoalRuntime(root, { PATH: bin, HOME: home });
    expect(rt.installed).toBe(false);
    expect(rt.install).toEqual([
      `opencode plugin add "github:kryptobaseddev/opencode-goal#${OCG_RELEASE_TAG}"`,
      'opencode reload',
    ]);
    expect(goalRuntimeHandoff(rt, 't1').next).toMatch(
      /not installed.*then in OpenCode run: \/goal start t1$/,
    );
  });

  it('found by the ocg binary on PATH', () => {
    writeFileSync(join(bin, 'ocg'), '#!/bin/sh\n');
    chmodSync(join(bin, 'ocg'), 0o755);
    const rt = detectGoalRuntime(root, { PATH: bin, HOME: home });
    expect(rt).toMatchObject({ installed: true, via: 'path' });
    expect(goalRuntimeHandoff(rt, 't1').next).toBe('In OpenCode, run: /goal start t1');
  });

  it('found by the plugin in an OpenCode config (project or user)', () => {
    writeFileSync(
      join(root, 'opencode.json'),
      JSON.stringify({ plugin: ['github:kryptobaseddev/opencode-goal#v0.5.1'] }),
    );
    expect(detectGoalRuntime(root, { PATH: bin, HOME: home })).toMatchObject({
      installed: true,
      via: 'opencode-config',
    });
    rmSync(join(root, 'opencode.json'));
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'opencode', 'opencode.json'),
      '{"plugin":["opencode-goal"]}',
    );
    expect(detectGoalRuntime(root, { PATH: bin, HOME: home }).installed).toBe(true);
  });
});
