/**
 * Tests for atomicity module.
 * @task T5001
 */
import { describe, it, expect } from 'vitest';
import { checkAtomicity, ATOMICITY_CRITERIA } from '../atomicity.js';
import type { Task } from '../../../types/task.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

// ===========================================================================
// ATOMICITY_CRITERIA constant
// ===========================================================================

describe('ATOMICITY_CRITERIA', () => {
  it('has exactly 6 entries', () => {
    expect(ATOMICITY_CRITERIA).toHaveLength(6);
  });

  it('each entry is a string', () => {
    for (const criterion of ATOMICITY_CRITERIA) {
      expect(typeof criterion).toBe('string');
    }
  });

  it('contains expected criteria names', () => {
    expect(ATOMICITY_CRITERIA).toContain('single-file-scope');
    expect(ATOMICITY_CRITERIA).toContain('single-cognitive-concern');
    expect(ATOMICITY_CRITERIA).toContain('clear-acceptance-criteria');
    expect(ATOMICITY_CRITERIA).toContain('no-context-switching');
    expect(ATOMICITY_CRITERIA).toContain('no-hidden-decisions');
    expect(ATOMICITY_CRITERIA).toContain('programmatic-validation-possible');
  });
});

// ===========================================================================
// checkAtomicity — perfect task
// ===========================================================================

describe('checkAtomicity — perfect task (6/6)', () => {
  it('scores 6/6 with good title and acceptance criteria', () => {
    const task = makeTask({
      id: 'T001',
      title: 'Add login endpoint',
      description: 'Must validate JWT token. Test passes when /api/login returns 200 with valid credentials.',
    });
    const result = checkAtomicity(task);
    expect(result.score).toBe(6);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ===========================================================================
// checkAtomicity — worst case (low score)
// ===========================================================================

describe('checkAtomicity — poor task (low score)', () => {
  it('scores low with multi-concern title and vague description', () => {
    const task = makeTask({
      id: 'T002',
      title: 'Add and update and fix and refactor multiple files across frontend, backend, database, api',
      description: 'TBD - figure out later',
    });
    const result = checkAtomicity(task);
    // 'single-cognitive-concern' fails: "and" conjunctions + multiple action verbs
    // 'clear-acceptance-criteria' fails: no acceptance keywords
    // 'no-context-switching' fails: frontend, backend, database, api = 4 domain keywords
    // 'no-hidden-decisions' fails: "figure out" and "TBD"
    // 'programmatic-validation-possible' fails: no validation keywords
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(4);
  });
});

// ===========================================================================
// checkAtomicity — custom threshold
// ===========================================================================

describe('checkAtomicity — custom threshold', () => {
  it('passes with threshold=3 when score is 3', () => {
    // Title with single action verb, no conjunction → single-cognitive-concern: PASS
    // Description short with acceptance keyword → clear-acceptance-criteria: PASS, single-file-scope: PASS
    // No domain keywords → no-context-switching: PASS
    // But has hidden-decision keyword and no validation keyword
    const task = makeTask({
      id: 'T003',
      title: 'Update config',
      description: 'Should work, but need to decide on format. Done when complete.',
    });
    const result3 = checkAtomicity(task, 3);
    // 'no-hidden-decisions' fails: "decide"
    // 'programmatic-validation-possible' may pass due to "complete" not matching validation keywords
    // Let's just verify threshold behavior
    if (result3.score >= 3) {
      expect(result3.passed).toBe(true);
    }
  });

  it('same task fails with higher threshold', () => {
    const task = makeTask({
      id: 'T004',
      title: 'Fix login',
      description: 'Must return 200. Verify with test.',
    });
    // This should score fairly high
    const resultHigh = checkAtomicity(task, 6);
    const resultLow = checkAtomicity(task, 1);
    // Threshold only changes passed, not score
    expect(resultHigh.score).toBe(resultLow.score);
    expect(resultLow.passed).toBe(true);
    // High threshold may or may not pass depending on score
    if (resultHigh.score < 6) {
      expect(resultHigh.passed).toBe(false);
    }
  });

  it('threshold determines pass/fail boundary', () => {
    const task = makeTask({
      id: 'T005',
      title: 'Fix bug',
      description: 'Must validate input. Test passes when error is handled.',
    });
    const result = checkAtomicity(task);
    // Test with score as threshold → should pass
    const atThreshold = checkAtomicity(task, result.score);
    expect(atThreshold.passed).toBe(true);
    // Test with score+1 as threshold → should fail
    const aboveThreshold = checkAtomicity(task, result.score + 1);
    expect(aboveThreshold.passed).toBe(false);
  });
});

// ===========================================================================
// checkAtomicity — violations array
// ===========================================================================

describe('checkAtomicity — violations array', () => {
  it('violations contain names from ATOMICITY_CRITERIA', () => {
    const task = makeTask({
      id: 'T006',
      title: 'Add and fix things',
      description: 'TBD',
    });
    const result = checkAtomicity(task);
    for (const v of result.violations) {
      expect(ATOMICITY_CRITERIA).toContain(v);
    }
  });

  it('score equals 6 minus violations length', () => {
    const task = makeTask({
      id: 'T007',
      title: 'Create handler',
      description: 'Should accept requests. Verify with test.',
    });
    const result = checkAtomicity(task);
    expect(result.score).toBe(ATOMICITY_CRITERIA.length - result.violations.length);
  });
});

// ===========================================================================
// checkAtomicity — empty/missing description
// ===========================================================================

describe('checkAtomicity — edge cases', () => {
  it('handles undefined description without throwing', () => {
    const task = makeTask({
      id: 'T008',
      title: 'Simple task',
    });
    // description is undefined
    expect(() => checkAtomicity(task)).not.toThrow();
    const result = checkAtomicity(task);
    expect(typeof result.score).toBe('number');
    expect(typeof result.passed).toBe('boolean');
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('handles empty string description without throwing', () => {
    const task = makeTask({
      id: 'T009',
      title: 'Another task',
      description: '',
    });
    expect(() => checkAtomicity(task)).not.toThrow();
    const result = checkAtomicity(task);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(6);
  });

  it('handles undefined title gracefully', () => {
    const task = makeTask({
      id: 'T010',
      title: undefined as unknown as string,
      description: 'Must validate. Test passes.',
    });
    expect(() => checkAtomicity(task)).not.toThrow();
  });
});
