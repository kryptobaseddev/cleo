/**
 * `cleo doctor` reports what an old CLEO left in the user-global Claude
 * settings, and never writes there (T13221). Every case uses a sandboxed
 * Claude dir; the real `~/.claude` is never read.
 *
 * @task T13221
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkUserGlobalClaudeLeftovers } from '../checks.js';

let claudeHome: string;
let settingsPath: string;

beforeEach(() => {
  claudeHome = join(mkdtempSync(join(tmpdir(), 'cleo-claude-home-')), '.claude');
  mkdirSync(join(claudeHome, 'hooks'), { recursive: true });
  settingsPath = join(claudeHome, 'settings.json');
});

afterEach(() => {
  rmSync(join(claudeHome, '..'), { recursive: true, force: true });
});

/** The literal shell word `${HOME}` (built so it is not a template placeholder). */
const BRACED_HOME = ['$', '{HOME}'].join('');

/** What a pre-T13128 CLEO's Claude Code install could write, beside user content. */
const OLD_SETTINGS = {
  model: 'opus',
  enabledPlugins: { 'cleo@cleocode': true, 'other@market': true },
  hooks: {
    PreCompact: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: '"/Users/x/.claude/hooks/precompact-safestop.sh" # cleo-hook',
            timeout: 30,
          },
        ],
      },
      { matcher: '', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] },
    ],
  },
};

describe('checkUserGlobalClaudeLeftovers (T13221)', () => {
  it('reports the plugin enable, the PreCompact cleo-hook and the hook scripts with manual steps', () => {
    writeFileSync(settingsPath, JSON.stringify(OLD_SETTINGS, null, 2));
    writeFileSync(join(claudeHome, 'hooks', 'precompact-safestop.sh'), '#!/bin/sh\n');
    writeFileSync(join(claudeHome, 'hooks', 'cleo-precompact-core.sh'), '#!/bin/sh\n');

    const r = checkUserGlobalClaudeLeftovers(claudeHome);

    expect(r.status).toBe('warning');
    expect(r.message).toContain('4 entries');
    expect(r.fix).toContain(`delete the "cleo@cleocode": true entry from "enabledPlugins"`);
    expect(r.fix).toContain('precompact-safestop.sh\\" # cleo-hook');
    expect(r.fix).toContain(`delete ${join(claudeHome, 'hooks', 'precompact-safestop.sh')}`);
    expect(r.fix).toContain(`delete ${join(claudeHome, 'hooks', 'cleo-precompact-core.sh')}`);
    // The user's own plugin and hook are not CLEO's.
    expect(r.fix).not.toContain('other@market');
    expect(r.fix).not.toContain('my-own-hook.sh');
  });

  it('never writes or deletes anything in the user-global Claude dir', () => {
    const bytes = JSON.stringify(OLD_SETTINGS, null, 2);
    writeFileSync(settingsPath, bytes);
    const script = join(claudeHome, 'hooks', 'precompact-safestop.sh');
    writeFileSync(script, '#!/bin/sh\n');
    const before = statSync(settingsPath).mtimeMs;

    checkUserGlobalClaudeLeftovers(claudeHome);

    expect(readFileSync(settingsPath, 'utf-8')).toBe(bytes);
    expect(statSync(settingsPath).mtimeMs).toBe(before);
    expect(readFileSync(script, 'utf-8')).toBe('#!/bin/sh\n');
  });

  it('passes when nothing of CLEO is there, or there is nothing to read', () => {
    expect(checkUserGlobalClaudeLeftovers(claudeHome).status).toBe('passed');
    writeFileSync(
      settingsPath,
      JSON.stringify({ enabledPlugins: { 'other@market': true }, hooks: {} }),
    );
    expect(checkUserGlobalClaudeLeftovers(claudeHome).status).toBe('passed');
  });

  it('a malformed settings file is a warning naming the repair, never touched', () => {
    writeFileSync(settingsPath, '{ not json');
    const r = checkUserGlobalClaudeLeftovers(claudeHome);
    expect(r.status).toBe('warning');
    expect(r.message).toContain('not valid JSON');
    expect(r.fix).toContain(`repair the JSON in ${settingsPath}`);
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ not json');
  });

  it('a top-level non-object settings file is a warning too', () => {
    writeFileSync(settingsPath, '[]');
    expect(checkUserGlobalClaudeLeftovers(claudeHome).status).toBe('warning');
  });

  it('reports the Stop and PostToolUse cleo-hooks registerNativeHooks wrote, one step per hook object', () => {
    // The exact commands from packages/adapters/src/providers/claude-code/hooks.ts.
    const stop = 'cleo session end --quiet # cleo-hook';
    const observe =
      'cleo observe "File modified via $TOOL_NAME" --title "tool-use" --quiet # cleo-hook';
    const nexus =
      'cleo nexus analyze --incremental --json > /dev/null 2>&1 && cleo observe "NEXUS re-indexed after $TOOL_NAME on $TOOL_INPUT_file_path" --title "nexus-post-check" --quiet # cleo-hook';
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: '', hooks: [{ type: 'command', command: stop }] }],
          PostToolUse: [
            {
              matcher: 'Write|Edit',
              hooks: [
                { type: 'command', command: observe },
                { type: 'command', command: 'prettier --write "$TOOL_INPUT_file_path"' },
                { type: 'command', command: nexus },
              ],
            },
          ],
        },
      }),
    );

    const r = checkUserGlobalClaudeLeftovers(claudeHome);

    expect(r.status).toBe('warning');
    expect(r.message).toContain('3 entries');
    const found = (r.details as { found: string[] }).found;
    expect(found).toEqual([
      `Stop hook ${stop}`,
      `PostToolUse hook ${observe}`,
      `PostToolUse hook ${nexus}`,
    ]);
    expect(r.fix).toContain('under "hooks.Stop" (matcher "")');
    expect(r.fix).toContain('under "hooks.PostToolUse" (matcher "Write|Edit")');
    expect(r.fix).toContain(`remove the one hook object whose command is ${JSON.stringify(nexus)}`);
    expect(r.fix).toContain('delete the entry if its "hooks" array is left empty');
    // The user's own hook sharing that entry is not CLEO's and must survive.
    expect(r.fix).not.toContain('prettier');
  });

  it('an unmarked safestop counts only as the exact CLEO path, under PreCompact', () => {
    const exact = join(claudeHome, 'hooks', 'precompact-safestop.sh');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreCompact: [
            {
              matcher: '',
              hooks: [
                { type: 'command', command: `"${exact}"` },
                { type: 'command', command: '/opt/mine/my-precompact-safestop.sh' },
                { type: 'command', command: 'echo precompact-safestop.sh' },
              ],
            },
          ],
          Stop: [{ matcher: '', hooks: [{ type: 'command', command: exact }] }],
        },
      }),
    );

    const found = (checkUserGlobalClaudeLeftovers(claudeHome).details as { found: string[] }).found;

    expect(found).toEqual([`PreCompact hook "${exact}"`]);
  });

  it('an unmarked safestop in the hand-written template forms (~/, $HOME/, single quotes) is found', () => {
    const savedHome = process.env.HOME;
    process.env.HOME = join(claudeHome, '..');
    try {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreCompact: [
              {
                hooks: [
                  { type: 'command', command: '~/.claude/hooks/precompact-safestop.sh' },
                  { type: 'command', command: '"$HOME/.claude/hooks/precompact-safestop.sh"' },
                  {
                    type: 'command',
                    command: `'${BRACED_HOME}/.claude/hooks/precompact-safestop.sh'`,
                  },
                  { type: 'command', command: '~/.claude/hooks/mine.sh' },
                ],
              },
            ],
          },
        }),
      );

      const r = checkUserGlobalClaudeLeftovers(claudeHome);

      const found = (r.details as { found: string[] }).found;
      expect(found).toEqual([
        'PreCompact hook ~/.claude/hooks/precompact-safestop.sh',
        'PreCompact hook "$HOME/.claude/hooks/precompact-safestop.sh"',
        `PreCompact hook '${BRACED_HOME}/.claude/hooks/precompact-safestop.sh'`,
      ]);
      // The entry has no matcher key; the step says so instead of `matcher ""`.
      expect(r.fix).toContain('under "hooks.PreCompact" (no matcher)');
      expect(r.fix).not.toContain('matcher ""');
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});
