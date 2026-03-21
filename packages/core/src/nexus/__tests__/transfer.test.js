/**
 * Tests for NEXUS cross-project task transfer.
 *
 * @task T046, T055
 * @epic T4540
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLinksByTaskId } from '../../reconciliation/link-store.js';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { nexusInit, nexusRegister, resetNexusDbState } from '../registry.js';
import { executeTransfer, previewTransfer } from '../transfer.js';
/** Create a test project with tasks in SQLite (tasks.db). */
async function createTestProjectDb(dir, tasks) {
    await mkdir(join(dir, '.cleo'), { recursive: true });
    resetDbState();
    const accessor = await createSqliteDataAccessor(dir);
    await seedTasks(accessor, tasks);
    await accessor.close();
    resetDbState();
}
let testDir;
let registryDir;
let sourceDir;
let targetDir;
beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'nexus-transfer-test-'));
    registryDir = join(testDir, 'cleo-home');
    sourceDir = join(testDir, 'source-project');
    targetDir = join(testDir, 'target-project');
    await mkdir(registryDir, { recursive: true });
    // Create source project with a task hierarchy
    await createTestProjectDb(sourceDir, [
        { id: 'T001', title: 'Epic: Auth', type: 'epic', status: 'active' },
        {
            id: 'T002',
            title: 'Login form',
            parentId: 'T001',
            status: 'pending',
            description: 'Build login',
        },
        {
            id: 'T003',
            title: 'JWT tokens',
            parentId: 'T001',
            depends: ['T002'],
            status: 'pending',
        },
        { id: 'T004', title: 'Unrelated task', status: 'done' },
    ]);
    // Create empty target project
    await createTestProjectDb(targetDir, []);
    // Point env vars to test dirs
    process.env['CLEO_HOME'] = registryDir;
    process.env['NEXUS_HOME'] = join(registryDir, 'nexus');
    process.env['NEXUS_CACHE_DIR'] = join(registryDir, 'nexus', 'cache');
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    resetNexusDbState();
    // Register both projects
    await nexusInit();
    await nexusRegister(sourceDir, 'source-project', 'read');
    resetDbState();
    await nexusRegister(targetDir, 'target-project', 'write');
    resetDbState();
});
afterEach(async () => {
    delete process.env['CLEO_HOME'];
    delete process.env['NEXUS_HOME'];
    delete process.env['NEXUS_CACHE_DIR'];
    delete process.env['NEXUS_SKIP_PERMISSION_CHECK'];
    resetNexusDbState();
    resetDbState();
    await rm(testDir, { recursive: true, force: true });
});
describe('previewTransfer', () => {
    it('returns a dry-run result without writing', async () => {
        const result = await previewTransfer({
            taskIds: ['T001'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            scope: 'subtree',
        });
        expect(result.dryRun).toBe(true);
        expect(result.transferred).toBe(3); // T001 + T002 + T003
        expect(result.manifest.sourceProject).toBe('source-project');
        expect(result.manifest.targetProject).toBe('target-project');
        expect(result.manifest.entries).toHaveLength(3);
        // Verify nothing was written to target
        resetDbState();
        const accessor = await createSqliteDataAccessor(targetDir);
        const { tasks } = await accessor.queryTasks({});
        expect(tasks).toHaveLength(0);
        await accessor.close();
    });
    it('returns single-task preview when scope is single', async () => {
        const result = await previewTransfer({
            taskIds: ['T001'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            scope: 'single',
        });
        expect(result.dryRun).toBe(true);
        expect(result.transferred).toBe(1);
        expect(result.manifest.entries).toHaveLength(1);
        expect(result.manifest.entries[0].sourceId).toBe('T001');
    });
});
describe('executeTransfer - copy mode', () => {
    it('copies a subtree to the target project', async () => {
        const result = await executeTransfer({
            taskIds: ['T001'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            mode: 'copy',
            scope: 'subtree',
        });
        expect(result.dryRun).toBe(false);
        expect(result.transferred).toBe(3);
        expect(result.skipped).toBe(0);
        expect(result.archived).toBe(0);
        expect(result.manifest.mode).toBe('copy');
        // Verify tasks exist in target
        resetDbState();
        const targetAccessor = await createSqliteDataAccessor(targetDir);
        const { tasks: targetTasks } = await targetAccessor.queryTasks({});
        expect(targetTasks).toHaveLength(3);
        await targetAccessor.close();
        // Verify source tasks still exist (not archived)
        resetDbState();
        const sourceAccessor = await createSqliteDataAccessor(sourceDir);
        const { tasks: sourceTasks } = await sourceAccessor.queryTasks({});
        expect(sourceTasks).toHaveLength(4); // all 4 original tasks
        await sourceAccessor.close();
    });
    it('remaps task IDs in the target', async () => {
        // Seed target with a task so IDs don't accidentally collide
        resetDbState();
        const accessor = await createSqliteDataAccessor(targetDir);
        await seedTasks(accessor, [{ id: 'T010', title: 'Existing target task', status: 'pending' }]);
        await accessor.close();
        resetDbState();
        const result = await executeTransfer({
            taskIds: ['T001'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            scope: 'subtree',
            onConflict: 'rename',
        });
        expect(Object.keys(result.manifest.idRemap).length).toBeGreaterThan(0);
        // All target IDs should be different from source IDs since target has T010
        for (const entry of result.manifest.entries) {
            expect(entry.targetId).not.toBe(entry.sourceId);
        }
    });
    it('preserves parent-child hierarchy in target', async () => {
        const result = await executeTransfer({
            taskIds: ['T001'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            scope: 'subtree',
        });
        resetDbState();
        const accessor = await createSqliteDataAccessor(targetDir);
        const { tasks } = await accessor.queryTasks({});
        const epicId = result.manifest.idRemap['T001'];
        const loginId = result.manifest.idRemap['T002'];
        const jwtId = result.manifest.idRemap['T003'];
        const loginTask = tasks.find((t) => t.id === loginId);
        const jwtTask = tasks.find((t) => t.id === jwtId);
        expect(loginTask?.parentId).toBe(epicId);
        expect(jwtTask?.parentId).toBe(epicId);
        await accessor.close();
    });
    it('preserves dependencies in target', async () => {
        const result = await executeTransfer({
            taskIds: ['T001'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            scope: 'subtree',
        });
        resetDbState();
        const accessor = await createSqliteDataAccessor(targetDir);
        const { tasks } = await accessor.queryTasks({});
        const loginId = result.manifest.idRemap['T002'];
        const jwtId = result.manifest.idRemap['T003'];
        const jwtTask = tasks.find((t) => t.id === jwtId);
        expect(jwtTask?.depends).toContain(loginId);
        await accessor.close();
    });
    it('adds provenance notes by default', async () => {
        const result = await executeTransfer({
            taskIds: ['T001'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            scope: 'single',
        });
        resetDbState();
        const accessor = await createSqliteDataAccessor(targetDir);
        const { tasks } = await accessor.queryTasks({});
        const epicId = result.manifest.idRemap['T001'];
        const task = tasks.find((t) => t.id === epicId);
        expect(task?.notes?.some((n) => n.includes('Imported from source-project'))).toBe(true);
        await accessor.close();
    });
    it('creates bidirectional external links', async () => {
        const result = await executeTransfer({
            taskIds: ['T004'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            scope: 'single',
        });
        expect(result.linksCreated).toBe(2); // one in each project
        // Check target link
        resetDbState();
        const targetId = result.manifest.idRemap['T004'];
        const targetLinks = await getLinksByTaskId(targetId, targetDir);
        expect(targetLinks).toHaveLength(1);
        expect(targetLinks[0].providerId).toBe('nexus:source-project');
        expect(targetLinks[0].externalId).toBe('T004');
        expect(targetLinks[0].linkType).toBe('transferred');
        expect(targetLinks[0].syncDirection).toBe('inbound');
        // Check source link
        resetDbState();
        const sourceLinks = await getLinksByTaskId('T004', sourceDir);
        expect(sourceLinks).toHaveLength(1);
        expect(sourceLinks[0].providerId).toBe('nexus:target-project');
        expect(sourceLinks[0].externalId).toBe(targetId);
        expect(sourceLinks[0].linkType).toBe('transferred');
        expect(sourceLinks[0].syncDirection).toBe('outbound');
    });
    it('transfers a single task without descendants', async () => {
        const result = await executeTransfer({
            taskIds: ['T004'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            scope: 'single',
        });
        expect(result.transferred).toBe(1);
        expect(result.manifest.entries).toHaveLength(1);
        expect(result.manifest.entries[0].sourceId).toBe('T004');
    });
});
describe('executeTransfer - move mode', () => {
    it('archives source tasks after transfer', async () => {
        const result = await executeTransfer({
            taskIds: ['T004'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            mode: 'move',
            scope: 'single',
        });
        expect(result.transferred).toBe(1);
        expect(result.archived).toBe(1);
        expect(result.manifest.mode).toBe('move');
        // Source task should be archived (queryTasks excludes archived by default)
        resetDbState();
        const sourceAccessor = await createSqliteDataAccessor(sourceDir);
        const { tasks: sourceTasks } = await sourceAccessor.queryTasks({
            status: 'archived',
        });
        const archivedTask = sourceTasks.find((t) => t.id === 'T004');
        expect(archivedTask?.status).toBe('archived');
        await sourceAccessor.close();
    });
});
describe('executeTransfer - error handling', () => {
    it('throws when source project not found', async () => {
        await expect(executeTransfer({
            taskIds: ['T001'],
            sourceProject: 'nonexistent',
            targetProject: 'target-project',
        })).rejects.toThrow('Source project not found');
    });
    it('throws when target project not found', async () => {
        await expect(executeTransfer({
            taskIds: ['T001'],
            sourceProject: 'source-project',
            targetProject: 'nonexistent',
        })).rejects.toThrow('Target project not found');
    });
    it('throws when source and target are the same', async () => {
        await expect(executeTransfer({
            taskIds: ['T001'],
            sourceProject: 'source-project',
            targetProject: 'source-project',
        })).rejects.toThrow('Source and target projects must be different');
    });
    it('throws when task not found in source', async () => {
        await expect(executeTransfer({
            taskIds: ['T999'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
        })).rejects.toThrow('Task not found in source project: T999');
    });
    it('throws when no task IDs specified', async () => {
        await expect(executeTransfer({
            taskIds: [],
            sourceProject: 'source-project',
            targetProject: 'target-project',
        })).rejects.toThrow('No task IDs specified');
    });
});
describe('executeTransfer - conflict resolution', () => {
    it('renames tasks with duplicate titles by default', async () => {
        // Create a task in target with the same title as source
        resetDbState();
        const accessor = await createSqliteDataAccessor(targetDir);
        await seedTasks(accessor, [{ id: 'T001', title: 'Unrelated task', status: 'pending' }]);
        await accessor.close();
        resetDbState();
        const result = await executeTransfer({
            taskIds: ['T004'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            scope: 'single',
            onConflict: 'rename',
        });
        expect(result.transferred).toBe(1);
        resetDbState();
        const targetAccessor = await createSqliteDataAccessor(targetDir);
        const { tasks: targetTasks } = await targetAccessor.queryTasks({});
        const transferredTask = targetTasks.find((t) => t.id === result.manifest.idRemap['T004']);
        expect(transferredTask?.title).toContain('imported');
        await targetAccessor.close();
    });
    it('skips tasks with duplicate titles when onConflict=skip', async () => {
        resetDbState();
        const accessor = await createSqliteDataAccessor(targetDir);
        await seedTasks(accessor, [{ id: 'T001', title: 'Unrelated task', status: 'pending' }]);
        await accessor.close();
        resetDbState();
        const result = await executeTransfer({
            taskIds: ['T004'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            scope: 'single',
            onConflict: 'skip',
        });
        expect(result.skipped).toBe(1);
        expect(result.transferred).toBe(0);
    });
});
describe('executeTransfer - multiple tasks', () => {
    it('transfers multiple independent tasks', async () => {
        const result = await executeTransfer({
            taskIds: ['T001', 'T004'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            scope: 'single',
        });
        expect(result.transferred).toBe(2);
        expect(result.manifest.entries).toHaveLength(2);
    });
    it('deduplicates tasks when subtree overlaps', async () => {
        // T001 subtree includes T002 and T003
        // Requesting T001 and T002 should not duplicate T002
        const result = await executeTransfer({
            taskIds: ['T001', 'T002'],
            sourceProject: 'source-project',
            targetProject: 'target-project',
            scope: 'subtree',
        });
        // T001 subtree is T001, T002, T003. T002 subtree is just T002.
        // Merged = T001, T002, T003 (deduped)
        expect(result.transferred).toBe(3);
    });
});
//# sourceMappingURL=transfer.test.js.map