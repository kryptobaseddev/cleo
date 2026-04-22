/**
 * Test: W2-5 global seed-agents bootstrap step.
 *
 * Verifies that {@link installSeedAgentsGlobally} idempotently copies the
 * bundled `.cant` personas from `@cleocode/agents/seed-agents/` into the
 * global CANT agents directory (`~/.local/share/cleo/cant/agents/` on Linux).
 *
 * The test drives the same code path exercised by the npm postinstall hook
 * (`bin/postinstall.js` -> `bootstrapGlobalCleo()` -> `installSeedAgentsGlobally()`),
 * which is the real entry point for end users.
 *
 * `CLEO_HOME` is overridden to a tmpdir so the test never writes to the real
 * user data directory.
 *
 * @task T889 / T897 / W2-5
 */

import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BootstrapContext, installSeedAgentsGlobally } from '../bootstrap.js';
import { getCleoGlobalCantAgentsDir } from '../paths.js';

describe('W2-5 installSeedAgentsGlobally (global seed-agents bootstrap)', () => {
  let tmpHome: string;
  let origCleoHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'cleo-seed-global-'));
    origCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = tmpHome;
    // Cache invalidation is automatic when CLEO_HOME changes, but reset
    // defensively to be robust across test orderings.
    const { _resetPlatformPathsCache } = await import('../system/platform-paths.js');
    _resetPlatformPathsCache();
  });

  afterEach(async () => {
    if (origCleoHome !== undefined) {
      process.env['CLEO_HOME'] = origCleoHome;
    } else {
      delete process.env['CLEO_HOME'];
    }
    const { _resetPlatformPathsCache } = await import('../system/platform-paths.js');
    _resetPlatformPathsCache();
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('copies all bundled seed .cant files into the global cant/agents directory', async () => {
    const ctx: BootstrapContext = { created: [], warnings: [], isDryRun: false };

    await installSeedAgentsGlobally(ctx);

    const targetDir = getCleoGlobalCantAgentsDir();
    expect(targetDir.startsWith(tmpHome)).toBe(true);
    expect(existsSync(targetDir)).toBe(true);

    const copied = readdirSync(targetDir).filter((f) => f.endsWith('.cant'));
    // Post-T1237 seed bundle ships 4 generic templates (orchestrator-generic,
    // dev-lead-generic, code-worker-generic, docs-worker-generic). The
    // cleo-specific personas (cleo-prime/dev/historian/…) live in the
    // cleocode repo's `.cleo/cant/agents/` and are NOT shipped as seeds.
    expect(copied.length).toBeGreaterThanOrEqual(4);
    expect(copied).toContain('orchestrator-generic.cant');
    expect(copied).toContain('dev-lead-generic.cant');
    expect(copied).toContain('code-worker-generic.cant');
    expect(copied).toContain('docs-worker-generic.cant');

    // Should have recorded a "created" entry, not a warning.
    expect(ctx.created.some((c) => c.startsWith('seed-agents (global):'))).toBe(true);
  });

  it('is idempotent — second run copies nothing but does not warn', async () => {
    const ctx1: BootstrapContext = { created: [], warnings: [], isDryRun: false };
    await installSeedAgentsGlobally(ctx1);

    const firstRunCount = readdirSync(getCleoGlobalCantAgentsDir()).filter((f) =>
      f.endsWith('.cant'),
    ).length;

    const ctx2: BootstrapContext = { created: [], warnings: [], isDryRun: false };
    await installSeedAgentsGlobally(ctx2);

    const secondRunCount = readdirSync(getCleoGlobalCantAgentsDir()).filter((f) =>
      f.endsWith('.cant'),
    ).length;

    expect(secondRunCount).toBe(firstRunCount);
    // Second run should produce NO `created` entries (nothing copied).
    expect(ctx2.created).toEqual([]);
    expect(ctx2.warnings).toEqual([]);
  });

  it('dry-run records the planned action without touching the filesystem', async () => {
    const ctx: BootstrapContext = { created: [], warnings: [], isDryRun: true };

    await installSeedAgentsGlobally(ctx);

    expect(existsSync(getCleoGlobalCantAgentsDir())).toBe(false);
    expect(ctx.created.some((c) => c.includes('would copy'))).toBe(true);
  });
});
