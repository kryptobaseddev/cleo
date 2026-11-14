/**
 * An ops-profile data task (the axiom T3110 shape, T14557): `cleo done --plan`
 * proposes only evidence `cleo verify` records, a data receipt cited by its
 * raw path is refused with the supported route named, and the task closes
 * with a decision, its canonical document and the JSON receipt attached.
 *
 * The fixture is a real CLEO store in a real git repository, and the plan
 * previews through the real verify path (no stubbed preview).
 *
 * @task T14557
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { validateGateVerify } from '../../validation/engine-ops.js';
import { addTask } from '../add.js';
import type { ChangeSetDeps } from '../change-set.js';
import { deriveTaskEvidence } from '../done-plan.js';
import { completeTaskStrict } from '../complete.js';
import { recordTaskDone } from '../done-record.js';
import { taskEvidenceKindReport } from '../evidence.js';
import { dataReceiptRoute, isDataReceiptPath } from '../gate-notes.js';

const RECEIPT = '.capture/run-12077/manifest.private.json';

let env: TestDbEnv;
let root: string;

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

beforeEach(async () => {
  env = await createTestDb();
  root = env.tempDir;
  process.env['CLEO_DIR'] = env.cleoDir;
  rmSync(join(root, '.git'), { recursive: true, force: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(root, '.gitignore'), '.cleo/\n.cleo-home/\n');
  // The raw HTTP readback the operation captured, outside any source directory.
  mkdirSync(join(root, '.capture', 'run-12077'), { recursive: true });
  writeFileSync(join(root, RECEIPT), '{"status":200,"rows":33}\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'init']);
  const origin = `${root}-origin.git`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(root, ['remote', 'add', 'origin', origin]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  git(root, ['remote', 'set-head', 'origin', 'main']);
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
  rmSync(`${root}-origin.git`, { recursive: true, force: true });
});

/** A stored document (blob) and its sha256, as `cleo docs add` leaves one. */
function storeDoc(content: string): string {
  const sha = createHash('sha256').update(content).digest('hex');
  mkdirSync(join(root, '.cleo', 'blobs', 'blobs'), { recursive: true });
  writeFileSync(join(root, '.cleo', 'blobs', 'blobs', sha), content);
  return sha;
}

async function opsTask(): Promise<string> {
  const result = await addTask(
    {
      title: 'Requalify the order on measured lab values',
      description: 'an ops data operation with no code change',
      acceptance: ['Requalify diff shows criterion changes only', 'Missing data goes to the lab'],
      kind: 'work',
      labels: ['profile:ops'],
      skipContainmentInvariant: true,
    },
    root,
    env.accessor,
  );
  return result.task.id;
}

function docsDeps(docs: Array<{ slug: string; sha256: string }>, decisions: string[]) {
  return {
    listMergedPrs: async () => ({ ok: true as const, prs: [] }),
    listPrsForCommit: async () => [],
    listTaskDocs: async () => docs.map((d) => ({ id: `att-${d.slug}`, ...d })),
    listTaskDecisions: async () => decisions,
    env: {},
  } satisfies ChangeSetDeps;
}

describe('T14557 AC1: the plan proposes only evidence verify records', () => {
  it('an ops task with its canonical document: the planned implemented shape is accepted', async () => {
    const id = await opsTask();
    const sha = storeDoc('# requalification\n');
    const plan = await deriveTaskEvidence(id, {
      projectRoot: root,
      cwd: root,
      satisfies: 'all',
      deps: docsDeps([{ slug: 'measured-requalification', sha256: sha }], []),
    });
    expect(plan.ready, JSON.stringify([plan.blockers, plan.changeSet.warnings])).toBe(true);
    const implemented = plan.gates.find((g) => g.gate === 'implemented')?.evidence ?? '';
    expect(implemented).toMatch(/^files:[^;]+;note:Deliverable: measured-requalification/);

    const recorded = await validateGateVerify(root, {
      taskId: id,
      gateEvidence: { implemented },
    });
    expect(recorded.success, JSON.stringify(recorded)).toBe(true);
  });
});

describe('T14557 AC2/AC3: a data receipt cited by its raw path names the supported route', () => {
  it('recognises data receipts, never source or toolchain configuration', () => {
    expect(isDataReceiptPath(RECEIPT)).toBe(true);
    expect(isDataReceiptPath('reports/census.csv')).toBe(true);
    expect(isDataReceiptPath('packages/core/fixtures/a.json')).toBe(false);
    expect(isDataReceiptPath('package.json')).toBe(false);
    expect(isDataReceiptPath('tsconfig.build.json')).toBe(false);
    expect(isDataReceiptPath('src/a.ts')).toBe(false);
    expect(dataReceiptRoute('T1', 'files:src/a.ts')).toBeNull();
    expect(dataReceiptRoute('T1', 'commit:abc1234')).toBeNull();
  });

  it('verify refuses files+note with the receipt and says why the profile did not apply', async () => {
    const id = await opsTask();
    const sha = storeDoc('# requalification\n');
    const r = await validateGateVerify(root, {
      taskId: id,
      gateEvidence: {
        implemented: `files:.cleo/blobs/blobs/${sha},${RECEIPT};note:requalified on measured values`,
      },
    });
    expect(r.success).toBe(false);
    const message = r.success ? '' : r.error.message;
    expect(message).toMatch(
      /profile:ops adds its implemented combinations only while every files:/,
    );
    expect(message).toContain(`${RECEIPT} is not`);
    expect(message).toContain(`cleo docs add ${id} ${RECEIPT} --type note`);
    expect(message).toContain(`cleo done ${id} --plan`);
  });

  it('the complete-time refusal over a recorded receipt path names the same route', async () => {
    const id = await opsTask();
    const report = await taskEvidenceKindReport(
      {
        id,
        kind: 'work',
        labels: ['profile:ops'],
        acceptance: ['Requalify'],
        verification: {
          passed: false,
          round: 1,
          gates: { implemented: true },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
          evidence: {
            implemented: {
              atoms: [
                { kind: 'decision', decisionId: 'D800' },
                { kind: 'files', files: [{ path: RECEIPT, sha256: 'a'.repeat(64) }] },
              ],
              capturedAt: '2026-11-13T00:00:00Z',
              capturedBy: 'test',
            },
          },
        },
      },
      root,
      [],
      root,
      { listMergedPrHeads: async () => [] },
    );
    expect(report.kind).toBe('code');
    expect(report.reason).toContain(
      `profile:ops does not apply: implemented carries files:${RECEIPT}`,
    );
    expect(report.reason).toContain(`cleo docs add ${id} ${RECEIPT} --type note`);
  });
});

describe('T14557 AC4: an ops task closes with a decision, a canonical document and a JSON receipt', () => {
  it('records implemented from the plan and completes without testsPassed or qaPassed', async () => {
    const id = await opsTask();
    const { storeDecision } = await import('../../memory/decisions.js');
    const decision = await storeDecision(root, {
      type: 'technical',
      decision: 'Requalify on measured lab values only',
      rationale: 'Generated previews are not measurements.',
      confidence: 'high',
      confirmationState: 'accepted',
    });
    const doc = storeDoc('# requalification\n');
    // The receipt attached through cleo docs add: its stored copy, not its raw path.
    const receipt = storeDoc('{"status":200,"rows":33}\n');
    const deps = docsDeps(
      [
        { slug: 'measured-requalification', sha256: doc },
        { slug: 'readback-receipt', sha256: receipt },
      ],
      [decision.id],
    );
    const plan = await deriveTaskEvidence(id, {
      projectRoot: root,
      cwd: root,
      satisfies: 'all',
      deps,
    });
    expect(plan.ready, JSON.stringify([plan.blockers, plan.changeSet.warnings])).toBe(true);
    expect(plan.gates.map((g) => g.gate)).toEqual(['implemented']);
    const implemented = plan.gates[0]?.evidence ?? '';
    expect(implemented).toContain(`decision:${decision.id}`);
    expect(implemented).toContain(`.cleo/blobs/blobs/${doc}`);
    expect(implemented).toContain(`.cleo/blobs/blobs/${receipt}`);

    const done = await recordTaskDone(id, { projectRoot: root, cwd: root, satisfies: 'all', deps });
    expect(done.success, JSON.stringify(done)).toBe(true);
    // cleo complete: re-validates every hard atom and owes no code gate.
    const completed = await completeTaskStrict(root, id);
    expect(completed.success, JSON.stringify(completed)).toBe(true);
    const task = await env.accessor.loadSingleTask(id);
    expect(task?.status).toBe('done');
    expect(task?.verification?.gates.testsPassed).not.toBe(true);
  });
});
