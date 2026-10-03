/**
 * Tests for `cleo hook heavy-command` (T12983).
 *
 * Coverage:
 *   - parseHookInput: shell tool calls only, junk is silence
 *   - heavyHookWaitBudget: Claude Code's Bash timeout grows by the queue wait
 *   - renderHeavyHookAnswer: the JSON each harness expects (Claude Code
 *     updatedInput without a permission decision, Codex allow + updatedInput,
 *     Kimi deny with the governed command, opencode `{ command }`)
 *   - heavyCommandHook end to end with the real planner: rewrite, the
 *     fallbacks (`cleo` not on PATH, warn mode, dontAsk), off, light commands,
 *     and the pressure line
 *   - runHookCli: usage errors exit 1, a hook failure exits 0 (fail-open)
 *
 * The pressure sample is stubbed so the answers do not depend on the load of
 * the machine running the tests.
 *
 * @task T12983
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HeavyCommandPlan, ShellToolInput } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pressure = vi.hoisted(() => ({ line: null as string | null }));
vi.mock('@cleocode/core/resources/heavy-command.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@cleocode/core/resources/heavy-command.js')>();
  return { ...real, heavyPressureNotice: async () => pressure.line };
});

import {
  type HookIo,
  heavyCommandHook,
  heavyHookContext,
  heavyHookWaitBudget,
  heavyRuleWords,
  parseHookInput,
  renderHeavyHookAnswer,
  runHookCli,
} from '../hook-entry.js';

let dir: string;
let pathWithCleo: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-hook-entry-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'cleo'), '#!/bin/sh\n');
  chmodSync(join(bin, 'cleo'), 0o755);
  pathWithCleo = `${bin}:/usr/bin:/bin`;
  pressure.line = null;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const payload = (command: string, extra: Record<string, string | number | boolean> = {}) =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command, description: 'run it', ...extra },
    cwd: dir,
    permission_mode: 'bypassPermissions',
  });

describe('parseHookInput', () => {
  it('keeps a shell tool call and drops everything else', () => {
    expect(parseHookInput(payload('ls'))?.tool_input?.command).toBe('ls');
    expect(parseHookInput('{"tool_name":"Shell","tool_input":{"command":"ls"}}')?.tool_name).toBe(
      'Shell',
    );
    expect(parseHookInput('{"tool_name":"Read","tool_input":{"command":"x"}}')).toBeNull();
    expect(parseHookInput('{"tool_name":"Bash","tool_input":{}}')).toBeNull();
    expect(parseHookInput('not json')).toBeNull();
    expect(parseHookInput('[1,2]')).toBeNull();
  });
});

describe('heavyHookWaitBudget', () => {
  it('adds the queue wait on top of Claude Code’s Bash timeout, within its maximum', () => {
    expect(heavyHookWaitBudget('claude-code', { command: 'x' })).toEqual({
      waitTimeoutSec: 120,
      timeoutMs: 240_000,
    });
    // At the cap the allowance shrinks to the room left (30 s floor), so the
    // command keeps almost all of its own time.
    expect(heavyHookWaitBudget('claude-code', { command: 'x', timeout: 600_000 })).toEqual({
      waitTimeoutSec: 30,
      timeoutMs: 600_000,
    });
    expect(heavyHookWaitBudget('claude-code', { command: 'x', timeout: 500_000 })).toEqual({
      waitTimeoutSec: 100,
      timeoutMs: 600_000,
    });
    // A deliberate short timeout gets a short wait, not five minutes.
    expect(heavyHookWaitBudget('claude-code', { command: 'x', timeout: 5000 })).toEqual({
      waitTimeoutSec: 30,
      timeoutMs: 35_000,
    });
    expect(heavyHookWaitBudget('claude-code', { command: 'x', run_in_background: true })).toEqual(
      {},
    );
    expect(heavyHookWaitBudget('codex', { command: 'x' })).toEqual({ waitTimeoutSec: 60 });
    expect(heavyHookWaitBudget('opencode', { command: 'x' })).toEqual({
      waitTimeoutSec: 120,
      timeoutMs: 240_000,
    });
  });

  it('honours BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS and never lowers the timeout', () => {
    const env = { BASH_MAX_TIMEOUT_MS: '3600000' };
    expect(heavyHookWaitBudget('claude-code', { command: 'x', timeout: 1_200_000 }, env)).toEqual({
      waitTimeoutSec: 300,
      timeoutMs: 1_500_000,
    });
    expect(
      heavyHookWaitBudget('claude-code', { command: 'x' }, { BASH_DEFAULT_TIMEOUT_MS: '1800000' }),
    ).toEqual({ waitTimeoutSec: 30, timeoutMs: 1_800_000 });
    for (const timeout of [1000, 5000, 120_000, 599_000, 600_000]) {
      const got = heavyHookWaitBudget('claude-code', { command: 'x', timeout });
      expect(got.timeoutMs ?? 0, String(timeout)).toBeGreaterThanOrEqual(timeout);
    }
    // Junk values fall back to the defaults.
    expect(
      heavyHookWaitBudget('claude-code', { command: 'x' }, { BASH_MAX_TIMEOUT_MS: 'lots' }),
    ).toEqual({ waitTimeoutSec: 120, timeoutMs: 240_000 });
  });
});

describe('renderHeavyHookAnswer', () => {
  const input: ShellToolInput = { command: 'pnpm test', description: 'tests' };
  const rewrite: HeavyCommandPlan = {
    action: 'rewrite',
    command: 'cleo run --wait --passthrough --class test -- pnpm test',
    segments: [
      {
        text: 'pnpm test',
        runClass: 'test',
        governed: 'cleo run --wait --passthrough --class test -- pnpm test',
        argv: ['pnpm', 'test'],
      },
    ],
  };
  const warn: HeavyCommandPlan = { action: 'warn', reason: 'x', segments: rewrite.segments };

  it('claude-code: updatedInput keeps the other fields, adds the timeout, decides nothing', () => {
    expect(
      JSON.parse(renderHeavyHookAnswer('claude-code', input, rewrite, 'ctx', 420_000)),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          command: 'cleo run --wait --passthrough --class test -- pnpm test',
          description: 'tests',
          timeout: 420_000,
        },
        additionalContext: 'ctx',
      },
    });
    expect(JSON.parse(renderHeavyHookAnswer('claude-code', input, warn, 'ctx'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'ctx' },
    });
  });

  it('codex: a rewrite needs permissionDecision allow', () => {
    expect(JSON.parse(renderHeavyHookAnswer('codex', input, rewrite, 'ctx'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          command: 'cleo run --wait --passthrough --class test -- pnpm test',
          description: 'tests',
        },
        additionalContext: 'ctx',
      },
    });
  });

  it('kimi: cannot rewrite, so it denies with the governed command; warnings are plain text', () => {
    const reason = heavyHookContext(rewrite, null, 'kimi');
    expect(reason).toBe(
      '[cleo] Not run: heavy commands share the machine-wide resource budget. Re-run it as: cleo run --wait --passthrough --class test -- pnpm test',
    );
    expect(reason).not.toMatch(/Routed/);
    const deny = JSON.parse(renderHeavyHookAnswer('kimi', input, rewrite, reason));
    expect(deny.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(deny.hookSpecificOutput.permissionDecisionReason).toBe(reason);
    expect(renderHeavyHookAnswer('kimi', input, warn, 'ctx')).toBe('ctx\n');
  });

  it('opencode: { command, timeout, context }', () => {
    expect(JSON.parse(renderHeavyHookAnswer('opencode', input, rewrite, 'ctx', 240_000))).toEqual({
      command: 'cleo run --wait --passthrough --class test -- pnpm test',
      timeout: 240_000,
      context: 'ctx',
    });
    expect(JSON.parse(renderHeavyHookAnswer('opencode', input, warn, 'ctx', 240_000))).toEqual({
      context: 'ctx',
    });
  });

  it('says nothing for a light command without a pressure line', () => {
    expect(renderHeavyHookAnswer('claude-code', input, { action: 'none' }, '')).toBe('');
  });
});

describe('heavyCommandHook', () => {
  // HOME and CODEX_HOME point into the temp dir: the user's own settings are never read.
  const io = (env: Record<string, string | undefined> = {}) => ({
    cwd: dir,
    env: {
      PATH: pathWithCleo,
      CLAUDE_PROJECT_DIR: dir,
      HOME: join(dir, 'home'),
      CODEX_HOME: join(dir, 'codex-home'),
      ...env,
    },
  });

  it('rewrites a heavy command through cleo run with the class and wait', async () => {
    const out = JSON.parse(
      await heavyCommandHook('claude-code', payload('pnpm vitest run a.test.ts'), io()),
    );
    expect(out.hookSpecificOutput.updatedInput).toEqual({
      command:
        'cleo run --wait --passthrough --timeout 120 --class test -- pnpm vitest run a.test.ts',
      description: 'run it',
      timeout: 240_000,
    });
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toMatch(/machine-wide budget/);
  });

  it('falls back to a warning when cleo is not on PATH', async () => {
    const out = JSON.parse(
      await heavyCommandHook('claude-code', payload('pnpm test'), io({ PATH: '/usr/bin:/bin' })),
    );
    expect(out.hookSpecificOutput.updatedInput).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toMatch(/not on PATH.*cleo run --wait/s);
  });

  it('honours CLEO_HEAVY_COMMAND_HOOK=warn and =off', async () => {
    const warned = JSON.parse(
      await heavyCommandHook(
        'claude-code',
        payload('pnpm test'),
        io({ CLEO_HEAVY_COMMAND_HOOK: 'warn' }),
      ),
    );
    expect(warned.hookSpecificOutput.updatedInput).toBeUndefined();
    expect(warned.hookSpecificOutput.additionalContext).toMatch(/warn mode/);
    expect(
      await heavyCommandHook(
        'claude-code',
        payload('pnpm test'),
        io({ CLEO_HEAVY_COMMAND_HOOK: 'off' }),
      ),
    ).toBe('');
  });

  it('honours resources.heavyCommandHook in the project config', async () => {
    mkdirSync(join(dir, '.cleo'));
    writeFileSync(
      join(dir, '.cleo', 'config.json'),
      JSON.stringify({ resources: { heavyCommandHook: 'off' } }),
    );
    expect(await heavyCommandHook('claude-code', payload('pnpm test'), io())).toBe('');
    // An unknown env value does not mask the config.
    expect(
      await heavyCommandHook(
        'claude-code',
        payload('pnpm test'),
        io({ CLEO_HEAVY_COMMAND_HOOK: 'sometimes' }),
      ),
    ).toBe('');
    // The project config applies from a subdirectory too (no CLAUDE_PROJECT_DIR).
    const sub = join(dir, 'packages', 'x');
    mkdirSync(sub, { recursive: true });
    const fromSub = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
      cwd: sub,
    });
    expect(
      await heavyCommandHook('codex', fromSub, { cwd: sub, env: { PATH: pathWithCleo } }),
    ).toBe('');
  });

  it('rewrites in auto mode as in bypassPermissions (owner decision 2026-10-01)', async () => {
    const stdin = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
      cwd: dir,
      permission_mode: 'auto',
    });
    const claude = JSON.parse(await heavyCommandHook('claude-code', stdin, io()));
    expect(claude.hookSpecificOutput.updatedInput.command).toBe(
      'cleo run --wait --passthrough --timeout 120 --class test -- pnpm test',
    );
    expect(claude.hookSpecificOutput.permissionDecision).toBeUndefined();
    // The deny/ask safeguard still applies in auto mode.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { ask: ['Bash(pnpm test:*)'] } }),
    );
    const guarded = JSON.parse(await heavyCommandHook('claude-code', stdin, io()));
    expect(guarded.hookSpecificOutput.updatedInput).toBeUndefined();
    expect(guarded.hookSpecificOutput.additionalContext).toMatch(/names `pnpm`/);
  });

  it('warns in default, acceptEdits, plan, dontAsk and unknown modes', async () => {
    for (const permission_mode of [
      'default',
      'acceptEdits',
      'plan',
      'dontAsk',
      'bogus',
      undefined,
    ]) {
      const stdin = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        cwd: dir,
        ...(permission_mode === undefined ? {} : { permission_mode }),
      });
      for (const provider of ['claude-code', 'codex'] as const) {
        const out = JSON.parse(await heavyCommandHook(provider, stdin, io()));
        expect(
          out.hookSpecificOutput.updatedInput,
          `${provider} ${permission_mode}`,
        ).toBeUndefined();
        expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
        expect(out.hookSpecificOutput.additionalContext).toMatch(
          /bypassPermissions or auto mode.*cleo run --wait --passthrough/s,
        );
      }
      // opencode reports no mode: context only, no command.
      const answer = JSON.parse(await heavyCommandHook('opencode', stdin, io()));
      expect(answer.command).toBeUndefined();
      expect(answer.context).toMatch(/cleo run --wait --passthrough/);
    }
  });

  it('warns instead of rewriting when a Claude Code deny or ask rule names the command', async () => {
    const write = (file: string, permissions: object) => {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify({ env: { SECRET: 'never-read' }, permissions }));
    };
    const project = join(dir, '.claude', 'settings.json');
    const user = join(dir, 'home', '.claude', 'settings.json');
    const local = join(dir, '.claude', 'settings.local.json');
    const answer = async (command: string) =>
      JSON.parse(await heavyCommandHook('claude-code', payload(command), io())).hookSpecificOutput;

    // A rule about something else leaves the rewrite alone.
    write(project, { deny: ['Bash(git push:*)', 'Read(./.env)'], allow: ['Bash(pnpm add *)'] });
    expect((await answer('pnpm add left-pad')).updatedInput).toBeDefined();

    write(project, { deny: ['Bash(pnpm add *)'] });
    const denied = await answer('pnpm add left-pad');
    expect(denied.updatedInput).toBeUndefined();
    expect(denied.additionalContext).toMatch(/deny or ask rule .* names `pnpm`/);
    expect(denied.additionalContext).not.toMatch(/never-read|pnpm add \*/);
    rmSync(project);

    write(user, { ask: ['Bash(npm install -g:*)'] });
    expect((await answer('npm install -g typescript')).updatedInput).toBeUndefined();
    rmSync(user);

    write(local, { ask: ['Bash(playwright install:*)'] });
    const pw = await answer('npx playwright install');
    expect(pw.updatedInput).toBeUndefined();
    expect(pw.additionalContext).toMatch(/names `playwright`/);
  });

  it('treats a bare Bash or Bash(*) deny/ask rule as matching every command', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    for (const rules of [{ deny: ['Bash'] }, { ask: ['Bash(*)'] }, { deny: ['Bash(*:*)'] }]) {
      writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: rules }));
      const out = JSON.parse(await heavyCommandHook('claude-code', payload('pnpm test'), io()));
      expect(out.hookSpecificOutput.updatedInput, JSON.stringify(rules)).toBeUndefined();
      expect(out.hookSpecificOutput.additionalContext).toMatch(/covers every Bash command/);
    }
  });

  it('fails safe when a settings file exists but cannot be parsed', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.local.json'), '{ "permissions": { "deny": [');
    const out = JSON.parse(await heavyCommandHook('claude-code', payload('pnpm test'), io()));
    expect(out.hookSpecificOutput.updatedInput).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toMatch(
      /settings\.local\.json could not be read or parsed/,
    );
  });

  it('warns instead of rewriting when a Codex forbidden or prompt rule names the command', async () => {
    const rules = join(dir, 'codex-home', 'rules');
    mkdirSync(rules, { recursive: true });
    writeFileSync(
      join(rules, 'default.rules'),
      'prefix_rule(pattern = ["yarn", "add"], decision = "forbidden")\n',
    );
    const out = JSON.parse(await heavyCommandHook('codex', payload('yarn add left-pad'), io()));
    expect(out.hookSpecificOutput.updatedInput).toBeUndefined();
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toMatch(/Codex rules names `yarn`/);
    // An allow-only rule file does not count.
    writeFileSync(
      join(rules, 'default.rules'),
      'prefix_rule(pattern = ["yarn", "add"], decision = "allow")\n',
    );
    const ok = JSON.parse(await heavyCommandHook('codex', payload('yarn add left-pad'), io()));
    expect(ok.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('heavyRuleWords: the leading words a rule could name', () => {
    expect(heavyRuleWords(['CI=1', 'env', 'FOO=2', 'pnpm', '--filter', 'x', 'add', 'y'])).toEqual([
      'env',
      'pnpm',
      'x',
      'add',
    ]);
    expect(heavyRuleWords(['./node_modules/.bin/vitest', 'run'])).toEqual(['vitest', 'run']);
    expect(heavyRuleWords(['nice', '-n', '10', 'npx', 'playwright', 'install'])).toEqual([
      'nice',
      'npx',
      'playwright',
      'install',
    ]);
  });

  it('sees a guarded command behind prefixes and flag values', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(npx playwright install:*)'] } }),
    );
    const out = JSON.parse(
      await heavyCommandHook('claude-code', payload('nice -n 10 npx playwright install'), io()),
    );
    expect(out.hookSpecificOutput.updatedInput).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toMatch(/names `npx`/);
  });

  it('uses CLAUDE_PROJECT_DIR for Claude Code only', async () => {
    const other = mkdtempSync(join(tmpdir(), 'cleo-hook-other-'));
    try {
      mkdirSync(join(other, '.cleo'));
      writeFileSync(
        join(other, '.cleo', 'config.json'),
        JSON.stringify({ resources: { heavyCommandHook: 'off' } }),
      );
      const env = { CLAUDE_PROJECT_DIR: other };
      expect(await heavyCommandHook('claude-code', payload('pnpm test'), io(env))).toBe('');
      // Codex ignores CLAUDE_PROJECT_DIR and reads the config at its own cwd (none): it rewrites.
      const codex = JSON.parse(await heavyCommandHook('codex', payload('pnpm test'), io(env)));
      expect(codex.hookSpecificOutput.permissionDecision).toBe('allow');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('stays silent for light and already-governed commands', async () => {
    for (const command of ['git status', 'cleo run -- pnpm test', 'echo vitest']) {
      expect(await heavyCommandHook('claude-code', payload(command), io()), command).toBe('');
    }
    expect(await heavyCommandHook('claude-code', 'garbage', io())).toBe('');
  });

  it('adds the pressure line when the machine is yellow or red', async () => {
    pressure.line = '[cleo] Machine pressure is red (test).';
    const out = JSON.parse(await heavyCommandHook('codex', payload('npx tsc --noEmit'), io()));
    expect(out.hookSpecificOutput.additionalContext).toMatch(/\n\[cleo\] Machine pressure is red/);
    expect(out.hookSpecificOutput.updatedInput.command).toBe(
      'cleo run --wait --passthrough --timeout 60 --class typecheck -- npx tsc --noEmit',
    );
  });
});

describe('runHookCli', () => {
  const capture = (stdin: string, env: Record<string, string | undefined> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: HookIo = {
      readStdin: async () => stdin,
      writeStdout: (t) => out.push(t),
      writeStderr: (t) => err.push(t),
      env: { PATH: pathWithCleo, ...env },
      cwd: dir,
    };
    return { io, out, err };
  };

  it('rejects an unknown hook or provider with exit 1', async () => {
    const a = capture('');
    expect(await runHookCli(['nope'], a.io)).toBe(1);
    expect(await runHookCli(['heavy-command', '--provider', 'vim'], a.io)).toBe(1);
    expect(a.err.join('')).toMatch(/usage: cleo hook heavy-command/);
  });

  it('answers on stdout and exits 0', async () => {
    const c = capture(payload('pnpm test'));
    expect(await runHookCli(['heavy-command', '--provider=opencode'], c.io)).toBe(0);
    expect(JSON.parse(c.out.join(''))).toMatchObject({
      command: 'cleo run --wait --passthrough --timeout 120 --class test -- pnpm test',
      timeout: 240_000,
    });
  });

  it('fails open when reading stdin throws', async () => {
    const c = capture('');
    const io: HookIo = {
      ...c.io,
      readStdin: async () => {
        throw new Error('boom');
      },
    };
    expect(await runHookCli(['heavy-command'], io)).toBe(0);
    expect(c.out).toEqual([]);
    expect(c.err.join('')).toMatch(/skipped: boom/);
  });
});
