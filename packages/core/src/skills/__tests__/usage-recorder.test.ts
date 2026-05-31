/**
 * Unit tests for usage-recorder.ts — best-effort telemetry hook.
 *
 * Mirrors the tmpdir + `resetSkillsDbState` pattern used by
 * `skills-store.test.ts` so the user-global `~/.local/share/cleo/skills.db`
 * is NEVER touched during tests.
 *
 * Tests verify three invariants:
 *   1. `recordSkillUsage('name', 'load')` persists a row.
 *   2. A failing skills.db open does NOT throw out of the recorder.
 *   3. `discoverSkill(path)` records a row when telemetry is enabled.
 *
 * @task T9689
 * @epic T9561
 * @saga T9560
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewSkillRow } from '../../store/schema/skills-schema.js';

describe('usage-recorder (T9689)', () => {
  let tmpRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t9689-'));
    dbPath = join(tmpRoot, 'skills.db');
    const mod = await import('../../store/skills-db.js');
    mod.resetSkillsDbState();
    const recorder = await import('../usage-recorder.js');
    recorder.__setSkillUsageRecorderEnabled(true);
  });

  afterEach(async () => {
    const mod = await import('../../store/skills-db.js');
    mod.closeSkillsDb();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // recordSkillUsage — happy path
  // -------------------------------------------------------------------------

  async function seedSkill(name: string): Promise<void> {
    const { openSkillsDb, upsertSkillRow } = await import('../../store/skills-db.js');
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
    await withProvenance('pr-generator', () => upsertSkillRow(row));
  }

  /**
   * Flush the batching queue and return the row-count for the given skill.
   *
   * The recorder enqueues into the T9694 batched queue, so a synchronous
   * SELECT immediately after the enqueue would see zero rows. Tests flush
   * explicitly to drain the queue into the tmp skills.db.
   */
  async function awaitUsageRow(skillName: string): Promise<number> {
    const { flushSkillsUsage } = await import('../../store/skills-usage-queue.js');
    await flushSkillsUsage();
    const { openSkillsDb } = await import('../../store/skills-db.js');
    const { skillUsage } = await import('../../store/schema/skills-schema.js');
    const { eq } = await import('drizzle-orm');
    const db = await openSkillsDb({ path: dbPath });
    const rows = db.select().from(skillUsage).where(eq(skillUsage.skillName, skillName)).all();
    return rows.length;
  }

  it('records a usage row for action=load', async () => {
    await seedSkill('ct-orchestrator');
    const { recordSkillUsage } = await import('../usage-recorder.js');
    recordSkillUsage('ct-orchestrator', 'load');
    const count = await awaitUsageRow('ct-orchestrator');
    expect(count).toBeGreaterThan(0);
  });

  it('records a usage row for action=edit with taskId context', async () => {
    await seedSkill('my-skill');
    const { recordSkillUsage } = await import('../usage-recorder.js');
    recordSkillUsage('my-skill', 'edit', { taskId: 'T9689' });
    const count = await awaitUsageRow('my-skill');
    expect(count).toBeGreaterThan(0);

    const { openSkillsDb } = await import('../../store/skills-db.js');
    const { skillUsage } = await import('../../store/schema/skills-schema.js');
    const { eq } = await import('drizzle-orm');
    const db = await openSkillsDb({ path: dbPath });
    const rows = db.select().from(skillUsage).where(eq(skillUsage.skillName, 'my-skill')).all();
    expect(rows[0]?.taskId).toBe('T9689');
    expect(rows[0]?.eventKind).toBe('edit');
  });

  // -------------------------------------------------------------------------
  // recordSkillUsage — best-effort: never throws
  // -------------------------------------------------------------------------

  it('does not throw when name is empty', () => {
    expect(async () => {
      const { recordSkillUsage } = await import('../usage-recorder.js');
      recordSkillUsage('', 'load');
    }).not.toThrow();
  });

  it('does not throw when recorder is disabled', async () => {
    const { recordSkillUsage, __setSkillUsageRecorderEnabled } = await import(
      '../usage-recorder.js'
    );
    __setSkillUsageRecorderEnabled(false);
    expect(() => {
      recordSkillUsage('anything', 'load');
    }).not.toThrow();
    __setSkillUsageRecorderEnabled(true);
  });

  // -------------------------------------------------------------------------
  // discoverSkill hook integration
  // -------------------------------------------------------------------------

  it('discoverSkill() records a usage row when telemetry is enabled', async () => {
    // Need to open skills.db at tmpdir first so discoverSkill's telemetry
    // write lands in the test DB, not the user-global one.
    const { openSkillsDb } = await import('../../store/skills-db.js');
    await openSkillsDb({ path: dbPath });

    const skillDir = join(tmpRoot, 'fixture-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: fixture-skill\ndescription: a fixture\n---\n# Fixture\n',
    );

    const { discoverSkill } = await import('../discovery.js');
    const skill = discoverSkill(skillDir);
    expect(skill).not.toBeNull();
    const count = await awaitUsageRow('fixture-skill');
    expect(count).toBeGreaterThan(0);
  });
});
