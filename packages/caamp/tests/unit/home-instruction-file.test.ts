/**
 * A project rooted at the home directory gets no provider instruction file
 * (T13227, #1898 review): providers load CLAUDE.md / AGENTS.md / GEMINI.md
 * from the working directory up through every ancestor, so a file at `$HOME`
 * reaches every session under it. HOME is sandboxed; the real one is never
 * touched.
 *
 * @task T13227
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { vi } from 'vitest';
import { registerInstructionsInject } from '../../src/commands/instructions/inject.js';
import { registerInstructionsUpdate } from '../../src/commands/instructions/update.js';
import {
  ensureAllProviderInstructionFiles,
  ensureProviderInstructionFile,
  HomeInstructionFileError,
  inject,
  injectAll,
} from '../../src/core/instructions/injector.js';
import { getProvider } from '../../src/core/registry/providers.js';
import type { Provider } from '../../src/types.js';

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

describe('injectAll and the caamp instructions commands refuse a $HOME project (T13257)', () => {
  const providers = (): Provider[] =>
    ['claude-code', 'codex'].map((id) => getProvider(id)).filter((p): p is Provider => p !== undefined);

  it('injectAll (project scope) at $HOME throws HomeInstructionFileError and writes nothing', async () => {
    await expect(injectAll(providers(), home, 'project', 'fixture')).rejects.toBeInstanceOf(
      HomeInstructionFileError,
    );
    expect(existsSync(join(home, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(home, 'AGENTS.md'))).toBe(false);
  });

  it('injectAll below $HOME still writes', async () => {
    const project = join(home, 'p');
    mkdirSync(project, { recursive: true });
    const r = await injectAll(providers(), project, 'project', 'fixture');
    expect([...r.keys()].sort()).toEqual([join(project, 'AGENTS.md'), join(project, 'CLAUDE.md')]);
  });

  it('the ~/.agents hub write is untouched by the refusal', async () => {
    const hub = join(home, '.agents', 'AGENTS.md');
    mkdirSync(join(home, '.agents'), { recursive: true });
    expect(await inject(hub, 'hub content')).toBe('created');
    expect(readFileSync(hub, 'utf-8')).toContain('hub content');
  });

  it.each([
    ['inject', registerInstructionsInject, ['inject', '--agent', 'codex', '--json']],
    ['update', registerInstructionsUpdate, ['update', '--json']],
  ] as const)('caamp instructions %s in $HOME refuses with the remedy, writing nothing', async (_n, register, argv) => {
    vi.spyOn(process, 'cwd').mockReturnValue(home);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      out.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      out.push(String(line));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const program = new Command();
    register(program);
    try {
      await expect(program.parseAsync(['node', 'caamp', ...argv])).rejects.toThrow('exit 1');
      const text = out.join('\n');
      expect(text).toContain('E_HOME_INSTRUCTION_FILE');
      expect(text).toContain('--global');
      expect(existsSync(join(home, 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(home, 'CLAUDE.md'))).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

