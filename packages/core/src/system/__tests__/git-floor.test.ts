/**
 * git below 2.31 lacks `--diff-merges`, which merge diffs need (T14166).
 *
 * @task T14166
 */

import { describe, expect, it } from 'vitest';
import { gitMeetsFloor } from '../dependencies.js';

describe('gitMeetsFloor (T14166)', () => {
  it('accepts 2.31 and later, refuses older or unreadable versions', () => {
    for (const v of ['2.31.0', '2.31', '2.39.3', '2.55.0', '3.0.0'])
      expect(gitMeetsFloor(v)).toBe(true);
    for (const v of ['2.30.2', '2.9.5', '1.99.0', '', 'unknown'])
      expect(gitMeetsFloor(v)).toBe(false);
  });
});
