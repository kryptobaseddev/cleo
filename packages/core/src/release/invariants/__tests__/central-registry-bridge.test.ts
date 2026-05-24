/**
 * Tests for the release-side bridge that consumes the central ADR-056
 * metadata from `@cleocode/contracts` (T10339 — R5).
 *
 * The release-time registry at `packages/core/src/release/invariants/registry.ts`
 * exposes `getRegisteredAdr056Invariants()` which proxies through to
 * `getInvariantsByAdr('ADR-056')` in the central registry. The two views
 * MUST stay in sync — this test pins the contract.
 *
 * @epic T10327 — E-INVARIANT-REGISTRY-SSOT
 * @saga T10326 — SG-SUBSTRATE-RECONCILIATION
 * @task T10339 — R5: release-registry consumes central substrate
 */

import { getInvariantsByAdr } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { getRegisteredAdr056Invariants } from '../registry.js';

describe('getRegisteredAdr056Invariants — release-side central-registry bridge', () => {
  it('returns the same six entries as getInvariantsByAdr("ADR-056")', () => {
    const fromBridge = getRegisteredAdr056Invariants();
    const fromCentral = getInvariantsByAdr('ADR-056');

    expect(fromBridge).toHaveLength(6);
    expect(fromBridge).toHaveLength(fromCentral.length);

    for (let i = 0; i < fromBridge.length; i++) {
      expect(fromBridge[i]?.adr).toBe(fromCentral[i]?.adr);
      expect(fromBridge[i]?.code).toBe(fromCentral[i]?.code);
      expect(fromBridge[i]?.name).toBe(fromCentral[i]?.name);
      expect(fromBridge[i]?.severity).toBe(fromCentral[i]?.severity);
    }
  });

  it('surfaces D1..D6 in declaration order', () => {
    const entries = getRegisteredAdr056Invariants();
    expect(entries.map((e) => e.code)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
  });

  it('D5 points at the release-time registry runInvariants entry', () => {
    const d5 = getRegisteredAdr056Invariants().find((e) => e.code === 'D5');
    expect(d5).toBeDefined();
    expect(d5?.runtimeGate?.module).toBe('packages/core/src/release/invariants/registry.ts');
    expect(d5?.runtimeGate?.functionName).toBe('runInvariants');
  });
});
