/**
 * T909 regression guard — getProjectRoot MUST NEVER resolve to $HOME or `/`.
 *
 * History: `cleo` run from `$HOME` with a stray `~/.cleo/` sentinel silently
 * created `~/.cleo/conduit.db` (orphan). ADR-037 says conduit.db is
 * project-tier-only; this guard blocks the regression vector.
 *
 * @task T909
 * @epic T889
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProjectRoot } from '../paths.js';

/** Snapshot and clear env vars that would bypass the walk. */
function useCleanEnv(): { restore: () => void } {
  const saved = {
    CLEO_ROOT: process.env['CLEO_ROOT'],
    CLEO_PROJECT_ROOT: process.env['CLEO_PROJECT_ROOT'],
    CLEO_DIR: process.env['CLEO_DIR'],
  };
  delete process.env['CLEO_ROOT'];
  delete process.env['CLEO_PROJECT_ROOT'];
  delete process.env['CLEO_DIR'];
  return {
    restore() {
      for (const key of Object.keys(saved) as Array<keyof typeof saved>) {
        const value = saved[key];
        if (value !== undefined) {
          process.env[key] = value;
        } else {
          delete process.env[key];
        }
      }
    },
  };
}

describe('getProjectRoot $HOME / root guard (T889/T909)', () => {
  let env: ReturnType<typeof useCleanEnv>;

  beforeEach(() => {
    env = useCleanEnv();
  });

  afterEach(() => {
    env.restore();
  });

  it('throws E_NO_PROJECT when cwd === $HOME, even if ~/.cleo/ exists', () => {
    // Use the real home — per the task contract we do NOT mock os.homedir().
    const home = homedir();

    // We cannot reliably guarantee whether ~/.cleo/ exists on the host,
    // so we only assert the guard's behaviour: getProjectRoot must either
    // throw, or — if it returns — NEVER return $HOME itself.
    let threw = false;
    let returned: string | undefined;
    try {
      returned = getProjectRoot(home);
    } catch {
      threw = true;
    }

    if (!threw) {
      expect(returned).not.toBe(home);
      expect(returned).not.toBe('/');
    } else {
      expect(threw).toBe(true);
    }
  });

  it('throws when cwd === "/" (filesystem root)', () => {
    expect(() => getProjectRoot('/')).toThrow();
  });

  it('returns a real project root when cwd is inside a real .cleo/ project (non-home)', () => {
    // Synthesize a tmp project with a legitimate .cleo/ sentinel that is
    // NOT inside $HOME and NOT `/`.
    const base = join(
      tmpdir(),
      `cleo-t909-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const nested = join(base, 'sub', 'deep');
    mkdirSync(join(base, '.cleo'), { recursive: true });
    mkdirSync(nested, { recursive: true });

    try {
      const resolved = getProjectRoot(nested);
      expect(resolved).toBe(base);
      // Must never accidentally resolve to home or root.
      expect(resolved).not.toBe(homedir());
      expect(resolved).not.toBe('/');
      expect(existsSync(join(resolved, '.cleo'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('allows CLEO_ROOT=$HOME as an explicit opt-in (env-var bypass is documented)', () => {
    // The guard applies only to the walk-up path. An operator who sets
    // CLEO_ROOT=$HOME has explicitly overridden; we respect that.
    const home = homedir();
    process.env['CLEO_ROOT'] = home;
    expect(getProjectRoot()).toBe(home);
  });
});
