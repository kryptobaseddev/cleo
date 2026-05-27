/**
 * Unit tests for T9770 — caamp `skills install` warning routing.
 *
 * @remarks
 * Verifies the `[caamp] WARNING:` stderr pollution reported by the user is
 * eliminated by routing graceful-degradation notices into the active LAFS
 * {@link WarningCollector} instead of `process.stderr.write`.
 *
 * Two scenarios are covered:
 * 1. `resolveCore()` fails (e.g. `@cleocode/core` unavailable in a standalone
 *    caamp install) — collector MUST capture exactly one
 *    `W_CORE_UNAVAILABLE` warning and stderr MUST stay silent.
 * 2. `recordTrustBypass()` throws (audit log write fails) — collector MUST
 *    capture `W_AUDIT_LOG_FAILED` and stderr MUST stay silent.
 *
 * @task T9770
 * @epic T9763
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WarningCollector, withWarningCollector } from '@cleocode/lafs';
import { __testing } from '../../src/commands/skills/install.js';

interface AdapterScanResultFixture {
  readonly skillName: string;
  readonly source: string;
  readonly trustLevel: 'community';
  readonly verdict: 'safe';
  readonly findings: readonly never[];
  readonly scannedAt: string;
  readonly summary: string;
}

function makeScanFixture(): AdapterScanResultFixture {
  return {
    skillName: 'test-skill',
    source: 'local:/tmp/test-skill',
    trustLevel: 'community',
    verdict: 'safe',
    findings: [],
    scannedAt: new Date().toISOString(),
    summary: 'fixture',
  };
}

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __testing.resetCoreCache();
  __testing.setCoreResolver(null);
  // Sentinel: any stderr write during the test counts as pollution.
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  __testing.resetCoreCache();
  __testing.setCoreResolver(null);
});

describe('caamp skills install — warning routing (T9770)', () => {
  it('routes W_CORE_UNAVAILABLE into the active WarningCollector when core resolution fails', async () => {
    const collector = new WarningCollector();
    // Simulate `@cleocode/core` being absent.
    __testing.setCoreResolver(() => Promise.reject(new Error('MODULE_NOT_FOUND')));

    const result = await withWarningCollector(collector, async () => __testing.resolveCore());

    expect(result).toBeNull();

    const drained = collector.drain();
    expect(drained).toBeDefined();
    expect(drained).toHaveLength(1);
    const [warning] = drained!;
    expect(warning.code).toBe('W_CORE_UNAVAILABLE');
    expect(warning.severity).toBe('warn');
    expect(warning.message).toMatch(/@cleocode\/core/);
    expect(warning.context).toMatchObject({ error: 'MODULE_NOT_FOUND' });

    // Stderr stays silent — no `[caamp] WARNING:` line should be emitted.
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('routes W_AUDIT_LOG_FAILED into the active WarningCollector when recordTrustBypass throws', async () => {
    const collector = new WarningCollector();
    // Provide a stub core whose `recordTrustBypass` always throws.
    __testing.setCoreResolver(() =>
      Promise.resolve({
        scanSkill: () => makeScanFixture(),
        shouldAllowInstall: () => ({ decision: 'allow' as const, reason: 'fixture' }),
        recordTrustBypass: () => {
          throw new Error('disk full');
        },
        evaluateFederationInstallGate: () => ({
          decision: 'allow' as const,
          reason: 'fixture',
          peer: null,
          isFederationSource: false,
          computedChecksum: null,
          expectedChecksum: null,
        }),
      }),
    );

    await withWarningCollector(collector, async () =>
      __testing.recordSkillTrustBypass(makeScanFixture(), 'unit test'),
    );

    const drained = collector.drain();
    expect(drained).toBeDefined();
    expect(drained).toHaveLength(1);
    const [warning] = drained!;
    expect(warning.code).toBe('W_AUDIT_LOG_FAILED');
    expect(warning.severity).toBe('warn');
    expect(warning.message).toBe('trust-bypass audit record failed');
    expect(warning.context).toMatchObject({ error: 'disk full' });

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('is silent (no warnings, no stderr) when there is no active collector and core is available', async () => {
    __testing.setCoreResolver(() =>
      Promise.resolve({
        scanSkill: () => makeScanFixture(),
        shouldAllowInstall: () => ({ decision: 'allow' as const, reason: 'fixture' }),
        recordTrustBypass: () => undefined,
        evaluateFederationInstallGate: () => ({
          decision: 'allow' as const,
          reason: 'fixture',
          peer: null,
          isFederationSource: false,
          computedChecksum: null,
          expectedChecksum: null,
        }),
      }),
    );

    const core = await __testing.resolveCore();
    expect(core).not.toBeNull();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('pushWarning is a no-op when no collector is active (resolver failure case)', async () => {
    // Outside any withWarningCollector scope — pushWarning falls through silently.
    __testing.setCoreResolver(() => Promise.reject(new Error('boom')));
    const result = await __testing.resolveCore();
    expect(result).toBeNull();
    // Critically: stderr stays silent even with NO collector — the warning is
    // simply dropped rather than being routed back to legacy stderr writes.
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
