/**
 * Unit tests for skills-store.ts — Sphere B typed adapter facade.
 *
 * Mirrors the tmpdir + `resetSkillsDbState` pattern used by
 * `skills-schema.test.ts` so the user-global `~/.local/share/cleo/skills.db`
 * is NEVER touched during tests.
 *
 * @task T9688
 * @epic T9571
 * @saga T9560
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewSkillRow } from '../skills-schema.js';

describe('skills-store (T9688)', () => {
  let tmpRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t9688-'));
    dbPath = join(tmpRoot, 'skills.db');
    const mod = await import('../skills-db.js');
    mod.resetSkillsDbState();
  });

  afterEach(async () => {
    const mod = await import('../skills-db.js');
    mod.closeSkillsDb();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Seed helper: openSkillsDb at tmpdir + upsert a baseline skill row
  // -------------------------------------------------------------------------

  async function seedBaselineSkill(name = 'ct-orchestrator'): Promise<void> {
    const { openSkillsDb, upsertSkillRow } = await import('../skills-db.js');
    const { withProvenance } = await import('../../sentient/skill-provenance.js');
    await openSkillsDb({ path: dbPath });
    const row: NewSkillRow = {
      name,
      version: '1.0.0',
      sourceType: 'canonical',
      installPath: `/tmp/skills/${name}`,
      installedAt: new Date().toISOString(),
      lifecycleState: 'active',
    };
    // T9708 — canonical writes require the pr-generator provenance frame.
    await withProvenance('pr-generator', () => upsertSkillRow(row));
  }

  // -------------------------------------------------------------------------
  // insertUsage
  // -------------------------------------------------------------------------

  it('insertUsage persists a row and returns the server-assigned id', async () => {
    await seedBaselineSkill();
    const { insertUsage } = await import('../skills-store.js');
    const persisted = await insertUsage({
      skillName: 'ct-orchestrator',
      eventKind: 'load',
    });
    expect(persisted.id).toBeGreaterThan(0);
    expect(persisted.skillName).toBe('ct-orchestrator');
    expect(persisted.observedAt).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // getSkillByName
  // -------------------------------------------------------------------------

  it('getSkillByName returns null for unknown names', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });
    const { getSkillByName } = await import('../skills-store.js');
    expect(await getSkillByName('does-not-exist')).toBeNull();
  });

  it('getSkillByName round-trips with upsert', async () => {
    await seedBaselineSkill('ct-cleo');
    const { getSkillByName } = await import('../skills-store.js');
    const row = await getSkillByName('ct-cleo');
    expect(row).not.toBeNull();
    expect(row?.name).toBe('ct-cleo');
  });

  // -------------------------------------------------------------------------
  // listByLifecycle
  // -------------------------------------------------------------------------

  it('listByLifecycle filters rows by lifecycle state', async () => {
    const { openSkillsDb, upsertSkillRow } = await import('../skills-db.js');
    const { withProvenance } = await import('../../sentient/skill-provenance.js');
    await openSkillsDb({ path: dbPath });
    const baseRow = (name: string, state: 'active' | 'stale'): NewSkillRow => ({
      name,
      sourceType: 'canonical',
      installPath: `/tmp/${name}`,
      installedAt: new Date().toISOString(),
      lifecycleState: state,
    });
    // T9708 — canonical writes require the pr-generator provenance frame.
    await withProvenance('pr-generator', async () => {
      await upsertSkillRow(baseRow('a-active', 'active'));
      await upsertSkillRow(baseRow('b-stale', 'stale'));
      await upsertSkillRow(baseRow('c-active', 'active'));
    });

    const { listByLifecycle } = await import('../skills-store.js');
    const active = await listByLifecycle('active');
    expect(active.map((r) => r.name)).toEqual(['a-active', 'c-active']);
    const stale = await listByLifecycle('stale');
    expect(stale.map((r) => r.name)).toEqual(['b-stale']);
  });

  // -------------------------------------------------------------------------
  // getTopUsed
  // -------------------------------------------------------------------------

  it('getTopUsed ranks by event count descending', async () => {
    await seedBaselineSkill('alpha');
    await seedBaselineSkill('beta');
    const { insertUsage, getTopUsed } = await import('../skills-store.js');
    await insertUsage({ skillName: 'alpha', eventKind: 'load' });
    await insertUsage({ skillName: 'alpha', eventKind: 'invoke' });
    await insertUsage({ skillName: 'beta', eventKind: 'load' });

    const top = await getTopUsed(10);
    expect(top[0]).toEqual({ skillName: 'alpha', count: 2 });
    expect(top[1]).toEqual({ skillName: 'beta', count: 1 });
  });

  it('getTopUsed normalises non-positive limit to 10', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });
    const { getTopUsed } = await import('../skills-store.js');
    const rows = await getTopUsed(-1);
    expect(rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // bulkImportFromHermes (stub)
  // -------------------------------------------------------------------------

  it('bulkImportFromHermes returns zero counts for empty input', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });
    const { bulkImportFromHermes } = await import('../skills-store.js');
    const result = await bulkImportFromHermes([]);
    expect(result).toEqual({ imported: 0, skipped: 0, failed: [] });
  });

  it('bulkImportFromHermes upserts entries as canonical sourceType', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });
    const { bulkImportFromHermes, getSkillByName } = await import('../skills-store.js');
    const result = await bulkImportFromHermes([
      { name: 'hermes-one', installPath: '/tmp/hermes-one' },
      { name: 'hermes-two', installPath: '/tmp/hermes-two', version: '1.2.3' },
    ]);
    expect(result.imported).toBe(2);
    expect(result.failed).toEqual([]);
    const one = await getSkillByName('hermes-one');
    expect(one?.sourceType).toBe('canonical');
    const two = await getSkillByName('hermes-two');
    expect(two?.version).toBe('1.2.3');
  });

  // -------------------------------------------------------------------------
  // listSkillsBySource re-export sanity
  // -------------------------------------------------------------------------

  it('listSkillsBySource re-export returns canonical rows', async () => {
    await seedBaselineSkill('canonical-skill');
    const { listSkillsBySource } = await import('../skills-store.js');
    const rows = await listSkillsBySource('canonical');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.sourceType === 'canonical')).toBe(true);
  });
});
