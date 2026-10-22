/**
 * Sync-state probes skip the startup encounter and heartbeat (T13852).
 *
 * @task T13852
 */

import { describe, expect, it } from 'vitest';
import { isSyncProbeInvocation } from '../sync-probe-commands.js';

describe('isSyncProbeInvocation', () => {
  it('matches cloud verify and cloud status, with flags anywhere after the verb', () => {
    expect(isSyncProbeInvocation(['cloud', 'verify'])).toBe(true);
    expect(isSyncProbeInvocation(['--json', 'cloud', 'verify', '--deep'])).toBe(true);
    expect(isSyncProbeInvocation(['cloud', 'status', '--scope', 'global'])).toBe(true);
  });

  it('leaves every command that uses or changes the store alone', () => {
    expect(isSyncProbeInvocation(['cloud', 'push'])).toBe(false);
    expect(isSyncProbeInvocation(['cloud', 'pull'])).toBe(false);
    expect(isSyncProbeInvocation(['cloud'])).toBe(false);
    expect(isSyncProbeInvocation(['verify', 'T1'])).toBe(false);
    expect(isSyncProbeInvocation(['show', 'T1'])).toBe(false);
    expect(isSyncProbeInvocation([])).toBe(false);
  });
});
