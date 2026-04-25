/**
 * Tests for IVTR orchestration loop state machine.
 *
 * Covers:
 * - Happy path: start → implement → validate → test → release
 * - Loop-back: test fails → rewind to implement → continue
 * - Max retries: third loop-back to same phase rejects with E_IVTR_MAX_RETRIES
 * - Prompt enrichment: loop-back context injected into Implement prompt
 * - Edge cases: double-start idempotency, advance past released
 *
 * @epic T810
 * @task T811
 * @task T814
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceIvtr,
  E_IVTR_MAX_RETRIES,
  getIvtrState,
  type ImplEvidenceSummary,
  loopBackIvtr,
  MAX_LOOP_BACKS_PER_PHASE,
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
  const { createTask } = await import('../../store/tasks-sqlite.js');
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

  it('generates validate prompt with prior evidence (raw sha256 fallback)', async () => {
    await startIvtr('T999', { cwd: testDir });
    const state = await advanceIvtr('T999', ['sha-abc'], { cwd: testDir });
    const prompt = resolvePhasePrompt('T999', state, 'My Task', 'Do the thing');

    expect(prompt).toContain('Phase: **VALIDATE**');
    // impl-diff sha256 surfaces in the evidence bundle fallback
    expect(prompt).toContain('sha-abc');
    // T812: Validate agent (not "Validation agent")
    expect(prompt).toContain('Validate agent');
    // T812: spec↔code alignment check instruction
    expect(prompt).toContain('spec↔code alignment');
    // T812: validate-spec-check kind
    expect(prompt).toContain('validate-spec-check');
    // T812: REJECT criteria
    expect(prompt).toContain('REJECT criteria');
  });

  it('generates test prompt with prior evidence', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['sha-i'], { cwd: testDir });
    const state = await advanceIvtr('T999', ['sha-v'], { cwd: testDir });
    const prompt = resolvePhasePrompt('T999', state, 'My Task', 'Do the thing');

    expect(prompt).toContain('Phase: **TEST**');
    expect(prompt).toContain('Testing agent');
    // T813 test-phase prompt: uses `cleo verify <id> --run` as canonical driver
    // when typed gates are present; `pnpm run test` appears inside a gate's
    // command field when provided. Accept either marker.
    expect(prompt).toMatch(/cleo verify.*--run|pnpm run test/);
  });
});

// ---------------------------------------------------------------------------
// Max retries: loop-back count enforcement (T814)
// ---------------------------------------------------------------------------

describe('IVTR loop-back max retries', () => {
  it('first loop-back (count=1) succeeds — loopBackCount increments', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['impl-sha'], { cwd: testDir }); // → validate
    await advanceIvtr('T999', ['val-sha'], { cwd: testDir }); // → test

    const state = await loopBackIvtr('T999', 'implement', 'Tests failed round 1', [], {
      cwd: testDir,
    });

    expect(state.loopBackCount.implement).toBe(1);
    expect(state.currentPhase).toBe('implement');
  });

  it('second loop-back (count=2) succeeds — loopBackCount reaches MAX', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['i1'], { cwd: testDir });
    await advanceIvtr('T999', ['v1'], { cwd: testDir });
    await loopBackIvtr('T999', 'implement', 'Round 1 failure', [], { cwd: testDir });

    // Resume: advance back through validate → test
    await advanceIvtr('T999', ['i2'], { cwd: testDir });
    await advanceIvtr('T999', ['v2'], { cwd: testDir });

    const state = await loopBackIvtr('T999', 'implement', 'Round 2 failure', [], {
      cwd: testDir,
    });

    expect(state.loopBackCount.implement).toBe(2);
    expect(state.currentPhase).toBe('implement');
  });

  it('third loop-back (count=3) rejects with E_IVTR_MAX_RETRIES', async () => {
    await startIvtr('T999', { cwd: testDir });
    // Pass 1: implement → validate → test → loop-back 1
    await advanceIvtr('T999', ['i1'], { cwd: testDir });
    await advanceIvtr('T999', ['v1'], { cwd: testDir });
    await loopBackIvtr('T999', 'implement', 'Failure 1', [], { cwd: testDir });

    // Pass 2: implement → validate → test → loop-back 2
    await advanceIvtr('T999', ['i2'], { cwd: testDir });
    await advanceIvtr('T999', ['v2'], { cwd: testDir });
    await loopBackIvtr('T999', 'implement', 'Failure 2', [], { cwd: testDir });

    // Pass 3: implement → validate → test → loop-back 3 (should FAIL)
    await advanceIvtr('T999', ['i3'], { cwd: testDir });
    await advanceIvtr('T999', ['v3'], { cwd: testDir });

    await expect(
      loopBackIvtr('T999', 'implement', 'Failure 3', [], { cwd: testDir }),
    ).rejects.toThrow(E_IVTR_MAX_RETRIES);
  });

  it('state is NOT mutated when max retries throws', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['i1'], { cwd: testDir });
    await advanceIvtr('T999', ['v1'], { cwd: testDir });
    await loopBackIvtr('T999', 'implement', 'Failure 1', [], { cwd: testDir });

    await advanceIvtr('T999', ['i2'], { cwd: testDir });
    await advanceIvtr('T999', ['v2'], { cwd: testDir });
    await loopBackIvtr('T999', 'implement', 'Failure 2', [], { cwd: testDir });

    await advanceIvtr('T999', ['i3'], { cwd: testDir });
    await advanceIvtr('T999', ['v3'], { cwd: testDir });

    // Attempt the rejected 3rd loop-back
    await expect(
      loopBackIvtr('T999', 'implement', 'Failure 3', [], { cwd: testDir }),
    ).rejects.toThrow(E_IVTR_MAX_RETRIES);

    // Phase must still be 'test' (the in-progress phase before the rejected loop-back)
    const state = await getIvtrState('T999', { cwd: testDir });
    expect(state?.currentPhase).toBe('test');
    expect(state?.loopBackCount.implement).toBe(MAX_LOOP_BACKS_PER_PHASE);
  });

  it('loopBackCount initialises to 0 on startIvtr', async () => {
    const state = await startIvtr('T999', { cwd: testDir });
    expect(state.loopBackCount).toEqual({ implement: 0, validate: 0, test: 0, released: 0 });
  });

  it('backward-compat: legacy state without loopBackCount still works', async () => {
    // Start the IVTR loop and manually strip loopBackCount from the persisted JSON
    // to simulate a pre-T814 state row already in the DB.
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['i'], { cwd: testDir });
    await advanceIvtr('T999', ['v'], { cwd: testDir });

    // Inject a legacy state (no loopBackCount) directly.
    const { getDb } = await import('../../store/sqlite.js');
    const { eq } = await import('drizzle-orm');
    const { tasks } = await import('../../store/tasks-schema.js');
    const db = await getDb(testDir);
    const rawRows = await db
      .select({ ivtrState: tasks.ivtrState })
      .from(tasks)
      .where(eq(tasks.id, 'T999'))
      .all();
    const parsed = JSON.parse(rawRows[0]!.ivtrState!) as Record<string, unknown>;
    delete parsed['loopBackCount'];
    await db
      .update(tasks)
      .set({ ivtrState: JSON.stringify(parsed) })
      .where(eq(tasks.id, 'T999'))
      .run();

    // Now loop-back should succeed — loopBackCount initialised to 0 on-the-fly.
    const state = await loopBackIvtr('T999', 'implement', 'Legacy compat failure', [], {
      cwd: testDir,
    });
    expect(state.loopBackCount.implement).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Prompt enrichment: loop-back context section (T814)
// ---------------------------------------------------------------------------

describe('resolvePhasePrompt loop-back context injection', () => {
  it('no loop-back section when implement is first-attempt (no failures)', async () => {
    const state = await startIvtr('T999', { cwd: testDir });
    const prompt = resolvePhasePrompt('T999', state, 'My Task', 'Spec here');

    expect(prompt).not.toContain('LOOP-BACK CONTEXT');
    expect(prompt).not.toContain('CRITICAL INSTRUCTION');
    expect(prompt).toContain('Phase: **IMPLEMENT**');
  });

  it('loop-back section included after validate failure triggers implement re-spawn', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['impl-sha'], { cwd: testDir }); // → validate

    // Validate fails → loop-back to implement
    const state = await loopBackIvtr(
      'T999',
      'implement',
      'Missing acceptance criterion X',
      ['validate-failure-sha'],
      { cwd: testDir },
    );

    expect(state.currentPhase).toBe('implement');
    const prompt = resolvePhasePrompt('T999', state, 'My Task', 'Spec here');

    expect(prompt).toContain('LOOP-BACK CONTEXT');
    expect(prompt).toContain('VALIDATE');
    expect(prompt).toContain('Missing acceptance criterion X');
    expect(prompt).toContain('validate-failure-sha');
    expect(prompt).toContain('CRITICAL INSTRUCTION');
    expect(prompt).toContain('Fix the ROOT CAUSE');
    expect(prompt).toContain('Loop-back History');
  });

  it('loop-back section included after test failure triggers implement re-spawn', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['i1'], { cwd: testDir });
    await advanceIvtr('T999', ['v1'], { cwd: testDir });

    // Test fails → loop-back to implement
    const state = await loopBackIvtr(
      'T999',
      'implement',
      'Test coverage is 12% below threshold',
      ['test-output-sha'],
      { cwd: testDir },
    );

    const prompt = resolvePhasePrompt('T999', state, 'My Task', 'Spec here');

    expect(prompt).toContain('LOOP-BACK CONTEXT');
    expect(prompt).toContain('TEST');
    expect(prompt).toContain('Test coverage is 12% below threshold');
    expect(prompt).toContain('test-output-sha');
    expect(prompt).toContain('Loop-back History (all prior failures for this task)');
    // History must list the failed test entry
    expect(prompt).toContain('1. Phase: TEST');
  });

  it('multi-failure: loop-back history lists ALL prior failures', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['i1'], { cwd: testDir });
    await advanceIvtr('T999', ['v1'], { cwd: testDir });

    // First loop-back
    await loopBackIvtr('T999', 'implement', 'First test failure', ['sha-fail-1'], {
      cwd: testDir,
    });

    // Advance again and fail a second time
    await advanceIvtr('T999', ['i2'], { cwd: testDir });
    await advanceIvtr('T999', ['v2'], { cwd: testDir });
    const state = await loopBackIvtr('T999', 'implement', 'Second test failure', ['sha-fail-2'], {
      cwd: testDir,
    });

    const prompt = resolvePhasePrompt('T999', state, 'My Task', 'Spec here');

    // Both failures must appear in loop-back history
    expect(prompt).toContain('1. Phase: TEST');
    expect(prompt).toContain('2. Phase: TEST');
    expect(prompt).toContain('First test failure');
    expect(prompt).toContain('Second test failure');
  });

  it('no loop-back section on validate prompt even when prior implement passed', async () => {
    await startIvtr('T999', { cwd: testDir });
    const state = await advanceIvtr('T999', ['impl-sha'], { cwd: testDir });

    // Must be 'validate' now, no failed entries
    expect(state.currentPhase).toBe('validate');
    const prompt = resolvePhasePrompt('T999', state, 'My Task', 'Spec here');

    expect(prompt).not.toContain('LOOP-BACK CONTEXT');
    expect(prompt).toContain('Phase: **VALIDATE**');
  });
});

// ---------------------------------------------------------------------------
// T812: Validate-phase prompt enrichment (evidence bundle + REJECT criteria)
// ---------------------------------------------------------------------------

describe('resolvePhasePrompt validate-phase enrichment (T812)', () => {
  it('validate prompt contains Validate agent header and validate-spec-check guidance', async () => {
    await startIvtr('T999', { cwd: testDir });
    // Advance implement → validate with impl-diff evidence ref
    const state = await advanceIvtr('T999', ['impl-diff-sha256abc'], { cwd: testDir });

    expect(state.currentPhase).toBe('validate');
    const prompt = resolvePhasePrompt('T999', state, 'My Task', 'Spec including REQ-001');

    // Section 1: task spec
    expect(prompt).toContain('## Task Specification');
    expect(prompt).toContain('Spec including REQ-001');

    // Section 2: impl evidence bundle fallback (raw sha256 refs)
    expect(prompt).toContain('Implement-Phase Evidence Bundle');
    expect(prompt).toContain('impl-diff-sha256abc');

    // Section 3: Validate agent instructions
    expect(prompt).toContain('Validate agent');
    expect(prompt).toContain('validate-spec-check');
    expect(prompt).toContain('reqIdsChecked');
    expect(prompt).toContain(`cleo orchestrate ivtr T999 --next --evidence`);
    expect(prompt).toContain(`cleo orchestrate ivtr T999 --loop-back --phase implement`);

    // Section 4: REJECT criteria
    expect(prompt).toContain('REJECT criteria');
    expect(prompt).toContain('Spec-code mismatch');
    expect(prompt).toContain('Missing test');
    expect(prompt).toContain('Undocumented deviation');
    expect(prompt).toContain('Quality gate not run');
  });

  it('validate prompt with enriched evidence bundle renders table', async () => {
    await startIvtr('T999', { cwd: testDir });
    const state = await advanceIvtr('T999', ['abc123deadbeef00'.repeat(4)], { cwd: testDir });

    const bundle: ImplEvidenceSummary[] = [
      {
        attachmentSha256: 'a'.repeat(64),
        kind: 'impl-diff',
        filesChanged: ['src/foo.ts', 'src/bar.ts'],
        linesAdded: 42,
        linesRemoved: 5,
        durationMs: 1200,
      },
    ];

    const prompt = resolvePhasePrompt('T999', state, 'My Task', 'Spec', undefined, bundle);

    // Table header
    expect(prompt).toContain(
      '| sha256 (prefix) | kind | filesChanged | linesAdded/Removed | duration |',
    );
    // Table row with the enriched data
    expect(prompt).toContain('impl-diff');
    expect(prompt).toContain('src/foo.ts, src/bar.ts');
    expect(prompt).toContain('+42');
    expect(prompt).toContain('-5');
    expect(prompt).toContain('1200ms');
    // Retrieve hint
    expect(prompt).toContain('cleo docs show <sha256>');
  });

  it('validate prompt shows REJECT criteria even without evidence bundle', async () => {
    await startIvtr('T999', { cwd: testDir });
    const state = await advanceIvtr('T999', [], { cwd: testDir });

    const prompt = resolvePhasePrompt('T999', state, 'My Task', 'Spec');

    expect(prompt).toContain('REJECT criteria');
    expect(prompt).toContain('Spec-code mismatch');
    expect(prompt).toContain('Missing test');
    expect(prompt).toContain('Quality gate not run');
    expect(prompt).toContain('Undocumented deviation');
  });

  it('validate prompt includes HITL escalation note after 2 loop-backs to validate', async () => {
    await startIvtr('T999', { cwd: testDir });
    await advanceIvtr('T999', ['i1'], { cwd: testDir }); // → validate

    // Loop-back from validate to implement (count=1)
    await loopBackIvtr('T999', 'implement', 'val fail 1', [], { cwd: testDir });
    await advanceIvtr('T999', ['i2'], { cwd: testDir }); // → validate again (count still 0 for validate)

    // Loop-back again from validate (count=1 → now 1 validate loop-back)
    await loopBackIvtr('T999', 'validate', 'implement-fail-re-validate-1', [], { cwd: testDir });
    await advanceIvtr('T999', ['v2'], { cwd: testDir }); // → test... wait, validate loop-back re-opens validate

    // Actually: loop-back to validate opens a new validate entry, then we advance that to test
    // Re-check: the escalation note appears when loopBackCount.validate >= 2
    // Let's do 2 loop-backs targeting 'validate'
    await loopBackIvtr('T999', 'validate', 'implement-fail-re-validate-2', [], { cwd: testDir });

    const state2 = await advanceIvtr('T999', ['v3'], { cwd: testDir });
    // state2 is now test phase (not validate)... the prompt won't show escalation
    // Actually we need the state at the validate phase to see the warning.
    // Let's just verify the loopBackCount drives the escalation note.
    // We'll call resolvePhasePrompt with a synthetic state.
    const syntheticState = await startIvtr('T998' as never, { cwd: testDir }).catch(() => null);
    void syntheticState; // unused — use the manual approach below

    // Build a minimal IvtrState manually for the escalation test
    const fakeState = {
      taskId: 'T999',
      currentPhase: 'validate' as const,
      phaseHistory: [
        {
          phase: 'implement' as const,
          agentIdentity: null,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          passed: true,
          evidenceRefs: ['impl-sha'],
        },
        {
          phase: 'validate' as const,
          agentIdentity: null,
          startedAt: new Date().toISOString(),
          completedAt: null,
          passed: null,
          evidenceRefs: [],
        },
      ],
      startedAt: new Date().toISOString(),
      loopBackCount: { implement: 0, validate: 2, test: 0, released: 0 },
    };

    const promptWithEscalation = resolvePhasePrompt('T999', fakeState, 'My Task', 'Spec');
    expect(promptWithEscalation).toContain('HITL escalation');
    expect(promptWithEscalation).toContain('WARNING');
  });
});
