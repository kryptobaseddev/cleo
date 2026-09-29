/**
 * Tests for `scripts/lint-skill-coverage.mjs` (T12124).
 *
 * @task T12124
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkDeclarations,
  checkPullRequest,
  globToRegExp,
  runGate,
} from '../lint-skill-coverage.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'lint-skill-coverage.mjs');

describe('lint-skill-coverage on the real repository', () => {
  it('every core and LOOM skill declares live covers', () => {
    expect(checkDeclarations(REPO)).toEqual([]);
  });

  it('exits 0 in --check mode', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });
});

describe('globToRegExp', () => {
  it.each([
    ['packages/core/src/**', 'packages/core/src/a/b.ts', true],
    ['packages/core/src/**/x.ts', 'packages/core/src/x.ts', true],
    ['packages/*/src/x.ts', 'packages/core/src/x.ts', true],
    ['packages/*/src/x.ts', 'packages/core/lib/src/x.ts', false],
    ['a.ts', 'b/a.ts', false],
  ])('%s vs %s → %s', (glob, path, want) => {
    expect(globToRegExp(glob).test(path)).toBe(want);
  });
});

describe('lint-skill-coverage in a git repository (PR mode)', () => {
  let root;

  /** Run git in the fixture repo. */
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' });

  /** Write a fixture file. */
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  /** A skill whose metadata covers one file. */
  const skill = (name, tier, version) =>
    [
      '---',
      `name: ${name}`,
      'description: d',
      'metadata:',
      `  version: ${version}`,
      `  tier: ${tier}`,
      '  install: harness',
      '  covers:',
      `    - src/${name}.ts`,
      '---',
      '',
    ].join('\n');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-coverage-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    write('packages/skills/skills/ct-core/SKILL.md', skill('ct-core', 'core', '1.0.0'));
    write('packages/skills/skills/ct-extra/SKILL.md', skill('ct-extra', 'on-demand', '1.0.0'));
    write('src/ct-core.ts', 'a\n');
    write('src/ct-extra.ts', 'a\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('tag', 'base');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Commit everything with a message. */
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-qm', message);
  };

  it('passes the declarations check', () => {
    expect(checkDeclarations(root)).toEqual([]);
  });

  it('fails when a covered file changes and its skill does not', () => {
    write('src/ct-extra.ts', 'b\n');
    commit('change');
    expect(checkPullRequest(root, 'base').join('\n')).toMatch(
      /ct-extra documents src\/ct-extra.ts/,
    );
    expect(runGate(root, { base: 'base' })).toBe(1);
  });

  it('accepts a Skill-Drift-Reviewed trailer for an on-demand skill', () => {
    write('src/ct-extra.ts', 'b\n');
    commit('change\n\nSkill-Drift-Reviewed: ct-extra: rename only');
    expect(checkPullRequest(root, 'base')).toEqual([]);
  });

  it('rejects the trailer for a core skill', () => {
    write('src/ct-core.ts', 'b\n');
    commit('change\n\nSkill-Drift-Reviewed: ct-core: trying');
    expect(checkPullRequest(root, 'base').join('\n')).toMatch(/ct-core \(core\).*do not accept/);
  });

  it('requires a version bump when the skill changes', () => {
    write('src/ct-core.ts', 'b\n');
    write(
      'packages/skills/skills/ct-core/SKILL.md',
      `${skill('ct-core', 'core', '1.0.0')}\nnew text\n`,
    );
    commit('change');
    expect(checkPullRequest(root, 'base')).toEqual([
      'ct-core changed but metadata.version is still 1.0.0; bump it (then run node scripts/skills/generate-manifest.mjs)',
    ]);

    write(
      'packages/skills/skills/ct-core/SKILL.md',
      `${skill('ct-core', 'core', '1.0.1')}\nnew text\n`,
    );
    commit('bump');
    expect(checkPullRequest(root, 'base')).toEqual([]);
  });

  it('flags a core or LOOM skill without covers and a dead glob', () => {
    write(
      'packages/skills/skills/ct-core/SKILL.md',
      readFileSync(join(root, 'packages/skills/skills/ct-core/SKILL.md'), 'utf8').replace(
        '    - src/ct-core.ts',
        '    - src/gone.ts',
      ),
    );
    write(
      'packages/skills/skills/ct-extra/SKILL.md',
      skill('ct-extra', 'on-demand', '1.0.0').replace(
        '  covers:\n    - src/ct-extra.ts\n',
        '  loomStage: research\n',
      ),
    );
    commit('decl');
    expect(checkDeclarations(root)).toEqual([
      "ct-core: metadata.covers 'src/gone.ts' matches no tracked file",
      'ct-extra: LOOM-stage skill declares no metadata.covers',
    ]);
  });
});
