/**
 * Tests for IVTR orchestration loop state machine.
 *
 * Covers:
 * - Happy path: start → implement → validate → test → release
 * - Loop-back: test fails → rewind to implement → continue
 * - Edge cases: double-start idempotency, advance past released
 *
 * @epic T810
 * @task T811
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceIvtr,
  getIvtrState,
  loopBackIvtr,
  releaseIvtr,
  resolvePhasePrompt,
  startIvtr,
} from '../ivtr-loop.js';

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
  const { createTask } = await import('../../store/task-store.js');
  await createTask(
    {
      id: 'T999',
      title: 'Test Task',
      description: 'A task for IVTR testing',
      status: 'in_progress',
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
// Happy path: start → implement → validate → test → release
// ---------------------------------------------------------------------------

describe('IVTR happy path', () => {
  it('startIvtr creates state with implement phase', async () => {
    const state = await startIvtr('T999', { cwd: testDir });

    expect(state.taskId).toBe('T999');
    expect(state.currentPhase).toBe('implement');
    expect(state.phaseHistory).toHaveLength(1);
    expect(state.phaseHistory[0]?.phase).toBe('implement');
    expect(state.phaseHistory[0]?.passed).toBeNull();
    expect(state.phaseHistory[0]?.completedAt).toBeNull();
    expect(state.startedAt).toBeDefined();
  });

  it('startIvtr is idempotent — second call returns existing state', async () => {
    const first = await startIvtr('T999', { cwd: testDir });
    const second = await startIvtr('T999', { cwd: testDir });

    expect(second.startedAt).toBe(first.startedAt);
    expect(second.phaseHistory).toHaveLength(1);
  });

  it('getIvtrState returns null before start', async () => {
    const state = await getIvtrState('T999', { cwd: testDir });
    expect(state).toBeNull();
  });

  it('advanceIvtr transitions implement → validate', async () => {
    await startIvtr('T999', { cwd: testDir });
    const evidence = ['abc123'];
    const state = await advanceIvtr('T999', evidence, { cwd: testDir });

    expect(state.currentPhase).toBe('validate');
    expect(state.phaseHistory).toHaveLength(2);

    const implEntry = state.phaseHistory[0]!;
    expect(implEntry.phase).toBe('implement');
    expect(implEntry.passed).toBe(true);
    expect(implEntry.evidenceRefs).toContain('abc123');
    expect(implEntry.completedAt).toBeDefined();

    const valEntry = state.phaseHistory[1]!;
    expect(valEntry.phase).toBe('validate');
    expect(valEntry.passed).toBeNull();
    expect(valEntry.completedAt).toBeNull();
  });

  it('advanceIvtr transitions validate → test', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['impl-sha'], { cwd: testDir });
    const state = await advanceIvtr('T999', ['val-sha'], { cwd: testDir });

    expect(state.currentPhase).toBe('test');
    expect(state.phaseHistory).toHaveLength(3);
    expect(state.phaseHistory[2]?.phase).toBe('test');
  });

  it('full happy path: implement → validate → test → release', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['impl-sha'], { cwd: testDir });
    await advanceIvtr('T999', ['val-sha'], { cwd: testDir });
    await advanceIvtr('T999', ['test-sha'], { cwd: testDir });

    const result = await releaseIvtr('T999', { cwd: testDir });
    expect(result.released).toBe(true);
    expect(result.failures).toBeUndefined();

    const state = await getIvtrState('T999', { cwd: testDir });
    expect(state?.currentPhase).toBe('released');
  });

  it('releaseIvtr is idempotent when already released', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['i'], { cwd: testDir });
    await advanceIvtr('T999', ['v'], { cwd: testDir });
    await advanceIvtr('T999', ['t'], { cwd: testDir });
    await releaseIvtr('T999', { cwd: testDir });

    const second = await releaseIvtr('T999', { cwd: testDir });
    expect(second.released).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Loop-back: phase failure → rewind
// ---------------------------------------------------------------------------

describe('IVTR loop-back', () => {
  it('loopBackIvtr from test to implement records failure', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['impl-sha'], { cwd: testDir });
    await advanceIvtr('T999', ['val-sha'], { cwd: testDir });

    const state = await loopBackIvtr('T999', 'implement', 'Tests failed: missing coverage', [], {
      cwd: testDir,
    });

    expect(state.currentPhase).toBe('implement');
    // History: implement(pass) + validate(pass) + test(fail) + implement(new)
    expect(state.phaseHistory).toHaveLength(4);

    const failedTest = state.phaseHistory[2]!;
    expect(failedTest.phase).toBe('test');
    expect(failedTest.passed).toBe(false);
    expect(failedTest.reason).toBe('Tests failed: missing coverage');

    const newImpl = state.phaseHistory[3]!;
    expect(newImpl.phase).toBe('implement');
    expect(newImpl.passed).toBeNull();
    expect(newImpl.reason).toMatch(/Loop-back from test/);
  });

  it('after loop-back, advance resumes from implement again', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['i1'], { cwd: testDir });
    await advanceIvtr('T999', ['v1'], { cwd: testDir });
    await loopBackIvtr('T999', 'implement', 'fix needed', [], { cwd: testDir });

    // Advance implement → validate → test
    await advanceIvtr('T999', ['i2'], { cwd: testDir });
    await advanceIvtr('T999', ['v2'], { cwd: testDir });
    await advanceIvtr('T999', ['t2'], { cwd: testDir });

    const result = await releaseIvtr('T999', { cwd: testDir });
    expect(result.released).toBe(true);
  });

  it('loopBackIvtr rejects target of released', async () => {
    await startIvtr('T999', { cwd: testDir });

    await expect(
      loopBackIvtr('T999', 'released' as never, 'bad', [], { cwd: testDir }),
    ).rejects.toThrow("Cannot loop back to 'released'");
  });

  it('loopBackIvtr rejects when no IVTR state exists', async () => {
    await expect(loopBackIvtr('T999', 'implement', 'bad', [], { cwd: testDir })).rejects.toThrow(
      'No IVTR state',
    );
  });
});

// ---------------------------------------------------------------------------
// Release gate failures
// ---------------------------------------------------------------------------

describe('releaseIvtr gate failures', () => {
  it('fails when implement phase has no passing entry', async () => {
    await startIvtr('T999', { cwd: testDir });
    const result = await releaseIvtr('T999', { cwd: testDir });

    expect(result.released).toBe(false);
    expect(result.failures).toContain("Phase 'implement' has no passing entry");
    expect(result.failures).toContain("Phase 'validate' has no passing entry");
    expect(result.failures).toContain("Phase 'test' has no passing entry");
  });

  it('fails when only implement has passed', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['i'], { cwd: testDir });
    const result = await releaseIvtr('T999', { cwd: testDir });

    expect(result.released).toBe(false);
    expect(result.failures).not.toContain("Phase 'implement' has no passing entry");
    expect(result.failures).toContain("Phase 'validate' has no passing entry");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('IVTR edge cases', () => {
  it('advanceIvtr throws when no state exists', async () => {
    await expect(advanceIvtr('T999', [], { cwd: testDir })).rejects.toThrow('No IVTR state');
  });

  it('advanceIvtr throws when already released', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['i'], { cwd: testDir });
    await advanceIvtr('T999', ['v'], { cwd: testDir });
    await advanceIvtr('T999', ['t'], { cwd: testDir });
    await releaseIvtr('T999', { cwd: testDir });

    await expect(advanceIvtr('T999', [], { cwd: testDir })).rejects.toThrow('already released');
  });
});

// ---------------------------------------------------------------------------
// resolvePhasePrompt
// ---------------------------------------------------------------------------

describe('resolvePhasePrompt', () => {
  it('generates implement prompt with correct phase header', async () => {
    const state = await startIvtr('T999', { cwd: testDir });
    const prompt = resolvePhasePrompt('T999', state, 'My Task', 'Do the thing');

    expect(prompt).toContain('Phase: **IMPLEMENT**');
    expect(prompt).toContain('T999: My Task');
    expect(prompt).toContain('Do the thing');
    expect(prompt).toContain('Implementation agent');
    expect(prompt).toContain('Prior Phase Evidence\n(none — first phase)');
  });

  it('generates validate prompt with prior evidence', async () => {
    await startIvtr('T999', { cwd: testDir });
    const state = await advanceIvtr('T999', ['sha-abc'], { cwd: testDir });
    const prompt = resolvePhasePrompt('T999', state, 'My Task', 'Do the thing');

    expect(prompt).toContain('Phase: **VALIDATE**');
    expect(prompt).toContain('sha-abc');
    expect(prompt).toContain('Validation agent');
    expect(prompt).toContain('spec↔code alignment');
  });

  it('generates test prompt with prior evidence', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['sha-i'], { cwd: testDir });
    const state = await advanceIvtr('T999', ['sha-v'], { cwd: testDir });
    const prompt = resolvePhasePrompt('T999', state, 'My Task', 'Do the thing');

    expect(prompt).toContain('Phase: **TEST**');
    expect(prompt).toContain('Testing agent');
    expect(prompt).toContain('pnpm run test');
  });
});
