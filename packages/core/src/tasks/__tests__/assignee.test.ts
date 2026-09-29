/**
 * Tests for the tasks.assignee column (B.1) and its separation from the
 * agent claim lease (T12502 AC3).
 *
 * Covers:
 * - claimTask / unclaimTask write the lease columns, never `assignee`
 * - claimTask / unclaimTask throw on non-existent task IDs
 * - Assignee is set and cleared through updateTaskFields
 *
 * Lease semantics (holders, expiry, take-over, release) live in
 * `task-work/__tests__/task-claims.test.ts`.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
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

describe('agent claim is separate from the human assignee (T12502 AC3)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await writeFile(join(env.cleoDir, 'config.json'), NO_ENFORCEMENT_CONFIG);
    await addTask(
      {
        title: 'Claim test task',
        description: 'Task for assignee tests',
        skipContainmentInvariant: true,
      },
      env.tempDir,
      accessor,
    );
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('claimTask records a lease and never writes assignee', async () => {
    await accessor.updateTaskFields('T001', { assignee: 'owner-human' });
    const claim = await accessor.claimTask('T001', {
      sessionId: 'ses-alpha',
      agentId: 'agent-alpha',
      mode: 'acquire',
    });
    expect(claim).toMatchObject({ sessionId: 'ses-alpha', agentId: 'agent-alpha' });
    const task = await accessor.loadSingleTask('T001');
    expect(task?.assignee).toBe('owner-human');
    expect(task?.claim?.agentId).toBe('agent-alpha');
  });

  it('unclaimTask clears the lease and never clears assignee', async () => {
    await accessor.updateTaskFields('T001', { assignee: 'owner-human' });
    await accessor.claimTask('T001', { sessionId: 'ses-alpha', agentId: null, mode: 'acquire' });
    expect(await accessor.unclaimTask('T001', { sessionId: 'ses-alpha' })).toBe(true);
    const task = await accessor.loadSingleTask('T001');
    expect(task?.claim).toBeUndefined();
    expect(task?.assignee).toBe('owner-human');
    expect(await accessor.unclaimTask('T001', { sessionId: 'ses-alpha' })).toBe(false);
  });

  it('claimTask / unclaimTask throw on non-existent task IDs', async () => {
    await expect(
      accessor.claimTask('T999', { sessionId: 'ses-alpha', agentId: null, mode: 'acquire' }),
    ).rejects.toThrow('not found');
    await expect(accessor.unclaimTask('T999', { sessionId: 'ses-alpha' })).rejects.toThrow(
      'not found',
    );
  });
});

describe('assignee updateTaskFields integration', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await writeFile(join(env.cleoDir, 'config.json'), NO_ENFORCEMENT_CONFIG);

    await addTask(
      {
        title: 'Update fields test',
        description: 'Task for updateTaskFields test',
        skipContainmentInvariant: true,
      },
      env.tempDir,
      accessor,
    );
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
