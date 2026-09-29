/**
 * Tests for `scripts/lint-skill-commands.mjs` (T12649).
 *
 * The gate must pass on the real repository, fail on a planted dead command
 * (even a baselined one in a core skill), ratchet non-core skills against the
 * baseline, and ignore frontmatter, glued names and marked negative examples.
 *
 * @task T12649
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  findSkillCommandViolations,
  prepareForScan,
  runGate,
} from '../lint-skill-commands.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'lint-skill-commands.mjs');

describe('lint-skill-commands on the real repository', () => {
  it('finds no dead command in any core skill', () => {
    expect(findSkillCommandViolations(REPO).filter((v) => v.core)).toEqual([]);
  });

  it('exits 0 against its baseline', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });
});

describe('prepareForScan', () => {
  it('blanks frontmatter so `name: ct-cleo` + `description:` is not read as a command', () => {
    const text = prepareForScan('---\nname: ct-cleo\ndescription: x\n---\nbody\n');
    expect(text).not.toMatch(/cleo\s+description/);
    expect(text.split('\n')).toHaveLength(6);
  });

  it('neutralises glued names and drops marked negative examples', () => {
    expect(prepareForScan('a non-cleo run')).not.toMatch(/\bcleo run/);
    expect(prepareForScan('cleo docs add T1 f --titel x  # cleo-cmd: negative-example')).toBe('');
  });
});

describe('lint-skill-commands goes red on planted defects', () => {
  let root;

  /** Write a skill file under the fixture root. */
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-commands-gate-'));
    // The CLI's command sources are the real ones; only the skills are fixtures.
    mkdirSync(join(root, 'packages'), { recursive: true });
    for (const pkg of ['cleo', 'contracts', 'core', 'lafs']) {
      symlinkSync(join(REPO, 'packages', pkg), join(root, 'packages', pkg));
    }
    write(
      'packages/skills/skills/manifest.json',
      JSON.stringify({
        skills: [
          { name: 'ct-core-skill', deliveryTier: 'core' },
          { name: 'ct-extra', deliveryTier: 'on-demand' },
        ],
      }),
    );
    write('packages/skills/skills/ct-core-skill/SKILL.md', '# Core\n\n`cleo show T1`\n');
    write('packages/skills/skills/ct-extra/SKILL.md', '# Extra\n\n`cleo find "x"`\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is clean when every invocation resolves', () => {
    expect(findSkillCommandViolations(root)).toEqual([]);
    expect(runGate(root)).toBe(0);
  });

  it('fails on a dead verb, sub-verb and flag, including in references/', () => {
    write('packages/skills/skills/ct-extra/references/r.md', 'Run `cleo lead rollup`.\n');
    write(
      'packages/skills/skills/ct-extra/SKILL.md',
      '`cleo orchestrate spawn-batch`\n\n`cleo orchestrate ready --epic T1`\n',
    );
    const messages = findSkillCommandViolations(root).map((v) => v.message);
    expect(messages.join('\n')).toMatch(/no such command: cleo lead/);
    expect(messages.join('\n')).toMatch(/has no sub-command 'spawn-batch'/);
    expect(messages.join('\n')).toMatch(/has no flag --epic/);
    expect(runGate(root)).toBe(1);
  });

  it('fails on camelCase check-protocol flags (the LOOM-skill defect)', () => {
    write(
      'packages/skills/skills/ct-extra/SKILL.md',
      '`cleo check protocol testing --taskId T1 --testsRun 3`\n',
    );
    expect(findSkillCommandViolations(root)[0].message).toMatch(/--taskId/);
  });

  it('baselines a non-core finding, and fails once it is stale', () => {
    write('packages/skills/skills/ct-extra/SKILL.md', '`cleo lead rollup`\n');
    const [finding] = findSkillCommandViolations(root);
    write(BASELINE_PATH, JSON.stringify({ entries: [{ key: finding.key, skill: 'ct-extra' }] }));
    expect(runGate(root)).toBe(0);
    expect(runGate(root, { strict: true })).toBe(1);

    write('packages/skills/skills/ct-extra/SKILL.md', '`cleo show T1`\n');
    expect(runGate(root)).toBe(1);
  });

  it('never accepts a baselined finding in a core skill', () => {
    write('packages/skills/skills/ct-core-skill/SKILL.md', '`cleo lead rollup`\n');
    const [finding] = findSkillCommandViolations(root);
    expect(finding.core).toBe(true);
    write(
      BASELINE_PATH,
      JSON.stringify({ entries: [{ key: finding.key, skill: 'ct-core-skill' }] }),
    );
    expect(runGate(root)).toBe(1);
  });
});
