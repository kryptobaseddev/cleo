/**
 * Tests for the PTY shell runner (T1741 · epic T11456 · AC1/AC8).
 *
 * Exercises the ALWAYS-available non-PTY `spawn` path and the PTY/auto fallback.
 * `node-pty` is an OPTIONAL dep and is NOT installed in CI, so the `auto`/`pty`
 * modes degrade to `spawn` with `ptyFellBack: true` — which is exactly the
 * behaviour asserted here. No network; the only subprocess is `node -e` (always
 * present in this toolchain).
 *
 * @task T1741
 * @epic T11456
 */

import { describe, expect, it } from 'vitest';
import { runPty } from '../pty.js';

const NODE = process.execPath;

describe('runPty — non-PTY spawn mode (AC1)', () => {
  it('captures stdout + exit code in spawn mode', async () => {
    const res = await runPty({
      command: NODE,
      args: ['-e', 'process.stdout.write("hello")'],
      mode: 'spawn',
    });
    expect(res.mode).toBe('spawn');
    expect(res.ptyFellBack).toBe(false);
    expect(res.stdout).toContain('hello');
    expect(res.code).toBe(0);
  });

  it('reports a non-zero exit code', async () => {
    const res = await runPty({
      command: NODE,
      args: ['-e', 'process.exit(7)'],
      mode: 'spawn',
    });
    expect(res.code).toBe(7);
  });
});

describe('runPty — auto/pty mode (AC1)', () => {
  it('degrades to spawn with ptyFellBack when node-pty is unavailable', async () => {
    const res = await runPty({
      command: NODE,
      args: ['-e', 'process.stdout.write("yo")'],
      mode: 'auto',
    });
    // node-pty is not a project dependency, so auto resolves to spawn fallback.
    expect(res.mode).toBe('spawn');
    expect(res.ptyFellBack).toBe(true);
    expect(res.stdout).toContain('yo');
    expect(res.code).toBe(0);
  });
});
