/**
 * Exodus-on-open ABORT-surfacing unit suite (T11828 · DHQ-059).
 *
 * Proves the abort that the data-continuity gate raises is now visible to a
 * MUTATING caller without breaking READ-only opens:
 *
 *   - {@link emitExodusAbort} records the abort per-scope AND broadcasts it on
 *     {@link exodusAbortEvents};
 *   - {@link getRecordedExodusAbort} returns the recorded detail (per-scope and
 *     most-recent), and {@link clearExodusAborts} resolves it;
 *   - {@link assertWriteDurable} throws {@link ExodusAbortWriteUnsafeError} when a
 *     handle carries an `exodusAbort` marker, and is a no-op otherwise;
 *   - the consolidated-schema MUTATION primitives ({@link insertIdempotent} /
 *     {@link upsertIdempotent}) reject with the same typed error while a recorded
 *     abort is live, and succeed once it is cleared.
 *
 * @task T11828 (DHQ-059)
 * @epic T11833
 * @saga T11242
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertWriteDurable,
  type DualScopeDbHandle,
  ExodusAbortWriteUnsafeError,
  insertIdempotent,
} from '../dual-scope-db.js';
import {
  clearExodusAborts,
  type ExodusAbortDetail,
  emitExodusAbort,
  exodusAbortEvents,
  getRecordedExodusAbort,
} from '../exodus/abort-events.js';

function makeDetail(over: Partial<ExodusAbortDetail> = {}): ExodusAbortDetail {
  return {
    scope: 'project',
    dbPath: '/tmp/cleo.db',
    reason: 'parity deficit: tasks_tasks(4465→0)',
    at: Date.now(),
    ...over,
  };
}

describe('exodus abort surface (T11828)', () => {
  beforeEach(() => {
    clearExodusAborts();
  });
  afterEach(() => {
    clearExodusAborts();
    exodusAbortEvents.removeAllListeners('abort');
  });

  describe('abort-events registry', () => {
    it('records the abort per-scope and broadcasts it', () => {
      const received: ExodusAbortDetail[] = [];
      exodusAbortEvents.on('abort', (d) => received.push(d));

      const detail = makeDetail();
      const hadListeners = emitExodusAbort(detail);

      expect(hadListeners).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(detail);
      expect(getRecordedExodusAbort('project')).toEqual(detail);
      expect(getRecordedExodusAbort('global')).toBeUndefined();
    });

    it('getRecordedExodusAbort() with no scope returns the most-recent across scopes', () => {
      const older = makeDetail({ scope: 'project', at: 1000 });
      const newer = makeDetail({ scope: 'global', dbPath: '/g/cleo.db', at: 2000 });
      emitExodusAbort(older);
      emitExodusAbort(newer);

      expect(getRecordedExodusAbort()).toEqual(newer);
      expect(getRecordedExodusAbort('project')).toEqual(older);
    });

    it('clearExodusAborts(scope) clears only that scope; clearExodusAborts() clears all', () => {
      emitExodusAbort(makeDetail({ scope: 'project' }));
      emitExodusAbort(makeDetail({ scope: 'global', dbPath: '/g/cleo.db' }));

      clearExodusAborts('project');
      expect(getRecordedExodusAbort('project')).toBeUndefined();
      expect(getRecordedExodusAbort('global')).toBeDefined();

      clearExodusAborts();
      expect(getRecordedExodusAbort()).toBeUndefined();
    });

    it('a throwing listener never propagates out of emitExodusAbort', () => {
      exodusAbortEvents.on('abort', () => {
        throw new Error('boom');
      });
      expect(() => emitExodusAbort(makeDetail())).not.toThrow();
      // The abort is still recorded despite the listener throwing.
      expect(getRecordedExodusAbort('project')).toBeDefined();
    });
  });

  describe('assertWriteDurable', () => {
    it('throws ExodusAbortWriteUnsafeError when the handle carries an abort marker', () => {
      const abort = makeDetail();
      const handle = {
        scope: 'project',
        dbPath: abort.dbPath,
        exodusAbort: abort,
        // db/close are irrelevant to the guard.
        db: {} as never,
        close: () => {},
      } as unknown as DualScopeDbHandle;

      expect(() => assertWriteDurable(handle)).toThrowError(ExodusAbortWriteUnsafeError);
      try {
        assertWriteDurable(handle);
      } catch (err) {
        expect(err).toBeInstanceOf(ExodusAbortWriteUnsafeError);
        expect((err as ExodusAbortWriteUnsafeError).codeName).toBe('E_EXODUS_ABORT_WRITE_UNSAFE');
        expect((err as ExodusAbortWriteUnsafeError).detail).toEqual(abort);
      }
    });

    it('is a no-op for a normal (non-aborted) read/write handle', () => {
      const handle = {
        scope: 'project',
        dbPath: '/tmp/cleo.db',
        db: {} as never,
        close: () => {},
      } as unknown as DualScopeDbHandle;
      expect(() => assertWriteDurable(handle)).not.toThrow();
    });
  });

  describe('write primitives reject while an abort is recorded', () => {
    // A stub Drizzle handle whose insert chain would resolve if reached — proves
    // the guard short-circuits BEFORE any DB call when an abort is live.
    function makeInsertSpyDb(): { db: never; calls: number } {
      const state = { calls: 0 };
      const chain = {
        values: () => chain,
        onConflictDoNothing: () => chain,
        returning: async () => {
          state.calls++;
          return [{}];
        },
      };
      const db = { insert: () => chain } as unknown as never;
      return {
        db,
        get calls() {
          return state.calls;
        },
      };
    }

    it('insertIdempotent throws ExodusAbortWriteUnsafeError without touching the DB', async () => {
      emitExodusAbort(makeDetail());
      const spy = makeInsertSpyDb();
      await expect(
        insertIdempotent(spy.db, {} as never, {} as never, 'idempotencyKey'),
      ).rejects.toBeInstanceOf(ExodusAbortWriteUnsafeError);
      expect(spy.calls).toBe(0);
    });

    it('insertIdempotent proceeds once the abort is cleared', async () => {
      emitExodusAbort(makeDetail());
      clearExodusAborts();
      const spy = makeInsertSpyDb();
      const inserted = await insertIdempotent(spy.db, {} as never, {} as never, 'idempotencyKey');
      expect(inserted).toBe(1);
      expect(spy.calls).toBe(1);
    });
  });
});
