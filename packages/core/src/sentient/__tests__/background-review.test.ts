/**
 * Tests for the auto-improve background-review pipeline + write-guards.
 *
 * Covers:
 *  - T9708 — `is_canonical` write-guard refuses non-pr-generator origins.
 *  - T9708 — `pr-generator` origin is allowed to mutate canonical rows.
 *  - T9707 — the background-review fork installs the `background-review`
 *    provenance frame BEFORE invoking the review callback.
 *  - T9715 — `applyLocalSkillPatch` writes under `~/.cleo/skills/<name>/`
 *    and records to `skill_patches`, scoped to `background-review` origin.
 *
 * Mirrors the tmpdir + `resetSkillsDbState` discipline used by the rest of
 * the skills-store test suite so the user-global `skills.db` is NEVER
 * touched during CI.
 *
 * @task T9707
 * @task T9708
 * @task T9715
 * @epic T9563
 * @saga T9560
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewSkillRow } from '../../store/schema/skills-schema.js';

describe('T9708 — canonical write-guard', () => {
  let tmpRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t9708-'));
    dbPath = join(tmpRoot, 'skills.db');
    const mod = await import('../../store/skills-db.js');
    mod.resetSkillsDbState();
  });

  afterEach(async () => {
    const mod = await import('../../store/skills-db.js');
    mod.closeSkillsDb();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('refuses canonical writes from foreground origin with E_CANONICAL_READ_ONLY', async () => {
    const { openSkillsDb, upsertSkillRow, E_CANONICAL_READ_ONLY } = await import(
      '../../store/skills-db.js'
    );
    const { withProvenance } = await import('../skill-provenance.js');
    await openSkillsDb({ path: dbPath });

    const row: NewSkillRow = {
      name: 'ct-foreground-attempt',
      sourceType: 'canonical',
      installPath: '/tmp/skills/ct-foreground-attempt',
      installedAt: new Date().toISOString(),
    };

    await expect(withProvenance('foreground', () => upsertSkillRow(row))).rejects.toMatchObject({
      code: E_CANONICAL_READ_ONLY,
    });
  });

  it('refuses canonical writes from background-review origin', async () => {
    const { openSkillsDb, upsertSkillRow, E_CANONICAL_READ_ONLY } = await import(
      '../../store/skills-db.js'
    );
    const { withProvenance } = await import('../skill-provenance.js');
    await openSkillsDb({ path: dbPath });

    const row: NewSkillRow = {
      name: 'ct-review-attempt',
      sourceType: 'canonical',
      installPath: '/tmp/skills/ct-review-attempt',
      installedAt: new Date().toISOString(),
    };

    await expect(
      withProvenance('background-review', () => upsertSkillRow(row)),
    ).rejects.toMatchObject({ code: E_CANONICAL_READ_ONLY });
  });

  it('refuses canonical writes when no provenance frame is set', async () => {
    const { openSkillsDb, upsertSkillRow, E_CANONICAL_READ_ONLY } = await import(
      '../../store/skills-db.js'
    );
    await openSkillsDb({ path: dbPath });

    const row: NewSkillRow = {
      name: 'ct-orphan-attempt',
      sourceType: 'canonical',
      installPath: '/tmp/skills/ct-orphan-attempt',
      installedAt: new Date().toISOString(),
    };

    await expect(upsertSkillRow(row)).rejects.toMatchObject({ code: E_CANONICAL_READ_ONLY });
  });

  it('allows canonical writes from pr-generator origin', async () => {
    const { openSkillsDb, upsertSkillRow, getSkillRow } = await import('../../store/skills-db.js');
    const { withProvenance } = await import('../skill-provenance.js');
    await openSkillsDb({ path: dbPath });

    const row: NewSkillRow = {
      name: 'ct-pr-generator-row',
      sourceType: 'canonical',
      installPath: '/tmp/skills/ct-pr-generator-row',
      installedAt: new Date().toISOString(),
    };

    await withProvenance('pr-generator', () => upsertSkillRow(row));
    const persisted = await getSkillRow('ct-pr-generator-row');
    expect(persisted?.sourceType).toBe('canonical');
  });

  it('allows non-canonical writes from any origin (and absent frame)', async () => {
    const { openSkillsDb, upsertSkillRow } = await import('../../store/skills-db.js');
    const { withProvenance } = await import('../skill-provenance.js');
    await openSkillsDb({ path: dbPath });

    const userRow: NewSkillRow = {
      name: 'my-user-skill',
      sourceType: 'user',
      installPath: '/tmp/skills/my-user-skill',
      installedAt: new Date().toISOString(),
    };
    // No frame
    await expect(upsertSkillRow(userRow)).resolves.toMatchObject({ sourceType: 'user' });

    const agentRow: NewSkillRow = {
      name: 'agent-built',
      sourceType: 'agent-created',
      installPath: '/tmp/skills/agent-built',
      installedAt: new Date().toISOString(),
      isAgentCreated: true,
    };
    // background-review frame
    await withProvenance('background-review', async () => {
      await expect(upsertSkillRow(agentRow)).resolves.toMatchObject({
        sourceType: 'agent-created',
      });
    });
  });
});

describe('T9707 — background-review fork installs provenance frame', () => {
  beforeEach(async () => {
    const mod = await import('../../store/skills-db.js');
    mod.resetSkillsDbState();
  });
  afterEach(async () => {
    const mod = await import('../../store/skills-db.js');
    mod.closeSkillsDb();
  });

  it('runReviewInline installs background-review origin before invoking the callback', async () => {
    const { runReviewInline } = await import('../background-review.js');
    const { getCurrentWriteOrigin } = await import('../skill-provenance.js');

    let observedOrigin: string | undefined;
    await runReviewInline({
      skillName: 'unit-test-skill',
      recentTaskContext: 'driven by unit test',
      lifecycleState: 'active',
      callback: async () => {
        observedOrigin = getCurrentWriteOrigin();
        return {
          decision: 'approved',
          summary: 'looks good',
        };
      },
    });
    expect(observedOrigin).toBe('background-review');
  });

  it('runReviewInline returns the callback verdict and exposes the prompt that was built', async () => {
    const { runReviewInline } = await import('../background-review.js');

    const outcome = await runReviewInline({
      skillName: 'verdict-test',
      recentTaskContext: 'used 3 times last week',
      lifecycleState: 'stale',
      callback: async () => ({ decision: 'needs-changes', summary: 'rewrite intro' }),
    });
    expect(outcome.verdict.decision).toBe('needs-changes');
    expect(outcome.verdict.summary).toBe('rewrite intro');
    expect(outcome.prompt).toContain('# Skill Review — verdict-test');
    expect(outcome.prompt).toContain('STALE');
  });

  it('runReviewInline propagates callback errors without leaking the origin frame', async () => {
    const { runReviewInline } = await import('../background-review.js');
    const { getCurrentWriteOrigin } = await import('../skill-provenance.js');

    await expect(
      runReviewInline({
        skillName: 'boom',
        recentTaskContext: '',
        lifecycleState: 'active',
        callback: async () => {
          throw new Error('llm exploded');
        },
      }),
    ).rejects.toThrow('llm exploded');
    // After the rejection, the surrounding frame must NOT still have
    // 'background-review' active.
    expect(getCurrentWriteOrigin()).toBeUndefined();
  });
});

describe('T9715 — applyLocalSkillPatch writes under ~/.cleo/skills + records patch row', () => {
  let tmpRoot: string;
  let dbPath: string;
  let skillsRoot: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t9715-'));
    dbPath = join(tmpRoot, 'skills.db');
    skillsRoot = join(tmpRoot, 'skills');
    const mod = await import('../../store/skills-db.js');
    mod.resetSkillsDbState();
  });

  afterEach(async () => {
    const mod = await import('../../store/skills-db.js');
    mod.closeSkillsDb();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes patched files under skillsRoot and records a skill_patches row', async () => {
    const { openSkillsDb, upsertSkillRow } = await import('../../store/skills-db.js');
    await openSkillsDb({ path: dbPath });
    // Seed a Sphere B user row — local-patch refuses to apply against
    // a missing row by design.
    await upsertSkillRow({
      name: 'my-local-skill',
      sourceType: 'user',
      installPath: join(skillsRoot, 'my-local-skill'),
      installedAt: new Date().toISOString(),
    });

    const { applyLocalSkillPatch } = await import('../local-patch.js');
    const result = await applyLocalSkillPatch({
      skillName: 'my-local-skill',
      diff: '--- a/SKILL.md\n+++ b/SKILL.md\n@@ updated @@\n',
      files: [{ relativePath: 'SKILL.md', contents: '# My Local Skill\n\nv2\n' }],
      skillsRootOverride: skillsRoot,
    });

    expect(result.appliedAt).toBeTruthy();
    expect(result.patchId).toBeGreaterThan(0);
    expect(result.writtenPaths).toHaveLength(1);

    const written = readFileSync(join(skillsRoot, 'my-local-skill', 'SKILL.md'), 'utf8');
    expect(written).toBe('# My Local Skill\n\nv2\n');

    // Patch row must be marked applied.
    const { skillPatches } = await import('../../store/schema/skills-schema.js');
    const { openSkillsDb: open } = await import('../../store/skills-db.js');
    const db = await open();
    const rows = db.select().from(skillPatches).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('applied');
    expect(rows[0]?.skillName).toBe('my-local-skill');
  });

  it('refuses canonical-targeted patches (E_CANONICAL_READ_ONLY)', async () => {
    const { openSkillsDb, upsertSkillRow } = await import('../../store/skills-db.js');
    const { withProvenance } = await import('../skill-provenance.js');
    await openSkillsDb({ path: dbPath });

    // Seed a canonical row first.
    await withProvenance('pr-generator', () =>
      upsertSkillRow({
        name: 'ct-protected',
        sourceType: 'canonical',
        installPath: join(skillsRoot, 'ct-protected'),
        installedAt: new Date().toISOString(),
      }),
    );

    const { applyLocalSkillPatch } = await import('../local-patch.js');
    await expect(
      applyLocalSkillPatch({
        skillName: 'ct-protected',
        diff: '...',
        files: [{ relativePath: 'SKILL.md', contents: 'should not write' }],
        skillsRootOverride: skillsRoot,
      }),
    ).rejects.toMatchObject({ code: 'E_CANONICAL_READ_ONLY' });
  });
});
