/**
 * Parallel arm execution for CANT workflow parallel blocks.
 *
 * Supports three join strategies:
 * - `all` (default): Wait for ALL arms. Fail if any arm fails.
 * - `race`: Return when the FIRST arm completes. Cancel remaining.
 * - `settle`: Wait for ALL arms. Collect successes and failures.
 *
 * @see docs/specs/CANT-DSL-SPEC.md Section 7.5 (Parallel Execution)
 */

import type { JoinStrategy, SettleResult, StepResult } from './types.js';

/** A single parallel arm to execute. */
export interface ParallelArm {
  /** The arm name (used for binding results to scope). */
  name: string;
  /** The async function that executes the arm's body. */
  execute: () => Promise<unknown>;
}

/** Result of a parallel block execution. */
export interface ParallelResult {
  /** Whether the parallel block succeeded according to its join strategy. */
  success: boolean;
  /** Per-arm results mapped by arm name. */
  results: Record<string, unknown>;
  /** Step results for audit/logging. */
  steps: StepResult[];
  /** Settle-mode detailed breakdown (only for `settle` strategy). */
  settleResult?: SettleResult;
}

/**
 * Executes parallel arms according to the specified join strategy.
 *
 * @param arms - The arms to execute concurrently.
 * @param strategy - The join strategy (default: 'all').
 * @returns Parallel execution result.
 */
export async function executeParallel(
  arms: ParallelArm[],
  strategy: JoinStrategy = 'all',
): Promise<ParallelResult> {
  switch (strategy) {
    case 'race':
      return executeRace(arms);
    case 'settle':
      return executeSettle(arms);
    default: // 'all' or any other value
      return executeAll(arms);
  }
}

/**
 * Execute all arms concurrently. Fail if any arm fails.
 */
async function executeAll(arms: ParallelArm[]): Promise<ParallelResult> {
  const startTimes = new Map<string, number>();
  const promises = arms.map(async (arm) => {
    const start = Date.now();
    startTimes.set(arm.name, start);
    const result = await arm.execute();
    return { name: arm.name, result, duration: Date.now() - start };
  });

  try {
    const outcomes = await Promise.all(promises);
    const results: Record<string, unknown> = {};
    const steps: StepResult[] = [];

    for (const outcome of outcomes) {
      results[outcome.name] = outcome.result;
      steps.push({
        name: outcome.name,
        type: 'parallel',
        success: true,
        output: outcome.result,
        duration: outcome.duration,
      });
    }

    return { success: true, results, steps };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      results: {},
      steps: [
        {
          name: 'parallel:all',
          type: 'parallel',
          success: false,
          error,
          duration: 0,
        },
      ],
    };
  }
}

/**
 * Execute all arms concurrently. Return on first completion.
 */
async function executeRace(arms: ParallelArm[]): Promise<ParallelResult> {
  const promises = arms.map(async (arm) => {
    const start = Date.now();
    const result = await arm.execute();
    return { name: arm.name, result, duration: Date.now() - start };
  });

  try {
    const winner = await Promise.race(promises);
    return {
      success: true,
      results: { [winner.name]: winner.result },
      steps: [
        {
          name: winner.name,
          type: 'parallel',
          success: true,
          output: winner.result,
          duration: winner.duration,
        },
      ],
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      results: {},
      steps: [
        {
          name: 'parallel:race',
          type: 'parallel',
          success: false,
          error,
          duration: 0,
        },
      ],
    };
  }
}

/**
 * Execute all arms concurrently. Collect all successes and failures.
 */
async function executeSettle(arms: ParallelArm[]): Promise<ParallelResult> {
  const promises = arms.map(async (arm) => {
    const start = Date.now();
    try {
      const result = await arm.execute();
      return {
        name: arm.name,
        status: 'fulfilled' as const,
        result,
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        name: arm.name,
        status: 'rejected' as const,
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - start,
      };
    }
  });

  const outcomes = await Promise.all(promises);

  const successes: SettleResult['successes'] = [];
  const failures: SettleResult['failures'] = [];
  const results: Record<string, unknown> = {};
  const steps: StepResult[] = [];

  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') {
      successes.push({ name: outcome.name, result: outcome.result });
      results[outcome.name] = outcome.result;
      steps.push({
        name: outcome.name,
        type: 'parallel',
        success: true,
        output: outcome.result,
        duration: outcome.duration,
      });
    } else {
      failures.push({ name: outcome.name, error: outcome.error });
      steps.push({
        name: outcome.name,
        type: 'parallel',
        success: false,
        error: outcome.error,
        duration: outcome.duration,
      });
    }
  }

  return {
    success: failures.length === 0,
    results,
    steps,
    settleResult: { successes, failures },
  };
}
