/**
 * `cleo doctor gate-text` (T14635): a text acceptance criterion stored as a
 * typed gate's JSON before T12292 refused that input is listed by a dry run
 * and converted to the typed gate by `apply`.
 *
 * @task T14635
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcceptanceGate } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  seedLegacyTextAcceptance,
  type TestDbEnv,
} from '../../store/__tests__/test-db-helper.js';
import { getNativeTasksDb, resetDbState } from '../../store/sqlite.js';
import { AC_CHANGES_AUDIT_FILE } from '../../tasks/ac-immutability.js';
import { addTask } from '../../tasks/add.js';
import { decomposeTask } from '../../tasks/decompose.js';
import { reqConvertGateText } from '../../tasks/req.js';
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
  // Tasks are filed at `implementation`, an AC-locked stage; the unlocked cases
  // run at a stage before the lock, the locked case sets it back.
  await env.accessor.updateTaskFields(task.id, { pipelineStage: 'research' });
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
        fix: null,
        terminal: false,
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
    await env.accessor.updateTaskFields(task.id, { pipelineStage: 'research' });

    const report = await scanGateTextAcceptance(env.tempDir, { apply: true });

    expect(report).toMatchObject({ found: 2, converted: 1, remaining: 1 });
    expect(report.tasks[0]?.conversions[1]).toMatchObject({
      gate: null,
      problem: expect.stringContaining('LEGACY-01'),
    });
  });

  it('a task in an AC-locked stage is listed with its fix, refused without --reason and converted with one', async () => {
    const taskId = await seedLegacyTask();
    await env.accessor.updateTaskFields(taskId, { pipelineStage: 'implementation' });

    const listed = await scanGateTextAcceptance(env.tempDir, { apply: true });
    expect(listed).toMatchObject({ found: 1, converted: 0, remaining: 1 });
    expect(listed.tasks[0]).toMatchObject({
      skipped: expect.stringContaining('locked at stage implementation'),
      fix: 'cleo doctor gate-text --apply --reason "<why the conversion is acceptable>"',
    });
    expect((await env.accessor.loadSingleTask(taskId))?.acceptance).toEqual([
      'Prose criterion stays',
      legacyText,
    ]);

    const converted = await scanGateTextAcceptance(env.tempDir, {
      apply: true,
      reason: 'legacy gate JSON becomes the gate it always meant',
    });
    expect(converted).toMatchObject({ found: 1, converted: 1, remaining: 0 });
    expect((await env.accessor.loadSingleTask(taskId))?.acceptance).toEqual([
      'Prose criterion stays',
      gate,
    ]);
    const auditPath = join(env.tempDir, AC_CHANGES_AUDIT_FILE);
    expect(existsSync(auditPath)).toBe(true);
    expect(readFileSync(auditPath, 'utf8')).toContain(taskId);

    // The task audit row carries a reversible receipt per criterion.
    const [logged] = (await env.accessor.queryAuditLog({ taskIds: [taskId] })).filter(
      (row) => row.action === 'req_gate_text_converted',
    );
    expect(JSON.stringify(logged)).toContain('legacy gate JSON becomes the gate');
    expect(JSON.stringify(logged)).toContain('oldText');
  });

  it('rows on terminal tasks are informational and never count as remaining', async () => {
    const taskId = await seedLegacyTask();
    await env.accessor.updateTaskFields(taskId, { status: 'done', pipelineStage: 'contribution' });

    const report = await scanGateTextAcceptance(env.tempDir, { apply: true });

    expect(report).toMatchObject({ found: 1, converted: 0, remaining: 0, terminal: 1 });
    expect(report.tasks[0]).toMatchObject({ terminal: true, skipped: 'task is done' });
    // The conversion itself refuses a terminal task, not only the doctor.
    await expect(
      reqConvertGateText(env.tempDir, taskId, true, { accessor: env.accessor }),
    ).rejects.toThrow(/is done; its acceptance is not rewritten/);
    expect((await env.accessor.loadSingleTask(taskId))?.acceptance).toEqual([
      'Prose criterion stays',
      legacyText,
    ]);
  });

  it('refuses a row with evidence bindings but no uid, so the bindings are not dropped', async () => {
    const taskId = await seedLegacyTask();
    const legacy = [...(await env.accessor.getAcRows(taskId))].sort(
      (a, b) => a.ordinal - b.ordinal,
    )[1];
    if (!legacy) throw new Error('seeded legacy row missing');
    getNativeTasksDb()
      ?.prepare('UPDATE tasks_task_acceptance_criteria SET uid = NULL WHERE id = ?')
      .run(legacy.id);
    await env.accessor.transaction((tx) =>
      tx.insertAcBindings([
        { id: 'binding-1', evidenceAtomId: 'atom-1', acId: legacy.id, bindingType: 'direct' },
      ]),
    );

    const report = await scanGateTextAcceptance(env.tempDir, { apply: true });

    expect(report).toMatchObject({ found: 1, converted: 0, remaining: 1 });
    expect(report.tasks[0]?.conversions[0]).toMatchObject({
      gate: null,
      problem: expect.stringContaining('no uid'),
    });
    expect(await env.accessor.getAcBindings([legacy.id])).toHaveLength(1);
  });
});
