/**
 * Tests for the tool guardrail chokepoint (E3 · T11407).
 *
 * @epic T11390
 * @task T11407
 * @saga T11387
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecuteShellResult } from '@cleocode/contracts/tools/atomic';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createToolGuard, GuardDeniedError } from '../guard.js';

let root: string;
const okExec = (): Promise<ExecuteShellResult> =>
  Promise.resolve({ stdout: 'ran', stderr: '', code: 0 });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-guard-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('fs path allowlist', () => {
  it('enforce: allows a write under an allowed root', async () => {
    const g = createToolGuard({ allowedRoots: [root], mode: 'enforce' });
    const res = await g.writeFileAtomic({ path: join(root, 'a.txt'), content: 'x' });
    expect(res.bytesWritten).toBe(1);
  });

  it('enforce: rejects a write OUTSIDE the allowed roots before execution', async () => {
    const g = createToolGuard({ allowedRoots: [root], mode: 'enforce' });
    await expect(
      g.writeFileAtomic({ path: '/etc/cleo-should-not-exist', content: 'x' }),
    ).rejects.toBeInstanceOf(GuardDeniedError);
  });

  it('warn (default): proceeds on an out-of-root path (no throw)', async () => {
    const other = mkdtempSync(join(tmpdir(), 'cleo-guard-other-'));
    try {
      const g = createToolGuard({ allowedRoots: [root] }); // mode defaults to 'warn'
      const res = await g.writeFileAtomic({ path: join(other, 'b.txt'), content: 'yy' });
      expect(res.bytesWritten).toBe(2); // warn-then-proceed
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('no allowedRoots → fs is unrestricted', async () => {
    const g = createToolGuard({ mode: 'enforce' });
    const res = await g.writeFileAtomic({ path: join(root, 'c.txt'), content: 'z' });
    expect(res.bytesWritten).toBe(1);
  });
});

describe('shell command denylist', () => {
  it('enforce: rejects a denied command before execution', async () => {
    const g = createToolGuard({ deniedCommands: ['rm'], mode: 'enforce' });
    await expect(
      g.executeShell({ command: 'rm', args: ['-rf', '/'] }, okExec),
    ).rejects.toBeInstanceOf(GuardDeniedError);
  });

  it('enforce: denies by basename even with an absolute path', async () => {
    const g = createToolGuard({ deniedCommands: ['rm'], mode: 'enforce' });
    await expect(
      g.executeShell({ command: '/bin/rm', args: ['x'] }, okExec),
    ).rejects.toBeInstanceOf(GuardDeniedError);
  });

  it('enforce: allows a non-denied command through to the executor', async () => {
    const g = createToolGuard({ deniedCommands: ['rm'], mode: 'enforce' });
    const res = await g.executeShell({ command: 'echo', args: ['hi'] }, okExec);
    expect(res).toEqual({ stdout: 'ran', stderr: '', code: 0 });
  });

  it('warn: proceeds on a denied command (no throw)', async () => {
    const g = createToolGuard({ deniedCommands: ['rm'] });
    const res = await g.executeShell({ command: 'rm', args: ['x'] }, okExec);
    expect(res.code).toBe(0); // warn-then-proceed
  });
});
