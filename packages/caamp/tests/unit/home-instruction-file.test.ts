/**
 * A project rooted at the home directory gets no provider instruction file
 * (T13227, #1898 review): providers load CLAUDE.md / AGENTS.md / GEMINI.md
 * from the working directory up through every ancestor, so a file at `$HOME`
 * reaches every session under it. HOME is sandboxed; the real one is never
 * touched.
 *
 * @task T13227
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureAllProviderInstructionFiles,
  ensureProviderInstructionFile,
  HomeInstructionFileError,
} from '../../src/core/instructions/injector.js';

let root: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  root = mkdtempSync(join(tmpdir(), 'caamp-home-instr-'));
  home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const options = { references: [], content: ['fixture'] };

describe('provider instruction files are refused at a $HOME project (T13227)', () => {
  it.each([
    ['claude-code', 'CLAUDE.md'],
    ['codex', 'AGENTS.md'],
    ['gemini-cli', 'GEMINI.md'],
  ])('%s: %s at $HOME is refused and not created', async (providerId, file) => {
    await expect(ensureProviderInstructionFile(providerId, home, options)).rejects.toBeInstanceOf(
      HomeInstructionFileError,
    );
    expect(existsSync(join(home, file))).toBe(false);
  });

  it('ensureAllProviderInstructionFiles refuses too, writing nothing', async () => {
    await expect(
      ensureAllProviderInstructionFiles(['claude-code', 'codex'], home, options),
    ).rejects.toBeInstanceOf(HomeInstructionFileError);
    expect(existsSync(join(home, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(home, 'AGENTS.md'))).toBe(false);
  });

  it('a differently cased spelling of $HOME is refused on a case-insensitive volume', async (ctx) => {
    const variant = join(root, 'HOME');
    if (!existsSync(variant)) ctx.skip();
    await expect(ensureProviderInstructionFile('codex', variant, options)).rejects.toBeInstanceOf(
      HomeInstructionFileError,
    );
    expect(existsSync(join(home, 'AGENTS.md'))).toBe(false);
  });

  it('a project below $HOME still gets its instruction file', async () => {
    const project = join(home, 'projects', 'app');
    mkdirSync(project, { recursive: true });
    const r = await ensureProviderInstructionFile('codex', project, options);
    expect(r.filePath).toBe(join(project, 'AGENTS.md'));
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
  });
});
