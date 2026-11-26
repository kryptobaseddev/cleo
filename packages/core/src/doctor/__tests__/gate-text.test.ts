/**
 * `cleo doctor gate-text` (T14635): a text acceptance criterion stored as a
 * typed gate's JSON before T12292 refused that input is listed by a dry run
 * and converted to the typed gate by `apply`.
 *
 * @task T14635
 */

import type { AcceptanceGate } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  seedLegacyTextAcceptance,
  type TestDbEnv,
} from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../../tasks/add.js';
import { decomposeTask } from '../../tasks/decompose.js';
import { scanGateTextAcceptance } from '../gate-text.js';

let env: TestDbEnv;

const gate: AcceptanceGate = {
  kind: 'test',
  req: 'LEGACY-01',
  description: 'Legacy harness passes',
  command: 'node',
  args: ['legacy.mjs'],
  expect: 'exit0',
};
// Key order differs from the canonical form, as a hand-typed gate would.
const legacyText = JSON.stringify({ description: gate.description, ...gate });

beforeEach(async () => {
  env = await createTestDb();
  process.env['CLEO_DIR'] = env.cleoDir;
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
});

async function seedLegacyTask(): Promise<string> {
  const { task } = await addTask(
    {
      title: 'Legacy gate task',
      description: 'Holds a typed gate stored as text',
      acceptance: ['Prose criterion stays'],
      skipContainmentInvariant: true,
    },
    env.tempDir,
    env.accessor,
  );
  await seedLegacyTextAcceptance(env.accessor, task.id, legacyText);
  return task.id;
}

describe('doctor gate-text (T14635)', () => {
  it('dry run lists the seeded legacy row and writes nothing', async () => {
    const taskId = await seedLegacyTask();
    const rowsBefore = await env.accessor.getAcRows(taskId);

    const report = await scanGateTextAcceptance(env.tempDir);

    expect(report).toMatchObject({ applied: false, found: 1, converted: 0, remaining: 1 });
    expect(report.tasks).toEqual([
      {
        taskId,
        status: 'pending',
        conversions: [{ index: 1, original: legacyText, gate, problem: null }],
        applied: 0,
        skipped: null,
      },
    ]);
    expect((await env.accessor.loadSingleTask(taskId))?.acceptance).toEqual([
      'Prose criterion stays',
      legacyText,
    ]);
    expect(await env.accessor.getAcRows(taskId)).toEqual(rowsBefore);
  });

  it('apply converts the row to a typed gate in place, after which decompose no longer hits the gate-text refusal', async () => {
    const taskId = await seedLegacyTask();
    const [prose, legacy] = [...(await env.accessor.getAcRows(taskId))].sort(
      (a, b) => a.ordinal - b.ordinal,
    );
    await expect(decomposeTask({ taskId }, env.tempDir, env.accessor)).rejects.toThrow(
      /typed gate object/,
    );

    const report = await scanGateTextAcceptance(env.tempDir, { apply: true });
    expect(report).toMatchObject({ applied: true, found: 1, converted: 1, remaining: 0 });

    expect((await env.accessor.loadSingleTask(taskId))?.acceptance).toEqual([
      'Prose criterion stays',
      gate,
    ]);
    const rows = [...(await env.accessor.getAcRows(taskId))].sort((a, b) => a.ordinal - b.ordinal);
    expect(rows[0]).toEqual(prose);
    expect(rows[1]).toMatchObject({
      ordinal: legacy?.ordinal,
      kind: 'evidence_bound',
      sourceKey: 'evidence:LEGACY-01',
    });
    expect(JSON.parse(rows[1]?.text ?? '')).toEqual(gate);

    // Idempotent: nothing is left to find.
    expect(await scanGateTextAcceptance(env.tempDir, { apply: true })).toMatchObject({
      found: 0,
      remaining: 0,
    });
    // The typed gate is not text, so decompose refuses for the documented
    // non-text reason rather than the gate-JSON input refusal.
    await expect(decomposeTask({ taskId }, env.tempDir, env.accessor)).rejects.toThrow(
      /non-text acceptance row/,
    );
  });

  it('reports a gate that fails req add checks and leaves it as text', async () => {
    const { task } = await addTask(
      {
        title: 'Duplicate REQ task',
        description: 'Typed gate and legacy text share a REQ-ID',
        acceptance: ['Prose criterion stays'],
        skipContainmentInvariant: true,
      },
      env.tempDir,
      env.accessor,
    );
    await seedLegacyTextAcceptance(env.accessor, task.id, legacyText);
    await seedLegacyTextAcceptance(
      env.accessor,
      task.id,
      legacyText.replace('legacy.mjs', 'b.mjs'),
    );

    const report = await scanGateTextAcceptance(env.tempDir, { apply: true });

    expect(report).toMatchObject({ found: 2, converted: 1, remaining: 1 });
    expect(report.tasks[0]?.conversions[1]).toMatchObject({
      gate: null,
      problem: expect.stringContaining('LEGACY-01'),
    });
  });
});
