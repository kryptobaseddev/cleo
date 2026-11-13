/**
 * T14549 — `cleo doctor --fix` on a repository git cannot read refuses the
 * untrack repair instead of reporting a clean index. Runs the real dispatch
 * the command uses (`mutate admin health {mode: 'repair'}`), unmocked, on a
 * scratch project whose git index is corrupt.
 *
 * @task T14549
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FixResult } from '@cleocode/core/system/health';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchRaw } from '../adapters/cli.js';

let isolatedRoot: string;
let project: string;
let origCwd: string;

beforeEach(() => {
  isolatedRoot = mkdtempSync(join(tmpdir(), 'cleo-t14549-fix-'));
  const home = join(isolatedRoot, 'home');
  for (const [name, dir] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    CLEO_HOME: join(isolatedRoot, 'cleo'),
    XDG_DATA_HOME: join(isolatedRoot, 'data-home'),
    XDG_CONFIG_HOME: join(isolatedRoot, 'config-home'),
    XDG_CACHE_HOME: join(isolatedRoot, 'cache-home'),
    AGENTS_HOME: join(isolatedRoot, 'agents'),
  })) {
    mkdirSync(dir, { recursive: true });
    vi.stubEnv(name, dir);
  }
  project = join(isolatedRoot, 'project');
  mkdirSync(join(project, '.cleo'), { recursive: true });
  writeFileSync(join(project, '.cleo', 'config.json'), '{}\n');
  execFileSync('git', ['init', '-q'], { cwd: project });
  execFileSync('git', ['add', '-f', '--', '.cleo/config.json'], { cwd: project });
  // The index git keeps for this checkout is now unreadable.
  writeFileSync(join(project, '.git', 'index'), 'not an index');
  vi.stubEnv('CLEO_ROOT', project);
  vi.stubEnv('CLEO_DIR', join(project, '.cleo'));
  origCwd = process.cwd();
  process.chdir(project);
});

afterEach(() => {
  process.chdir(origCwd);
  vi.unstubAllEnvs();
  rmSync(isolatedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('T14549: cleo doctor --fix on an unreadable git index', () => {
  it('reaches the untrack fixer through the real dispatch and refuses', async () => {
    const response = await dispatchRaw('mutate', 'admin', 'health', { mode: 'repair' });
    expect(response.success).toBe(true);
    const results = response.data as FixResult[];
    const untrack = results.find((r) => r.check === 'tracked_cleo_runtime');
    expect(untrack?.action).toBe('failed');
    expect(untrack?.message).toContain('nothing was untracked');
  }, 120_000);
});
