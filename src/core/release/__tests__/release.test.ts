/**
 * Tests for release management.
 * @task T4467
 * @epic T4454
 *
 * Note: createRelease, planRelease, shipRelease, listReleases, showRelease,
 * getChangelog and validateVersion were removed as part of T5578 legacy purge.
 * Release operations now route through release-engine.ts via the dispatch layer.
 */

import { describe, it, expect } from 'vitest';
import { validateVersionFormat } from '../version-bump.js';

describe('validateVersionFormat', () => {
  it('accepts valid version formats', () => {
    expect(validateVersionFormat('1.0.0')).toBe(true);
    expect(validateVersionFormat('2.3.4')).toBe(true);
    expect(validateVersionFormat('1.0.0-alpha.1')).toBe(true);
    expect(validateVersionFormat('2026.2.0')).toBe(true);
  });

  it('rejects invalid version formats', () => {
    expect(validateVersionFormat('abc')).toBe(false);
    expect(validateVersionFormat('1.0')).toBe(false);
    expect(validateVersionFormat('v2.3.4')).toBe(false);
  });
});
