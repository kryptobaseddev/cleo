/**
 * Claude Code's native Stop hook is the one Stop dispatcher (T13796): a fresh
 * project gets `cleo hook stop`, and a project carrying the pre-dispatcher
 * `cleo session end --quiet` Stop entry has it replaced in place, the user's
 * own hooks untouched.
 *
 * @task T13796
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeCodeHookProvider,
  LEGACY_NATIVE_STOP_HOOK_COMMAND,
  NATIVE_NEXUS_HOOK_COMMAND,
  NATIVE_OBSERVE_HOOK_COMMAND,
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

describe('Claude Code Stop dispatcher hook (T13796)', () => {
  it('registers cleo hook stop as the Stop command', async () => {
    expect(NATIVE_STOP_HOOK_COMMAND).toBe('cleo hook stop --provider claude-code # cleo-hook');
    await new ClaudeCodeHookProvider().registerNativeHooks(projectDir);
    expect(stopCommands(read())).toEqual([NATIVE_STOP_HOOK_COMMAND]);
  });

  it('replaces a pre-dispatcher session-end Stop entry in place and keeps user hooks', async () => {
    writeFileSync(
      join(projectDir, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { matcher: '', hooks: [{ type: 'command', command: LEGACY_NATIVE_STOP_HOOK_COMMAND }] },
            { matcher: '', hooks: [{ type: 'command', command: 'my-stop.sh' }] },
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
    expect(JSON.stringify(after)).not.toContain(LEGACY_NATIVE_STOP_HOOK_COMMAND);
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
