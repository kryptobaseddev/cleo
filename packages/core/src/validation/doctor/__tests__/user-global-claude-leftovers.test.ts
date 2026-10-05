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

  it('a malformed settings file is reported as not checked, never touched', () => {
    writeFileSync(settingsPath, '{ not json');
    const r = checkUserGlobalClaudeLeftovers(claudeHome);
    expect(r.status).toBe('passed');
    expect(r.message).toContain('not checked');
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ not json');
  });
});
