/**
 * Session activity heartbeat (T12540 · epic T12497).
 *
 * Proves:
 *  1. A bound session's heartbeat writes `lastActivity`, at most once per
 *     `SESSION_ACTIVITY_THROTTLE_MS` (AC1).
 *  2. Only ACTIVE sessions beat; an ended or unknown session is untouched.
 *  3. A beat blocked by another writer returns at once, writes nothing, and
 *     restores the connection's lock policy (best-effort, non-blocking).
 *  4. Liveness (`hasActiveSession`) and `session gc` measure idleness from
 *     `lastActivity`: a session that started 30 h ago but kept working stays
 *     live and is not orphaned, while an idle one is (AC2, AC3).
 *  5. `heartbeatProjectSession` is the one beat: activity + claim leases.
 *
 * @task T12540
 * @epic T12497
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Session } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import {
  getSession,
  hasActiveSession,
  SESSION_ACTIVITY_THROTTLE_MS,
  SESSION_LIVE_TTL_MS,
  sessionLastSeenMs,
  touchSessionActivity,
} from '../../store/session-store.js';
import { getNativeTasksDb } from '../../store/sqlite.js';
import { heartbeatProjectSession } from '../../task-work/claims.js';
import { gcSessions } from '../index.js';

const SES_WORKING = 'ses_20260929100001_workin';
const SES_IDLE = 'ses_20260929100002_idlexx';
const HOUR_MS = 60 * 60 * 1000;

function session(id: string, startedAt: string, status: Session['status'] = 'active'): Session {
  return {
    id,
    name: `session-${id}`,
    status,
    scope: { type: 'global' },
    taskWork: { taskId: null, setAt: null },
    startedAt,
    ...(status === 'active' ? {} : { endedAt: startedAt }),
  };
}

describe('session activity heartbeat (T12540)', () => {
  let env: TestDbEnv;
  const now = Date.now();

  beforeEach(async () => {
    env = await createTestDb();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  async function lastActivity(id: string): Promise<string | null | undefined> {
    return (await getSession(id, env.tempDir))?.lastActivity;
  }

  it('writes lastActivity at most once per throttle window', async () => {
    await env.accessor.upsertSingleSession(session(SES_WORKING, new Date(now).toISOString()));
    expect(await lastActivity(SES_WORKING)).toBeNull();

    expect(await touchSessionActivity(SES_WORKING, env.tempDir, now)).toBe(true);
    expect(await lastActivity(SES_WORKING)).toBe(new Date(now).toISOString());

    // Inside the window: throttled, nothing written.
    const soon = now + SESSION_ACTIVITY_THROTTLE_MS - 1;
    expect(await touchSessionActivity(SES_WORKING, env.tempDir, soon)).toBe(false);
    expect(await lastActivity(SES_WORKING)).toBe(new Date(now).toISOString());

    // Window elapsed: the next beat lands.
    const later = now + SESSION_ACTIVITY_THROTTLE_MS;
    expect(await touchSessionActivity(SES_WORKING, env.tempDir, later)).toBe(true);
    expect(await lastActivity(SES_WORKING)).toBe(new Date(later).toISOString());
  });

  it('never beats for an ended or unknown session', async () => {
    await env.accessor.upsertSingleSession(
      session(SES_IDLE, new Date(now - HOUR_MS).toISOString(), 'ended'),
    );
    expect(await touchSessionActivity(SES_IDLE, env.tempDir, now)).toBe(false);
    expect(await lastActivity(SES_IDLE)).toBeNull();
    expect(await touchSessionActivity('ses_missing', env.tempDir, now)).toBe(false);
  });

  it('a beat blocked by another writer returns at once without writing or erroring', async () => {
    await env.accessor.upsertSingleSession(session(SES_WORKING, new Date(now).toISOString()));
    const busyTimeout = () =>
      Number(getNativeTasksDb(env.tempDir)?.prepare('PRAGMA busy_timeout').get()?.['timeout']);
    const before = busyTimeout();
    const other = new DatabaseSync(join(env.cleoDir, 'cleo.db'));
    other.exec('PRAGMA busy_timeout = 0');
    other.exec('BEGIN IMMEDIATE');
    try {
      const started = Date.now();
      expect(await touchSessionActivity(SES_WORKING, env.tempDir, now)).toBe(false);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    expect(busyTimeout()).toBe(before);
    expect(await lastActivity(SES_WORKING)).toBeNull();
    // The next beat lands once the lock is gone.
    expect(await touchSessionActivity(SES_WORKING, env.tempDir, now)).toBe(true);
  });

  it('an active long-running session stays live past 24 h of activity; an idle one does not', async () => {
    const startedMs = now - 30 * HOUR_MS;
    const startedAt = new Date(startedMs).toISOString();
    await env.accessor.upsertSingleSession(session(SES_WORKING, startedAt));
    await env.accessor.upsertSingleSession(session(SES_IDLE, startedAt));

    // 30 h of work: a mutation every 30 minutes, each one a heartbeat.
    for (let t = startedMs; t <= now; t += HOUR_MS / 2) {
      await heartbeatProjectSession(env.tempDir, SES_WORKING, t);
    }
    const working = await getSession(SES_WORKING, env.tempDir);
    expect(working && now - sessionLastSeenMs(working)).toBeLessThan(HOUR_MS);

    // Liveness reads the heartbeat: live now, 30 h after it started ...
    expect(now - startedMs).toBeGreaterThan(SESSION_LIVE_TTL_MS);
    expect(await hasActiveSession(env.tempDir, now)).toBe(true);

    // ... and gc orphans only the session that stopped working.
    const result = await gcSessions(env.tempDir, { maxAgeDays: 1 });
    expect(result.orphaned).toEqual([SES_IDLE]);
    expect((await getSession(SES_WORKING, env.tempDir))?.status).toBe('active');
    expect((await getSession(SES_IDLE, env.tempDir))?.status).toBe('orphaned');

    // Once the working session also goes quiet for a full TTL, it is not live.
    expect(await hasActiveSession(env.tempDir, now + SESSION_LIVE_TTL_MS + 60_000)).toBe(false);
  });

  it('heartbeatProjectSession reports the activity beat and renewed leases', async () => {
    await env.accessor.upsertSingleSession(session(SES_WORKING, new Date(now).toISOString()));
    expect(await heartbeatProjectSession(env.tempDir, SES_WORKING, now)).toEqual({
      activityTouched: true,
      leasesRenewed: 0,
    });
    expect(await heartbeatProjectSession(env.tempDir, SES_WORKING, now + 1000)).toEqual({
      activityTouched: false,
      leasesRenewed: 0,
    });
  });
});
