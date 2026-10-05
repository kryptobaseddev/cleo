/**
 * The Claude Code adapter never writes the user-global Claude config (T13227).
 *
 * `ClaudeCodeAdapter.initialize` (native hooks), the install provider (plugin
 * + PreCompact hook templates) and `dispose` (hook removal) all write the
 * PROJECT's `.claude/` only. Every case runs in a sandbox: `HOME`,
 * `CLAUDE_HOME` and `CLAUDE_SETTINGS` point into a throwaway dir, and the
 * user-global dir there is snapshotted (bytes + mtime of every file) before
 * and compared after. The real `~/.claude` is never read.
 *
 * @task T13227
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// initialize() asks the `cleo` binary for the spawn mode; never run a real one.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') callback(new Error('cleo not available in test'));
    },
  };
});

import { ClaudeCodeAdapter } from '../adapter.js';
import { ClaudeCodeHookProvider, NATIVE_STOP_HOOK_COMMAND } from '../hooks.js';
import { ClaudeCodeInstallProvider } from '../install.js';

/** Every file under `dir`, as path → bytes + mtime. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf-8' })) {
    const path = join(dir, name);
    const st = statSync(path);
    out[name] = st.isDirectory()
      ? `dir@${st.mtimeMs}`
      : `${readFileSync(path, 'base64')}@${st.mtimeMs}`;
  }
  return out;
}

/** What a user's own global Claude config holds. */
const USER_SETTINGS = JSON.stringify(
  {
    model: 'opus',
    enabledPlugins: { 'other@market': true },
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-stop.sh' }] }] },
  },
  null,
  2,
);

const SAVED = ['HOME', 'USERPROFILE', 'CLAUDE_HOME', 'CLAUDE_SETTINGS'] as const;
let saved: Record<string, string | undefined>;
let root: string;
let home: string;
let claudeHome: string;
let projectDir: string;

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  root = mkdtempSync(join(tmpdir(), 'cleo-claude-global-'));
  home = join(root, 'home');
  claudeHome = join(home, '.claude');
  projectDir = join(root, 'project');
  mkdirSync(join(claudeHome, 'hooks'), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(claudeHome, 'settings.json'), USER_SETTINGS);
  writeFileSync(join(claudeHome, 'hooks', 'mine.sh'), '#!/bin/sh\n');
  execFileSync('git', ['init', '-q', projectDir]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_HOME = claudeHome;
  delete process.env.CLAUDE_SETTINGS;
  mkdirSync(join(home, '.cleo', 'templates'), { recursive: true });
  writeFileSync(join(home, '.cleo', 'templates', 'CLEO-INJECTION.md'), 'Fixture protocol.');
});

afterEach(() => {
  for (const k of SAVED) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Run every adapter writer for `dir`: initialize, install, dispose. */
async function runAllWriters(dir: string): Promise<{
  adapter: ClaudeCodeAdapter;
  install: Awaited<ReturnType<ClaudeCodeInstallProvider['install']>>;
}> {
  const adapter = new ClaudeCodeAdapter();
  await adapter.initialize(dir);
  const install = await new ClaudeCodeInstallProvider().install({ projectDir: dir });
  await adapter.dispose();
  return { adapter, install };
}

describe('Claude Code adapter never writes the user-global Claude config (T13227)', () => {
  it('initialize + install + dispose leave CLAUDE_HOME byte-identical and write the project', async () => {
    const before = snapshot(claudeHome);
    const adapter = new ClaudeCodeAdapter();

    await adapter.initialize(projectDir);
    const local = join(projectDir, '.claude', 'settings.local.json');
    const afterInit = JSON.parse(readFileSync(local, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(afterInit.hooks.Stop?.[0]?.hooks[0]?.command).toBe(NATIVE_STOP_HOOK_COMMAND);
    expect(afterInit.hooks.PostToolUse?.[0]?.hooks).toHaveLength(2);

    const result = await new ClaudeCodeInstallProvider().install({ projectDir });
    expect(result.success).toBe(true);
    const afterInstall = JSON.parse(readFileSync(local, 'utf-8')) as {
      enabledPlugins: Record<string, boolean>;
      hooks: Record<string, unknown[]>;
    };
    expect(afterInstall.enabledPlugins['cleo@cleocode']).toBe(true);
    expect(afterInstall.hooks.PreCompact).toHaveLength(1);
    expect(existsSync(join(projectDir, '.claude', 'hooks', 'precompact-safestop.sh'))).toBe(true);

    await adapter.dispose();

    expect(snapshot(claudeHome)).toEqual(before);
    expect(readFileSync(join(claudeHome, 'settings.json'), 'utf-8')).toBe(USER_SETTINGS);
    // The per-machine files are kept out of git.
    const exclude = readFileSync(join(projectDir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('/.claude/settings.local.json');
    expect(exclude).toContain('/.claude/hooks/precompact-safestop.sh');
  });

  it('a project that is the home directory is refused: nothing written, steps skipped', async () => {
    const before = snapshot(claudeHome);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const hooks = new ClaudeCodeHookProvider();
    await hooks.registerNativeHooks(home);
    const { install } = await runAllWriters(home);

    expect(snapshot(claudeHome)).toEqual(before);
    expect(hooks.getSettingsError()).toMatch(
      /refusing to write .*the project is the home directory/,
    );
    expect(install.details?.plugin).toBe('skipped');
    expect(install.details?.hookTemplates).toBe('skipped');
    // ~/CLAUDE.md is loaded into every session under $HOME (#1898 review MED).
    expect(install.details?.instructionFile).toBe('skipped');
    expect(existsSync(join(home, 'CLAUDE.md'))).toBe(false);
    await expect(new ClaudeCodeInstallProvider().ensureInstructionReferences(home)).rejects.toThrow(
      /the project is the home directory/,
    );
    expect(existsSync(join(home, 'CLAUDE.md'))).toBe(false);
    expect(stderr).toHaveBeenCalled();
  });

  it('the home directory is refused even when CLAUDE_HOME points elsewhere', async () => {
    process.env.CLAUDE_HOME = join(root, 'elsewhere', '.claude');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const before = snapshot(join(home, '.claude'));

    const { install } = await runAllWriters(home);

    expect(snapshot(join(home, '.claude'))).toEqual(before);
    expect(install.details?.instructionFile).toBe('skipped');
    expect(existsSync(join(home, 'CLAUDE.md'))).toBe(false);
    expect(install.details?.plugin).toBe('skipped');
    expect(install.details?.commands).toBe('skipped');
  });

  it('CLAUDE_HOME pointing at the project .claude is refused: nothing written', async () => {
    const projectClaude = join(projectDir, '.claude');
    mkdirSync(projectClaude, { recursive: true });
    writeFileSync(join(projectClaude, 'settings.json'), USER_SETTINGS);
    process.env.CLAUDE_HOME = projectClaude;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const before = snapshot(projectClaude);

    const { install } = await runAllWriters(projectDir);

    expect(snapshot(projectClaude)).toEqual(before);
    expect(install.details?.plugin).toBe('skipped');
    expect(install.details?.hookTemplates).toBe('skipped');
  });

  it('the Claude dir itself as the project is refused, CLAUDE.md included', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const before = snapshot(claudeHome);

    const { install } = await runAllWriters(claudeHome);

    expect(snapshot(claudeHome)).toEqual(before);
    expect(install.details?.instructionFile).toBe('skipped');
    expect(install.details?.commands).toBe('skipped');
    await expect(
      new ClaudeCodeInstallProvider().ensureInstructionReferences(claudeHome),
    ).rejects.toThrow(/inside the user-global Claude config dir/);
    expect(existsSync(join(claudeHome, 'CLAUDE.md'))).toBe(false);
  });

  it('a differently cased spelling of the Claude dir is refused on a case-insensitive volume', async (ctx) => {
    const variant = join(home, '.CLAUDE');
    // Only meaningful where the volume folds case (default APFS / NTFS).
    if (!existsSync(variant)) ctx.skip();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const before = snapshot(claudeHome);

    const hooks = new ClaudeCodeHookProvider();
    await hooks.registerNativeHooks(variant);
    const { install } = await runAllWriters(variant);

    expect(snapshot(claudeHome)).toEqual(before);
    expect(hooks.getSettingsError()).toMatch(/inside the user-global Claude config dir/);
    expect(install.details?.instructionFile).toBe('skipped');
    expect(install.details?.plugin).toBe('skipped');
    expect(install.details?.hookTemplates).toBe('skipped');
    expect(install.details?.commands).toBe('skipped');
  });

  it('a differently cased spelling of the home directory is refused on a case-insensitive volume', async (ctx) => {
    const variant = home.replace(/home$/, 'HOME');
    if (!existsSync(variant)) ctx.skip();
    process.env.CLAUDE_HOME = join(root, 'elsewhere', '.claude');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const before = snapshot(claudeHome);

    const { install } = await runAllWriters(variant);

    expect(snapshot(claudeHome)).toEqual(before);
    expect(install.details?.plugin).toBe('skipped');
  });

  it('CLAUDE_SETTINGS naming the project settings.local.json is refused: nothing written', async () => {
    const local = join(projectDir, '.claude', 'settings.local.json');
    process.env.CLAUDE_SETTINGS = local;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const before = snapshot(claudeHome);

    const { install } = await runAllWriters(projectDir);

    expect(existsSync(local)).toBe(false);
    expect(snapshot(claudeHome)).toEqual(before);
    expect(install.details?.plugin).toBe('skipped');
  });

  it('dispose removes only the native hook objects; the heavy-command and user hooks stay', async () => {
    const local = join(projectDir, '.claude', 'settings.local.json');
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    const heavy = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'cleo hook heavy-command # cleo-hook', timeout: 20 }],
    };
    writeFileSync(
      local,
      JSON.stringify({
        hooks: {
          PreToolUse: [heavy],
          Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-stop.sh' }] }],
        },
      }),
    );
    const adapter = new ClaudeCodeAdapter();

    await adapter.initialize(projectDir);
    // Wired beside the heavy-command hook (which is not a native hook).
    expect(readFileSync(local, 'utf-8')).toContain(JSON.stringify(NATIVE_STOP_HOOK_COMMAND));
    await adapter.dispose();

    const after = JSON.parse(readFileSync(local, 'utf-8')) as { hooks: Record<string, unknown> };
    expect(after.hooks).toEqual({
      PreToolUse: [heavy],
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-stop.sh' }] }],
    });
  });
});
