/**
 * `mergeConfigJson` rejects a `system-one` block (T12713): the section reads
 * no options, and merging the block would route its key into the shared
 * `apiKey` field the `llm` section consumes.
 *
 * @task T12713
 */

import { describe, expect, it } from 'vitest';
import {
  mergeConfigJson,
  SetupConfigJsonError,
  SYSTEM_ONE_CONFIG_FIX,
} from '../config-json-merge.js';
import type { WizardOptions } from '../wizard.js';

describe('mergeConfigJson — system-one block (T12713)', () => {
  it('rejects a non-empty system-one block and points to cleo decide config --key-stdin', () => {
    const out: WizardOptions = {};
    let caught: unknown;
    try {
      mergeConfigJson({ 'system-one': { provider: 'layahost', apiKey: 'sk-not-merged' } }, out);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SetupConfigJsonError);
    expect(caught instanceof Error ? caught.message : '').toContain(SYSTEM_ONE_CONFIG_FIX);
    expect(SYSTEM_ONE_CONFIG_FIX).toContain('cleo decide config');
    expect(SYSTEM_ONE_CONFIG_FIX).toContain('--key-stdin');
    // Nothing leaked into the llm section's fields.
    expect(out.apiKey).toBeUndefined();
    expect(out.provider).toBeUndefined();
  });

  it('accepts an empty system-one block and still merges the other sections', () => {
    const out: WizardOptions = {};
    mergeConfigJson({ 'system-one': {}, identity: { agentName: 'Atlas' } }, out);
    expect(out.agentName).toBe('Atlas');
  });
});
