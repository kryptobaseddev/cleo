/**
 * E2E integration tests: hook automation fires across lifecycle events
 *
 * Verifies that brain automation hooks actually dispatch and call observeBrain
 * with the correct payloads for all lifecycle event types. Tests use mock
 * adapters and direct handler invocation to exercise the full handler logic
 * without requiring a real SQLite database.
 *
 * @task T168
 * @epic T134
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// ---------------------------------------------------------------------------
// Mock setup — must come before any handler imports.
// vi.mock is hoisted; factory fns must use vi.fn() inline (not outer vars).
// After imports, use vi.mocked() to get typed refs to the mock instances.
// ---------------------------------------------------------------------------
vi.mock('../../../memory/brain-retrieval.js', () => ({
    observeBrain: vi.fn(),
}));
vi.mock('../../../config.js', () => ({
    loadConfig: vi.fn(),
}));
vi.mock('../memory-bridge-refresh.js', () => ({
    maybeRefreshMemoryBridge: vi.fn(),
}));
// ---------------------------------------------------------------------------
// Handler imports — after mock setup
// ---------------------------------------------------------------------------
import * as configModule from '../../../config.js';
import * as brainRetrieval from '../../../memory/brain-retrieval.js';
import { handleSubagentStart, handleSubagentStop } from '../agent-hooks.js';
import { handlePostCompact, handlePreCompact } from '../context-hooks.js';
import * as bridgeRefresh from '../memory-bridge-refresh.js';
import { handleSystemNotification } from '../notification-hooks.js';
import { handleSessionEnd, handleSessionStart } from '../session-hooks.js';
import { handleToolComplete, handleToolStart } from '../task-hooks.js';
import { handleWorkPromptSubmit, handleWorkResponseComplete } from '../work-capture-hooks.js';
// Typed mock refs — assigned after imports resolve
const observeBrainMock = vi.mocked(brainRetrieval.observeBrain);
const loadConfigMock = vi.mocked(configModule.loadConfig);
const maybeRefreshMemoryBridgeMock = vi.mocked(bridgeRefresh.maybeRefreshMemoryBridge);
// ---------------------------------------------------------------------------
// Shared config factories
// ---------------------------------------------------------------------------
/** Returns a minimal CleoConfig with brain.autoCapture and brain.captureWork enabled. */
function makeConfig(overrides = {}) {
    return {
        brain: {
            autoCapture: overrides.autoCapture ?? true,
            captureWork: overrides.captureWork ?? false,
            captureFiles: overrides.captureFiles ?? false,
            captureMcp: overrides.captureMcp ?? false,
            memoryBridge: { autoRefresh: overrides.autoRefresh ?? false },
            embedding: { enabled: false, provider: 'local' },
            summarization: { enabled: false },
        },
    };
}
const PROJECT_ROOT = '/tmp/e2e-test-project';
const TIMESTAMP = '2026-03-24T00:00:00.000Z';
// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('hook automation E2E', () => {
    beforeEach(() => {
        observeBrainMock.mockReset().mockResolvedValue(undefined);
        loadConfigMock.mockReset().mockResolvedValue(makeConfig());
        maybeRefreshMemoryBridgeMock.mockReset().mockResolvedValue(undefined);
        // Clear work-capture env var
        delete process.env['CLEO_BRAIN_CAPTURE_WORK'];
        delete process.env['CLEO_BRAIN_CAPTURE_MCP'];
    });
    afterEach(() => {
        delete process.env['CLEO_BRAIN_CAPTURE_WORK'];
        delete process.env['CLEO_BRAIN_CAPTURE_MCP'];
    });
    // -------------------------------------------------------------------------
    // 1. SessionStart dispatches and brain handler fires (bridge refresh)
    // -------------------------------------------------------------------------
    describe('SessionStart', () => {
        it('fires brain observation on session start', async () => {
            await handleSessionStart(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                sessionId: 'ses-e2e-1',
                name: 'E2E Session',
                scope: 'T168',
                agent: 'claude-sonnet',
            });
            expect(observeBrainMock).toHaveBeenCalledTimes(1);
            expect(observeBrainMock).toHaveBeenCalledWith(PROJECT_ROOT, expect.objectContaining({
                title: 'Session start: E2E Session',
                type: 'discovery',
                sourceSessionId: 'ses-e2e-1',
                sourceType: 'agent',
            }));
        });
        it('triggers memory bridge refresh after session start', async () => {
            await handleSessionStart(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                sessionId: 'ses-e2e-refresh',
                name: 'Bridge Refresh Test',
                scope: 'global',
            });
            expect(maybeRefreshMemoryBridgeMock).toHaveBeenCalledWith(PROJECT_ROOT);
        });
    });
    // -------------------------------------------------------------------------
    // 2. SessionEnd dispatches and brain handler fires (summarization + bridge)
    // -------------------------------------------------------------------------
    describe('SessionEnd', () => {
        it('fires brain observation on session end', async () => {
            await handleSessionEnd(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                sessionId: 'ses-e2e-2',
                duration: 1800,
                tasksCompleted: ['T166', 'T168'],
            });
            expect(observeBrainMock).toHaveBeenCalledTimes(1);
            expect(observeBrainMock).toHaveBeenCalledWith(PROJECT_ROOT, expect.objectContaining({
                title: 'Session end: ses-e2e-2',
                type: 'change',
                sourceSessionId: 'ses-e2e-2',
                sourceType: 'agent',
            }));
        });
        it('includes task list in session end observation text', async () => {
            await handleSessionEnd(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                sessionId: 'ses-e2e-tasks',
                duration: 600,
                tasksCompleted: ['T100', 'T101'],
            });
            const callText = observeBrainMock.mock.calls[0][1].text;
            expect(callText).toContain('T100');
            expect(callText).toContain('T101');
        });
        it('triggers memory bridge refresh after session end', async () => {
            await handleSessionEnd(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                sessionId: 'ses-e2e-bridge',
                duration: 300,
                tasksCompleted: [],
            });
            expect(maybeRefreshMemoryBridgeMock).toHaveBeenCalledWith(PROJECT_ROOT);
        });
    });
    // -------------------------------------------------------------------------
    // 3. PreToolUse dispatches and brain handler fires (observation created)
    // -------------------------------------------------------------------------
    describe('PreToolUse', () => {
        it('fires brain observation when a tool starts', async () => {
            await handleToolStart(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                taskId: 'T168',
                taskTitle: 'E2E integration tests',
            });
            expect(observeBrainMock).toHaveBeenCalledTimes(1);
            expect(observeBrainMock).toHaveBeenCalledWith(PROJECT_ROOT, expect.objectContaining({
                text: 'Started work on T168: E2E integration tests',
                title: 'Task start: T168',
                type: 'change',
                sourceType: 'agent',
            }));
        });
    });
    // -------------------------------------------------------------------------
    // 4. PostToolUse dispatches and brain handler fires (completion observation)
    // -------------------------------------------------------------------------
    describe('PostToolUse', () => {
        it('fires brain observation when a tool completes', async () => {
            await handleToolComplete(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                taskId: 'T168',
                taskTitle: 'E2E integration tests',
                status: 'done',
            });
            expect(observeBrainMock).toHaveBeenCalledTimes(1);
            expect(observeBrainMock).toHaveBeenCalledWith(PROJECT_ROOT, expect.objectContaining({
                text: 'Task T168 completed with status: done',
                title: 'Task complete: T168',
                type: 'change',
                sourceType: 'agent',
            }));
        });
        it('triggers memory bridge refresh after tool completes', async () => {
            await handleToolComplete(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                taskId: 'T168',
                taskTitle: 'E2E integration tests',
                status: 'done',
            });
            expect(maybeRefreshMemoryBridgeMock).toHaveBeenCalledWith(PROJECT_ROOT);
        });
    });
    // -------------------------------------------------------------------------
    // 5. PromptSubmit dispatches for mutations only (work-capture filter)
    // -------------------------------------------------------------------------
    describe('PromptSubmit (work-capture)', () => {
        it('captures mutate operations in CAPTURE_OPERATIONS set', async () => {
            process.env['CLEO_BRAIN_CAPTURE_WORK'] = 'true';
            await handleWorkPromptSubmit(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                gateway: 'mutate',
                domain: 'tasks',
                operation: 'add',
                source: 'agent-alpha',
            });
            expect(observeBrainMock).toHaveBeenCalledTimes(1);
            expect(observeBrainMock).toHaveBeenCalledWith(PROJECT_ROOT, expect.objectContaining({
                title: 'Work intent: tasks.add',
                type: 'discovery',
                sourceType: 'agent',
            }));
        });
        // -----------------------------------------------------------------------
        // 6. PromptSubmit skips queries (smart filtering)
        // -----------------------------------------------------------------------
        it('skips query gateway operations', async () => {
            process.env['CLEO_BRAIN_CAPTURE_WORK'] = 'true';
            await handleWorkPromptSubmit(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                gateway: 'query',
                domain: 'tasks',
                operation: 'find',
            });
            expect(observeBrainMock).not.toHaveBeenCalled();
        });
        it('skips mutate operations NOT in CAPTURE_OPERATIONS (e.g. tasks.complete)', async () => {
            process.env['CLEO_BRAIN_CAPTURE_WORK'] = 'true';
            await handleWorkPromptSubmit(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                gateway: 'mutate',
                domain: 'tasks',
                operation: 'complete',
            });
            expect(observeBrainMock).not.toHaveBeenCalled();
        });
    });
    // -------------------------------------------------------------------------
    // 7. ResponseComplete dispatches for successes only
    // -------------------------------------------------------------------------
    describe('ResponseComplete (work-capture)', () => {
        it('captures successful mutate operations in CAPTURE_OPERATIONS', async () => {
            process.env['CLEO_BRAIN_CAPTURE_WORK'] = 'true';
            await handleWorkResponseComplete(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                gateway: 'mutate',
                domain: 'tasks',
                operation: 'add',
                success: true,
                durationMs: 42,
            });
            expect(observeBrainMock).toHaveBeenCalledTimes(1);
            expect(observeBrainMock).toHaveBeenCalledWith(PROJECT_ROOT, expect.objectContaining({
                title: 'Work done: tasks.add',
                type: 'change',
                sourceType: 'agent',
            }));
        });
        it('skips failed operations', async () => {
            process.env['CLEO_BRAIN_CAPTURE_WORK'] = 'true';
            await handleWorkResponseComplete(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                gateway: 'mutate',
                domain: 'tasks',
                operation: 'add',
                success: false,
            });
            expect(observeBrainMock).not.toHaveBeenCalled();
        });
    });
    // -------------------------------------------------------------------------
    // 8. SubagentStart creates brain observation
    // -------------------------------------------------------------------------
    describe('SubagentStart', () => {
        it('creates brain observation when subagent spawns', async () => {
            await handleSubagentStart(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                agentId: 'agent-worker-1',
                role: 'implementer',
                taskId: 'T166',
                sessionId: 'ses-e2e-1',
            });
            expect(observeBrainMock).toHaveBeenCalledTimes(1);
            expect(observeBrainMock).toHaveBeenCalledWith(PROJECT_ROOT, expect.objectContaining({
                title: 'Subagent start: agent-worker-1',
                type: 'discovery',
                sourceType: 'agent',
                sourceSessionId: 'ses-e2e-1',
            }));
            const callText = observeBrainMock.mock.calls[0][1].text;
            expect(callText).toContain('agent-worker-1');
            expect(callText).toContain('role=implementer');
            expect(callText).toContain('task=T166');
        });
        it('creates observation with minimal payload (no role or task)', async () => {
            await handleSubagentStart(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                agentId: 'agent-minimal',
            });
            expect(observeBrainMock).toHaveBeenCalledTimes(1);
            const callText = observeBrainMock.mock.calls[0][1].text;
            expect(callText).toContain('agent-minimal');
            expect(callText).not.toContain('role=');
            expect(callText).not.toContain('task=');
        });
        it('creates observation for SubagentStop with completion status', async () => {
            await handleSubagentStop(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                agentId: 'agent-worker-1',
                status: 'complete',
                taskId: 'T166',
                summary: 'All handlers wired',
                sessionId: 'ses-e2e-1',
            });
            expect(observeBrainMock).toHaveBeenCalledTimes(1);
            expect(observeBrainMock).toHaveBeenCalledWith(PROJECT_ROOT, expect.objectContaining({
                title: 'Subagent stop: agent-worker-1',
                type: 'change',
                sourceType: 'agent',
                sourceSessionId: 'ses-e2e-1',
            }));
            const callText = observeBrainMock.mock.calls[0][1].text;
            expect(callText).toContain('status=complete');
            expect(callText).toContain('task=T166');
            expect(callText).toContain('All handlers wired');
        });
    });
    // -------------------------------------------------------------------------
    // 9. PreCompact creates context snapshot observation
    // -------------------------------------------------------------------------
    describe('PreCompact', () => {
        it('creates context snapshot observation before compaction', async () => {
            await handlePreCompact(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                tokensBefore: 80000,
                reason: 'context-limit',
                sessionId: 'ses-e2e-1',
            });
            expect(observeBrainMock).toHaveBeenCalledTimes(1);
            expect(observeBrainMock).toHaveBeenCalledWith(PROJECT_ROOT, expect.objectContaining({
                title: 'Pre-compaction context snapshot',
                type: 'discovery',
                sourceType: 'agent',
                sourceSessionId: 'ses-e2e-1',
            }));
            const callText = observeBrainMock.mock.calls[0][1].text;
            expect(callText).toContain('80,000');
            expect(callText).toContain('context-limit');
        });
        it('creates PostCompact record after compaction', async () => {
            await handlePostCompact(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                tokensBefore: 80000,
                tokensAfter: 20000,
                success: true,
                sessionId: 'ses-e2e-1',
            });
            expect(observeBrainMock).toHaveBeenCalledTimes(1);
            expect(observeBrainMock).toHaveBeenCalledWith(PROJECT_ROOT, expect.objectContaining({
                title: 'Post-compaction record',
                type: 'change',
                sourceType: 'agent',
            }));
            const callText = observeBrainMock.mock.calls[0][1].text;
            expect(callText).toContain('succeeded');
            expect(callText).toContain('80,000');
            expect(callText).toContain('20,000');
        });
    });
    // -------------------------------------------------------------------------
    // 10. Config gating: handler skips when brain.autoCapture=false
    // -------------------------------------------------------------------------
    describe('config gating', () => {
        it('SubagentStart skips when brain.autoCapture=false', async () => {
            loadConfigMock.mockResolvedValue(makeConfig({ autoCapture: false }));
            await handleSubagentStart(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                agentId: 'agent-gated',
                role: 'tester',
            });
            expect(observeBrainMock).not.toHaveBeenCalled();
        });
        it('PreCompact skips when brain.autoCapture=false', async () => {
            loadConfigMock.mockResolvedValue(makeConfig({ autoCapture: false }));
            await handlePreCompact(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                tokensBefore: 50000,
            });
            expect(observeBrainMock).not.toHaveBeenCalled();
        });
        it('PostCompact skips when brain.autoCapture=false', async () => {
            loadConfigMock.mockResolvedValue(makeConfig({ autoCapture: false }));
            await handlePostCompact(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                success: true,
            });
            expect(observeBrainMock).not.toHaveBeenCalled();
        });
        it('SubagentStop skips when brain.autoCapture=false', async () => {
            loadConfigMock.mockResolvedValue(makeConfig({ autoCapture: false }));
            await handleSubagentStop(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                agentId: 'agent-gated',
                status: 'complete',
            });
            expect(observeBrainMock).not.toHaveBeenCalled();
        });
        it('work-capture skips when captureWork=false and env not set', async () => {
            // No env override + captureWork=false in config
            loadConfigMock.mockResolvedValue(makeConfig({ captureWork: false }));
            await handleWorkPromptSubmit(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                gateway: 'mutate',
                domain: 'tasks',
                operation: 'add',
            });
            expect(observeBrainMock).not.toHaveBeenCalled();
        });
    });
    // -------------------------------------------------------------------------
    // 11. Dedup: PostToolUse doesn't double-capture what session-hooks handles
    // -------------------------------------------------------------------------
    describe('dedup (no double-capture)', () => {
        it('PostToolUse and SessionEnd are separate calls — no overlap', async () => {
            // Simulate a session ending after a task completes
            await handleToolComplete(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                taskId: 'T168',
                taskTitle: 'E2E tests',
                status: 'done',
            });
            observeBrainMock.mockClear();
            await handleSessionEnd(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                sessionId: 'ses-dedup',
                duration: 300,
                tasksCompleted: ['T168'],
            });
            // Each handler fires exactly once — no double-capture for the same event
            expect(observeBrainMock).toHaveBeenCalledTimes(1);
            expect(observeBrainMock).toHaveBeenCalledWith(PROJECT_ROOT, expect.objectContaining({ title: 'Session end: ses-dedup' }));
        });
        it('work-capture and mcp-hooks register on same event but use different config keys', async () => {
            // work-capture is keyed on captureWork; mcp-hooks keyed on captureMcp
            // When both are disabled (default), neither fires
            await handleWorkPromptSubmit(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                gateway: 'mutate',
                domain: 'tasks',
                operation: 'add',
            });
            expect(observeBrainMock).not.toHaveBeenCalled();
        });
    });
    // -------------------------------------------------------------------------
    // 12. Notification — system notification captured as observation
    // -------------------------------------------------------------------------
    describe('Notification (system)', () => {
        it('captures message-bearing system notifications', async () => {
            await handleSystemNotification(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                message: 'CLEO session limit approaching (80% used)',
                sessionId: 'ses-e2e-1',
            });
            expect(observeBrainMock).toHaveBeenCalledTimes(1);
            expect(observeBrainMock).toHaveBeenCalledWith(PROJECT_ROOT, expect.objectContaining({
                type: 'discovery',
                sourceType: 'agent',
                sourceSessionId: 'ses-e2e-1',
            }));
            const callText = observeBrainMock.mock.calls[0][1].text;
            expect(callText).toContain('CLEO session limit approaching');
        });
        it('skips file-change notifications (handled by file-hooks)', async () => {
            await handleSystemNotification(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                filePath: 'src/core/tasks.ts',
                changeType: 'write',
                message: 'some extra message',
            });
            expect(observeBrainMock).not.toHaveBeenCalled();
        });
        it('skips notifications with no message and no filePath', async () => {
            await handleSystemNotification(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
            });
            expect(observeBrainMock).not.toHaveBeenCalled();
        });
        it('skips when brain.autoCapture=false', async () => {
            loadConfigMock.mockResolvedValue(makeConfig({ autoCapture: false }));
            await handleSystemNotification(PROJECT_ROOT, {
                timestamp: TIMESTAMP,
                message: 'Should be skipped',
            });
            expect(observeBrainMock).not.toHaveBeenCalled();
        });
    });
});
//# sourceMappingURL=hook-automation-e2e.test.js.map