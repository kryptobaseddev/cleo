/**
 * Tests for the OpenCode PreCompact hook-template installer (T1013).
 *
 * OpenCode does not have config-based hooks — it uses a JavaScript plugin
 * system. The installer therefore produces:
 *
 * 1. `<projectDir>/.opencode/plugins/hooks/cleo-precompact-core.sh` (shared helper)
 * 2. `<projectDir>/.opencode/plugins/hooks/precompact.sh` (OpenCode shim)
 * 3. `<projectDir>/.opencode/plugins/cleo-precompact.js` (JS plugin that
 *    spawns the shim on `experimental.session.compacting`).
 *
 * @task T1013
 * @epic T1000
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenCodeInstallProvider } from '../install.js';

describe('OpenCodeInstallProvider — PreCompact hook templates', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'cleo-opencode-install-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('installs bash templates under <projectDir>/.opencode/plugins/hooks/', async () => {
    const provider = new OpenCodeInstallProvider();
    const result = await provider.install({ projectDir });
    expect(result.success).toBe(true);

    const hookTemplates = (result.details?.hookTemplates ?? null) as {
      templates: { installedFiles: string[]; targetDir: string };
      pluginWritten: boolean;
    } | null;

    expect(hookTemplates).not.toBeNull();
    expect(hookTemplates?.templates.targetDir).toBe(
      join(projectDir, '.opencode', 'plugins', 'hooks'),
    );
    const installed = hookTemplates?.templates.installedFiles ?? [];
    expect(installed.some((p) => p.endsWith('cleo-precompact-core.sh'))).toBe(true);
    expect(installed.some((p) => p.endsWith('precompact.sh'))).toBe(true);
  });

  it('generates a JS plugin wrapping the experimental.session.compacting event', async () => {
    const provider = new OpenCodeInstallProvider();
    await provider.install({ projectDir });

    const pluginPath = join(projectDir, '.opencode', 'plugins', 'cleo-precompact.js');
    const plugin = readFileSync(pluginPath, 'utf-8');

    // Plugin subscribes to OpenCode's native PreCompact event
    expect(plugin).toContain('experimental.session.compacting');
    // Plugin spawns the bash shim (not core internals) — universal CLI surface.
    expect(plugin).toContain('spawn');
    expect(plugin).toContain('precompact.sh');
  });

  it('is idempotent — re-running install does not rewrite unchanged plugin files', async () => {
    const provider = new OpenCodeInstallProvider();
    const first = await provider.install({ projectDir });
    const second = await provider.install({ projectDir });

    const firstResult = (first.details?.hookTemplates ?? null) as {
      pluginWritten: boolean;
    } | null;
    // The first install writes both the bash templates and the plugin.
    expect(firstResult?.pluginWritten).toBe(true);

    // On the second pass the generated plugin file matches the source exactly
    // and both bash templates are byte-identical, so the install helper
    // returns `null` (no change required).
    expect(second.details?.hookTemplates ?? null).toBeNull();

    // And the plugin file contents have not been clobbered between the two runs.
    const pluginPath = join(projectDir, '.opencode', 'plugins', 'cleo-precompact.js');
    const plugin = readFileSync(pluginPath, 'utf-8');
    expect(plugin).toContain('experimental.session.compacting');
  });
});
