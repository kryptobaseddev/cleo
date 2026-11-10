/**
 * Tests for `scripts/lint-skill-coverage.mjs` (T12124).
 *
 * @task T12124
 * @task T14393
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
  semverGreater,
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
    git('tag', 'v2000.1.0');
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

  it('ignores a trailer that names a different skill', () => {
    write('src/ct-extra.ts', 'b\n');
    commit('change\n\nSkill-Drift-Reviewed: ct-other: wrong skill');
    expect(checkPullRequest(root, 'base').join('\n')).toMatch(/ct-extra documents/);
  });

  it('ignores a trailer on a commit that does not touch the covered file', () => {
    write('src/ct-extra.ts', 'b\n');
    commit('change');
    write('unrelated.txt', 'x\n');
    commit('other\n\nSkill-Drift-Reviewed: ct-extra: rename only');
    expect(checkPullRequest(root, 'base').join('\n')).toMatch(/ct-extra documents/);
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
      'ct-core changed but metadata.version 1.0.0 is not greater than 1.0.0; bump it (then run node scripts/skills/generate-manifest.mjs)',
    ]);

    write(
      'packages/skills/skills/ct-core/SKILL.md',
      `${skill('ct-core', 'core', '0.9.9')}\nnew text\n`,
    );
    commit('downgrade');
    expect(checkPullRequest(root, 'base').join('\n')).toMatch(
      /0\.9\.9 is not greater than 1\.0\.0/,
    );

    write(
      'packages/skills/skills/ct-core/SKILL.md',
      `${skill('ct-core', 'core', '1.0.1')}\nnew text\n`,
    );
    commit('bump');
    expect(checkPullRequest(root, 'base')).toEqual([]);
  });

  describe('parallel PRs that bump one skill (T14393)', () => {
    const SKILL = 'packages/skills/skills/ct-core/SKILL.md';
    /** Lines far enough apart that git merges edits to each independently. */
    const body = (top, bottom) => `\n${top}\n\n1\n2\n3\n4\n5\n6\n\n${bottom}\n`;

    /** A branch off main that edits the covered file, the skill and bumps it. */
    const branch = (name, version, top, bottom, file) => {
      git('checkout', '-q', '-b', name, 'main');
      write(SKILL, `${skill('ct-core', 'core', version)}${body(top, bottom)}`);
      write(file, `${name}\n`);
      commit(name);
      git('checkout', '-q', 'main');
    };

    /** Merge a branch into main the way GitHub's merge ref does; throws on conflict. */
    const mergeRef = (name) => {
      git('checkout', '-q', '-b', `merge-${name}`, 'main');
      git('merge', '-q', '--no-ff', '-m', `merge ${name}`, name);
    };

    beforeEach(() => {
      write(SKILL, `${skill('ct-core', 'core', '1.0.0')}${body('top', 'bottom')}`);
      write('src/a.ts', 'a\n');
      write('src/b.ts', 'b\n');
      write('src/ct-core.ts', 'base\n');
      commit('skill body');
      branch('pr-a', '1.1.0', 'top from a', 'bottom', 'src/ct-core.ts');
      branch('pr-b', '1.1.0', 'top', 'bottom from b', 'src/b.ts');
    });

    it.each([
      ['pr-a', 'pr-b'],
      ['pr-b', 'pr-a'],
    ])('merge %s then %s with no conflict and a green gate', (first, second) => {
      mergeRef(first);
      expect(checkPullRequest(root, 'main', { head: first })).toEqual([]);
      git('checkout', '-q', 'main');
      git('merge', '-q', '--ff-only', `merge-${first}`);

      mergeRef(second);
      expect(checkPullRequest(root, 'main', { head: second })).toEqual([]);
      git('checkout', '-q', 'main');
      git('merge', '-q', '--ff-only', `merge-${second}`);
      const merged = readFileSync(join(root, SKILL), 'utf8');
      expect(merged).toContain('version: 1.1.0');
      expect(merged).toContain('top from a');
      expect(merged).toContain('bottom from b');
    });

    it('still fails the second PR when a release tag was cut after its branch point', () => {
      mergeRef('pr-a');
      git('checkout', '-q', 'main');
      git('merge', '-q', '--ff-only', 'merge-pr-a');
      git('tag', 'v2026.1.1');

      mergeRef('pr-b');
      expect(checkPullRequest(root, 'main', { head: 'pr-b' })).toEqual([
        'ct-core changed but metadata.version 1.1.0 is not greater than 1.1.0, released in v2026.1.1; bump it (then run node scripts/skills/generate-manifest.mjs)',
      ]);
    });

    it('fails a PR that never bumped even though its merge commit inherits another bump', () => {
      mergeRef('pr-a');
      git('checkout', '-q', 'main');
      git('merge', '-q', '--ff-only', 'merge-pr-a');

      git('checkout', '-q', '-b', 'pr-d', 'main~1');
      write(SKILL, `${skill('ct-core', 'core', '1.0.0')}${body('top', 'bottom from d')}`);
      commit('body only, no bump');
      git('checkout', '-q', 'main');
      mergeRef('pr-d');
      expect(readFileSync(join(root, SKILL), 'utf8')).toContain('version: 1.1.0');
      expect(checkPullRequest(root, 'main', { head: 'pr-d' })).toEqual([
        'ct-core changed but metadata.version 1.0.0 is not greater than 1.0.0; bump it (then run node scripts/skills/generate-manifest.mjs)',
      ]);
    });

    it('ignores canary and rc tags as release anchors', () => {
      mergeRef('pr-a');
      git('checkout', '-q', 'main');
      git('merge', '-q', '--ff-only', 'merge-pr-a');
      git('tag', 'v2026.1.1-canary.1');
      git('tag', 'v2026.1.1-rc.1');

      mergeRef('pr-b');
      expect(checkPullRequest(root, 'main', { head: 'pr-b' })).toEqual([]);
    });

    it('fails loudly, naming the fetch, when no stable release tag is reachable', () => {
      git('tag', '-d', 'v2000.1.0');
      mergeRef('pr-a');
      expect(checkPullRequest(root, 'main', { head: 'pr-a' })).toEqual([
        'skill version check cannot run: no stable release tag (v*, not -canary/-rc) reachable from main; fetch tags (git fetch --tags origin, or actions/checkout fetch-depth: 0)',
      ]);
    });

    it('rejects a version below the base even when above the branch point', () => {
      mergeRef('pr-a');
      git('checkout', '-q', 'main');
      git('merge', '-q', '--ff-only', 'merge-pr-a');

      git('checkout', '-q', 'pr-b');
      write(SKILL, `${skill('ct-core', 'core', '1.0.1')}${body('top', 'bottom from b')}`);
      commit('patch bump');
      expect(checkPullRequest(root, 'main')).toEqual([
        "ct-core changed but metadata.version 1.0.1 is lower than main's 1.1.0; bump it (then run node scripts/skills/generate-manifest.mjs)",
      ]);
    });

    it('still fails a covered change without a skill change', () => {
      git('checkout', '-q', '-b', 'pr-c', 'main');
      write('src/ct-core.ts', 'c\n');
      commit('covered only');
      expect(checkPullRequest(root, 'main').join('\n')).toMatch(
        /ct-core \(core\) documents src\/ct-core.ts/,
      );
    });
  });

  it.each([
    ['1.0.1', '1.0.0', true],
    ['1.10.0', '1.9.9', true],
    ['2.0.0', '1.99.99', true],
    ['1.0.0', '1.0.0', false],
    ['0.9.9', '1.0.0', false],
    ['1.0', '1.0.0', false],
  ])('semverGreater(%s, %s) → %s', (a, b, want) => {
    expect(semverGreater(a, b)).toBe(want);
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
