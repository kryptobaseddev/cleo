/**
 * stdout discipline + daemon-survives smoke tests for the Pi embed
 * (T11761 · S2 · T11898).
 *
 * Two child-process tests (faithful to the daemon's real stdout/stderr split):
 *
 *  1. **single-LAFS-envelope-on-stdout** (ADR-086) — the adapter runs, streaming
 *     noise goes to stderr, and EXACTLY ONE LAFS envelope JSON line lands on
 *     stdout. Pi never writes stdout directly.
 *  2. **daemon-survives-forced-Pi-error** — a Pi `process.exit(1)` is neutralized
 *     by the pinned exit guard; the daemon-shaped child survives, emits a typed
 *     error envelope, and exits 0 (NOT 1 — which is what a failed trap would do).
 *
 * The children are run with `tsx` against the SOURCE (so they exercise the live
 * code, not a stale dist). They live under `fixtures/` so they are not collected
 * as vitest files.
 *
 * @epic T10403
 * @task T11761
 * @task T11898
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the `tsx` cli entry. Prefer `import.meta.resolve` (works in the test
 * runtime), fall back to the package-local `node_modules/.bin/tsx`.
 */
function resolveTsx(): string {
  try {
    return fileURLToPath(import.meta.resolve('tsx/dist/cli.mjs'));
  } catch {
    // Walk up from HERE to the package root and use the .bin symlink.
    const binTsx = join(HERE, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
    if (existsSync(binTsx)) return binTsx;
    return 'tsx';
  }
}

const TSX = resolveTsx();

/** Run a fixture script with tsx, capturing stdout/stderr separately. */
function runFixture(name: string): { stdout: string; stderr: string; status: number | null } {
  const script = join(HERE, 'fixtures', name);
  // The .bin/tsx shim is directly executable; the resolved cli.mjs is run via node.
  const isBinShim = TSX.endsWith(`.bin${'/'}tsx`) || TSX === 'tsx';
  const cmd = isBinShim ? TSX : 'node';
  const argv = isBinShim ? [script] : [TSX, script];
  const res = spawnSync(cmd, argv, {
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CLEO_SESSION_ID: 'fixture-session-1' },
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
}

describe('ADR-086 single LAFS envelope on stdout', () => {
  it('emits exactly ONE LAFS envelope line on stdout; streaming noise on stderr only', () => {
    const { stdout, stderr } = runFixture('single-envelope-runner.ts');

    // stdout = exactly one non-empty line, a valid LAFS envelope.
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]) as { $schema?: string; _meta?: unknown; success?: boolean };
    expect(parsed.$schema).toContain('lafs.dev/schemas');
    expect(parsed).toHaveProperty('_meta');
    expect(typeof parsed.success).toBe('boolean');

    // The streaming/progress noise went to stderr (proving the split).
    expect(stderr).toContain('pi: starting agent loop');
    // And stdout carries NONE of that prose.
    expect(stdout).not.toContain('pi: starting agent loop');
  }, 70_000);
});

describe('daemon survives a forced Pi process.exit', () => {
  it('neutralizes process.exit(1) from a Pi code path; daemon survives and exits 0', () => {
    const { stdout, status, stderr } = runFixture('daemon-survives-runner.ts');

    // Survived: a failed trap would have killed the child with code 1.
    expect(status).toBe(0);

    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]) as {
      success?: boolean;
      result?: { contained?: boolean; piCode?: string };
      error?: { code?: string };
    };
    expect(parsed.result?.contained).toBe(true);
    expect(parsed.result?.piCode).toBe('E_PI_PROCESS_EXIT_TRAPPED');
    expect(parsed.error?.code).toBe('E_PI_PROCESS_EXIT_TRAPPED');
    // The simulated exit attempt was logged to stderr, not stdout.
    expect(stderr).toContain('simulating daemon-fatal process.exit');
  }, 70_000);
});
