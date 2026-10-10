/**
 * T13305 (C2): row uids are ON by default; `CLEO_ROW_UID_FILL=0` is the kill
 * switch, and any other value (or none) leaves them on.
 *
 * @task T13305
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultRowUid, ROW_UID_FILL_FLAG, rowUidFillEnabled } from '../row-identity-flag.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('row uid default (T13305)', () => {
  it('unset: on, and new minted rows get a uid', () => {
    vi.stubEnv(ROW_UID_FILL_FLAG, undefined);
    expect(rowUidFillEnabled()).toBe(true);
    expect(typeof defaultRowUid()).toBe('string');
  });

  it('CLEO_ROW_UID_FILL=0 is the kill switch: off, and new rows get NULL', () => {
    vi.stubEnv(ROW_UID_FILL_FLAG, '0');
    expect(rowUidFillEnabled()).toBe(false);
    expect(typeof defaultRowUid()).not.toBe('string');
  });

  it.each(['1', 'true', ''])('CLEO_ROW_UID_FILL=%j leaves them on', (value) => {
    vi.stubEnv(ROW_UID_FILL_FLAG, value);
    expect(rowUidFillEnabled()).toBe(true);
  });
});
