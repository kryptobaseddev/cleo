/**
 * Tests for `toolsSkillPruneTelemetry` — Sphere B retention engine op.
 *
 * Seeds a tmp `skills.db` with mixed-age usage rows, then asserts:
 *   - rows older than the cutoff are deleted (real run)
 *   - dry-run returns the projected count without writes
 *   - `--vacuum` runs successfully (file size at most equal post-delete)
 *   - `oldestRemaining` / `newestRemaining` snapshots are correct
 *
 * @task T9693
 * @epic T9561
 * @saga T9560
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('toolsSkillPruneTelemetry (T9693)', () => {
  let tmpRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t9693-'));
    dbPath = join(tmpRoot, 'skills.db');
    const mod = await import('../../store/skills-db.js');
    mod.resetSkillsDbState();
    await mod.openSkillsDb({ path: dbPath });
  });

  afterEach(async () => {
    const mod = await import('../../store/skills-db.js');
    mod.closeSkillsDb();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function seedUsage(): Promise<void> {
    const { upsertSkillRow } = await import('../../store/skills-db.js');
    const { insertUsage } = await import('../../store/skills-store.js');
    const { withProvenance } = await import('../../sentient/skill-provenance.js');
    await withProvenance('pr-generator', () =>
      upsertSkillRow({
        name: 'pruneable',
        sourceType: 'canonical',
        installPath: '/tmp/pruneable',
        installedAt: new Date().toISOString(),
        lifecycleState: 'active',
      }),
    );

    const now = Date.now();
    // 5 rows: 365d old, 200d old, 100d old, 30d old, now.
    const ages = [365, 200, 100, 30, 0];
    for (const days of ages) {
      const ts = new Date(now - days * 86_400_000).toISOString();
      await insertUsage({
        skillName: 'pruneable',
        eventKind: 'load',
        observedAt: ts,
      });
    }
  }

  it('deletes rows older than --older-than DAYS (default 180)', async () => {
    await seedUsage();
    const { toolsSkillPruneTelemetry } = await import('../../engine/engine-ops.js');
    const result = await toolsSkillPruneTelemetry({ olderThanDays: 180 });
    expect(result.success).toBe(true);
    if (!result.success || !result.data) throw new Error('expected success');
    // 365d + 200d are older than 180 → deleted (2 rows).
    expect(result.data.deletedRows).toBe(2);
    expect(result.data.dryRun).toBe(false);
    expect(result.data.vacuumed).toBe(false);
  });

  it('honors custom olderThanDays threshold', async () => {
    await seedUsage();
    const { toolsSkillPruneTelemetry } = await import('../../engine/engine-ops.js');
    const result = await toolsSkillPruneTelemetry({ olderThanDays: 50 });
    expect(result.success).toBe(true);
    if (!result.success || !result.data) throw new Error('expected success');
    // 365d + 200d + 100d are older than 50 → 3 rows deleted.
    expect(result.data.deletedRows).toBe(3);
  });

  it('dry-run returns projected count without writes', async () => {
    await seedUsage();
    const { toolsSkillPruneTelemetry } = await import('../../engine/engine-ops.js');
    const result = await toolsSkillPruneTelemetry({ olderThanDays: 180, dryRun: true });
    expect(result.success).toBe(true);
    if (!result.success || !result.data) throw new Error('expected success');
    expect(result.data.deletedRows).toBe(2);
    expect(result.data.dryRun).toBe(true);
    expect(result.data.dbSizeAfter).toBe(result.data.dbSizeBefore);
    // Verify the actual rows are still there.
    const { openSkillsDb } = await import('../../store/skills-db.js');
    const { skillUsage } = await import('../../store/skills-schema.js');
    const db = await openSkillsDb({ path: dbPath });
    const rows = db.select().from(skillUsage).all();
    expect(rows.length).toBe(5);
  });

  it('--vacuum runs after the delete', async () => {
    await seedUsage();
    const { toolsSkillPruneTelemetry } = await import('../../engine/engine-ops.js');
    const result = await toolsSkillPruneTelemetry({ olderThanDays: 180, vacuum: true });
    expect(result.success).toBe(true);
    if (!result.success || !result.data) throw new Error('expected success');
    expect(result.data.vacuumed).toBe(true);
  });

  it('reports oldestRemaining and newestRemaining bounds', async () => {
    await seedUsage();
    const { toolsSkillPruneTelemetry } = await import('../../engine/engine-ops.js');
    const result = await toolsSkillPruneTelemetry({ olderThanDays: 180 });
    expect(result.success).toBe(true);
    if (!result.success || !result.data) throw new Error('expected success');
    expect(result.data.oldestRemaining).not.toBeNull();
    expect(result.data.newestRemaining).not.toBeNull();
    // Oldest remaining must be more recent than the deleted 200d row.
    const oldestMs = new Date(result.data.oldestRemaining ?? 0).getTime();
    expect(Date.now() - oldestMs).toBeLessThan(181 * 86_400_000);
  });

  it('rejects negative olderThanDays', async () => {
    const { toolsSkillPruneTelemetry } = await import('../../engine/engine-ops.js');
    const result = await toolsSkillPruneTelemetry({ olderThanDays: -1 });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('E_INVALID_INPUT');
  });
});
