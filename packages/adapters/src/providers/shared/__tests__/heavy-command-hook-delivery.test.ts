/**
 * Tests for delivering the heavy-command hook to every provider a project
 * uses (T13124).
 *
 * Coverage:
 *   - providers are independent: a stray `.codex` FILE (live in cleocode on
 *     2026-10-03, where `mkdirSync` threw EEXIST and aborted the Codex install)
 *     blocks Codex with a reason and remedy while Claude Code and opencode
 *     still install; a malformed settings file fails only its provider
 *   - providers not in use are skipped, Kimi is `unsupported` (global config
 *     only), the home directory is skipped, mode `off` removes everywhere
 *   - inspection: installed, outdated (other build, legacy location, present
 *     while off), missing, blocked, unreadable, disabled, not-detected, and a
 *     hand-added Kimi entry
 *
 * Every write goes to a temp directory; detection reads only the injected env.
 *
 * @task T13124
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectHeavyHookProvider,
  inspectProjectHeavyCommandHooks,
  probeHeavyHookCli,
  syncProjectHeavyCommandHooks,
} from '../heavy-command-hook-delivery.js';
import { heavyCommandHookEntry, OLDER_CLEO_MARKER_PREFIX } from '../heavy-command-hook-install.js';

let dir: string;
let project: string;
let home: string;
let env: Record<string, string>;
const savedTmp = process.env.TMPDIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-heavy-hook-delivery-'));
  project = join(dir, 'project');
  home = join(dir, 'home');
  mkdirSync(project);
  mkdirSync(home);
  // An empty PATH dir: no harness CLI is found unless a test adds one.
  mkdirSync(join(dir, 'bin'));
  env = { HOME: home, PATH: join(dir, 'bin') };
  // The older-CLEO marker sweep runs in $TMPDIR; keep it inside the sandbox.
  process.env.TMPDIR = dir;
});
afterEach(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  rmSync(dir, { recursive: true, force: true });
});

const status = (outcomes: readonly { provider: string; status: string }[]) =>
  Object.fromEntries(outcomes.map((o) => [o.provider, o.status]));

function useAll(): void {
  mkdirSync(join(project, '.claude'));
  mkdirSync(join(home, '.codex'));
  mkdirSync(join(project, '.opencode'));
  mkdirSync(join(home, '.kimi'));
}

describe('syncProjectHeavyCommandHooks', () => {
  it('installs for every provider in use, each on its own, then is idempotent', async () => {
    useAll();
    const first = await syncProjectHeavyCommandHooks(project, 'rewrite', { env });
    expect(status(first)).toEqual({
      'claude-code': 'installed',
      codex: 'installed',
      opencode: 'installed',
      kimi: 'unsupported',
    });
    expect(first.find((o) => o.provider === 'kimi')?.remedy).toMatch(/\[\[hooks\]\]/);
    expect(existsSync(join(project, '.claude', 'settings.local.json'))).toBe(true);
    expect(existsSync(join(project, '.codex', 'hooks.json'))).toBe(true);
    expect(existsSync(join(project, '.opencode', 'plugins', 'cleo-heavy-command.js'))).toBe(true);
    const again = await syncProjectHeavyCommandHooks(project, 'rewrite', { env });
    expect(status(again)).toEqual({
      'claude-code': 'unchanged',
      codex: 'unchanged',
      opencode: 'unchanged',
      kimi: 'unsupported',
    });
  });

  it('a .codex FILE blocks only Codex, with the reason and remedy; the others install', async () => {
    useAll();
    writeFileSync(join(project, '.codex'), '');
    const outcomes = await syncProjectHeavyCommandHooks(project, 'rewrite', { env });
    expect(status(outcomes)).toMatchObject({
      'claude-code': 'installed',
      codex: 'blocked',
      opencode: 'installed',
    });
    const codex = outcomes.find((o) => o.provider === 'codex');
    expect(codex?.reason).toMatch(/\.codex exists but is not a directory/);
    expect(codex?.remedy).toMatch(
      /remove or rename .*\.codex.*cleo doctor heavy-command-hook --fix/,
    );
    // The file is left exactly as it was.
    expect(readFileSync(join(project, '.codex'), 'utf-8')).toBe('');
  });

  it('a malformed settings file fails only Claude Code and is left untouched', async () => {
    useAll();
    const local = join(project, '.claude', 'settings.local.json');
    writeFileSync(local, '{ "permissions": ');
    const outcomes = await syncProjectHeavyCommandHooks(project, 'rewrite', { env });
    expect(status(outcomes)).toMatchObject({
      'claude-code': 'failed',
      codex: 'installed',
      opencode: 'installed',
    });
    const claude = outcomes.find((o) => o.provider === 'claude-code');
    expect(claude?.remedy).toMatch(/fix the JSON in .*settings\.local\.json/);
    expect(readFileSync(local, 'utf-8')).toBe('{ "permissions": ');
  });

  it('a .claude FILE blocks Claude Code instead of throwing', async () => {
    writeFileSync(join(project, '.claude'), 'not a dir');
    const outcomes = await syncProjectHeavyCommandHooks(project, 'rewrite', {
      env,
      providers: ['claude-code'],
    });
    expect(status(outcomes)).toEqual({ 'claude-code': 'blocked' });
  });

  it('skips providers not in use, and skips everything in the home directory', async () => {
    const none = await syncProjectHeavyCommandHooks(project, 'rewrite', { env });
    expect(status(none)).toEqual({
      'claude-code': 'skipped',
      codex: 'skipped',
      opencode: 'skipped',
      kimi: 'skipped',
    });
    expect(existsSync(join(project, '.claude'))).toBe(false);
    mkdirSync(join(home, '.claude'));
    const atHome = await syncProjectHeavyCommandHooks(home, 'rewrite', { env });
    expect(atHome.every((o) => o.status === 'skipped')).toBe(true);
    expect(existsSync(join(home, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('mode off removes the hook from every provider, in use or not', async () => {
    useAll();
    await syncProjectHeavyCommandHooks(project, 'rewrite', { env });
    rmSync(join(home, '.codex'), { recursive: true });
    const off = await syncProjectHeavyCommandHooks(project, 'off', { env });
    expect(status(off)).toEqual({
      'claude-code': 'removed',
      codex: 'removed',
      opencode: 'removed',
      kimi: 'unchanged',
    });
  });
});

describe('detectHeavyHookProvider', () => {
  it('reads project dirs, PATH, user config dirs and the environment', () => {
    expect(detectHeavyHookProvider('claude-code', project, env).detected).toBe(false);
    expect(
      detectHeavyHookProvider('claude-code', project, { ...env, CLAUDECODE: '1' }).why,
    ).toMatch(/inside Claude Code/);
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    expect(detectHeavyHookProvider('codex', project, env).why).toMatch(/`codex` is on PATH/);
    writeFileSync(join(project, 'opencode.json'), '{}');
    expect(detectHeavyHookProvider('opencode', project, env).detected).toBe(true);
  });
});

describe('inspectProjectHeavyCommandHooks', () => {
  const state = (mode: 'rewrite' | 'warn' | 'off' = 'rewrite') =>
    Object.fromEntries(
      inspectProjectHeavyCommandHooks(project, mode, { env }).map((i) => [i.provider, i.state]),
    );

  it('reports missing for a provider in use, not-detected otherwise, installed after a sync', async () => {
    mkdirSync(join(project, '.claude'));
    expect(state()).toEqual({
      'claude-code': 'missing',
      codex: 'not-detected',
      opencode: 'not-detected',
      kimi: 'not-detected',
    });
    const missing = inspectProjectHeavyCommandHooks(project, 'rewrite', { env })[0];
    expect(missing?.remedy).toBe('run: cleo doctor heavy-command-hook --fix');
    await syncProjectHeavyCommandHooks(project, 'rewrite', { env });
    expect(state()['claude-code']).toBe('installed');
  });

  it('reports outdated for another build, a legacy location, or a hook left while off', async () => {
    mkdirSync(join(project, '.claude'));
    const local = join(project, '.claude', 'settings.local.json');
    const stale = heavyCommandHookEntry('claude-code');
    const hooks = stale.hooks as Array<Record<string, unknown>>;
    hooks[0] = { ...hooks[0], timeout: 1 };
    writeFileSync(local, JSON.stringify({ hooks: { PreToolUse: [stale] } }));
    expect(state()['claude-code']).toBe('outdated');
    rmSync(local);
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [heavyCommandHookEntry('claude-code')] } }),
    );
    expect(state()['claude-code']).toBe('outdated');
    rmSync(join(project, '.claude', 'settings.json'));
    await syncProjectHeavyCommandHooks(project, 'rewrite', { env });
    expect(state('off')['claude-code']).toBe('outdated');
    await syncProjectHeavyCommandHooks(project, 'off', { env });
    expect(state('off')['claude-code']).toBe('disabled');
  });

  it('reports blocked and unreadable with the exact remedy', () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(project, '.codex'), '');
    const codex = inspectProjectHeavyCommandHooks(project, 'rewrite', { env }).find(
      (i) => i.provider === 'codex',
    );
    expect(codex?.state).toBe('blocked');
    expect(codex?.remedy).toMatch(/remove or rename .*\.codex/);
    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude', 'settings.local.json'), '[');
    expect(state()['claude-code']).toBe('unreadable');
  });

  it('Kimi: unsupported unless the user added the entry to ~/.kimi/config.toml', () => {
    mkdirSync(join(home, '.kimi'));
    expect(state().kimi).toBe('unsupported');
    writeFileSync(
      join(home, '.kimi', 'config.toml'),
      '[[hooks]]\nevent = "PreToolUse"\ncommand = "cleo hook heavy-command --provider kimi"\n',
    );
    expect(state().kimi).toBe('installed');
  });

  it('never writes anything', () => {
    useAll();
    inspectProjectHeavyCommandHooks(project, 'rewrite', { env });
    expect(existsSync(join(project, '.claude', 'settings.local.json'))).toBe(false);
    expect(existsSync(join(project, '.codex'))).toBe(false);
  });
});

describe('probeHeavyHookCli', () => {
  /** A fake `cleo` on the test PATH running `body`. */
  const fakeCleo = (body: string): string => {
    const path = join(dir, 'bin', 'cleo');
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return path;
  };
  const probeEnv = () => ({ ...env, PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, TMPDIR: dir });

  it('reports a missing cleo', () => {
    expect(probeHeavyHookCli(project, { env }).state).toBe('missing');
  });

  it('reports a cleo that answers the hook as current', () => {
    fakeCleo('cat >/dev/null; exit 0');
    expect(probeHeavyHookCli(project, { env: probeEnv() }).state).toBe('current');
  });

  it('reports a cleo without `cleo hook` as older, with the remedy', () => {
    const path = fakeCleo('echo "Unknown command hook" >&2; exit 127');
    const probe = probeHeavyHookCli(project, { env: probeEnv() });
    expect(probe.state).toBe('older');
    expect(probe.path).toBe(path);
    expect(probe.remedy).toMatch(/upgrade the cleo at .*cleo doctor heavy-command-hook --fix/);
    // Any other failure is unknown, not older.
    fakeCleo('exit 3');
    const broken = probeHeavyHookCli(project, { env: probeEnv() });
    expect(broken.state).toBe('unknown');
    expect(broken.detail).toMatch(/exit 3.*fails open/);
    expect(broken.remedy).toMatch(/hook heavy-command < \/dev\/null/);
  });

  it("trusts the hook's own marker for this binary and directory, within its hour", () => {
    // This cleo would answer, but the hook recorded that it did not.
    const path = fakeCleo('cat >/dev/null; exit 0');
    const key = execFileSync(
      '/bin/sh',
      ['-c', `printf '%s|%s' "$1" "$2" | cksum | tr -c '0-9' '-'`, 'sh', path, project],
      { encoding: 'utf-8' },
    );
    const marker = join(dir, `${OLDER_CLEO_MARKER_PREFIX}${key}`);
    writeFileSync(marker, '');
    const old = new Date(Date.now() - 10_000);
    utimesSync(path, old, old);
    expect(probeHeavyHookCli(project, { env: probeEnv() }).state).toBe('older');
    // A marker older than the binary (CLEO was upgraded since) is ignored.
    utimesSync(marker, old, new Date(Date.now() - 20_000));
    expect(probeHeavyHookCli(project, { env: probeEnv() }).state).toBe('current');
  });
});

describe('every hook file stays out of git (T13124, gh#1805)', () => {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', project, ...args], { encoding: 'utf-8' });
  const untracked = () =>
    git('status', '--porcelain', '--untracked-files=all')
      .split('\n')
      .filter((l) => l.startsWith('??'))
      .map((l) => l.slice(3));

  it('excludes the Claude Code, Codex and opencode hook files it writes, and undoes it on off', async () => {
    git('init', '-q');
    useAll();
    await syncProjectHeavyCommandHooks(project, 'rewrite', { env });
    expect(untracked()).toEqual([]);
    const exclude = readFileSync(join(project, '.git', 'info', 'exclude'), 'utf-8');
    for (const line of [
      '/.claude/settings.local.json',
      '/.codex/hooks.json',
      '/.opencode/plugins/cleo-heavy-command.js',
    ]) {
      expect(exclude.split('\n')).toContain(line);
    }
    await syncProjectHeavyCommandHooks(project, 'off', { env });
    const after = readFileSync(join(project, '.git', 'info', 'exclude'), 'utf-8');
    expect(after).not.toMatch(/cleo-heavy-command\.js|\.codex\/hooks\.json|settings\.local\.json/);
  });

  it('flags a hand-written hook file git can see, and the fix excludes it without rewriting it', async () => {
    git('init', '-q');
    mkdirSync(join(project, '.opencode', 'plugins'), { recursive: true });
    const { opencodeHeavyCommandPluginSource } = await import('../heavy-command-hook-install.js');
    writeFileSync(
      join(project, '.opencode', 'plugins', 'cleo-heavy-command.js'),
      opencodeHeavyCommandPluginSource(),
    );
    const before = inspectProjectHeavyCommandHooks(project, 'rewrite', { env }).find(
      (i) => i.provider === 'opencode',
    );
    expect(before?.state).toBe('outdated');
    expect(before?.detail).toMatch(/git sees it as an untracked file/);
    const outcomes = await syncProjectHeavyCommandHooks(project, 'rewrite', { env });
    expect(outcomes.find((o) => o.provider === 'opencode')?.status).toBe('unchanged');
    expect(untracked()).toEqual([]);
    expect(
      inspectProjectHeavyCommandHooks(project, 'rewrite', { env }).find(
        (i) => i.provider === 'opencode',
      )?.state,
    ).toBe('installed');
  });

  it('never adds an exclude line for a hook file the repository tracks', async () => {
    git('init', '-q');
    mkdirSync(join(project, '.opencode'));
    await syncProjectHeavyCommandHooks(project, 'rewrite', { env, providers: ['opencode'] });
    // Drop CLEO's block, then commit the plugin as a team would.
    writeFileSync(join(project, '.git', 'info', 'exclude'), '');
    git('add', '-f', '.opencode/plugins/cleo-heavy-command.js');
    await syncProjectHeavyCommandHooks(project, 'rewrite', { env, providers: ['opencode'] });
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf-8')).toBe('');
  });

  it("mode off keeps a user's own identical exclude line (only CLEO's marked block goes)", async () => {
    git('init', '-q');
    mkdirSync(join(project, '.opencode', 'plugins'), { recursive: true });
    const exclude = join(project, '.git', 'info', 'exclude');
    writeFileSync(exclude, '# mine\n/.opencode/plugins/cleo-heavy-command.js\n');
    await syncProjectHeavyCommandHooks(project, 'off', { env, providers: ['opencode'] });
    expect(readFileSync(exclude, 'utf-8')).toBe(
      '# mine\n/.opencode/plugins/cleo-heavy-command.js\n',
    );
  });

  it('mode off cleans a provider no longer in use (a vanished plugin left its exclude block)', async () => {
    git('init', '-q');
    mkdirSync(join(project, '.opencode'));
    await syncProjectHeavyCommandHooks(project, 'rewrite', { env, providers: ['opencode'] });
    const exclude = join(project, '.git', 'info', 'exclude');
    expect(readFileSync(exclude, 'utf-8')).toContain('/.opencode/plugins/cleo-heavy-command.js');
    rmSync(join(project, '.opencode'), { recursive: true });
    expect(detectHeavyHookProvider('opencode', project, env).detected).toBe(false);
    await syncProjectHeavyCommandHooks(project, 'off', { env, providers: ['opencode'] });
    expect(readFileSync(exclude, 'utf-8')).not.toContain('cleo-heavy-command.js');
  });

  it('a hook file alone makes its provider in use, so mode off always reaches it', async () => {
    useAll();
    await syncProjectHeavyCommandHooks(project, 'rewrite', { env });
    // Every machine-level signal gone: the hook files still count.
    rmSync(join(home, '.codex'), { recursive: true });
    rmSync(join(home, '.kimi'), { recursive: true });
    for (const provider of ['claude-code', 'codex', 'opencode'] as const) {
      expect(detectHeavyHookProvider(provider, project, env).detected, provider).toBe(true);
    }
    const off = await syncProjectHeavyCommandHooks(project, 'off', { env });
    expect(off.filter((o) => o.status === 'removed').map((o) => o.provider)).toEqual([
      'claude-code',
      'codex',
      'opencode',
    ]);
  });
});

describe("Codex's hooks.json is a shared project config (review MED-3)", () => {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', project, ...args], { encoding: 'utf-8' });
  const hooksFile = () => join(project, '.codex', 'hooks.json');
  const teamHook = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'team-lint-hook' }] }],
    },
  };
  const codex = async () =>
    (await syncProjectHeavyCommandHooks(project, 'rewrite', { env, providers: ['codex'] }))[0];
  const inspectCodex = () =>
    inspectProjectHeavyCommandHooks(project, 'rewrite', { env, providers: ['codex'] })[0];

  beforeEach(() => {
    git('init', '-q');
    mkdirSync(join(home, '.codex'));
    mkdirSync(join(project, '.codex'));
  });

  it('an untracked hooks.json with a team hook: needs consent (with the exact entry), untouched, never excluded', async () => {
    const body = `${JSON.stringify(teamHook, null, 2)}\n`;
    writeFileSync(hooksFile(), body);
    const outcome = await codex();
    expect(outcome?.status).toBe('needs-consent');
    expect(outcome?.reason).toMatch(/is the project's own Codex hook config/);
    expect(outcome?.remedy).toMatch(/add CLEO's PreToolUse entry \(the snippet\)/);
    expect(JSON.parse(outcome?.snippet ?? 'null')).toEqual(heavyCommandHookEntry('codex'));
    expect(readFileSync(hooksFile(), 'utf-8')).toBe(body);
    expect(
      existsSync(join(project, '.git', 'info', 'exclude'))
        ? readFileSync(join(project, '.git', 'info', 'exclude'), 'utf-8')
        : '',
    ).not.toContain('.codex/hooks.json');
    const inspected = inspectCodex();
    expect(inspected?.state).toBe('needs-consent');
    expect(inspected?.snippet).toBe(outcome?.snippet);
  });

  it("an empty hooks.json the user made is theirs too: needs consent, even in the briefing's no-git mode", async () => {
    writeFileSync(hooksFile(), '{}\n');
    expect((await codex())?.status).toBe('needs-consent');
    expect(readFileSync(hooksFile(), 'utf-8')).toBe('{}\n');
    const quick = inspectProjectHeavyCommandHooks(project, 'rewrite', {
      env,
      providers: ['codex'],
      gitChecks: false,
    })[0];
    expect(quick?.state).toBe('needs-consent');
  });

  it('a CLEO-created, untracked hooks.json is refreshed and excluded', async () => {
    rmSync(join(project, '.codex'), { recursive: true });
    expect((await codex())?.status).toBe('installed');
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf-8')).toContain(
      '/.codex/hooks.json',
    );
    expect((await codex())?.status).toBe('unchanged');
  });

  it('a tracked hooks.json holding only CLEO hooks still needs consent, untouched', async () => {
    rmSync(join(project, '.codex'), { recursive: true });
    await codex();
    git('add', '-f', '.codex/hooks.json');
    const before = readFileSync(hooksFile(), 'utf-8');
    const outcome = await codex();
    expect(outcome?.status).toBe('needs-consent');
    expect(outcome?.reason).toMatch(/is tracked by git/);
    expect(readFileSync(hooksFile(), 'utf-8')).toBe(before);
  });

  it.each([
    ['empty', ''],
    ['a newline', '\n'],
  ])("a committed %s hooks.json is the team's: needs consent, never written (review MED-3a)", async (_name, body) => {
    writeFileSync(hooksFile(), body);
    git('add', '-f', '.codex/hooks.json');
    git(
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '-qm',
      'team',
      '--no-verify',
    );
    const outcome = await codex();
    expect(outcome?.status).toBe('needs-consent');
    expect(readFileSync(hooksFile(), 'utf-8')).toBe(body);
    expect(git('status', '--porcelain', '--', '.codex/hooks.json')).toBe('');
  });

  it("an untracked hooks.json that is not valid JSON is the user's: needs consent, untouched", async () => {
    writeFileSync(hooksFile(), '{ broken');
    expect((await codex())?.status).toBe('needs-consent');
    expect(readFileSync(hooksFile(), 'utf-8')).toBe('{ broken');
  });

  it("mode off leaves CLEO's hook the team committed (review MED-3b)", async () => {
    rmSync(join(project, '.codex'), { recursive: true });
    await codex();
    writeFileSync(join(project, '.git', 'info', 'exclude'), '');
    git('add', '-f', '.codex/hooks.json');
    git(
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '-qm',
      'adopt cleo hook',
      '--no-verify',
    );
    const committed = readFileSync(hooksFile(), 'utf-8');
    const off = (
      await syncProjectHeavyCommandHooks(project, 'off', { env, providers: ['codex'] })
    )[0];
    expect(off?.status).toBe('needs-consent');
    expect(off?.remedy).toMatch(/team committed CLEO's hook/);
    expect(readFileSync(hooksFile(), 'utf-8')).toBe(committed);
    expect(git('status', '--porcelain', '--', '.codex/hooks.json')).toBe('');
  });

  it("a CLEO-created file that later holds the user's own hook stops being hidden (review MED-3c)", async () => {
    rmSync(join(project, '.codex'), { recursive: true });
    await codex();
    const exclude = join(project, '.git', 'info', 'exclude');
    expect(readFileSync(exclude, 'utf-8')).toContain('/.codex/hooks.json');
    const withTeam = JSON.parse(readFileSync(hooksFile(), 'utf-8')) as typeof teamHook;
    withTeam.hooks.PreToolUse.push(...teamHook.hooks.PreToolUse);
    writeFileSync(hooksFile(), JSON.stringify(withTeam));
    const flagged = inspectCodex();
    expect(flagged?.state).toBe('outdated');
    expect(flagged?.detail).toMatch(/info\/exclude line hides/);
    expect((await codex())?.status).toBe('needs-consent');
    expect(readFileSync(exclude, 'utf-8')).not.toContain('/.codex/hooks.json');
    expect(git('status', '--porcelain', '--untracked-files=all')).toContain('.codex/hooks.json');
  });

  it("flags CLEO's hook left as an uncommitted change in a tracked hooks.json; off removes only CLEO's", async () => {
    // The team's own formatting (4-space indent), which off must give back byte for byte.
    const committedBytes = `${JSON.stringify(teamHook, null, 4)}\n`;
    writeFileSync(hooksFile(), committedBytes);
    git('add', '-f', '.codex/hooks.json');
    git(
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '-qm',
      'team hooks',
      '--no-verify',
    );
    // An earlier hand install wrote CLEO's hook into the committed team file.
    const withCleo = structuredClone(teamHook);
    withCleo.hooks.PreToolUse.push(
      heavyCommandHookEntry('codex') as (typeof teamHook.hooks.PreToolUse)[number],
    );
    writeFileSync(hooksFile(), JSON.stringify(withCleo));
    const flagged = inspectCodex();
    expect(flagged?.state).toBe('outdated');
    expect(flagged?.detail).toMatch(
      /an uncommitted change: one `git commit -a` ships it to the team/,
    );
    const off = await syncProjectHeavyCommandHooks(project, 'off', { env, providers: ['codex'] });
    expect(off[0]?.status).toBe('removed');
    // Back to HEAD's exact bytes (review LOW-3): no reformatting diff left behind.
    expect(readFileSync(hooksFile(), 'utf-8')).toBe(committedBytes);
    expect(git('status', '--porcelain', '--', '.codex/hooks.json')).toBe('');
  });
});
