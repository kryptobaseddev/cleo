/**
 * Unit tests for the sentient SKILLS CURATOR (T9677).
 *
 * Covers:
 *   - Triple guard: canonical / pinned / dbSourceType='canonical' rows are skipped.
 *   - Stale transition: `active` row with anchor older than `staleAfterDays` → `stale`.
 *   - Archive transition: row with anchor older than `archiveAfterDays` → on-disk
 *     directory moved into `<skillsRoot>/.archive/<name>-<ts>/` and row updated.
 *   - Reactivate transition: `stale` row with recent anchor → `active`.
 *   - Dry-run: same visit log, no disk writes, no db row mutations.
 *   - Restore round-trip: archive then restore brings the row back to `active`
 *     and the directory back to the live root.
 *
 * @task T9677, T9562
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewSkillRow } from '../../store/skills-schema.js';
import {
  __resetCuratorForTest,
  applyTransition,
  CURATABLE_SOURCE_TYPES,
  DEFAULT_ARCHIVE_AFTER_DAYS,
  DEFAULT_STALE_AFTER_DAYS,
  restoreSkillFromArchive,
  runCuratorTick,
} from '../curator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reference "now" used across the suite — every cutoff is anchored on this. */
const NOW = new Date('2026-05-19T00:00:00.000Z');

/** Days → ISO timestamp helper for installed_at / last_updated_at. */
function isoDaysAgo(days: number, now: Date = NOW): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Build a fully-populated NewSkillRow with sensible defaults. */
function buildRow(
  overrides: Partial<NewSkillRow> & { name: string; installPath: string },
): NewSkillRow {
  return {
    name: overrides.name,
    version: '0.1.0',
    sourceType: 'agent-created',
    sourceUrl: null,
    installPath: overrides.installPath,
    canonicalPath: null,
    installedAt: isoDaysAgo(0),
    lastUpdatedAt: isoDaysAgo(0),
    lifecycleState: 'active',
    pinned: false,
    isAgentCreated: true,
    archivedAt: null,
    archivedFromPath: null,
    ...overrides,
  };
}

/** Plant a fake skill directory with a SKILL.md so cp/rm see real bytes. */
function plantSkillDir(skillsRoot: string, name: string): string {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`, 'utf-8');
  return dir;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('sentient curator', () => {
  let tmpRoot: string;
  let dbPath: string;
  let skillsRoot: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t9677-'));
    dbPath = join(tmpRoot, 'skills.db');
    skillsRoot = join(tmpRoot, 'skills');
    mkdirSync(skillsRoot, { recursive: true });

    // Ensure a clean singleton before every case — different tmpdirs bleed
    // across tests otherwise.
    const mod = await import('../../store/skills-db.js');
    mod.resetSkillsDbState();
    await mod.openSkillsDb({ path: dbPath });
  });

  afterEach(() => {
    __resetCuratorForTest();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Sanity
  // -------------------------------------------------------------------------

  it('exposes sensible defaults', () => {
    expect(DEFAULT_STALE_AFTER_DAYS).toBe(30);
    expect(DEFAULT_ARCHIVE_AFTER_DAYS).toBe(90);
    expect(CURATABLE_SOURCE_TYPES).toContain('agent-created');
    expect(CURATABLE_SOURCE_TYPES).toContain('user');
    expect(CURATABLE_SOURCE_TYPES).not.toContain('canonical');
  });

  // -------------------------------------------------------------------------
  // Triple guard
  // -------------------------------------------------------------------------

  it('refuses to archive a canonical row (db source_type = canonical)', async () => {
    const { upsertSkillRow } = await import('../../store/skills-db.js');
    const installPath = plantSkillDir(skillsRoot, 'ct-orchestrator');
    // listSkillsBySource filters by sourceType, and 'canonical' is NOT in
    // CURATABLE_SOURCE_TYPES — so the curator should never see this row at
    // all. We still seed it to prove that even if a future caller widens
    // CURATABLE_SOURCE_TYPES, the triple guard would catch it.
    await upsertSkillRow(
      buildRow({
        name: 'ct-orchestrator',
        installPath,
        sourceType: 'canonical',
        installedAt: isoDaysAgo(365),
        lastUpdatedAt: isoDaysAgo(365),
      }),
    );

    const result = await runCuratorTick({ now: NOW, skillsRoot });

    // The curator does not even visit canonical rows.
    expect(result.transitions).toHaveLength(0);
    expect(result.summary.archived).toBe(0);
    expect(existsSync(installPath)).toBe(true);
  });

  it('refuses to archive a pinned row even when archive cutoff is breached', async () => {
    const { upsertSkillRow } = await import('../../store/skills-db.js');
    const installPath = plantSkillDir(skillsRoot, 'pinned-skill');
    await upsertSkillRow(
      buildRow({
        name: 'pinned-skill',
        installPath,
        pinned: true,
        installedAt: isoDaysAgo(365),
        lastUpdatedAt: isoDaysAgo(365),
      }),
    );

    const result = await runCuratorTick({ now: NOW, skillsRoot });

    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]?.kind).toBe('skip');
    expect(result.transitions[0]?.skipReason).toBe('pinned');
    expect(existsSync(installPath)).toBe(true);
  });

  it('refuses to archive when manifest lists the basename (is_canonical via manifest)', async () => {
    const { upsertSkillRow } = await import('../../store/skills-db.js');
    const installPath = plantSkillDir(skillsRoot, 'ct-lead');
    await upsertSkillRow(
      buildRow({
        name: 'ct-lead',
        installPath,
        // Lie about source so only the manifest can save it.
        sourceType: 'agent-created',
        installedAt: isoDaysAgo(365),
        lastUpdatedAt: isoDaysAgo(365),
      }),
    );

    const result = await runCuratorTick({
      now: NOW,
      skillsRoot,
      manifestNames: ['ct-lead', 'ct-orchestrator'],
    });

    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]?.kind).toBe('skip');
    expect(result.transitions[0]?.skipReason).toBe('canonical');
    expect(existsSync(installPath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  it('marks an active row stale when anchor crosses stale cutoff but not archive cutoff', async () => {
    const { upsertSkillRow, getSkillRow } = await import('../../store/skills-db.js');
    const installPath = plantSkillDir(skillsRoot, 'going-stale');
    await upsertSkillRow(
      buildRow({
        name: 'going-stale',
        installPath,
        installedAt: isoDaysAgo(45),
        lastUpdatedAt: isoDaysAgo(45),
        lifecycleState: 'active',
      }),
    );

    const result = await runCuratorTick({ now: NOW, skillsRoot });

    expect(result.summary.markedStale).toBe(1);
    expect(result.summary.archived).toBe(0);
    const fresh = await getSkillRow('going-stale');
    expect(fresh?.lifecycleState).toBe('stale');
    expect(existsSync(installPath)).toBe(true);
  });

  it('archives a row whose anchor crossed the archive cutoff', async () => {
    const { upsertSkillRow, getSkillRow } = await import('../../store/skills-db.js');
    const installPath = plantSkillDir(skillsRoot, 'old-skill');
    await upsertSkillRow(
      buildRow({
        name: 'old-skill',
        installPath,
        installedAt: isoDaysAgo(120),
        lastUpdatedAt: isoDaysAgo(120),
        lifecycleState: 'stale',
      }),
    );

    const result = await runCuratorTick({ now: NOW, skillsRoot });

    expect(result.summary.archived).toBe(1);
    expect(existsSync(installPath)).toBe(false);

    // Archive destination exists and contains the original SKILL.md.
    const archiveRoot = join(skillsRoot, '.archive');
    const entries = readdirSync(archiveRoot);
    expect(entries.some((e) => e.startsWith('old-skill-'))).toBe(true);

    const fresh = await getSkillRow('old-skill');
    expect(fresh?.lifecycleState).toBe('archived');
    expect(fresh?.archivedAt).toBeTruthy();
    expect(fresh?.archivedFromPath).toBe(installPath);
  });

  it('reactivates a stale row when activity returned within the stale window', async () => {
    const { upsertSkillRow, getSkillRow } = await import('../../store/skills-db.js');
    const installPath = plantSkillDir(skillsRoot, 'comeback');
    await upsertSkillRow(
      buildRow({
        name: 'comeback',
        installPath,
        installedAt: isoDaysAgo(200),
        // last_updated_at is recent → anchor wins on max(last_updated, installed).
        lastUpdatedAt: isoDaysAgo(2),
        lifecycleState: 'stale',
      }),
    );

    const result = await runCuratorTick({ now: NOW, skillsRoot });

    expect(result.summary.reactivated).toBe(1);
    const fresh = await getSkillRow('comeback');
    expect(fresh?.lifecycleState).toBe('active');
  });

  // -------------------------------------------------------------------------
  // Dry-run
  // -------------------------------------------------------------------------

  it('dry-run produces the same visit log but writes nothing', async () => {
    const { upsertSkillRow, getSkillRow } = await import('../../store/skills-db.js');
    const installPath = plantSkillDir(skillsRoot, 'dry-target');
    await upsertSkillRow(
      buildRow({
        name: 'dry-target',
        installPath,
        installedAt: isoDaysAgo(120),
        lastUpdatedAt: isoDaysAgo(120),
        lifecycleState: 'stale',
      }),
    );

    const result = await runCuratorTick({ now: NOW, skillsRoot, dryRun: true });

    expect(result.summary.dryRun).toBe(true);
    // Transition was planned but not applied.
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]?.kind).toBe('archive');
    // Disk untouched.
    expect(existsSync(installPath)).toBe(true);
    const archiveRoot = join(skillsRoot, '.archive');
    expect(existsSync(archiveRoot)).toBe(false);
    // Row unchanged.
    const fresh = await getSkillRow('dry-target');
    expect(fresh?.lifecycleState).toBe('stale');
  });

  // -------------------------------------------------------------------------
  // applyTransition direct
  // -------------------------------------------------------------------------

  it('applyTransition is a no-op for kind=skip', async () => {
    const { upsertSkillRow } = await import('../../store/skills-db.js');
    const installPath = plantSkillDir(skillsRoot, 'noop');
    await upsertSkillRow(
      buildRow({
        name: 'noop',
        installPath,
      }),
    );

    const out = await applyTransition(
      {
        name: 'noop',
        installPath,
        fromState: 'active',
        toState: 'active',
        kind: 'skip',
        anchorAt: NOW.toISOString(),
        skipReason: 'no-transition-needed',
      },
      { skillsRoot, now: NOW },
    );
    expect(out.archiveDestination).toBeNull();
    expect(existsSync(installPath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Restore round-trip
  // -------------------------------------------------------------------------

  it('archive → restore round-trip restores the skill back to active', async () => {
    const { upsertSkillRow, getSkillRow } = await import('../../store/skills-db.js');
    const installPath = plantSkillDir(skillsRoot, 'roundtrip');
    await upsertSkillRow(
      buildRow({
        name: 'roundtrip',
        installPath,
        installedAt: isoDaysAgo(120),
        lastUpdatedAt: isoDaysAgo(120),
      }),
    );

    // 1. Archive via curator.
    const tick = await runCuratorTick({ now: NOW, skillsRoot });
    expect(tick.summary.archived).toBe(1);
    expect(existsSync(installPath)).toBe(false);

    // 2. Restore.
    const restored = await restoreSkillFromArchive('roundtrip', {
      skillsRoot,
      now: new Date(NOW.getTime() + 1000),
    });
    expect(restored.restoredTo).toBe(installPath);
    expect(existsSync(installPath)).toBe(true);

    const fresh = await getSkillRow('roundtrip');
    expect(fresh?.lifecycleState).toBe('active');
    expect(fresh?.archivedAt).toBeNull();
    expect(fresh?.archivedFromPath).toBeNull();
  });

  it('restore refuses to clobber an existing live install path', async () => {
    const { upsertSkillRow } = await import('../../store/skills-db.js');
    const installPath = plantSkillDir(skillsRoot, 'cant-clobber');
    await upsertSkillRow(
      buildRow({
        name: 'cant-clobber',
        installPath,
        installedAt: isoDaysAgo(120),
        lastUpdatedAt: isoDaysAgo(120),
      }),
    );

    await runCuratorTick({ now: NOW, skillsRoot });

    // Re-plant the directory so restore sees a clobber target.
    plantSkillDir(skillsRoot, 'cant-clobber');

    await expect(restoreSkillFromArchive('cant-clobber', { skillsRoot, now: NOW })).rejects.toThrow(
      /refuse-to-clobber/,
    );
  });

  it('restore throws when no archive exists for the requested name', async () => {
    await expect(restoreSkillFromArchive('ghost-skill', { skillsRoot, now: NOW })).rejects.toThrow(
      /nothing to restore|no archive/i,
    );
  });
});
