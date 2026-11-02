/**
 * A gate-profiled task with no code change (an ops repair, a census, an
 * audit or measurement) proves `implemented` with its stored document and a
 * note (T14187, the T14178 repro). The plan and the gate read one table,
 * `PROFILE_GATE_EVIDENCE`; a code path keeps the base requirements.
 *
 * @task T14187
 */

import type { EvidenceAtom, Task } from '@cleocode/contracts';
import {
  formatGateRequirement,
  PROFILE_GATE_EVIDENCE,
  validateEvidenceForGate,
} from '@cleocode/contracts/evidence-atom-schema.js';
import { describe, expect, it } from 'vitest';
import { checkGateEvidenceMinimum } from '../evidence.js';
import { evidenceProfileOf } from '../verification-policy.js';

const STORED = '.cleo/attachments/sha256/36/fe01aa.md';

const docAndNote = (path: string): EvidenceAtom[] => [
  { kind: 'files', files: [{ path, sha256: 'a'.repeat(64) }] },
  { kind: 'note', note: 'Deliverable: modernize-store-6k-timing' },
];

const task = (labels: string[], acceptance: string[] = ['Measure the timing']) =>
  ({ kind: 'work', labels, acceptance }) satisfies Pick<Task, 'kind' | 'labels' | 'acceptance'>;

describe('PROFILE_GATE_EVIDENCE: one table for the plan and the gate (T14187)', () => {
  it('ops, census and audit accept files+note for implemented; decision does not', () => {
    const atoms = [{ kind: 'files' as const }, { kind: 'note' as const }];
    expect(validateEvidenceForGate('implemented', atoms).ok).toBe(false);
    for (const profile of ['ops', 'census', 'audit'] as const) {
      expect(validateEvidenceForGate('implemented', atoms, profile).ok).toBe(true);
      expect(PROFILE_GATE_EVIDENCE[profile].implemented).toEqual([['files', 'note']]);
    }
    expect(validateEvidenceForGate('implemented', atoms, 'decision').ok).toBe(false);
  });

  it('the refusal names the profile combination when one applies', () => {
    expect(formatGateRequirement('implemented', 'audit')).toMatch(/\[files AND note\]$/);
    expect(formatGateRequirement('implemented')).not.toContain('[files AND note]');
  });
});

describe('the gate side: checkGateEvidenceMinimum with the task profile (T14187)', () => {
  it('the T14178 shape: an audit task with its stored document and a note is implemented', () => {
    const profile = evidenceProfileOf(task(['profile:audit']));
    expect(profile).toBe('audit');
    expect(checkGateEvidenceMinimum('implemented', docAndNote(STORED), profile)).toBeNull();
  });

  it('without a profile the same atoms are refused with the base requirements', () => {
    expect(checkGateEvidenceMinimum('implemented', docAndNote(STORED), null)).toMatch(
      /^Gate 'implemented' requires evidence: \[commit AND files\]/,
    );
  });

  it('a code path keeps the base requirements, so a profiled code change owes a commit or PR', () => {
    expect(checkGateEvidenceMinimum('implemented', docAndNote('src/store.ts'), 'audit')).toMatch(
      /requires evidence/,
    );
  });

  it('a profiled task whose criteria name code is code, so no profile applies', () => {
    expect(evidenceProfileOf(task(['profile:ops'], ['Fix packages/core/src/store.ts']))).toBeNull();
    expect(evidenceProfileOf(task([]))).toBeNull();
  });
});
