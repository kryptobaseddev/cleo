/**
 * The global bootstrap never writes a user-global instruction file (T13409).
 *
 * `cleo self-update` runs `npm install -g`, whose postinstall runs
 * `bootstrapGlobalCleo({})`. Until T13409 that regenerated every provider's
 * global instruction file through `syncGlobalInstructions`, which is how the
 * owner's `~/.claude/CLAUDE.md` was rewritten into an inlined CAAMP block.
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
import { bootstrapGlobalCleo } from '../bootstrap.js';
import { resolveSkillsRoot } from '../skills/skill-root.js';

let isolatedRoot: string;
let home: string;

/** CLEO's own data under HOME: the `~/.cleo` link and the canonical skill store. */
const CLEO_OWNED_UNDER_HOME = ['.cleo', '.agents/skills', '.agents/agents', '.agents/.caamp'];

const USER_CLAUDE =
  '<!-- CAAMP:START -->\n@~/.agents/AGENTS.md\n<!-- CAAMP:END -->\n\n# My global Claude rules\n';
const USER_CODEX = '# My Codex rules\n';
const USER_HUB = '<!-- CAAMP:START -->\n@~/.cleo/templates/CLEO-INJECTION.md\n<!-- CAAMP:END -->\n';

function snapshot(root: string, exclude: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(root, abs);
      if (exclude.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
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

function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [path, digest] of after) if (before.get(path) !== digest) out.push(path);
  for (const path of before.keys()) if (!after.has(path)) out.push(`-${path}`);
  return out.sort();
}

beforeAll(() => {
  isolatedRoot = mkdtempSync(join(process.env['CLEO_HOME'] ?? tmpdir(), 'bootstrap-no-global-'));
});

afterAll(() => {
  rmSync(isolatedRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  const run = mkdtempSync(join(isolatedRoot, 'run-'));
  home = join(run, 'home');
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
  for (const name of ['AGENTS_HOME', 'CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    vi.stubEnv(name, undefined);
  }
  const { _resetPlatformPathsCache } = await import('../system/platform-paths.js');
  _resetPlatformPathsCache();

  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), USER_CLAUDE);
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'AGENTS.md'), USER_CODEX);
  mkdirSync(join(home, '.agents'), { recursive: true });
  writeFileSync(join(home, '.agents', 'AGENTS.md'), USER_HUB);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const { _resetPlatformPathsCache } = await import('../system/platform-paths.js');
  _resetPlatformPathsCache();
});

describe('bootstrapGlobalCleo (npm postinstall, self-update) — T13409', () => {
  it('changes no byte under HOME outside CLEO-owned data, and names the owner command', async () => {
    const before = snapshot(home, CLEO_OWNED_UNDER_HOME);
    const ctx = await bootstrapGlobalCleo({});
    const after = snapshot(home, CLEO_OWNED_UNDER_HOME);
    // Only new links into CLEO's own skill store (and their parent dirs) may appear.
    const root = resolveSkillsRoot();
    const illegal = changed(before, after).filter((path) => {
      const value = after.get(path);
      if (value?.startsWith('link:')) return !value.slice(5).startsWith(`${root}/`);
      return value !== 'dir' || before.has(path);
    });
    expect(illegal).toEqual([]);
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf-8')).toBe(USER_CLAUDE);
    expect(ctx.warnings.join('\n')).toContain('caamp instructions update --global');
  });

  it('never rewrites a provider instruction file even when the user runs install-global', async () => {
    await bootstrapGlobalCleo({ userRequested: true });
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf-8')).toBe(USER_CLAUDE);
    expect(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf-8')).toBe(USER_CODEX);
  });
});
