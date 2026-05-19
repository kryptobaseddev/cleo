/**
 * ADR-link gate for LOOM-stage skills (T9665).
 *
 * Enforces two invariants on every canonical LOOM-stage skill in
 * `packages/skills/skills/manifest.json`:
 *
 *   1. The skill entry declares a non-empty `adrRefs[]` array of ADR IDs.
 *   2. Every ADR id in the array resolves to a real file under `.cleo/adrs/`.
 *
 * The mapping of (stage -> required adrRefs minimum) is the authoritative
 * source-of-truth defined in `docs/skills/loom-coverage-matrix.md` under
 * the "ADR Bindings Section". When that doc updates, this test updates.
 *
 * @task T9665
 * @epic T9568
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const thisDir = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(thisDir, '../../manifest.json');
const adrDir = resolve(thisDir, '../../../../../.cleo/adrs');

interface SkillEntry {
  name: string;
  loomStage?: string;
  adrRefs?: string[];
  [key: string]: unknown;
}

interface Manifest {
  skills: SkillEntry[];
}

const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

/**
 * The canonical 10 LOOM lifecycle stages — underscored form is authoritative.
 * Must match `cleo lifecycle --help` output.
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
 * Required ADR-id minimums per stage. The matrix doc may extend each entry;
 * this gate only enforces the floor.
 */
const REQUIRED_ADR_REFS: Record<(typeof CANONICAL_LOOM_STAGES)[number], string[]> = {
  research: ['ADR-023', 'ADR-070'],
  consensus: ['ADR-015', 'ADR-023'],
  architecture_decision: ['ADR-053', 'ADR-070'],
  specification: ['ADR-014', 'ADR-023'],
  decomposition: ['ADR-066', 'ADR-073'],
  implementation: ['ADR-070', 'ADR-062'],
  validation: ['ADR-051', 'ADR-023'],
  testing: ['ADR-051', 'ADR-061'],
  release: ['ADR-053', 'ADR-063', 'ADR-065'],
  contribution: ['ADR-015', 'ADR-053'],
};

/**
 * Build a set of ADR-id prefixes from .cleo/adrs/. Each filename starts
 * with `ADR-NNN-...`; we extract the prefix before the second dash.
 */
function loadAdrIdSet(): Set<string> {
  const files = readdirSync(adrDir);
  const ids = new Set<string>();
  for (const file of files) {
    const match = file.match(/^(ADR-\d{3})-/);
    if (match) ids.add(match[1]);
  }
  return ids;
}

const adrIds = loadAdrIdSet();
const skillsByStage = new Map<string, SkillEntry>();
for (const s of manifest.skills) {
  if (typeof s.loomStage === 'string') {
    skillsByStage.set(s.loomStage, s);
  }
}

// ---------------------------------------------------------------------------
// Gate 1: every LOOM-stage skill declares a non-empty adrRefs[]
// ---------------------------------------------------------------------------

describe('LOOM ADR links — adrRefs[] declared on every LOOM-stage skill', () => {
  for (const stage of CANONICAL_LOOM_STAGES) {
    it(`stage "${stage}" skill carries a non-empty adrRefs[]`, () => {
      const skill = skillsByStage.get(stage);
      expect(skill, `no skill found with loomStage="${stage}"`).toBeDefined();
      expect(
        Array.isArray(skill?.adrRefs),
        `skill ${skill?.name} adrRefs is not an array`,
      ).toBe(true);
      expect(
        (skill?.adrRefs ?? []).length,
        `skill ${skill?.name} adrRefs is empty`,
      ).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Gate 2: every adrRef resolves to a real file under .cleo/adrs/
// ---------------------------------------------------------------------------

describe('LOOM ADR links — every adrRefs entry resolves to .cleo/adrs/<id>-*.md', () => {
  it('.cleo/adrs/ exists and was loaded', () => {
    expect(existsSync(adrDir), `.cleo/adrs/ not found at ${adrDir}`).toBe(true);
    expect(adrIds.size).toBeGreaterThan(0);
  });

  for (const stage of CANONICAL_LOOM_STAGES) {
    const skill = skillsByStage.get(stage);
    const refs = skill?.adrRefs ?? [];
    for (const ref of refs) {
      it(`stage "${stage}" skill ${skill?.name} references real ADR file "${ref}"`, () => {
        expect(
          adrIds.has(ref),
          `${ref} not found under .cleo/adrs/ — known prefixes: ${[...adrIds].sort().join(', ')}`,
        ).toBe(true);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Gate 3: required ADR floor per stage is met
// ---------------------------------------------------------------------------

describe('LOOM ADR links — required ADR floor met per stage', () => {
  for (const stage of CANONICAL_LOOM_STAGES) {
    const required = REQUIRED_ADR_REFS[stage];
    const skill = skillsByStage.get(stage);
    const refs = new Set(skill?.adrRefs ?? []);
    for (const requiredAdr of required) {
      it(`stage "${stage}" includes required ADR "${requiredAdr}" in adrRefs`, () => {
        expect(
          refs.has(requiredAdr),
          `skill ${skill?.name} for stage ${stage} missing required ADR ${requiredAdr} (has: ${[...refs].join(', ')})`,
        ).toBe(true);
      });
    }
  }
});
