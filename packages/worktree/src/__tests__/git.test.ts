/**
 * Regression locks for the low-level git helpers in `@cleocode/worktree`.
 *
 * Currently asserts only the published value of {@link DEFAULT_GIT_TIMEOUT_MS}
 * — T9823 bumped this from 60s to 180s so large-repo `git worktree add`
 * (~95s on the cleocode monorepo with 10,712 files) can complete without
 * triggering `spawnSync git ETIMEDOUT`. Keeping the bumped value pinned here
 * prevents accidental regressions back to 60s.
 *
 * @task T9823
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_GIT_TIMEOUT_MS } from '../git.js';

describe('DEFAULT_GIT_TIMEOUT_MS (T9823 regression lock)', () => {
  it('is pinned at 180_000ms (3 minutes) so large-repo worktree add completes', () => {
    expect(DEFAULT_GIT_TIMEOUT_MS).toBe(180_000);
  });

  it('is strictly larger than the legacy 60s budget that caused T9823', () => {
    // The legacy value (60_000) was provably too tight for 10k+ file repos.
    // Any future tuning MUST keep the value above 60s — this assertion catches
    // an accidental revert without locking the new value in stone.
    expect(DEFAULT_GIT_TIMEOUT_MS).toBeGreaterThan(60_000);
  });
});
