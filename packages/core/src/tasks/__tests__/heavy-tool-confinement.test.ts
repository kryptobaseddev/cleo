/**
 * T12116 — end-to-end proof that the ceiling is real.
 *
 * The unit tests assert the argv we build. This one spawns it and proves the
 * kernel enforces it: a child told to touch far more memory than its cap is
 * killed inside its own cgroup instead of being allowed to allocate.
 *
 * That distinction is the entire point of the change. The incident this guards
 * against was not an OOM kill — `app.slice` reached `MemoryHigh`, the kernel
 * throttled and thrashed swap, and the host locked up while logging nothing.
 * Confinement converts that silent host-wide degradation into a loud,
 * locally-contained failure that CLEO can report as a failed run.
 *
 * Skipped wherever confinement is unavailable (non-Linux, no user systemd
 * manager, most CI containers) — there the documented behaviour is an
 * unwrapped spawn, which the unit tests already cover.
 */

import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { cgroupConfinementAvailable, withMemoryLimit } from '../heavy-tool-limit.js';

/**
 * Whether a transient scope can ACTUALLY be created here.
 *
 * `cgroupConfinementAvailable()` answers "is the machinery present" — the right
 * question for production, where an unwrapped spawn is a safe degradation. It
 * is the wrong question for a test, because a CI runner can have `systemd-run`
 * on PATH and a user manager that answers `systemctl is-system-running`, and
 * still refuse to create a scope (no session bus, no delegated cgroup). There
 * the probe says yes and the scope fails, so the test fails for an environment
 * reason rather than a code one.
 *
 * So: attempt a real, trivial scope once and believe the result.
 */
function canActuallyConfine(): boolean {
  if (!cgroupConfinementAvailable()) return false;
  const r = spawnSync(
    'systemd-run',
    ['--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=64M', '--', 'true'],
    { stdio: 'ignore', timeout: 15_000 },
  );
  return !r.error && r.status === 0;
}

const available = canActuallyConfine();

/** Touch `mb` MiB for real — `Buffer.alloc` alone may never fault the pages in. */
const GREEDY = (mb: number) =>
  `const a=[];for(let i=0;i<${mb};i++){const b=Buffer.alloc(1048576);b.fill(i%251);a.push(b);}` +
  `console.log('ALLOCATED');`;

describe.skipIf(!available)('heavy-tool confinement (integration)', () => {
  it('kills a child that exceeds its ceiling instead of letting it allocate', async () => {
    const limited = withMemoryLimit('test', process.execPath, ['-e', GREEDY(2_048)], {
      env: { CLEO_TOOL_MEMORY_MAX_MB: '256' },
      available: true,
    });
    expect(limited.confined).toBe(true);

    const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(limited.cmd, [...limited.args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => {
        out += String(d);
      });
      child.on('close', (code) => resolve({ code, out }));
    });

    // The child must NOT have completed its allocation.
    expect(result.out).not.toContain('ALLOCATED');
    expect(result.code).not.toBe(0);
  }, 60_000);

  it('lets a child that stays under its ceiling finish normally', async () => {
    // The bound must not be so blunt that ordinary work fails — a ceiling that
    // kills healthy runs would just be a different outage.
    const limited = withMemoryLimit('test', process.execPath, ['-e', GREEDY(32)], {
      env: { CLEO_TOOL_MEMORY_MAX_MB: '512' },
      available: true,
    });

    const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(limited.cmd, [...limited.args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => {
        out += String(d);
      });
      child.on('close', (code) => resolve({ code, out }));
    });

    expect(result.out).toContain('ALLOCATED');
    expect(result.code).toBe(0);
  }, 60_000);
});
