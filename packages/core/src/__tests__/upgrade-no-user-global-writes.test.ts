/**
 * `cleo upgrade` leaves user-global files and user-owned project text alone,
 * backs up what it does change, and is idempotent (T13409).
 *
 * The incident: a post-update upgrade rewrote the owner's `~/.claude/CLAUDE.md`
 * into an inlined CAAMP block, replaced the `@path` references in the tracked
 * AGENTS.md / CLAUDE.md / GEMINI.md with inlined protocol text, reset
 * `.cleo/.gitignore` and `.worktreeinclude` to the template, and regenerated
 * `.cleo/project-context.json` without `build.outputDir` — with no backup.
 *
 * Each test runs `runUpgrade` against a sandboxed HOME and a fixture project
 * and compares byte snapshots.
 *
 * @task T13409
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUpgrade } from '../upgrade.js';

let isolatedRoot: string;
let home: string;
let project: string;

/**
 * Directories under HOME that CLEO owns as data (the canonical skills store and
 * the agent-definition links). Everything else under HOME must be untouched.
 */
const CLEO_OWNED_UNDER_HOME = ['.cleo', '.agents/skills', '.agents/agents', '.agents/.caamp'];

/** Path → content digest (files), link target (symlinks) or `dir`. */
function snapshot(root: string, exclude: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(root, abs);
      if (exclude.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
      // SQLite stores and their WAL sidecars change whenever they are opened.
      if (/\.db(-shm|-wal|-journal)?$/.test(name)) continue;
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) out.set(rel, `link:${readlinkSync(abs)}`);
      else if (stat.isDirectory()) {
        out.set(rel, 'dir');
        walk(abs);
      } else out.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

/** Entries that differ between two snapshots, for a readable failure. */
function diff(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, digest] of after) {
    if (before.get(path) !== digest) changed.push(before.has(path) ? `M ${path}` : `A ${path}`);
  }
  for (const path of before.keys()) if (!after.has(path)) changed.push(`D ${path}`);
  return changed.sort();
}

const USER_GLOBAL_CLAUDE = '# My global Claude rules\n\nNever touch this file.\n';
const USER_GLOBAL_CODEX = '# My Codex rules\n';
const USER_GLOBAL_GEMINI = '# My Gemini rules\n';
const USER_HUB =
  '<!-- CAAMP:START -->\n@~/.cleo/templates/CLEO-INJECTION.md\n<!-- CAAMP:END -->\n\n# Owner hub rule\n';

const AGENTS_MD =
  '<!-- CAAMP:START -->\n@~/.agents/AGENTS.md\n@.cleo/project-context.json\n# Run: cleo memory digest\n<!-- CAAMP:END -->\n\n# Project rules (user text)\n\n- keep me\n';
/** An existing project's settings (memory bridge in its default `cli` mode). */
const CONFIG = { brain: { memoryBridge: { mode: 'cli' } } };
const CLAUDE_MD =
  '<!-- CAAMP:START -->\n@AGENTS.md\n<!-- CAAMP:END -->\n\n## Release Workflow (user text)\n';
const GEMINI_MD = '<!-- CAAMP:START -->\n@AGENTS.md\n<!-- CAAMP:END -->\n';
const GITIGNORE = '# user header\n*\n!.gitignore\n!my-own-file.txt\n';
const WORKTREEINCLUDE = '# mine first\n.env.local\n.idea/\n';
const PROJECT_CONTEXT = {
  schemaVersion: '1.0.0',
  detectedAt: '2026-01-01T00:00:00.000Z',
  projectTypes: ['node'],
  primaryType: 'node',
  monorepo: false,
  testing: { framework: 'vitest', command: 'pnpm run test' },
  build: { command: 'pnpm run build', outputDir: 'dist' },
  customOwnerKey: { keep: true },
};

beforeAll(() => {
  isolatedRoot = mkdtempSync(join(process.env['CLEO_HOME'] ?? tmpdir(), 'upgrade-no-global-'));
});

afterAll(() => {
  rmSync(isolatedRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  // AGENTS_HOME is left unset so the hub resolves to HOME/.agents, as on a real machine.
  vi.stubEnv('AGENTS_HOME', undefined);
  const run = mkdtempSync(join(isolatedRoot, 'run-'));
  home = join(run, 'home');
  project = join(run, 'project');
  const roots: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    CLEO_HOME: join(run, 'cleo'),
    XDG_DATA_HOME: join(run, 'data-home'),
    XDG_CONFIG_HOME: join(run, 'config-home'),
    XDG_CACHE_HOME: join(run, 'cache-home'),
  };
  for (const [name, dir] of Object.entries(roots)) {
    mkdirSync(dir, { recursive: true });
    vi.stubEnv(name, dir);
  }
  for (const name of [
    'CLAUDE_HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'HERMES_HOME',
    'PI_CODING_AGENT_DIR',
    'PI_HOME',
  ]) {
    vi.stubEnv(name, undefined);
  }

  // User-global provider files the owner wrote by hand.
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), USER_GLOBAL_CLAUDE);
  writeFileSync(join(home, '.claude', 'settings.json'), '{"theme":"dark"}\n');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'AGENTS.md'), USER_GLOBAL_CODEX);
  mkdirSync(join(home, '.gemini'), { recursive: true });
  writeFileSync(join(home, '.gemini', 'GEMINI.md'), USER_GLOBAL_GEMINI);
  mkdirSync(join(home, '.agents'), { recursive: true });
  writeFileSync(join(home, '.agents', 'AGENTS.md'), USER_HUB);
  writeFileSync(join(home, 'NOTES.md'), '# home notes\n');
  // The installed protocol the hub references, so every delivery resolves and
  // upgrade really reaches the project files (a failed resolve skips them all).
  mkdirSync(join(home, '.cleo', 'templates'), { recursive: true });
  writeFileSync(join(home, '.cleo', 'templates', 'CLEO-INJECTION.md'), '# CLEO protocol\n');

  // A project whose tracked files carry user text and reference-form blocks.
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(project, '.cleo'), { recursive: true });
  writeFileSync(join(project, 'AGENTS.md'), AGENTS_MD);
  writeFileSync(join(project, 'CLAUDE.md'), CLAUDE_MD);
  writeFileSync(join(project, 'GEMINI.md'), GEMINI_MD);
  writeFileSync(join(project, '.cleo', '.gitignore'), GITIGNORE);
  writeFileSync(join(project, '.worktreeinclude'), WORKTREEINCLUDE);
  writeFileSync(join(project, '.cleo', 'config.json'), JSON.stringify(CONFIG, null, 2));
  writeFileSync(
    join(project, '.cleo', 'project-context.json'),
    JSON.stringify(PROJECT_CONTEXT, null, 2),
  );
});

afterEach(async () => {
  try {
    const { closeAllDatabases } = await import('../store/sqlite.js');
    await closeAllDatabases();
  } catch {
    /* module may not be loaded */
  }
  vi.unstubAllEnvs();
});

describe('runUpgrade never writes user-global files (T13409 AC1)', () => {
  it('leaves every byte under HOME unchanged outside CLEO-owned data dirs', async () => {
    const before = snapshot(home, CLEO_OWNED_UNDER_HOME);
    await runUpgrade({ cwd: project });
    expect(diff(before, snapshot(home, CLEO_OWNED_UNDER_HOME))).toEqual([]);
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf-8')).toBe(USER_GLOBAL_CLAUDE);
  });
});

describe('runUpgrade preserves user-owned project text (T13409 AC2/AC4)', () => {
  it('keeps the @path reference blocks and the user text in AGENTS.md, CLAUDE.md, GEMINI.md', async () => {
    const result = await runUpgrade({ cwd: project });
    // The refresh ran (a failed delivery would skip the files and pass vacuously).
    expect(result.actions.find((a) => a.action === 'injection_refresh')?.details).not.toMatch(
      /delivery failed/i,
    );
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf-8')).toBe(AGENTS_MD);
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf-8')).toBe(CLAUDE_MD);
    expect(readFileSync(join(project, 'GEMINI.md'), 'utf-8')).toBe(GEMINI_MD);
  });

  it('keeps an embedded block embedded and the text outside its markers byte-identical', async () => {
    const source = join(project, 'old-source.md');
    writeFileSync(source, 'old\n');
    const stamp = `<!-- CAAMP:SOURCE ${encodeURIComponent(source)} ${'0'.repeat(64)} -->`;
    const before = '# heading the user wrote\n\n';
    const after = '\n\n## user notes below the block\n';
    writeFileSync(
      join(project, 'CLAUDE.md'),
      `${before}<!-- CAAMP:START -->\n${stamp}\nstale embedded text\n<!-- CAAMP:END -->${after}`,
    );
    await runUpgrade({ cwd: project });
    const text = readFileSync(join(project, 'CLAUDE.md'), 'utf-8');
    expect(text.startsWith(`${before}<!-- CAAMP:START -->\n<!-- CAAMP:SOURCE `)).toBe(true);
    expect(text.endsWith(`<!-- CAAMP:END -->${after}`)).toBe(true);
    expect(text).not.toContain('stale embedded text');
  });

  it('leaves an instruction file without CAAMP markers untouched', async () => {
    const userOnly = '# Gemini notes the user keeps without markers\n';
    writeFileSync(join(project, 'GEMINI.md'), userOnly);
    await runUpgrade({ cwd: project });
    expect(readFileSync(join(project, 'GEMINI.md'), 'utf-8')).toBe(userOnly);
  });

  it('embeds the references only when the project opted in (injection.delivery)', async () => {
    writeFileSync(
      join(project, '.cleo', 'config.json'),
      JSON.stringify({ ...CONFIG, injection: { delivery: 'embedded' } }),
    );
    await runUpgrade({ cwd: project });
    const text = readFileSync(join(project, 'AGENTS.md'), 'utf-8');
    expect(text).toContain('<!-- CAAMP:SOURCE ');
    expect(text.endsWith('<!-- CAAMP:END -->\n\n# Project rules (user text)\n\n- keep me\n')).toBe(
      true,
    );
  });

  it('only appends missing CLEO-required lines to .cleo/.gitignore and .worktreeinclude', async () => {
    await runUpgrade({ cwd: project });
    const gitignore = readFileSync(join(project, '.cleo', '.gitignore'), 'utf-8');
    expect(gitignore.startsWith(GITIGNORE)).toBe(true);
    expect(gitignore).toContain('\n!project-context.json\n');
    const include = readFileSync(join(project, '.worktreeinclude'), 'utf-8');
    expect(include.startsWith(WORKTREEINCLUDE)).toBe(true);
  });

  it('keeps every project-context.json key, value and order (build.outputDir survives)', async () => {
    await runUpgrade({ cwd: project, forceDetect: true });
    const after = JSON.parse(readFileSync(join(project, '.cleo', 'project-context.json'), 'utf-8'));
    expect(after.build.outputDir).toBe('dist');
    expect(after.customOwnerKey).toEqual({ keep: true });
    const keys = Object.keys(after);
    expect(keys.slice(0, Object.keys(PROJECT_CONTEXT).length)).toEqual(
      Object.keys(PROJECT_CONTEXT),
    );
  });
});

describe('runUpgrade is idempotent and backs up what it changes (T13409 AC3/AC5)', () => {
  it('a second run applies nothing and changes no byte in the project or HOME', async () => {
    const first = await runUpgrade({ cwd: project });
    const projectBefore = snapshot(project, ['.cleo/backups', '.cleo/logs', '.cleo/.git']);
    const homeBefore = snapshot(home, CLEO_OWNED_UNDER_HOME);
    const second = await runUpgrade({ cwd: project });
    expect(
      second.actions.filter((a) => a.status === 'applied').map((a) => a.action),
      JSON.stringify(first.actions.filter((a) => a.status === 'applied')),
    ).toEqual([]);
    expect(second.applied).toBe(0);
    expect(
      diff(projectBefore, snapshot(project, ['.cleo/backups', '.cleo/logs', '.cleo/.git'])),
    ).toEqual([]);
    expect(diff(homeBefore, snapshot(home, CLEO_OWNED_UNDER_HOME))).toEqual([]);
    expect(second.fileChanges).toEqual([]);
  });

  it('lists every changed file with a backup holding its previous bytes', async () => {
    const result = await runUpgrade({ cwd: project });
    const gitignorePath = join(project, '.cleo', '.gitignore');
    const change = result.fileChanges.find((entry) => entry.path === gitignorePath);
    expect(change?.backupPath).toBeTruthy();
    expect(readFileSync(change?.backupPath ?? '', 'utf-8')).toBe(GITIGNORE);
    for (const entry of result.fileChanges) {
      if (entry.backupPath !== null) expect(existsSync(entry.backupPath)).toBe(true);
    }
  });
});
