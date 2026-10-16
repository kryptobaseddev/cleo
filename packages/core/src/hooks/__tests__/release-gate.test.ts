/**
 * The hooks-v1 release gate opens from release metadata only (T13557).
 *
 * @task T13557
 */

import { describe, expect, it } from 'vitest';
import { hookReleaseManifest, hooksV1Released, UNRELEASED_HOOK_FEATURES } from '../release-gate.js';

describe('hooksV1Released (T13557)', () => {
  it('is released in source after the v2026.10.17 promotion (T13776)', () => {
    expect(UNRELEASED_HOOK_FEATURES.has('hooks-v1')).toBe(false);
    expect(hooksV1Released({ manifest: { version: '2026.10.18' } })).toBe(true);
  });

  it('is closed on a stable build without the promotion stamp while unreleased', () => {
    const unreleased = new Set(['hooks-v1'] as const);
    expect(hooksV1Released({ manifest: { version: '2026.10.9' }, unreleased })).toBe(false);
    expect(hooksV1Released({ manifest: { version: '2026.10.9-rc.ci.42' }, unreleased })).toBe(
      false,
    );
    expect(hooksV1Released({ manifest: {}, unreleased })).toBe(false);
  });

  it('opens on a canary build, on the promotion stamp, or by explicit opt-in', () => {
    const unreleased = new Set(['hooks-v1'] as const);
    expect(hooksV1Released({ manifest: { version: '2026.10.9-canary.3' }, unreleased })).toBe(true);
    expect(
      hooksV1Released({
        manifest: { version: '2026.10.9', cleo: { releasedFeatures: ['hooks-v1'] } },
        unreleased,
      }),
    ).toBe(true);
    expect(
      hooksV1Released({ manifest: { version: '2026.10.9' }, allowUnreleased: true, unreleased }),
    ).toBe(true);
  });

  it('is open everywhere once hooks-v1 leaves the unreleased set', () => {
    expect(hooksV1Released({ manifest: { version: '2026.10.9' }, unreleased: new Set() })).toBe(
      true,
    );
  });

  it("reads this build's own @cleocode/core manifest by default (T13559)", () => {
    // A layout change that resolved another package.json would silently keep a canary closed.
    expect(hookReleaseManifest().name).toBe('@cleocode/core');
    expect(typeof hooksV1Released()).toBe('boolean');
  });
});
