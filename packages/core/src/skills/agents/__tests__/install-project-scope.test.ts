/**
 * The core agent installer writes the PROJECT's `.claude/agents/` and never
 * the user-global Claude config (T13241). HOME, CLAUDE_HOME and the project
 * root (CLEO_ROOT) are sandboxed; the user-global dir is snapshotted (bytes,
 * link targets, mtimes) before and compared after. The real `~/.claude` is
 * never read.
 *
 * @task T13241
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installAgent, installAllAgents, uninstallAgent } from '../install.js';

const SAVED = ['HOME', 'USERPROFILE', 'CLAUDE_HOME', 'CLEO_ROOT', 'CLEO_DIR'] as const;
let saved: Record<string, string | undefined>;
let root: string;
let home: string;
let claudeHome: string;
let project: string;

/** Every entry under `dir`, as path → content or link target + mtime. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf-8' })) {
    const path = join(dir, name);
    const st = lstatSync(path);
    out[name] = st.isSymbolicLink()
      ? `link:${readlinkSync(path)}@${st.mtimeMs}`
      : st.isDirectory()
        ? `dir@${st.mtimeMs}`
        : `${readFileSync(path, 'base64')}@${st.mtimeMs}`;
  }
  return out;
}

function addAgent(dir: string, name: string): string {
  const agentDir = join(dir, 'agents', name);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'AGENT.md'), `---\nname: ${name}\n---\n`);
  return agentDir;
}

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  root = mkdtempSync(join(tmpdir(), 'cleo-agents-scope-'));
  home = join(root, 'home');
  claudeHome = join(home, '.claude');
  project = join(root, 'project');
  mkdirSync(join(claudeHome, 'agents'), { recursive: true });
  writeFileSync(join(claudeHome, 'settings.json'), '{"model":"opus"}');
  mkdirSync(project, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_HOME = claudeHome;
  process.env.CLEO_ROOT = project;
  delete process.env.CLEO_DIR;
});

afterEach(() => {
  for (const k of SAVED) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('agent install is project-scoped (T13241)', () => {
  it('installAllAgents and uninstallAgent use <project>/.claude/agents; CLAUDE_HOME is unchanged', () => {
    const src = addAgent(project, 'reviewer');
    const before = snapshot(claudeHome);

    const results = installAllAgents(project);

    expect(results).toEqual([{ name: 'reviewer', installed: true, error: undefined }]);
    const link = join(project, '.claude', 'agents', 'reviewer');
    expect(readlinkSync(link)).toBe(src);
    expect(uninstallAgent('reviewer', project)).toBe(true);
    expect(existsSync(link)).toBe(false);
    expect(snapshot(claudeHome)).toEqual(before);
  });

  it('a project that is the home directory is refused: nothing written under ~/.claude', () => {
    process.env.CLEO_ROOT = home;
    const src = addAgent(home, 'reviewer');
    const before = snapshot(claudeHome);

    const r = installAgent(src, home);

    expect(r.installed).toBe(false);
    expect(r.error).toMatch(/the project is the home directory/);
    expect(installAllAgents(home)[0]?.installed).toBe(false);
    expect(snapshot(claudeHome)).toEqual(before);
  });

  it('CLAUDE_HOME pointing at the project .claude is refused', () => {
    process.env.CLAUDE_HOME = join(project, '.claude');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const before = snapshot(join(project, '.claude'));

    const r = installAgent(addAgent(project, 'reviewer'), project);

    expect(r.installed).toBe(false);
    expect(r.error).toMatch(/inside the user-global Claude config dir/);
    expect(snapshot(join(project, '.claude'))).toEqual(before);
  });

  it('uninstall never removes a user-global agent link, even when asked by a home project', () => {
    const elsewhere = addAgent(join(root, 'other'), 'mine');
    symlinkSync(elsewhere, join(claudeHome, 'agents', 'mine'));
    process.env.CLEO_ROOT = home;
    const before = snapshot(claudeHome);

    expect(uninstallAgent('mine', home)).toBe(false);
    expect(snapshot(claudeHome)).toEqual(before);
  });

  it('a differently cased spelling of the Claude dir is refused on a case-insensitive volume', (ctx) => {
    const variant = join(home, '.CLAUDE');
    if (!existsSync(variant)) ctx.skip();
    process.env.CLEO_ROOT = variant;
    const before = snapshot(claudeHome);

    const r = installAgent(addAgent(join(root, 'src'), 'reviewer'), variant);

    expect(r.installed).toBe(false);
    expect(snapshot(claudeHome)).toEqual(before);
  });
});
