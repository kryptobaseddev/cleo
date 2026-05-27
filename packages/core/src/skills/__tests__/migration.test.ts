/**
 * Unit tests for `cleo skills migrate` (T9653).
 *
 * Drives the migration helpers in `src/core/skills/migration.ts` against a
 * `mkdtemp`-backed tmpfs with an in-memory `tar` fake so no shell-out, no
 * real `$HOME` mutation, and full determinism.
 *
 * Coverage:
 *   1. `--dry-run` — produces a plan, writes nothing.
 *   2. real migration — copies dirs, writes backup tarball, writes sentinel.
 *   3. idempotent re-run — second migrate call yields `{action:'no-op'}`.
 *   4. `--rollback` — restores legacy tree from the most recent backup.
 *   5. partial-failure resumability — left-over dirs at canonical root are
 *      skipped on the next migrate pass.
 *
 * @task T9653
 */

import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatBackupTimestamp,
  isAlreadyMigrated,
  LEGACY_MIGRATED_MARKER,
  listBackups,
  listSkillDirs,
  type MigratedSkillRecord,
  type MigrationOptions,
  planMigration,
  runMigration,
  runRollback,
  type TarExec,
} from '../migration.js';

// ---------------------------------------------------------------------------
// Test scaffolding — tmpdir + fake tar
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  legacyRoot: string;
  canonicalRoot: string;
  backupDir: string;
}

function makeFixture(): Fixture {
  const root = join(tmpdir(), `caamp-migrate-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return {
    root,
    legacyRoot: join(root, '.local', 'share', 'agents', 'skills'),
    canonicalRoot: join(root, '.cleo', 'skills'),
    backupDir: join(root, '.cleo', 'backups', 'skills'),
  };
}

function seedSkill(legacyRoot: string, name: string): string {
  const dir = join(legacyRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: seed ${name}\n---\n# ${name}\n`,
    'utf-8',
  );
  return dir;
}

/**
 * In-memory `tar` fake: snapshots the source tree to disk in a sidecar
 * directory (so we can detect a "backup was written") and restores it on
 * extract. Behaves identically across create + extract for round-trip tests.
 */
function makeFakeTar(): TarExec & { archives: Map<string, string> } {
  const archives = new Map<string, string>(); // archivePath → snapshotDir

  return {
    archives,
    async create({ archivePath, sourceRoot }) {
      const snapshotDir = `${archivePath}.snapshot`;
      if (existsSync(snapshotDir)) {
        rmSync(snapshotDir, { recursive: true, force: true });
      }
      mkdirSync(snapshotDir, { recursive: true });
      if (existsSync(sourceRoot)) {
        cpSync(sourceRoot, join(snapshotDir, 'root'), { recursive: true });
      }
      // Touch the archive path so consumers can verify file existence.
      writeFileSync(archivePath, JSON.stringify({ sourceRoot }), 'utf-8');
      archives.set(archivePath, snapshotDir);
    },
    async extract({ archivePath, destinationRoot }) {
      const snapshotDir = archives.get(archivePath);
      if (!snapshotDir) {
        throw new Error(`fake-tar: no snapshot recorded for ${archivePath}`);
      }
      mkdirSync(destinationRoot, { recursive: true });
      const snapshotRoot = join(snapshotDir, 'root');
      if (existsSync(snapshotRoot)) {
        // cpSync overwrites by default when target exists, but the migrate
        // flow rms the legacy root before extract — so a plain recursive
        // copy is sufficient here.
        cpSync(snapshotRoot, destinationRoot, { recursive: true });
      }
    },
  };
}

function buildOptions(fx: Fixture, manifestNames: string[] = []): MigrationOptions {
  return {
    legacyRoot: fx.legacyRoot,
    canonicalRoot: fx.canonicalRoot,
    backupDir: fx.backupDir,
    manifestNames,
    now: () => new Date('2026-05-19T12:00:00Z'),
    tarExec: makeFakeTar(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let fx: Fixture;

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  rmSync(fx.root, { recursive: true, force: true });
});

describe('formatBackupTimestamp', () => {
  it('produces YYYYMMDD-HHmmss in UTC', () => {
    const ts = formatBackupTimestamp(new Date('2026-05-19T08:09:07Z'));
    expect(ts).toBe('20260519-080907');
  });
});

describe('listSkillDirs', () => {
  it('returns empty when root is missing', () => {
    expect(listSkillDirs(join(fx.root, 'nope'))).toEqual([]);
  });

  it('lists top-level dirs in sorted order, skipping the sentinel', () => {
    seedSkill(fx.legacyRoot, 'ct-zeta');
    seedSkill(fx.legacyRoot, 'ct-alpha');
    seedSkill(fx.legacyRoot, 'user-skill');
    writeFileSync(join(fx.legacyRoot, LEGACY_MIGRATED_MARKER), '{}', 'utf-8');
    expect(listSkillDirs(fx.legacyRoot)).toEqual(['ct-alpha', 'ct-zeta', 'user-skill']);
  });
});

describe('isAlreadyMigrated', () => {
  it('returns true when legacy root does not exist', () => {
    expect(isAlreadyMigrated(join(fx.root, 'missing'))).toBe(true);
  });

  it('returns true when the sentinel is present', () => {
    seedSkill(fx.legacyRoot, 'foo');
    writeFileSync(join(fx.legacyRoot, LEGACY_MIGRATED_MARKER), '{}', 'utf-8');
    expect(isAlreadyMigrated(fx.legacyRoot)).toBe(true);
  });

  it('returns false when legacy exists with no sentinel', () => {
    seedSkill(fx.legacyRoot, 'foo');
    expect(isAlreadyMigrated(fx.legacyRoot)).toBe(false);
  });
});

describe('planMigration (dry-run engine)', () => {
  it('returns no-op when nothing to migrate', () => {
    const outcome = planMigration(buildOptions(fx));
    expect(outcome.action).toBe('no-op');
    expect(outcome.migrated).toEqual([]);
    expect(outcome.backupPath).toBeNull();
  });

  it('flags canonical skills via manifest membership', () => {
    seedSkill(fx.legacyRoot, 'ct-orchestrator');
    seedSkill(fx.legacyRoot, 'my-user-skill');
    const outcome = planMigration(buildOptions(fx, ['ct-orchestrator', 'ct-lead']));
    expect(outcome.action).toBe('dry-run');
    expect(outcome.migrated).toHaveLength(2);
    const byName = new Map(outcome.migrated.map((m) => [m.name, m]));
    expect(byName.get('ct-orchestrator')?.sourceType).toBe('canonical');
    expect(byName.get('my-user-skill')?.sourceType).toBe('user');
  });

  it('skips entries already present at the destination', () => {
    seedSkill(fx.legacyRoot, 'shared');
    mkdirSync(join(fx.canonicalRoot, 'shared'), { recursive: true });
    const outcome = planMigration(buildOptions(fx));
    expect(outcome.migrated).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0]).toMatchObject({
      name: 'shared',
      reason: 'already-present',
    });
  });

  it('does not write to the filesystem', () => {
    seedSkill(fx.legacyRoot, 'foo');
    planMigration(buildOptions(fx));
    expect(existsSync(fx.canonicalRoot)).toBe(false);
    expect(existsSync(fx.backupDir)).toBe(false);
    expect(existsSync(join(fx.legacyRoot, LEGACY_MIGRATED_MARKER))).toBe(false);
  });
});

describe('runMigration', () => {
  it('copies entries and writes backup + sentinel', async () => {
    seedSkill(fx.legacyRoot, 'ct-orchestrator');
    seedSkill(fx.legacyRoot, 'user-skill');
    const recorded: MigratedSkillRecord[] = [];
    const options: MigrationOptions = {
      ...buildOptions(fx, ['ct-orchestrator']),
      recordRow: (row) => {
        recorded.push(row);
      },
    };

    const outcome = await runMigration(options);

    expect(outcome.action).toBe('migrate');
    expect(outcome.migrated).toHaveLength(2);
    expect(outcome.backupPath).toContain('skills-pre-migrate-20260519-120000.tgz');

    // Files actually landed at the destination.
    expect(existsSync(join(fx.canonicalRoot, 'ct-orchestrator', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(fx.canonicalRoot, 'user-skill', 'SKILL.md'))).toBe(true);

    // Sentinel written.
    const sentinel = JSON.parse(readFileSync(join(fx.legacyRoot, LEGACY_MIGRATED_MARKER), 'utf-8'));
    expect(sentinel.entries).toBe(2);
    expect(sentinel.canonicalRoot).toBe(fx.canonicalRoot);

    // recordRow invoked per migrated entry.
    expect(recorded.map((r) => r.name).sort()).toEqual(['ct-orchestrator', 'user-skill']);
  });

  it('is idempotent: second run is a no-op', async () => {
    seedSkill(fx.legacyRoot, 'alpha');
    const opts = buildOptions(fx);
    await runMigration(opts);
    const second = await runMigration(opts);
    expect(second.action).toBe('no-op');
    expect(second.migrated).toEqual([]);
    expect(second.backupPath).toBeNull();
  });

  it('skips a partial-state entry that already exists at the destination', async () => {
    // Simulate a previous run that copied "alpha" but crashed before the
    // sentinel was written.
    seedSkill(fx.legacyRoot, 'alpha');
    seedSkill(fx.legacyRoot, 'beta');
    mkdirSync(join(fx.canonicalRoot, 'alpha'), { recursive: true });
    writeFileSync(join(fx.canonicalRoot, 'alpha', 'SKILL.md'), 'pre-existing', 'utf-8');

    const outcome = await runMigration(buildOptions(fx));
    expect(outcome.action).toBe('migrate');
    expect(outcome.migrated.map((m) => m.name)).toEqual(['beta']);
    expect(outcome.skipped.map((s) => s.name)).toEqual(['alpha']);
    expect(readFileSync(join(fx.canonicalRoot, 'alpha', 'SKILL.md'), 'utf-8')).toBe('pre-existing');
  });
});

describe('runRollback', () => {
  it('restores legacy tree from the most recent backup', async () => {
    seedSkill(fx.legacyRoot, 'gamma');
    const opts = buildOptions(fx);
    await runMigration(opts);

    // Verify the sentinel + canonical copy exist before rollback.
    expect(existsSync(join(fx.legacyRoot, LEGACY_MIGRATED_MARKER))).toBe(true);

    const outcome = await runRollback(opts);
    expect(outcome.action).toBe('rollback');
    expect(outcome.backupPath).not.toBeNull();
    // Legacy tree was extracted back (without sentinel).
    expect(existsSync(join(fx.legacyRoot, 'gamma', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(fx.legacyRoot, LEGACY_MIGRATED_MARKER))).toBe(false);
  });

  it('throws when no backup tarballs exist', async () => {
    await expect(runRollback(buildOptions(fx))).rejects.toThrow(/No backup tarballs/);
  });
});

describe('listBackups', () => {
  it('returns absolute paths, newest first', () => {
    mkdirSync(fx.backupDir, { recursive: true });
    writeFileSync(join(fx.backupDir, 'skills-pre-migrate-20260101-000000.tgz'), '', 'utf-8');
    writeFileSync(join(fx.backupDir, 'skills-pre-migrate-20260601-000000.tgz'), '', 'utf-8');
    writeFileSync(join(fx.backupDir, 'unrelated.txt'), '', 'utf-8');
    const sorted = listBackups(fx.backupDir);
    expect(sorted).toHaveLength(2);
    expect(sorted[0]).toContain('20260601');
    expect(sorted[1]).toContain('20260101');
  });

  it('returns empty when backup dir does not exist', () => {
    expect(listBackups(join(fx.root, 'nope'))).toEqual([]);
  });
});

describe('end-to-end: dry-run → migrate → re-run → rollback', () => {
  it('walks the full lifecycle without leaving stale state', async () => {
    seedSkill(fx.legacyRoot, 'ct-lead');
    seedSkill(fx.legacyRoot, 'user-skill');
    const opts = buildOptions(fx, ['ct-lead']);

    // 1. Dry-run — plan only, no writes.
    const dry = planMigration(opts);
    expect(dry.action).toBe('dry-run');
    expect(dry.migrated).toHaveLength(2);
    expect(existsSync(fx.canonicalRoot)).toBe(false);

    // 2. Real migrate.
    const migrated = await runMigration(opts);
    expect(migrated.action).toBe('migrate');
    expect(readdirSync(fx.canonicalRoot).sort()).toEqual(['ct-lead', 'user-skill']);

    // 3. Re-run is a no-op.
    const again = await runMigration(opts);
    expect(again.action).toBe('no-op');

    // 4. Rollback restores legacy.
    const restored = await runRollback(opts);
    expect(restored.action).toBe('rollback');
    expect(existsSync(join(fx.legacyRoot, 'ct-lead', 'SKILL.md'))).toBe(true);
  });
});
