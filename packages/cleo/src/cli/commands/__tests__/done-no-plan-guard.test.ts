/**
 * `cleo done` without `--plan` must refuse plan-only flags rather than
 * complete the task as if they had been applied (T12623).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const completeRun = vi.fn();
const cliError = vi.fn();

vi.mock('../complete.js', () => ({
  completeCommandArgs: { taskId: { type: 'positional', required: true } },
  completeCommand: { run: completeRun },
}));
vi.mock('../../renderers/index.js', () => ({ cliError, cliOutput: vi.fn() }));

const { doneCommand } = await import('../done.js');

async function runDone(args: Record<string, unknown>): Promise<void> {
  await doneCommand.run?.({ args, rawArgs: [], cmd: doneCommand } as never);
}

afterEach(() => {
  completeRun.mockReset();
  cliError.mockReset();
  process.exitCode = undefined;
});

describe('cleo done without --plan', () => {
  it.each([
    [{ taskId: 'T1', satisfies: 'AC1' }, '--satisfies'],
    [{ taskId: 'T1', pr: '42' }, '--pr'],
    [{ taskId: 'T1', satisfies: 'all', pr: '42' }, '--satisfies and --pr'],
  ])('refuses %o with E_INVALID_INPUT and never completes', async (args, named) => {
    await runDone(args);
    expect(completeRun).not.toHaveBeenCalled();
    expect(cliError).toHaveBeenCalledTimes(1);
    expect(cliError.mock.calls[0]?.[0]).toContain(named);
    expect(cliError.mock.calls[0]?.[1]).toBe('E_INVALID_INPUT');
    expect(process.exitCode).toBe(2);
  });

  it('hands off to complete unchanged when no plan-only flag is given', async () => {
    await runDone({ taskId: 'T1', notes: 'n' });
    expect(cliError).not.toHaveBeenCalled();
    expect(completeRun).toHaveBeenCalledTimes(1);
    expect(completeRun.mock.calls[0]?.[0].args).toMatchObject({ taskId: 'T1', notes: 'n' });
  });
});
