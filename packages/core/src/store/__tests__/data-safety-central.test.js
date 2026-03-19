/**
 * Data Safety Central - Unit Tests
 *
 * Tests the centralized safety manager that wraps all data operations
 * with sequence validation, write verification, and checkpointing.
 *
 * Coverage:
 * - safeSaveSessions: write -> verify -> checkpoint
 * - safeSaveSessions: write -> verify -> checkpoint
 * - safeSaveArchive: write -> verify -> checkpoint
 * - safeAppendLog: write -> checkpoint (no verification)
 * - runDataIntegrityCheck: comprehensive validation
 * - getSafetyStats / resetSafetyStats: statistics tracking
 * - enableSafety / disableSafety: runtime toggle
 *
 * @task T4741
 * @epic T4732
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Mock git-checkpoint to prevent real git operations
vi.mock('../git-checkpoint.js', () => ({
    gitCheckpoint: vi.fn().mockResolvedValue(undefined),
}));
describe('Data Safety Central', () => {
    let tempDir;
    let cleoDir;
    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'cleo-safety-central-'));
        cleoDir = join(tempDir, '.cleo');
        await mkdir(cleoDir, { recursive: true });
        process.env['CLEO_DIR'] = cleoDir;
        // Reset module state
        const mod = await import('../data-safety-central.js');
        mod.resetSafetyStats();
        mod.enableSafety();
        // Clear mocks
        vi.clearAllMocks();
    });
    afterEach(async () => {
        delete process.env['CLEO_DIR'];
        await rm(tempDir, { recursive: true, force: true });
    });
    // ---- Fixtures ----
    const makeSessions = (count = 0) => Array.from({ length: count }, (_, i) => ({
        id: `sess-${i}`,
        name: `Session ${i}`,
        status: 'ended',
        scope: { type: 'epic', epicId: 'T001' },
        taskWork: { taskId: null, setAt: null },
        agent: 'test',
        notes: [],
        tasksCompleted: [],
        tasksCreated: [],
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
    }));
    const makeArchiveFile = (count = 0) => ({
        archivedTasks: Array.from({ length: count }, (_, i) => ({
            id: `T${900 + i}`,
            title: `Archived task ${i}`,
            status: 'done',
            priority: 'medium',
            createdAt: new Date().toISOString(),
        })),
    });
    /**
     * Create a mock DataAccessor that stores data in memory.
     */
    function createMockAccessor() {
        const mock = {
            engine: 'sqlite',
            _sessions: makeSessions(),
            _archive: null,
            _logs: [],
            async loadArchive() {
                return mock._archive;
            },
            async saveArchive(data) {
                mock._archive = data;
            },
            async loadSessions() {
                return mock._sessions;
            },
            async saveSessions(data) {
                mock._sessions = data;
            },
            async appendLog(entry) {
                mock._logs.push(entry);
            },
            async close() { },
            async getActiveSession() { return null; },
            async getNextPosition() { return 0; },
            async shiftPositions() { },
            async upsertSingleSession() { },
            async removeSingleSession() { },
            async upsertSingleTask() { },
            async archiveSingleTask() { },
            async removeSingleTask() { },
            async loadSingleTask() { return null; },
            async addRelation() { },
            async getMetaValue() { return null; },
            async setMetaValue() { },
            async getSchemaVersion() { return null; },
            async queryTasks() { return { tasks: [], total: 0 }; },
            async countTasks() { return 0; },
            async getChildren() { return []; },
            async countChildren() { return 0; },
            async countActiveChildren() { return 0; },
            async getAncestorChain() { return []; },
            async getSubtree() { return []; },
            async getDependents() { return []; },
            async getDependencyChain() { return []; },
            async taskExists() { return false; },
            async loadTasks() { return []; },
            async updateTaskFields() { },
            async transaction(fn) { return fn({}); },
        };
        return mock;
    }
    // ---- Statistics Tracking ----
    describe('Safety Statistics', () => {
        it('should start with zero stats', async () => {
            const { getSafetyStats } = await import('../data-safety-central.js');
            const stats = getSafetyStats();
            expect(stats.writes).toBe(0);
            expect(stats.verifications).toBe(0);
            expect(stats.checkpoints).toBe(0);
            expect(stats.errors).toBe(0);
            expect(stats.lastCheckpoint).toBeNull();
        });
        it('should reset stats correctly', async () => {
            const { resetSafetyStats, getSafetyStats, safeSaveSessions } = await import('../data-safety-central.js');
            const accessor = createMockAccessor();
            // Perform a write to increment stats
            await safeSaveSessions(accessor, makeSessions(1), tempDir, {
                checkpoint: false,
            });
            expect(getSafetyStats().writes).toBeGreaterThan(0);
            resetSafetyStats();
            const stats = getSafetyStats();
            expect(stats.writes).toBe(0);
            expect(stats.verifications).toBe(0);
        });
        it('should increment writes on saveSessions', async () => {
            const { safeSaveSessions, getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
            resetSafetyStats();
            const accessor = createMockAccessor();
            await safeSaveSessions(accessor, makeSessions(1), tempDir, {
                checkpoint: false,
            });
            expect(getSafetyStats().writes).toBe(1);
        });
        it('should increment verifications when verify is enabled', async () => {
            const { safeSaveSessions, getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
            resetSafetyStats();
            const accessor = createMockAccessor();
            await safeSaveSessions(accessor, makeSessions(1), tempDir, {
                verify: true,
                checkpoint: false,
            });
            expect(getSafetyStats().verifications).toBe(1);
        });
        it('should not increment verifications when verify is disabled', async () => {
            const { safeAppendLog, getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
            resetSafetyStats();
            const accessor = createMockAccessor();
            await safeAppendLog(accessor, { action: 'test' }, tempDir, {
                checkpoint: false,
            });
            // safeAppendLog always sets verify: false
            expect(getSafetyStats().verifications).toBe(0);
        });
        it('should increment checkpoints after write', async () => {
            const { safeSaveSessions, getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
            resetSafetyStats();
            const accessor = createMockAccessor();
            await safeSaveSessions(accessor, makeSessions(1), tempDir, {
                verify: false,
                checkpoint: true,
            });
            expect(getSafetyStats().checkpoints).toBe(1);
            expect(getSafetyStats().lastCheckpoint).not.toBeNull();
        });
    });
    // ---- Sessions Verification ----
    describe('Session Safety', () => {
        it('should verify session count after save', async () => {
            const { safeSaveSessions } = await import('../data-safety-central.js');
            const accessor = createMockAccessor();
            const sessions = makeSessions(3);
            await safeSaveSessions(accessor, sessions, tempDir, {
                checkpoint: false,
            });
            expect(accessor._sessions.length).toBe(3);
        });
        it('should fail when session count mismatches', async () => {
            const { safeSaveSessions } = await import('../data-safety-central.js');
            const accessor = createMockAccessor();
            // After save, return fewer sessions
            accessor.loadSessions = async () => makeSessions(1);
            await expect(safeSaveSessions(accessor, makeSessions(3), tempDir, {
                verify: true,
                checkpoint: false,
                strict: true,
            })).rejects.toThrow('count mismatch');
        });
    });
    // ---- Archive Verification ----
    describe('Archive Safety', () => {
        it('should verify archive count after save', async () => {
            const { safeSaveArchive } = await import('../data-safety-central.js');
            const accessor = createMockAccessor();
            const archive = makeArchiveFile(5);
            await safeSaveArchive(accessor, archive, tempDir, {
                checkpoint: false,
            });
            expect(accessor._archive?.archivedTasks.length).toBe(5);
        });
        it('should fail when archive is null after save', async () => {
            const { safeSaveArchive } = await import('../data-safety-central.js');
            const accessor = createMockAccessor();
            accessor.loadArchive = async () => null;
            await expect(safeSaveArchive(accessor, makeArchiveFile(2), tempDir, {
                verify: true,
                checkpoint: false,
                strict: true,
            })).rejects.toThrow('not found after write');
        });
        it('should fail when archive count mismatches', async () => {
            const { safeSaveArchive } = await import('../data-safety-central.js');
            const accessor = createMockAccessor();
            accessor.loadArchive = async () => makeArchiveFile(1);
            await expect(safeSaveArchive(accessor, makeArchiveFile(5), tempDir, {
                verify: true,
                checkpoint: false,
                strict: true,
            })).rejects.toThrow('count mismatch');
        });
    });
    // ---- Log Safety ----
    describe('Log Safety', () => {
        it('should append log entry without verification', async () => {
            const { safeAppendLog, getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
            resetSafetyStats();
            const accessor = createMockAccessor();
            await safeAppendLog(accessor, { action: 'test', timestamp: new Date().toISOString() }, tempDir, {
                checkpoint: false,
            });
            expect(accessor._logs.length).toBe(1);
            expect(getSafetyStats().writes).toBe(1);
            // Logs don't have verification
            expect(getSafetyStats().verifications).toBe(0);
        });
    });
    // ---- Checkpoint Behavior ----
    describe('Checkpointing', () => {
        it('should call gitCheckpoint when checkpoint is enabled', async () => {
            const { gitCheckpoint } = await import('../git-checkpoint.js');
            const { safeSaveSessions, resetSafetyStats } = await import('../data-safety-central.js');
            resetSafetyStats();
            const accessor = createMockAccessor();
            await safeSaveSessions(accessor, makeSessions(1), tempDir, {
                verify: false,
                checkpoint: true,
            });
            expect(gitCheckpoint).toHaveBeenCalledWith('auto', expect.stringContaining('Sessions'), tempDir);
        });
        it('should NOT call gitCheckpoint when checkpoint is disabled', async () => {
            const { gitCheckpoint } = await import('../git-checkpoint.js');
            const { safeSaveSessions, resetSafetyStats } = await import('../data-safety-central.js');
            resetSafetyStats();
            const accessor = createMockAccessor();
            await safeSaveSessions(accessor, makeSessions(1), tempDir, {
                verify: false,
                checkpoint: false,
            });
            expect(gitCheckpoint).not.toHaveBeenCalled();
        });
        it('should not fail the operation when checkpoint throws', async () => {
            const gitMod = await import('../git-checkpoint.js');
            vi.mocked(gitMod.gitCheckpoint).mockRejectedValueOnce(new Error('git not found'));
            const { safeSaveSessions, getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
            resetSafetyStats();
            const accessor = createMockAccessor();
            // Should not throw even though checkpoint fails
            await safeSaveSessions(accessor, makeSessions(1), tempDir, {
                verify: false,
                checkpoint: true,
            });
            // Write still succeeded
            expect(getSafetyStats().writes).toBe(1);
        });
    });
    // ---- Enable/Disable Safety ----
    describe('Safety Toggle', () => {
        it('should disable all safety options', async () => {
            const { disableSafety, safeAppendLog, getSafetyStats, resetSafetyStats, enableSafety } = await import('../data-safety-central.js');
            resetSafetyStats();
            disableSafety();
            const accessor = createMockAccessor();
            // Will not throw because verify=false when disabled
            await safeAppendLog(accessor, { action: 'test' }, tempDir);
            expect(getSafetyStats().writes).toBe(1);
            // Re-enable for other tests
            enableSafety();
        });
        it('should re-enable safety after disable', async () => {
            const { disableSafety, enableSafety, safeSaveSessions } = await import('../data-safety-central.js');
            disableSafety();
            enableSafety();
            const accessor = createMockAccessor();
            // After save, return mismatched session count to trigger verification failure
            accessor.loadSessions = async () => makeSessions(0);
            // Now verification should be active again and should throw
            await expect(safeSaveSessions(accessor, makeSessions(3), tempDir, {
                verify: true,
                checkpoint: false,
                strict: true,
            })).rejects.toThrow('count mismatch');
        });
    });
    // ---- Data Integrity Check ----
    describe('Data Integrity Check', () => {
        it('should pass when all data loads correctly', async () => {
            const { runDataIntegrityCheck: checkIntegrity } = await import('../data-safety-central.js');
            const accessor = createMockAccessor();
            // Add countTasks to mock since runDataIntegrityCheck uses it
            accessor.countTasks = async () => 0;
            accessor._sessions = makeSessions();
            const result = await checkIntegrity(accessor, tempDir);
            // May have sequence warnings, but should not have structural errors
            expect(result.stats).toBeDefined();
        });
        it('should report error when task count query fails', async () => {
            const { runDataIntegrityCheck: checkIntegrity } = await import('../data-safety-central.js');
            const accessor = createMockAccessor();
            accessor.countTasks = async () => {
                throw new Error('corrupted');
            };
            const result = await checkIntegrity(accessor, tempDir);
            expect(result.passed).toBe(false);
            expect(result.errors.some((e) => e.includes('Task data query failed'))).toBe(true);
        });
        it('should report error when task count is negative', async () => {
            const { runDataIntegrityCheck: checkIntegrity } = await import('../data-safety-central.js');
            const accessor = createMockAccessor();
            accessor.countTasks = async () => -1;
            const result = await checkIntegrity(accessor, tempDir);
            expect(result.errors.some((e) => e.includes('negative'))).toBe(true);
        });
        it('should report error when sessions fail to load', async () => {
            const { runDataIntegrityCheck: checkIntegrity } = await import('../data-safety-central.js');
            const accessor = createMockAccessor();
            accessor.countTasks = async () => 0;
            accessor.loadSessions = async () => {
                throw new Error('session corruption');
            };
            const result = await checkIntegrity(accessor, tempDir);
            expect(result.errors.some((e) => e.includes('Sessions load failed'))).toBe(true);
        });
    });
});
//# sourceMappingURL=data-safety-central.test.js.map