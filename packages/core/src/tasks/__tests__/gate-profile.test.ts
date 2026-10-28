/**
 * Gate profiles for tasks with no code change (T13474) and the decision-only
 * route named in refusals (T12220).
 *
 * A `profile:<name>` label from a closed set makes a task owe the non-code
 * gates; it never applies over code evidence; every change to it is audited;
 * and readers see the gates it waives as not applicable, never as passed.
 *
 * @task T13474
 * @task T12220
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvidenceAtom, Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { validateLabels } from '../add.js';
import { computeTaskView } from '../compute-task-view.js';
import { decisionOnlyRouteNote, taskEvidenceKindReport } from '../evidence.js';
import { profileGateNotes } from '../gate-notes.js';
import { updateTask } from '../update.js';
import {
  declaredEvidenceKind,
  gateProfileLabelProblem,
  gateProfileOf,
  implementedCodeEvidence,
} from '../verification-policy.js';

const implemented = (atoms: EvidenceAtom[]): Task['verification'] => ({
  passed: false,
  round: 1,
  gates: { implemented: true },
  lastAgent: null,
  lastUpdated: null,
  failureLog: [],
  evidence: { implemented: { atoms, capturedAt: '2026-10-27T00:00:00Z', capturedBy: 'test' } },
});

const decision: EvidenceAtom = { kind: 'decision', decisionId: 'D900' };
const commit: EvidenceAtom = { kind: 'commit', sha: 'a'.repeat(40), shortSha: 'aaaaaaa' };

describe('rule 1: a closed set of profile names, one per task (T13474)', () => {
  it('accepts a known profile and refuses an unknown one or two at once', () => {
    expect(() => validateLabels(['profile:ops', 'infra'])).not.toThrow();
    expect(() => validateLabels(['profile:deploy'])).toThrow(
      /Unknown gate profile label 'profile:deploy'/,
    );
    expect(() => validateLabels(['profile:ops', 'profile:audit'])).toThrow(/one gate profile/);
    expect(gateProfileLabelProblem(['profile:census'])).toBeNull();
    expect(gateProfileOf({ labels: ['infra', 'profile:decision'] })).toBe('decision');
    expect(gateProfileOf({ labels: ['profile:deploy'] })).toBeNull();
  });

  it('a profiled task owes the non-code (research) gates; a bug or declared code file stays code', () => {
    expect(declaredEvidenceKind({ kind: 'work', labels: ['profile:ops'] })).toBe('research');
    expect(declaredEvidenceKind({ kind: 'bug', labels: ['profile:ops'] })).toBe('code');
    expect(
      declaredEvidenceKind({ kind: 'work', labels: ['profile:ops'], files: ['src/a.ts'] }),
    ).toBe('code');
  });
});

describe('rule 2: a profile never applies over code evidence (T13474)', () => {
  it('names the code atom: commit:, pr: or a code files: path, never a document', () => {
    expect(implementedCodeEvidence({ verification: implemented([decision]) })).toBeNull();
    expect(implementedCodeEvidence({ verification: implemented([commit]) })).toBe(
      `commit:${'a'.repeat(40)}`,
    );
    const docs: EvidenceAtom = { kind: 'files', files: [{ path: 'docs/a.md', sha256: 'x' }] };
    const code: EvidenceAtom = { kind: 'files', files: [{ path: 'src/a.ts', sha256: 'x' }] };
    expect(implementedCodeEvidence({ verification: implemented([decision, docs]) })).toBeNull();
    expect(implementedCodeEvidence({ verification: implemented([decision, code]) })).toBe(
      'files:src/a.ts',
    );
  });

  it('at verify and complete the task owes the code gates, with the reason', async () => {
    const report = await taskEvidenceKindReport(
      {
        id: 'T001',
        kind: 'work',
        labels: ['profile:ops'],
        acceptance: [],
        verification: implemented([commit]),
      },
      process.cwd(),
    );
    expect(report.kind).toBe('code');
    expect(report.reason).toMatch(/profile:ops does not apply: implemented carries commit:a{40}/);
  });
});

describe('rules 2-5 through the store (T13474)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeFile(
      join(env.cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
        lifecycle: { mode: 'off' },
        verification: { enabled: false },
      }),
    );
  });
  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  const seed = (over: Partial<Task> = {}) =>
    seedTasks(env.accessor, [
      {
        id: 'T001',
        title: 'Census of stale worktrees',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        ...over,
      },
    ]);

  it('rule 2: adding a profile to a task whose implemented carries a commit is refused', async () => {
    await seed({ verification: implemented([commit]) });
    await expect(
      updateTask({ taskId: 'T001', addLabels: ['profile:census'] }, env.tempDir, env.accessor),
    ).rejects.toThrow(/profile:census cannot be declared on T001: .*commit:a{40}/);
  });

  it('rule 1 on update: a second profile is refused', async () => {
    await seed({ labels: ['profile:ops'] });
    await expect(
      updateTask({ taskId: 'T001', addLabels: ['profile:audit'] }, env.tempDir, env.accessor),
    ).rejects.toThrow(/one gate profile/);
  });

  it('rule 3: every profile add and remove is audited', async () => {
    await seed();
    await updateTask({ taskId: 'T001', addLabels: ['profile:census'] }, env.tempDir, env.accessor);
    await updateTask(
      { taskId: 'T001', removeLabels: ['profile:census'] },
      env.tempDir,
      env.accessor,
    );
    const rows = await env.accessor.queryAuditLog({
      taskIds: ['T001'],
      actions: ['gate_profile_changed'],
    });
    expect(rows.map((r) => JSON.parse(r.detailsJson ?? 'null'))).toEqual(
      expect.arrayContaining([
        { before: null, after: 'census' },
        { before: 'census', after: null },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it('rules 4-5: show names the profile and its waived gates as not applicable, never passed', async () => {
    await seed({ labels: ['profile:census'], verification: implemented([decision]) });
    const view = await computeTaskView('T001', env.accessor);
    expect(view?.gatesStatus.testsPassed).toBe(false);
    expect(view?.gateNotes).toMatchObject({
      testsPassed: 'not applicable (profile:census)',
      qaPassed: 'not applicable (profile:census)',
    });
    // Over code evidence the profile does not apply, so nothing is waived.
    expect(
      profileGateNotes({ labels: ['profile:census'], verification: implemented([commit]) }),
    ).toEqual({});
  });
});

describe('the decision-only route is named in the refusal (T12220)', () => {
  it('names the route, that each gate is verified explicitly, and that re-verify replaces', () => {
    const note = decisionOnlyRouteNote('testsPassed', undefined);
    expect(note).toMatch(/decision-only route: record implemented as decision:<id>;note:<why>/);
    expect(note).toMatch(/each explicitly/);
    expect(note).toMatch(/replaces its atoms; it never appends/);
    expect(note).toMatch(/profile:ops/);
    expect(decisionOnlyRouteNote('implemented', undefined)).toBeNull();
  });

  it('names the commit: or pr: atom that disqualifies it', () => {
    const note = decisionOnlyRouteNote('qaPassed', { atoms: [decision, commit] });
    expect(note).toMatch(/does not apply: implemented carries commit:a{40}, a code change/);
    // It never tells an agent holding code evidence how to strip it.
    expect(note).not.toMatch(/re-record|replaces its atoms/);
  });
});
