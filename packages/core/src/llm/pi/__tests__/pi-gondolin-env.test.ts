/**
 * Unit tests for the Gondolin micro-VM Pi `ExecutionEnv` (T11909 · T11888-B).
 *
 * The VM is FULLY MOCKED — NO `@earendil-works/gondolin` package, NO QEMU, NO
 * `/dev/kvm` is required and NO real VM is ever launched. A `MockVm` records the
 * `vm.fs.*` / `vm.exec` calls so each test asserts the method→VM mapping, the
 * deny-first path/command guard, the seeded-copy-only mount set, and the
 * egress-deny-by-default footgun guard. A real-VM exercise is a separate opt-in
 * integration test gated on `/dev/kvm`+QEMU (out of scope here).
 *
 * @epic T11599
 * @task T11909
 */

import { describe, expect, it } from 'vitest';
import type {
  CreateHttpHooksOptions,
  ExecOptions,
  ExecResult,
  GondolinModule,
  HttpHooks,
  RealFSProviderInstance,
  VM,
  VmFs,
  VmStat,
} from '../gondolin-loader.js';
import {
  createGondolinExecutionEnv,
  GONDOLIN_WORKSPACE_ROOT,
  GondolinUnavailableError,
} from '../pi-gondolin-env.js';

// ---------------------------------------------------------------------------
// Mock gondolin surface
// ---------------------------------------------------------------------------

/** A recorded `vm.exec` invocation. */
interface ExecCall {
  readonly command: string | readonly string[];
  readonly options?: ExecOptions;
}

/** A recorded `vm.fs.*` invocation. */
interface FsCall {
  readonly method: string;
  readonly path: string;
  readonly args: readonly unknown[];
}

/** Controls what the mock VM returns / throws, per test. */
interface MockVmConfig {
  /** Seed file contents (guest path → utf-8 text). */
  readonly files?: Record<string, string>;
  /** Binary seed contents (guest path → bytes). */
  readonly binary?: Record<string, Uint8Array>;
  /** Directory listings (guest path → entries). */
  readonly dirs?: Record<string, string[]>;
  /** Paths that `stat`/`access` resolve as a directory. */
  readonly directories?: readonly string[];
  /** Paths that exist (for `access`). When omitted, `files`/`dirs` keys exist. */
  readonly existing?: readonly string[];
  /** Per-command exec result override (keyed by JSON of the command). */
  readonly execResult?: (command: string | readonly string[], options?: ExecOptions) => ExecResult;
}

/** A mock `VM` recording every fs/exec call; never boots QEMU. */
class MockVm implements VM {
  readonly fsCalls: FsCall[] = [];
  readonly execCalls: ExecCall[] = [];
  closeCount = 0;
  readonly fs: VmFs;

  constructor(private readonly cfg: MockVmConfig = {}) {
    const record = (method: string, path: string, ...args: unknown[]): void => {
      this.fsCalls.push({ method, path, args });
    };
    const isDir = (p: string): boolean => (this.cfg.directories ?? []).includes(p);
    const stat = (p: string): VmStat => ({ isFile: () => !isDir(p), isDirectory: () => isDir(p) });
    const exists = (p: string): boolean => {
      if (this.cfg.existing !== undefined) return this.cfg.existing.includes(p);
      return (
        p in (this.cfg.files ?? {}) ||
        p in (this.cfg.dirs ?? {}) ||
        p in (this.cfg.binary ?? {}) ||
        isDir(p)
      );
    };
    // The VmFs surface is intentionally narrow; the mock implements exactly the
    // overloaded `readFile` plus the consumed mutators.
    this.fs = {
      readFile: (async (p: string, options?: { encoding: 'utf-8' }) => {
        record('readFile', p, options);
        if (options?.encoding === 'utf-8') {
          const text = this.cfg.files?.[p];
          if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return text;
        }
        const bytes = this.cfg.binary?.[p];
        if (bytes === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return bytes;
      }) as VmFs['readFile'],
      writeFile: async (p: string, content: string) => {
        record('writeFile', p, content);
      },
      stat: async (p: string) => {
        record('stat', p);
        if (!exists(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return stat(p);
      },
      listDir: async (p: string) => {
        record('listDir', p);
        const entries = this.cfg.dirs?.[p];
        if (entries === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return entries;
      },
      access: async (p: string) => {
        record('access', p);
        if (!exists(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      mkdir: async (p: string, options: { recursive: boolean }) => {
        record('mkdir', p, options);
      },
      deleteFile: async (p: string, options: { recursive: boolean; force: boolean }) => {
        record('deleteFile', p, options);
      },
    };
  }

  exec(command: string | readonly string[], options?: ExecOptions): PromiseLike<ExecResult> {
    this.execCalls.push({ command, options });
    const result: ExecResult = this.cfg.execResult?.(command, options) ?? {
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
    return Promise.resolve(result);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

/** Records the args passed to the mock `createHttpHooks` + `RealFSProvider`. */
interface MockModuleProbe {
  hooksOptions?: CreateHttpHooksOptions;
  realFsRoots: string[];
  vmOptionsSeen?: unknown;
  readonly vm: MockVm;
}

/**
 * Build a mock {@link GondolinModule} whose `VM.create` returns the supplied
 * {@link MockVm} (recording the `VMOptions`), plus a probe capturing the hooks /
 * mount construction. NO real package, NO QEMU.
 */
function mockModule(vm: MockVm): { module: GondolinModule; probe: MockModuleProbe } {
  const probe: MockModuleProbe = { realFsRoots: [], vm };
  const httpHooks: HttpHooks = { __httpHooks: true };
  const module: GondolinModule = {
    VM: {
      create: async (options) => {
        probe.vmOptionsSeen = options;
        return vm;
      },
    },
    RealFSProvider: class implements RealFSProviderInstance {
      readonly __realFsProvider = true as const;
      constructor(root: string) {
        probe.realFsRoots.push(root);
      }
    },
    createHttpHooks: (options) => {
      probe.hooksOptions = options;
      return httpHooks;
    },
  };
  return { module, probe };
}

/** Construct an env over a fresh mock VM (no QEMU), returning env + handles. */
async function gondolinEnv(cfg: MockVmConfig = {}, seededCopyDir = '/tmp/seed-copy') {
  const vm = new MockVm(cfg);
  const { module, probe } = mockModule(vm);
  const env = await createGondolinExecutionEnv({ seededCopyDir, load: async () => module });
  return { env, vm, probe };
}

const WS = GONDOLIN_WORKSPACE_ROOT;

// ---------------------------------------------------------------------------
// Factory: VM boot wiring (zero authority, seeded-copy-only, deny-by-default)
// ---------------------------------------------------------------------------

describe('createGondolinExecutionEnv — VM boot wiring', () => {
  it('throws GondolinUnavailableError when the loader returns null (package absent)', async () => {
    await expect(
      createGondolinExecutionEnv({ seededCopyDir: '/tmp/seed', load: async () => null }),
    ).rejects.toBeInstanceOf(GondolinUnavailableError);
  });

  it('mounts ONLY the disposable seeded copy at /workspace (no live DB ever mounted)', async () => {
    const { probe } = await gondolinEnv({}, '/tmp/disposable-seed');
    // Exactly one RealFSProvider, rooted at the seeded copy dir.
    expect(probe.realFsRoots).toEqual(['/tmp/disposable-seed']);
    const opts = probe.vmOptionsSeen as {
      vfs?: { mounts?: Record<string, unknown> };
    };
    const mounts = opts.vfs?.mounts ?? {};
    expect(Object.keys(mounts)).toEqual([WS]);
  });

  it('NEVER mounts a live tasks.db / brain.db path — the mount set is the seeded copy only', async () => {
    // Even when the host has live DBs, the factory mounts ONLY seededCopyDir; a
    // live `.cleo` path is structurally absent from the mount set + roots.
    const { probe } = await gondolinEnv({}, '/home/u/project/.cleo/snapshot-disposable');
    expect(probe.realFsRoots).toEqual(['/home/u/project/.cleo/snapshot-disposable']);
    const json = JSON.stringify(probe.vmOptionsSeen);
    expect(json).not.toContain('tasks.db');
    expect(json).not.toContain('brain.db');
  });

  it('boots egress DENY-BY-DEFAULT — allowedHosts is PRESENT-and-empty (the footgun guard)', async () => {
    const { probe } = await gondolinEnv();
    expect(probe.hooksOptions).toBeDefined();
    // The field must be present (not undefined) AND empty — omitting it = allow-all.
    expect(probe.hooksOptions?.allowedHosts).toEqual([]);
    expect(probe.hooksOptions?.allowedHosts).not.toBeUndefined();
  });

  it('forwards explicit allowedHosts + vault secret placeholders to the hooks', async () => {
    const vm = new MockVm();
    const { module, probe } = mockModule(vm);
    await createGondolinExecutionEnv({
      seededCopyDir: '/tmp/seed',
      allowedHosts: ['api.example.com'],
      vaultSecrets: {
        API_KEY: { hosts: ['api.example.com'], value: 'REAL-SECRET', placeholder: '<<API_KEY>>' },
      },
      load: async () => module,
    });
    expect(probe.hooksOptions?.allowedHosts).toEqual(['api.example.com']);
    // The guest only ever sees the placeholder — but the factory faithfully
    // passes the secret def through to the HOST-side hooks.
    expect(probe.hooksOptions?.secrets?.API_KEY?.placeholder).toBe('<<API_KEY>>');
  });

  it('passes ZERO authority into the guest — env is opts.env only (no host process.env)', async () => {
    const { probe } = await gondolinEnv();
    const opts = probe.vmOptionsSeen as { env?: Record<string, string>; memory?: string };
    // Default env is the empty map — host process.env is never inherited.
    expect(opts.env).toEqual({});
    // Memory is set EXPLICITLY (never relies on the gondolin default).
    expect(opts.memory).toBe('1G');
  });
});

// ---------------------------------------------------------------------------
// FileSystem method → vm.fs mapping (incl. S1's filled v0 denials)
// ---------------------------------------------------------------------------

describe('pure path arithmetic (no VM round-trip)', () => {
  it('cwd is the guest /workspace root', async () => {
    const { env } = await gondolinEnv();
    expect(env.cwd()).toBe(WS);
  });

  it('joinPath / absolutePath anchor at /workspace (POSIX)', async () => {
    const { env } = await gondolinEnv();
    expect(env.joinPath('a', 'b')).toBe(`${WS}/a/b`);
    expect(env.absolutePath('rel.txt')).toBe(`${WS}/rel.txt`);
    expect(env.absolutePath(`${WS}/x`)).toBe(`${WS}/x`);
  });
});

describe('file reads map to vm.fs.readFile', () => {
  it('readTextFile → vm.fs.readFile(p, {encoding:utf-8})', async () => {
    const { env, vm } = await gondolinEnv({ files: { [`${WS}/a.txt`]: 'hi' } });
    const r = await env.readTextFile(`${WS}/a.txt`);
    expect(r).toEqual({ ok: true, value: 'hi' });
    expect(vm.fsCalls[0]).toMatchObject({ method: 'readFile', path: `${WS}/a.txt` });
    expect(vm.fsCalls[0]?.args[0]).toEqual({ encoding: 'utf-8' });
  });

  it('readTextLines splits the read content', async () => {
    const { env } = await gondolinEnv({ files: { [`${WS}/l.txt`]: 'a\nb\nc' } });
    const r = await env.readTextLines(`${WS}/l.txt`);
    expect(r).toEqual({ ok: true, value: ['a', 'b', 'c'] });
  });

  it('readBinaryFile → vm.fs.readFile(p) — FILLS S1 v0 denial (returns Uint8Array)', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { env, vm } = await gondolinEnv({ binary: { [`${WS}/blob.bin`]: bytes } });
    const r = await env.readBinaryFile(`${WS}/blob.bin`);
    expect(r).toEqual({ ok: true, value: bytes });
    // The binary read passes NO encoding option (the Buffer overload).
    expect(vm.fsCalls.at(-1)).toMatchObject({ method: 'readFile', path: `${WS}/blob.bin` });
    expect(vm.fsCalls.at(-1)?.args[0]).toBeUndefined();
  });
});

describe('file writes map to vm.fs.writeFile', () => {
  it('writeFile → vm.fs.writeFile', async () => {
    const { env, vm } = await gondolinEnv();
    const r = await env.writeFile(`${WS}/out.txt`, 'data');
    expect(r).toEqual({ ok: true, value: undefined });
    expect(vm.fsCalls.at(-1)).toMatchObject({ method: 'writeFile', path: `${WS}/out.txt` });
    expect(vm.fsCalls.at(-1)?.args[0]).toBe('data');
  });

  it('appendFile concatenates onto existing content', async () => {
    const { env, vm } = await gondolinEnv({ files: { [`${WS}/log.txt`]: 'one' } });
    const r = await env.appendFile(`${WS}/log.txt`, '-two');
    expect(r).toEqual({ ok: true, value: undefined });
    const write = vm.fsCalls.find((c) => c.method === 'writeFile');
    expect(write?.args[0]).toBe('one-two');
  });

  it('appendFile treats a missing file as empty (append-creates)', async () => {
    const { env, vm } = await gondolinEnv();
    const r = await env.appendFile(`${WS}/fresh.txt`, 'first');
    expect(r).toEqual({ ok: true, value: undefined });
    const write = vm.fsCalls.find((c) => c.method === 'writeFile');
    expect(write?.args[0]).toBe('first');
  });
});

describe('metadata maps to vm.fs.stat / access', () => {
  it('fileInfo → vm.fs.stat → {isFile,isDirectory}', async () => {
    const { env } = await gondolinEnv({
      files: { [`${WS}/f.txt`]: 'x' },
      directories: [`${WS}/d`],
      existing: [`${WS}/f.txt`, `${WS}/d`],
    });
    expect(await env.fileInfo(`${WS}/f.txt`)).toEqual({
      ok: true,
      value: { isFile: true, isDirectory: false },
    });
    expect(await env.fileInfo(`${WS}/d`)).toEqual({
      ok: true,
      value: { isFile: false, isDirectory: true },
    });
  });

  it('exists → vm.fs.access resolve→true / reject→false (a missing path is ok(false), not err)', async () => {
    const { env } = await gondolinEnv({ existing: [`${WS}/here`] });
    expect(await env.exists(`${WS}/here`)).toEqual({ ok: true, value: true });
    expect(await env.exists(`${WS}/gone`)).toEqual({ ok: true, value: false });
  });

  it('canonicalPath runs /bin/realpath in ARRAY form (no $PATH expansion)', async () => {
    const { env, vm } = await gondolinEnv({
      execResult: () => ({ stdout: `${WS}/real`, stderr: '', exitCode: 0 }),
    });
    const r = await env.canonicalPath(`${WS}/link`);
    expect(r).toEqual({ ok: true, value: `${WS}/real` });
    expect(vm.execCalls[0]?.command).toEqual(['/bin/realpath', `${WS}/link`]);
  });
});

describe('FILLS S1 v0 denials: listDir / createDir / remove / createTempDir / createTempFile', () => {
  it('listDir → vm.fs.listDir', async () => {
    const { env, vm } = await gondolinEnv({ dirs: { [`${WS}/d`]: ['a', 'b'] } });
    expect(await env.listDir(`${WS}/d`)).toEqual({ ok: true, value: ['a', 'b'] });
    expect(vm.fsCalls.at(-1)).toMatchObject({ method: 'listDir', path: `${WS}/d` });
  });

  it('createDir → vm.fs.mkdir(p, {recursive:true})', async () => {
    const { env, vm } = await gondolinEnv();
    expect(await env.createDir(`${WS}/new/deep`)).toEqual({ ok: true, value: undefined });
    expect(vm.fsCalls.at(-1)).toMatchObject({ method: 'mkdir', path: `${WS}/new/deep` });
    expect(vm.fsCalls.at(-1)?.args[0]).toEqual({ recursive: true });
  });

  it('remove → vm.fs.deleteFile(p, {recursive:true,force:true})', async () => {
    const { env, vm } = await gondolinEnv();
    expect(await env.remove(`${WS}/junk`)).toEqual({ ok: true, value: undefined });
    expect(vm.fsCalls.at(-1)).toMatchObject({ method: 'deleteFile', path: `${WS}/junk` });
    expect(vm.fsCalls.at(-1)?.args[0]).toEqual({ recursive: true, force: true });
  });

  it('createTempDir → mktemp -d under /workspace/.tmp (ARRAY form)', async () => {
    const { env, vm } = await gondolinEnv({
      execResult: () => ({ stdout: `${WS}/.tmp/pi-AbC123`, stderr: '', exitCode: 0 }),
    });
    const r = await env.createTempDir('job-');
    expect(r).toEqual({ ok: true, value: `${WS}/.tmp/pi-AbC123` });
    const exec = vm.execCalls.at(-1)?.command as string[];
    expect(exec[0]).toBe('/bin/mktemp');
    expect(exec).toContain('-d');
    expect(exec.at(-1)).toBe(`${WS}/.tmp/job-XXXXXX`);
  });

  it('createTempFile → mktemp (no -d) under /workspace/.tmp', async () => {
    const { env, vm } = await gondolinEnv({
      execResult: () => ({ stdout: `${WS}/.tmp/pi-Xy9`, stderr: '', exitCode: 0 }),
    });
    const r = await env.createTempFile();
    expect(r).toEqual({ ok: true, value: `${WS}/.tmp/pi-Xy9` });
    const exec = vm.execCalls.at(-1)?.command as string[];
    expect(exec[0]).toBe('/bin/mktemp');
    expect(exec).not.toContain('-d');
  });
});

// ---------------------------------------------------------------------------
// Deny-first path confinement
// ---------------------------------------------------------------------------

describe('deny-first: paths outside /workspace are rejected BEFORE touching vm.fs', () => {
  const escapes = ['/etc/passwd', '../secrets', `${WS}/../etc/shadow`, '/'];
  for (const bad of escapes) {
    it(`readTextFile("${bad}") → E_PI_FS_DENIED, no vm.fs call`, async () => {
      const { env, vm } = await gondolinEnv();
      const r = await env.readTextFile(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('E_PI_FS_DENIED');
      expect(vm.fsCalls).toHaveLength(0);
    });
  }

  it('writeFile outside /workspace is denied (no write reaches the VM)', async () => {
    const { env, vm } = await gondolinEnv();
    const r = await env.writeFile('/etc/cron.d/evil', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_PI_FS_DENIED');
    expect(vm.fsCalls).toHaveLength(0);
  });

  it('createDir / remove / listDir outside /workspace are denied', async () => {
    const { env, vm } = await gondolinEnv();
    expect((await env.createDir('/opt/x')).ok).toBe(false);
    expect((await env.remove('/var/lib')).ok).toBe(false);
    expect((await env.listDir('/root')).ok).toBe(false);
    expect(vm.fsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Shell: command denylist + cwd confinement + exitCode mapping
// ---------------------------------------------------------------------------

describe('exec: real-egress verbs are DENIED before reaching vm.exec', () => {
  const denied = [
    'gh pr create',
    'git push origin main',
    'npm publish --tag latest',
    'cleo release plan',
    'git remote add origin url',
    '/usr/bin/gh auth login',
  ];
  for (const cmd of denied) {
    it(`denies "${cmd}"`, async () => {
      const { env, vm } = await gondolinEnv();
      const r = await env.exec(cmd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('E_PI_EXEC_DENIED');
      // The denied command NEVER reaches the VM.
      expect(vm.execCalls).toHaveLength(0);
    });
  }

  it('ALLOWS patch-producing git verbs (git diff / git status / git apply)', async () => {
    const { env, vm } = await gondolinEnv({
      execResult: () => ({ stdout: 'diff', stderr: '', exitCode: 0 }),
    });
    const r = await env.exec('git diff HEAD');
    expect(r.ok).toBe(true);
    expect(vm.execCalls).toHaveLength(1);
  });
});

describe('exec: cwd confinement + options + exitCode mapping', () => {
  it('rejects a cwd outside /workspace', async () => {
    const { env, vm } = await gondolinEnv();
    const r = await env.exec('ls', { cwd: '/etc' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_PI_EXEC_DENIED');
    expect(vm.execCalls).toHaveLength(0);
  });

  it('forwards command + cwd/env/timeout to vm.exec and returns stdout/stderr/exitCode', async () => {
    const { env, vm } = await gondolinEnv({
      execResult: () => ({ stdout: 'out', stderr: 'err', exitCode: 0 }),
    });
    const r = await env.exec('echo hi', {
      cwd: `${WS}/sub`,
      env: { FOO: 'bar' },
      timeout: 1234,
    });
    expect(r).toEqual({ ok: true, value: { stdout: 'out', stderr: 'err', exitCode: 0 } });
    const call = vm.execCalls[0];
    expect(call?.command).toBe('echo hi');
    expect(call?.options).toMatchObject({ cwd: `${WS}/sub`, env: { FOO: 'bar' }, timeout: 1234 });
  });

  it('maps a SIGNAL-killed process to exitCode null (not the raw number)', async () => {
    const { env } = await gondolinEnv({
      execResult: () => ({ stdout: '', stderr: 'killed', exitCode: 137, signal: 9 }),
    });
    const r = await env.exec('sleep 999');
    expect(r).toEqual({ ok: true, value: { stdout: '', stderr: 'killed', exitCode: null } });
  });

  it('a normal non-zero exit passes the number through (no signal → exitCode stays)', async () => {
    const { env } = await gondolinEnv({
      execResult: () => ({ stdout: '', stderr: 'boom', exitCode: 2 }),
    });
    const r = await env.exec('false');
    expect(r).toEqual({ ok: true, value: { stdout: '', stderr: 'boom', exitCode: 2 } });
  });
});

// ---------------------------------------------------------------------------
// Never-throw discipline + cleanup
// ---------------------------------------------------------------------------

describe('never-throws → PiResult.err', () => {
  it('a thrown vm.fs error becomes a PiResult.err (not an exception)', async () => {
    const vm = new MockVm();
    // Force writeFile to throw a coded error.
    vm.fs.writeFile = async () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    };
    const { module } = mockModule(vm);
    const env = await createGondolinExecutionEnv({
      seededCopyDir: '/tmp/s',
      load: async () => module,
    });
    const r = await env.writeFile(`${WS}/x`, 'data');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('ENOSPC');
      expect(r.error.message).toContain('disk full');
    }
  });

  it('a thrown vm.exec error becomes a PiResult.err with E_PI_EXEC_FAILED', async () => {
    const vm = new MockVm();
    vm.exec = () => Promise.reject(new Error('vm exploded'));
    const { module } = mockModule(vm);
    const env = await createGondolinExecutionEnv({
      seededCopyDir: '/tmp/s',
      load: async () => module,
    });
    const r = await env.exec('ls');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_PI_EXEC_FAILED');
  });
});

describe('cleanup() releases the VM (idempotent)', () => {
  it('cleanup → vm.close() exactly once even when called twice', async () => {
    const { env, vm } = await gondolinEnv();
    await env.cleanup();
    await env.cleanup();
    expect(vm.closeCount).toBe(1);
  });

  it('a close() failure is swallowed (cleanup never throws)', async () => {
    const vm = new MockVm();
    vm.close = async () => {
      throw new Error('close failed');
    };
    const { module } = mockModule(vm);
    const env = await createGondolinExecutionEnv({
      seededCopyDir: '/tmp/s',
      load: async () => module,
    });
    await expect(env.cleanup()).resolves.toBeUndefined();
  });
});
