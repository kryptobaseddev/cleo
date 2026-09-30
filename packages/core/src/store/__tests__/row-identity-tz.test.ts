/**
 * Row uids do not depend on the device timezone (T12341 review round 2, item
 * 5). This file runs under America/Los_Angeles; every assertion compares with
 * the UTC reading of the same stored value.
 *
 * @task T12341
 */

process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { birthFingerprint, mintedRowUid, parseStoreTimestamp } from '../row-identity.js';

describe('stored timestamps under a non-UTC timezone', () => {
  it('runs in a timezone where Date.parse reads a zoneless value as local time', () => {
    expect(Date.parse('2026-09-24T17:59:09')).not.toBe(Date.parse('2026-09-24T17:59:09Z'));
  });

  it('reads every zoneless form as UTC', () => {
    const utc = Date.UTC(2026, 8, 24, 17, 59, 9);
    expect(parseStoreTimestamp('2026-09-24T17:59:09')).toBe(utc);
    expect(parseStoreTimestamp('2026-09-24 17:59:09')).toBe(utc);
    expect(parseStoreTimestamp('2026-09-24T17:59:09Z')).toBe(utc);
    expect(parseStoreTimestamp('2026-09-24T17:59:09.000Z')).toBe(utc);
    expect(parseStoreTimestamp('2026-09-24T10:59:09-07:00')).toBe(utc);
    expect(parseStoreTimestamp('2026-09-24')).toBe(Date.UTC(2026, 8, 24));
  });

  it('rejects everything that is not a strict ISO / SQLite timestamp', () => {
    for (const v of [
      'Sep 24 2026',
      '2026-13-01',
      '2026-02-30',
      '2026-09-24T25:00:00',
      '24/09/2026',
      '',
    ]) {
      expect(parseStoreTimestamp(v), v).toBeNull();
    }
  });

  it('derives the same uid and fingerprint as a UTC device would', () => {
    const zoneless = mintedRowUid('project', 'tasks_tasks', ['T1'], '2026-09-24T17:59:09');
    expect(zoneless).toBe(mintedRowUid('project', 'tasks_tasks', ['T1'], '2026-09-24T17:59:09Z'));
    expect(Number.parseInt(zoneless.replaceAll('-', '').slice(0, 12), 16)).toBe(
      Date.UTC(2026, 8, 24, 17, 59, 9),
    );
    expect(birthFingerprint('tasks_tasks', '2026-09-24T17:59:09', ['a', 'task'])).toBe(
      birthFingerprint('tasks_tasks', '2026-09-24 17:59:09', ['a', 'task']),
    );
  });
});
