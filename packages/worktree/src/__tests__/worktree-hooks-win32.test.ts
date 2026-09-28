/**
 * T12604 — worktree hooks must not require `sh` on Windows.
 *
 * `runSingleHook` executed every hook as `execFile('sh', ['-c', cmd])`, so on
 * Windows every post-create/post-start hook failed with ENOENT. With the
 * platform set to win32, the hook must go to `%ComSpec%`. The test points
 * `ComSpec` at a stand-in that echoes its argv, so it runs on any POSIX host
 * without mocking `child_process`.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSingleHook } from '../worktree-hooks.js';

const realPlatform = process.platform;
let dir: string | undefined;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('runSingleHook shell per platform (T12604)', () => {
  it('hands the hook to %ComSpec% /d /s /c on win32, never sh', async () => {
    if (realPlatform === 'win32') return;
    dir = mkdtempSync(join(tmpdir(), 'hook-comspec-'));
    const comSpec = join(dir, 'cmd.exe');
    writeFileSync(comSpec, '#!/bin/sh\nprintf "%s|" "$@"\n');
    chmodSync(comSpec, 0o755);
    vi.stubEnv('ComSpec', comSpec);
    setPlatform('win32');

    const result = await runSingleHook({ event: 'post-create', command: 'echo hook-ran' }, dir);
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('/d|/s|/c|"echo hook-ran"|');
  });

  it('runs a real hook through /bin/sh on POSIX', async () => {
    if (realPlatform === 'win32') return;
    const result = await runSingleHook(
      { event: 'post-create', command: 'echo hook-ok' },
      process.cwd(),
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('hook-ok');
  });
});
