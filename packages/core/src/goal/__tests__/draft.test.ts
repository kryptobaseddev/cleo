/**
 * `cleo goal draft` (T13793): typed gates become checks never weaker than the
 * gate, each proving its AC by canonical uuid; free text becomes a verifier
 * check, manual gates a human check; writes stay in the project and never
 * overwrite an existing goal.yaml.
 *
 * @task T13793
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcceptanceGate, GoalCommandCheck } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../../tasks/add.js';
import { reqAdd } from '../../tasks/req.js';
import { buildGoalDraft, draftGoal } from '../draft.js';

let env: TestDbEnv;

beforeEach(async () => {
  env = await createTestDb();
  process.env['CLEO_DIR'] = env.cleoDir;
  writeFileSync(
    join(env.cleoDir, 'project-context.json'),
    JSON.stringify({
      primaryType: 'node',
      lint: { command: 'biome check' },
      typecheck: { command: 'tsc -b' },
    }),
  );
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
});

async function seed(title: string, acceptance: string[], gates: AcceptanceGate[]): Promise<string> {
  const { task } = await addTask(
    {
      title,
      description: `${title} fixture`,
      acceptance,
      skipContainmentInvariant: true,
      size: 'small',
    },
    env.tempDir,
    env.accessor,
  );
  for (const gate of gates) await reqAdd(env.tempDir, task.id, gate, env.accessor);
  return task.id;
}

async function rowIds(id: string): Promise<string[]> {
  return [...(await env.accessor.getAcRows(id))]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((r) => r.id);
}

describe('draftGoal (T13793)', () => {
  it('maps expressible gates to host checks, others to the gate itself, proving by uuid', async () => {
    const id = await seed(
      'goal draft fixture',
      ['The error message names the task'],
      [
        {
          kind: 'test',
          command: 'pnpm exec vitest run',
          args: ['a.test.ts'],
          expect: 'pass',
          req: 'R-TEST',
          description: 'a passes',
        },
        { kind: 'command', cmd: 'node', args: ['-e', '0'], description: 'node runs' },
        {
          kind: 'file',
          path: 'src/a.ts',
          assertions: [{ type: 'exists' }, { type: 'contains', value: 'x' }],
          description: 'a.ts has x',
        },
        { kind: 'manual', prompt: 'Does the copy read well?', description: 'copy review' },
      ],
    );
    const other = await seed('second task', ['Docs updated'], []);
    const result = await draftGoal([id, other], { projectRoot: env.tempDir });
    if (!result.success) throw new Error(result.error.message);
    const { contract, path } = result.data;
    const [ac1, ac2, ac3, ac4, ac5] = await rowIds(id);
    const [otherAc1] = await rowIds(other);

    expect(
      path.endsWith(join('.opencode', 'goals', `${id}-${other}`.toLowerCase(), 'goal.yaml')),
    ).toBe(true);
    expect(contract.cleo).toEqual({ tasks: [{ id }, { id: other }] });
    expect(contract.criteria.map((c) => [c.check.kind, c.proves])).toEqual([
      ['verifier', [`${id}#${ac1}`]],
      ['command', [`${id}#${ac2}`]],
      ['command', [`${id}#${ac3}`]],
      ['file', [`${id}#${ac4}`]],
      ['contains', [`${id}#${ac4}`]],
      ['human', [`${id}#${ac5}`]],
      ['verifier', [`${other}#${otherAc1}`]],
    ]);
    // expect:'pass' scans output, which goal/v1 cannot: the gate runs as itself.
    expect(contract.criteria[1]?.check).toEqual({
      kind: 'command',
      run: `cleo verify ${id} --run --req R-TEST --field /data/passed`,
      expect: { exit: 0, stdout_regex: '^true\\s*$' },
      timeout: 1860,
    });
    expect(contract.criteria[2]?.check).toEqual({
      kind: 'command',
      run: 'node -e 0',
      expect: { exit: 0 },
      timeout: 300,
    });
    // Readable statements: the gate description, not its JSON.
    expect(contract.criteria.map((c) => c.statement).slice(1, 4)).toEqual([
      'a passes',
      'node runs',
      'a.ts has x',
    ]);
    expect(contract.invariants.map((i) => i.check.kind === 'command' && i.check.run)).toEqual([
      'biome check',
      'tsc -b',
    ]);
    expect(contract.protect).toContain('.cleo/**');
    expect(contract.budget).toEqual({ turns: 20, wallMs: 3_600_000 });

    const yaml = parse(readFileSync(path, 'utf8'));
    expect(yaml.schema).toBe('goal/v1');
    expect(yaml.budget).toEqual({ turns: 20, wall: '60m' });
    expect(yaml.criteria[0].proves).toEqual([`${id}#${ac1}`]);
  });

  it('never weakens a gate: lint defaults, deadline, env, advisory, inexpressible gates', async () => {
    const id = await seed(
      'weakening fixture',
      [],
      [
        { kind: 'lint', tool: 'prettier', expect: 'noErrors', description: ' ' },
        {
          kind: 'lint',
          tool: 'clippy',
          expect: 'clean',
          req: 'R-CLIPPY',
          description: 'clippy clean',
        },
        {
          kind: 'test',
          command: 'node t.js',
          expect: 'exit0',
          timeoutMs: 900_000,
          env: { CI: '1' },
          cwd: 'pkg',
          description: 'slow test',
        },
        { kind: 'command', cmd: 'node', stderrMatches: 'ok', description: 'stderr says ok' },
        {
          kind: 'file',
          path: 'a.ts',
          assertions: [{ type: 'matches', regex: 'x', flags: 'i' }],
          req: 'R-FILE',
          description: 'a.ts matches x/i',
          advisory: true,
        },
      ],
    );
    const result = await draftGoal([id], { projectRoot: env.tempDir });
    if (!result.success) throw new Error(result.error.message);
    const [prettier, clippy, slow, stderr, file] = result.data.contract.criteria;
    // Full executable + default args from the gate runner, never a bare binary.
    expect((prettier?.check as GoalCommandCheck).run).toBe('prettier --check .');
    expect(prettier?.statement).toBe('prettier reports no errors');
    // clippy 'clean' scans for ^error: goal/v1 cannot, so it runs as the gate.
    expect((clippy?.check as GoalCommandCheck).run).toBe(
      `cleo verify ${id} --run --req R-CLIPPY --field /data/passed`,
    );
    expect(slow?.check).toEqual({
      kind: 'command',
      run: 'cd pkg && env CI=1 node t.js',
      expect: { exit: 0 },
      timeout: 900,
    });
    // No host form and no REQ-ID: a verifier asks, which never satisfies a gate at close.
    expect(stderr?.check.kind).toBe('verifier');
    expect(file?.check.kind).toBe('command');
    expect(file?.essential).toBe(false);
  });

  it('confines --out to <id>/goal.yaml inside the project', async () => {
    const id = await seed('out fixture', ['Something holds'], []);
    const named = await draftGoal([id], {
      projectRoot: env.tempDir,
      out: 'goals/my-goal/goal.yaml',
    });
    if (!named.success) throw new Error(named.error.message);
    expect(named.data.contract.id).toBe('my-goal');
    for (const out of [
      'goals/my-goal/other.yaml',
      'goals/Bad_Name/goal.yaml',
      '../escape/goal.yaml',
    ]) {
      expect((await draftGoal([id], { projectRoot: env.tempDir, out })).success).toBe(false);
    }
    const outside = mkdtempSync(join(tmpdir(), 'goal-outside-'));
    try {
      mkdirSync(join(env.tempDir, '.opencode'), { recursive: true });
      symlinkSync(outside, join(env.tempDir, '.opencode', 'goals'));
      const linked = await draftGoal([id], { projectRoot: env.tempDir });
      expect(linked.success).toBe(false);
      if (!linked.success) expect(linked.error.message).toMatch(/outside the project/);
      expect(existsSync(join(outside, id.toLowerCase()))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect((await draftGoal(['t1', id], { projectRoot: env.tempDir })).success).toBe(false);
  });

  it('never cuts a task id in the slug', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `T100000${i}`);
    const tasks = ids.map((id) => ({
      task: { id, title: id, description: '', size: null, acceptance: [] },
      rows: [],
    }));
    const slug = buildGoalDraft(tasks, [], { root: env.tempDir }).id;
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.split('-').every((part) => ids.map((i) => i.toLowerCase()).includes(part))).toBe(
      true,
    );
  });

  it('refuses to overwrite an existing goal.yaml and never touches it', async () => {
    const id = await seed('overwrite fixture', ['Something holds'], []);
    const out = join(env.tempDir, 'goals', 'kept', 'goal.yaml');
    mkdirSync(join(env.tempDir, 'goals', 'kept'), { recursive: true });
    writeFileSync(out, 'owner edits\n');
    const result = await draftGoal([id], { projectRoot: env.tempDir, out: 'goals/kept/goal.yaml' });
    expect(result.success).toBe(false);
    expect(readFileSync(out, 'utf8')).toBe('owner edits\n');
  });
});
