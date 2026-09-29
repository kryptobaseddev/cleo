/**
 * Tests for `scripts/lint-emitted-skills.mjs` (T12648, T12653).
 *
 * The gate must pass on the real repository with an empty baseline and go
 * red on each planted defect: a name from any of the five sources that is
 * missing, not harness, or not installed; an install change the mirror no
 * longer describes; and a stale baseline entry. Extraction must accept every
 * quote style and stay inside its own literal.
 *
 * @task T12648
 * @task T12653
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  collectEmittedSkills,
  findViolations,
  installedSkillNames,
  runGate,
} from '../lint-emitted-skills.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'lint-emitted-skills.mjs');

describe('lint-emitted-skills on the real repository', () => {
  it('reads emitted names from all five sources', () => {
    const sources = new Set(collectEmittedSkills(REPO).map((e) => e.source.split('/').pop()));
    for (const s of ['stage-guidance.ts', 'spawn-prompt.ts', 'types.ts', 'dispatch.ts']) {
      expect(sources).toContain(s);
    }
    expect([...sources].some((s) => s.endsWith('.cant'))).toBe(true);
  });

  it('has an empty baseline and passes --strict', () => {
    const baseline = JSON.parse(readFileSync(join(REPO, BASELINE_PATH), 'utf8'));
    expect(baseline.entries).toEqual([]);
    const run = spawnSync(process.execPath, [SCRIPT, '--strict'], { cwd: REPO, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });

  it('installs ct-lead and the LOOM skills, and not internal ct-grade', () => {
    const installed = installedSkillNames(REPO);
    for (const name of [
      'ct-lead',
      'ct-adr-recorder',
      'ct-consensus-voter',
      'ct-ivt-looper',
      'ct-release-orchestrator',
      'ct-artifact-publisher',
      'ct-provenance-keeper',
    ]) {
      expect(installed).toContain(name);
    }
    expect(installed).not.toContain('ct-grade');
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

  const ALL = {
    'ct-research': 'harness',
    'ct-core': 'harness',
    'ct-lead': 'harness',
    'ct-alias': 'harness',
    'ct-dispatch': 'harness',
    'ct-release': 'harness',
    'ct-internal': 'internal',
  };

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
      'packages/core/src/skills/types.ts',
      "export const SKILL_NAME_MAP: Record<string, string> = {\n  'alias-key': 'ct-alias',\n};\n",
    );
    write('packages/core/src/skills/dispatch.ts', "const r = { skill: 'ct-dispatch' };\n");
    write(
      'packages/core/src/validation/protocols/cant/release.cant',
      'kind: protocol\nskillRef: ct-release\n',
    );
    write(
      'packages/core/src/init.ts',
      [
        "const manifestPath = join(ctSkillsRoot, 'skills', 'manifest.json');",
        "const harnessSkills = skills.filter((s) => s.install === 'harness');",
        "const skillSourceDir = join(ctSkillsRoot, 'skills', skill.name);",
      ].join('\n'),
    );
    for (const name of Object.keys(ALL)) {
      write(`packages/skills/skills/${name}/SKILL.md`, `---\nname: ${name}\n---\n`);
    }
    manifest(ALL);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is clean when every emitted skill is installed and declared harness', () => {
    expect(findViolations(root)).toEqual([]);
    expect(runGate(root)).toBe(0);
  });

  it('fails when a spawn-prompt skill is not installed (the ct-lead defect)', () => {
    manifest({ ...ALL, 'ct-lead': 'internal' });
    expect(findViolations(root).map((v) => v.key)).toEqual([
      'emitted-not-harness:ct-lead',
      'emitted-not-installed:ct-lead',
    ]);
    expect(runGate(root)).toBe(1);
  });

  it('fails when a SKILL_NAME_MAP value names a skill that never existed', () => {
    write(
      'packages/core/src/skills/types.ts',
      "export const SKILL_NAME_MAP: Record<string, string> = {\n  bats: 'ct-test-writer-bats',\n};\n",
    );
    expect(findViolations(root).map((v) => v.key)).toEqual([
      'emitted-missing:ct-test-writer-bats',
      'emitted-not-installed:ct-test-writer-bats',
    ]);
  });

  it('fails when a dispatch.ts skill is internal', () => {
    manifest({ ...ALL, 'ct-dispatch': 'internal' });
    expect(findViolations(root).map((v) => v.key)).toContain('emitted-not-harness:ct-dispatch');
  });

  it('fails when a stage-guidance skill has no directory', () => {
    rmSync(join(root, 'packages/skills/skills/ct-research'), { recursive: true });
    expect(findViolations(root).map((v) => v.key)).toEqual([
      'emitted-missing:ct-research',
      'emitted-not-installed:ct-research',
    ]);
  });

  it('treats a harness entry with no directory or no name as not installed', () => {
    write(
      'packages/skills/skills/manifest.json',
      JSON.stringify({
        skills: [{ install: 'harness' }, { name: 'ct-ghost', install: 'harness' }],
      }),
    );
    expect(installedSkillNames(root)).toEqual(new Set());
  });

  it('reads names in double and backtick quotes', () => {
    write(
      'packages/core/src/orchestration/spawn-prompt.ts',
      'loadSkillExcerpt("ct-dq", 1); resolveSkillPath(`ct-bt`, root);\n',
    );
    const names = collectEmittedSkills(root).map((e) => e.name);
    expect(names).toContain('ct-dq');
    expect(names).toContain('ct-bt');
  });

  it('stays inside an `as const` literal instead of reading the next statement', () => {
    write(
      'packages/core/src/lifecycle/stage-guidance.ts',
      [
        "export const STAGE_SKILL_MAP = { research: 'ct-research' } as const;",
        "export const TIER_0_SKILLS = ['ct-core'] as const;",
        "const unrelated = { other: 'ct-not-a-skill' };",
      ].join('\n'),
    );
    const names = collectEmittedSkills(root)
      .filter((e) => e.source.endsWith('stage-guidance.ts'))
      .map((e) => e.name);
    expect(names).toEqual(['ct-research', 'ct-core']);
  });

  it('fails when STAGE_SKILL_MAP is renamed, even with a phantom planted (review of #1651)', () => {
    write(
      'packages/core/src/lifecycle/stage-guidance.ts',
      [
        'export const STAGE_SKILL_MAP_RENAMED: Record<Stage, string> = {',
        "  research: 'ct-ghost',",
        '};',
        "export const TIER_0_SKILLS: readonly string[] = ['ct-core'];",
      ].join('\n'),
    );
    const keys = findViolations(root).map((v) => v.key);
    expect(keys).toContain(
      'source-empty:STAGE_SKILL_MAP (packages/core/src/lifecycle/stage-guidance.ts)',
    );
    expect(runGate(root)).toBe(1);
  });

  it.each([
    [
      'TIER_0_SKILLS',
      'packages/core/src/lifecycle/stage-guidance.ts',
      "export const STAGE_SKILL_MAP = { research: 'ct-research' };\n",
    ],
    ['SKILL_NAME_MAP', 'packages/core/src/skills/types.ts', 'export const NAME_MAP = {};\n'],
    ['skill:', 'packages/core/src/skills/dispatch.ts', 'const r = {};\n'],
    [
      'loadSkillExcerpt/resolveSkillPath',
      'packages/core/src/orchestration/spawn-prompt.ts',
      'const x = 1;\n',
    ],
  ])('fails when the %s source yields no names', (label, file, text) => {
    write(file, text);
    expect(
      findViolations(root)
        .map((v) => v.key)
        .some((k) => k.startsWith(`source-empty:${label}`)),
    ).toBe(true);
  });

  it('resolves a CONSTANT_CASE skill argument, and fails when it cannot', () => {
    write(
      'packages/core/src/orchestration/spawn-prompt.ts',
      "const LEAD_SKILL = 'ct-lead';\nloadSkillExcerpt(LEAD_SKILL, 6000, projectRoot);\n",
    );
    expect(findViolations(root)).toEqual([]);
    write(
      'packages/core/src/orchestration/spawn-prompt.ts',
      "loadSkillExcerpt('ct-lead', 1);\nloadSkillExcerpt(MISSING_SKILL, 6000, projectRoot);\n",
    );
    expect(findViolations(root).map((v) => v.key)).toEqual([
      'unresolved-constant:MISSING_SKILL (packages/core/src/orchestration/spawn-prompt.ts)',
    ]);
  });

  it('resolves a camelCase const skill argument and skips an unbound parameter (T12679)', () => {
    write(
      'packages/core/src/orchestration/spawn-prompt.ts',
      "const leadSkill = 'ct-ghost';\nloadSkillExcerpt(leadSkill, 6000, projectRoot);\nresolveSkillPath(skillName, projectRoot);\n",
    );
    expect(findViolations(root).map((v) => v.key)).toEqual([
      'emitted-missing:ct-ghost',
      'emitted-not-installed:ct-ghost',
    ]);
  });

  it('does not accept an install tripwire that survives only in a string literal (T12679)', () => {
    write(
      'packages/core/src/init.ts',
      [
        "const manifestPath = join(ctSkillsRoot, 'skills', 'manifest.json');",
        'const harnessSkills = skills.filter((s) => true);',
        'log("old filter was s.install === \'harness\'");',
        "const skillSourceDir = join(ctSkillsRoot, 'skills', skill.name);",
      ].join('\n'),
    );
    expect(findViolations(root).map((v) => v.key)).toEqual(["tripwire:s.install === 'harness'"]);
  });

  it('does not accept an install tripwire that survives only in a comment', () => {
    write(
      'packages/core/src/init.ts',
      [
        "const manifestPath = join(ctSkillsRoot, 'skills', 'manifest.json');",
        "const harnessSkills = skills.filter((s) => true); // s.install === 'harness'",
        "const skillSourceDir = join(ctSkillsRoot, 'skills', skill.name);",
      ].join('\n'),
    );
    expect(findViolations(root).map((v) => v.key)).toEqual(["tripwire:s.install === 'harness'"]);
  });

  it('fails when install stops matching the mirror', () => {
    write('packages/core/src/init.ts', "const catalogPath = join(ctSkillsRoot, 'skills.json');\n");
    expect(findViolations(root).map((v) => v.key)).toEqual([
      "tripwire:join(ctSkillsRoot, 'skills', 'manifest.json')",
      "tripwire:s.install === 'harness'",
      "tripwire:join(ctSkillsRoot, 'skills', skill.name)",
    ]);
  });

  it('baselines a known violation, and fails once the entry is stale', () => {
    manifest({ ...ALL, 'ct-lead': 'internal' });
    const entries = [
      { key: 'emitted-not-harness:ct-lead', task: 'T1' },
      { key: 'emitted-not-installed:ct-lead', task: 'T1' },
    ];
    write(BASELINE_PATH, JSON.stringify({ entries }));
    expect(runGate(root)).toBe(0);
    expect(runGate(root, { strict: true })).toBe(1);

    manifest(ALL);
    expect(runGate(root)).toBe(1);
  });
});
