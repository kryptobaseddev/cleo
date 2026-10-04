/**
 * The CLI adapter settles best-effort writes before an error exit (T13164).
 *
 * `dispatchFromCli` printed the error envelope and called `process.exit` at
 * once, and `dispatchRaw` handed a failure to callers that exit through
 * `handleRawError`. Either way a pending hook dispatch (the work-capture BRAIN
 * write, an adapter's native hook) was killed. Both now settle tracked work
 * first. A ResponseComplete hook that finishes 30 ms later stands in for a
 * pending write.
 *
 * @task T13164
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hooks } from '@cleocode/core/hooks/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../cli/renderers/index.js', () => ({
  cliOutput: vi.fn(),
  cliError: vi.fn(),
}));

import { cliError } from '../../../cli/renderers/index.js';
import { dispatchFromCli, dispatchRaw, resetCliDispatcher } from '../cli.js';

/** Register a ResponseComplete hook that finishes after 30 ms, recording into `order`. */
function slowResponseHook(order: string[]): () => void {
  return hooks.register({
    id: 't13164-slow-response-hook',
    event: 'ResponseComplete',
    priority: 1,
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('hook-done');
    },
  });
}

describe('CLI adapter error exit settles pending hooks (T13164)', () => {
  let project: string;
  let unregister: (() => void) | undefined;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cleo-error-exit-settle-'));
    mkdirSync(join(project, '.cleo'));
    mkdirSync(join(project, '.git'));
    vi.stubEnv('CLEO_ROOT', project);
    resetCliDispatcher();
  });
  afterEach(() => {
    unregister?.();
    unregister = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(project, { recursive: true, force: true });
  });

  it('dispatchFromCli exits only after the pending hook finishes', async () => {
    const order: string[] = [];
    unregister = slowResponseHook(order);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      order.push(`exit:${String(code)}`);
      return undefined as never;
    });

    await dispatchFromCli('query', 'tasks', 'nonexistent', {}, { command: 'test' });

    expect(cliError).toHaveBeenCalled();
    expect(order).toHaveLength(2);
    expect(order[0]).toBe('hook-done');
    expect(order[1]).toMatch(/^exit:\d+$/);
  });

  it('dispatchRaw settles the pending hook before handing back a failure', async () => {
    const order: string[] = [];
    unregister = slowResponseHook(order);

    const response = await dispatchRaw('query', 'tasks', 'nonexistent');

    expect(response.success).toBe(false);
    expect(order).toEqual(['hook-done']);
  });
});
