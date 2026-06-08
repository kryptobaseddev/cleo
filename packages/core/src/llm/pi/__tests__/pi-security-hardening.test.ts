/**
 * Security-hardening regression tests for the guarded Pi surface (T11897).
 *
 * These tests are the closing-the-escape counterparts to the adversarial probes
 * that originally REPRODUCED the findings. Each `describe` block pins one of the
 * fixed classes:
 *
 * 1. Symlink escape (read + dir-symlink write) — `#confine` + the guard now
 *    canonicalize via `fs.realpath` and re-check containment against the REAL
 *    target, so a symlink planted inside the workspace can no longer leak.
 * 2. Sandbox escape via Pi-controlled env (LD_PRELOAD / PATH / NODE_OPTIONS) —
 *    `exec` scrubs Pi's env to a minimal allowlist, pins PATH, drops loader
 *    hooks, so a workspace-resident impostor on a hijacked PATH is not found and
 *    no loader hook is forwarded.
 * 3. Daemon-secret leak — the scrubbed env never inherits `process.env`, so a
 *    child never sees `ANTHROPIC_API_KEY` / `CLEO_VAULT_*`.
 * 4. Warn-mode guard rejection — the Pi adapter refuses a non-enforce guard.
 *
 * @epic T10403
 * @task T11761
 * @task T11897
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createToolGuard } from '../../../tools/guard.js';
import { createGuardedExecutionEnv } from '../pi-execution-env.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-pi-sec-root-'));
  outside = mkdtempSync(join(tmpdir(), 'cleo-pi-sec-outside-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** An enforce-mode env confined to `root` (the real Pi deployment posture). */
function enforcedEnv() {
  const guard = createToolGuard({ allowedRoots: [root], mode: 'enforce' });
  return createGuardedExecutionEnv({ guard, workspaceRoot: root });
}

describe('symlink escape — READ through a file symlink is denied', () => {
  it('a symlinked file inside the workspace pointing outside does NOT leak content', async () => {
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'TOP-SECRET-OUTSIDE-WORKSPACE');
    // Plant a symlink INSIDE the workspace pointing to the external secret.
    const planted = join(root, 'innocent.txt');
    symlinkSync(secret, planted);

    const env = enforcedEnv();
    const r = await env.readTextFile('innocent.txt');
    // BEFORE the fix this returned { ok:true, value:'TOP-SECRET-OUTSIDE-WORKSPACE' }.
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('E_PI_FS_DENIED');
  });
});

describe('symlink escape — WRITE through a directory symlink is denied', () => {
  it('a symlinked directory inside the workspace does NOT let a write land outside', async () => {
    // root/sub -> outside  (a symlinked directory inside the workspace)
    const planted = join(root, 'sub');
    symlinkSync(outside, planted);

    const env = enforcedEnv();
    const r = await env.writeFile('sub/x.txt', 'should-not-land-outside');
    // BEFORE the fix the tmp-then-rename landed the file at outside/x.txt.
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('E_PI_FS_DENIED');
  });

  it('a legitimate nested write inside a REAL subdirectory still succeeds', async () => {
    mkdirSync(join(root, 'realdir'));
    const env = enforcedEnv();
    const w = await env.writeFile('realdir/ok.txt', 'fine');
    expect(w.ok).toBe(true);
    const back = await env.readTextFile('realdir/ok.txt');
    expect(back).toEqual({ ok: true, value: 'fine' });
  });
});

describe('symlink escape — exists/fileInfo/canonicalPath also deny a planted symlink', () => {
  it('a symlink to outside is reported denied across the metadata surface', async () => {
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'x');
    symlinkSync(secret, join(root, 'link.txt'));
    const env = enforcedEnv();
    for (const r of [
      await env.exists('link.txt'),
      await env.fileInfo('link.txt'),
      await env.canonicalPath('link.txt'),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error.code).toBe('E_PI_FS_DENIED');
    }
  });
});

describe('sandbox escape via Pi-controlled subprocess env', () => {
  it('a Pi-hijacked PATH does NOT make a workspace impostor satisfy a command basename', async () => {
    // Drop a malicious `env` impostor in the writable workspace.
    const impostor = join(root, 'env');
    writeFileSync(impostor, '#!/bin/sh\necho ARBITRARY-EXECUTION\n');
    chmodSync(impostor, 0o755);

    const env = enforcedEnv();
    // Pi tries to run `env` with PATH hijacked to the workspace (where the
    // impostor lives) plus a forwarded loader hook.
    const r = await env.exec('env', {
      env: { PATH: root, LD_PRELOAD: join(outside, 'evil.so') },
    });
    // PATH is pinned to TRUSTED_PATH (the workspace is NOT on it), so the
    // impostor is never resolved; the real /usr/bin/env runs instead and its
    // output must NOT contain the impostor's marker.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.stdout).not.toContain('ARBITRARY-EXECUTION');
    }
  });

  it('LD_PRELOAD / NODE_OPTIONS / GIT_SSH_COMMAND are NOT forwarded to the child', async () => {
    const env = enforcedEnv();
    const r = await env.exec('env', {
      env: {
        LD_PRELOAD: '/tmp/evil.so',
        NODE_OPTIONS: '--require /tmp/evil.js',
        GIT_SSH_COMMAND: 'sh -c "touch /tmp/pwned"',
        SAFE_VAR: 'kept',
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.value.stdout;
      expect(out).not.toMatch(/LD_PRELOAD/);
      expect(out).not.toMatch(/NODE_OPTIONS/);
      expect(out).not.toMatch(/GIT_SSH_COMMAND/);
      // a benign caller var DOES pass through
      expect(out).toMatch(/SAFE_VAR=kept/);
    }
  });
});

describe('daemon-secret leak through the guarded exec seam', () => {
  const SAVED = { ...process.env };
  afterEach(() => {
    // restore env keys we set
    for (const k of ['ANTHROPIC_API_KEY', 'CLEO_VAULT_SECRET', 'OPENAI_API_KEY']) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
  });

  it('a subprocess does NOT inherit the daemon ANTHROPIC_API_KEY / vault secret', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-SECRET-DAEMON-KEY';
    process.env.CLEO_VAULT_SECRET = 'vault-material';
    process.env.OPENAI_API_KEY = 'sk-openai-secret';

    const env = enforcedEnv();
    const r = await env.exec('env');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.value.stdout;
      expect(out).not.toContain('sk-ant-SECRET-DAEMON-KEY');
      expect(out).not.toContain('vault-material');
      expect(out).not.toContain('sk-openai-secret');
      expect(out).not.toMatch(/ANTHROPIC_API_KEY/);
      expect(out).not.toMatch(/CLEO_VAULT_SECRET/);
    }
  });
});
