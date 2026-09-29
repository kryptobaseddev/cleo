/**
 * T12689 — component-PR credit LOWs:
 *  - a deletion-only PR implements with `pr:` + `note:` (it has no bytes to
 *    hash), and only when every change it made is a deletion;
 *  - each `implemented` criterion link says whether a path the criterion
 *    names is among the artifacts, or rests on the agent's claim.
 *
 * @task T12689
 */

import type { EvidenceAtom, EvidenceValidationContext } from '@cleocode/contracts';
import { parseEvidenceString, validateEvidenceForGate } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { checkTaskEvidenceContext, composeGateEvidence } from '../evidence.js';

const AC1 = '11111111-1111-4111-8111-111111111111';
const AC2 = '22222222-2222-4222-8222-222222222222';

function context(criteria: Array<{ id: string; text: string }>): EvidenceValidationContext {
  return {
    task: { id: 'T1', kind: 'work', labels: [], files: [], acceptance: [] },
    gates: ['implemented'],
    criteria: criteria.map((c) => ({ ...c, updatedAt: '2026-09-29T00:00:00Z' })),
  };
}

const satisfies = (uuid: string): EvidenceAtom =>
  ({ kind: 'satisfies', targetTaskId: 'T1', resolvedAcUuid: uuid }) as EvidenceAtom;

const pr = (changedPaths: string[], deletedPaths?: string[]): EvidenceAtom => ({
  kind: 'pr',
  prNumber: 41,
  componentPrNumber: 42,
  mergeCommitSha: 'a'.repeat(40),
  mergedAt: '2026-09-29T00:00:00Z',
  successCount: 1,
  totalChecks: 1,
  changedPaths,
  taskId: 'T1',
  ...(deletedPaths ? { deletedPaths } : {}),
});

const note: EvidenceAtom = { kind: 'note', note: 'Component PR #42 only deleted: old.ts' };

describe('a deletion-only PR implements without files', () => {
  it('pr + note meets the implemented minimum', () => {
    const atoms = parseEvidenceString('pr:42@41;note:Component PR #42 only deleted: old.ts');
    expect(validateEvidenceForGate('implemented', atoms)).toMatchObject({ ok: true });
  });

  it('accepted in context when every change is a deletion, criterion linked', () => {
    const ctx = context([{ id: AC1, text: 'Remove old.ts' }]);
    expect(
      checkTaskEvidenceContext(ctx, 'implemented', [
        pr(['old.ts'], ['old.ts']),
        note,
        satisfies(AC1),
      ]),
    ).toBeNull();
  });

  it('refused when the PR also changed a file that files: must pin', () => {
    const ctx = context([{ id: AC1, text: 'Remove old.ts' }]);
    expect(
      checkTaskEvidenceContext(ctx, 'implemented', [
        pr(['old.ts', 'a.ts'], ['old.ts']),
        note,
        satisfies(AC1),
      ]),
    ).toMatch(/requires files evidence/);
  });

  it('refused for a PR that recorded no deletions', () => {
    const ctx = context([{ id: AC1, text: 'Change a.ts' }]);
    expect(
      checkTaskEvidenceContext(ctx, 'implemented', [pr(['a.ts']), note, satisfies(AC1)]),
    ).toMatch(/requires files evidence/);
  });
});

describe('criterion links say what supports them', () => {
  it('files when the criterion names an inspected path; self-attested otherwise', () => {
    const ctx = context([
      { id: AC1, text: 'Change src/a.ts to return 2' },
      { id: AC2, text: 'The output is friendlier' },
    ]);
    const atoms: EvidenceAtom[] = [
      { kind: 'commit', sha: 'b'.repeat(40) } as EvidenceAtom,
      { kind: 'files', files: [{ path: 'src/a.ts', sha256: 'c'.repeat(64) }] } as EvidenceAtom,
      satisfies(AC1),
      satisfies(AC2),
    ];
    const evidence = composeGateEvidence(atoms, 'test', undefined, undefined, ctx, 'implemented');
    const basis = Object.fromEntries(
      (evidence.scope?.criteria ?? []).map((link) => [link.criterionId, link.basis]),
    );
    expect(basis).toEqual({ [AC1]: 'files', [AC2]: 'self-attested' });
  });

  it('a criterion naming a path the evidence does not touch is self-attested', () => {
    const ctx = context([{ id: AC1, text: 'Change src/other.ts' }]);
    const atoms: EvidenceAtom[] = [
      { kind: 'files', files: [{ path: 'src/a.ts', sha256: 'c'.repeat(64) }] } as EvidenceAtom,
      satisfies(AC1),
    ];
    const evidence = composeGateEvidence(atoms, 'test', undefined, undefined, ctx, 'implemented');
    expect(evidence.scope?.criteria[0]?.basis).toBe('self-attested');
  });

  it('a deletion-only PR supports a criterion naming the deleted path', () => {
    const ctx = context([{ id: AC1, text: 'Remove src/old.ts' }]);
    const evidence = composeGateEvidence(
      [pr(['src/old.ts'], ['src/old.ts']), note, satisfies(AC1)],
      'test',
      undefined,
      undefined,
      ctx,
      'implemented',
    );
    expect(evidence.scope?.criteria[0]?.basis).toBe('files');
  });
});
