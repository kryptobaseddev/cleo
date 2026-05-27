/**
 * T11187 — Dogfood regression harness from 2026-05-25 failure patterns.
 *
 * Canonical harness-level validation for epic T10521. Validates:
 *   1. Harness infrastructure — scenario coverage, test case structure,
 *      consistency between SIX_REGRESSION_SCENARIOS and
 *      SIX_REGRESSION_TEST_CASES.
 *   2. Cross-scenario integrity — every failure class has executable
 *      test coverage at the core level.
 *
 * Core-level regression tests (slug collision S5, slug suffix S6) are
 * owned by dedicated tasks T11061 and T11062.
 *
 * AC coverage:
 *   AC1 — All six scenarios have at least one core-level test case
 *   AC2 — Test case infrastructure (SIX_REGRESSION_TEST_CASES) is self-consistent
 *   AC3 — Scenario ↔ test case mapping is complete and non-redundant
 *
 * @task T11187 (Epic T10521 · Saga T10516)
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  SIX_REGRESSION_SCENARIOS,
  SIX_REGRESSION_TEST_CASES,
  auditScenarioCoverage,
  testCasesForScenario,
} from './fixtures/docs-dogfood-harness.js';

// ═══════════════════════════════════════════════════════════════════════════════
// AC1: Harness infrastructure self-consistency
// ═══════════════════════════════════════════════════════════════════════════════

describe('T11187 AC1 — Harness infrastructure', () => {
  describe('SIX_REGRESSION_TEST_CASES', () => {
    it('has exactly 15 test cases covering all 6 scenarios', () => {
      expect(SIX_REGRESSION_TEST_CASES).toHaveLength(15);
    });

    it('auditScenarioCoverage returns empty array (all scenarios covered)', () => {
      const uncovered = auditScenarioCoverage();
      expect(uncovered, `uncovered scenarios: ${uncovered.join(', ')}`).toEqual(
        [],
      );
    });

    it('each scenario has at least 2 test cases', () => {
      for (const scenario of SIX_REGRESSION_SCENARIOS) {
        const cases = testCasesForScenario(scenario.id);
        expect(
          cases.length,
          `scenario ${scenario.id} has only ${cases.length} test case(s)`,
        ).toBeGreaterThanOrEqual(2);
      }
    });

    it('each scenario has at least one core-level test case (can run in CI)', () => {
      for (const scenario of SIX_REGRESSION_SCENARIOS) {
        const coreCases = testCasesForScenario(scenario.id).filter(
          (tc) => tc.coreLevel,
        );
        expect(
          coreCases.length,
          `scenario ${scenario.id} has 0 core-level test cases`,
        ).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('RegressionTestCase structure', () => {
    it('all test case IDs are unique', () => {
      const ids = SIX_REGRESSION_TEST_CASES.map((tc) => tc.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('all test case IDs follow RTC-S{1-6}-N pattern', () => {
      for (const tc of SIX_REGRESSION_TEST_CASES) {
        expect(tc.id).toMatch(/^RTC-S[1-6]-\d+$/);
      }
    });

    it('all test cases have non-empty description and targetModule', () => {
      for (const tc of SIX_REGRESSION_TEST_CASES) {
        expect(tc.description.length).toBeGreaterThan(10);
        expect(tc.targetModule.length).toBeGreaterThan(5);
        expect(tc.targetModule).toContain('packages/');
      }
    });

    it('all test cases are owned by T11060, T11061, or T11062', () => {
      const owners = new Set(SIX_REGRESSION_TEST_CASES.map((tc) => tc.ownedBy));
      expect(owners.has('T11060')).toBe(true);
      expect(owners.has('T11061')).toBe(true);
      expect(owners.has('T11062')).toBe(true);
      for (const owner of owners) {
        expect(['T11060', 'T11061', 'T11062']).toContain(owner);
      }
    });

    it('all test cases have valid assertionKind values', () => {
      const validKinds = new Set([
        'error-envelope',
        'value-assertion',
        'behavioral',
      ]);
      for (const tc of SIX_REGRESSION_TEST_CASES) {
        expect(validKinds.has(tc.assertionKind)).toBe(true);
      }
    });

    it('scenarioId in every test case references a real scenario', () => {
      const scenarioIds = new Set(
        SIX_REGRESSION_SCENARIOS.map((s) => s.id),
      );
      for (const tc of SIX_REGRESSION_TEST_CASES) {
        expect(
          scenarioIds.has(tc.scenarioId),
          `test case ${tc.id} references non-existent scenario ${tc.scenarioId}`,
        ).toBe(true);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC2: Scenario consistency
// ═══════════════════════════════════════════════════════════════════════════════

describe('T11187 AC2 — Scenario consistency', () => {
  it('scenarios S1-S6 have correct failure-class mapping', () => {
    expect(SIX_REGRESSION_SCENARIOS[0].failureClass).toBe(
      'Path traversal guard',
    );
    expect(SIX_REGRESSION_SCENARIOS[1].failureClass).toBe(
      'Drift state mismatch',
    );
    expect(SIX_REGRESSION_SCENARIOS[2].failureClass).toBe(
      'Slug→owner registration',
    );
    expect(SIX_REGRESSION_SCENARIOS[3].failureClass).toBe(
      'Version selection',
    );
    expect(SIX_REGRESSION_SCENARIOS[4].failureClass).toBe(
      'Slug uniqueness UX',
    );
    expect(SIX_REGRESSION_SCENARIOS[5].failureClass).toBe(
      'Auto-suffix transparency',
    );
  });

  it('S3 ownedBy is T11061 and S5 ownedBy is T11062', () => {
    expect(SIX_REGRESSION_SCENARIOS[2].ownedBy).toBe('T11061');
    expect(SIX_REGRESSION_SCENARIOS[4].ownedBy).toBe('T11062');
  });

  it('every scenario has an owner task in the test cases', () => {
    for (const scenario of SIX_REGRESSION_SCENARIOS) {
      const ownerCases = SIX_REGRESSION_TEST_CASES.filter(
        (tc) => tc.ownedBy === scenario.ownedBy,
      );
      expect(
        ownerCases.length,
        `scenario ${scenario.id} (owned by ${scenario.ownedBy}) has 0 test cases`,
      ).toBeGreaterThanOrEqual(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC3: Cross-scenario coverage audit
// ═══════════════════════════════════════════════════════════════════════════════

describe('T11187 AC3 — Cross-scenario coverage audit', () => {
  it('all 6 scenarios documented, all 15 test cases defined', () => {
    expect(SIX_REGRESSION_SCENARIOS).toHaveLength(6);
    expect(SIX_REGRESSION_TEST_CASES).toHaveLength(15);
  });

  it('coreLevel test cases cover S1-S6 (all scenarios)', () => {
    const coreCovered = new Set(
      SIX_REGRESSION_TEST_CASES.filter((tc) => tc.coreLevel).map(
        (tc) => tc.scenarioId,
      ),
    );
    expect(coreCovered.size).toBe(6);
  });

  it('non-coreLevel test cases are explicitly justified', () => {
    const nonCore = SIX_REGRESSION_TEST_CASES.filter((tc) => !tc.coreLevel);
    expect(nonCore).toHaveLength(1);
    expect(nonCore[0].id).toBe('RTC-S3-2');
  });

  it('S3 (update owner-ref) has both a core-level and a CLI-level test', () => {
    const s3Cases = testCasesForScenario('S3');
    expect(s3Cases).toHaveLength(2);
    expect(s3Cases.filter((tc) => tc.coreLevel)).toHaveLength(1);
    expect(s3Cases.filter((tc) => !tc.coreLevel)).toHaveLength(1);
  });
});
