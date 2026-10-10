/**
 * `promptAllowed` / `isCiEnv` (T13308): one rule for the login picker and the
 * first-run consent prompt.
 *
 * @task T13308
 */

import { describe, expect, it } from 'vitest';
import { isCiEnv, promptAllowed } from '../prompt-allowed.js';

describe('promptAllowed (T13308)', () => {
  it('needs a terminal on stdin and stderr, and no CI', () => {
    expect(promptAllowed({}, true)).toBe(true);
    expect(promptAllowed({}, false)).toBe(false);
    expect(promptAllowed({ CI: 'true' }, true)).toBe(false);
    expect(promptAllowed({ CI: '1' }, true)).toBe(false);
  });

  it('CI empty or "false" is not CI', () => {
    expect(isCiEnv({})).toBe(false);
    expect(isCiEnv({ CI: '' })).toBe(false);
    expect(isCiEnv({ CI: 'false' })).toBe(false);
    expect(isCiEnv({ CI: 'true' })).toBe(true);
  });
});
