/**
 * A graph-link failure never fails `cleo verify` (T13950, T14005): the gate is
 * recorded and the failure becomes a W_EVIDENCE_GRAPH_LINK_FAILED warning.
 *
 * @task T14005
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drainWarnings } from '../../output.js';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';
import { closeBrainDb, getBrainDb, getBrainNativeDb } from '../../store/memory-sqlite.js';
import { resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { validateGateVerify } from '../engine-ops.js';

let root: string;
let sha: string;

beforeEach(async () => {
  resetDbState();
  drainWarnings();
  root = await mkdtemp(join(tmpdir(), 'cleo-gate-graph-fail-'));
  await mkdir(join(root, '.cleo'), { recursive: true });
  await writeFile(
    join(root, '.cleo', 'config.json'),
    JSON.stringify({
      enforcement: { acceptance: { mode: 'off' } },
      verification: { enabled: true, requiredGates: ['implemented'] },
      lifecycle: { mode: 'off' },
    }),
  );
  const git = (args: string[]): string => execFileSync('git', args, { cwd: root }).toString();
  git(['init', '-q']);
  git(['config', 'user.name', 'graph-fail test']);
  git(['config', 'user.email', 'graph-fail@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'seed.ts'), 'seed\n');
  git(['add', 'seed.ts']);
  git(['commit', '-q', '-m', 'seed']);
  sha = git(['rev-parse', 'HEAD']).trim();
  const accessor = await createSqliteDataAccessor(root);
  await seedTasks(accessor, [
    {
      id: 'T500',
      title: 'Graph failure task',
      type: 'task',
      status: 'active',
      priority: 'medium',
      acceptance: ['AC1'],
      files: ['seed.ts'],
    },
  ]);
  await accessor.close();
  resetDbState();
});

afterEach(async () => {
  closeBrainDb();
  resetDbState();
  drainWarnings();
  await rm(root, { recursive: true, force: true });
});

describe('validateGateVerify with a failing graph write (T14005)', () => {
  it('records the gate and warns when the graph batch fails', async () => {
    await getBrainDb(root);
    getBrainNativeDb(root)!.exec(
      "CREATE TRIGGER t_refuse BEFORE INSERT ON brain_page_nodes BEGIN SELECT RAISE(ABORT, 'graph refused'); END",
    );
    drainWarnings();

    const result = await validateGateVerify(root, {
      taskId: 'T500',
      gate: 'implemented',
      value: true,
      evidence: `commit:${sha};files:seed.ts`,
    });

    expect(result.success).toBe(true);
    expect(
      (result.data as { verification: { gates: Record<string, boolean> } }).verification.gates,
    ).toMatchObject({ implemented: true });
    const warning = (drainWarnings() ?? []).find((w) => w.code === 'W_EVIDENCE_GRAPH_LINK_FAILED');
    expect(warning?.message).toMatch(/^Evidence accepted; graph linking failed: /);
  });
});
