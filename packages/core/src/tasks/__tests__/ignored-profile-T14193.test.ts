/**
 * When a task's record keeps it code despite a `profile:<name>` label, the
 * refusal and `cleo done --plan` name the deciding rule and the exact file or
 * token, with the fix: correct the record, never a waiver (T14193, VidaPeps
 * T2383).
 *
 * @task T14193
 */

import type { EvidenceAtom, EvidenceValidationContext, Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { checkTaskEvidenceContext, taskEvidenceKindReport } from '../evidence.js';
import { ignoredProfileReason } from '../verification-policy.js';

type TaskRecord = Pick<Task, 'id' | 'kind' | 'files' | 'acceptance' | 'labels'>;

const task = (over: Partial<TaskRecord>): TaskRecord => ({
  id: 'T2383',
  kind: 'work',
  files: [],
  acceptance: ['Audit the order backlog'],
  labels: ['profile:audit'],
  ...over,
});

describe('ignoredProfileReason (T14193)', () => {
  it('a declared non-document file: names the file, the rule and the fix', () => {
    const why = ignoredProfileReason(task({ files: ['docs/audit.md', 'scripts/backfill.ts'] }));
    expect(why).toContain('profile:audit does not apply');
    expect(why).toContain('declares the non-document file scripts/backfill.ts');
    expect(why).toContain('declared files decide before a profile');
    expect(why).toContain('drop that entry from its files');
    expect(why).not.toMatch(/waive|override/i);
  });

  it('a criterion naming a code path: names the criterion, the token and the fix', () => {
    const why = ignoredProfileReason(
      task({ acceptance: ['Count the rows', 'Read packages/core/src/store.ts for the query'] }),
    );
    expect(why).toContain(
      'acceptance criterion AC2 names the code path packages/core/src/store.ts',
    );
    expect(why).toContain('reword that criterion');
    expect(why).not.toMatch(/waive|override/i);
  });

  it('declared files decide before criteria: the file is the one named', () => {
    const why = ignoredProfileReason(
      task({ files: ['src/a.ts'], acceptance: ['Change packages/x/y.ts'] }),
    );
    expect(why).toContain('src/a.ts');
    expect(why).not.toContain('packages/x/y.ts');
  });

  it('an unaffected profiled task, and a task with no profile, get no reason', () => {
    expect(ignoredProfileReason(task({ files: ['docs/audit.md'] }))).toBeNull();
    expect(ignoredProfileReason(task({}))).toBeNull();
    expect(ignoredProfileReason(task({ labels: [], files: ['src/a.ts'] }))).toBeNull();
  });
});

describe('where the reason surfaces (T14193)', () => {
  it('done --plan and cleo complete read it as the code-gates reason', async () => {
    const report = await taskEvidenceKindReport(
      { ...task({ files: ['scripts/backfill.ts'] }), verification: null },
      '/nonexistent',
    );
    expect(report.kind).toBe('code');
    expect(report.reason).toContain('declares the non-document file scripts/backfill.ts');
  });

  it('the implemented-gate refusal of a decision names the rule', () => {
    const context: EvidenceValidationContext = {
      task: { ...task({ files: ['scripts/backfill.ts'] }), verification: null },
      gates: ['implemented'],
      criteria: [],
    };
    const atoms: EvidenceAtom[] = [
      { kind: 'decision', decisionId: 'D900' },
      { kind: 'note', note: 'backfill done' },
    ];
    expect(checkTaskEvidenceContext(context, 'implemented', atoms)).toMatch(
      /^A research decision alone cannot implement a code-fix task: profile:audit does not apply: T2383 declares the non-document file scripts\/backfill\.ts/,
    );
  });

  it('an unaffected profiled task keeps the plain refusal-free path', async () => {
    const report = await taskEvidenceKindReport(
      { ...task({ files: ['docs/audit.md'] }), verification: null },
      '/nonexistent',
    );
    expect(String(report.reason)).not.toMatch(/does not apply/);
  });
});
