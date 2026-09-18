/**
 * Tests for the teardown signal (T12239).
 *
 * The behaviour that matters is the RACE: work can register its controller at
 * any instant relative to `markShuttingDown()`, including after. A registry
 * that only aborts what was present when the latch flipped leaves exactly the
 * window this module exists to close.
 *
 * @task T12239
 * @epic T12114
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetTeardownSignalForTests,
  isShuttingDown,
  markShuttingDown,
  registerTeardownAbort,
} from '../teardown-signal.js';

afterEach(() => {
  _resetTeardownSignalForTests();
});

describe('teardown-signal', () => {
  it('starts un-latched', () => {
    expect(isShuttingDown()).toBe(false);
  });

  it('aborts controllers registered BEFORE teardown', () => {
    const c = new AbortController();
    registerTeardownAbort(c);
    expect(c.signal.aborted).toBe(false);

    markShuttingDown();

    expect(isShuttingDown()).toBe(true);
    expect(c.signal.aborted).toBe(true);
  });

  it('aborts a controller registered AFTER teardown, immediately', () => {
    // The race. Between `markShuttingDown()` and a `setImmediate` callback
    // reaching `registerTeardownAbort`, work can start that nothing has seen.
    // Registering late must not mean never.
    markShuttingDown();

    const late = new AbortController();
    registerTeardownAbort(late);
    expect(late.signal.aborted).toBe(true);
  });

  it('deregistration stops a completed operation retaining its controller', () => {
    const c = new AbortController();
    const off = registerTeardownAbort(c);
    off();

    markShuttingDown();

    // Not aborted, because the work already finished and deregistered. The
    // point is the registry does not grow for the process lifetime.
    expect(c.signal.aborted).toBe(false);
  });

  it('is idempotent — a second markShuttingDown is a no-op', () => {
    markShuttingDown();
    expect(() => markShuttingDown()).not.toThrow();
    expect(isShuttingDown()).toBe(true);
  });

  it('one controller throwing does not prevent the others aborting', () => {
    const good1 = new AbortController();
    const poisoned = new AbortController();
    // Simulate a detached/native controller whose abort throws.
    Object.defineProperty(poisoned, 'abort', {
      value: () => {
        throw new Error('detached');
      },
    });
    const good2 = new AbortController();

    registerTeardownAbort(good1);
    registerTeardownAbort(poisoned);
    registerTeardownAbort(good2);

    expect(() => markShuttingDown()).not.toThrow();
    expect(good1.signal.aborted).toBe(true);
    expect(good2.signal.aborted).toBe(true);
  });
});
