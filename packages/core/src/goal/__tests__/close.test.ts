/**
 * `cleo goal close` (T13794): a multi-task goal closes one task and leaves the
 * other open with each AC named. Claims are re-checked at the head commit: a
 * path check that no longer holds, a report whose sha256 differs and a verifier
 * verdict never satisfy a gate; the typecheck command maps to qaPassed via
 * CLEO's own tool runner. The lock and head commit are verified; a re-run
 * writes nothing new.
 *
 * @task T13794
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GoalOutcome } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { useRealToolRunner } from '../../tasks/__tests__/real-tool-runner.js';
import { addTask } from '../../tasks/add.js';
import type { ChangeSetDeps } from '../../tasks/change-set.js';
import { closeGoal } from '../close.js';

// tool:typecheck runs a tiny real `node -e 0` through CLEO's tool runner.
useRealToolRunner();

const deps: ChangeSetDeps = {
  listMergedPrs: async () => ({ ok: true, prs: [] }),
  listPrsForCommit: async () => [],
  listTaskDocs: async () => [],
  listTaskDecisions: async () => [],
  env: {},
};

let env: TestDbEnv;
let root: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
}

beforeEach(async () => {
  env = await createTestDb();
  root = env.tempDir;
  process.env['CLEO_DIR'] = env.cleoDir;
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  writeFileSync(join(root, '.gitignore'), '.cleo/\n.cleo-home/\n.opencode/\nreports/\n');
  writeFileSync(
    join(root, '.cleo', 'project-context.json'),
    JSON.stringify({ primaryType: 'node', typecheck: { command: 'node -e 0' } }),
  );
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
});

async function seed(title: string, acceptance: string[]): Promise<string> {
  const { task } = await addTask(
    { title, description: `${title} fixture`, acceptance, skipContainmentInvariant: true },
    root,
    env.accessor,
  );
  return task.id;
}

/** Write goal.yaml with these criterion lines and tasks; return its lock. */
function writeContract(slug: string, criteria: string[], tasks: string[]): string {
  const yaml = [
    'schema: goal/v1',
    `id: ${slug}`,
    'title: close fixture',
    'intent: {verbatim: close fixture}',
    'outcome: both tasks hold',
    'non_goals: [nothing else]',
    'criteria:',
    ...criteria.map((c) => `  - ${c}`),
    'invariants: []',
    `cleo: {tasks: [${tasks.join(', ')}]}`,
    '',
  ].join('\n');
  const dir = join(root, '.opencode', 'goals', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'goal.yaml'), yaml);
  return createHash('sha256').update(yaml).digest('hex');
}

function writeOutcome(outcome: GoalOutcome): string {
  const path = join(root, 'outcome.json');
  writeFileSync(path, JSON.stringify(outcome));
  return path;
}

/** A passing vitest-shaped report; returns its path and sha256. */
function writeReport(name: string): { path: string; sha: string } {
  mkdirSync(join(root, 'reports'), { recursive: true });
  const body = JSON.stringify({
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    success: true,
    startTime: Date.now(),
    testResults: [
      {
        name: join(root, 'src', 'a.test.ts'),
        status: 'passed',
        assertionResults: [{ status: 'passed', fullName: 'a' }],
      },
    ],
  });
  const path = join(root, 'reports', name);
  writeFileSync(path, body);
  return { path, sha: createHash('sha256').update(body).digest('hex') };
}

const pass = (id: string, evidence: GoalOutcome['results'][number]['evidence']) =>
  ({ id, pass: true, by: 'host', evidence }) as const;

describe('closeGoal (T13794)', () => {
  it('closes one task, leaves the other open with named ACs; re-checks claims at head; idempotent', async () => {
    const a = await seed('task a', [
      'src/a.ts exports a = 2',
      'The a tests pass',
      'Typecheck is clean',
    ]);
    const b = await seed('task b', [
      'The copy reads well',
      'The b test passes',
      'src/a.ts says hello',
      'b report binds',
    ]);
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
    git(['commit', '-q', '-am', `${a}: change a`]);
    const head = git(['rev-parse', 'HEAD']);
    const [aAc1] = [...(await env.accessor.getAcRows(a))].sort((x, y) => x.ordinal - y.ordinal);
    const good = writeReport('a.json');
    const tampered = writeReport('b.json');
    const slug = 'close-fixture';
    const lock = writeContract(
      slug,
      [
        // canonical uuid form
        `{id: C1, statement: a.ts changed, essential: true, check: {kind: contains, path: src/a.ts, text: "a = 2"}, proves: ["${a}#${aAc1?.id}"]}`,
        `{id: C2, statement: copy reads well, essential: true, check: {kind: verifier, ask: ok?}, proves: ["${b}#AC1"]}`,
        `{id: C3, statement: b test passes, essential: true, check: {kind: command, run: "true"}, proves: ["${b}#AC2"]}`,
        `{id: C4, statement: a tests pass, essential: true, check: {kind: command, run: "vitest run"}, proves: ["${a}#AC2"]}`,
        `{id: C5, statement: typecheck clean, essential: true, check: {kind: command, run: "node -e 0"}, proves: ["${a}#AC3"]}`,
        `{id: C6, statement: says hello, essential: true, check: {kind: contains, path: src/a.ts, text: hello}, proves: ["${b}#AC3"]}`,
        `{id: C7, statement: b report, essential: true, check: {kind: command, run: "vitest run b"}, proves: ["${b}#AC4"]}`,
      ],
      [a, b],
    );
    writeFileSync(tampered.path, '{"tampered":true}');
    const outcomePath = writeOutcome({
      schema: 'goal-outcome/v1',
      goal: slug,
      lock,
      baseCommit: null,
      headCommit: head,
      results: [
        pass('C1', { kind: 'contains', paths: ['src/a.ts'] }),
        {
          id: 'C2',
          pass: true,
          by: 'verifier',
          evidence: {
            kind: 'verifier',
            verdict: 'proven',
            quotes: [{ path: 'src/a.ts', quote: 'a = 2' }],
          },
        },
        {
          id: 'C3',
          pass: false,
          by: 'host',
          detail: 'exit 1',
          evidence: { kind: 'command', command: 'true', exitCode: 1 },
        },
        pass('C4', {
          kind: 'command',
          command: 'vitest run',
          exitCode: 0,
          reportPath: good.path,
          reportSha256: good.sha,
        }),
        // The exit code is a claim; CLEO's tool runner decides qaPassed.
        pass('C5', { kind: 'command', command: 'node -e 0', exitCode: 0 }),
        // Claimed pass, but the text is not in src/a.ts at head.
        pass('C6', { kind: 'contains', paths: ['src/a.ts'] }),
        pass('C7', {
          kind: 'command',
          command: 'vitest run b',
          exitCode: 0,
          reportPath: tampered.path,
          reportSha256: tampered.sha,
        }),
      ],
    });

    const first = await closeGoal(slug, { projectRoot: root, outcomePath, deps });
    if (!first.success) throw new Error(first.error.message);
    const [ta, tb] = first.data.tasks;
    expect(ta).toMatchObject({
      taskId: a,
      satisfied: ['AC1', 'AC2', 'AC3'],
      open: [],
      ready: true,
    });
    expect(ta?.recordedGates.sort()).toEqual(['implemented', 'qaPassed', 'testsPassed']);
    expect(tb?.ready).toBe(false);
    expect(tb?.recordedGates).toEqual([]);
    expect(tb?.open.map((o) => o.alias)).toEqual(['AC1', 'AC2', 'AC3', 'AC4']);
    expect(tb?.open[0]?.blocker).toMatch(
      /verifier verdict \(a note; 1\/1 quotes found at head\); a verifier verdict never satisfies a gate/,
    );
    expect(tb?.open[1]?.blocker).toMatch(/C3 did not pass: exit 1/);
    expect(tb?.open[2]?.blocker).toMatch(/C6 does not hold at head/);
    expect(tb?.open[3]?.blocker).toMatch(/does not hash to its reportSha256/);

    const stored = (await env.accessor.loadSingleTask(a))?.verification?.evidence;
    expect(stored?.implemented?.atoms.map((x) => x.kind)).toEqual(
      expect.arrayContaining(['commit', 'files']),
    );
    expect(stored?.testsPassed?.atoms.map((x) => x.kind)).toContain('test-run');
    expect(stored?.qaPassed?.atoms).toContainEqual(
      expect.objectContaining({ kind: 'tool', tool: 'typecheck' }),
    );
    expect((await env.accessor.loadSingleTask(b))?.verification?.gates?.implemented).not.toBe(true);

    // Re-run: same verdicts, nothing new recorded.
    const again = await closeGoal(slug, { projectRoot: root, outcomePath, deps });
    if (!again.success) throw new Error(again.error.message);
    expect(again.data.tasks.map((t) => [t.taskId, t.recordedGates, t.ready])).toEqual([
      [a, [], true],
      [b, [], false],
    ]);
  });

  it('refuses an outcome whose lock, head or base commit does not match', async () => {
    const a = await seed('task a', ['src/a.ts exports a = 2']);
    const slug = 'close-fixture';
    const lock = writeContract(
      slug,
      [
        `{id: C1, statement: s, essential: true, check: {kind: verifier, ask: ok?}, proves: ["${a}#AC1"]}`,
      ],
      [a],
    );
    const head = git(['rev-parse', 'HEAD']);
    const base = { schema: 'goal-outcome/v1', goal: slug, results: [] } as const;
    const cases: Array<[GoalOutcome, RegExp]> = [
      [{ ...base, lock: '0'.repeat(64), baseCommit: null, headCommit: head }, /does not match/],
      [{ ...base, lock, baseCommit: null, headCommit: 'f'.repeat(40) }, /does not exist/],
      [{ ...base, lock, baseCommit: 'e'.repeat(40), headCommit: head }, /does not exist/],
    ];
    for (const [outcome, why] of cases) {
      const r = await closeGoal(slug, {
        projectRoot: root,
        outcomePath: writeOutcome(outcome),
        deps,
      });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.message).toMatch(why);
    }
    rmSync(join(root, 'outcome.json'));
  });
});
