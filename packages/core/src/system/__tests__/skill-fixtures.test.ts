/**
 * Tests for the caamp test-fixture sweep (T12645).
 *
 * Fixtures below are byte-for-byte what `skills-installer.test.ts` and
 * `skills-installer-recordrow.test.ts` wrote into the real skills root.
 *
 * @task T12645
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { auditSkillFixtures, repairSkillFixtures } from '../skill-fixtures.js';

const UUID = '3f5741af-bfcd-40af-9808-1de587e3100c';

let root: string;
let skillsRoot: string;
let auditDir: string;

function skill(name: string, body: string, extra: Record<string, string> = {}): string {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const fixtureBody = (n: string): string =>
  `---\nname: ${n}\ndescription: Test skill ${n}\n---\n\n# ${n}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-fixtures-'));
  skillsRoot = join(root, 'skills');
  auditDir = join(root, 'audit');
  mkdirSync(skillsRoot, { recursive: true });

  // Fixtures, as the caamp tests wrote them.
  skill(`test-skill-${UUID}`, fixtureBody('test-skill'));
  skill(`deep-${UUID}`, '---\nname: deep-skill\ndescription: Deep nested skill\n---\n', {
    'file1.txt': 'content1',
    'subdir/file2.txt': 'content2',
  });
  skill('real-skill', fixtureBody('skill1'));
  // Never candidates.
  skill('ct-cleo', fixtureBody('ct-cleo'));
  skill('my-skill', fixtureBody('my-skill'));
  mkdirSync(join(skillsRoot, '.audit-log'));
  writeFileSync(join(skillsRoot, '.audit-log', 'adopt.json'), '{}');
  // Fixture-shaped names whose content is not a fixture's.
  skill(
    `notes-${UUID.replace('3f', '4f')}`,
    '---\nname: notes\ndescription: My real notes skill\n---\n',
  );
  skill(`big-${UUID.replace('3f', '5f')}`, fixtureBody('big'), { 'data.bin': 'x'.repeat(4096) });
  symlinkSync(join(skillsRoot, 'my-skill'), join(skillsRoot, `link-${UUID.replace('3f', '6f')}`));
});

const opts = (): { skillsRoot: string; auditDir: string; protectedNames: string[] } => ({
  skillsRoot,
  auditDir,
  protectedNames: ['ct-cleo'],
});

describe('auditSkillFixtures', () => {
  it('classifies only fixture-named entries, by content', () => {
    const audit = auditSkillFixtures(opts());
    const byName = Object.fromEntries(audit.entries.map((e) => [e.name, e.state]));
    expect(byName).toEqual({
      [`big-${UUID.replace('3f', '5f')}`]: 'unclassified',
      [`deep-${UUID}`]: 'fixture',
      [`link-${UUID.replace('3f', '6f')}`]: 'unclassified',
      [`notes-${UUID.replace('3f', '4f')}`]: 'unclassified',
      'real-skill': 'fixture',
      [`test-skill-${UUID}`]: 'fixture',
    });
    expect(audit.counts).toEqual({ fixture: 3, unclassified: 3 });
    expect(audit.healthy).toBe(false);
    expect(audit.remedy).toBe('cleo doctor skill-fixtures --repair');
  });
});

describe('repairSkillFixtures', () => {
  it('dry run moves and writes nothing', () => {
    const { receipt } = repairSkillFixtures({ ...opts(), dryRun: true });
    expect(receipt.phase).toBe('planned');
    expect(receipt.planned).toHaveLength(3);
    expect(existsSync(join(skillsRoot, 'real-skill'))).toBe(true);
    expect(existsSync(auditDir)).toBe(false);
  });

  it('quarantines fixtures with a receipt and leaves everything else', () => {
    const { audit, receipt } = repairSkillFixtures(opts());
    expect(receipt.moved).toHaveLength(3);
    expect(audit.healthy).toBe(true);
    expect(audit.counts).toEqual({ fixture: 0, unclassified: 3 });

    for (const kept of ['ct-cleo', 'my-skill', '.audit-log', `notes-${UUID.replace('3f', '4f')}`]) {
      expect(existsSync(join(skillsRoot, kept))).toBe(true);
    }
    expect(
      readFileSync(join(receipt.quarantineDir, `deep-${UUID}`, 'subdir', 'file2.txt'), 'utf8'),
    ).toBe('content2');

    const lines = readFileSync(join(auditDir, 'skill-fixtures.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).phase)).toEqual(['intent', 'completed']);
    const intent = JSON.parse(lines[0] as string);
    expect(intent.planned.map((p: { from: string }) => p.from)).toContain(
      join(skillsRoot, 'real-skill'),
    );
    expect(intent.planned[0].files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is a no-op on a clean root', () => {
    repairSkillFixtures(opts());
    const { receipt } = repairSkillFixtures(opts());
    expect(receipt.moved).toEqual([]);
    expect(receipt.receiptLog).toBeNull();
  });
});
