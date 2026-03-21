/**
 * Unit tests for the Quality Prediction module.
 *
 * Tests risk scoring, validation outcome prediction, and learning context
 * gathering. All external dependencies are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateTaskRisk, gatherLearningContext, predictValidationOutcome, } from '../prediction.js';
// ---- helpers ----------------------------------------------------------------
function makeTask(overrides) {
    return {
        status: 'pending',
        priority: 'medium',
        description: `Description for ${overrides.id}`,
        createdAt: new Date().toISOString(),
        labels: [],
        depends: [],
        ...overrides,
    };
}
function makePattern(overrides = {}) {
    return {
        id: `P-${Math.random().toString(36).slice(2, 10)}`,
        type: 'success',
        pattern: 'test pattern',
        context: 'test context',
        frequency: 1,
        successRate: null,
        impact: null,
        antiPattern: null,
        mitigation: null,
        examplesJson: '[]',
        extractedAt: new Date().toISOString(),
        updatedAt: null,
        ...overrides,
    };
}
function makeLearning(overrides = {}) {
    return {
        id: `L-${Math.random().toString(36).slice(2, 10)}`,
        insight: 'test insight',
        source: 'test-source',
        confidence: 0.7,
        actionable: false,
        application: null,
        applicableTypesJson: '[]',
        createdAt: new Date().toISOString(),
        updatedAt: null,
        ...overrides,
    };
}
function mockTaskAccessor(tasks) {
    return {
        loadSingleTask: vi
            .fn()
            .mockImplementation((id) => Promise.resolve(tasks.find((t) => t.id === id) ?? null)),
        queryTasks: vi.fn().mockResolvedValue({ tasks, total: tasks.length }),
        countChildren: vi.fn().mockResolvedValue(0),
        close: vi.fn().mockResolvedValue(undefined),
    };
}
function mockBrainAccessor(patterns = [], learnings = []) {
    return {
        findPatterns: vi.fn().mockImplementation((params) => {
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
        findObservations: vi.fn().mockResolvedValue([]),
    };
}
// ---- tests ----------------------------------------------------------------
beforeEach(() => {
    vi.clearAllMocks();
});
describe('calculateTaskRisk', () => {
    it('returns zero risk for not-found task', async () => {
        const taskAccessor = mockTaskAccessor([]);
        const brainAccessor = mockBrainAccessor();
        const result = await calculateTaskRisk('T999', taskAccessor, brainAccessor);
        expect(result.taskId).toBe('T999');
        expect(result.riskScore).toBe(0);
        expect(result.confidence).toBe(0);
        expect(result.factors).toHaveLength(0);
        expect(result.recommendation).toContain('not found');
    });
    it('calculates risk for a simple task with no dependencies', async () => {
        const task = makeTask({ id: 'T001', title: 'Simple task', size: 'small' });
        const taskAccessor = mockTaskAccessor([task]);
        const brainAccessor = mockBrainAccessor();
        const result = await calculateTaskRisk('T001', taskAccessor, brainAccessor);
        expect(result.taskId).toBe('T001');
        expect(result.riskScore).toBeGreaterThanOrEqual(0);
        expect(result.riskScore).toBeLessThanOrEqual(1);
        expect(result.confidence).toBeGreaterThan(0);
        expect(result.factors).toHaveLength(4);
        expect(result.recommendation).toBeTruthy();
    });
    it('scores higher risk for a large task with many dependencies', async () => {
        const deps = ['T010', 'T011', 'T012', 'T013', 'T014'];
        const depTasks = deps.map((id) => makeTask({ id, title: `Dep ${id}` }));
        const task = makeTask({
            id: 'T001',
            title: 'Complex task',
            size: 'large',
            depends: deps,
        });
        const allTasks = [task, ...depTasks];
        const taskAccessor = mockTaskAccessor(allTasks);
        const brainAccessor = mockBrainAccessor();
        const result = await calculateTaskRisk('T001', taskAccessor, brainAccessor);
        expect(result.riskScore).toBeGreaterThan(0.1);
        const complexityFactor = result.factors.find((f) => f.name === 'complexity');
        expect(complexityFactor).toBeDefined();
        expect(complexityFactor.value).toBeGreaterThan(0.3);
    });
    it('increases risk when task blocks other tasks', async () => {
        const task = makeTask({ id: 'T001', title: 'Blocker task' });
        const dependents = [
            makeTask({ id: 'T002', title: 'Dep 1', depends: ['T001'] }),
            makeTask({ id: 'T003', title: 'Dep 2', depends: ['T001'] }),
            makeTask({ id: 'T004', title: 'Dep 3', depends: ['T001'] }),
        ];
        const taskAccessor = mockTaskAccessor([task, ...dependents]);
        const brainAccessor = mockBrainAccessor();
        const result = await calculateTaskRisk('T001', taskAccessor, brainAccessor);
        const blockingFactor = result.factors.find((f) => f.name === 'blocking_risk');
        expect(blockingFactor).toBeDefined();
        expect(blockingFactor.value).toBeGreaterThan(0);
        expect(blockingFactor.description).toContain('blocks');
    });
    it('considers historical failure patterns in risk score', async () => {
        const task = makeTask({ id: 'T001', title: 'Auth migration', labels: ['auth'] });
        const taskAccessor = mockTaskAccessor([task]);
        const failurePatterns = [
            makePattern({
                type: 'failure',
                pattern: 'Auth migrations tend to fail due to token format changes',
                context: 'auth module',
                successRate: 0.3,
            }),
        ];
        const brainAccessor = mockBrainAccessor(failurePatterns);
        const result = await calculateTaskRisk('T001', taskAccessor, brainAccessor);
        const historicalFactor = result.factors.find((f) => f.name === 'historical_failure');
        expect(historicalFactor).toBeDefined();
        expect(historicalFactor.value).toBeGreaterThan(0);
    });
    it('returns low risk recommendation for simple tasks', async () => {
        const task = makeTask({ id: 'T001', title: 'Fix typo', size: 'small' });
        const taskAccessor = mockTaskAccessor([task]);
        const brainAccessor = mockBrainAccessor();
        const result = await calculateTaskRisk('T001', taskAccessor, brainAccessor);
        expect(result.recommendation).toContain('Low risk');
    });
    it('walks dependency chain for depth calculation', async () => {
        const t3 = makeTask({ id: 'T003', title: 'Leaf', depends: [] });
        const t2 = makeTask({ id: 'T002', title: 'Mid', depends: ['T003'] });
        const t1 = makeTask({ id: 'T001', title: 'Root', depends: ['T002'] });
        const taskAccessor = mockTaskAccessor([t1, t2, t3]);
        const brainAccessor = mockBrainAccessor();
        const result = await calculateTaskRisk('T001', taskAccessor, brainAccessor);
        const depthFactor = result.factors.find((f) => f.name === 'dependency_depth');
        expect(depthFactor).toBeDefined();
        expect(depthFactor.value).toBeGreaterThan(0);
        expect(depthFactor.description).toContain('Dependency chain depth: 2');
    });
});
describe('predictValidationOutcome', () => {
    it('returns zero likelihood for not-found task', async () => {
        const taskAccessor = mockTaskAccessor([]);
        const brainAccessor = mockBrainAccessor();
        const result = await predictValidationOutcome('T999', 'specification', taskAccessor, brainAccessor);
        expect(result.taskId).toBe('T999');
        expect(result.passLikelihood).toBe(0);
        expect(result.blockers).toHaveLength(1);
        expect(result.blockers[0]).toContain('not found');
    });
    it('predicts higher likelihood for done tasks', async () => {
        const task = makeTask({ id: 'T001', title: 'Done task', status: 'done' });
        const taskAccessor = mockTaskAccessor([task]);
        const brainAccessor = mockBrainAccessor();
        const result = await predictValidationOutcome('T001', 'verification', taskAccessor, brainAccessor);
        expect(result.passLikelihood).toBeGreaterThan(0.5);
        expect(result.blockers).toHaveLength(0);
    });
    it('reports blockers for blocked tasks', async () => {
        const task = makeTask({
            id: 'T001',
            title: 'Blocked task',
            status: 'blocked',
            blockedBy: 'Waiting for API access',
        });
        const taskAccessor = mockTaskAccessor([task]);
        const brainAccessor = mockBrainAccessor();
        const result = await predictValidationOutcome('T001', 'implementation', taskAccessor, brainAccessor);
        expect(result.blockers.length).toBeGreaterThan(0);
        expect(result.blockers[0]).toContain('blocked');
        expect(result.suggestions.length).toBeGreaterThan(0);
    });
    it('boosts prediction when acceptance criteria exist', async () => {
        const taskWith = makeTask({
            id: 'T001',
            title: 'With criteria',
            status: 'active',
            acceptance: ['Unit tests pass', 'Integration tests pass'],
        });
        const taskWithout = makeTask({
            id: 'T002',
            title: 'Without criteria',
            status: 'active',
        });
        const taskAccessor = mockTaskAccessor([taskWith, taskWithout]);
        const brainAccessor = mockBrainAccessor();
        const resultWith = await predictValidationOutcome('T001', 'implementation', taskAccessor, brainAccessor);
        const resultWithout = await predictValidationOutcome('T002', 'implementation', taskAccessor, brainAccessor);
        expect(resultWith.passLikelihood).toBeGreaterThanOrEqual(resultWithout.passLikelihood);
    });
    it('uses historical patterns for prediction', async () => {
        const task = makeTask({ id: 'T001', title: 'Feature task', status: 'active' });
        const taskAccessor = mockTaskAccessor([task]);
        const patterns = [
            makePattern({
                type: 'success',
                pattern: 'Implementation passes consistently',
                context: 'implementation stage validation',
                successRate: 0.9,
            }),
        ];
        const brainAccessor = mockBrainAccessor(patterns);
        const result = await predictValidationOutcome('T001', 'implementation', taskAccessor, brainAccessor);
        // Should have a reasonable pass likelihood given the success pattern
        expect(result.passLikelihood).toBeGreaterThan(0);
    });
    it('suggests mitigation from failure patterns', async () => {
        const task = makeTask({ id: 'T001', title: 'Deploy task', status: 'active' });
        const taskAccessor = mockTaskAccessor([task]);
        const patterns = [
            makePattern({
                type: 'failure',
                pattern: 'Deployments fail when tests are skipped',
                context: 'release stage gate',
                successRate: 0.2,
                mitigation: 'Always run full test suite before release',
            }),
        ];
        const brainAccessor = mockBrainAccessor(patterns);
        const result = await predictValidationOutcome('T001', 'release', taskAccessor, brainAccessor);
        expect(result.suggestions.some((s) => s.includes('test suite'))).toBe(true);
    });
});
describe('gatherLearningContext', () => {
    it('returns empty context when no learnings exist', async () => {
        const task = makeTask({ id: 'T001', title: 'Test task' });
        const brainAccessor = mockBrainAccessor([], []);
        const context = await gatherLearningContext(task, brainAccessor);
        expect(context.applicable).toHaveLength(0);
        expect(context.averageConfidence).toBe(0);
        expect(context.actionableCount).toBe(0);
    });
    it('matches learnings by task ID reference', async () => {
        const task = makeTask({ id: 'T001', title: 'Auth fix' });
        const learnings = [
            makeLearning({
                insight: 'Completed: T001 auth fix was successful',
                source: 'task-completion:T001',
                confidence: 0.8,
                actionable: true,
            }),
            makeLearning({
                insight: 'Unrelated learning about database',
                source: 'manual',
                confidence: 0.5,
            }),
        ];
        const brainAccessor = mockBrainAccessor([], learnings);
        const context = await gatherLearningContext(task, brainAccessor);
        expect(context.applicable).toHaveLength(1);
        expect(context.applicable[0].insight).toContain('T001');
        expect(context.actionableCount).toBe(1);
    });
    it('matches learnings by label overlap', async () => {
        const task = makeTask({ id: 'T001', title: 'Auth feature', labels: ['auth', 'security'] });
        const learnings = [
            makeLearning({
                insight: 'Auth module requires special token handling',
                source: 'session-end:S-001',
                confidence: 0.7,
            }),
        ];
        const brainAccessor = mockBrainAccessor([], learnings);
        const context = await gatherLearningContext(task, brainAccessor);
        expect(context.applicable).toHaveLength(1);
    });
    it('calculates average confidence correctly', async () => {
        const task = makeTask({ id: 'T001', title: 'Test task', labels: ['test'] });
        const learnings = [
            makeLearning({ insight: 'Test insight 1', confidence: 0.6 }),
            makeLearning({ insight: 'Test insight 2', confidence: 0.8 }),
        ];
        // Both contain 'test' so match by label
        const brainAccessor = mockBrainAccessor([], learnings);
        const context = await gatherLearningContext(task, brainAccessor);
        expect(context.applicable).toHaveLength(2);
        expect(context.averageConfidence).toBe(0.7);
    });
});
//# sourceMappingURL=prediction.test.js.map