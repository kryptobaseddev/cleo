/**
 * Unit tests for auto-extract memory pipeline.
 *
 * All external dependencies are mocked — this tests extraction logic only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// ---- mocks ----------------------------------------------------------------
vi.mock('../learnings.js', () => ({
    storeLearning: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../patterns.js', () => ({
    storePattern: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../decisions.js', () => ({
    storeDecision: vi.fn().mockResolvedValue(undefined),
}));
// Mock getAccessor used inside auto-extract for pattern detection
vi.mock('../../../store/data-accessor.js', () => ({
    getAccessor: vi.fn(),
}));
// ---- imports after mocks --------------------------------------------------
import { getAccessor } from '../store/data-accessor.js';
import { extractSessionEndMemory, extractTaskCompletionMemory, resolveTaskDetails, } from '../auto-extract.js';
import { storeDecision } from '../decisions.js';
import { storeLearning } from '../learnings.js';
import { storePattern } from '../patterns.js';
// ---- helpers --------------------------------------------------------------
function makeTask(overrides) {
    return {
        status: 'done',
        priority: 'medium',
        description: `Description for ${overrides.id}`,
        createdAt: new Date().toISOString(),
        labels: [],
        depends: [],
        ...overrides,
    };
}
function makeSessionData(overrides = {}) {
    return {
        sessionId: 'S-test-001',
        scope: 'test scope',
        tasksCompleted: [],
        duration: 3600,
        ...overrides,
    };
}
function setupAccessor(tasks) {
    getAccessor.mockResolvedValue({
        loadTaskFile: vi.fn().mockResolvedValue({ tasks }),
        close: vi.fn().mockResolvedValue(undefined),
    });
}
// ---- tests ----------------------------------------------------------------
beforeEach(() => {
    vi.clearAllMocks();
});
describe('extractTaskCompletionMemory', () => {
    it('creates a learning from completed task', async () => {
        const task = makeTask({ id: 'T001', title: 'Fix auth bug', description: 'Auth was broken' });
        setupAccessor([task]);
        await extractTaskCompletionMemory('/mock/root', task);
        expect(storeLearning).toHaveBeenCalledWith('/mock/root', expect.objectContaining({
            insight: `Completed: ${task.title} — ${task.description}`,
            source: `task-completion:${task.id}`,
            confidence: 0.7,
            actionable: true,
        }));
    });
    it('creates dependency learning when task has dependencies', async () => {
        const task = makeTask({
            id: 'T002',
            title: 'Deploy feature',
            description: 'Deploy the thing',
            depends: ['T001', 'T003'],
        });
        setupAccessor([task]);
        await extractTaskCompletionMemory('/mock/root', task);
        const calls = storeLearning.mock.calls;
        const depCall = calls.find((c) => c[1].insight.includes('depended on'));
        expect(depCall).toBeDefined();
        expect(depCall[1].insight).toContain('T001, T003');
        expect(depCall[1].source).toBe('task-completion:T002');
    });
    it('does not create dependency learning when task has no dependencies', async () => {
        const task = makeTask({ id: 'T003', title: 'Solo task', depends: [] });
        setupAccessor([task]);
        await extractTaskCompletionMemory('/mock/root', task);
        const depCall = storeLearning.mock.calls.find((c) => c[1].insight.includes('depended on'));
        expect(depCall).toBeUndefined();
    });
    it('stores a pattern when a label appears 3+ times in done tasks', async () => {
        const completedTasks = [
            makeTask({ id: 'T010', title: 'A', labels: ['bug'] }),
            makeTask({ id: 'T011', title: 'B', labels: ['bug'] }),
            makeTask({ id: 'T012', title: 'C', labels: ['bug'] }),
        ];
        const trigger = makeTask({ id: 'T013', title: 'D', labels: ['bug'] });
        setupAccessor([...completedTasks, trigger]);
        await extractTaskCompletionMemory('/mock/root', trigger);
        expect(storePattern).toHaveBeenCalledWith('/mock/root', expect.objectContaining({
            type: 'success',
            impact: 'medium',
        }));
    });
    it('does not throw on error', async () => {
        storeLearning.mockRejectedValueOnce(new Error('db error'));
        setupAccessor([]);
        await expect(extractTaskCompletionMemory('/mock/root', makeTask({ id: 'T099', title: 'X' }))).resolves.toBeUndefined();
    });
});
describe('extractSessionEndMemory', () => {
    it('creates a decision when tasks are completed', async () => {
        const tasks = [
            makeTask({ id: 'T001', title: 'Task one' }),
            makeTask({ id: 'T002', title: 'Task two' }),
        ];
        const session = makeSessionData({ sessionId: 'S-001', tasksCompleted: ['T001', 'T002'] });
        await extractSessionEndMemory('/mock/root', session, tasks);
        expect(storeDecision).toHaveBeenCalledWith('/mock/root', expect.objectContaining({
            type: 'process',
            confidence: 'medium',
        }));
        const call = storeDecision.mock.calls[0][1];
        expect(call.decision).toContain('S-001');
        expect(call.decision).toContain('T001');
        expect(call.decision).toContain('T002');
        expect(call.rationale).toContain('test scope');
    });
    it('does not create a decision when no tasks completed', async () => {
        const session = makeSessionData({ tasksCompleted: [] });
        await extractSessionEndMemory('/mock/root', session, []);
        expect(storeDecision).not.toHaveBeenCalled();
    });
    it('creates per-task learnings', async () => {
        const tasks = [
            makeTask({ id: 'T001', title: 'Task one', description: 'Desc one' }),
            makeTask({ id: 'T002', title: 'Task two', description: 'Desc two' }),
        ];
        const session = makeSessionData({ sessionId: 'S-002', tasksCompleted: ['T001', 'T002'] });
        await extractSessionEndMemory('/mock/root', session, tasks);
        const calls = storeLearning.mock.calls;
        expect(calls.length).toBe(2);
        calls.forEach((c) => {
            expect(c[1].source).toBe('session-end:S-002');
            expect(c[1].confidence).toBe(0.7);
        });
    });
    it('stores a workflow pattern when 2+ tasks share a label', async () => {
        const tasks = [
            makeTask({ id: 'T001', title: 'A', labels: ['feature'] }),
            makeTask({ id: 'T002', title: 'B', labels: ['feature'] }),
        ];
        const session = makeSessionData({ sessionId: 'S-003', tasksCompleted: ['T001', 'T002'] });
        await extractSessionEndMemory('/mock/root', session, tasks);
        expect(storePattern).toHaveBeenCalledWith('/mock/root', expect.objectContaining({
            type: 'workflow',
            impact: 'medium',
        }));
    });
    it('does not throw on error', async () => {
        storeDecision.mockRejectedValueOnce(new Error('db fail'));
        const tasks = [makeTask({ id: 'T001', title: 'X' })];
        const session = makeSessionData({ tasksCompleted: ['T001'] });
        await expect(extractSessionEndMemory('/mock/root', session, tasks)).resolves.toBeUndefined();
    });
});
describe('resolveTaskDetails', () => {
    it('resolves task IDs to task objects', async () => {
        const tasks = [
            makeTask({ id: 'T001', title: 'Alpha' }),
            makeTask({ id: 'T002', title: 'Beta' }),
            makeTask({ id: 'T003', title: 'Gamma' }),
        ];
        setupAccessor(tasks);
        const result = await resolveTaskDetails('/mock/root', ['T001', 'T003']);
        expect(result).toHaveLength(2);
        expect(result.map((t) => t.id)).toEqual(expect.arrayContaining(['T001', 'T003']));
    });
    it('filters out missing tasks', async () => {
        const tasks = [makeTask({ id: 'T001', title: 'Alpha' })];
        setupAccessor(tasks);
        const result = await resolveTaskDetails('/mock/root', ['T001', 'T999']);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('T001');
    });
    it('returns empty array when taskIds is empty', async () => {
        setupAccessor([]);
        const result = await resolveTaskDetails('/mock/root', []);
        expect(result).toEqual([]);
        // getAccessor should not be called for empty input
        expect(getAccessor).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=auto-extract.test.js.map