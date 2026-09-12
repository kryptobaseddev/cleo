/**
 * Tests for the per-kind lifecycle requirements SSoT (gh#494, gh#1215).
 *
 * CLEO's epic pipeline was calibrated for design-bearing code work and applied
 * to every epic regardless of what the epic is. A documentation epic, a spike
 * or a release epic hit the same wall: a child with complete, honest evidence
 * could not complete until the parent had been walked through five stages that
 * describe nothing about the work. The only escape was four
 * `cleo lifecycle skip --reason` calls plus a `lifecycle start`, per epic —
 * each writing an audit record asserting a deliberate bypass, which trains
 * everyone to read the audit trail as noise.
 *
 * The issue proposed a new `doc` kind that skips the stages. That encodes an
 * exception; the next non-code work type would need another. This table
 * answers the general question on the axis that already exists (ADR-066).
 *
 * @task T12140 (gh#494)
 */

import { KIND_LIFECYCLE_REQUIREMENTS, type TaskKind } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { requiresStagedPipeline, stagedPipelineRationale } from '../kind-requirements.js';

const ALL_KINDS: TaskKind[] = ['work', 'research', 'experiment', 'bug', 'spike', 'release'];

describe('gh#494 — every kind declares its requirement explicitly', () => {
  it('covers every TaskKind with no gaps', () => {
    // Adding a kind must force a decision, not inherit one silently.
    for (const kind of ALL_KINDS) {
      expect(KIND_LIFECYCLE_REQUIREMENTS[kind], `${kind} missing`).toBeDefined();
    }
    expect(Object.keys(KIND_LIFECYCLE_REQUIREMENTS).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('gives every kind a non-empty rationale', () => {
    // The rationale is surfaced in errors, so the rule is legible where it fires.
    for (const kind of ALL_KINDS) {
      expect(stagedPipelineRationale(kind).length, `${kind}`).toBeGreaterThan(20);
    }
  });
});

describe('gh#494 — work keeps the ceremony; kinds that are not staged design work do not', () => {
  it('work requires the staged pipeline', () => {
    // The default. The stages exist for exactly this case and are not weakened.
    expect(requiresStagedPipeline('work')).toBe(true);
  });

  it.each([
    'bug',
    'research',
    'spike',
    'experiment',
    'release',
  ] as const)('%s does not require the staged pipeline', (kind) => {
    expect(requiresStagedPipeline(kind)).toBe(false);
  });
});

describe('gh#494 — a missing kind must never be a way to opt out', () => {
  it('treats null, undefined and an unknown kind as work', () => {
    // The conservative default. If a kind is absent the answer is "full
    // ceremony", never "no ceremony" — otherwise omitting a field becomes the
    // cheapest way to skip the pipeline, which is the failure this replaces.
    expect(requiresStagedPipeline(null)).toBe(true);
    expect(requiresStagedPipeline(undefined)).toBe(true);
    expect(requiresStagedPipeline('not-a-kind' as TaskKind)).toBe(true);
  });

  it('falls back to work rationale for an unknown kind', () => {
    expect(stagedPipelineRationale(null)).toBe(KIND_LIFECYCLE_REQUIREMENTS.work.rationale);
  });
});
