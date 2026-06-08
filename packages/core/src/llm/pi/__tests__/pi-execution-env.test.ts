/**
 * Tests for the guarded Pi ExecutionEnv (T11761 · S1 · T11897).
 *
 * @epic T10403
 * @task T11761
 * @task T11897
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  // `realpathSync` so the root is the REAL on-disk path. On macOS the OS tmpdir
  // is reached through a symlink (`/var`→`/private/var`, `/tmp`→`/private/tmp`),
  // so `mkdtempSync` returns a symlinked path; the symlink-resolving boundary
  // (`#confine`/`canonicalPath`) returns the REAL location, and expectations that
  // build paths from `root` must therefore anchor on the real root too — else
  // they diverge by the `/private` prefix on macOS only. (No-op on Linux.)
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-pi-env-')));
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

describe('symlinked workspace root (macOS /tmp→/private/tmp parity)', () => {
  // On macOS the OS tmpdir (`/var/folders/...`, and `/tmp`) is reached through a
  // symlink (`/var`→`/private/var`, `/tmp`→`/private/tmp`), so `mkdtempSync` hands
  // back a path whose realpath has a DIFFERENT prefix. The symlink-resolving
  // boundary (`#confine`) returns that REAL path; any op that fed the resolved
  // path back through a second confinement (e.g. `appendFile`'s read-then-write)
  // would see it as `../`-outside the lexical root and falsely deny it. This
  // block reproduces that on Linux by making the workspace root itself a symlink
  // to a sibling dir with a different prefix.
  let base: string;
  let symlinkedRoot: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cleo-pi-symroot-'));
    const realStore = join(base, 'realstore');
    mkdirSync(realStore);
    symlinkedRoot = join(base, 'link');
    symlinkSync(realStore, symlinkedRoot); // root → realstore (prefix differs, like /var→/private/var)
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** Env whose workspaceRoot is a symlink to a different-prefix real dir. */
  function symlinkedEnv() {
    const guard = createToolGuard({ allowedRoots: [symlinkedRoot], mode: 'enforce' });
    return createGuardedExecutionEnv({ guard, workspaceRoot: symlinkedRoot });
  }

  it('appendFile concatenates onto existing content under a symlinked root', async () => {
    const env = symlinkedEnv();
    const target = join(symlinkedRoot, 'log.txt');
    expect((await env.writeFile(target, 'one')).ok).toBe(true);
    expect((await env.appendFile(target, '-two')).ok).toBe(true);
    expect(await env.readTextFile(target)).toEqual({ ok: true, value: 'one-two' });
  });

  it('appendFile creates a missing file under a symlinked root', async () => {
    const env = symlinkedEnv();
    const fresh = join(symlinkedRoot, 'fresh.txt');
    expect((await env.appendFile(fresh, 'first')).ok).toBe(true);
    expect(await env.readTextFile(fresh)).toEqual({ ok: true, value: 'first' });
  });

  it('canonicalPath resolves to the REAL (symlink-followed) path, not the link path', async () => {
    // `canonicalPath` is symlink-RESOLVING by contract — under a symlinked root it
    // returns the real on-disk location (the `/private`-prefixed path on macOS),
    // NOT the symlinked input. This locks the exact divergence the macOS CI hit.
    const env = symlinkedEnv();
    const realRoot = realpathSync(symlinkedRoot);
    const r = await env.canonicalPath('sub/x.txt');
    expect(r).toEqual({ ok: true, value: join(realRoot, 'sub', 'x.txt') });
    // Sanity: the resolved value is genuinely different from the lexical link path.
    expect(r.ok === true && r.value).not.toBe(join(symlinkedRoot, 'sub', 'x.txt'));
  });

  it('still DENIES a symlink that escapes the (symlinked) workspace root', async () => {
    // Symlink-escape protection must survive the symlinked-root fix: a symlink
    // planted inside the workspace whose real target leaves the root is denied.
    const env = symlinkedEnv();
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET');
    symlinkSync(outside, join(symlinkedRoot, 'evil')); // dir symlink escaping the root

    for (const r of [
      await env.readTextFile(join(symlinkedRoot, 'evil', 'secret.txt')),
      await env.writeFile(join(symlinkedRoot, 'evil', 'pwned.txt'), 'x'),
      await env.appendFile(join(symlinkedRoot, 'evil', 'pwned2.txt'), 'x'),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error.code).toBe('E_PI_FS_DENIED');
    }
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
