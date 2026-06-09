/**
 * Selector matrix tests for {@link resolveExecutionEnv} (T11910 · T11888-C).
 *
 * The VM is FULLY MOCKED via the `seams` parameter — NO `@earendil-works/gondolin`
 * package, NO QEMU, NO `/dev/kvm` is required and NO real VM is ever launched. The
 * matrix asserts:
 *   - `backend:'gondolin'` + available → the VM factory is called (VM-backed env);
 *   - `backend:'gondolin'` + UNAVAILABLE → silent degrade to `GuardedExecutionEnv`;
 *   - `backend:'in-process'` → `GuardedExecutionEnv` WITHOUT probing the host.
 *
 * The in-process fallback is exercised with a REAL enforce-mode {@link ToolGuard}
 * (the same construction S1's tests use), so the returned env is the genuine
 * guarded backend, not a stub. A real-VM exercise is a separate opt-in integration
 * test gated on `/dev/kvm`+QEMU (`pi-gondolin-env.integration.test.ts`).
 *
 * @epic T11599
 * @task T11910
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createToolGuard, type ToolGuard } from '../../../tools/guard.js';
import { GuardedExecutionEnv, type PiExecutionEnv } from '../pi-execution-env.js';
import {
  type CreateGondolinExecutionEnvOptions,
  GONDOLIN_WORKSPACE_ROOT,
} from '../pi-gondolin-env.js';
import { ExecutionEnvConfigError, resolveExecutionEnv } from '../resolve-execution-env.js';

// ---------------------------------------------------------------------------
// Fixtures: a real enforce-mode ToolGuard for the fallback + a fake VM env that
// records the options it was booted with (NO real QEMU).
// ---------------------------------------------------------------------------

let root: string;
let guard: ToolGuard;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'resolve-env-'));
  guard = createToolGuard({ allowedRoots: [root], mode: 'enforce' });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A sentinel env the mocked VM factory returns; identity-checked by the matrix. */
const VM_ENV_MARKER = '__vm_env_marker__' as const;

/** A fake `PiExecutionEnv` standing in for a booted VM — never touches QEMU. */
function fakeVmEnv(): PiExecutionEnv & { readonly marker: typeof VM_ENV_MARKER } {
  return {
    marker: VM_ENV_MARKER,
    cwd: () => GONDOLIN_WORKSPACE_ROOT,
    absolutePath: (p) => p,
    joinPath: (...s) => s.join('/'),
    readTextFile: async () => ({ ok: true, value: '' }),
    readTextLines: async () => ({ ok: true, value: [] }),
    readBinaryFile: async () => ({ ok: true, value: new Uint8Array() }),
    writeFile: async () => ({ ok: true, value: undefined }),
    appendFile: async () => ({ ok: true, value: undefined }),
    fileInfo: async () => ({ ok: true, value: { isFile: true, isDirectory: false } }),
    listDir: async () => ({ ok: true, value: [] }),
    canonicalPath: async () => ({ ok: true, value: GONDOLIN_WORKSPACE_ROOT }),
    exists: async () => ({ ok: true, value: true }),
    createDir: async () => ({ ok: true, value: undefined }),
    remove: async () => ({ ok: true, value: undefined }),
    createTempDir: async () => ({ ok: true, value: GONDOLIN_WORKSPACE_ROOT }),
    createTempFile: async () => ({ ok: true, value: GONDOLIN_WORKSPACE_ROOT }),
    exec: async () => ({ ok: true, value: { stdout: '', stderr: '', exitCode: 0 } }),
    cleanup: async () => {},
  };
}

/** Build the test seams: a fixed availability + a recording VM factory. */
function seamsFor(available: boolean) {
  const calls: CreateGondolinExecutionEnvOptions[] = [];
  const seams = {
    isAvailable: async () => available,
    createGondolin: async (opts: CreateGondolinExecutionEnvOptions): Promise<PiExecutionEnv> => {
      calls.push(opts);
      return fakeVmEnv();
    },
  };
  return { seams, calls };
}

// ---------------------------------------------------------------------------
// The selection matrix
// ---------------------------------------------------------------------------

describe('resolveExecutionEnv — selector matrix', () => {
  it('VM REQUESTED + AVAILABLE → boots the gondolin VM (createGondolin called)', async () => {
    const { seams, calls } = seamsFor(true);
    const env = await resolveExecutionEnv(
      {
        backend: 'gondolin',
        guard,
        workspaceRoot: root,
        seededCopyDir: '/tmp/disposable-seed',
        allowedHosts: ['api.example.com'],
        memory: '2G',
        env: { CI: 'false' },
      },
      seams,
    );
    // The VM-backed env was returned (the sentinel marker), NOT the guarded env.
    expect((env as { marker?: string }).marker).toBe(VM_ENV_MARKER);
    expect(env).not.toBeInstanceOf(GuardedExecutionEnv);
    // The VM factory received exactly the VM-only options (mount + egress + bounds).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      seededCopyDir: '/tmp/disposable-seed',
      allowedHosts: ['api.example.com'],
      memory: '2G',
      env: { CI: 'false' },
    });
  });

  it('VM REQUESTED + UNAVAILABLE → SILENTLY DEGRADES to GuardedExecutionEnv (no throw, no VM)', async () => {
    const { seams, calls } = seamsFor(false);
    const env = await resolveExecutionEnv(
      {
        backend: 'gondolin',
        guard,
        workspaceRoot: root,
        seededCopyDir: '/tmp/disposable-seed',
      },
      seams,
    );
    // Fell back to the in-process guarded backend — the VM factory was never called.
    expect(env).toBeInstanceOf(GuardedExecutionEnv);
    expect(calls).toHaveLength(0);
    // The guarded fallback is anchored at the workspace root, not /workspace.
    expect(env.cwd()).toBe(root);
  });

  it('backend:in-process → GuardedExecutionEnv WITHOUT probing availability', async () => {
    let probed = false;
    const seams = {
      isAvailable: async () => {
        probed = true;
        return true;
      },
      createGondolin: async (): Promise<PiExecutionEnv> => {
        throw new Error('createGondolin must NOT be called for backend:in-process');
      },
    };
    const env = await resolveExecutionEnv(
      { backend: 'in-process', guard, workspaceRoot: root },
      seams,
    );
    expect(env).toBeInstanceOf(GuardedExecutionEnv);
    // An in-process request must NOT touch the host availability probe at all.
    expect(probed).toBe(false);
    expect(env.cwd()).toBe(root);
  });
});

// ---------------------------------------------------------------------------
// Misconfiguration vs degradation
// ---------------------------------------------------------------------------

describe('resolveExecutionEnv — misconfiguration is NOT silently degraded', () => {
  it('VM requested + available but NO seededCopyDir → ExecutionEnvConfigError (caller bug)', async () => {
    const { seams, calls } = seamsFor(true);
    await expect(
      resolveExecutionEnv({ backend: 'gondolin', guard, workspaceRoot: root }, seams),
    ).rejects.toBeInstanceOf(ExecutionEnvConfigError);
    // It is NOT a silent fallback: the VM factory was never reached either.
    expect(calls).toHaveLength(0);
  });

  it('VM requested + UNAVAILABLE + no seededCopyDir → degrades cleanly (config error never fires)', async () => {
    const { seams } = seamsFor(false);
    // When the VM is unavailable the seededCopyDir is irrelevant — the fallback
    // does not need it, so the absence is NOT a misconfiguration here.
    const env = await resolveExecutionEnv(
      { backend: 'gondolin', guard, workspaceRoot: root },
      seams,
    );
    expect(env).toBeInstanceOf(GuardedExecutionEnv);
  });
});

// ---------------------------------------------------------------------------
// The fallback is the REAL guarded backend (functional, not a stub)
// ---------------------------------------------------------------------------

describe('resolveExecutionEnv — the degraded env is a fully-functional GuardedExecutionEnv', () => {
  it('the fallback env confines reads to the workspace root (deny-first still holds)', async () => {
    const { seams } = seamsFor(false);
    const env = await resolveExecutionEnv(
      { backend: 'gondolin', guard, workspaceRoot: root },
      seams,
    );
    // A path that climbs out of the workspace is denied by the guarded backend.
    const r = await env.readTextFile('/etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_PI_FS_DENIED');
  });
});
