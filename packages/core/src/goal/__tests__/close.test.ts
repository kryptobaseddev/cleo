/**
 * `cleo goal close` (T13794): a multi-task goal closes one task and leaves the
 * other open with each AC named; a verifier verdict never satisfies a gate;
 * the lock and head commit are verified; a re-run writes nothing new.
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
import { addTask } from '../../tasks/add.js';
import type { ChangeSetDeps } from '../../tasks/change-set.js';
import { closeGoal } from '../close.js';

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
  writeFileSync(join(root, '.gitignore'), '.cleo/\n.cleo-home/\n.opencode/\n');
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

/** Write goal.yaml for two tasks and return its lock. */
function writeContract(slug: string, a: string, b: string): string {
  const yaml = [
    'schema: goal/v1',
    `id: ${slug}`,
    'title: close fixture',
    'intent: {verbatim: close fixture}',
    'outcome: both tasks hold',
    'non_goals: [nothing else]',
    'criteria:',
    `  - {id: C1, statement: a.ts changed, essential: true, check: {kind: contains, path: src/a.ts, text: "a = 2"}, proves: ["${a}#AC1"]}`,
    `  - {id: C2, statement: copy reads well, essential: true, check: {kind: verifier, ask: ok?}, proves: ["${b}#AC1"]}`,
    `  - {id: C3, statement: b test passes, essential: true, check: {kind: command, run: "true"}, proves: ["${b}#AC2"]}`,
    'invariants: []',
    `cleo: {tasks: [${a}, ${b}]}`,
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

describe('closeGoal (T13794)', () => {
  it('closes one task and leaves the other open with named ACs; idempotent on re-run', async () => {
    const a = await seed('task a', ['src/a.ts exports a = 2']);
    const b = await seed('task b', ['The copy reads well', 'The b test passes']);
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
    git(['commit', '-q', '-am', `${a}: change a`]);
    const head = git(['rev-parse', 'HEAD']);
    const slug = 'close-fixture';
    const lock = writeContract(slug, a, b);
    const outcomePath = writeOutcome({
      schema: 'goal-outcome/v1',
      goal: slug,
      lock,
      baseCommit: null,
      headCommit: head,
      results: [
        { id: 'C1', pass: true, by: 'host', evidence: { kind: 'contains', paths: ['src/a.ts'] } },
        {
          id: 'C2',
          pass: true,
          by: 'verifier',
          evidence: {
            kind: 'verifier',
            verdict: 'proven',
            quotes: [{ path: 'src/a.ts', quote: 'a' }],
          },
        },
        {
          id: 'C3',
          pass: false,
          by: 'host',
          detail: 'exit 1',
          evidence: { kind: 'command', command: 'true', exitCode: 1 },
        },
      ],
    });

    const first = await closeGoal(slug, { projectRoot: root, outcomePath, deps });
    if (!first.success) throw new Error(first.error.message);
    const [ta, tb] = first.data.tasks;
    expect(ta).toMatchObject({
      taskId: a,
      recordedGates: ['implemented'],
      satisfied: ['AC1'],
      open: [],
      ready: true,
    });
    expect(tb?.ready).toBe(false);
    expect(tb?.recordedGates).toEqual([]);
    expect(tb?.open.map((o) => o.alias)).toEqual(['AC1', 'AC2']);
    expect(tb?.open[0]?.blocker).toMatch(
      /verifier verdict never satisfies implemented or testsPassed/,
    );
    expect(tb?.open[1]?.blocker).toMatch(/C3 did not pass: exit 1/);

    const stored = await env.accessor.loadSingleTask(a);
    const atoms = stored?.verification?.evidence?.implemented?.atoms.map((x) => x.kind);
    expect(atoms).toEqual(expect.arrayContaining(['commit', 'files']));
    expect((await env.accessor.loadSingleTask(b))?.verification?.gates?.implemented).not.toBe(true);

    // Re-run: same verdicts, nothing new recorded.
    const again = await closeGoal(slug, { projectRoot: root, outcomePath, deps });
    if (!again.success) throw new Error(again.error.message);
    expect(again.data.tasks.map((t) => [t.taskId, t.recordedGates, t.ready])).toEqual([
      [a, [], true],
      [b, [], false],
    ]);
  });

  it('refuses an outcome whose lock or head commit does not match', async () => {
    const a = await seed('task a', ['src/a.ts exports a = 2']);
    const b = await seed('task b', ['x', 'y']);
    const slug = 'close-fixture';
    const lock = writeContract(slug, a, b);
    const base = { schema: 'goal-outcome/v1', goal: slug, baseCommit: null, results: [] } as const;
    const badLock = await closeGoal(slug, {
      projectRoot: root,
      outcomePath: writeOutcome({
        ...base,
        lock: '0'.repeat(64),
        headCommit: git(['rev-parse', 'HEAD']),
      }),
      deps,
    });
    expect(badLock.success).toBe(false);
    if (!badLock.success) expect(badLock.error.message).toMatch(/does not match/);
    const badHead = await closeGoal(slug, {
      projectRoot: root,
      outcomePath: writeOutcome({ ...base, lock, headCommit: 'f'.repeat(40) }),
      deps,
    });
    expect(badHead.success).toBe(false);
    if (!badHead.success) expect(badHead.error.message).toMatch(/does not exist/);
    rmSync(join(root, 'outcome.json'));
  });
});
