/**
 * `tool:test-affected` is a listed tool name (T12964).
 *
 * The atom validated since T12635, but help and validation surfaces built from
 * {@link listValidToolNames} never mentioned it, so agents did not know it
 * existed.
 *
 * @task T12964
 */

import { describe, expect, it } from 'vitest';
import { isValidToolName, VALID_TOOLS } from '../evidence.js';
import { listValidToolNames } from '../tool-resolver.js';

describe('valid tool names (T12964)', () => {
  it('lists test-affected beside the canonical tools', () => {
    expect(listValidToolNames()).toContain('test-affected');
    expect(listValidToolNames()).toContain('test');
  });

  it('accepts test-affected through the evidence-side list', () => {
    expect(VALID_TOOLS).toContain('test-affected');
    expect(isValidToolName('test-affected')).toBe(true);
  });
});
