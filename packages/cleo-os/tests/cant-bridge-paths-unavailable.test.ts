/**
 * When `@cleocode/paths` cannot be used, the cleo-cant-bridge extension says
 * so once instead of silently dropping the global and user CANT tiers
 * (T12602 review).
 *
 * @task T12602
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cleocode/paths', () => ({}));

import {
  _resetCleoPathsWarningForTests,
  loadCleoPaths,
} from '../extensions/cleo-cant-bridge.js';

describe('loadCleoPaths — module unavailable (T12602)', () => {
  beforeEach(() => {
    _resetCleoPathsWarningForTests();
  });

  it('returns null and warns exactly once per process', async () => {
    const warn = vi.fn();

    expect(await loadCleoPaths(warn)).toBeNull();
    expect(await loadCleoPaths(warn)).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('@cleocode/paths unavailable');
    expect(warn.mock.calls[0]?.[0]).toContain('CANT tiers');
  });
});
