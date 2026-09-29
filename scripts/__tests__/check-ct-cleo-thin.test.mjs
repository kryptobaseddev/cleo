/**
 * Tests for `scripts/check-ct-cleo-thin.mjs` (T9148 · T12124).
 *
 * @task T12124
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findViolations, measure } from '../check-ct-cleo-thin.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'check-ct-cleo-thin.mjs');

const skill = (sections) =>
  ['---', 'name: ct-cleo', '---', '<!-- thin-pointer: see CLEO-INJECTION.md -->', ...sections].join(
    '\n',
  );

describe('check-ct-cleo-thin', () => {
  it('passes the real ct-cleo against its baseline (--check)', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8' });
    expect(run.status, run.stdout).toBe(0);
  });

  it('ratchet: fails on growth, a new section, and a stale baseline section', () => {
    const m = measure(skill(['## Quick Reference', 'a', '## Old', '## Planted']));
    expect(findViolations(m, { maxNonBlankLines: 5, extraHeadings: ['Old', 'Gone'] })).toEqual([
      'packages/skills/skills/ct-cleo/SKILL.md: 8 non-blank lines exceeds the baseline 5 (target 50). Move protocol content to CLEO-INJECTION.md / CLEO-REFERENCE.md or a references/ file.',
      'packages/skills/skills/ct-cleo/SKILL.md: new section "## Planted". Put it in references/ or under "## Skill-Specific Extensions".',
      'scripts/.check-ct-cleo-thin-baseline.json: section "## Gone" is gone — remove it from the baseline.',
    ]);
  });

  it('strict: applies the full T9148 rules', () => {
    const m = measure(skill(['## Quick Reference', '## Extra']));
    expect(findViolations(m, null)).toEqual([
      'packages/skills/skills/ct-cleo/SKILL.md: disallowed section "## Extra". Only "## Quick Reference" and "## Skill-Specific Extensions" are permitted.',
    ]);
  });

  it('fails when the thin-pointer marker is removed', () => {
    const m = measure('---\nname: ct-cleo\n---\n## Quick Reference\n');
    expect(findViolations(m, { maxNonBlankLines: 100, extraHeadings: [] })).toEqual([
      'packages/skills/skills/ct-cleo/SKILL.md: missing <!-- thin-pointer: ... --> marker.',
    ]);
  });
});
