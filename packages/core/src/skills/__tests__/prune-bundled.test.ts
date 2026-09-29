/**
 * Tests for {@link pruneBundledSkills} (T12678).
 *
 * Covers the ct-grade case (a skill later declared internal), a retired
 * skill, dry-run, the receipt, the ledger, and — most importantly — that
 * nothing CLEO cannot prove it owns is ever deleted.
 *
 * @task T12678
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_LEDGER_FILE,
  pruneBundledSkills,
  pruneCandidates,
  writeBundledLedger,
} from '../prune-bundled.js';

let root: string;
let bundled: string;
let skillsRoot: string;
let claude: string;
let pi: string;
let receiptPath: string;

/** Create a skill directory with a SKILL.md. */
function skillDir(path: string, name: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\n---\n`);
}

/** True when a path exists without following symlinks. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prune-bundled-'));
  bundled = join(root, 'bundle', 'skills');
  skillsRoot = join(root, 'cleo', 'skills');
  claude = join(root, 'claude', 'skills');
  pi = join(root, 'pi', 'skills');
  receiptPath = join(skillsRoot, '.prune-receipts.jsonl');
  mkdirSync(bundled, { recursive: true });
  writeFileSync(
    join(bundled, 'manifest.json'),
    JSON.stringify({
      skills: [
        { name: 'ct-cleo', install: 'harness' },
        { name: 'ct-grade', install: 'internal' },
      ],
      retiredSkills: ['ct-docs-lookup'],
    }),
  );
  for (const name of ['ct-cleo', 'ct-grade', 'ct-docs-lookup']) {
    skillDir(join(skillsRoot, name), name);
  }
  mkdirSync(claude, { recursive: true });
  mkdirSync(pi, { recursive: true });
  for (const name of ['ct-cleo', 'ct-grade', 'ct-docs-lookup']) {
    symlinkSync(join(skillsRoot, name), join(claude, name));
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const run = (dryRun = false) =>
  pruneBundledSkills({
    bundledSkillsDir: bundled,
    skillsRoot,
    providerSkillDirs: [claude, pi],
    dryRun,
    receiptPath,
  });

describe('pruneCandidates', () => {
  it('is every non-harness entry plus retiredSkills', () => {
    expect(
      pruneCandidates({
        skills: [
          { name: 'a', install: 'harness' },
          { name: 'b', install: 'internal' },
        ],
        retiredSkills: ['c'],
      }),
    ).toEqual(['b', 'c']);
  });
});

describe('pruneBundledSkills', () => {
  it('removes ct-grade (now internal) and a retired skill, leaving harness skills', async () => {
    const receipt = await run();
    expect(present(join(claude, 'ct-grade'))).toBe(false);
    expect(existsSync(join(skillsRoot, 'ct-grade'))).toBe(false);
    expect(present(join(claude, 'ct-docs-lookup'))).toBe(false);
    expect(existsSync(join(skillsRoot, 'ct-docs-lookup'))).toBe(false);
    expect(present(join(claude, 'ct-cleo'))).toBe(true);
    expect(existsSync(join(skillsRoot, 'ct-cleo'))).toBe(true);
    expect(
      receipt.actions
        .filter((a) => a.action === 'removed')
        .map((a) => a.name)
        .sort(),
    ).toEqual(['ct-docs-lookup', 'ct-docs-lookup', 'ct-grade', 'ct-grade']);
  });

  it('dry-run lists what would be pruned and deletes nothing', async () => {
    const receipt = await run(true);
    expect(receipt.dryRun).toBe(true);
    expect(
      receipt.actions
        .filter((a) => a.action === 'would-remove')
        .map((a) => a.path)
        .sort(),
    ).toEqual(
      [
        join(claude, 'ct-docs-lookup'),
        join(claude, 'ct-grade'),
        join(skillsRoot, 'ct-docs-lookup'),
        join(skillsRoot, 'ct-grade'),
      ].sort(),
    );
    expect(present(join(claude, 'ct-grade'))).toBe(true);
    expect(existsSync(join(skillsRoot, 'ct-grade'))).toBe(true);
    expect(existsSync(receiptPath)).toBe(false);
  });

  it('appends a receipt line on a real run', async () => {
    await run();
    const lines = readFileSync(receiptPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).candidates).toEqual(['ct-docs-lookup', 'ct-grade']);
  });

  it('never touches a user-owned real directory of the same name', async () => {
    skillDir(join(pi, 'ct-grade'), 'ct-grade');
    writeFileSync(join(pi, 'ct-grade', 'NOTES.md'), 'my own edits\n');
    const receipt = await run();
    expect(existsSync(join(pi, 'ct-grade', 'SKILL.md'))).toBe(true);
    expect(receipt.actions).toContainEqual(
      expect.objectContaining({ path: join(pi, 'ct-grade'), action: 'skipped' }),
    );
  });

  it('removes a byte-identical harness copy (copy-mode harness such as Pi)', async () => {
    skillDir(join(pi, 'ct-grade'), 'ct-grade');
    await run();
    expect(present(join(pi, 'ct-grade'))).toBe(false);
  });

  it('visits a directory shared by several providers once', async () => {
    const receipt = await pruneBundledSkills({
      bundledSkillsDir: bundled,
      skillsRoot,
      providerSkillDirs: [claude, claude, pi],
      dryRun: true,
    });
    const paths = receipt.actions.map((a) => a.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('never follows a same-named symlink that points outside the CLEO root', async () => {
    rmSync(join(claude, 'ct-grade'));
    const userCopy = join(root, 'user', 'ct-grade');
    skillDir(userCopy, 'ct-grade');
    symlinkSync(userCopy, join(claude, 'ct-grade'));
    await run();
    expect(present(join(claude, 'ct-grade'))).toBe(true);
    expect(existsSync(join(userCopy, 'SKILL.md'))).toBe(true);
    // No CLEO link and no ledger record: the canonical copy is not provably CLEO's.
    expect(existsSync(join(skillsRoot, 'ct-grade'))).toBe(true);
  });

  it('removes an unlinked canonical copy only when the ledger records it', async () => {
    rmSync(join(claude, 'ct-grade'));
    await run();
    expect(existsSync(join(skillsRoot, 'ct-grade'))).toBe(true);

    await writeBundledLedger(skillsRoot, ['ct-grade']);
    await run();
    expect(existsSync(join(skillsRoot, 'ct-grade'))).toBe(false);
    const ledger = JSON.parse(readFileSync(join(skillsRoot, BUNDLED_LEDGER_FILE), 'utf-8'));
    expect(ledger.skills).not.toContain('ct-grade');
  });

  it('removes a dangling CLEO link whose canonical copy is already gone', async () => {
    rmSync(join(skillsRoot, 'ct-grade'), { recursive: true });
    await run();
    expect(present(join(claude, 'ct-grade'))).toBe(false);
  });
});
