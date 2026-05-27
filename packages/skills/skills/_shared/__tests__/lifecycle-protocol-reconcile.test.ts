/**
 * Lifecycle-protocol reconcile gate (T9672).
 *
 * Asserts the SET equality:
 *
 *   SET( cleo lifecycle stages )
 *   ==
 *   SET( manifest.dispatch_matrix.by_protocol keys )
 *     − { "artifact-publish", "provenance", "agent-protocol" }   # cross-cutting
 *
 * No normalization, no dashed-alias allowance. This is the strict gate that
 * lands together with the manifest rename `architecture-decision` →
 * `architecture_decision` so that a future drift fails CI.
 *
 * @task T9672
 * @epic T9568
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const thisDir = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(thisDir, '../../manifest.json');

interface Manifest {
  dispatch_matrix: {
    by_protocol: Record<string, string>;
    by_keyword: Record<string, string>;
  };
}

const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

/**
 * The canonical 10 LOOM lifecycle stages emitted by `cleo lifecycle --help`.
 * Underscored form is authoritative — see `packages/core/src/lifecycle/`.
 */
const LIFECYCLE_STAGES = [
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
 * not LOOM lifecycle stages.
 */
const CROSS_CUTTING_PROTOCOLS = new Set([
  'artifact-publish',
  'provenance',
  'agent-protocol',
]);

describe('lifecycle ↔ protocol reconcile (T9672)', () => {
  const byProtocolKeys = new Set(Object.keys(manifest.dispatch_matrix.by_protocol));
  const stageOnlyKeys = new Set(
    [...byProtocolKeys].filter((k) => !CROSS_CUTTING_PROTOCOLS.has(k)),
  );
  const expected = new Set<string>(LIFECYCLE_STAGES);

  it('every cleo lifecycle stage is present as a strict (underscored) key in dispatch_matrix.by_protocol', () => {
    for (const stage of LIFECYCLE_STAGES) {
      expect(
        byProtocolKeys.has(stage),
        `lifecycle stage "${stage}" missing from dispatch_matrix.by_protocol — keys: ${[...byProtocolKeys].sort().join(', ')}`,
      ).toBe(true);
    }
  });

  it('dispatch_matrix.by_protocol contains no surplus stage-like keys', () => {
    for (const key of stageOnlyKeys) {
      expect(
        expected.has(key),
        `dispatch_matrix.by_protocol has key "${key}" which is not a cleo lifecycle stage and not a known cross-cutting protocol`,
      ).toBe(true);
    }
  });

  it('the dashed legacy form "architecture-decision" is NOT a dispatch_matrix.by_protocol key', () => {
    expect(byProtocolKeys.has('architecture-decision')).toBe(false);
  });

  it('the dashed legacy form "architecture-decision" IS preserved as a keyword alias', () => {
    const keywordKeys = Object.keys(manifest.dispatch_matrix.by_keyword);
    const adrLine = keywordKeys.find((k) => k.includes('adr') && k.includes('formalize'));
    expect(
      adrLine,
      `expected the ct-adr-recorder keyword dispatch line to exist; keys: ${keywordKeys.join(', ')}`,
    ).toBeDefined();
    expect(
      (adrLine ?? '').includes('architecture-decision'),
      `architecture-decision keyword alias must be retained in ${adrLine}`,
    ).toBe(true);
  });

  it('the underscored canonical form "architecture_decision" maps to ct-adr-recorder', () => {
    expect(manifest.dispatch_matrix.by_protocol.architecture_decision).toBe('ct-adr-recorder');
  });

  it('the by_protocol stage-only key set is exactly equal to the lifecycle stage set', () => {
    expect([...stageOnlyKeys].sort()).toEqual([...expected].sort());
  });
});
