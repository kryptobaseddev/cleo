/**
 * Unit tests for the ADR-056 D1-D6 entries in the central invariants
 * registry (T10339 — R5).
 *
 * The release-side executable subsystem at
 * `packages/core/src/release/invariants/registry.ts` consumes these
 * metadata entries via `getInvariantsByAdr('ADR-056')`. The tests below
 * assert the metadata shape downstream consumers (R4 CI gate, R6 doctor
 * audit, R8 docs renderer) rely on.
 *
 * @epic T10327 — E-INVARIANT-REGISTRY-SSOT
 * @saga T10326 — SG-SUBSTRATE-RECONCILIATION
 * @task T10339 — R5: release-registry consumes central substrate
 */

import { describe, expect, it } from 'vitest';
import {
  ADR_056_INVARIANTS,
  getInvariant,
  getInvariantsByAdr,
  INVARIANTS_REGISTRY,
} from '../index.js';

describe('ADR-056 invariants — central registry entries', () => {
  it('registers all six ADR-056 decisions D1-D6 under predictable keys', () => {
    for (let i = 1; i <= 6; i++) {
      const key = `ADR-056.D${i}`;
      expect(INVARIANTS_REGISTRY[key]).toBeDefined();
      expect(INVARIANTS_REGISTRY[key]?.adr).toBe('ADR-056');
      expect(INVARIANTS_REGISTRY[key]?.code).toBe(`D${i}`);
    }
  });

  it('getInvariantsByAdr("ADR-056") returns D1..D6 in declaration order', () => {
    const adr056 = getInvariantsByAdr('ADR-056');
    expect(adr056).toHaveLength(6);
    expect(adr056.map((e) => e.code)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
  });

  it('ADR_056_INVARIANTS convenience binding matches getInvariantsByAdr output', () => {
    expect(ADR_056_INVARIANTS).toHaveLength(6);
    const enumerated = getInvariantsByAdr('ADR-056');
    expect(enumerated).toHaveLength(ADR_056_INVARIANTS.length);
    for (let i = 0; i < ADR_056_INVARIANTS.length; i++) {
      expect(enumerated[i]?.code).toBe(ADR_056_INVARIANTS[i]?.code);
    }
  });

  it('every entry carries a non-empty name and description', () => {
    for (const entry of ADR_056_INVARIANTS) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('D4 is the archive-reason runtime gate (severity:error)', () => {
    const d4 = getInvariant('ADR-056.D4');
    expect(d4).toBeDefined();
    expect(d4?.severity).toBe('error');
    expect(d4?.runtimeGate).not.toBeNull();
    expect(d4?.runtimeGate?.functionName).toBe('assertArchiveReason');
    expect(d4?.runtimeGate?.module).toBe('packages/contracts/src/tasks/archive.ts');
  });

  it('D5 points at the release-invariants registry runtime gate', () => {
    const d5 = getInvariant('ADR-056.D5');
    expect(d5).toBeDefined();
    expect(d5?.severity).toBe('warning');
    expect(d5?.runtimeGate).not.toBeNull();
    expect(d5?.runtimeGate?.functionName).toBe('runInvariants');
    expect(d5?.runtimeGate?.module).toBe('packages/core/src/release/invariants/registry.ts');
  });

  it('D6 carries a lintRule pointer to the commit-msg hook (info severity)', () => {
    const d6 = getInvariant('ADR-056.D6');
    expect(d6).toBeDefined();
    expect(d6?.severity).toBe('info');
    expect(d6?.runtimeGate).toBeNull();
    expect(d6?.lintRule?.lintScript).toBe('scripts/hooks/commit-msg-release-lint.mjs');
  });

  it('D1, D2, D3 are info-tier topology/convention decisions with no runtime gate', () => {
    for (const code of ['D1', 'D2', 'D3'] as const) {
      const entry = getInvariant(`ADR-056.${code}`);
      expect(entry).toBeDefined();
      expect(entry?.severity).toBe('info');
      expect(entry?.runtimeGate).toBeNull();
    }
  });

  it('every severity:"error" ADR-056 entry has a non-null runtimeGate', () => {
    const errorTier = ADR_056_INVARIANTS.filter((e) => e.severity === 'error');
    expect(errorTier.length).toBeGreaterThan(0);
    for (const entry of errorTier) {
      expect(entry.runtimeGate).not.toBeNull();
      if (entry.runtimeGate !== null) {
        expect(entry.runtimeGate.module.length).toBeGreaterThan(0);
        expect(entry.runtimeGate.functionName.length).toBeGreaterThan(0);
      }
    }
  });
});
