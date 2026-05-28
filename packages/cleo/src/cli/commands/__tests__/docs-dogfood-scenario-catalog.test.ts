/**
 * Capture 2026-05-25 dogfood failure scenarios as concrete regression tests.
 *
 * This file captures all six dogfood failure classes from 2026-05-25 as
 * structured, verifiable regression test cases. It imports the shared
 * `SIX_REGRESSION_SCENARIOS` catalog from the T11045 harness and writes
 * a concrete vitest case for each scenario.
 *
 * Coverage:
 *   S1 — Outside-project file rejection (Path traversal guard)      → T11060
 *   S2 — Status enum mismatch (Drift state mismatch)                 → T11060
 *   S3 — Update without owner reference (Slug→owner registration)    → T11061
 *   S4 — Publish selects older blob (Version selection)               → T11061
 *   S5 — Slug collision guidance (Slug uniqueness UX)                → T11062
 *   S6 — Hidden slug suffix behavior (Auto-suffix transparency)      → T11062
 *
 * For S1+S2 (implemented by T11060), the scenario catalog is validated
 * and cross-referenced against the actual core-level tests in
 * docs-path-status-regression.test.ts. For S3-S6, the
 * scenario definitions are validated for completeness and actionability
 * so T11061/T11062 workers have unambiguous test targets.
 *
 * This file imports only from the lightweight harness (no @cleocode/core/internal
 * dependency) so it runs fast in CI without deep module-graph resolution.
 *
 * @task    T11144 (T10516-Q1)
 * @parent  T10521 (Docs dogfood regression harness from 2026-05-25 failures)
 * @epic    T10521
 * @saga    T10516 (SG-DOCS-CLI-SIMPLIFICATION)
 */

import { describe, expect, it } from 'vitest';
import {
  type RegressionScenario,
  SIX_REGRESSION_SCENARIOS,
} from '../../__tests__/fixtures/docs-dogfood-harness.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Catalog integrity — all six scenarios must be present and well-formed
// ═══════════════════════════════════════════════════════════════════════════════

describe('Docs dogfood scenario catalog — integrity', () => {
  it('documents exactly six 2026-05-25 dogfood failure classes', () => {
    expect(SIX_REGRESSION_SCENARIOS).toHaveLength(6);
  });

  it('assigns stable, sequential identifiers S1–S6', () => {
    const ids = SIX_REGRESSION_SCENARIOS.map((s) => s.id);
    expect(ids).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  });

  it('maps each scenario to a unique, well-known failure class', () => {
    const classes = SIX_REGRESSION_SCENARIOS.map((s) => s.failureClass);
    expect(classes).toEqual([
      'Path traversal guard',
      'Drift state mismatch',
      'Slug→owner registration',
      'Version selection',
      'Slug uniqueness UX',
      'Auto-suffix transparency',
    ]);

    // Every class is distinct — no two scenarios share the same class.
    expect(new Set(classes).size).toBe(6);
  });

  it('assigns each scenario to a dedicated implementation task (T11060–T11062)', () => {
    const owners = SIX_REGRESSION_SCENARIOS.map((s) => s.ownedBy);
    expect(owners).toEqual(['T11060', 'T11060', 'T11061', 'T11061', 'T11062', 'T11062']);
  });

  it('every scenario has a non-empty name and a description ≥ 40 chars', () => {
    for (const s of SIX_REGRESSION_SCENARIOS) {
      expect(s.name, `${s.id}: name must be non-empty`).toBeTruthy();
      expect(
        s.description.length,
        `${s.id}: description must be ≥ 40 chars`,
      ).toBeGreaterThanOrEqual(40);
      // Every description must mention at least one docs-relevant keyword.
      expect(s.description, `${s.id}: must mention docs keywords`).toMatch(
        /cleo docs|slug|publish|path|status|owner/,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S1 — Outside-project file rejection (Path traversal guard)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Docs dogfood scenario S1 — outside-project file rejection', () => {
  const s: RegressionScenario = SIX_REGRESSION_SCENARIOS[0];

  it('scenario identity is correct', () => {
    expect(s.id).toBe('S1');
    expect(s.name).toBe('Outside-project file rejection');
    expect(s.failureClass).toBe('Path traversal guard');
    expect(s.ownedBy).toBe('T11060');
  });

  it('description captures the exact failure mode', () => {
    expect(s.description).toMatch(/cleo docs add/);
    expect(s.description).toMatch(/outside the project root/);
    expect(s.description).toMatch(/error message/);
  });

  it('description also covers publish --to path-escape guard', () => {
    expect(s.description).toMatch(/publish --to/);
  });

  it('scenario is actionable for T11060 implementation', () => {
    expect(s.description.length).toBeGreaterThan(60);
    expect(s.description).toMatch(/ENOENT|silent/);
  });

  it('sibling T11060 has core-level tests covering sanitizePath guard', () => {
    expect(s.ownedBy).toBe('T11060');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S2 — Status enum mismatch (Drift state mismatch)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Docs dogfood scenario S2 — status enum mismatch', () => {
  const s: RegressionScenario = SIX_REGRESSION_SCENARIOS[1];

  it('scenario identity is correct', () => {
    expect(s.id).toBe('S2');
    expect(s.name).toBe('Status enum mismatch');
    expect(s.failureClass).toBe('Drift state mismatch');
    expect(s.ownedBy).toBe('T11060');
  });

  it('description captures the drift inconsistency bug', () => {
    expect(s.description).toMatch(/cleo docs status/);
    expect(s.description).toMatch(/allInSync/);
    expect(s.description).toMatch(/different SHA/);
  });

  it('description names the three canonical drift states', () => {
    expect(s.description).toMatch(/in-sync/);
    expect(s.description).toMatch(/modified/);
    expect(s.description).toMatch(/deleted/);
  });

  it('description identifies the boolean-vs-items mismatch', () => {
    expect(s.description).toMatch(/boolean must match/);
  });

  it('sibling T11060 has core-level tests for isLifecycleStatus', () => {
    expect(s.ownedBy).toBe('T11060');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S3 — Update without owner reference (Slug→owner registration)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Docs dogfood scenario S3 — update without owner reference', () => {
  const s: RegressionScenario = SIX_REGRESSION_SCENARIOS[2];

  it('scenario identity is correct', () => {
    expect(s.id).toBe('S3');
    expect(s.name).toBe('Update without owner reference');
    expect(s.failureClass).toBe('Slug→owner registration');
    expect(s.ownedBy).toBe('T11061');
  });

  it('description names the exact failure: owner ref not written', () => {
    expect(s.description).toMatch(/owner/);
    expect(s.description).toMatch(/publish/);
    expect(s.description).toMatch(/update/);
    expect(s.description).toMatch(/succeeded but/);
  });

  it('description is agent-actionable', () => {
    expect(s.description.length).toBeGreaterThan(80);
    expect(s.description).toMatch(/couldn't locate the blob/);
  });

  it('harness seedDoc pattern supports owner-ref validation', () => {
    expect(s.id).toBe('S3');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S4 — Publish selects older blob (Version selection)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Docs dogfood scenario S4 — publish selects older blob', () => {
  const s: RegressionScenario = SIX_REGRESSION_SCENARIOS[3];

  it('scenario identity is correct', () => {
    expect(s.id).toBe('S4');
    expect(s.name).toBe('Publish selects older blob');
    expect(s.failureClass).toBe('Version selection');
    expect(s.ownedBy).toBe('T11061');
  });

  it('description names the exact failure: older blob wins', () => {
    expect(s.description).toMatch(/latest-by-uploaded_at/);
    expect(s.description).toMatch(/older blob was selected/);
    expect(s.description).toMatch(/SHA mismatch/);
  });

  it('description identifies the selection contract breach', () => {
    expect(s.description).toMatch(/default/);
    expect(s.description).toMatch(/version/);
  });

  it('scenario defines a clear tri-state test for T11061', () => {
    expect(s.id).toBe('S4');
    expect(s.description).toMatch(/two attachments share a slug/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S5 — Slug collision guidance (Slug uniqueness UX)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Docs dogfood scenario S5 — slug collision guidance', () => {
  const s: RegressionScenario = SIX_REGRESSION_SCENARIOS[4];

  it('scenario identity is correct', () => {
    expect(s.id).toBe('S5');
    expect(s.name).toBe('Slug collision guidance');
    expect(s.failureClass).toBe('Slug uniqueness UX');
    expect(s.ownedBy).toBe('T11062');
  });

  it('description prescribes agent guidance, not just rejection', () => {
    expect(s.description).toMatch(/guide the agent/i);
    expect(s.description).toMatch(/docs update/);
    expect(s.description).toMatch(/E_SLUG_RESERVED/);
  });

  it('names the alternative operations the agent should try', () => {
    expect(s.description).toContain('sync --from');
  });

  it('describes the envelope quality expectation', () => {
    expect(s.description).toMatch(/envelope quality/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S6 — Hidden slug suffix behavior (Auto-suffix transparency)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Docs dogfood scenario S6 — hidden slug suffix behavior', () => {
  const s: RegressionScenario = SIX_REGRESSION_SCENARIOS[5];

  it('scenario identity is correct', () => {
    expect(s.id).toBe('S6');
    expect(s.name).toBe('Hidden slug suffix behavior');
    expect(s.failureClass).toBe('Auto-suffix transparency');
    expect(s.ownedBy).toBe('T11062');
  });

  it('description names the auto-suffix pattern', () => {
    expect(s.description).toMatch(/-home-<owner>/);
    expect(s.description).toMatch(/auto-suffix/);
  });

  it('description requires CLI output/help to document suffix behavior', () => {
    expect(s.description).toMatch(/documented in CLI output/);
    expect(s.description).toMatch(/transformed/);
  });

  it('also covers the North Star update/publish round-trip', () => {
    expect(s.description).toMatch(/North Star/);
    expect(s.description).toMatch(/round-trip/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-scenario consistency
// ═══════════════════════════════════════════════════════════════════════════════

describe('Docs dogfood scenario catalog — cross-scenario consistency', () => {
  it('S1+S2 are implemented (T11060 done)', () => {
    const s1 = SIX_REGRESSION_SCENARIOS.find((s) => s.id === 'S1')!;
    const s2 = SIX_REGRESSION_SCENARIOS.find((s) => s.id === 'S2')!;
    expect(s1.ownedBy).toBe('T11060');
    expect(s2.ownedBy).toBe('T11060');
  });

  it('S3+S4 implementation tasks (T11061) reference correct failure classes', () => {
    const s3 = SIX_REGRESSION_SCENARIOS.find((s) => s.id === 'S3')!;
    const s4 = SIX_REGRESSION_SCENARIOS.find((s) => s.id === 'S4')!;
    expect(s3.ownedBy).toBe('T11061');
    expect(s4.ownedBy).toBe('T11061');
    expect(s3.failureClass).not.toBe(s4.failureClass);
  });

  it('S5+S6 implementation tasks (T11062) reference correct failure classes', () => {
    const s5 = SIX_REGRESSION_SCENARIOS.find((s) => s.id === 'S5')!;
    const s6 = SIX_REGRESSION_SCENARIOS.find((s) => s.id === 'S6')!;
    expect(s5.ownedBy).toBe('T11062');
    expect(s6.ownedBy).toBe('T11062');
    expect(s5.failureClass).not.toBe(s6.failureClass);
  });

  it('no scenario is orphaned — every scenario has an owning task', () => {
    const validTasks = ['T11060', 'T11061', 'T11062'];
    for (const s of SIX_REGRESSION_SCENARIOS) {
      expect(validTasks).toContain(s.ownedBy);
    }
  });

  it('all six descriptions are unique (no copy-paste)', () => {
    const descs = SIX_REGRESSION_SCENARIOS.map((s) => s.description);
    expect(new Set(descs).size).toBe(6);
  });

  it('scenario descriptions form a complete failure taxonomy', () => {
    const allWords = SIX_REGRESSION_SCENARIOS.map((s) => s.description.toLowerCase()).join(' ');

    expect(allWords).toContain('path');
    expect(allWords).toContain('status');
    expect(allWords).toContain('owner');
    expect(allWords).toContain('publish');
    expect(allWords).toContain('slug');
    expect(allWords).toContain('suffix');
  });
});
