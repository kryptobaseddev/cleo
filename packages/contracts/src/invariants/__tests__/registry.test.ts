/**
 * Unit tests for the central invariants registry (T10335).
 *
 * The registry is the SSoT for system-wide invariants surfaced via the
 * SG-SUBSTRATE-RECONCILIATION saga. Downstream R-tasks (R2 ORC codes,
 * R4 CI gate, R5 release refactor, R6 doctor audit, R8 docs renderer)
 * all key off the metadata shape asserted below.
 *
 * @epic T10327 — E-INVARIANT-REGISTRY-SSOT
 * @saga T10326 — SG-SUBSTRATE-RECONCILIATION
 * @task T10335 — R1: registry + ADR-073 I1-I8
 */

import { describe, expect, it } from 'vitest';
import {
  E_SAGA_INVARIANT_VIOLATION_I3,
  E_SAGA_INVARIANT_VIOLATION_I5,
  E_SAGA_INVARIANT_VIOLATION_I7,
} from '../../errors.js';
import {
  ADR_073_INVARIANTS,
  getInvariant,
  getInvariantsByAdr,
  INVARIANTS_REGISTRY,
  type RegisteredInvariant,
} from '../index.js';

/**
 * Map from ADR-073 invariant code → expected LAFS error code in
 * `packages/contracts/src/errors.ts`. R2/R4 will extend this mapping with
 * ADR-070 ORC codes once they land — for now the registry only knows
 * about the three saga-runtime guards.
 *
 * NOTE: I4 / I6 / I8 deliberately have no error code today — they are
 * UNENFORCED warnings. The R4 CI gate (T10338) is the right home for the
 * strict "every error has an error code" assertion; this test only
 * validates the subset we already have wired.
 */
const ADR_073_ERROR_CODE_MAP: Record<string, string> = {
  I3: E_SAGA_INVARIANT_VIOLATION_I3,
  I5: E_SAGA_INVARIANT_VIOLATION_I5,
  I7: E_SAGA_INVARIANT_VIOLATION_I7,
};

describe('INVARIANTS_REGISTRY — central registry shape', () => {
  it('exposes at least 8 entries (ADR-073 I1-I8 baseline)', () => {
    const entries = Object.values(INVARIANTS_REGISTRY);
    expect(entries.length).toBeGreaterThanOrEqual(8);
  });

  it('registers all eight ADR-073 invariants under predictable keys', () => {
    for (let i = 1; i <= 8; i++) {
      const key = `ADR-073.I${i}`;
      expect(INVARIANTS_REGISTRY[key]).toBeDefined();
      expect(INVARIANTS_REGISTRY[key]?.adr).toBe('ADR-073');
      expect(INVARIANTS_REGISTRY[key]?.code).toBe(`I${i}`);
    }
  });

  it('every entry carries a non-empty name and description', () => {
    for (const entry of Object.values(INVARIANTS_REGISTRY)) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('every severity:"error" invariant has a non-null runtimeGate', () => {
    const errorTier: RegisteredInvariant[] = Object.values(INVARIANTS_REGISTRY).filter(
      (e) => e.severity === 'error',
    );
    expect(errorTier.length).toBeGreaterThan(0);
    for (const entry of errorTier) {
      expect(entry.runtimeGate).not.toBeNull();
      // Triple is fully populated when present.
      if (entry.runtimeGate !== null) {
        expect(entry.runtimeGate.module.length).toBeGreaterThan(0);
        expect(entry.runtimeGate.functionName.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('getInvariant — lookup helper', () => {
  it('returns the ADR-073.I3 entry with the expected runtime guard', () => {
    const i3 = getInvariant('ADR-073.I3');
    expect(i3).toBeDefined();
    expect(i3?.adr).toBe('ADR-073');
    expect(i3?.code).toBe('I3');
    expect(i3?.severity).toBe('error');
    expect(i3?.runtimeGate?.functionName).toBe('assertSagaInvariantI3');
    expect(i3?.runtimeGate?.module).toBe('packages/core/src/sagas/enforcement.ts');
  });

  it('returns undefined for an unregistered key', () => {
    expect(getInvariant('ADR-999.X1')).toBeUndefined();
  });
});

describe('getInvariantsByAdr — per-ADR enumeration', () => {
  it('returns all eight ADR-073 invariants in declaration order', () => {
    const adr073 = getInvariantsByAdr('ADR-073');
    expect(adr073).toHaveLength(8);
    expect(adr073.map((e) => e.code)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8']);
  });

  it('returns an empty array for an unknown ADR', () => {
    expect(getInvariantsByAdr('ADR-DOES-NOT-EXIST')).toEqual([]);
  });
});

describe('ADR_073_INVARIANTS — exported convenience binding', () => {
  it('matches the entries surfaced via getInvariantsByAdr', () => {
    expect(ADR_073_INVARIANTS).toHaveLength(8);
    const enumerated = getInvariantsByAdr('ADR-073');
    expect(enumerated).toHaveLength(ADR_073_INVARIANTS.length);
    for (let i = 0; i < ADR_073_INVARIANTS.length; i++) {
      expect(enumerated[i]?.code).toBe(ADR_073_INVARIANTS[i]?.code);
    }
  });
});

describe('error-code cross-reference (subset — R4 T10338 owns full strict gate)', () => {
  it('every ADR-073 invariant with a runtimeGate has a known LAFS error code', () => {
    // TODO(T10338 / R4): replace this targeted subset with a strict registry-wide
    // assertion that walks every severity:"error" entry and confirms a matching
    // LAFS error code (E_<ADR>_INVARIANT_VIOLATION_<CODE>) exists in errors.ts.
    const adr073 = getInvariantsByAdr('ADR-073');
    for (const entry of adr073) {
      if (entry.runtimeGate !== null) {
        const expected = ADR_073_ERROR_CODE_MAP[entry.code];
        expect(expected).toBeDefined();
        expect(typeof expected).toBe('string');
      }
    }
  });
});
