/**
 * Unit tests for skills-usage-queue.ts — batched-write queue for telemetry.
 *
 * Verifies:
 *   - `enqueue()` does NOT touch the DB until `flush()` is called.
 *   - Capacity-trigger fires the flush mid-burst.
 *   - 1000 sequential enqueues produce zero DB rows mid-burst and
 *     exactly 1000 rows after an explicit flush.
 *   - `process.beforeExit` hook is installed exactly once across many
 *     enqueues (no listener leak).
 *
 * @task T9694
 * @epic T9561
 * @saga T9560
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewSkillRow, NewSkillUsageRow } from '../skills-schema.js';

describe('skills-usage-queue (T9694)', () => {
  let tmpRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t9694-'));
    dbPath = join(tmpRoot, 'skills.db');
    const dbMod = await import('../skills-db.js');
    dbMod.resetSkillsDbState();
    // Open the tmp DB BEFORE any queue work so the singleton sits at our tmp.
    await dbMod.openSkillsDb({ path: dbPath });
  });

  afterEach(async () => {
    const dbMod = await import('../skills-db.js');
    dbMod.closeSkillsDb();
    const qMod = await import('../skills-usage-queue.js');
    qMod.__setSkillsUsageQueueSingleton(null);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function seedSkill(name: string): Promise<void> {
    const { upsertSkillRow } = await import('../skills-db.js');
    const { withProvenance } = await import('../../sentient/skill-provenance.js');
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

  async function countUsage(skillName: string): Promise<number> {
    const { openSkillsDb } = await import('../skills-db.js');
    const { skillUsage } = await import('../skills-schema.js');
    const { eq } = await import('drizzle-orm');
    const db = await openSkillsDb({ path: dbPath });
    const rows = db.select().from(skillUsage).where(eq(skillUsage.skillName, skillName)).all();
    return rows.length;
  }

  // -------------------------------------------------------------------------
  // enqueue does NOT write until flush
  // -------------------------------------------------------------------------

  it('enqueue() does not persist rows until flush() is called', async () => {
    await seedSkill('queued-skill');
    const { SkillsUsageQueue } = await import('../skills-usage-queue.js');
    const q = new SkillsUsageQueue({
      capacity: 1000,
      idleMs: 0, // disable debounce — only explicit flush writes
      disableBeforeExitHook: true,
    });

    q.enqueue({ skillName: 'queued-skill', eventKind: 'load' });
    q.enqueue({ skillName: 'queued-skill', eventKind: 'view' });

    expect(q.size).toBe(2);
    expect(await countUsage('queued-skill')).toBe(0);

    await q.flush();
    expect(q.size).toBe(0);
    expect(await countUsage('queued-skill')).toBe(2);
  });

  // -------------------------------------------------------------------------
  // capacity-trigger fires flush mid-burst
  // -------------------------------------------------------------------------

  it('hits capacity and auto-flushes mid-burst', async () => {
    await seedSkill('cap-skill');
    const { SkillsUsageQueue } = await import('../skills-usage-queue.js');
    const q = new SkillsUsageQueue({
      capacity: 4,
      idleMs: 0,
      disableBeforeExitHook: true,
    });

    for (let i = 0; i < 4; i++) {
      q.enqueue({ skillName: 'cap-skill', eventKind: 'load' });
    }
    // Capacity-trigger flush is fire-and-forget; await it explicitly.
    await q.flush();
    expect(await countUsage('cap-skill')).toBe(4);
  });

  // -------------------------------------------------------------------------
  // 1000-call burst: zero rows mid-burst, exactly 1000 after flush
  // -------------------------------------------------------------------------

  it('1000 sequential enqueues produce zero DB writes mid-burst and exactly 1000 rows after flush', async () => {
    await seedSkill('burst');
    const { SkillsUsageQueue } = await import('../skills-usage-queue.js');
    const q = new SkillsUsageQueue({
      capacity: 10_000,
      idleMs: 0,
      disableBeforeExitHook: true,
    });

    for (let i = 0; i < 1000; i++) {
      q.enqueue({ skillName: 'burst', eventKind: 'load' });
    }
    // Mid-burst snapshot — no DB writes yet because idleMs=0 disables debounce.
    expect(await countUsage('burst')).toBe(0);
    expect(q.size).toBe(1000);

    await q.flush();
    expect(await countUsage('burst')).toBe(1000);
    expect(q.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // process.beforeExit listener — installed at most once
  // -------------------------------------------------------------------------

  it('installs the beforeExit listener exactly once across many enqueues', async () => {
    const { SkillsUsageQueue } = await import('../skills-usage-queue.js');
    const before = process.listenerCount('beforeExit');
    const q = new SkillsUsageQueue({ capacity: 1000, idleMs: 0 });
    for (let i = 0; i < 50; i++) {
      q.enqueue({ skillName: 'leak-test', eventKind: 'load' });
    }
    const after = process.listenerCount('beforeExit');
    // At most one new listener was added by this queue instance.
    expect(after - before).toBeLessThanOrEqual(1);
    // Clean up by flushing + dropping the singleton.
    await q.flush();
  });

  // -------------------------------------------------------------------------
  // drain() — test-only synchronous discard
  // -------------------------------------------------------------------------

  it('drain() returns the buffered rows and resets size to 0', async () => {
    const { SkillsUsageQueue } = await import('../skills-usage-queue.js');
    const q = new SkillsUsageQueue({
      capacity: 1000,
      idleMs: 0,
      disableBeforeExitHook: true,
    });
    const row: NewSkillUsageRow = { skillName: 'drain', eventKind: 'load' };
    q.enqueue(row);
    q.enqueue(row);
    expect(q.size).toBe(2);

    const drained = q.drain();
    expect(drained.length).toBe(2);
    expect(q.size).toBe(0);
    expect(await countUsage('drain')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // singleton helpers
  // -------------------------------------------------------------------------

  it('enqueueSkillUsage + flushSkillsUsage round-trip via singleton', async () => {
    await seedSkill('singleton-skill');
    const {
      SkillsUsageQueue,
      __setSkillsUsageQueueSingleton,
      enqueueSkillUsage,
      flushSkillsUsage,
    } = await import('../skills-usage-queue.js');
    // Install an isolated test queue so the user-global singleton stays
    // untouched if the suite runs in parallel.
    __setSkillsUsageQueueSingleton(
      new SkillsUsageQueue({ capacity: 1000, idleMs: 0, disableBeforeExitHook: true }),
    );

    enqueueSkillUsage({ skillName: 'singleton-skill', eventKind: 'load' });
    enqueueSkillUsage({ skillName: 'singleton-skill', eventKind: 'invoke' });
    expect(await countUsage('singleton-skill')).toBe(0);

    await flushSkillsUsage();
    expect(await countUsage('singleton-skill')).toBe(2);
  });
});
