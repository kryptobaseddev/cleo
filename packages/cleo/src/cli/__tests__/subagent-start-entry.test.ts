/**
 * T13667 — `cleo hook subagent-start`: lean rules for harness-spawned
 * subagents, level-aware, matcher-scoped, fail-open.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HookIo, runHookCli } from '../hook-entry.js';
import { subagentInScope, subagentStartHook } from '../subagent-start-entry.js';

describe('subagentInScope (T13667)', () => {
  it('injects by default and on any doubt', () => {
    expect(subagentInScope(undefined, 'Explore')).toBe(true);
    expect(subagentInScope('explore', '')).toBe(true);
    expect(subagentInScope('([', 'Explore')).toBe(true); // invalid regex
    expect(subagentInScope('x'.repeat(201), 'Explore')).toBe(true); // too long
  });

  it('skips only a definite mismatch', () => {
    expect(subagentInScope('explore|general', 'Explore')).toBe(true);
    expect(subagentInScope('^general$', 'Explore')).toBe(false);
  });
});

describe('subagentStartHook (T13667)', () => {
  let root: string;
  let home: string;
  const saved = process.env.CLEO_HOME;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'subagent-start-'));
    home = mkdtempSync(join(tmpdir(), 'subagent-start-home-'));
    mkdirSync(join(root, '.cleo'));
    process.env.CLEO_HOME = home;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLEO_HOME;
    else process.env.CLEO_HOME = saved;
  });

  it('injects the full rules as SubagentStart additionalContext', async () => {
    const out = JSON.parse(await subagentStartHook('{"agent_type":"Explore"}', {}, root));
    expect(out.hookSpecificOutput.hookEventName).toBe('SubagentStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('## Lean Change (ct-lean)');
  });

  it('follows the level: ultra from config, nothing at off from env', async () => {
    writeFileSync(join(root, '.cleo', 'config.json'), JSON.stringify({ lean: { level: 'ultra' } }));
    const ultra = JSON.parse(await subagentStartHook('{}', {}, root));
    expect(ultra.hookSpecificOutput.additionalContext).toContain('(ct-lean, ultra)');
    expect(await subagentStartHook('{}', { CLEO_LEAN_LEVEL: 'off' }, root)).toBe('');
  });

  it('respects the matcher', async () => {
    const env = { CLEO_LEAN_SUBAGENT_MATCHER: '^general' };
    expect(await subagentStartHook('{"agent_type":"Explore"}', env, root)).toBe('');
    expect(await subagentStartHook('{"agent_type":"general-purpose"}', env, root)).not.toBe('');
  });
});

describe('runHookCli subagent-start (T13667)', () => {
  function io(stdin: string, cwd: string) {
    const out: string[] = [];
    const hookIo: HookIo = {
      readStdin: async () => stdin,
      writeStdout: (t) => out.push(t),
      writeStderr: () => {},
      env: {},
      cwd,
    };
    return { hookIo, out };
  }

  it('answers for claude-code, fails open on garbage, rejects other providers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-start-cli-'));
    const savedHome = process.env.CLEO_HOME;
    process.env.CLEO_HOME = dir;
    try {
      const ok = io('}{', dir);
      expect(await runHookCli(['subagent-start', '--provider', 'claude-code'], ok.hookIo)).toBe(0);
      expect(ok.out.join('')).toContain('SubagentStart');
      expect(
        await runHookCli(['subagent-start', '--provider', 'codex'], io('{}', dir).hookIo),
      ).toBe(1);
    } finally {
      if (savedHome === undefined) delete process.env.CLEO_HOME;
      else process.env.CLEO_HOME = savedHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
