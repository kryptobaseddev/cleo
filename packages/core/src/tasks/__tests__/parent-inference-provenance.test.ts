/**
 * An explicit argument must outrank an inference, and an inference that fires
 * must be visible in the output (T12136 · GH #1232, #1238).
 *
 * The live condition these tests encode is not synthetic. In the session that
 * wrote them, `cleo current` returned `T12100` — status `done`, set
 * 2026-08-19, in a session started 2026-08-01. Any `cleo add --type task`
 * without `--parent` would have been filed under a task finished weeks
 * earlier, and `E_CLEO_DEPTH_EXCEEDED` would have named it as though the
 * caller had asked for it.
 *
 * @task T12136
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resolveParentFromSession } from '../session-scope.js';

const NOW = new Date().toISOString();

describe('resolveParentFromSession — explicit outranks inference (T12136)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await seedTasks(accessor, [
      { id: 'T100', title: 'live epic', type: 'epic', status: 'pending', createdAt: NOW },
      { id: 'T200', title: 'finished epic', type: 'epic', status: 'done', createdAt: NOW },
    ]);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('returns an explicit parent verbatim and reports it as explicit', async () => {
    const r = await resolveParentFromSession(env.tempDir, { parent: 'T100', type: 'task' });
    expect(r.resolvedParent).toBe('T100');
    expect(r.parentSource).toBe('explicit');
    // No note: nothing happened that the caller did not ask for.
    expect(r.inferenceNote).toBeUndefined();
  });

  it('never infers for an epic', async () => {
    const r = await resolveParentFromSession(env.tempDir, { type: 'epic' });
    expect(r.resolvedParent).toBeNull();
    expect(r.parentSource).toBe('explicit');
  });

  it('reports nothing when there is no session scope to infer from', async () => {
    const r = await resolveParentFromSession(env.tempDir, { type: 'task' });
    expect(r.resolvedParent).toBeNull();
    expect(r.parentSource).toBe('explicit');
  });

  it('reports a --parent-search resolution rather than passing it off as explicit', async () => {
    const r = await resolveParentFromSession(env.tempDir, {
      parentSearch: 'live epic',
      type: 'task',
    });
    expect(r.resolvedParent).toBe('T100');
    expect(r.parentSource).toBe('parent-search');
    expect(r.inferenceNote).toContain('resolved to T100');
  });

  it('errors, rather than silently returning no parent, when --parent-search matches nothing', async () => {
    const r = await resolveParentFromSession(env.tempDir, {
      parentSearch: 'no such task anywhere',
      type: 'task',
    });
    expect(r.resolvedParent).toBeNull();
    expect(r.error).toBeDefined();
  });
});

describe('parent-inference provenance shape (T12136)', () => {
  it('names the source in a discriminated union, so a consumer can branch on it', async () => {
    const env = await createTestDb();
    try {
      await seedTasks(env.accessor, [
        { id: 'T100', title: 'epic', type: 'epic', status: 'pending', createdAt: NOW },
      ]);
      const explicit = await resolveParentFromSession(env.tempDir, {
        parent: 'T100',
        type: 'task',
      });
      // The discriminant is what lets `E_CLEO_DEPTH_EXCEEDED` say "you did not
      // pass --parent" only when that is true. A caller that DID pass
      // --parent must never be told its parent was inferred.
      expect(['explicit', 'parent-search', 'session-inference']).toContain(explicit.parentSource);
      expect(explicit.parentSource).toBe('explicit');
    } finally {
      await env.cleanup();
    }
  });
});

describe('E_CLEO_DEPTH_EXCEEDED names an inherited parent (T12136 · GH #1238)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    // saga -> epic -> task: the task is at depth 2, so it cannot take children.
    await seedTasks(accessor, [
      { id: 'T9001', title: 'saga', type: 'saga', status: 'pending', createdAt: NOW },
      {
        id: 'T9002',
        title: 'epic',
        type: 'epic',
        parentId: 'T9001',
        status: 'pending',
        createdAt: NOW,
      },
      {
        id: 'T9003',
        title: 'task',
        type: 'task',
        parentId: 'T9002',
        status: 'pending',
        createdAt: NOW,
      },
    ]);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  /**
   * The reported incident: the caller passed no `--parent`, the parent was
   * inherited from the session pointer, and the error read as though the
   * caller had asked to file under it — with the suggested remedy pointing
   * into a hierarchy it never intended to touch.
   */
  it('says the caller did not pass --parent when the parent was inherited', async () => {
    const { addTask } = await import('../add.js');
    await expect(
      addTask(
        {
          title: 'child of a depth-2 task',
          type: 'task',
          parentId: 'T9003',
          parentSource: 'session-inference',
          acceptance: ['a', 'b'],
        },
        env.tempDir,
        accessor,
      ),
    ).rejects.toThrow(
      /You did not pass --parent: T9003 was inherited from the active session pointer/,
    );
  });

  it('offers the escape hatch only when the parent was inherited', async () => {
    const { addTask } = await import('../add.js');
    await expect(
      addTask(
        {
          title: 'child of a depth-2 task',
          type: 'task',
          parentId: 'T9003',
          parentSource: 'session-inference',
          acceptance: ['a', 'b'],
        },
        env.tempDir,
        accessor,
      ),
    ).rejects.toThrow(/--parent none to suppress inference/);
  });

  it('does NOT claim inheritance when the caller named the parent', async () => {
    // The dangerous inverse: telling a caller that DID pass --parent that its
    // parent was inferred would be a new false statement, not a fix.
    const { addTask } = await import('../add.js');
    let message = '';
    try {
      await addTask(
        {
          title: 'child of a depth-2 task',
          type: 'task',
          parentId: 'T9003',
          parentSource: 'explicit',
          acceptance: ['a', 'b'],
        },
        env.tempDir,
        accessor,
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/hierarchy depth cap/);
    expect(message).not.toMatch(/You did not pass --parent/);
    expect(message).not.toMatch(/inherited/);
  });

  it('defaults to explicit when parentSource is omitted, so no false claim is made', async () => {
    const { addTask } = await import('../add.js');
    let message = '';
    try {
      await addTask(
        { title: 'child', type: 'task', parentId: 'T9003', acceptance: ['a', 'b'] },
        env.tempDir,
        accessor,
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toMatch(/You did not pass --parent/);
  });
});
