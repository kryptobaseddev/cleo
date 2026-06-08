/**
 * Tests for the guarded Pi ExecutionEnv (T11761 · S1 · T11897).
 *
 * @epic T10403
 * @task T11761
 * @task T11897
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createToolGuard } from '../../../tools/guard.js';
import {
  createGuardedExecutionEnv,
  GuardedExecutionEnv,
  PiGuardModeError,
} from '../pi-execution-env.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-pi-env-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A guard in enforce mode confined to the workspace root. */
function enforcedEnv() {
  const guard = createToolGuard({ allowedRoots: [root], mode: 'enforce' });
  return createGuardedExecutionEnv({ guard, workspaceRoot: root });
}

describe('pure path arithmetic', () => {
  it('cwd returns the resolved workspace root', () => {
    const env = enforcedEnv();
    expect(env.cwd()).toBe(root);
  });

  it('joinPath / absolutePath anchor at the workspace root', () => {
    const env = enforcedEnv();
    expect(env.joinPath('a', 'b')).toBe(join(root, 'a', 'b'));
    expect(env.absolutePath('rel.txt')).toBe(join(root, 'rel.txt'));
  });
});

describe('file ops inside the workspace (allowed)', () => {
  it('writes then reads a file via the guard', async () => {
    const env = enforcedEnv();
    const target = join(root, 'note.txt');
    const w = await env.writeFile(target, 'hello');
    expect(w.ok).toBe(true);
    const r = await env.readTextFile(target);
    expect(r).toEqual({ ok: true, value: 'hello' });
  });

  it('readTextLines splits content into lines', async () => {
    const env = enforcedEnv();
    const target = join(root, 'lines.txt');
    await env.writeFile(target, 'a\nb\nc');
    const r = await env.readTextLines(target);
    expect(r).toEqual({ ok: true, value: ['a', 'b', 'c'] });
  });

  it('appendFile concatenates onto existing content', async () => {
    const env = enforcedEnv();
    const target = join(root, 'log.txt');
    await env.writeFile(target, 'one');
    await env.appendFile(target, '-two');
    const r = await env.readTextFile(target);
    expect(r).toEqual({ ok: true, value: 'one-two' });
  });

  it('appendFile treats a missing file as empty', async () => {
    const env = enforcedEnv();
    const target = join(root, 'fresh.txt');
    await env.appendFile(target, 'first');
    const r = await env.readTextFile(target);
    expect(r).toEqual({ ok: true, value: 'first' });
  });

  it('exists + fileInfo report file vs directory', async () => {
    const env = enforcedEnv();
    const target = join(root, 'present.txt');
    await env.writeFile(target, 'x');
    expect(await env.exists(target)).toEqual({ ok: true, value: true });
    const info = await env.fileInfo(target);
    expect(info).toEqual({ ok: true, value: { isFile: true, isDirectory: false } });
  });

  it('exists is false for a missing path; fileInfo errors NOT_FOUND', async () => {
    const env = enforcedEnv();
    const missing = join(root, 'nope.txt');
    expect(await env.exists(missing)).toEqual({ ok: true, value: false });
    const info = await env.fileInfo(missing);
    expect(info.ok).toBe(false);
    expect(info.ok === false && info.error.code).toBe('E_PI_FS_NOT_FOUND');
  });

  it('canonicalPath returns the confined absolute path', async () => {
    const env = enforcedEnv();
    const r = await env.canonicalPath('sub/x.txt');
    expect(r).toEqual({ ok: true, value: join(root, 'sub', 'x.txt') });
  });
});

describe('deny-first workspace boundary (path-escape)', () => {
  it('rejects a parent-traversal (../) read without touching the fs', async () => {
    const env = enforcedEnv();
    const r = await env.readTextFile('../outside.txt');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('E_PI_FS_DENIED');
  });

  it('rejects a deep ../../ escape', async () => {
    const env = enforcedEnv();
    const r = await env.readTextFile('a/../../../../etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('E_PI_FS_DENIED');
  });

  it('rejects an absolute path outside the workspace', async () => {
    const env = enforcedEnv();
    const r = await env.writeFile('/etc/cleo-should-not-exist', 'x');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('E_PI_FS_DENIED');
  });

  it('denies exists/fileInfo/canonicalPath for escaping paths too', async () => {
    const env = enforcedEnv();
    for (const r of [
      await env.exists('../x'),
      await env.fileInfo('../x'),
      await env.canonicalPath('../x'),
      await env.appendFile('../x', 'y'),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error.code).toBe('E_PI_FS_DENIED');
    }
  });
});

describe('guard enforce-mode denial → Result.err (never throws)', () => {
  it('a path that escapes the guard allowlist returns Result.err, not a throw', async () => {
    // Workspace root permits ../escape past confine, but the guard's own
    // allowlist is narrower — assert the GuardDeniedError is caught.
    const parent = mkdtempSync(join(tmpdir(), 'cleo-pi-parent-'));
    try {
      const inner = join(parent, 'inner');
      // workspace root = parent (so ../ stays inside), guard allowlist = inner only
      const guard = createToolGuard({ allowedRoots: [inner], mode: 'enforce' });
      const env = createGuardedExecutionEnv({ guard, workspaceRoot: parent });
      // path is inside workspace (parent) but OUTSIDE guard allowlist (inner)
      const r = await env.writeFile(join(parent, 'top.txt'), 'x');
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error.code).toBe('E_PI_FS_DENIED');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('unsupported v0 capabilities are denied (no fs reach)', () => {
  it('binary read, listDir, createDir, remove, temp ops all deny', async () => {
    const env = enforcedEnv();
    const results = [
      await env.readBinaryFile(join(root, 'x')),
      await env.listDir(root),
      await env.createDir(join(root, 'd')),
      await env.remove(join(root, 'x')),
      await env.createTempDir(),
      await env.createTempFile(),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error.code).toBe('E_PI_FS_UNSUPPORTED');
    }
  });
});

describe('shell exec pass-through to the ToolGuard', () => {
  it('runs an allowed command and maps the result', async () => {
    const env = enforcedEnv();
    const r = await env.exec('echo', { env: { CLEO_TEST: '1' } });
    expect(r.ok).toBe(true);
    expect(r.ok === true && typeof r.value.exitCode).toBe('number');
  });

  it('a denied command surfaces as Result.err (never throws)', async () => {
    const guard = createToolGuard({
      allowedRoots: [root],
      deniedCommands: ['rm'],
      mode: 'enforce',
    });
    const env = createGuardedExecutionEnv({ guard, workspaceRoot: root });
    const r = await env.exec('rm');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('E_PI_EXEC_DENIED');
  });

  it('an escaping cwd is denied before execution', async () => {
    const env = enforcedEnv();
    const r = await env.exec('echo', { cwd: '/etc' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('E_PI_EXEC_DENIED');
  });
});

describe('cleanup is a best-effort no-op', () => {
  it('resolves without throwing', async () => {
    const env = enforcedEnv();
    await expect(env.cleanup()).resolves.toBeUndefined();
  });
});

describe('factory + class parity', () => {
  it('createGuardedExecutionEnv yields a GuardedExecutionEnv instance', () => {
    const guard = createToolGuard({ allowedRoots: [root], mode: 'enforce' });
    const env = createGuardedExecutionEnv({ guard, workspaceRoot: root });
    expect(env).toBeInstanceOf(GuardedExecutionEnv);
  });
});

describe('factory REQUIRES an enforce-mode guard (warn-mode is rejected)', () => {
  it('throws PiGuardModeError when the guard is in warn mode', () => {
    // A warn-mode guard's allowlist/denylist are advisory — the Pi adapter must
    // refuse it rather than run untrusted work behind an advisory boundary.
    const warnGuard = createToolGuard({ allowedRoots: [root], mode: 'warn' });
    expect(() => createGuardedExecutionEnv({ guard: warnGuard, workspaceRoot: root })).toThrow(
      PiGuardModeError,
    );
  });

  it('throws when no explicit mode is given (live default is warn)', () => {
    // The live default posture is `warn` (GUARD_ENFORCE_FLIP_ENABLED=false), so a
    // guard built without an explicit mode must also be rejected.
    const defaultGuard = createToolGuard({ allowedRoots: [root] });
    try {
      createGuardedExecutionEnv({ guard: defaultGuard, workspaceRoot: root });
      expect.unreachable('expected PiGuardModeError');
    } catch (err) {
      expect(err).toBeInstanceOf(PiGuardModeError);
      expect((err as PiGuardModeError).code).toBe('E_PI_GUARD_NOT_ENFORCING');
    }
  });
});
