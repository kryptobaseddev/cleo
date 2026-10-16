/**
 * `cleo goal draft` (T13793): typed gates become host checks that prove their
 * AC, free text becomes a verifier check, manual gates a human check, and the
 * draft never overwrites an existing goal.yaml.
 *
 * @task T13793
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcceptanceGate } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../../tasks/add.js';
import { reqAdd } from '../../tasks/req.js';
import { draftGoal } from '../draft.js';

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

describe('draftGoal (T13793)', () => {
  it('maps typed gates to host checks with proves, free text to verifier, manual to human', async () => {
    const id = await seed(
      'goal draft fixture',
      ['The error message names the task'],
      [
        {
          kind: 'test',
          command: 'pnpm exec vitest run',
          args: ['a.test.ts'],
          expect: 'pass',
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

    expect(path).toBe(
      join(env.tempDir, '.opencode', 'goals', `${id}-${other}`.toLowerCase(), 'goal.yaml'),
    );
    expect(contract.cleo).toEqual({ tasks: [{ id }, { id: other }] });
    expect(contract.criteria.map((c) => [c.check.kind, c.proves])).toEqual([
      ['verifier', [`${id}#AC1`]],
      ['command', [`${id}#AC2`]],
      ['command', [`${id}#AC3`]],
      ['file', [`${id}#AC4`]],
      ['contains', [`${id}#AC4`]],
      ['human', [`${id}#AC5`]],
      ['verifier', [`${other}#AC1`]],
    ]);
    expect(contract.criteria[1]?.check).toEqual({
      kind: 'command',
      run: 'pnpm exec vitest run a.test.ts',
      expect: { exit: 0 },
    });
    expect(contract.criteria[2]?.check).toEqual({
      kind: 'command',
      run: 'node -e 0',
      expect: { exit: 0 },
    });
    expect(contract.invariants.map((i) => i.check.kind === 'command' && i.check.run)).toEqual([
      'biome check',
      'tsc -b',
    ]);
    expect(contract.protect).toContain('.cleo/**');
    expect(contract.budget).toEqual({ turns: 20, wallMs: 3_600_000 });

    const yaml = parse(readFileSync(path, 'utf8'));
    expect(yaml.schema).toBe('goal/v1');
    expect(yaml.budget).toEqual({ turns: 20, wall: '60m' });
    expect(yaml.criteria[0].proves).toEqual([`${id}#AC1`]);
  });

  it('refuses to overwrite an existing goal.yaml and never touches it', async () => {
    const id = await seed('overwrite fixture', ['Something holds'], []);
    const out = join(env.tempDir, 'goal.yaml');
    writeFileSync(out, 'owner edits\n');
    const result = await draftGoal([id], { projectRoot: env.tempDir, out });
    expect(result.success).toBe(false);
    expect(readFileSync(out, 'utf8')).toBe('owner edits\n');
    expect(existsSync(join(env.tempDir, '.opencode'))).toBe(false);
  });
});
