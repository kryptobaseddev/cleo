/**
 * A/B testing framework for CLEO vs baseline comparison.
 *
 * Enables scientific comparison of CLEO (with subagents, manifests, protocols)
 * vs baseline (direct implementation) across token consumption, validation
 * effectiveness, and completion rates.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getCleoDir } from '../paths.js';
import { isoTimestamp, readJsonlFile } from './common.js';
import { isOtelEnabled, getSessionTokens } from './otel-integration.js';

/** A/B test variant. */
export type ABVariant = 'cleo' | 'baseline';

/** A/B test event types. */
export type ABEventType = 'start' | 'end' | 'milestone' | 'note';

/** A/B test session state. */
interface ABSessionState {
  testName: string;
  variant: ABVariant;
  startTime: string;
  startTokens: number;
}

let currentTest: ABSessionState | null = null;

function getABMetricsDir(cwd?: string): string {
  return process.env.AB_TEST_METRICS_DIR ?? join(getCleoDir(cwd), 'metrics', 'ab-tests');
}

function getABMetricsFile(cwd?: string): string {
  return join(getABMetricsDir(cwd), 'AB_TESTS.jsonl');
}

/** Log an A/B test event. */
export async function logABEvent(
  eventType: ABEventType,
  testName: string,
  variant: ABVariant,
  context?: Record<string, unknown> | string,
  cwd?: string,
): Promise<void> {
  const dir = getABMetricsDir(cwd);
  await mkdir(dir, { recursive: true });

  const file = getABMetricsFile(cwd);
  const parsedContext = typeof context === 'string'
    ? { note: context }
    : (context ?? {});

  const entry = {
    timestamp: isoTimestamp(),
    event_type: eventType,
    test_name: testName,
    variant,
    context: parsedContext,
  };

  try {
    appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    // Non-fatal
  }
}

/** Start an A/B test session. */
export async function startABTest(
  testName: string,
  variant: ABVariant,
  description?: string,
  cwd?: string,
): Promise<void> {
  if (!testName) throw new Error('Test name required');
  if (variant !== 'cleo' && variant !== 'baseline') {
    throw new Error("Invalid variant. Must be 'cleo' or 'baseline'");
  }

  let startTokens = 0;
  if (isOtelEnabled()) {
    const tokenData = getSessionTokens(`${testName}-${variant}`, cwd);
    startTokens = tokenData.tokens.total;
  }

  currentTest = {
    testName,
    variant,
    startTime: isoTimestamp(),
    startTokens,
  };

  await logABEvent('start', testName, variant, {
    description: description ?? '',
    otel_enabled: isOtelEnabled(),
  }, cwd);
}

/** A/B test summary result. */
export interface ABTestSummary {
  test_name: string;
  variant: ABVariant;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  tokens_consumed: number;
  token_source: string;
  tasks_completed: number;
  validations: {
    passed: number;
    failed: number;
    total: number;
    pass_rate_percent: number;
  };
  notes: string;
}

/** End an A/B test session with summary. */
export async function endABTest(
  options: {
    tasksCompleted?: number;
    validationPasses?: number;
    validationFailures?: number;
    notes?: string;
  } = {},
  cwd?: string,
): Promise<ABTestSummary | null> {
  if (!currentTest) return null;

  const endTime = isoTimestamp();
  const startEpoch = new Date(currentTest.startTime).getTime();
  const endEpoch = new Date(endTime).getTime();
  const durationSeconds = Math.floor((endEpoch - startEpoch) / 1000);

  let totalTokens = 0;
  let tokenSource = 'none';

  if (isOtelEnabled()) {
    const endTokenData = getSessionTokens(`${currentTest.testName}-${currentTest.variant}`, cwd);
    totalTokens = endTokenData.tokens.total - currentTest.startTokens;
    tokenSource = 'otel';
  } else {
    const tokenFile = join(getCleoDir(cwd), 'metrics', 'TOKEN_USAGE.jsonl');
    if (existsSync(tokenFile)) {
      const entries = readJsonlFile(tokenFile);
      totalTokens = entries
        .filter(e => e.session_id === currentTest!.testName)
        .reduce((sum, e) => sum + ((e.estimated_tokens as number) ?? 0), 0);
      tokenSource = 'estimated';
    }
  }

  const tasksCompleted = options.tasksCompleted ?? 0;
  const valPasses = options.validationPasses ?? 0;
  const valFailures = options.validationFailures ?? 0;
  const totalVal = valPasses + valFailures;
  const valRate = totalVal > 0 ? Math.floor((valPasses * 100) / totalVal) : 0;

  const summary: ABTestSummary = {
    test_name: currentTest.testName,
    variant: currentTest.variant,
    start_time: currentTest.startTime,
    end_time: endTime,
    duration_seconds: durationSeconds,
    tokens_consumed: totalTokens,
    token_source: tokenSource,
    tasks_completed: tasksCompleted,
    validations: {
      passed: valPasses,
      failed: valFailures,
      total: totalVal,
      pass_rate_percent: valRate,
    },
    notes: options.notes ?? '',
  };

  await logABEvent('end', currentTest.testName, currentTest.variant, summary as unknown as Record<string, unknown>, cwd);

  currentTest = null;
  return summary;
}

/** Get results for a specific test variant. */
export function getABTestResults(
  testName: string,
  variant: ABVariant,
  cwd?: string,
): Record<string, unknown> | null {
  const file = getABMetricsFile(cwd);
  if (!existsSync(file)) return null;

  const entries = readJsonlFile(file);
  const endEntry = entries
    .filter(e =>
      e.test_name === testName &&
      e.variant === variant &&
      e.event_type === 'end',
    )
    .pop();

  if (!endEntry) return null;
  return endEntry.context as Record<string, unknown>;
}

/** List all A/B tests. */
export function listABTests(filter?: string, cwd?: string): Record<string, unknown>[] {
  const file = getABMetricsFile(cwd);
  if (!existsSync(file)) return [];

  let entries = readJsonlFile(file);
  if (filter) {
    entries = entries.filter(e => e.test_name === filter);
  }

  // Group by test name
  const byTest = new Map<string, typeof entries>();
  for (const e of entries) {
    const name = e.test_name as string;
    if (!byTest.has(name)) byTest.set(name, []);
    byTest.get(name)!.push(e);
  }

  return Array.from(byTest.entries()).map(([testName, group]) => ({
    test_name: testName,
    variants: [...new Set(group.map(e => e.variant as string))],
    total_runs: group.length,
    last_run: group.map(e => e.timestamp as string).sort().pop() ?? null,
  }));
}

/** Compare two variants of the same test. */
export function compareABTest(
  testName: string,
  cwd?: string,
): Record<string, unknown> {
  const cleoResult = getABTestResults(testName, 'cleo', cwd);
  const baselineResult = getABTestResults(testName, 'baseline', cwd);

  if (!cleoResult) return { error: `No CLEO variant found for test '${testName}'` };
  if (!baselineResult) return { error: `No baseline variant found for test '${testName}'` };

  const cleoTokens = (cleoResult.tokens_consumed as number) ?? 0;
  const baselineTokens = (baselineResult.tokens_consumed as number) ?? 0;
  const cleoTasks = (cleoResult.tasks_completed as number) ?? 0;
  const baselineTasks = (baselineResult.tasks_completed as number) ?? 0;
  const cleoValRate = ((cleoResult.validations as Record<string, number>)?.pass_rate_percent) ?? 0;
  const baselineValRate = ((baselineResult.validations as Record<string, number>)?.pass_rate_percent) ?? 0;
  const cleoDuration = (cleoResult.duration_seconds as number) ?? 0;
  const baselineDuration = (baselineResult.duration_seconds as number) ?? 0;

  const tokenDiff = baselineTokens - cleoTokens;
  const tokenSavingsPct = baselineTokens > 0 ? Math.floor((tokenDiff * 100) / baselineTokens) : 0;
  const cleoTokensPerTask = cleoTasks > 0 ? Math.floor(cleoTokens / cleoTasks) : 0;
  const baselineTokensPerTask = baselineTasks > 0 ? Math.floor(baselineTokens / baselineTasks) : 0;

  const isSignificant = Math.abs(tokenSavingsPct) >= 20;

  let verdict: string;
  if (tokenSavingsPct >= 70) verdict = 'Excellent: CLEO saves >70% tokens';
  else if (tokenSavingsPct >= 50) verdict = 'Good: CLEO saves 50-70% tokens';
  else if (tokenSavingsPct >= 20) verdict = 'Moderate: CLEO saves 20-50% tokens';
  else if (tokenSavingsPct >= 0) verdict = 'Minimal: CLEO saves <20% tokens';
  else verdict = 'Warning: CLEO used MORE tokens';

  return {
    test_name: testName,
    comparison: {
      tokens: {
        cleo: cleoTokens,
        baseline: baselineTokens,
        difference: tokenDiff,
        savings_percent: tokenSavingsPct,
        winner: tokenDiff > 0 ? 'cleo' : 'baseline',
      },
      tasks_completed: {
        cleo: cleoTasks,
        baseline: baselineTasks,
        difference: cleoTasks - baselineTasks,
      },
      tokens_per_task: {
        cleo: cleoTokensPerTask,
        baseline: baselineTokensPerTask,
        efficiency_gain_percent: baselineTokensPerTask > 0
          ? Math.floor(((baselineTokensPerTask - cleoTokensPerTask) * 100) / baselineTokensPerTask)
          : 0,
      },
      validation_pass_rate: {
        cleo: cleoValRate,
        baseline: baselineValRate,
        difference: cleoValRate - baselineValRate,
      },
      duration_seconds: {
        cleo: cleoDuration,
        baseline: baselineDuration,
        difference: baselineDuration - cleoDuration,
      },
    },
    statistical: {
      significant: isSignificant,
      confidence_note: 'Simple threshold test: >20% difference considered significant',
    },
    verdict,
    details: { cleo: cleoResult, baseline: baselineResult },
  };
}

/** Get aggregate statistics of all A/B tests. */
export function getABTestStats(cwd?: string): Record<string, unknown> {
  const file = getABMetricsFile(cwd);
  if (!existsSync(file)) {
    return { total_tests: 0, total_runs: 0, avg_token_savings: 0 };
  }

  const entries = readJsonlFile(file);
  const uniqueTests = new Set(entries.map(e => e.test_name as string));
  const totalRuns = entries.length;

  let totalSavings = 0;
  let comparisonCount = 0;

  for (const testName of uniqueTests) {
    const comparison = compareABTest(testName, cwd);
    if (!comparison.error) {
      const savings = (comparison.comparison as Record<string, Record<string, number>>)
        ?.tokens?.savings_percent ?? 0;
      totalSavings += savings;
      comparisonCount++;
    }
  }

  const avgSavings = comparisonCount > 0 ? Math.floor(totalSavings / comparisonCount) : 0;

  return {
    total_tests: uniqueTests.size,
    total_runs: totalRuns,
    completed_comparisons: comparisonCount,
    avg_token_savings_percent: avgSavings,
    summary: `Tracked ${uniqueTests.size} tests with ${comparisonCount} A/B comparisons. Average token savings: ${avgSavings}%`,
  };
}
