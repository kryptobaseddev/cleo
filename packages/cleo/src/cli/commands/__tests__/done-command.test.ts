/**
 * `cleo done` handler (T12623 · T12625): one envelope per call, record before
 * complete, and every stop is `E_DONE_BLOCKED` with one next step.
 *
 * Supersedes the T12623 guard test: `--satisfies` / `--pr` were refused
 * without `--plan` only until the write path existed; they now shape the
 * recorded evidence, and an invalid `--pr` is still refused before anything
 * runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const recordTaskDone = vi.fn();
const recordTasksDone = vi.fn();
const planTaskDone = vi.fn();
const dispatchRaw = vi.fn();
const cliError = vi.fn();
const cliOutput = vi.fn();

vi.mock('@cleocode/core/tasks/done-record.js', () => ({ recordTaskDone, recordTasksDone }));
vi.mock('@cleocode/core/tasks/done-plan.js', async (orig) => ({
  ...(await orig<typeof import('@cleocode/core/tasks/done-plan.js')>()),
  planTaskDone,
}));
vi.mock('@cleocode/core/paths.js', () => ({ getProjectRoot: () => '/p' }));
vi.mock('../../../dispatch/adapters/cli.js', () => ({ dispatchRaw }));
vi.mock('../../renderers/index.js', () => ({ cliError, cliOutput }));

const { doneCommand } = await import('../done.js');

async function runDone(args: Record<string, unknown>): Promise<void> {
  await doneCommand.run?.({ args, rawArgs: [], cmd: doneCommand } as never);
}

const recorded = {
  success: true,
  data: { taskId: 'T1', recordedGates: ['implemented'], plan: { big: true } },
};

afterEach(() => {
  for (const fn of [
    recordTaskDone,
    recordTasksDone,
    planTaskDone,
    dispatchRaw,
    cliError,
    cliOutput,
  ])
    fn.mockReset();
  process.exitCode = undefined;
});

describe('cleo done', () => {
  it('refuses an invalid --pr before recording anything', async () => {
    await runDone({ taskId: 'T1', pr: 'abc' });
    expect(recordTaskDone).not.toHaveBeenCalled();
    expect(cliError.mock.calls[0]?.[1]).toBe('E_INVALID_INPUT');
    expect(process.exitCode).toBe(2);
  });

  it('records with --satisfies/--pr, then completes through tasks.complete, in one envelope', async () => {
    recordTaskDone.mockResolvedValue(recorded);
    dispatchRaw.mockResolvedValue({ success: true, data: { updated: ['T1'] } });
    await runDone({ taskId: 'T1', satisfies: 'AC1,AC2', pr: '42', notes: 'n' });
    expect(recordTaskDone).toHaveBeenCalledWith('T1', {
      projectRoot: '/p',
      satisfies: ['AC1', 'AC2'],
      prNumber: 42,
    });
    expect(dispatchRaw).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'complete',
      expect.objectContaining({ taskId: 'T1', notes: 'n' }),
    );
    expect(recordTaskDone.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchRaw.mock.invocationCallOrder[0] as number,
    );
    expect(cliOutput).toHaveBeenCalledTimes(1);
    expect(cliOutput.mock.calls[0]?.[0]).toEqual({
      taskId: 'T1',
      recordedGates: ['implemented'],
      completed: true,
      complete: { updated: ['T1'] },
    });
    expect(cliError).not.toHaveBeenCalled();
  });

  it('a blocked record never completes and passes the next step through', async () => {
    recordTaskDone.mockResolvedValue({
      success: false,
      error: {
        code: 'E_DONE_BLOCKED',
        message: 'm',
        fix: 'cleo done T1 --plan --satisfies AC2',
        details: { blocker: 'ac-mapping-needed' },
      },
    });
    await runDone({ taskId: 'T1' });
    expect(dispatchRaw).not.toHaveBeenCalled();
    expect(cliError).toHaveBeenCalledWith('m', 'E_DONE_BLOCKED', {
      fix: 'cleo done T1 --plan --satisfies AC2',
      details: { blocker: 'ac-mapping-needed' },
    });
    expect(process.exitCode).toBe(1);
  });

  it('a refused completion is E_DONE_BLOCKED completion-refused, naming the recorded gates', async () => {
    recordTaskDone.mockResolvedValue(recorded);
    dispatchRaw.mockResolvedValue({
      success: false,
      error: {
        code: 'E_SESSION_REQUIRED',
        message: 'no session',
        exitCode: 7,
        fix: 'cleo session start',
      },
    });
    await runDone({ taskId: 'T1' });
    expect(cliOutput).not.toHaveBeenCalled();
    const [message, code, details] = cliError.mock.calls[0] ?? [];
    expect([message, code]).toEqual(['no session', 'E_DONE_BLOCKED']);
    expect(details.fix).toBe('cleo session start');
    expect(details.details).toMatchObject({
      blocker: 'completion-refused',
      cause: 'E_SESSION_REQUIRED',
      recordedGates: ['implemented'],
    });
    expect(process.exitCode).toBe(7);
  });

  it('--plan plans and records nothing', async () => {
    planTaskDone.mockResolvedValue({ success: true, data: { taskId: 'T1' } });
    await runDone({ taskId: 'T1', plan: true, satisfies: 'all' });
    expect(planTaskDone).toHaveBeenCalledWith('T1', { projectRoot: '/p', satisfies: 'all' });
    expect(recordTaskDone).not.toHaveBeenCalled();
    expect(dispatchRaw).not.toHaveBeenCalled();
  });

  it('several ids: one batch record, completes only the recorded tasks, reports each (T12628)', async () => {
    recordTasksDone.mockResolvedValue([
      { taskId: 'T1', result: recorded },
      {
        taskId: 'T2',
        result: {
          success: false,
          error: { code: 'E_DONE_BLOCKED', message: 'no', fix: 'cleo done T2 --plan' },
        },
      },
      { taskId: 'T3', result: { ...recorded, data: { ...recorded.data, taskId: 'T3' } } },
    ]);
    dispatchRaw.mockResolvedValue({ success: true, data: {} });
    await runDone({ taskId: 'T1', _: ['T1', 'T2', 'T3'], pr: '42' });
    expect(recordTasksDone).toHaveBeenCalledWith(['T1', 'T2', 'T3'], {
      projectRoot: '/p',
      prNumber: 42,
    });
    expect(recordTaskDone).not.toHaveBeenCalled();
    expect(dispatchRaw.mock.calls.map((c) => c[3].taskId)).toEqual(['T1', 'T3']);
    const [message, code, details] = cliError.mock.calls[0] ?? [];
    expect(code).toBe('E_DONE_PARTIAL');
    expect(message).toMatch(/1 of 3 tasks not completed: T2/);
    expect(
      details.details.results.map((r: { taskId: string; completed: boolean }) => [
        r.taskId,
        r.completed,
      ]),
    ).toEqual([
      ['T1', true],
      ['T2', false],
      ['T3', true],
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('rejects an argument that is not a task id instead of dropping it (review LOW)', async () => {
    await runDone({ taskId: 'T1', _: ['T1', 't2'] });
    expect(recordTasksDone).not.toHaveBeenCalled();
    expect(recordTaskDone).not.toHaveBeenCalled();
    expect(cliError.mock.calls[0]?.[0]).toMatch(/Not task ids: t2/);
    expect(cliError.mock.calls[0]?.[1]).toBe('E_INVALID_INPUT');
    expect(process.exitCode).toBe(2);
  });
});
