/**
 * OPT-IN real-VM integration test for the Gondolin selector (T11910 · T11888-C).
 *
 * This is the ONE test that may boot a REAL micro-VM. It is GATED on the host
 * actually having the sandbox infra — the optional `@earendil-works/gondolin`
 * package loads AND `/dev/kvm` exists AND a working `qemu-system-x86_64` is on
 * `PATH` (the same AND-gate as {@link isGondolinAvailable}) — AND the explicit
 * opt-in env flag `CLEO_GONDOLIN_INTEGRATION=1`. When ANY of those is absent the
 * suite is SKIPPED (never failed), so CI — gondolin uninstalled, no `/dev/kvm`,
 * no QEMU — stays green with zero VM infra. The unit matrix
 * ({@link ./resolve-execution-env.test.js}) mocks the VM and is the always-run
 * coverage; this file only adds value on a real KVM-capable box.
 *
 * Run it deliberately, cgroup-wrapped (the MEMORY.md OOM cap), e.g.:
 *   systemd-run --user --scope -p MemoryMax=32G -p MemorySwapMax=0 -- \
 *     env CLEO_GONDOLIN_INTEGRATION=1 \
 *     pnpm --filter @cleocode/core test -- --maxWorkers=1 resolve-execution-env
 *
 * @epic T11599
 * @task T11910
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToolGuard } from '../../../tools/guard.js';
import { isGondolinAvailable } from '../gondolin-loader.js';
import type { PiExecutionEnv } from '../pi-execution-env.js';
import { resolveExecutionEnv } from '../resolve-execution-env.js';

/**
 * Whether the real-VM exercise should run: the explicit opt-in flag AND the host
 * sandbox infra (package + `/dev/kvm` + QEMU) are both present. Awaited in
 * `beforeAll` so an unavailable host skips every case rather than throwing at
 * VM-boot time.
 */
async function shouldRunRealVm(): Promise<boolean> {
  if (process.env.CLEO_GONDOLIN_INTEGRATION !== '1') return false;
  return isGondolinAvailable();
}

describe('resolveExecutionEnv — REAL VM integration (opt-in, gated on /dev/kvm + QEMU)', () => {
  let enabled = false;
  let root: string;
  let seededCopyDir: string;
  let env: PiExecutionEnv | undefined;

  beforeAll(async () => {
    enabled = await shouldRunRealVm();
    if (!enabled) return;
    root = mkdtempSync(join(tmpdir(), 'gondolin-int-'));
    // The VM's single RW mount: a disposable seeded copy (NEVER a live DB dir).
    seededCopyDir = mkdtempSync(join(tmpdir(), 'gondolin-seed-'));
  });

  afterAll(async () => {
    if (env !== undefined) await env.cleanup();
    if (enabled) {
      rmSync(root, { recursive: true, force: true });
      rmSync(seededCopyDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.env.CLEO_GONDOLIN_INTEGRATION === '1')(
    'boots a real VM when requested AND available, then runs a guest command',
    async () => {
      if (!enabled) {
        // Infra absent even though the opt-in flag was set — skip without failing.
        return;
      }
      const guard = createToolGuard({ allowedRoots: [root], mode: 'enforce' });
      env = await resolveExecutionEnv({
        backend: 'gondolin',
        guard,
        workspaceRoot: root,
        seededCopyDir,
        // Egress stays deny-by-default (the factory passes allowedHosts: []).
      });
      // The VM-backed env reports the guest workspace root, not the host root.
      expect(env.cwd()).toBe('/workspace');
      // A trivial guest command round-trips through the real VM.
      const res = await env.exec('echo gondolin-ok');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.stdout).toContain('gondolin-ok');
        expect(res.value.exitCode).toBe(0);
      }
    },
  );
});
