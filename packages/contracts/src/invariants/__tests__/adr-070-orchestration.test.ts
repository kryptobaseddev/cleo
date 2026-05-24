/**
 * Unit tests for the ADR-070 ORC-### orchestration invariants (T10336).
 *
 * The ORC codes are the Orchestrator / Lead / Worker behavioural contract
 * surfaced through the central INVARIANTS_REGISTRY. The tests below assert:
 *
 * 1. At least 10 ORC-### entries are registered (we ship 14).
 * 2. ORC-012 (the only ORC rule with a hard-enforced dispatch gate today)
 *    points at the `enforceThinAgent` function in
 *    `packages/core/src/orchestration/thin-agent.ts`.
 * 3. Every `severity:'warning'` entry with `runtimeGate: null` carries
 *    explanatory `description` text — the gap MUST be documented, not
 *    silent.
 * 4. ORC keys are emitted under the `ADR-070.` prefix in declaration
 *    order and are merged into the central registry.
 *
 * @epic T10327 — E-INVARIANT-REGISTRY-SSOT
 * @saga T10326 — SG-SUBSTRATE-RECONCILIATION
 * @task T10336 — R2: enumerate ADR-070 ORC codes + register
 */

import { describe, expect, it } from 'vitest';
import {
  ADR_070_INVARIANT_COUNT,
  ADR_070_INVARIANTS,
  ADR_070_MIN_ENTRIES,
} from '../adr-070-orchestration.js';
import {
  getInvariant,
  getInvariantsByAdr,
  INVARIANTS_REGISTRY,
  type RegisteredInvariant,
} from '../index.js';

/**
 * Minimum ORC-### entry count required by AC1 — "Inventory ~ORC-001
 * through ~ORC-020". We ship 14 today; the floor is 10 so future
 * removals trip the gate before silently dropping coverage.
 */
const MIN_ORC_ENTRIES = 10;

/**
 * The ORC entry that has a hard-enforced dispatch-time guard today.
 * Other entries either prompt-time (skill text) or filed-but-unshipped
 * (ORC-010 / ORC-011 → T10278 / T10279).
 */
const HARD_ENFORCED_ORC_CODE = 'ORC-012';

/**
 * Expected runtime-gate module + function for ORC-012. Asserting both
 * fields prevents silent drift if the thin-agent module is renamed or
 * the export is shadowed.
 */
const ORC_012_RUNTIME_GATE = {
  module: 'packages/core/src/orchestration/thin-agent.ts',
  functionName: 'enforceThinAgent',
} as const;

describe('ADR_070_INVARIANTS — enumeration shape', () => {
  it('exposes at least 10 ORC-### entries', () => {
    expect(ADR_070_INVARIANTS.length).toBeGreaterThanOrEqual(MIN_ORC_ENTRIES);
  });

  it('keeps ADR_070_INVARIANT_COUNT in sync with the array length', () => {
    expect(ADR_070_INVARIANT_COUNT).toBe(ADR_070_INVARIANTS.length);
  });

  it('declares ADR_070_MIN_ENTRIES at or above the AC1 floor', () => {
    expect(ADR_070_MIN_ENTRIES).toBeGreaterThanOrEqual(MIN_ORC_ENTRIES);
    expect(ADR_070_MIN_ENTRIES).toBeLessThanOrEqual(ADR_070_INVARIANTS.length);
  });

  it('every entry sets adr="ADR-070" and a non-empty ORC-#### code', () => {
    for (const entry of ADR_070_INVARIANTS) {
      expect(entry.adr).toBe('ADR-070');
      expect(entry.code).toMatch(/^ORC-\d{3}$/);
    }
  });

  it('every entry carries a non-empty name and description', () => {
    for (const entry of ADR_070_INVARIANTS) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('codes are unique across the ADR-070 enumeration', () => {
    const codes = ADR_070_INVARIANTS.map((e) => e.code);
    const uniqueCodes = new Set(codes);
    expect(uniqueCodes.size).toBe(codes.length);
  });
});

describe('ADR-070 ORC-012 — thin-agent dispatch gate (hard-enforced)', () => {
  it('points at enforceThinAgent in packages/core/src/orchestration/thin-agent.ts', () => {
    const entry = ADR_070_INVARIANTS.find((e) => e.code === HARD_ENFORCED_ORC_CODE);
    expect(entry).toBeDefined();
    expect(entry?.severity).toBe('error');
    expect(entry?.runtimeGate).not.toBeNull();
    expect(entry?.runtimeGate?.module).toBe(ORC_012_RUNTIME_GATE.module);
    expect(entry?.runtimeGate?.functionName).toBe(ORC_012_RUNTIME_GATE.functionName);
  });

  it('is reachable via INVARIANTS_REGISTRY["ADR-070.ORC-012"]', () => {
    const fromRegistry = INVARIANTS_REGISTRY['ADR-070.ORC-012'];
    expect(fromRegistry).toBeDefined();
    expect(fromRegistry?.runtimeGate?.functionName).toBe(ORC_012_RUNTIME_GATE.functionName);
  });
});

describe('ADR-070 gap documentation — warning + runtimeGate:null entries', () => {
  it('every warning entry with runtimeGate:null carries explanatory description text', () => {
    const gaps: RegisteredInvariant[] = ADR_070_INVARIANTS.filter(
      (e) => e.severity === 'warning' && e.runtimeGate === null,
    );

    // We expect at least the prompt-only ORC entries (ORC-001..003, 008, 009)
    // plus the filed-but-unshipped depth/lead entries (ORC-010 / ORC-011).
    expect(gaps.length).toBeGreaterThanOrEqual(5);

    // Each gap MUST explain WHY no runtime gate exists. We probe for the
    // documented surface markers ("UNENFORCED", "Prompt-time",
    // "FILED but UNSHIPPED" — and the related verb forms). At least one of
    // these phrases is required so the R6 doctor audit can rely on the
    // description as a human-readable gap explanation.
    const gapMarkers = ['UNENFORCED', 'prompt-time', 'Prompt-time', 'UNSHIPPED', 'unshipped'];
    for (const entry of gaps) {
      const hasMarker = gapMarkers.some((m) => entry.description.includes(m));
      expect(hasMarker, `Entry ${entry.code} description is missing a gap marker`).toBe(true);
      // Sanity check: description is substantive, not a stub.
      expect(entry.description.length).toBeGreaterThanOrEqual(80);
    }
  });

  it('filed-but-unshipped ORC-010 / ORC-011 reference their tracking tasks', () => {
    const orc010 = ADR_070_INVARIANTS.find((e) => e.code === 'ORC-010');
    const orc011 = ADR_070_INVARIANTS.find((e) => e.code === 'ORC-011');
    expect(orc010?.description).toContain('T10278');
    expect(orc011?.description).toContain('T10279');
  });
});

describe('central registry — ADR-070 entries merged via index.ts', () => {
  it('every ADR-070 entry is reachable via getInvariant("ADR-070.<code>")', () => {
    for (const entry of ADR_070_INVARIANTS) {
      const key = `ADR-070.${entry.code}`;
      const fromRegistry = getInvariant(key);
      expect(fromRegistry, `Missing registry entry for ${key}`).toBeDefined();
      expect(fromRegistry?.code).toBe(entry.code);
    }
  });

  it('getInvariantsByAdr("ADR-070") returns every entry in declaration order', () => {
    const adr070 = getInvariantsByAdr('ADR-070');
    expect(adr070).toHaveLength(ADR_070_INVARIANTS.length);
    for (let i = 0; i < ADR_070_INVARIANTS.length; i++) {
      expect(adr070[i]?.code).toBe(ADR_070_INVARIANTS[i]?.code);
    }
  });

  it('does not collide with ADR-073 entries under the merged key space', () => {
    const adr070Keys = ADR_070_INVARIANTS.map((e) => `ADR-070.${e.code}`);
    const adr073Keys = getInvariantsByAdr('ADR-073').map((e) => `ADR-073.${e.code}`);
    const intersection = adr070Keys.filter((k) => adr073Keys.includes(k));
    expect(intersection).toEqual([]);
  });
});

describe('ADR-070 severity:"error" entries — runtime gate invariant', () => {
  it('every error-tier entry has a non-null runtimeGate (R4 T10338 strict gate)', () => {
    const errorTier: RegisteredInvariant[] = ADR_070_INVARIANTS.filter(
      (e) => e.severity === 'error',
    );
    expect(errorTier.length).toBeGreaterThan(0);
    for (const entry of errorTier) {
      expect(
        entry.runtimeGate,
        `Error-tier entry ${entry.code} missing runtimeGate`,
      ).not.toBeNull();
      if (entry.runtimeGate !== null) {
        expect(entry.runtimeGate.module.length).toBeGreaterThan(0);
        expect(entry.runtimeGate.functionName.length).toBeGreaterThan(0);
      }
    }
  });
});
