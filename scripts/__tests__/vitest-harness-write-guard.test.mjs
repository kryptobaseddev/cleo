/**
 * The vitest.setup.ts write guard covers the real harness skill dirs (T12688).
 *
 * Each case runs the setup in a child process whose HOME is a temp fixture
 * that simulates the real dirs (`~/.claude/skills`, `~/.agents/skills`,
 * `~/.gemini`, `~/.kimi`, `<config>/opencode`, `~/.pi/agent`, a registry
 * path such as `~/.codex/skills`, and an inherited `CLAUDE_HOME`). The child
 * then plants a write into each. The real harness dirs are never touched.
 *
 * @task T12688
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const setupUrl = new URL('../../vitest.setup.ts', import.meta.url).href;

/** Fixture-relative dirs that stand in for the real harness dirs. */
const HARNESS_DIRS = [
  'home/.claude/skills',
  'home/.agents/skills',
  'home/.gemini',
  'home/.kimi',
  'home/.config/opencode',
  'home/.pi/agent',
  'home/.codex/skills',
  'claude-home',
];

describe('vitest.setup.ts harness write guard (T12688)', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cleo-harness-guard-'));
    for (const dir of HARNESS_DIRS) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'sentinel'), 'real harness bytes');
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Child env: the fixture HOME stands in for the real one. */
  const fixtureEnv = () => {
    const home = join(root, 'home');
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      CLAUDE_HOME: join(root, 'claude-home'),
    };
    // This fork's own sandbox values would otherwise be read as the "real"
    // roots: the child must capture from the fixture HOME.
    for (const name of ['CLEO_TEST_PROTECTED_DATA_ROOTS', 'CLEO_HOME', 'AGENTS_HOME'])
      delete env[name];
    return env;
  };

  /**
   * Run the setup in a child under the fixture HOME, then each `ops` entry
   * (label → JS statement using `fs`, `path` and `home`). Returns label →
   * `'ok'` or the error code.
   */
  const runOps = (ops) => {
    const script = `
      await import(${JSON.stringify(setupUrl)});
      const fs = await import('node:fs');
      const path = await import('node:path');
      const home = ${JSON.stringify(join(root, 'home'))};
      const codes = {};
      for (const [label, body] of Object.entries(${JSON.stringify(ops)})) {
        try {
          new Function('fs', 'path', 'home', body)(fs, path, home);
          codes[label] = 'ok';
        } catch (err) {
          codes[label] = err.code ?? String(err);
        }
      }
      process.stdout.write(JSON.stringify(codes));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: fixtureEnv(),
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout);
  };

  /** Run the setup under the fixture HOME, then plant a write into each dir. */
  const runPlantedWrites = () => {
    const env = fixtureEnv();
    const targets = [...HARNESS_DIRS, 'home/unrelated'].map((dir) =>
      join(root, dir, 'planted', 'SKILL.md'),
    );
    const script = `
      await import(${JSON.stringify(setupUrl)});
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      const codes = {};
      for (const target of ${JSON.stringify(targets)}) {
        try {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, 'planted');
          codes[target] = 'written';
        } catch (err) {
          codes[target] = err.code;
        }
      }
      process.stdout.write(JSON.stringify({ codes, claudeHome: process.env.CLAUDE_HOME ?? null }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env,
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(child.status, child.stderr).toBe(0);
    return { targets, ...JSON.parse(child.stdout) };
  };

  it('refuses a planted write into every simulated harness dir', () => {
    const { targets, codes } = runPlantedWrites();
    for (const target of targets.slice(0, -1)) {
      expect(codes[target], target).toBe('E_TEST_REAL_DATA_WRITE');
    }
    for (const dir of HARNESS_DIRS) {
      expect(readdirSync(join(root, dir)), dir).toEqual(['sentinel']);
    }
  });

  it('still writes outside the protected dirs, so the probe is not vacuous', () => {
    const { targets, codes } = runPlantedWrites();
    expect(codes[targets.at(-1)]).toBe('written');
  });

  it('removes an inherited CLAUDE_HOME so harness paths resolve under the sandbox', () => {
    expect(runPlantedWrites().claudeHome).toBeNull();
  });

  it('refuses a symlink or hard link whose TARGET is a protected dir', () => {
    mkdirSync(join(root, 'home', 'unrelated'), { recursive: true });
    const codes = runOps({
      absolute: `fs.symlinkSync(path.join(home, '.agents/skills'), path.join(home, 'unrelated/abs'))`,
      relative: `fs.symlinkSync('../.agents/skills', path.join(home, 'unrelated/rel'))`,
      hard: `fs.linkSync(path.join(home, '.agents/skills/sentinel'), path.join(home, 'unrelated/hard'))`,
    });
    expect(codes).toEqual({
      absolute: 'E_TEST_REAL_DATA_WRITE',
      relative: 'E_TEST_REAL_DATA_WRITE',
      hard: 'E_TEST_REAL_DATA_WRITE',
    });
    expect(readdirSync(join(root, 'home', 'unrelated'))).toEqual([]);
  });

  it('refuses a write through an existing link into a protected dir, but lets the link be removed', () => {
    mkdirSync(join(root, 'home', 'unrelated'), { recursive: true });
    for (const name of ['through', 'removable']) {
      symlinkSync(join(root, 'home', '.agents', 'skills'), join(root, 'home', 'unrelated', name));
    }
    const codes = runOps({
      write: `fs.writeFileSync(path.join(home, 'unrelated/through/SKILL.md'), 'x')`,
      mkdir: `fs.mkdirSync(path.join(home, 'unrelated/through/planted/deep'), { recursive: true })`,
      unlink: `fs.unlinkSync(path.join(home, 'unrelated/removable'))`,
    });
    expect(codes).toEqual({
      write: 'E_TEST_REAL_DATA_WRITE',
      mkdir: 'E_TEST_REAL_DATA_WRITE',
      unlink: 'ok',
    });
    expect(readdirSync(join(root, 'home', '.agents', 'skills'))).toEqual(['sentinel']);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'refuses a differently-cased path on a case-insensitive file system',
    () => {
      const codes = runOps({
        cased: `fs.writeFileSync(path.join(home, '.Agents/Skills/cased.md'), 'x')`,
      });
      expect(codes).toEqual({ cased: 'E_TEST_REAL_DATA_WRITE' });
      expect(readdirSync(join(root, 'home', '.agents', 'skills'))).toEqual(['sentinel']);
    },
  );
});
