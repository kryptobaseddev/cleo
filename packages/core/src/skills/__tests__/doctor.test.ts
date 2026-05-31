/**
 * Unit tests for the skill-store doctor diagnose pass.
 *
 * Each test sets up a `mkdtemp`-based fake home directory with a specific
 * configuration of the four skill paths, points a tmpdir `skills.db` at it,
 * runs {@link diagnoseSkillStore}, and asserts on the resulting report.
 *
 * Covers the AC matrix from T9652:
 *   1. Empty state (clean install — nothing exists yet).
 *   2. Legacy-only state (only `~/.local/share/agents/skills/` populated).
 *   3. Fully-migrated state (canonical + bridge symlink + agents-shared links).
 *   4. Drift detected (skills.db row whose installPath is missing).
 *   5. Orphan detected (on-disk dir not in skills.db).
 *   6. Broken symlink detected (agents-shared link to deleted target).
 *   7. Real-dir bridge (~/.agents/skills is a real directory, not a symlink).
 *
 * @task T9652
 * @epic T9571
 * @saga T9560
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type NewSkillRow, skills as skillsTable } from '../../store/schema/skills-schema.js';
import { closeSkillsDb, openSkillsDb, resetSkillsDbState } from '../../store/skills-db.js';
import { diagnoseSkillStore, renderDoctorDiagnoseReport } from '../doctor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Sandbox {
  home: string;
  dbPath: string;
  paths: {
    canonicalSsot: string;
    legacyXdg: string;
    agentsSkills: string;
    claudeSkills: string;
    claudeAgentsShared: string;
  };
  cleanup: () => void;
}

/**
 * Build an empty `mkdtemp` sandbox shaped like a $HOME with none of the four
 * skill locations populated. Individual tests then call the `populate*`
 * helpers below to construct each scenario.
 */
function buildSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'cleo-t9652-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const dbPath = join(root, 'skills.db');
  return {
    home,
    dbPath,
    paths: {
      canonicalSsot: join(home, '.cleo', 'skills'),
      legacyXdg: join(home, '.local', 'share', 'agents', 'skills'),
      agentsSkills: join(home, '.agents', 'skills'),
      claudeSkills: join(home, '.claude', 'skills'),
      claudeAgentsShared: join(home, '.claude', 'skills', 'agents-shared'),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Create a directory with a minimal SKILL.md file inside. */
function makeSkillDir(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\nversion: 1.0.0\n---\n# ${name}\n`);
  return dir;
}

/** Build the fully-migrated layout under the sandbox. */
function populateFullyMigrated(sandbox: Sandbox): void {
  mkdirSync(sandbox.paths.canonicalSsot, { recursive: true });
  makeSkillDir(sandbox.paths.canonicalSsot, 'ct-orchestrator');
  makeSkillDir(sandbox.paths.canonicalSsot, 'ct-validator');

  mkdirSync(sandbox.paths.claudeAgentsShared, { recursive: true });
  symlinkSync(
    join(sandbox.paths.canonicalSsot, 'ct-orchestrator'),
    join(sandbox.paths.claudeAgentsShared, 'ct-orchestrator'),
  );
  symlinkSync(
    join(sandbox.paths.canonicalSsot, 'ct-validator'),
    join(sandbox.paths.claudeAgentsShared, 'ct-validator'),
  );

  // Bridge symlink: ~/.agents/skills -> ~/.claude/skills/agents-shared
  mkdirSync(join(sandbox.home, '.agents'), { recursive: true });
  symlinkSync(sandbox.paths.claudeAgentsShared, sandbox.paths.agentsSkills);
}

/** Insert a registry row into the open db. */
async function insertRow(dbPath: string, row: NewSkillRow): Promise<void> {
  const db = await openSkillsDb({ path: dbPath });
  db.insert(skillsTable).values(row).run();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('diagnoseSkillStore — T9652 read-only health report', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = buildSandbox();
    resetSkillsDbState();
  });

  afterEach(() => {
    closeSkillsDb();
    sandbox.cleanup();
  });

  // -------------------------------------------------------------------------
  // 1. Empty state (fresh install — nothing exists)
  // -------------------------------------------------------------------------

  it('empty state — reports preferred SSoT path even when nothing exists', async () => {
    const report = await diagnoseSkillStore({
      homeOverride: sandbox.home,
      dbPathOverride: sandbox.dbPath,
    });

    expect(report.canonicalRoot.path).toBe(sandbox.paths.canonicalSsot);
    expect(report.canonicalRoot.exists).toBe(false);
    expect(report.canonicalRoot.entryCount).toBe(0);
    expect(report.canonicalRoot.isPreferredSsot).toBe(true);

    expect(report.legacyRoot.exists).toBe(false);
    expect(report.bridgeStatus.kind).toBe('missing');
    expect(report.bridgeStatus.bridgeOk).toBe(false);
    expect(report.claudeSkillsAgentsShared.exists).toBe(false);
    expect(report.claudeSkillsDirect.exists).toBe(false);

    expect(report.db.rowCount).toBe(0);
    expect(report.driftEntries).toEqual([]);
    expect(report.orphans).toEqual([]);
    expect(report.brokenSymlinks).toEqual([]);

    // Empty state is NOT healthy — bridge symlink is required.
    expect(report.healthy).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2. Legacy-only state (only ~/.local/share/agents/skills/ populated)
  // -------------------------------------------------------------------------

  it('legacy-only state — surfaces legacy entry count + flags non-preferred root', async () => {
    mkdirSync(sandbox.paths.legacyXdg, { recursive: true });
    makeSkillDir(sandbox.paths.legacyXdg, 'ct-legacy-1');
    makeSkillDir(sandbox.paths.legacyXdg, 'ct-legacy-2');

    const report = await diagnoseSkillStore({
      homeOverride: sandbox.home,
      dbPathOverride: sandbox.dbPath,
    });

    expect(report.legacyRoot.exists).toBe(true);
    expect(report.legacyRoot.entryCount).toBe(2);
    // canonicalSsot does not exist → resolver falls back to legacy.
    expect(report.canonicalRoot.path).toBe(sandbox.paths.legacyXdg);
    expect(report.canonicalRoot.isPreferredSsot).toBe(false);
    expect(report.canonicalRoot.entryCount).toBe(2);

    // Two legacy entries are orphans (not in skills.db).
    expect(report.orphans.length).toBeGreaterThanOrEqual(2);
    expect(report.orphans.some((o) => o.name === 'ct-legacy-1')).toBe(true);
    expect(report.healthy).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. Fully-migrated state
  // -------------------------------------------------------------------------

  it('fully-migrated state — healthy when bridge symlink + db rows align', async () => {
    populateFullyMigrated(sandbox);
    const installedAt = '2026-05-19T00:00:00.000Z';
    await insertRow(sandbox.dbPath, {
      name: 'ct-orchestrator',
      version: '4.0.0',
      sourceType: 'canonical',
      sourceUrl: null,
      installPath: join(sandbox.paths.canonicalSsot, 'ct-orchestrator'),
      canonicalPath: join(sandbox.paths.canonicalSsot, 'ct-orchestrator'),
      installedAt,
      lastUpdatedAt: installedAt,
      lifecycleState: 'active',
      pinned: false,
      isAgentCreated: false,
      archivedAt: null,
      archivedFromPath: null,
    });
    await insertRow(sandbox.dbPath, {
      name: 'ct-validator',
      version: '2.0.0',
      sourceType: 'canonical',
      sourceUrl: null,
      installPath: join(sandbox.paths.canonicalSsot, 'ct-validator'),
      canonicalPath: join(sandbox.paths.canonicalSsot, 'ct-validator'),
      installedAt,
      lastUpdatedAt: installedAt,
      lifecycleState: 'active',
      pinned: false,
      isAgentCreated: false,
      archivedAt: null,
      archivedFromPath: null,
    });

    const report = await diagnoseSkillStore({
      homeOverride: sandbox.home,
      dbPathOverride: sandbox.dbPath,
    });

    expect(report.canonicalRoot.isPreferredSsot).toBe(true);
    expect(report.canonicalRoot.exists).toBe(true);
    expect(report.canonicalRoot.entryCount).toBe(2);
    expect(report.bridgeStatus.kind).toBe('symlink');
    expect(report.bridgeStatus.bridgeOk).toBe(true);
    expect(report.claudeSkillsAgentsShared.entryCount).toBe(2);
    expect(report.db.rowCount).toBe(2);
    expect(report.driftEntries).toEqual([]);
    expect(report.orphans).toEqual([]);
    expect(report.brokenSymlinks).toEqual([]);
    expect(report.perSkillSymlinks).toHaveLength(2);
    expect(report.perSkillSymlinks.every((s) => s.resolved && s.pointsToCanonical)).toBe(true);

    expect(report.healthy).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. Drift detected — db row whose installPath is missing
  // -------------------------------------------------------------------------

  it('drift detected — surfaces db rows whose installPath no longer resolves', async () => {
    populateFullyMigrated(sandbox);
    const missing = join(sandbox.paths.canonicalSsot, 'ct-ghost');
    await insertRow(sandbox.dbPath, {
      name: 'ct-ghost',
      version: '1.0.0',
      sourceType: 'canonical',
      sourceUrl: null,
      installPath: missing,
      canonicalPath: missing,
      installedAt: '2026-05-19T00:00:00.000Z',
      lastUpdatedAt: null,
      lifecycleState: 'active',
      pinned: false,
      isAgentCreated: false,
      archivedAt: null,
      archivedFromPath: null,
    });

    const report = await diagnoseSkillStore({
      homeOverride: sandbox.home,
      dbPathOverride: sandbox.dbPath,
    });

    expect(report.driftEntries).toHaveLength(1);
    expect(report.driftEntries[0]?.name).toBe('ct-ghost');
    expect(report.driftEntries[0]?.reason).toBe('missing-on-disk');
    expect(report.db.missingOnDisk).toContain('ct-ghost');
    expect(report.healthy).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 5. Orphan detected — dir on disk not in skills.db
  // -------------------------------------------------------------------------

  it('orphan detected — surfaces on-disk dirs not present in skills.db', async () => {
    populateFullyMigrated(sandbox);
    // Add an extra dir that nobody registered.
    makeSkillDir(sandbox.paths.canonicalSsot, 'ct-unregistered');

    const report = await diagnoseSkillStore({
      homeOverride: sandbox.home,
      dbPathOverride: sandbox.dbPath,
    });

    expect(report.orphans.some((o) => o.name === 'ct-unregistered')).toBe(true);
    expect(report.orphans.some((o) => o.rootLabel === 'canonical')).toBe(true);
    expect(report.healthy).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. Broken symlink — agents-shared link to a deleted target
  // -------------------------------------------------------------------------

  it('broken symlink detected — surfaces agents-shared link to deleted target', async () => {
    mkdirSync(sandbox.paths.canonicalSsot, { recursive: true });
    mkdirSync(sandbox.paths.claudeAgentsShared, { recursive: true });
    // Symlink to a path that does NOT exist.
    symlinkSync(
      join(sandbox.paths.canonicalSsot, 'ct-deleted'),
      join(sandbox.paths.claudeAgentsShared, 'ct-deleted'),
    );

    const report = await diagnoseSkillStore({
      homeOverride: sandbox.home,
      dbPathOverride: sandbox.dbPath,
    });

    expect(report.brokenSymlinks.length).toBeGreaterThanOrEqual(1);
    expect(report.brokenSymlinks.some((b) => b.path.endsWith('ct-deleted'))).toBe(true);
    expect(report.healthy).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 7. Real-dir bridge — ~/.agents/skills is a real dir, not a symlink
  // -------------------------------------------------------------------------

  it('real-dir bridge detected — surfaces ~/.agents/skills as real-dir kind', async () => {
    mkdirSync(sandbox.paths.canonicalSsot, { recursive: true });
    // ~/.agents/skills as a real dir with N entries.
    mkdirSync(sandbox.paths.agentsSkills, { recursive: true });
    makeSkillDir(sandbox.paths.agentsSkills, 'ct-old-1');
    makeSkillDir(sandbox.paths.agentsSkills, 'ct-old-2');

    const report = await diagnoseSkillStore({
      homeOverride: sandbox.home,
      dbPathOverride: sandbox.dbPath,
    });

    expect(report.bridgeStatus.kind).toBe('real-dir');
    expect(report.bridgeStatus.bridgeOk).toBe(false);
    expect(report.bridgeStatus.realDirEntryCount).toBe(2);
    // The real-dir entries should appear as orphans (need migration).
    expect(report.orphans.some((o) => o.rootLabel === 'agents')).toBe(true);
    expect(report.healthy).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 8. Render — returns a non-empty multi-line string for both modes
  // -------------------------------------------------------------------------

  it('renderDoctorDiagnoseReport produces a stable plain-text summary', async () => {
    populateFullyMigrated(sandbox);
    const report = await diagnoseSkillStore({
      homeOverride: sandbox.home,
      dbPathOverride: sandbox.dbPath,
    });

    const brief = renderDoctorDiagnoseReport(report, false);
    expect(brief).toContain('cleo skills doctor diagnose');
    expect(brief).toContain('Canonical SSoT');
    expect(brief).toContain('Bridge link');
    expect(brief).toMatch(/Overall: (HEALTHY|NEEDS ATTENTION)/);

    const verbose = renderDoctorDiagnoseReport(report, true);
    expect(verbose.length).toBeGreaterThan(brief.length);
    expect(verbose).toContain('Per-skill symlinks');
  });
});
