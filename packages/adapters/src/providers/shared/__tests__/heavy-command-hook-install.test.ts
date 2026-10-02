/**
 * Tests for installing the heavy-command hook (T12983).
 *
 * Coverage:
 *   - the hook command line, under every shell present: starts no `cleo`
 *     unless a tool name appears as a whole word, prints only JSON, exits 0
 *     when `cleo` is missing, and asks an older CLEO only once (a marker keyed
 *     on the binary, invalidated by a newer binary)
 *   - JSON configs (Claude Code settings.local.json, Codex hooks.json):
 *     install, idempotency, refresh of a stale hook, user hooks untouched even
 *     inside CLEO's matcher group, `off` removes only CLEO's hook, duplicates
 *     collapse, a malformed file is never rewritten
 *   - the opencode plugin: write, idempotency, `off` deletes it, and the
 *     generated module applies the hook's rewrite
 *   - installer wiring: Claude Code writes the project settings.local.json
 *     and removes an earlier entry from settings.json (never the user's
 *     settings), Codex and opencode install only when a mode is passed, the
 *     home directory is skipped
 *
 * Every write goes to a temp directory; HOME and CLAUDE_HOME point there too.
 *
 * @task T12983
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeInstallProvider } from '../../claude-code/install.js';
import { CodexInstallProvider } from '../../codex/install.js';
import { OpenCodeInstallProvider } from '../../opencode/install.js';
import {
  clearOlderCleoMarkers,
  excludeLocalSettingsFromGit,
  HEAVY_COMMAND_HOOK_TIMEOUT_SEC,
  heavyCommandHookCommand,
  heavyCommandHookEntry,
  heavyCommandHookObject,
  isUserHomeDir,
  LOCAL_SETTINGS_EXCLUDE_MARKER,
  OLDER_CLEO_HOOK_ANSWER,
  OLDER_CLEO_MARKER_PREFIX,
  OPENCODE_HEAVY_COMMAND_PLUGIN,
  syncJsonHeavyCommandHook,
  syncOpencodeHeavyCommandPlugin,
} from '../heavy-command-hook-install.js';

let dir: string;
let bin: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_HOME',
  'CLAUDE_SETTINGS',
  'CLEO_HOME',
  'PATH',
] as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-heavy-hook-install-'));
  bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const home = join(dir, 'home');
  mkdirSync(join(home, '.cleo', 'templates'), { recursive: true });
  writeFileSync(join(home, '.cleo', 'templates', 'CLEO-INJECTION.md'), 'fixture\n');
  process.env.CLEO_HOME = join(home, '.cleo');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_HOME = join(home, '.claude');
  delete process.env.CLAUDE_SETTINGS;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A fake `cleo` on PATH running `script` (a POSIX sh body). */
function fakeCleo(script: string): void {
  writeFileSync(join(bin, 'cleo'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, 'cleo'), 0o755);
}

/**
 * Shells to run the hook line under: Claude Code uses `sh -c` (bash on macOS,
 * dash on Debian/Ubuntu), Codex the user's login shell (often zsh).
 */
const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash', '/bin/zsh'].filter((s) => existsSync(s));

/**
 * Run a hook command line the way a harness does: `<shell> -c`, JSON on
 * stdin. `TMPDIR` (where the older-CLEO marker lives) is the test's temp dir;
 * a fake `cleo` appends to `$CALLS` each time it starts.
 */
function runHookLine(
  line: string,
  stdin: string,
  shell = '/bin/sh',
  cwd = dir,
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(shell, ['-c', line], {
      input: stdin,
      cwd,
      encoding: 'utf-8',
      env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: dir, CALLS: join(dir, 'calls') },
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? -1 };
  }
}

/** A shell-tool payload as Claude Code sends it. */
const payload = (command: string, description = 'run it'): string =>
  JSON.stringify({ tool_name: 'Bash', tool_input: { command, description } });

/** How many times the fake `cleo` started. */
const calls = (): number =>
  existsSync(join(dir, 'calls'))
    ? readFileSync(join(dir, 'calls'), 'utf-8').split('\n').length - 1
    : 0;

describe.each(SHELLS)('heavyCommandHookCommand under %s', (shell) => {
  const run = (line: string, stdin: string, cwd = dir) => runHookLine(line, stdin, shell, cwd);

  it('starts no cleo when no tool name appears as a whole word', () => {
    fakeCleo('echo x >> "$CALLS"; cat');
    for (const command of [
      'ls -la',
      'cat test-notes.md',
      'git commit -m "fix the build and install steps"',
      'grep -rn testing src',
      'cleo show T1',
    ]) {
      expect(run(heavyCommandHookCommand('claude-code'), payload(command, 'x')), command).toEqual({
        stdout: '',
        status: 0,
      });
    }
    expect(calls()).toBe(0);
  });

  it('passes a call naming a tool to cleo hook heavy-command and prints its JSON answer', () => {
    fakeCleo(
      'echo x >> "$CALLS"\n[ "$1 $2 $3 $4" = "hook heavy-command --provider codex" ] || exit 9\ncat',
    );
    for (const command of [
      'pnpm test',
      './node_modules/.bin/vitest run a.test.ts',
      'echo \'"quoted"\' && cargo build',
      'cd pkg\nnpx tsc --noEmit',
    ]) {
      const stdin = payload(command);
      expect(run(heavyCommandHookCommand('codex'), stdin), command).toEqual({
        stdout: `${stdin}\n`,
        status: 0,
      });
    }
    expect(calls()).toBe(4);
  });

  it('sends every kind of heavy command run-class knows on to cleo', () => {
    fakeCleo('echo x >> "$CALLS"; cat > /dev/null');
    const heavy = [
      'vitest run',
      'npx jest',
      'pnpm exec tsc -b',
      'turbo run build',
      'nx run-many -t build',
      'cargo test',
      'go test ./...',
      'pytest -x',
      'bun test',
      'yarn build',
      'npm ci',
      'biome check .',
      'eslint .',
      'next build',
      'vite build',
      'webpack',
      'rollup -c',
      'esbuild src/x.ts',
      'tsup',
      'playwright test',
      'mocha',
      'svelte-check',
      'ava',
      'tap',
      'rspec',
      'phpunit',
      'pnpx vitest',
      'bunx tsc',
    ];
    for (const command of heavy) run(heavyCommandHookCommand('claude-code'), payload(command, 'x'));
    expect(calls()).toBe(heavy.length);
  });

  it('exits 0 and prints nothing when cleo is missing', () => {
    expect(run(heavyCommandHookCommand('claude-code'), payload('pnpm test'))).toEqual({
      stdout: '',
      status: 0,
    });
  });

  it('an older cleo is asked once; later calls start no cleo until the binary changes', () => {
    // What 2026.10.1 does with `cleo hook`: "Unknown command hook" on stderr, exit 127.
    fakeCleo('echo x >> "$CALLS"\ncat > /dev/null\necho "Unknown command hook" >&2\nexit 127');
    const heavy = payload('pnpm vitest run a.test.ts');
    for (let i = 0; i < 3; i++) {
      const r = run(heavyCommandHookCommand('claude-code'), heavy);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(JSON.parse(OLDER_CLEO_HOOK_ANSWER));
    }
    expect(calls()).toBe(1);
    // A call with no tool word stays silent and free, even for an older cleo.
    expect(run(heavyCommandHookCommand('claude-code'), payload('ls')).stdout).toBe('');
    // Reinstalling cleo (a binary newer than the marker) invalidates the marker.
    const marker = () => readdirSync(dir).filter((n) => n.startsWith(OLDER_CLEO_MARKER_PREFIX));
    const now = Date.now() / 1000;
    for (const m of marker()) utimesSync(join(dir, m), now - 120, now - 120);
    utimesSync(join(bin, 'cleo'), now - 60, now - 60);
    run(heavyCommandHookCommand('claude-code'), heavy);
    expect(calls()).toBe(2);
    run(heavyCommandHookCommand('claude-code'), heavy);
    expect(calls()).toBe(2);
    // Another directory may resolve another cleo (a mise shim): asked again there.
    const other = join(dir, 'other-project');
    mkdirSync(other);
    run(heavyCommandHookCommand('claude-code'), heavy, other);
    expect(calls()).toBe(3);
    // A marker older than an hour lapses.
    const markers = marker();
    expect(markers.length).toBe(2);
    const hoursAgo = Date.now() / 1000 - 2 * 3600;
    for (const m of markers) utimesSync(join(dir, m), hoursAgo, hoursAgo);
    utimesSync(join(bin, 'cleo'), hoursAgo - 60, hoursAgo - 60);
    run(heavyCommandHookCommand('claude-code'), heavy);
    expect(calls()).toBe(4);
    // A newer CLEO installing the hook clears every marker.
    expect(clearOlderCleoMarkers(dir)).toBe(2);
    expect(readdirSync(dir).some((n) => n.startsWith(OLDER_CLEO_MARKER_PREFIX))).toBe(false);
  });

  it('a current cleo that crashes or is killed fails open and is asked again next time', () => {
    // As jetsam / the OOM killer would: SIGKILL mid-hook (exit 137), or another failure.
    for (const body of [
      'kill -9 $$',
      'echo "boom" >&2; exit 1',
      'echo "env: node: No such file" >&2; exit 127',
    ]) {
      rmSync(join(dir, 'calls'), { force: true });
      fakeCleo(`echo x >> "$CALLS"\ncat > /dev/null\n${body}`);
      for (let i = 0; i < 3; i++) {
        expect(run(heavyCommandHookCommand('claude-code'), payload('pnpm test')), body).toEqual({
          stdout: '',
          status: 0,
        });
      }
      expect(calls(), body).toBe(3);
      expect(
        readdirSync(dir).some((n) => n.startsWith(OLDER_CLEO_MARKER_PREFIX)),
        body,
      ).toBe(false);
    }
  });

  it('never follows a symlink planted at the marker path', () => {
    fakeCleo('echo x >> "$CALLS"\ncat > /dev/null\necho "Unknown command hook" >&2\nexit 127');
    run(heavyCommandHookCommand('claude-code'), payload('pnpm test'));
    const [name] = readdirSync(dir).filter((n) => n.startsWith(OLDER_CLEO_MARKER_PREFIX));
    expect(name).toBeDefined();
    const marker = join(dir, name as string);
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'keep me\n');
    rmSync(marker);
    symlinkSync(victim, marker);
    // A symlink is never taken as the cache, and replacing it leaves its target alone.
    run(heavyCommandHookCommand('claude-code'), payload('pnpm test'));
    expect(calls()).toBe(2);
    expect(readFileSync(victim, 'utf-8')).toBe('keep me\n');
    expect(lstatSync(marker).isSymbolicLink()).toBe(false);
  });

  it('matches a backslash with [\\] rather than \\\\ (fish keeps \\\\ in single quotes)', () => {
    for (const provider of ['claude-code', 'codex'] as const) {
      const line = heavyCommandHookCommand(provider);
      expect(line).toContain('s/[\\][nrt]/ /g');
      expect(line).not.toContain('\\\\');
    }
  });

  it('never forwards output that is not a JSON object', () => {
    fakeCleo('cat > /dev/null\necho "cleo 2026.9.1"');
    expect(run(heavyCommandHookCommand('claude-code'), payload('pnpm test'))).toEqual({
      stdout: '',
      status: 0,
    });
  });

  it('carries the cleo-hook marker; the Codex line hands the script to /bin/sh', () => {
    expect(heavyCommandHookCommand('claude-code')).toMatch(/^command -v cleo .* # cleo-hook$/);
    expect(heavyCommandHookCommand('codex')).toMatch(
      /^\/bin\/sh -c 'command -v cleo .*' # cleo-hook$/,
    );
  });
});

describe('syncJsonHeavyCommandHook', () => {
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf-8'));

  it('creates the file with one PreToolUse/Bash entry, then is idempotent', async () => {
    const path = join(dir, 'project', '.claude', 'settings.json');
    expect(await syncJsonHeavyCommandHook(path, 'claude-code', 'rewrite')).toBe('installed');
    const before = readFileSync(path, 'utf-8');
    expect(read(path)).toEqual({ hooks: { PreToolUse: [heavyCommandHookEntry('claude-code')] } });
    expect(read(path).hooks.PreToolUse[0].hooks[0].timeout).toBe(HEAVY_COMMAND_HOOK_TIMEOUT_SEC);
    expect(await syncJsonHeavyCommandHook(path, 'claude-code', 'warn')).toBe('unchanged');
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('keeps user settings and hooks, and refreshes a stale CLEO entry in place', async () => {
    const path = join(dir, 'hooks.json');
    const user = { matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] };
    const stale = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'cleo hook heavy-command # cleo-hook' }],
    };
    writeFileSync(path, JSON.stringify({ model: 'x', hooks: { PreToolUse: [user, stale] } }));
    expect(await syncJsonHeavyCommandHook(path, 'codex', 'rewrite')).toBe('updated');
    expect(read(path)).toEqual({
      model: 'x',
      hooks: { PreToolUse: [user, heavyCommandHookEntry('codex')] },
    });
  });

  it('off removes only the heavy-command entry', async () => {
    const path = join(dir, 'settings.json');
    const user = { matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] };
    const precompact = {
      matcher: '',
      hooks: [{ type: 'command', command: '"/x/precompact-safestop.sh" # cleo-hook' }],
    };
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          PreToolUse: [user, heavyCommandHookEntry('claude-code')],
          PreCompact: [precompact],
        },
      }),
    );
    expect(await syncJsonHeavyCommandHook(path, 'claude-code', 'off')).toBe('removed');
    expect(read(path)).toEqual({ hooks: { PreToolUse: [user], PreCompact: [precompact] } });
    expect(await syncJsonHeavyCommandHook(path, 'claude-code', 'off')).toBe('unchanged');
    expect(await syncJsonHeavyCommandHook(join(dir, 'missing.json'), 'codex', 'off')).toBe(
      'unchanged',
    );
    expect(existsSync(join(dir, 'missing.json'))).toBe(false);
  });

  it('keeps a user hook that shares the matcher group with CLEO on refresh and off', async () => {
    const path = join(dir, 'settings.local.json');
    const userHook = { type: 'command', command: './audit.sh' };
    const staleCleo = { type: 'command', command: 'cleo hook heavy-command # cleo-hook' };
    writeFileSync(
      path,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [userHook, staleCleo] }] },
      }),
    );
    expect(await syncJsonHeavyCommandHook(path, 'claude-code', 'rewrite')).toBe('updated');
    expect(read(path).hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [userHook, heavyCommandHookObject('claude-code')] },
    ]);
    expect(await syncJsonHeavyCommandHook(path, 'claude-code', 'rewrite')).toBe('unchanged');
    expect(await syncJsonHeavyCommandHook(path, 'claude-code', 'off')).toBe('removed');
    expect(read(path).hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [userHook] }]);
  });

  it('drops duplicate CLEO hooks and keeps one', async () => {
    const path = join(dir, 'hooks.json');
    const dup = heavyCommandHookEntry('codex');
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [dup, dup] } }));
    expect(await syncJsonHeavyCommandHook(path, 'codex', 'rewrite')).toBe('updated');
    expect(read(path).hooks.PreToolUse).toEqual([heavyCommandHookEntry('codex')]);
  });

  it('refuses a malformed file and leaves it untouched', async () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{ not json');
    await expect(syncJsonHeavyCommandHook(path, 'claude-code', 'rewrite')).rejects.toThrow();
    expect(readFileSync(path, 'utf-8')).toBe('{ not json');
  });
});

describe('syncOpencodeHeavyCommandPlugin', () => {
  it('writes the plugin once, and off deletes it', () => {
    const project = join(dir, 'project');
    const plugin = join(project, '.opencode', 'plugins', OPENCODE_HEAVY_COMMAND_PLUGIN);
    expect(syncOpencodeHeavyCommandPlugin(project, 'rewrite')).toBe('installed');
    expect(syncOpencodeHeavyCommandPlugin(project, 'rewrite')).toBe('unchanged');
    writeFileSync(plugin, '// edited');
    expect(syncOpencodeHeavyCommandPlugin(project, 'warn')).toBe('updated');
    expect(syncOpencodeHeavyCommandPlugin(project, 'off')).toBe('removed');
    expect(existsSync(plugin)).toBe(false);
    expect(syncOpencodeHeavyCommandPlugin(project, 'off')).toBe('unchanged');
  });

  it('generates a module that applies the rewrite and timeout, and appends the context', async () => {
    const project = join(dir, 'project');
    syncOpencodeHeavyCommandPlugin(project, 'rewrite');
    const mjs = join(dir, 'plugin.mjs');
    copyFileSync(join(project, '.opencode', 'plugins', OPENCODE_HEAVY_COMMAND_PLUGIN), mjs);
    const answer = {
      command: 'cleo run --wait --passthrough --class test -- pnpm test',
      timeout: 240_000,
      context: '[cleo] routed',
    };
    fakeCleo(
      `echo x >> "${join(dir, 'calls')}"\ncat > /dev/null\necho '${JSON.stringify(answer)}'`,
    );
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    type Input = { tool: string; callID?: string };
    const mod = (await import(pathToFileURL(mjs).href)) as {
      CleoHeavyCommand: (ctx: { directory: string }) => Promise<{
        'tool.execute.before': (
          input: Input,
          output: { args: { command: string; timeout?: number } },
        ) => Promise<void>;
        'tool.execute.after': (input: Input, output: { output: string }) => Promise<void>;
      }>;
    };
    const hooks = await mod.CleoHeavyCommand({ directory: project });
    const output: { args: { command: string; timeout?: number } } = {
      args: { command: 'pnpm test' },
    };
    await hooks['tool.execute.before']({ tool: 'bash', callID: 'c1' }, output);
    expect(output.args).toEqual({ command: answer.command, timeout: 240_000 });
    const result = { output: 'tests passed' };
    await hooks['tool.execute.after']({ tool: 'bash', callID: 'c1' }, result);
    expect(result.output).toBe('tests passed\n\n[cleo] routed');
    // Not the shell tool, or no tool word: cleo is never started.
    const other = { args: { command: 'pnpm test' } };
    await hooks['tool.execute.before']({ tool: 'read', callID: 'c2' }, other);
    const light = { args: { command: 'cat test-notes.md' } };
    await hooks['tool.execute.before']({ tool: 'bash', callID: 'c3' }, light);
    expect([other.args.command, light.args.command]).toEqual(['pnpm test', 'cat test-notes.md']);
    expect(calls()).toBe(1);
  });
});

describe('installer wiring', () => {
  it('Claude Code writes the project settings.local.json, never settings.json or the user settings', async () => {
    const project = join(dir, 'project');
    mkdirSync(join(project, '.claude'), { recursive: true });
    // An earlier build wrote the hook into the shared settings.json; a user hook sits beside it.
    const userGroup = { matcher: 'Bash', hooks: [{ type: 'command', command: './lint.sh' }] };
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [userGroup, heavyCommandHookEntry('claude-code')] } }),
    );
    const result = await new ClaudeCodeInstallProvider().install({
      projectDir: project,
      heavyCommandHook: 'rewrite',
    });
    expect(result.details?.heavyCommandHook).toBe('installed');
    const local = JSON.parse(
      readFileSync(join(project, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(local.hooks.PreToolUse).toEqual([heavyCommandHookEntry('claude-code')]);
    const shared = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf-8'));
    expect(shared.hooks.PreToolUse).toEqual([userGroup]);
    const userSettings = join(process.env.CLAUDE_HOME as string, 'settings.json');
    const user = existsSync(userSettings) ? readFileSync(userSettings, 'utf-8') : '';
    expect(user).not.toContain('heavy-command');
  });

  it('keeps a CLEO-written settings.local.json out of git, and undoes only its own block', async () => {
    const project = join(dir, 'repo');
    mkdirSync(project);
    execFileSync('git', ['init', '-q'], { cwd: project });
    const ignored = () => {
      try {
        execFileSync('git', ['check-ignore', '-q', '.claude/settings.local.json'], {
          cwd: project,
        });
        return true;
      } catch {
        return false;
      }
    };
    const exclude = join(project, '.git', 'info', 'exclude');
    expect(ignored()).toBe(false);
    for (let i = 0; i < 2; i++) {
      await new ClaudeCodeInstallProvider().install({
        projectDir: project,
        heavyCommandHook: 'rewrite',
      });
    }
    expect(ignored()).toBe(true);
    const text = readFileSync(exclude, 'utf-8');
    expect(text.split(LOCAL_SETTINGS_EXCLUDE_MARKER).length - 1).toBe(1);
    expect(text).toContain('/.claude/settings.local.json');
    await new ClaudeCodeInstallProvider().install({ projectDir: project, heavyCommandHook: 'off' });
    expect(readFileSync(exclude, 'utf-8')).not.toContain(LOCAL_SETTINGS_EXCLUDE_MARKER);
    expect(ignored()).toBe(false);

    // Already ignored by the project: nothing is added.
    writeFileSync(join(project, '.gitignore'), '.claude/settings.local.json\n');
    expect(excludeLocalSettingsFromGit(project)).toBe(false);
    expect(readFileSync(exclude, 'utf-8')).not.toContain(LOCAL_SETTINGS_EXCLUDE_MARKER);
    // Outside a git work tree: nothing happens.
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    expect(excludeLocalSettingsFromGit(plain)).toBe(false);
  });

  it('gives a second CLEO project in a subdirectory of the same repository its own line', async () => {
    const repo = join(dir, 'mono');
    const sub = join(repo, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const exclude = join(repo, '.git', 'info', 'exclude');
    const lines = () => readFileSync(exclude, 'utf-8').split('\n');
    await new ClaudeCodeInstallProvider().install({
      projectDir: repo,
      heavyCommandHook: 'rewrite',
    });
    await new ClaudeCodeInstallProvider().install({ projectDir: sub, heavyCommandHook: 'rewrite' });
    await new ClaudeCodeInstallProvider().install({ projectDir: sub, heavyCommandHook: 'rewrite' });
    expect(lines().filter((l) => l.endsWith('.claude/settings.local.json'))).toEqual([
      '/.claude/settings.local.json',
      '/packages/app/.claude/settings.local.json',
    ]);
    execFileSync('git', ['check-ignore', '-q', 'packages/app/.claude/settings.local.json'], {
      cwd: repo,
    });
    // `off` in the subdirectory removes only its own block.
    await new ClaudeCodeInstallProvider().install({ projectDir: sub, heavyCommandHook: 'off' });
    expect(lines().filter((l) => l.endsWith('.claude/settings.local.json'))).toEqual([
      '/.claude/settings.local.json',
    ]);
    expect(lines().filter((l) => l === LOCAL_SETTINGS_EXCLUDE_MARKER)).toHaveLength(1);
  });

  it('skips the home directory, whose provider configs are the user-global ones', async () => {
    const home = process.env.HOME as string;
    // Sequential: Codex and opencode both write AGENTS.md here.
    const results = [
      await new ClaudeCodeInstallProvider().install({
        projectDir: home,
        heavyCommandHook: 'rewrite',
      }),
      await new CodexInstallProvider().install({ projectDir: home, heavyCommandHook: 'rewrite' }),
      await new OpenCodeInstallProvider().install({
        projectDir: home,
        heavyCommandHook: 'rewrite',
      }),
    ];
    expect(results.map((r) => r.details?.heavyCommandHook)).toEqual([
      'skipped',
      'skipped',
      'skipped',
    ]);
    const userSettings = join(home, '.claude', 'settings.json');
    const user = existsSync(userSettings) ? readFileSync(userSettings, 'utf-8') : '';
    expect(user).not.toContain('heavy-command');
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false);
    expect(existsSync(join(home, '.opencode', 'plugins', OPENCODE_HEAVY_COMMAND_PLUGIN))).toBe(
      false,
    );
    expect(isUserHomeDir(join(home, 'project'))).toBe(false);
  });

  it('Codex and opencode install only when a mode is passed', async () => {
    const project = join(dir, 'project');
    mkdirSync(project);
    await new CodexInstallProvider().install({ projectDir: project });
    await new OpenCodeInstallProvider().install({ projectDir: project });
    expect(existsSync(join(project, '.codex', 'hooks.json'))).toBe(false);
    expect(existsSync(join(project, '.opencode', 'plugins', OPENCODE_HEAVY_COMMAND_PLUGIN))).toBe(
      false,
    );

    const codex = await new CodexInstallProvider().install({
      projectDir: project,
      heavyCommandHook: 'rewrite',
    });
    const opencode = await new OpenCodeInstallProvider().install({
      projectDir: project,
      heavyCommandHook: 'rewrite',
    });
    expect([codex.details?.heavyCommandHook, opencode.details?.heavyCommandHook]).toEqual([
      'installed',
      'installed',
    ]);
    const hooks = JSON.parse(readFileSync(join(project, '.codex', 'hooks.json'), 'utf-8'));
    expect(hooks.hooks.PreToolUse).toEqual([heavyCommandHookEntry('codex')]);
  });
});
