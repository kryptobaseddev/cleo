/**
 * Tests for the IVTR `ivtr_state` read + cantbook-mirror surface.
 *
 * The hand-rolled phase-walk functions (`startIvtr`/`advanceIvtr`/
 * `loopBackIvtr`/`releaseIvtr`) and the per-phase prompt/auto-gate helpers were
 * deleted in T11896 when the IVTR loop was collapsed onto the cantbook runtime.
 * This file now covers the RETAINED surface:
 *
 * - `seedIvtrForPlaybook` — the `cleo go` seam seeds `ivtr_state` at implement.
 * - `finalizeIvtrFromPlaybook` — mirrors the cantbook run's terminal status
 *   back into `ivtr_state` so the strict `E_IVTR_INCOMPLETE` gate stays
 *   load-bearing (a `completed` run drives the column to `released`).
 * - `getIvtrState` — the read path backing the completion gate +
 *   `cleo show --ivtr-history`.
 *
 * @epic T810
 * @task T811
 * @task T11805 — cantbook seam (seed + finalize mirror)
 * @task T11896 — phase-walk functions deleted; this is the read/mirror surface
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalizeIvtrFromPlaybook, getIvtrState, seedIvtrForPlaybook } from '../ivtr-loop.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-ivtr-'));
  const cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;

  // Reset SQLite singleton so each test gets a fresh DB
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();

  // Seed a test task so FK references don't fail
  const { createTask } = await import('../../store/tasks-sqlite.js');
  await createTask(
    {
      id: 'T999',
      title: 'Test Task',
      description: 'A task for IVTR testing',
      // T11578 · AC1: 'in_progress' is NOT a valid TASK_STATUSES member — the
      // legacy bare `tasks` table had no CHECK so it slipped through; the
      // consolidated `tasks_tasks` CHECK rejects it. Canonical = 'active'.
      status: 'active',
      priority: 'medium',
      depends: [],
    },
    testDir,
  );
});

afterEach(async () => {
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// seedIvtrForPlaybook — the cantbook seam seeds ivtr_state at implement
// ---------------------------------------------------------------------------

describe('seedIvtrForPlaybook (T11805 cantbook seam)', () => {
  it('getIvtrState returns null before any seed', async () => {
    const state = await getIvtrState('T999', { cwd: testDir });
    expect(state).toBeNull();
  });

  // T11805 — the `cleo go` seam seeds ivtr_state via seedIvtrForPlaybook so the
  // strict E_IVTR_INCOMPLETE completion gate stays load-bearing for
  // cantbook-driven runs (collapse-plan §3 item 4).
  it('seeds a fresh schema-v2 implement-phase state', async () => {
    const seeded = await seedIvtrForPlaybook('T999', { cwd: testDir });

    expect(seeded.taskId).toBe('T999');
    expect(seeded.currentPhase).toBe('implement');
    expect(seeded.schemaVersion).toBe(2);
    expect(seeded.phaseHistory).toHaveLength(1);
    expect(seeded.phaseHistory[0]?.phase).toBe('implement');
    expect(seeded.phaseHistory[0]?.passed).toBeNull();
    expect(seeded.phaseHistory[0]?.completedAt).toBeNull();
    expect(seeded.loopBackCount).toEqual({
      implement: 0,
      validate: 0,
      audit: 0,
      test: 0,
      released: 0,
    });

    // Persisted: the strict gate reads it back as non-null.
    const readBack = await getIvtrState('T999', { cwd: testDir });
    expect(readBack).not.toBeNull();
    expect(readBack?.currentPhase).toBe('implement');
  });

  it('is idempotent — second call returns existing state', async () => {
    const first = await seedIvtrForPlaybook('T999', { cwd: testDir });
    const second = await seedIvtrForPlaybook('T999', { cwd: testDir });

    expect(second.startedAt).toBe(first.startedAt);
    expect(second.phaseHistory).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// finalizeIvtrFromPlaybook — terminal-status mirror back into ivtr_state
// ---------------------------------------------------------------------------

// T11805 — terminal-mirror: the `cleo go` cantbook seam mirrors the playbook
// run's TERMINAL status back into ivtr_state so the strict E_IVTR_INCOMPLETE
// gate reflects an autonomous run (collapse-plan §3 item 4 + Risk #2).
describe('finalizeIvtrFromPlaybook (T11805 terminal mirror)', () => {
  it("on 'completed' advances seeded implement state to released with passing phase history", async () => {
    // Seam seeds at implement (passed: null) — this is the frozen state the
    // bug left behind. finalize must drive it to released.
    const seeded = await seedIvtrForPlaybook('T999', { cwd: testDir });
    expect(seeded.currentPhase).toBe('implement');
    expect(seeded.phaseHistory[0]?.passed).toBeNull();

    const result = await finalizeIvtrFromPlaybook('T999', 'completed', {
      cwd: testDir,
      runId: 'pbr_999',
      finalContext: { taskId: 'T999', testsPassed: true, __lastError: 'should-be-stripped' },
    });

    expect(result.state?.currentPhase).toBe('released');
    // implement/validate/audit/test all have a passing entry → gate passes.
    for (const phase of ['implement', 'validate', 'audit', 'test'] as const) {
      const hasPassed = result.state?.phaseHistory.some(
        (e) => e.phase === phase && e.passed === true,
      );
      expect(hasPassed).toBe(true);
    }
    // No in-progress entry remains (gate's active-entry check passes).
    expect(result.state?.phaseHistory.every((e) => e.completedAt !== null)).toBe(true);

    // Persisted: read back as released.
    const readBack = await getIvtrState('T999', { cwd: testDir });
    expect(readBack?.currentPhase).toBe('released');
  });

  it("on 'completed' reproduces the attachment-store evidence write (sha256 recorded)", async () => {
    await seedIvtrForPlaybook('T999', { cwd: testDir });
    const result = await finalizeIvtrFromPlaybook('T999', 'completed', {
      cwd: testDir,
      runId: 'pbr_evidence',
      finalContext: { taskId: 'T999', diff: 'abc' },
    });

    // A provenance evidence ref (sha256) is produced and recorded.
    expect(result.evidenceRef).toMatch(/^[0-9a-f]{64}$/);
    const allRefs = result.state?.phaseHistory.flatMap((e) => e.evidenceRefs) ?? [];
    expect(allRefs).toContain(result.evidenceRef);
  });

  it("on 'failed' marks the active phase failed and leaves currentPhase un-advanced (gate blocks)", async () => {
    await seedIvtrForPlaybook('T999', { cwd: testDir });
    const result = await finalizeIvtrFromPlaybook('T999', 'failed', {
      cwd: testDir,
      runId: 'pbr_fail',
      error: 'implement node exceeded retries',
    });

    expect(result.state?.currentPhase).toBe('implement'); // NOT released
    const implEntry = result.state?.phaseHistory.find((e) => e.phase === 'implement');
    expect(implEntry?.passed).toBe(false);
    expect(implEntry?.reason).toMatch(/Playbook failed/);

    // The strict gate (currentPhase !== 'released') would still block complete.
    const readBack = await getIvtrState('T999', { cwd: testDir });
    expect(readBack?.currentPhase).not.toBe('released');
  });

  it("on 'exceeded_iteration_cap' marks failed and does not release", async () => {
    await seedIvtrForPlaybook('T999', { cwd: testDir });
    const result = await finalizeIvtrFromPlaybook('T999', 'exceeded_iteration_cap', {
      cwd: testDir,
    });
    expect(result.state?.currentPhase).toBe('implement');
    const implEntry = result.state?.phaseHistory.find((e) => e.phase === 'implement');
    expect(implEntry?.passed).toBe(false);
  });

  it("on 'pending_approval' is a no-op (run awaits HITL; later resume finalizes)", async () => {
    await seedIvtrForPlaybook('T999', { cwd: testDir });
    const result = await finalizeIvtrFromPlaybook('T999', 'pending_approval', { cwd: testDir });
    expect(result.state?.currentPhase).toBe('implement');
    // Seed entry stays in-progress (passed: null) — nothing was finalized.
    expect(result.state?.phaseHistory[0]?.passed).toBeNull();
  });

  it('returns null state when no ivtr_state was seeded (defensive no-op)', async () => {
    const result = await finalizeIvtrFromPlaybook('T999', 'completed', { cwd: testDir });
    expect(result.state).toBeNull();
  });

  it('is idempotent when already released', async () => {
    await seedIvtrForPlaybook('T999', { cwd: testDir });
    await finalizeIvtrFromPlaybook('T999', 'completed', { cwd: testDir, runId: 'r1' });
    const second = await finalizeIvtrFromPlaybook('T999', 'completed', {
      cwd: testDir,
      runId: 'r2',
    });
    expect(second.state?.currentPhase).toBe('released');
  });

  it('end-to-end: seed → finalize(completed) yields a state the strict gate accepts', async () => {
    // Mirror the gate's own check (complete.ts:1400): ivtrState !== null &&
    // currentPhase !== 'released' → reject. After finalize, this must pass.
    await seedIvtrForPlaybook('T999', { cwd: testDir });
    await finalizeIvtrFromPlaybook('T999', 'completed', { cwd: testDir, runId: 'pbr_gate' });

    const state = await getIvtrState('T999', { cwd: testDir });
    expect(state).not.toBeNull();
    const gateWouldBlock = state !== null && state.currentPhase !== 'released';
    expect(gateWouldBlock).toBe(false);
  });
});
