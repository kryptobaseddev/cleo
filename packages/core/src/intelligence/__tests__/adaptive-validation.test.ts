/**
 * Unit tests for the Adaptive Validation module.
 *
 * Tests gate focus suggestions, confidence scoring, and prediction storage.
 * All external dependencies are mocked.
 *
 * @task T035
 * @epic T029
 */

import type { Task, TaskVerification } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import type { BrainDataAccessor } from '../../store/memory-accessor.js';
import type {
  BrainLearningRow,
  BrainObservationRow,
  BrainPatternRow,
} from '../../store/memory-schema.js';
import {
  predictAndStore,
  scoreVerificationConfidence,
  storePrediction,
  suggestGateFocus,
} from '../adaptive-validation.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    status: 'pending',
    priority: 'medium',
    description: `Description for ${overrides.id}`,
    createdAt: new Date().toISOString(),
    labels: [],
    depends: [],
    ...overrides,
  } as Task;
}

function makeVerification(overrides: Partial<TaskVerification> = {}): TaskVerification {
  return {
    passed: false,
    round: 1,
    gates: {},
    lastAgent: null,
    lastUpdated: null,
    failureLog: [],
    ...overrides,
  };
}

function makePattern(overrides: Partial<BrainPatternRow> = {}): BrainPatternRow {
  return {
    id: `P-${Math.random().toString(36).slice(2, 10)}`,
    type: 'failure',
    pattern: 'test pattern',
    context: 'test context',
    frequency: 2,
    successRate: 0.3,
    impact: 'medium',
    antiPattern: null,
    mitigation: null,
    examplesJson: '[]',
    extractedAt: new Date().toISOString(),
    updatedAt: null,
    ...overrides,
  };
}

function mockTaskAccessor(tasks: Task[]): DataAccessor {
  return {
    loadSingleTask: vi
      .fn()
      .mockImplementation((id: string) => Promise.resolve(tasks.find((t) => t.id === id) ?? null)),
    queryTasks: vi.fn().mockResolvedValue({ tasks, total: tasks.length }),
    countChildren: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as DataAccessor;
}

function mockBrainAccessor(
  patterns: BrainPatternRow[] = [],
  observations: BrainObservationRow[] = [],
  learnings: BrainLearningRow[] = [],
): BrainDataAccessor {
  return {
    findPatterns: vi.fn().mockImplementation((params?: { type?: string; limit?: number }) => {
      let filtered = patterns;
      if (params?.type) {
        filtered = filtered.filter((p) => p.type === params.type);
      }
      if (params?.limit) {
        filtered = filtered.slice(0, params.limit);
      }
      return Promise.resolve(filtered);
    }),
    findLearnings: vi.fn().mockResolvedValue(learnings),
    findObservations: vi.fn().mockResolvedValue(observations),
    addObservation: vi.fn().mockImplementation((row: BrainObservationRow) => Promise.resolve(row)),
    addLearning: vi.fn().mockImplementation((row: BrainLearningRow) => Promise.resolve(row)),
    getObservation: vi.fn().mockResolvedValue(null),
  } as unknown as BrainDataAccessor;
}

// ============================================================================
// Tests: suggestGateFocus
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
});

describe('suggestGateFocus', () => {
  it('returns empty gate focus for not-found task', async () => {
    const taskAccessor = mockTaskAccessor([]);
    const brainAccessor = mockBrainAccessor();

    const result = await suggestGateFocus('T999', taskAccessor, brainAccessor);

    expect(result.taskId).toBe('T999');
    expect(result.gateFocus).toHaveLength(0);
    expect(result.tips[0]).toContain('not found');
  });

  it('returns gate recommendations for a simple task', async () => {
    const task = makeTask({ id: 'T001', title: 'Simple feature', size: 'small' });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const result = await suggestGateFocus('T001', taskAccessor, brainAccessor);

    expect(result.taskId).toBe('T001');
    expect(result.gateFocus.length).toBeGreaterThan(0);
    expect(result.overallConfidence).toBeGreaterThanOrEqual(0);
    expect(result.overallConfidence).toBeLessThanOrEqual(1);
  });

  it('skips already-passed gates', async () => {
    const task = makeTask({
      id: 'T001',
      title: 'Partial task',
      verification: makeVerification({
        gates: { implemented: true, testsPassed: true },
      }),
    });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const result = await suggestGateFocus('T001', taskAccessor, brainAccessor);

    const gateNames = result.gateFocus.map((r) => r.gate);
    expect(gateNames).not.toContain('implemented');
    expect(gateNames).not.toContain('testsPassed');
  });

  it('marks security gate as high priority for security-labeled tasks', async () => {
    const task = makeTask({
      id: 'T001',
      title: 'Auth overhaul',
      labels: ['auth', 'security'],
      size: 'large',
    });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const result = await suggestGateFocus('T001', taskAccessor, brainAccessor);

    const securityGate = result.gateFocus.find((r) => r.gate === 'securityPassed');
    expect(securityGate).toBeDefined();
    expect(securityGate!.priority).toBe('high');
  });

  it('incorporates historical failure patterns into gate risk', async () => {
    const task = makeTask({ id: 'T001', title: 'Deploy service', labels: ['deploy'] });
    const failurePatterns = [
      makePattern({
        type: 'failure',
        pattern: 'testsPassed gate often fails during deploy tasks',
        context: 'deploy testing failure',
        successRate: 0.1,
      }),
    ];
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor(failurePatterns);

    const result = await suggestGateFocus('T001', taskAccessor, brainAccessor);

    const testsGate = result.gateFocus.find((r) => r.gate === 'testsPassed');
    expect(testsGate).toBeDefined();
    // Historical failure data should push this gate to high priority
    expect(testsGate!.priority).toBe('high');
  });

  it('includes mitigation from historical patterns in rationale', async () => {
    const task = makeTask({ id: 'T001', title: 'Migration task', labels: ['migration'] });
    const failurePatterns = [
      makePattern({
        type: 'failure',
        pattern: 'qaPassed fails on migration tasks',
        context: 'migration qa failure',
        successRate: 0.2,
        mitigation: 'Always test rollback before qa sign-off',
      }),
    ];
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor(failurePatterns);

    const result = await suggestGateFocus('T001', taskAccessor, brainAccessor);

    const qaGate = result.gateFocus.find((r) => r.gate === 'qaPassed');
    expect(qaGate).toBeDefined();
    expect(qaGate!.rationale).toContain('rollback');
  });

  it('orders gates by priority (high before medium before low)', async () => {
    const task = makeTask({
      id: 'T001',
      title: 'Auth service',
      labels: ['auth', 'security'],
      size: 'large',
      priority: 'critical',
    });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const result = await suggestGateFocus('T001', taskAccessor, brainAccessor);

    const priorityValues: Record<string, number> = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < result.gateFocus.length; i++) {
      const prevPriority = priorityValues[result.gateFocus[i - 1].priority];
      const currPriority = priorityValues[result.gateFocus[i].priority];
      expect(prevPriority).toBeLessThanOrEqual(currPriority);
    }
  });

  it('generates tips about missing acceptance criteria', async () => {
    const task = makeTask({ id: 'T001', title: 'Feature', acceptance: [] });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const result = await suggestGateFocus('T001', taskAccessor, brainAccessor);

    expect(result.tips.some((t) => t.toLowerCase().includes('acceptance'))).toBe(true);
  });

  it('mentions previously-failed gates in tips', async () => {
    const task = makeTask({
      id: 'T001',
      title: 'Retry task',
      verification: makeVerification({
        round: 2,
        gates: { testsPassed: false },
      }),
    });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const result = await suggestGateFocus('T001', taskAccessor, brainAccessor);

    expect(result.tips.some((t) => t.includes('previous'))).toBe(true);
  });
});

// ============================================================================
// Tests: scoreVerificationConfidence
// ============================================================================

describe('scoreVerificationConfidence', () => {
  it('returns confidence 0 when all tracked gates failed', async () => {
    const task = makeTask({ id: 'T001', title: 'Failing task' });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const verification = makeVerification({
      passed: false,
      round: 5,
      gates: {
        implemented: false,
        testsPassed: false,
        qaPassed: false,
      },
      failureLog: [
        { round: 1, agent: 'qa', reason: 'fails', timestamp: new Date().toISOString() },
        { round: 2, agent: 'qa', reason: 'still fails', timestamp: new Date().toISOString() },
        { round: 3, agent: 'qa', reason: 'again', timestamp: new Date().toISOString() },
      ],
    });

    const result = await scoreVerificationConfidence(
      'T001',
      verification,
      taskAccessor,
      brainAccessor,
      { dryRun: true },
    );

    expect(result.confidenceScore).toBeLessThan(0.3);
    expect(result.passed).toBe(false);
    expect(result.gatesFailed).toContain('implemented');
    expect(result.observationId).toBeUndefined();
  });

  it('returns high confidence for first-round all-pass', async () => {
    const task = makeTask({ id: 'T001', title: 'Green task' });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const verification = makeVerification({
      passed: true,
      round: 1,
      gates: {
        implemented: true,
        testsPassed: true,
        qaPassed: true,
      },
      failureLog: [],
    });

    const result = await scoreVerificationConfidence(
      'T001',
      verification,
      taskAccessor,
      brainAccessor,
      { dryRun: true },
    );

    expect(result.confidenceScore).toBeGreaterThan(0.7);
    expect(result.passed).toBe(true);
    expect(result.gatesPassed).toContain('implemented');
    expect(result.gatesPassed).toContain('testsPassed');
    expect(result.gatesPassed).toContain('qaPassed');
  });

  it('correctly classifies gatesPassed and gatesFailed', async () => {
    const task = makeTask({ id: 'T001', title: 'Mixed task' });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const verification = makeVerification({
      passed: false,
      round: 1,
      gates: {
        implemented: true,
        testsPassed: false,
        qaPassed: null,
        cleanupDone: true,
      },
    });

    const result = await scoreVerificationConfidence(
      'T001',
      verification,
      taskAccessor,
      brainAccessor,
      { dryRun: true },
    );

    expect(result.gatesPassed).toContain('implemented');
    expect(result.gatesPassed).toContain('cleanupDone');
    expect(result.gatesFailed).toContain('testsPassed');
    expect(result.gatesFailed).toContain('qaPassed');
  });

  it('persists observation when not dry-run', async () => {
    const task = makeTask({ id: 'T001', title: 'Persist task' });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const verification = makeVerification({
      passed: true,
      round: 1,
      gates: { implemented: true, testsPassed: true },
    });

    const result = await scoreVerificationConfidence(
      'T001',
      verification,
      taskAccessor,
      brainAccessor,
    );

    expect(brainAccessor.addObservation).toHaveBeenCalledTimes(1);
    expect(result.observationId).toBeDefined();
    expect(result.observationId).toMatch(/^O-vconf-/);
  });

  it('extracts learning for high-confidence first-round pass', async () => {
    const task = makeTask({ id: 'T001', title: 'Clean task', size: 'small' });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const verification = makeVerification({
      passed: true,
      round: 1,
      gates: {
        implemented: true,
        testsPassed: true,
        qaPassed: true,
        cleanupDone: true,
        documented: true,
      },
      failureLog: [],
    });

    const result = await scoreVerificationConfidence(
      'T001',
      verification,
      taskAccessor,
      brainAccessor,
    );

    expect(brainAccessor.addLearning).toHaveBeenCalledTimes(1);
    expect(result.learningId).toBeDefined();
    expect(result.learningId).toMatch(/^L-vconf-/);
  });

  it('extracts actionable learning when multiple gates fail', async () => {
    const task = makeTask({ id: 'T001', title: 'Troubled task', labels: ['auth'] });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const verification = makeVerification({
      passed: false,
      round: 2,
      gates: { testsPassed: false, qaPassed: false, securityPassed: false },
      failureLog: [
        { round: 1, agent: 'qa', reason: 'coverage', timestamp: new Date().toISOString() },
        { round: 1, agent: 'security', reason: 'vuln', timestamp: new Date().toISOString() },
      ],
    });

    const result = await scoreVerificationConfidence(
      'T001',
      verification,
      taskAccessor,
      brainAccessor,
    );

    // Should extract learning: >= 2 gates failed
    expect(brainAccessor.addLearning).toHaveBeenCalledTimes(1);
    const learningCall = (brainAccessor.addLearning as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(learningCall.actionable).toBe(true);
    expect(learningCall.insight).toContain('testsPassed');
    expect(result.learningId).toBeDefined();
  });

  it('does not extract learning for moderate mid-round outcomes', async () => {
    const task = makeTask({ id: 'T001', title: 'Average task' });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const verification = makeVerification({
      passed: true,
      round: 3,
      gates: { implemented: true, testsPassed: true },
      failureLog: [{ round: 1, agent: 'qa', reason: 'minor', timestamp: new Date().toISOString() }],
    });

    const result = await scoreVerificationConfidence(
      'T001',
      verification,
      taskAccessor,
      brainAccessor,
    );

    // Round 3 pass with moderate confidence — not notable enough
    expect(result.learningId).toBeUndefined();
  });
});

// ============================================================================
// Tests: storePrediction
// ============================================================================

describe('storePrediction', () => {
  it('returns undefined on dry run', async () => {
    const brainAccessor = mockBrainAccessor();

    const observationId = await storePrediction(
      {
        taskId: 'T001',
        stage: 'implementation',
        passLikelihood: 0.8,
        blockers: [],
        suggestions: ['Review docs'],
      },
      brainAccessor,
      { dryRun: true },
    );

    expect(observationId).toBeUndefined();
    expect(brainAccessor.addObservation).not.toHaveBeenCalled();
  });

  it('persists prediction observation to brain', async () => {
    const brainAccessor = mockBrainAccessor();

    const observationId = await storePrediction(
      {
        taskId: 'T001',
        stage: 'specification',
        passLikelihood: 0.6,
        blockers: ['Missing AC'],
        suggestions: [],
      },
      brainAccessor,
      { project: 'test-project', sessionId: 'S-001' },
    );

    expect(observationId).toMatch(/^O-pred-/);
    expect(brainAccessor.addObservation).toHaveBeenCalledTimes(1);
    const obs = (brainAccessor.addObservation as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(obs.title).toContain('T001');
    expect(obs.title).toContain('specification');
    expect(obs.narrative).toContain('Missing AC');
    expect(obs.project).toBe('test-project');
    expect(obs.sourceSessionId).toBe('S-001');
  });

  it('includes pass likelihood in subtitle', async () => {
    const brainAccessor = mockBrainAccessor();

    await storePrediction(
      {
        taskId: 'T002',
        stage: 'verification',
        passLikelihood: 0.75,
        blockers: [],
        suggestions: [],
      },
      brainAccessor,
    );

    const obs = (brainAccessor.addObservation as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(obs.subtitle).toContain('75%');
  });
});

// ============================================================================
// Tests: predictAndStore
// ============================================================================

describe('predictAndStore', () => {
  it('returns prediction with observationId when not dry-run', async () => {
    const task = makeTask({ id: 'T001', title: 'Feature task', status: 'active' });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const result = await predictAndStore('T001', 'implementation', taskAccessor, brainAccessor);

    expect(result.taskId).toBe('T001');
    expect(result.stage).toBe('implementation');
    expect(result.passLikelihood).toBeGreaterThanOrEqual(0);
    expect(result.passLikelihood).toBeLessThanOrEqual(1);
    expect(result.observationId).toMatch(/^O-pred-/);
    expect(brainAccessor.addObservation).toHaveBeenCalledTimes(1);
  });

  it('skips storage on dry run', async () => {
    const task = makeTask({ id: 'T001', title: 'Feature task', status: 'active' });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const result = await predictAndStore('T001', 'specification', taskAccessor, brainAccessor, {
      dryRun: true,
    });

    expect(result.observationId).toBeUndefined();
    expect(brainAccessor.addObservation).not.toHaveBeenCalled();
  });

  it('handles task not found gracefully', async () => {
    const taskAccessor = mockTaskAccessor([]);
    const brainAccessor = mockBrainAccessor();

    const result = await predictAndStore('T999', 'verification', taskAccessor, brainAccessor, {
      dryRun: true,
    });

    expect(result.taskId).toBe('T999');
    expect(result.passLikelihood).toBe(0);
    expect(result.blockers[0]).toContain('not found');
    expect(result.observationId).toBeUndefined();
  });
});

// ============================================================================
// Tests: confidence score computation boundary cases
// ============================================================================

describe('confidence score boundary cases', () => {
  it('confidence approaches 1.0 for ideal verification', async () => {
    const task = makeTask({ id: 'T001', title: 'Ideal' });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const allGatesPassed: TaskVerification['gates'] = {
      implemented: true,
      testsPassed: true,
      qaPassed: true,
      cleanupDone: true,
      securityPassed: true,
      documented: true,
    };

    const verification = makeVerification({
      passed: true,
      round: 1,
      gates: allGatesPassed,
      failureLog: [],
    });

    const result = await scoreVerificationConfidence(
      'T001',
      verification,
      taskAccessor,
      brainAccessor,
      { dryRun: true },
    );

    // 6/6 gates passed (0.6) + no failures (0.2) + round 1 (0.2) = 1.0
    expect(result.confidenceScore).toBe(1.0);
  });

  it('confidence is lower for multi-round verification even with pass', async () => {
    const task = makeTask({ id: 'T001', title: 'Multi-round' });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const singleRound = makeVerification({
      passed: true,
      round: 1,
      gates: { implemented: true, testsPassed: true },
      failureLog: [],
    });

    const multiRound = makeVerification({
      passed: true,
      round: 3,
      gates: { implemented: true, testsPassed: true },
      failureLog: [{ round: 1, agent: 'qa', reason: 'issue', timestamp: new Date().toISOString() }],
    });

    const [s1, m1] = await Promise.all([
      scoreVerificationConfidence('T001', singleRound, taskAccessor, brainAccessor, {
        dryRun: true,
      }),
      scoreVerificationConfidence('T001', multiRound, taskAccessor, brainAccessor, {
        dryRun: true,
      }),
    ]);

    expect(s1.confidenceScore).toBeGreaterThan(m1.confidenceScore);
  });

  it('confidence is clamped between 0 and 1', async () => {
    const task = makeTask({ id: 'T001', title: 'Extreme' });
    const taskAccessor = mockTaskAccessor([task]);
    const brainAccessor = mockBrainAccessor();

    const worstCase = makeVerification({
      passed: false,
      round: 10,
      gates: {
        implemented: false,
        testsPassed: false,
        qaPassed: false,
        cleanupDone: false,
        securityPassed: false,
        documented: false,
      },
      failureLog: Array.from({ length: 10 }, (_, i) => ({
        round: i + 1,
        agent: 'qa',
        reason: `failure ${i}`,
        timestamp: new Date().toISOString(),
      })),
    });

    const result = await scoreVerificationConfidence(
      'T001',
      worstCase,
      taskAccessor,
      brainAccessor,
      { dryRun: true },
    );

    expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(result.confidenceScore).toBeLessThanOrEqual(1);
  });
});
