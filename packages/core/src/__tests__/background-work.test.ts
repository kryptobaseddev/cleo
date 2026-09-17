/**
 * The background-work registry must let teardown drain fire-and-forget work
 * WITHOUT changing the semantics of the callsites that start it (gh#1448).
 *
 * ## What is being protected
 *
 * Session start, session end and handoff each start a best-effort
 * session-manifest mirror and deliberately do not await it (T11639 AC3/AC4).
 * That is correct: a mirror failure must never block session start, and session
 * start must never wait on the two `git` spawns the mirror performs.
 *
 * So the registry may only OBSERVE. If registering a promise could delay a
 * callsite, or could surface a rejection the callsite had chosen to swallow,
 * the fix would have reintroduced exactly what those ACs forbid — the shape of
 * fixing one defect by undoing the guard against a worse one.
 *
 * @task T12217 (gh#1448)
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetBackgroundWork,
  backgroundWorkCount,
  drainBackgroundWork,
  trackBackgroundWork,
} from '../background-work.js';

afterEach(() => {
  _resetBackgroundWork();
});

describe('trackBackgroundWork does not change callsite semantics (gh#1448)', () => {
  it('returns void synchronously — registration cannot delay the caller', () => {
    let resolveIt: () => void = () => undefined;
    const slow = new Promise<void>((r) => {
      resolveIt = r;
    });
    const before = Date.now();
    const result = trackBackgroundWork(slow);
    // Registration must not await. If it did, this line would not be reached
    // until `slow` settled.
    expect(result).toBeUndefined();
    expect(Date.now() - before).toBeLessThan(50);
    resolveIt();
  });

  it('absorbs a rejection — registering cannot create an unhandled rejection', async () => {
    // The load-bearing safety property. A callsite that already swallows its
    // errors must not start emitting them because it was registered.
    const rejected = Promise.reject(new Error('mirror failed'));
    expect(() => trackBackgroundWork(rejected)).not.toThrow();
    // Keep the original handled too, so this test does not itself leak one.
    rejected.catch(() => undefined);
    await expect(drainBackgroundWork()).resolves.toBeGreaterThanOrEqual(1);
  });

  it('drains a rejection without propagating it', async () => {
    trackBackgroundWork(Promise.reject(new Error('boom')));
    await expect(drainBackgroundWork()).resolves.toBe(1);
  });
});

describe('drainBackgroundWork (gh#1448)', () => {
  it('waits for registered work to settle', async () => {
    let done = false;
    trackBackgroundWork(
      new Promise<void>((r) => setTimeout(r, 30)).then(() => {
        done = true;
      }),
    );
    expect(done).toBe(false);
    await drainBackgroundWork();
    expect(done).toBe(true);
  });

  it('returns 0 and resolves immediately when nothing is registered', async () => {
    await expect(drainBackgroundWork()).resolves.toBe(0);
  });

  it('forgets settled work, so a long process does not accumulate', async () => {
    trackBackgroundWork(Promise.resolve());
    await drainBackgroundWork();
    // Give the `finally` microtask a turn.
    await new Promise((r) => setTimeout(r, 0));
    expect(backgroundWorkCount()).toBe(0);
  });

  it('is a SNAPSHOT, not a barrier — work registered mid-drain is not awaited', async () => {
    // Deliberate. A barrier could never terminate against work that schedules
    // more work, and teardown must terminate.
    let lateStarted = false;
    trackBackgroundWork(
      new Promise<void>((r) => setTimeout(r, 10)).then(() => {
        trackBackgroundWork(
          new Promise<void>((r) => setTimeout(r, 10_000)).then(() => {
            lateStarted = true;
          }),
        );
      }),
    );
    const awaited = await drainBackgroundWork();
    expect(awaited).toBe(1);
    expect(lateStarted).toBe(false);
  });
});
