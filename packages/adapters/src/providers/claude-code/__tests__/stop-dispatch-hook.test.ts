/**
 * Claude Code's native Stop hook is the one Stop dispatcher (T13796): a fresh
 * project gets `cleo hook stop`, and a project carrying the pre-dispatcher
 * `cleo session end --quiet` Stop entry has it replaced in place, the user's
 * own hooks untouched. The Stop never ends the session; the `SessionEnd`
 * hook does (T13913).
 *
 * @task T13796
 * @task T13913
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askEnforceHookObject } from '../../shared/heavy-command-hook-install.js';
import {
  ClaudeCodeHookProvider,
  LEGACY_NATIVE_STOP_HOOK_COMMAND,
  NATIVE_NEXUS_HOOK_COMMAND,
  NATIVE_OBSERVE_HOOK_COMMAND,
  NATIVE_SESSION_END_HOOK_COMMAND,
  NATIVE_STOP_HOOK_COMMAND,
} from '../hooks.js';

let root: string;
let projectDir: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  root = mkdtempSync(join(tmpdir(), 'cleo-stop-dispatch-'));
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', projectDir]);
  process.env.HOME = join(root, 'home');
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

type Settings = { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
const read = (): Settings =>
  JSON.parse(readFileSync(join(projectDir, '.claude', 'settings.local.json'), 'utf-8'));
const stopCommands = (s: Settings) =>
  (s.hooks.Stop ?? []).flatMap((e) => e.hooks.map((h) => h.command));
const sessionEndCommands = (s: Settings) =>
  (s.hooks.SessionEnd ?? []).flatMap((e) => e.hooks.map((h) => h.command));

describe('Claude Code Stop dispatcher hook (T13796)', () => {
  it('registers cleo hook stop as the Stop command', async () => {
    expect(NATIVE_STOP_HOOK_COMMAND).toContain('cleo hook stop --provider claude-code 2>/dev/null');
    expect(NATIVE_STOP_HOOK_COMMAND.endsWith('exit 0 # cleo-hook')).toBe(true);
    await new ClaudeCodeHookProvider().registerNativeHooks(projectDir);
    expect(stopCommands(read())).toEqual([NATIVE_STOP_HOOK_COMMAND]);
  });

  it('ends the CLEO session on SessionEnd, never on Stop (T13913)', async () => {
    expect(NATIVE_STOP_HOOK_COMMAND).not.toContain('session end');
    expect(NATIVE_SESSION_END_HOOK_COMMAND).toContain(
      'cleo hook session-end --provider claude-code >/dev/null 2>&1; exit 0',
    );
    expect(NATIVE_SESSION_END_HOOK_COMMAND.endsWith('# cleo-hook')).toBe(true);
    const provider = new ClaudeCodeHookProvider();
    await provider.registerNativeHooks(projectDir);
    expect(sessionEndCommands(read())).toEqual([NATIVE_SESSION_END_HOOK_COMMAND]);
    // Dispose removes it with the other native hooks.
    await provider.unregisterNativeHooks();
    expect(read().hooks.SessionEnd).toBeUndefined();
  });

  it('folds the old session-end and ask-enforce Stop entries into one dispatcher, keeping user hooks', async () => {
    writeFileSync(
      join(projectDir, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { matcher: '', hooks: [{ type: 'command', command: LEGACY_NATIVE_STOP_HOOK_COMMAND }] },
            { matcher: '', hooks: [{ type: 'command', command: 'my-stop.sh' }] },
            { hooks: [askEnforceHookObject('claude-code')] },
          ],
          PostToolUse: [
            {
              matcher: 'Write|Edit',
              hooks: [
                { type: 'command', command: NATIVE_OBSERVE_HOOK_COMMAND },
                { type: 'command', command: NATIVE_NEXUS_HOOK_COMMAND },
              ],
            },
          ],
        },
      }),
    );
    const provider = new ClaudeCodeHookProvider();
    await provider.registerNativeHooks(projectDir);
    const after = read();
    expect(stopCommands(after).sort()).toEqual([NATIVE_STOP_HOOK_COMMAND, 'my-stop.sh'].sort());
    // A wired project gains the SessionEnd hook that replaces the Stop's session end.
    expect(sessionEndCommands(after)).toEqual([NATIVE_SESSION_END_HOOK_COMMAND]);
    expect(JSON.stringify(after)).not.toContain(LEGACY_NATIVE_STOP_HOOK_COMMAND);
    expect(JSON.stringify(after)).not.toContain('cleo hook ask-enforce');
    expect(after.hooks.PostToolUse?.flatMap((e) => e.hooks.map((h) => h.command))).toEqual([
      NATIVE_OBSERVE_HOOK_COMMAND,
      NATIVE_NEXUS_HOOK_COMMAND,
    ]);
    // Idempotent once migrated.
    const bytes = readFileSync(join(projectDir, '.claude', 'settings.local.json'), 'utf-8');
    await provider.registerNativeHooks(projectDir);
    expect(readFileSync(join(projectDir, '.claude', 'settings.local.json'), 'utf-8')).toBe(bytes);
  });
});
