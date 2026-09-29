/**
 * Tests for `scripts/lint-skills-manifest.mjs` and the generator it checks
 * (T12648).
 *
 * The gate must pass on the real repository and go red on each planted
 * defect: manifest drift, a directory missing from the manifest, a manifest
 * entry without a directory, and each invalid-frontmatter class.
 *
 * @task T12648
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGate } from '../lint-skills-manifest.mjs';
import { buildManifest, checkManifest, serialiseManifest } from '../skills/generate-manifest.mjs';
import { parseFrontmatter } from '../skills/lib/skill-frontmatter.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'lint-skills-manifest.mjs');
const MANIFEST = 'packages/skills/skills/manifest.json';

/** Frontmatter for a valid fixture skill. */
function skillMd(name, extra = '') {
  return [
    '---',
    `name: ${name}`,
    `description: Fixture skill ${name}.`,
    extra,
    'metadata:',
    '  version: 1.0.0',
    '  tier: on-demand',
    '  install: harness',
    '---',
    '',
    `# ${name}`,
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

describe('lint-skills-manifest on the real repository', () => {
  it('pins SKILL.md checkouts to LF via .gitattributes (T12649)', () => {
    const run = spawnSync(
      'git',
      ['check-attr', 'eol', '--', 'packages/skills/skills/ct-cleo/SKILL.md'],
      { cwd: REPO, encoding: 'utf8' },
    );
    expect(run.stdout.trim()).toBe('packages/skills/skills/ct-cleo/SKILL.md: eol: lf');
  });

  it('reports no drift and no invalid frontmatter', () => {
    expect(checkManifest(REPO)).toEqual({ problems: [], drift: [] });
  });

  it('exits 0 when run as a script', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });
});

describe('lint-skills-manifest goes red on planted defects', () => {
  let root;

  /** Write a fixture skill directory. */
  const addSkill = (name, text = skillMd(name)) => {
    mkdirSync(join(root, 'packages/skills/skills', name), { recursive: true });
    writeFileSync(join(root, 'packages/skills/skills', name, 'SKILL.md'), text);
  };

  /** Regenerate the fixture manifest so it starts clean. */
  const regenerate = () => {
    const { manifest, problems } = buildManifest(root);
    expect(problems).toEqual([]);
    writeFileSync(join(root, MANIFEST), serialiseManifest(manifest));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skills-manifest-gate-'));
    mkdirSync(join(root, 'packages/skills/skills'), { recursive: true });
    writeFileSync(
      join(root, MANIFEST),
      JSON.stringify({ dispatch_matrix: { by_protocol: {} }, skills: [] }),
    );
    addSkill('ct-alpha');
    addSkill('ct-beta');
    regenerate();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is clean after regeneration', () => {
    expect(runGate(root)).toBe(0);
  });

  it('carries curated fields over and overwrites identity fields', () => {
    const m = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
    m.skills[0].capabilities = { inputs: ['TASK_ID'] };
    m.skills[0].version = '9.9.9';
    writeFileSync(join(root, MANIFEST), serialiseManifest(m));
    const { manifest } = buildManifest(root);
    expect(manifest.skills[0].capabilities).toEqual({ inputs: ['TASK_ID'] });
    expect(manifest.skills[0].version).toBe('1.0.0');
  });

  it('fails when a manifest identity field is hand-edited', () => {
    const m = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
    m.skills[0].version = '9.9.9';
    writeFileSync(join(root, MANIFEST), serialiseManifest(m));
    expect(checkManifest(root).drift).toEqual(['ct-alpha: entry differs from frontmatter']);
  });

  it('fails when a skill directory is missing from the manifest', () => {
    addSkill('ct-gamma');
    expect(checkManifest(root).drift[0]).toMatch(/ct-gamma: missing from manifest/);
  });

  it('fails when a retired skills.json index comes back (T12653)', () => {
    writeFileSync(join(root, 'packages/skills/skills.json'), '{"skills":[]}');
    expect(checkManifest(root).drift).toEqual([
      'packages/skills/skills.json: a second skills index exists; the manifest is the only one (T12653)',
    ]);
    expect(runGate(root)).toBe(1);
  });

  it('derives core and category from metadata.tier and fills catalog defaults (T12653)', () => {
    const { manifest } = buildManifest(root);
    expect(manifest.skills[0]).toMatchObject({
      core: false,
      category: 'recommended',
      references: [],
      protocol: null,
      dependencies: [],
      sharedResources: [],
      compatibility: [],
      license: 'MIT',
    });
  });

  it('binds metadata.loomStage to the stage map and rejects a top-level loomStage (T12649)', () => {
    mkdirSync(join(root, 'packages/core/src/lifecycle'), { recursive: true });
    writeFileSync(
      join(root, 'packages/core/src/lifecycle/stage-guidance.ts'),
      "export const STAGE_SKILL_MAP = {\n  research: 'ct-beta',\n  testing: 'ct-alpha',\n};\n",
    );
    const withStage = (stage) =>
      skillMd('ct-beta').replace('  install: harness', `  install: harness\n  loomStage: ${stage}`);

    addSkill('ct-beta', withStage('research'));
    expect(checkManifest(root).problems).toEqual([]);

    addSkill('ct-beta', withStage('testing'));
    expect(checkManifest(root).problems.map((p) => p.problem)).toEqual([
      "metadata.loomStage 'testing' is bound to 'ct-alpha', not 'ct-beta'",
    ]);

    addSkill('ct-beta', withStage('nonsense'));
    expect(checkManifest(root).problems[0].problem).toMatch(/not a STAGE_SKILL_MAP stage/);

    addSkill('ct-beta', skillMd('ct-beta', 'loomStage: research'));
    expect(checkManifest(root).problems[0].problem).toMatch(/top-level loomStage moved/);
  });

  it('fails when a profile names a phantom or omits a harness skill (T12649)', () => {
    mkdirSync(join(root, 'packages/skills/profiles'), { recursive: true });
    const profile = (name, skills, ext) =>
      writeFileSync(
        join(root, 'packages/skills/profiles', `${name}.json`),
        JSON.stringify({ name, skills, ...(ext && { extends: ext }) }),
      );
    profile('minimal', ['ct-alpha']);
    profile('full', ['ct-beta'], 'minimal');
    expect(checkManifest(root).drift).toEqual([]);

    profile('full', ['loom'], 'minimal');
    expect(checkManifest(root).drift).toEqual([
      "packages/skills/profiles: profile 'full' names 'loom', which is not a harness skill in the manifest",
      "packages/skills/profiles: harness skill 'ct-beta' is in no profile ('full' must install every harness skill)",
    ]);
  });

  it('fails on a ghost dependency, chains_to or reference (review of #1656)', () => {
    addSkill('ct-beta', skillMd('ct-beta', 'dependencies:\n  - ct-docs-write'));
    expect(checkManifest(root).problems).toEqual([]);
    const { manifest } = buildManifest(root);
    expect(manifest.skills.find((s) => s.name === 'ct-beta').dependencies).toEqual([
      'ct-docs-write',
    ]);
    writeFileSync(join(root, MANIFEST), serialiseManifest(manifest));
    expect(checkManifest(root).drift).toEqual([
      "ct-beta: dependencies names 'ct-docs-write', which is not a skill",
    ]);

    addSkill('ct-beta');
    const clean = buildManifest(root).manifest;
    clean.skills[0].capabilities = { chains_to: ['ct-docs-review'] };
    clean.skills[0].references = ['skills/ct-skill-creator/references/x.md'];
    writeFileSync(join(root, MANIFEST), serialiseManifest(clean));
    expect(checkManifest(root).drift).toEqual([
      "ct-alpha: capabilities.chains_to names 'ct-docs-review', which is not a skill",
      "ct-alpha: references 'skills/ct-skill-creator/references/x.md', which does not exist",
    ]);
  });

  it("fails when a profile's dependency closure reaches a non-harness skill", () => {
    addSkill(
      'ct-gamma',
      skillMd('ct-gamma')
        .replace('tier: on-demand', 'tier: internal')
        .replace('install: harness', 'install: internal'),
    );
    addSkill('ct-beta', skillMd('ct-beta', 'dependencies:\n  - ct-gamma'));
    regenerate();
    mkdirSync(join(root, 'packages/skills/profiles'), { recursive: true });
    writeFileSync(
      join(root, 'packages/skills/profiles/full.json'),
      JSON.stringify({ name: 'full', skills: ['ct-alpha', 'ct-beta'] }),
    );
    expect(checkManifest(root).drift).toEqual([
      "packages/skills/profiles: profile 'full' installs 'ct-gamma' (via dependencies), which is not a harness skill",
    ]);
  });

  it('fails when the manifest lists a skill with no directory', () => {
    const m = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
    m.skills.push({ name: 'loom' });
    writeFileSync(join(root, MANIFEST), serialiseManifest(m));
    expect(checkManifest(root).drift).toContain(
      'loom: listed but no packages/skills/skills/loom/SKILL.md',
    );
  });

  it.each([
    ['name differs from directory', skillMd('ct-other'), /does not equal its directory/],
    ['top-level tier', skillMd('ct-beta', 'tier: 1'), /top-level tier is not allowed/],
    ['top-level core', skillMd('ct-beta', 'core: true'), /top-level core is not allowed/],
    [
      'top-level category',
      skillMd('ct-beta', 'category: meta'),
      /top-level category is not allowed/,
    ],
    [
      'disagreeing top-level version',
      skillMd('ct-beta', 'version: 2.0.0'),
      /disagrees with metadata.version/,
    ],
    ['duplicate key', skillMd('ct-beta', 'name: ct-beta'), /duplicate top-level key 'name'/],
    [
      'bad tier',
      skillMd('ct-beta').replace('tier: on-demand', 'tier: recommended'),
      /metadata.tier/,
    ],
    [
      'bad install',
      skillMd('ct-beta').replace('install: harness', 'install: global'),
      /metadata.install/,
    ],
    [
      'internal installed to harness',
      skillMd('ct-beta').replace('tier: on-demand', 'tier: internal'),
      /internal cannot have metadata.install harness/,
    ],
    [
      'missing version',
      skillMd('ct-beta').replace('  version: 1.0.0\n', ''),
      /metadata.version is missing/,
    ],
    [
      'overlong description',
      skillMd('ct-beta').replace('Fixture skill ct-beta.', 'x'.repeat(1025)),
      /max 1024/,
    ],
  ])('fails on invalid frontmatter: %s', (_label, text, pattern) => {
    addSkill('ct-beta', text);
    const { problems } = checkManifest(root);
    expect(problems.map((p) => p.problem).join('\n')).toMatch(pattern);
    expect(runGate(root)).toBe(1);
  });
});

describe('parseFrontmatter', () => {
  it('folds block scalars and reads the metadata map', () => {
    const fm = parseFrontmatter(
      [
        '---',
        'name: x',
        'description: >-',
        '  line one',
        '  line two',
        'metadata:',
        '  version: 1.2.3',
        '---',
      ].join('\n'),
    );
    expect(fm.fields.description).toBe('line one line two');
    expect(fm.metadata.version).toBe('1.2.3');
  });

  it('reports a missing frontmatter block', () => {
    expect(parseFrontmatter('# no frontmatter').errors).toEqual(['no frontmatter block']);
  });

  it('parses a CRLF file exactly like its LF twin (T12649)', () => {
    const lf = [
      '---',
      'name: x',
      'description: d',
      'metadata:',
      '  version: 1.2.3',
      '---',
      '',
    ].join('\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(parseFrontmatter(crlf)).toEqual(parseFrontmatter(lf));
    expect(parseFrontmatter(crlf).metadata.version).toBe('1.2.3');
  });

  it('keeps reading metadata across a blank line (T12649)', () => {
    const fm = parseFrontmatter(
      [
        '---',
        'name: x',
        'metadata:',
        '  version: 1.2.3',
        '',
        '  tier: core',
        'other: y',
        '---',
      ].join('\n'),
    );
    expect(fm.metadata).toEqual({ version: '1.2.3', tier: 'core' });
    expect(fm.fields.other).toBe('y');
  });
});
