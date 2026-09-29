/**
 * `cleo skills validate` validates the SKILL.md — T12655.
 *
 * Drives {@link toolsSkillVerify}, the engine op behind `cleo skills
 * validate`, against planted skills in a temp dir. Before T12655 it only
 * reported installation and catalog status and returned success for any
 * input, so every planted defect below passed.
 *
 * @task T12655
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSkillsRoot } from '../../skills/skill-root.js';
import { toolsSkillVerify } from '../engine-ops.js';

let root: string;

/** Write `<root>/<dir>/SKILL.md` and return the skill directory. */
function plant(dir: string, frontmatter: string, body = 'Do the thing.\n'): string {
  const skillDir = join(root, dir);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`);
  return skillDir;
}

const GOOD_DESCRIPTION =
  'description: Validates planted skills so the gate has something real to check.';

beforeEach(() => {
  root = mkdtempSync(join(process.env['CLEO_HOME'] ?? '/nonexistent', 'skill-verify-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('toolsSkillVerify (cleo skills validate)', () => {
  it('passes a valid skill directory and reports the file it checked', async () => {
    const dir = plant('ct-good', `name: ct-good\n${GOOD_DESCRIPTION}`);
    const result = await toolsSkillVerify(dir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.valid).toBe(true);
    expect(result.data.file).toBe(join(dir, 'SKILL.md'));
    expect(result.data.skill).toBe('ct-good');
  });

  it('fails E_VALIDATION with findings when description is missing', async () => {
    const dir = plant('ct-nodesc', 'name: ct-nodesc');
    const result = await toolsSkillVerify(join(dir, 'SKILL.md'));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_VALIDATION');
    expect(result.error.message).toMatch(/description: Missing required field/);
    const details = result.error.details as { valid: boolean; issues: { field: string }[] };
    expect(details.valid).toBe(false);
    expect(details.issues.map((i) => i.field)).toContain('description');
  });

  it('fails on invalid YAML (a duplicated metadata block)', async () => {
    const dir = plant(
      'ct-dupe',
      `name: ct-dupe\n${GOOD_DESCRIPTION}\nmetadata:\n  version: 1.0.0\nmetadata:\n  version: 2.0.0`,
    );
    const result = await toolsSkillVerify(dir);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_VALIDATION');
    expect(result.error.message).toMatch(/frontmatter/i);
  });

  it('fails when name does not equal its directory, or is malformed', async () => {
    const mismatch = await toolsSkillVerify(plant('ct-dir', `name: ct-other\n${GOOD_DESCRIPTION}`));
    expect(mismatch.success).toBe(false);
    if (!mismatch.success) {
      expect(mismatch.error.message).toMatch(/name 'ct-other' must equal its directory 'ct-dir'/);
    }
    const badName = await toolsSkillVerify(
      plant('Bad_Name', `name: Bad_Name\n${GOOD_DESCRIPTION}`),
    );
    expect(badName.success).toBe(false);
  });

  it('resolves a bare name to the installed skill', async () => {
    const skillsRoot = resolveSkillsRoot();
    mkdirSync(join(skillsRoot, 'ct-installed-verify'), { recursive: true });
    writeFileSync(
      join(skillsRoot, 'ct-installed-verify', 'SKILL.md'),
      '---\nname: ct-installed-verify\n---\n\nBody.\n',
    );
    try {
      const result = await toolsSkillVerify('ct-installed-verify');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('E_VALIDATION');
    } finally {
      rmSync(join(skillsRoot, 'ct-installed-verify'), { recursive: true, force: true });
    }
  });

  it('fails E_NOT_FOUND for a path that does not exist', async () => {
    const result = await toolsSkillVerify(join(root, 'missing', 'SKILL.md'));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('E_NOT_FOUND');
  });
});
