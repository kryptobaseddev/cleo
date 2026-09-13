/**
 * T12117 (#1244) — a write must never be lost to enrichment.
 *
 * `checkDuplicates` runs BEFORE the row is inserted, and its vector tier called
 * a local embedding model once per ACTIVE TASK. In a project with ~1,000 active
 * tasks that is thousands of inferences to create one row. Field report: three
 * `cleo add` attempts at 280 s each, none of which created a task — no error,
 * no id, nothing. A silent write failure is the worst failure a tracker has,
 * because the agent that filed the task believes the work is recorded.
 */

import type { DataAccessor } from '@cleocode/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkDuplicatesBounded,
  DUPLICATE_CHECK_BUDGET_ENV,
  resolveDuplicateCheckBudgetMs,
} from '../duplicate-detector.js';

/** Accessor whose task load never finishes — a stalled enrichment dependency. */
function stalledAccessor(): DataAccessor {
  return {
    queryTasks: () => new Promise(() => {}),
  } as unknown as DataAccessor;
}

afterEach(() => {
  delete process.env[DUPLICATE_CHECK_BUDGET_ENV];
});

describe('resolveDuplicateCheckBudgetMs', () => {
  it('defaults when unset', () => {
    expect(resolveDuplicateCheckBudgetMs({})).toBe(20_000);
  });

  it('honours an operator override', () => {
    expect(resolveDuplicateCheckBudgetMs({ [DUPLICATE_CHECK_BUDGET_ENV]: '500' })).toBe(500);
  });

  it('ignores a malformed override rather than trusting it', () => {
    expect(resolveDuplicateCheckBudgetMs({ [DUPLICATE_CHECK_BUDGET_ENV]: 'soon' })).toBe(20_000);
  });
});

describe('checkDuplicatesBounded', () => {
  it('fails OPEN when detection stalls, so the row can still be created', async () => {
    process.env[DUPLICATE_CHECK_BUDGET_ENV] = '100';

    const verdict = await checkDuplicatesBounded(
      'a new task',
      'some description',
      stalledAccessor(),
      [],
      process.cwd(),
    );

    // The critical assertion: a stalled check must NOT reject the write. On the
    // old unbounded path this call never returns and `cleo add` exits having
    // created nothing.
    expect(verdict.timedOut).toBe(true);
    expect(verdict.shouldReject).toBe(false);
    expect(verdict.candidates).toEqual([]);
  });

  it('returns within its budget rather than hanging', async () => {
    process.env[DUPLICATE_CHECK_BUDGET_ENV] = '100';

    const startedAt = Date.now();
    await checkDuplicatesBounded('t', 'd', stalledAccessor(), [], process.cwd());

    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
