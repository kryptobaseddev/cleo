/**
 * `cleo init` / `cleo upgrade` injection at a project rooted at the home
 * directory is skipped with a clear reason (T13257): providers load
 * AGENTS.md / CLAUDE.md from every ancestor directory, so a file at `$HOME`
 * would reach every session under it. HOME is sandboxed.
 *
 * @task T13257
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureInjection } from '../injection.js';

let root: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  root = mkdtempSync(join(tmpdir(), 'cleo-injection-home-'));
  home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

describe('ensureInjection at $HOME (T13257)', () => {
  it('is skipped with the reason, writing no AGENTS.md or provider file', async () => {
    const r = await ensureInjection(home);
    expect(r.action).toBe('skipped');
    expect(r.details).toMatch(/the project is your home directory/);
    expect(r.details).toMatch(/Run cleo init inside a project directory/);
    expect(existsSync(join(home, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(home, 'CLAUDE.md'))).toBe(false);
  });
});
