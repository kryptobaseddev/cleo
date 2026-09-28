/**
 * Tests for `scripts/lint-emitted-skills.mjs` (T12648).
 *
 * The gate must pass on the real repository (with its baseline) and go red on
 * each planted defect: a stage-guidance / spawn-prompt / .cant name that is
 * missing, not harness, or not installed; a frontmatter install field that
 * disagrees with install; a stale baseline entry; and an install change the
 * mirror no longer describes.
 *
 * @task T12648
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  collectEmittedSkills,
  findViolations,
  runGate,
} from '../lint-emitted-skills.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'lint-emitted-skills.mjs');

describe('lint-emitted-skills on the real repository', () => {
  it('reads emitted names from all three sources', () => {
    const sources = new Set(collectEmittedSkills(REPO).map((e) => e.source.split('/').pop()));
    expect(sources).toContain('stage-guidance.ts');
    expect(sources).toContain('spawn-prompt.ts');
    expect([...sources].some((s) => s.endsWith('.cant'))).toBe(true);
  });

  it('exits 0 against its baseline', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });
});

describe('lint-emitted-skills goes red on planted defects', () => {
  let root;

  /** Write a file under the fixture root. */
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  /** Write the fixture manifest from `{ name: install }`. */
  const manifest = (skills) =>
    write(
      'packages/skills/skills/manifest.json',
      JSON.stringify({
        skills: Object.entries(skills).map(([name, install]) => ({ name, install })),
      }),
    );

  /** Write the fixture install catalogue from `{ name: tier }`. */
  const catalog = (skills) =>
    write(
      'packages/skills/skills.json',
      JSON.stringify({
        skills: Object.entries(skills).map(([name, tier]) => ({
          name,
          tier,
          path: `skills/${name}/SKILL.md`,
        })),
      }),
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'emitted-skills-gate-'));
    write(
      'packages/core/src/lifecycle/stage-guidance.ts',
      [
        'export const STAGE_SKILL_MAP: Record<Stage, string> = {',
        "  research: 'ct-research',",
        '};',
        "export const TIER_0_SKILLS: readonly string[] = ['ct-core'];",
      ].join('\n'),
    );
    write(
      'packages/core/src/orchestration/spawn-prompt.ts',
      "const lead = loadSkillExcerpt('ct-lead', 6000, projectRoot);\n",
    );
    write(
      'packages/core/src/validation/protocols/cant/release.cant',
      'kind: protocol\nskillRef: ct-release\n',
    );
    write(
      'packages/core/src/init.ts',
      "const catalogPath = join(ctSkillsRoot, 'skills.json');\nconst coreSkills = skills.filter((s) => s.tier <= 2);\n",
    );
    for (const name of ['ct-research', 'ct-core', 'ct-lead', 'ct-release', 'ct-internal']) {
      write(`packages/skills/skills/${name}/SKILL.md`, `---\nname: ${name}\n---\n`);
    }
    manifest({
      'ct-research': 'harness',
      'ct-core': 'harness',
      'ct-lead': 'harness',
      'ct-release': 'harness',
      'ct-internal': 'internal',
    });
    catalog({ 'ct-research': 1, 'ct-core': 0, 'ct-lead': 1, 'ct-release': 1, 'ct-internal': 3 });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is clean when every emitted skill is installed and declared harness', () => {
    expect(findViolations(root)).toEqual([]);
    expect(runGate(root)).toBe(0);
  });

  it('fails when a spawn-prompt skill is not installed (the ct-lead defect)', () => {
    catalog({ 'ct-research': 1, 'ct-core': 0, 'ct-release': 1, 'ct-internal': 3 });
    expect(findViolations(root).map((v) => v.key)).toEqual([
      'emitted-not-installed:ct-lead',
      'install-mismatch:ct-lead',
    ]);
    expect(runGate(root)).toBe(1);
  });

  it('fails when a stage-guidance skill has no directory', () => {
    rmSync(join(root, 'packages/skills/skills/ct-research'), { recursive: true });
    expect(findViolations(root).map((v) => v.key)).toContain('emitted-missing:ct-research');
  });

  it('fails when a .cant skillRef is declared internal', () => {
    manifest({
      'ct-research': 'harness',
      'ct-core': 'harness',
      'ct-lead': 'harness',
      'ct-release': 'internal',
      'ct-internal': 'internal',
    });
    expect(findViolations(root).map((v) => v.key)).toEqual([
      'emitted-not-harness:ct-release',
      'install-mismatch:ct-release',
    ]);
  });

  it('fails when an internal skill is installed anyway', () => {
    catalog({ 'ct-research': 1, 'ct-core': 0, 'ct-lead': 1, 'ct-release': 1, 'ct-internal': 2 });
    expect(findViolations(root).map((v) => v.key)).toEqual(['install-mismatch:ct-internal']);
  });

  it('fails when install stops matching the mirror', () => {
    write(
      'packages/core/src/init.ts',
      "const catalogPath = join(ctSkillsRoot, 'manifest.json');\n",
    );
    expect(findViolations(root).map((v) => v.key)).toEqual([
      "tripwire:join(ctSkillsRoot, 'skills.json')",
      'tripwire:s.tier <= 2',
    ]);
  });

  it('baselines a known violation, and fails once the entry is stale', () => {
    catalog({ 'ct-research': 1, 'ct-core': 0, 'ct-release': 1, 'ct-internal': 3 });
    const entries = [
      { key: 'emitted-not-installed:ct-lead', task: 'T1' },
      { key: 'install-mismatch:ct-lead', task: 'T1' },
    ];
    write(BASELINE_PATH, JSON.stringify({ entries }));
    expect(runGate(root)).toBe(0);
    expect(runGate(root, { strict: true })).toBe(1);

    catalog({ 'ct-research': 1, 'ct-core': 0, 'ct-lead': 1, 'ct-release': 1, 'ct-internal': 3 });
    expect(runGate(root)).toBe(1);
  });
});
