/**
 * `cleo verify --fresh` — the flag form of `CLEO_EVIDENCE_FRESH=1` (T12964).
 *
 * The cache bypass was reachable only through an environment variable, which
 * agents rarely discover. The flag sets that same variable before dispatch, so
 * every `runToolCached` call in this process re-runs instead of reusing an
 * entry, and the variable keeps working on its own.
 *
 * @task T12964
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyCommand } from '../verify.js';

/** Run `verifyCommand` with dispatch stubbed; returns the env value seen at dispatch. */
async function freshSeenAtDispatch(cliArgs: Record<string, unknown>): Promise<string | undefined> {
  let seen: string | undefined;
  const adapter = await import('../../../dispatch/adapters/cli.js');
  const spy = vi.spyOn(adapter, 'dispatchFromCli').mockImplementation(async () => {
    seen = process.env['CLEO_EVIDENCE_FRESH'];
    return { meta: {} as never, success: true, data: {} };
  });
  try {
    await verifyCommand.run?.({
      args: cliArgs as never,
      cmd: verifyCommand as never,
      rawArgs: [] as never,
    } as never);
  } finally {
    spy.mockRestore();
  }
  return seen;
}

describe('cleo verify --fresh (T12964)', () => {
  const original = process.env['CLEO_EVIDENCE_FRESH'];
  afterEach(() => {
    if (original === undefined) delete process.env['CLEO_EVIDENCE_FRESH'];
    else process.env['CLEO_EVIDENCE_FRESH'] = original;
  });

  it('declares --fresh as a boolean flag that names the env var it mirrors', () => {
    expect(verifyCommand.args?.fresh?.type).toBe('boolean');
    expect(verifyCommand.args?.fresh?.description).toMatch(/CLEO_EVIDENCE_FRESH/);
  });

  it('sets CLEO_EVIDENCE_FRESH=1 before an evidence write dispatches', async () => {
    delete process.env['CLEO_EVIDENCE_FRESH'];
    const seen = await freshSeenAtDispatch({
      taskId: 'T1',
      gate: 'testsPassed',
      evidence: 'tool:test',
      fresh: true,
      value: 'true',
    });
    expect(seen).toBe('1');
  });

  it('leaves the cache on without the flag', async () => {
    delete process.env['CLEO_EVIDENCE_FRESH'];
    const seen = await freshSeenAtDispatch({
      taskId: 'T1',
      gate: 'testsPassed',
      evidence: 'tool:test',
      value: 'true',
    });
    expect(seen).toBeUndefined();
  });

  it('keeps an already-set CLEO_EVIDENCE_FRESH working on its own', async () => {
    process.env['CLEO_EVIDENCE_FRESH'] = '1';
    const seen = await freshSeenAtDispatch({
      taskId: 'T1',
      gate: 'testsPassed',
      evidence: 'tool:test',
      value: 'true',
    });
    expect(seen).toBe('1');
  });

  it('documents tool:test-affected in the --evidence help', () => {
    expect(verifyCommand.args?.evidence?.description).toMatch(/tool:test-affected/);
  });
});
