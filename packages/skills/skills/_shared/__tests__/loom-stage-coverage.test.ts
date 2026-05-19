/**
 * LOOM-stage coverage gate (T9664).
 *
 * Enforces that every canonical LOOM lifecycle stage emitted by `cleo lifecycle`
 * has a bound skill in `packages/skills/skills/manifest.json` and that the
 * skill's entry declares a `loomStage` field equal to the lifecycle stage name
 * in underscored canonical form (the `cleo lifecycle` source-of-truth form).
 *
 * Why this exists:
 * - The lifecycle CLI is the runtime source of truth for stage names.
 * - The manifest's `dispatch_matrix.by_protocol` is the dispatch routing table.
 * - Historically those two surfaces drifted (T9568 audit found
 *   `architecture-decision` dashed in manifest vs `architecture_decision`
 *   underscored in lifecycle CLI).
 * - This test pins the contract so future drift fails CI instead of silently
 *   reaching agents at spawn time.
 *
 * @task T9664
 * @epic T9568
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const thisDir = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(thisDir, '../../manifest.json');

interface SkillEntry {
  name: string;
  protocol?: string;
  loomStage?: string;
  status?: string;
  // intentionally permissive — other fields ignored for this gate
  [key: string]: unknown;
}

interface Manifest {
  dispatch_matrix: {
    by_protocol: Record<string, string>;
  };
  skills: SkillEntry[];
}

const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

/**
 * The canonical 10 LOOM lifecycle stages emitted by `cleo lifecycle` (see
 * `packages/core/src/lifecycle/`). Underscored form is authoritative.
 * Update this constant ONLY when the lifecycle CLI itself adds or removes
 * a stage — never to silence a drift failure.
 */
const CANONICAL_LOOM_STAGES = [
  'research',
  'consensus',
  'architecture_decision',
  'specification',
  'decomposition',
  'implementation',
  'validation',
  'testing',
  'release',
  'contribution',
] as const;

/**
 * Cross-cutting protocols that live in `dispatch_matrix.by_protocol` but are
 * NOT LOOM lifecycle stages. They route by capability, not by lifecycle
 * position, and are excluded from the 10-stage gate.
 */
const CROSS_CUTTING_PROTOCOLS = new Set([
  'artifact-publish',
  'provenance',
  'agent-protocol',
]);

/**
 * Skill-name lookup keyed by the `name` field.
 */
const skillByName = new Map(manifest.skills.map((s) => [s.name, s]));

// ---------------------------------------------------------------------------
// Gate 1: every canonical stage has a binding in dispatch_matrix.by_protocol
// ---------------------------------------------------------------------------

describe('LOOM stage coverage — dispatch_matrix.by_protocol', () => {
  for (const stage of CANONICAL_LOOM_STAGES) {
    it(`stage "${stage}" is bound to a skill in dispatch_matrix.by_protocol`, () => {
      // We accept either the underscored form (canonical) or the dashed
      // legacy alias (architecture-decision) until T9672 reconciles. After
      // T9672, only the underscored key is required.
      const dashed = stage.replace(/_/g, '-');
      const skillName =
        manifest.dispatch_matrix.by_protocol[stage] ??
        manifest.dispatch_matrix.by_protocol[dashed];
      expect(
        skillName,
        `LOOM stage "${stage}" has no skill binding in manifest.dispatch_matrix.by_protocol (checked both "${stage}" and "${dashed}")`,
      ).toBeTruthy();
    });
  }
});

// ---------------------------------------------------------------------------
// Gate 2: every protocol-bound skill carries a matching loomStage frontmatter
// ---------------------------------------------------------------------------

describe('LOOM stage coverage — loomStage field on bound skills', () => {
  for (const stage of CANONICAL_LOOM_STAGES) {
    it(`bound skill for "${stage}" declares loomStage === "${stage}"`, () => {
      const dashed = stage.replace(/_/g, '-');
      const skillName =
        manifest.dispatch_matrix.by_protocol[stage] ??
        manifest.dispatch_matrix.by_protocol[dashed];
      const skill = skillName ? skillByName.get(skillName) : undefined;
      expect(skill, `skill "${skillName}" not found in manifest.skills[]`).toBeDefined();
      expect(
        skill?.loomStage,
        `skill "${skillName}" missing loomStage field; expected "${stage}"`,
      ).toBe(stage);
    });
  }
});

// ---------------------------------------------------------------------------
// Gate 3: every skill that has loomStage uses a canonical (underscored) value
// ---------------------------------------------------------------------------

describe('LOOM stage coverage — loomStage values are canonical', () => {
  const stagesSet = new Set<string>(CANONICAL_LOOM_STAGES);
  const skillsWithLoomStage = manifest.skills.filter((s) => typeof s.loomStage === 'string');

  it('at least 10 skills carry a loomStage field (one per LOOM stage)', () => {
    expect(skillsWithLoomStage.length).toBeGreaterThanOrEqual(CANONICAL_LOOM_STAGES.length);
  });

  for (const skill of skillsWithLoomStage) {
    it(`skill "${skill.name}" loomStage value "${skill.loomStage}" is a canonical LOOM stage`, () => {
      expect(stagesSet.has(skill.loomStage as string)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Gate 4: dispatch_matrix.by_protocol keys minus cross-cutting == LOOM stages
// (the union of the 10 lifecycle stages — checked allowing dashed alias for
//  architecture_decision until T9672 lands the reconcile)
// ---------------------------------------------------------------------------

describe('LOOM stage coverage — dispatch_matrix.by_protocol key set', () => {
  it('by_protocol keys minus cross-cutting protocols cover every canonical LOOM stage', () => {
    const keys = new Set(Object.keys(manifest.dispatch_matrix.by_protocol));
    const stageKeys = [...keys].filter((k) => !CROSS_CUTTING_PROTOCOLS.has(k));
    const normalized = new Set(stageKeys.map((k) => k.replace(/-/g, '_')));
    for (const stage of CANONICAL_LOOM_STAGES) {
      expect(
        normalized.has(stage),
        `LOOM stage "${stage}" not represented in dispatch_matrix.by_protocol (normalized keys: ${[...normalized].join(', ')})`,
      ).toBe(true);
    }
  });
});
