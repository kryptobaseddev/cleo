/**
 * SafetyDataAccessor Integration Tests
 *
 * Tests the factory-level safety wrapper that wraps all DataAccessor
 * implementations with mandatory safety checks.
 *
 * Key tests:
 * - Factory always wraps with safety
 * - CLEO_DISABLE_SAFETY bypasses wrapping
 * - Read operations pass through without overhead
 * - Write operations trigger full safety pipeline
 * - Safety status reporting
 *
 * @task T4741
 * @epic T4732
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Mock git-checkpoint
vi.mock('../git-checkpoint.js', () => ({
    gitCheckpoint: vi.fn().mockResolvedValue(undefined),
}));
describe('SafetyDataAccessor', () => {
    let tempDir;
    let cleoDir;
    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'cleo-safety-accessor-'));
        cleoDir = join(tempDir, '.cleo');
        await mkdir(cleoDir, { recursive: true });
        process.env['CLEO_DIR'] = cleoDir;
        delete process.env['CLEO_DISABLE_SAFETY'];
        vi.clearAllMocks();
    });
    afterEach(async () => {
        delete process.env['CLEO_DIR'];
        delete process.env['CLEO_DISABLE_SAFETY'];
        await rm(tempDir, { recursive: true, force: true });
    });
    // ---- Fixtures ----
    function createMockAccessor() {
        const data = {
            sessions: [],
            archive: null,
        };
        return {
            engine: 'sqlite',
            async loadArchive() {
                return data.archive;
            },
            async saveArchive(d) {
                data.archive = d;
            },
            async loadSessions() {
                return data.sessions;
            },
            async saveSessions(d) {
                data.sessions = d;
            },
            async appendLog() { },
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
    }
    // ---- Factory Wrapping ----
    describe('Factory Integration', () => {
        it('should wrap accessor with safety by default', async () => {
            const { wrapWithSafety, isSafetyEnabled } = await import('../safety-data-accessor.js');
            const inner = createMockAccessor();
            const wrapped = wrapWithSafety(inner, tempDir);
            expect(isSafetyEnabled()).toBe(true);
            // Wrapped accessor should have same engine property
            expect(wrapped.engine).toBe('sqlite');
        });
        it('should bypass safety when CLEO_DISABLE_SAFETY=true', async () => {
            process.env['CLEO_DISABLE_SAFETY'] = 'true';
            const { wrapWithSafety, isSafetyEnabled } = await import('../safety-data-accessor.js');
            const inner = createMockAccessor();
            const wrapped = wrapWithSafety(inner, tempDir);
            expect(isSafetyEnabled()).toBe(false);
            // Should return the inner accessor unwrapped
            expect(wrapped).toBe(inner);
        });
    });
    // ---- Safety Status ----
    describe('Safety Status', () => {
        it('should report enabled when no env var set', async () => {
            const { getSafetyStatus } = await import('../safety-data-accessor.js');
            const status = getSafetyStatus();
            expect(status.enabled).toBe(true);
            expect(status.reason).toBeUndefined();
        });
        it('should report disabled with reason when env var set', async () => {
            process.env['CLEO_DISABLE_SAFETY'] = 'true';
            const { getSafetyStatus } = await import('../safety-data-accessor.js');
            const status = getSafetyStatus();
            expect(status.enabled).toBe(false);
            expect(status.reason).toContain('CLEO_DISABLE_SAFETY');
        });
    });
    // ---- Read Pass-Through ----
    describe('Read Operations', () => {
        it('should pass through loadSessions without modification', async () => {
            const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
            const inner = createMockAccessor();
            const wrapped = new SafetyDataAccessor(inner, tempDir);
            const result = await wrapped.loadSessions();
            expect(result).toEqual([]);
        });
        it('should pass through loadArchive without modification', async () => {
            const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
            const inner = createMockAccessor();
            const wrapped = new SafetyDataAccessor(inner, tempDir);
            const result = await wrapped.loadArchive();
            expect(result).toBeNull();
        });
    });
    // ---- Write Operations with Safety ----
    describe('Write Operations', () => {
        it('should trigger safety pipeline on saveSessions', async () => {
            const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
            const { getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
            resetSafetyStats();
            const inner = createMockAccessor();
            const wrapped = new SafetyDataAccessor(inner, tempDir, { enabled: true });
            await wrapped.saveSessions([]);
            expect(getSafetyStats().writes).toBeGreaterThan(0);
        });
        it('should trigger safety pipeline on saveArchive', async () => {
            const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
            const { getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
            resetSafetyStats();
            const inner = createMockAccessor();
            // Need archive to be loadable for verification
            const archiveData = { archivedTasks: [] };
            inner.loadArchive = async () => archiveData;
            const wrapped = new SafetyDataAccessor(inner, tempDir, { enabled: true });
            await wrapped.saveArchive(archiveData);
            expect(getSafetyStats().writes).toBeGreaterThan(0);
        });
        it('should delegate close to inner accessor', async () => {
            const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
            const inner = createMockAccessor();
            const closeSpy = vi.spyOn(inner, 'close');
            const wrapped = new SafetyDataAccessor(inner, tempDir);
            await wrapped.close();
            expect(closeSpy).toHaveBeenCalledOnce();
        });
    });
});
//# sourceMappingURL=safety-accessor.test.js.map