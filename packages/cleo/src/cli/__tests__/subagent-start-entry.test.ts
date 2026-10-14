/**
 * T13667 — `cleo hook subagent-start`: lean rules for harness-spawned
 * subagents, level-aware, matcher-scoped, fail-open.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('reads the session level of the session bound to CLAUDE_CODE_SESSION_ID', async () => {
    // Only the harness key names the caller, as under Claude Code's Agent tool.
    const harness = { CLAUDE_CODE_SESSION_ID: 'cc-subagent-test' };
    const { SESSION_ENV_KEY_PRECEDENCE } = await import('@cleocode/core/sessions/session-id.js');
    const { TERMINAL_KEY_SOURCES } = await import('@cleocode/core/sessions/terminal-identity.js');
    for (const name of [
      ...SESSION_ENV_KEY_PRECEDENCE,
      ...TERMINAL_KEY_SOURCES.map((k) => k.envVar),
      'CLEO_DIR',
      'CLEO_ROOT',
    ]) {
      vi.stubEnv(name, undefined);
    }
    writeFileSync(
      join(root, '.cleo', 'config.json'),
      JSON.stringify({ enforcement: { session: { requiredForMutate: false } } }),
    );
    try {
      const { sessionStart } = await import('@cleocode/core/internal');
      for (const [k, v] of Object.entries(harness)) vi.stubEnv(k, v);
      const started = await sessionStart(root, { scope: 'global', name: 'subagent-start' });
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined);
      const sessionId = started.data?.id;
      expect(sessionId).toBeTruthy();
      const { setLeanLevel } = await import('@cleocode/core/orchestration/lean-change.js');
      await setLeanLevel({ projectRoot: root, level: 'ultra', scope: 'session', sessionId });

      const out = JSON.parse(await subagentStartHook('{}', harness, root));
      expect(out.hookSpecificOutput.additionalContext).toContain('(ct-lean, ultra)');
      // A different harness session is not bound, so it gets the default level.
      const other = JSON.parse(
        await subagentStartHook('{}', { CLAUDE_CODE_SESSION_ID: 'cc-other' }, root),
      );
      expect(other.hookSpecificOutput.additionalContext).toContain('## Lean Change (ct-lean)');
    } finally {
      vi.unstubAllEnvs();
      const { closeAllDatabases } = await import('@cleocode/core/store/sqlite.js');
      await closeAllDatabases();
    }
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
