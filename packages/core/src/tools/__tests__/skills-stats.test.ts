/**
 * Integration tests for `toolsSkillStats` — Sphere B telemetry rollup engine op.
 *
 * Seeds a tmp `skills.db` with mixed rows + usage events, then asserts the
 * stats engine op returns the expected facets.
 *
 * @task T9690
 * @epic T9561
 * @saga T9560
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewSkillRow } from '../../store/skills-schema.js';

describe('toolsSkillStats (T9690)', () => {
  let tmpRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t9690-'));
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

  async function seed(): Promise<void> {
    const { upsertSkillRow } = await import('../../store/skills-db.js');
    const { insertUsage } = await import('../../store/skills-store.js');
    const { withProvenance } = await import('../../sentient/skill-provenance.js');

    const make = (
      name: string,
      sourceType: NewSkillRow['sourceType'],
      lifecycleState: NewSkillRow['lifecycleState'],
      isAgentCreated = false,
    ): NewSkillRow => ({
      name,
      version: '1.0.0',
      sourceType,
      installPath: `/tmp/skills/${name}`,
      installedAt: new Date().toISOString(),
      lifecycleState,
      isAgentCreated,
    });

    await withProvenance('pr-generator', () =>
      upsertSkillRow(make('alpha', 'canonical', 'active')),
    );
    await upsertSkillRow(make('beta', 'user', 'active'));
    await upsertSkillRow(make('gamma', 'agent-created', 'active', true));
    await upsertSkillRow(make('delta', 'community', 'stale'));

    await insertUsage({ skillName: 'alpha', eventKind: 'load' });
    await insertUsage({ skillName: 'alpha', eventKind: 'invoke' });
    await insertUsage({ skillName: 'alpha', eventKind: 'load' });
    await insertUsage({ skillName: 'beta', eventKind: 'load' });
  }

  it('returns the top-N usage rollup only by default', async () => {
    await seed();
    const { toolsSkillStats } = await import('../engine-ops.js');
    const result = await toolsSkillStats({ top: 5 });
    expect(result.success).toBe(true);
    if (!result.success || !result.data) throw new Error('expected success');
    expect(result.data.top[0]).toEqual({ skillName: 'alpha', count: 3 });
    expect(result.data.top[1]).toEqual({ skillName: 'beta', count: 1 });
    expect(result.data.bySource).toBeNull();
    expect(result.data.byLifecycle).toBeNull();
    expect(result.data.agentCreated).toBeNull();
  });

  it('includes source-type breakdown when bySource=true', async () => {
    await seed();
    const { toolsSkillStats } = await import('../engine-ops.js');
    const result = await toolsSkillStats({ top: 5, bySource: true });
    expect(result.success).toBe(true);
    if (!result.success || !result.data) throw new Error('expected success');
    const counts = Object.fromEntries(result.data.bySource!.map((r) => [r.sourceType, r.count]));
    expect(counts.canonical).toBe(1);
    expect(counts.user).toBe(1);
    expect(counts['agent-created']).toBe(1);
    expect(counts.community).toBe(1);
  });

  it('includes lifecycle breakdown when byLifecycle=true', async () => {
    await seed();
    const { toolsSkillStats } = await import('../engine-ops.js');
    const result = await toolsSkillStats({ top: 5, byLifecycle: true });
    expect(result.success).toBe(true);
    if (!result.success || !result.data) throw new Error('expected success');
    const counts = Object.fromEntries(result.data.byLifecycle!.map((r) => [r.state, r.count]));
    expect(counts.active).toBe(3);
    expect(counts.stale).toBe(1);
  });

  it('lists agent-created skills when agentCreated=true', async () => {
    await seed();
    const { toolsSkillStats } = await import('../engine-ops.js');
    const result = await toolsSkillStats({ top: 5, agentCreated: true });
    expect(result.success).toBe(true);
    if (!result.success || !result.data) throw new Error('expected success');
    expect(result.data.agentCreated?.length).toBe(1);
    expect(result.data.agentCreated?.[0]?.name).toBe('gamma');
    expect(result.data.agentCreated?.[0]?.lifecycleState).toBe('active');
  });

  it('honors top=N limit', async () => {
    await seed();
    const { toolsSkillStats } = await import('../engine-ops.js');
    const result = await toolsSkillStats({ top: 1 });
    expect(result.success).toBe(true);
    if (!result.success || !result.data) throw new Error('expected success');
    expect(result.data.top.length).toBe(1);
    expect(result.data.top[0]?.skillName).toBe('alpha');
  });

  it('returns sinceDays passthrough on the response envelope', async () => {
    await seed();
    const { toolsSkillStats } = await import('../engine-ops.js');
    const result = await toolsSkillStats({ top: 5, sinceDays: 30 });
    expect(result.success).toBe(true);
    if (!result.success || !result.data) throw new Error('expected success');
    expect(result.data.sinceDays).toBe(30);
  });
});
