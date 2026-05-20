/**
 * Tests for hermes-importer.ts — Hermes `.usage.json` → CLEO skills.db migrator.
 *
 * Builds a fixture Hermes home under tmpdir with a synthetic `.usage.json`
 * plus `.bundled_manifest`, runs `importFromHermes`, then asserts:
 *   - source-type mapping (agent / bundled / user)
 *   - counter synthesis (use_count × load, view × view, patch × patch)
 *   - idempotency (re-running produces zero new failures + same DB shape)
 *   - dry-run mode produces no DB writes
 *
 * @task T9691
 * @epic T9561
 * @saga T9560
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const FIXTURE_SIDECAR = {
  'cleo-agent-skill': {
    archived_at: null,
    created_at: '2026-05-19T22:09:40.848843+00:00',
    created_by: 'agent',
    last_patched_at: '2026-05-19T22:10:49.025785+00:00',
    last_used_at: '2026-05-20T05:08:34.564999+00:00',
    last_viewed_at: '2026-05-20T05:08:34.563407+00:00',
    patch_count: 2,
    pinned: false,
    state: 'active',
    use_count: 3,
    view_count: 1,
  },
  'bundled-skill': {
    archived_at: null,
    created_at: '2026-05-04T15:12:32.232081+00:00',
    created_by: null,
    last_patched_at: '2026-05-07T19:09:57.939248+00:00',
    last_used_at: '2026-05-19T15:36:46.111296+00:00',
    last_viewed_at: '2026-05-19T15:36:46.109646+00:00',
    patch_count: 0,
    pinned: false,
    state: 'active',
    use_count: 4,
    view_count: 4,
  },
  'plain-user-skill': {
    archived_at: null,
    created_at: '2026-05-08T10:00:00.000000+00:00',
    created_by: null,
    last_patched_at: null,
    last_used_at: '2026-05-09T11:00:00.000000+00:00',
    last_viewed_at: null,
    patch_count: 0,
    pinned: true,
    state: 'stale',
    use_count: 1,
    view_count: 0,
  },
};

const FIXTURE_BUNDLED_MANIFEST = `bundled-skill:abcdef0123456789
other-bundled:fedcba9876543210
`;

describe('importFromHermes (T9691)', () => {
  let tmpRoot: string;
  let dbPath: string;
  let hermesHome: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t9691-'));
    dbPath = join(tmpRoot, 'skills.db');
    hermesHome = join(tmpRoot, 'hermes-home');
    const skillsDir = join(hermesHome, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, '.usage.json'), JSON.stringify(FIXTURE_SIDECAR, null, 2));
    writeFileSync(join(skillsDir, '.bundled_manifest'), FIXTURE_BUNDLED_MANIFEST);

    const dbMod = await import('../../store/skills-db.js');
    dbMod.resetSkillsDbState();
    await dbMod.openSkillsDb({ path: dbPath });
  });

  afterEach(async () => {
    const dbMod = await import('../../store/skills-db.js');
    dbMod.closeSkillsDb();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function countUsage(skillName: string): Promise<number> {
    const { openSkillsDb } = await import('../../store/skills-db.js');
    const { skillUsage } = await import('../../store/skills-schema.js');
    const { eq } = await import('drizzle-orm');
    const db = await openSkillsDb({ path: dbPath });
    const rows = db.select().from(skillUsage).where(eq(skillUsage.skillName, skillName)).all();
    return rows.length;
  }

  // -------------------------------------------------------------------------
  // Source-type mapping
  // -------------------------------------------------------------------------

  it('maps created_by=agent → sourceType=agent-created', async () => {
    const { importFromHermes } = await import('../hermes-importer.js');
    const response = await importFromHermes({ hermesHome });
    expect(response.imported).toBe(3);
    expect(response.failed).toBe(0);
    const agentRow = response.rows.find((r) => r.name === 'cleo-agent-skill');
    expect(agentRow?.sourceType).toBe('agent-created');
  });

  it('maps bundled-manifest entries → sourceType=canonical', async () => {
    const { importFromHermes } = await import('../hermes-importer.js');
    const response = await importFromHermes({ hermesHome });
    const bundledRow = response.rows.find((r) => r.name === 'bundled-skill');
    expect(bundledRow?.sourceType).toBe('canonical');
  });

  it('falls back to sourceType=user for unbundled / non-agent entries', async () => {
    const { importFromHermes } = await import('../hermes-importer.js');
    const response = await importFromHermes({ hermesHome });
    const plainRow = response.rows.find((r) => r.name === 'plain-user-skill');
    expect(plainRow?.sourceType).toBe('user');
  });

  // -------------------------------------------------------------------------
  // Counter synthesis
  // -------------------------------------------------------------------------

  it('synthesizes use_count × load + view_count × view + patch_count × patch rows', async () => {
    const { importFromHermes } = await import('../hermes-importer.js');
    await importFromHermes({ hermesHome });
    // cleo-agent-skill: use=3, view=1, patch=2 → 6 usage rows.
    expect(await countUsage('cleo-agent-skill')).toBe(6);
    // bundled-skill: use=4, view=4, patch=0 → 8 usage rows.
    expect(await countUsage('bundled-skill')).toBe(8);
    // plain-user-skill: use=1, view=0, patch=0 → 1 usage row.
    expect(await countUsage('plain-user-skill')).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('idempotent — re-running upserts without failures', async () => {
    const { importFromHermes } = await import('../hermes-importer.js');
    const first = await importFromHermes({ hermesHome });
    const second = await importFromHermes({ hermesHome });
    expect(first.imported).toBe(3);
    expect(second.imported).toBe(3);
    expect(second.failed).toBe(0);
    // skills row count is unchanged; usage rows grow because we synthesize
    // each invocation — that's documented behaviour for T9691.
    const { openSkillsDb } = await import('../../store/skills-db.js');
    const { skills } = await import('../../store/skills-schema.js');
    const db = await openSkillsDb({ path: dbPath });
    const rows = db.select().from(skills).all();
    expect(rows.length).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Dry-run mode
  // -------------------------------------------------------------------------

  it('dry-run produces no DB writes', async () => {
    const { importFromHermes } = await import('../hermes-importer.js');
    const response = await importFromHermes({ hermesHome, dryRun: true });
    expect(response.dryRun).toBe(true);
    expect(response.imported).toBe(3);
    expect(response.totalSynthesizedUsage).toBe(6 + 8 + 1);
    const { openSkillsDb } = await import('../../store/skills-db.js');
    const { skills, skillUsage } = await import('../../store/skills-schema.js');
    const db = await openSkillsDb({ path: dbPath });
    const skillsCount = db.select().from(skills).all().length;
    const usageCount = db.select().from(skillUsage).all().length;
    expect(skillsCount).toBe(0);
    expect(usageCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // No-op when Hermes home is empty
  // -------------------------------------------------------------------------

  it('returns zero-counts envelope when sidecar is missing', async () => {
    const { importFromHermes } = await import('../hermes-importer.js');
    const emptyHermes = join(tmpRoot, 'empty-hermes');
    mkdirSync(emptyHermes, { recursive: true });
    const response = await importFromHermes({ hermesHome: emptyHermes });
    expect(response.seen).toBe(0);
    expect(response.imported).toBe(0);
    expect(response.rows).toEqual([]);
  });
});
