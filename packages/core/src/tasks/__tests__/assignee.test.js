/**
 * Tests for tasks.assignee column: claimTask / unclaimTask (B.1).
 *
 * Covers:
 * - Claim sets assignee on a previously unclaimed task
 * - Claim is idempotent for the same agent
 * - Claim fails when task is already claimed by a different agent
 * - Unclaim clears the assignee
 * - Unclaim is a no-op on an already unclaimed task
 * - claimTask / unclaimTask throw on non-existent task IDs
 * - Assignee persists through rowToTask round-trip
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../store/__tests__/test-db-helper.js';
import { addTask } from '../add.js';
/** Minimal config that disables enforcement so tests run in isolation. */
const NO_ENFORCEMENT_CONFIG = JSON.stringify({
    lifecycle: { mode: 'off' },
    enforcement: {
        session: { requiredForMutate: false },
        acceptance: { mode: 'off' },
    },
    verification: { enabled: false },
});
describe('claimTask', () => {
    let env;
    let accessor;
    beforeEach(async () => {
        env = await createTestDb();
        accessor = env.accessor;
        await writeFile(join(env.cleoDir, 'config.json'), NO_ENFORCEMENT_CONFIG);
        // Seed a single task used by most tests
        await addTask({ title: 'Claim test task', description: 'Task for assignee tests' }, env.tempDir, accessor);
    });
    afterEach(async () => {
        await env.cleanup();
    });
    it('sets assignee on an unclaimed task', async () => {
        await accessor.claimTask('T001', 'agent-alpha');
        const task = await accessor.loadSingleTask('T001');
        expect(task?.assignee).toBe('agent-alpha');
    });
    it('is idempotent — same agent can claim again', async () => {
        await accessor.claimTask('T001', 'agent-alpha');
        // Second claim by same agent must not throw
        await expect(accessor.claimTask('T001', 'agent-alpha')).resolves.toBeUndefined();
        const task = await accessor.loadSingleTask('T001');
        expect(task?.assignee).toBe('agent-alpha');
    });
    it('throws when task is claimed by a different agent', async () => {
        await accessor.claimTask('T001', 'agent-alpha');
        await expect(accessor.claimTask('T001', 'agent-beta')).rejects.toThrow('already claimed');
    });
    it('throws when task does not exist', async () => {
        await expect(accessor.claimTask('T999', 'agent-alpha')).rejects.toThrow('not found');
    });
    it('persists assignee through round-trip load', async () => {
        await accessor.claimTask('T001', 'agent-round-trip');
        const loaded = await accessor.loadSingleTask('T001');
        expect(loaded?.assignee).toBe('agent-round-trip');
    });
});
describe('unclaimTask', () => {
    let env;
    let accessor;
    beforeEach(async () => {
        env = await createTestDb();
        accessor = env.accessor;
        await writeFile(join(env.cleoDir, 'config.json'), NO_ENFORCEMENT_CONFIG);
        await addTask({ title: 'Unclaim test task', description: 'Task for unclaim tests' }, env.tempDir, accessor);
    });
    afterEach(async () => {
        await env.cleanup();
    });
    it('clears assignee after a claim', async () => {
        await accessor.claimTask('T001', 'agent-alpha');
        await accessor.unclaimTask('T001');
        const task = await accessor.loadSingleTask('T001');
        expect(task?.assignee).toBeUndefined();
    });
    it('is a no-op on an already-unclaimed task', async () => {
        // Task was never claimed — unclaimTask should not throw
        await expect(accessor.unclaimTask('T001')).resolves.toBeUndefined();
        const task = await accessor.loadSingleTask('T001');
        expect(task?.assignee).toBeUndefined();
    });
    it('allows re-claim after unclaim', async () => {
        await accessor.claimTask('T001', 'agent-alpha');
        await accessor.unclaimTask('T001');
        // A different agent may now claim it
        await accessor.claimTask('T001', 'agent-beta');
        const task = await accessor.loadSingleTask('T001');
        expect(task?.assignee).toBe('agent-beta');
    });
    it('throws when task does not exist', async () => {
        await expect(accessor.unclaimTask('T999')).rejects.toThrow('not found');
    });
});
describe('assignee updateTaskFields integration', () => {
    let env;
    let accessor;
    beforeEach(async () => {
        env = await createTestDb();
        accessor = env.accessor;
        await writeFile(join(env.cleoDir, 'config.json'), NO_ENFORCEMENT_CONFIG);
        await addTask({ title: 'Update fields test', description: 'Task for updateTaskFields test' }, env.tempDir, accessor);
    });
    afterEach(async () => {
        await env.cleanup();
    });
    it('can set assignee via updateTaskFields', async () => {
        await accessor.updateTaskFields('T001', { assignee: 'agent-via-update' });
        const task = await accessor.loadSingleTask('T001');
        expect(task?.assignee).toBe('agent-via-update');
    });
    it('can clear assignee via updateTaskFields', async () => {
        await accessor.updateTaskFields('T001', { assignee: 'agent-via-update' });
        await accessor.updateTaskFields('T001', { assignee: null });
        const task = await accessor.loadSingleTask('T001');
        expect(task?.assignee).toBeUndefined();
    });
});
//# sourceMappingURL=assignee.test.js.map