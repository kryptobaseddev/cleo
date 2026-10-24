/**
 * The single-flight pid lock shared by the inline refresh and the reindex
 * after a merge (T14014): one winner when two clear a dead holder, a live lock
 * that raced in is put back, and only the owner releases.
 *
 * Liveness is injected, so pids here are labels, not processes.
 *
 * @task T14014
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { releasePidLock, takePidLock } from '../pid-lock.js';

let dir: string;
let lock: string;
const DEAD = 999_999;
const alive = (pid: number): boolean => pid !== DEAD;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-pid-lock-'));
  lock = join(dir, 'x.lock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pid lock (T14014)', () => {
  it('takes a free lock and reports a live holder', () => {
    expect(takePidLock(lock, { pid: 101, isAlive: alive })).toBeNull();
    expect(readFileSync(lock, 'utf-8')).toBe('101');
    expect(takePidLock(lock, { pid: 202, isAlive: alive })).toBe(101);
  });

  it('two clearers of a dead holder: exactly one wins', () => {
    writeFileSync(lock, String(DEAD));
    const first = takePidLock(lock, { pid: 101, isAlive: alive });
    const second = takePidLock(lock, { pid: 202, isAlive: alive });
    expect([first, second]).toEqual([null, 101]);
    expect(readFileSync(lock, 'utf-8')).toBe('101');
  });

  it('puts back a live lock that replaced the dead one mid-clear', () => {
    writeFileSync(lock, String(DEAD));
    // Between judging the holder dead and moving the lock aside, another
    // process clears it and takes it (pid 303).
    const racing = (pid: number): boolean => {
      if (pid === DEAD) writeFileSync(lock, '303');
      return alive(pid);
    };
    expect(takePidLock(lock, { pid: 101, isAlive: racing })).toBe(303);
    expect(readFileSync(lock, 'utf-8')).toBe('303');
  });

  it('only the owner releases the lock', () => {
    expect(takePidLock(lock, { pid: 101, isAlive: alive })).toBeNull();
    releasePidLock(lock, 202);
    expect(existsSync(lock)).toBe(true);
    releasePidLock(lock, 101);
    expect(existsSync(lock)).toBe(false);
  });

  it('treats a young empty lock as a holder still writing it', () => {
    writeFileSync(lock, '');
    expect(takePidLock(lock, { pid: 101, isAlive: alive })).toBe(0);
    expect(readFileSync(lock, 'utf-8')).toBe('');
  });
});
