/**
 * Tests for the bundled-skill prune (T12678).
 *
 * Ownership comes only from CLEO's install ledger, content must still hash
 * to what CLEO wrote, and nothing is deleted — owned paths move into a
 * quarantine that `restoreQuarantine` reverses. The review of #1660
 * reproduced three deletions of user-owned skills; each is a test here.
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
  type PruneLockEntry,
  type PruneRegistry,
  pruneBundledSkills,
  pruneCandidates,
  recordBundledInstalls,
  restoreQuarantine,
} from '../prune-bundled.js';

let root: string;
let bundled: string;
let skillsRoot: string;
let quarantineRoot: string;
let claude: string;
let pi: string;

/** In-memory lock file and skills.db. */
let locks: Map<string, PruneLockEntry>;
let rows: Map<string, { sourceType: string; lifecycleState: string }>;

const registry: PruneRegistry = {
  async lockEntry(name) {
    return locks.get(name) ?? null;
  },
  async removeLockEntry(name) {
    locks.delete(name);
  },
  async restoreLockEntry(name, entry) {
    locks.set(name, entry);
  },
  async skillRow(name) {
    return rows.get(name) ?? null;
  },
  async setLifecycleState(name, state) {
    const r = rows.get(name);
    if (r) rows.set(name, { ...r, lifecycleState: state });
  },
};

/** Create a skill directory. */
function skillDir(path: string, name: string, extra = ''): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\n---\n${extra}`);
}

/** True when something (even a dangling link) exists at `path`. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Install a skill "as CLEO": canonical copy, harness link, ledger record. */
async function cleoInstall(name: string): Promise<void> {
  skillDir(join(skillsRoot, name), name);
  symlinkSync(join(skillsRoot, name), join(claude, name));
  await recordBundledInstalls(skillsRoot, [name]);
}

const run = (dryRun = false) =>
  pruneBundledSkills({
    bundledSkillsDir: bundled,
    skillsRoot,
    providerSkillDirs: [claude, claude, pi],
    registry,
    dryRun,
    quarantineRoot,
    receiptPath: join(skillsRoot, '.prune-receipts.jsonl'),
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prune-bundled-'));
  bundled = join(root, 'bundle', 'skills');
  skillsRoot = join(root, 'cleo', 'skills');
  quarantineRoot = join(root, 'cleo', 'skills-quarantine');
  claude = join(root, 'claude', 'skills');
  pi = join(root, 'pi', 'skills');
  for (const d of [bundled, skillsRoot, claude, pi]) mkdirSync(d, { recursive: true });
  writeFileSync(
    join(bundled, 'manifest.json'),
    JSON.stringify({
      skills: [
        { name: 'ct-cleo', install: 'harness' },
        { name: 'ct-grade', install: 'internal' },
        { name: 'ct-skill-author', install: 'internal' },
      ],
      retiredSkills: ['ct-docs-lookup', 'loom', 'signaldock-connect'],
    }),
  );
  locks = new Map();
  rows = new Map();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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

describe('pruneBundledSkills — CLEO-owned, unmodified', () => {
  it('quarantines ct-grade (link, Pi copy, canonical copy) and leaves harness skills', async () => {
    await cleoInstall('ct-cleo');
    await cleoInstall('ct-grade');
    skillDir(join(pi, 'ct-grade'), 'ct-grade');
    const receipt = await run();
    expect(present(join(claude, 'ct-grade'))).toBe(false);
    expect(present(join(pi, 'ct-grade'))).toBe(false);
    expect(existsSync(join(skillsRoot, 'ct-grade'))).toBe(false);
    expect(present(join(claude, 'ct-cleo'))).toBe(true);
    // Nothing deleted: it all sits in the quarantine.
    const record = JSON.parse(
      readFileSync(join(quarantineRoot, receipt.quarantineId ?? '', 'quarantine.json'), 'utf8'),
    );
    expect(record.moves).toHaveLength(3);
    for (const m of record.moves) expect(present(m.to)).toBe(true);
  });

  it('dry-run lists what would be quarantined and moves nothing', async () => {
    await cleoInstall('ct-grade');
    const receipt = await run(true);
    expect(receipt.quarantineId).toBeNull();
    expect(receipt.actions.filter((a) => a.action === 'would-quarantine')).toHaveLength(2);
    expect(existsSync(join(skillsRoot, 'ct-grade'))).toBe(true);
    expect(existsSync(quarantineRoot)).toBe(false);
  });

  it('removes a library lock entry and archives the canonical skills.db row; restore reverses all of it', async () => {
    await cleoInstall('ct-grade');
    locks.set('ct-grade', { source: 'library:ct-grade', sourceType: 'library' });
    rows.set('ct-grade', { sourceType: 'canonical', lifecycleState: 'active' });
    const receipt = await run();
    expect(locks.has('ct-grade')).toBe(false);
    expect(rows.get('ct-grade')?.lifecycleState).toBe('archived');

    const restored = await restoreQuarantine({
      quarantineRoot,
      id: receipt.quarantineId ?? '',
      skillsRoot,
      registry,
    });
    expect(restored.conflicts).toEqual([]);
    expect(existsSync(join(skillsRoot, 'ct-grade', 'SKILL.md'))).toBe(true);
    expect(present(join(claude, 'ct-grade'))).toBe(true);
    expect(locks.get('ct-grade')?.source).toBe('library:ct-grade');
    expect(rows.get('ct-grade')?.lifecycleState).toBe('active');
    const ledger = JSON.parse(readFileSync(join(skillsRoot, BUNDLED_LEDGER_FILE), 'utf8'));
    expect(Object.keys(ledger.skills)).toContain('ct-grade');
  });

  it('restore reports a conflict instead of overwriting a re-created path', async () => {
    await cleoInstall('ct-grade');
    const receipt = await run();
    skillDir(join(skillsRoot, 'ct-grade'), 'ct-grade', 'new\n');
    const restored = await restoreQuarantine({
      quarantineRoot,
      id: receipt.quarantineId ?? '',
      skillsRoot,
      registry,
    });
    expect(restored.conflicts).toEqual([join(skillsRoot, 'ct-grade')]);
    expect(readFileSync(join(skillsRoot, 'ct-grade', 'SKILL.md'), 'utf8')).toContain('new');
  });
});

describe('pruneBundledSkills — never touches what CLEO cannot prove it wrote (#1660 repros)', () => {
  it('repro 1: a user-installed signaldock-connect (retired name) is kept — no ledger record', async () => {
    skillDir(join(skillsRoot, 'signaldock-connect'), 'signaldock-connect');
    symlinkSync(join(skillsRoot, 'signaldock-connect'), join(claude, 'signaldock-connect'));
    const receipt = await run();
    expect(existsSync(join(skillsRoot, 'signaldock-connect', 'SKILL.md'))).toBe(true);
    expect(present(join(claude, 'signaldock-connect'))).toBe(true);
    expect(receipt.actions.every((a) => a.action === 'kept')).toBe(true);
  });

  it('repro 2: a user-installed ct-skill-author (internal) is kept when the lock records a user source', async () => {
    await cleoInstall('ct-skill-author');
    locks.set('ct-skill-author', { source: 'github:someone/skills', sourceType: 'github' });
    await run();
    expect(existsSync(join(skillsRoot, 'ct-skill-author', 'SKILL.md'))).toBe(true);
    expect(present(join(claude, 'ct-skill-author'))).toBe(true);
  });

  it('repro 2b: ct-skill-author installed without any CLEO ledger record is kept', async () => {
    skillDir(join(skillsRoot, 'ct-skill-author'), 'ct-skill-author');
    symlinkSync(join(skillsRoot, 'ct-skill-author'), join(claude, 'ct-skill-author'));
    await run();
    expect(existsSync(join(skillsRoot, 'ct-skill-author', 'SKILL.md'))).toBe(true);
  });

  it('repro 3: a user-edited loom canonical copy and its Pi copy are kept', async () => {
    await cleoInstall('loom');
    writeFileSync(join(skillsRoot, 'loom', 'SKILL.md'), '---\nname: loom\n---\nmy edits\n');
    skillDir(join(pi, 'loom'), 'loom', 'my edits\n');
    const receipt = await run();
    expect(readFileSync(join(skillsRoot, 'loom', 'SKILL.md'), 'utf8')).toContain('my edits');
    expect(present(join(pi, 'loom'))).toBe(true);
    // The harness link points at a modified copy, so it stays too.
    expect(present(join(claude, 'loom'))).toBe(true);
    expect(receipt.quarantineId).toBeNull();
  });

  it('a skills.db row with a non-canonical source keeps the skill', async () => {
    await cleoInstall('ct-grade');
    rows.set('ct-grade', { sourceType: 'user', lifecycleState: 'active' });
    await run();
    expect(existsSync(join(skillsRoot, 'ct-grade'))).toBe(true);
  });

  it('a same-named link that points elsewhere is kept', async () => {
    await cleoInstall('ct-grade');
    rmSync(join(claude, 'ct-grade'));
    const userCopy = join(root, 'user', 'ct-grade');
    skillDir(userCopy, 'ct-grade', 'user\n');
    symlinkSync(userCopy, join(claude, 'ct-grade'));
    await run();
    expect(present(join(claude, 'ct-grade'))).toBe(true);
    expect(existsSync(join(userCopy, 'SKILL.md'))).toBe(true);
  });

  it('a Pi copy that differs from what CLEO installed is kept', async () => {
    await cleoInstall('ct-grade');
    skillDir(join(pi, 'ct-grade'), 'ct-grade', 'user notes\n');
    await run();
    expect(present(join(pi, 'ct-grade'))).toBe(true);
  });
});
