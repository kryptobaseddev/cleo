/**
 * Smoke test for cleo doctor --scan-stray-nexus-dbs flag (T9052).
 *
 * @task T9052
 */
import { describe, expect, it } from 'vitest';
import {
  detectAndRemoveLegacyGlobalFiles,
  detectAndRemoveStrayProjectNexus,
} from '../cleanup-legacy.js';

describe('T9052 — stray-DB cleanup', () => {
  it('detectAndRemoveLegacyGlobalFiles returns array shape', () => {
    const result = detectAndRemoveLegacyGlobalFiles('/tmp/nonexistent-cleo-home');
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('detectAndRemoveStrayProjectNexus returns boolean shape', () => {
    const result = detectAndRemoveStrayProjectNexus('/tmp/nonexistent-project');
    expect(typeof result.removed).toBe('boolean');
    expect(result.path).toBeDefined();
  });
});
