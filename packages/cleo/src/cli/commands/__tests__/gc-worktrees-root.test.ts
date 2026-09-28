/**
 * `cleo gc worktrees` scans the platform CLEO data dir by default (T12602).
 *
 * The old default was `$XDG_DATA_HOME ?? ~/.local/share` + `cleo/worktrees`
 * on every OS. `cleo orchestrate spawn` provisions under `getCleoHome()`,
 * which is `~/Library/Application Support/cleo` on macOS, so gc scanned an
 * empty tree there and silently reported nothing.
 *
 * `CLEO_HOME` stands in for the platform data dir so the real one is never
 * touched; `XDG_DATA_HOME` points at an empty dir, which is what the old
 * resolver scanned.
 *
 * @task T12602
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const outputs = vi.hoisted((): unknown[] => []);

vi.mock('../../renderers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../renderers/index.js')>();
  return {
    ...actual,
    cliOutput: (data: unknown) => {
      outputs.push(data);
    },
  };
});

import { gcCommand } from '../gc.js';

interface GcWorktreesOutput {
  removed: number;
  removedPaths: string[];
  quarantined: number;
  quarantinedPaths: string[];
}

describe('cleo gc worktrees — default root (T12602)', () => {
  let cleoHome: string;
  let xdgData: string;

  beforeEach(() => {
    outputs.length = 0;
    cleoHome = mkdtempSync(join(tmpdir(), 'cleo-gc-home-'));
    xdgData = mkdtempSync(join(tmpdir(), 'cleo-gc-xdg-'));
    vi.stubEnv('CLEO_HOME', cleoHome);
    vi.stubEnv('XDG_DATA_HOME', xdgData);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cleoHome, { recursive: true, force: true });
    rmSync(xdgData, { recursive: true, force: true });
  });

  it('finds an orphan worktree under getCleoWorktreesRoot()', async () => {
    const orphan = join(cleoHome, 'worktrees', 'projhash01', 'T9002');
    mkdirSync(orphan, { recursive: true });
    mkdirSync(join(cleoHome, 'worktrees', 'projhash01', 'T9001'), { recursive: true });

    await runCommand(gcCommand, {
      rawArgs: ['worktrees', '--dry-run', '--preserve-tasks', 'T9001'],
    });

    expect(outputs).toHaveLength(1);
    const result = outputs[0] as GcWorktreesOutput;
    expect([...result.removedPaths, ...result.quarantinedPaths]).toEqual([orphan]);
  });
});
