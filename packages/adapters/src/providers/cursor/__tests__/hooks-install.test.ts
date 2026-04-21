/**
 * Tests for the Cursor PreCompact hook-template installer (T1013).
 *
 * Validates that:
 * - The Cursor adapter copies the shared helper + provider shim into
 *   `<projectDir>/.cursor/hooks/`.
 * - `<projectDir>/.cursor/hooks.json` gains a `preCompact` entry (CAAMP's
 *   native event name for Cursor) tagged with the `# cleo-hook` sentinel.
 * - Repeat invocations are idempotent.
 *
 * The test writes to a scoped tmp project directory so no user config is
 * touched.
 *
 * @task T1013
 * @epic T1000
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CursorInstallProvider } from '../install.js';

describe('CursorInstallProvider — PreCompact hook templates', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'cleo-cursor-install-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('installs both bash templates into <projectDir>/.cursor/hooks/', async () => {
    const provider = new CursorInstallProvider();

    const result = await provider.install({ projectDir });
    expect(result.success).toBe(true);

    const hookTemplates = (result.details?.hookTemplates ?? null) as {
      templates: { installedFiles: string[]; targetDir: string };
      hooksJsonEntryAdded: boolean;
    } | null;

    expect(hookTemplates).not.toBeNull();
    expect(hookTemplates?.templates.targetDir).toBe(join(projectDir, '.cursor', 'hooks'));
    const installed = hookTemplates?.templates.installedFiles ?? [];
    expect(installed.some((p) => p.endsWith('cleo-precompact-core.sh'))).toBe(true);
    expect(installed.some((p) => p.endsWith('precompact.sh'))).toBe(true);

    // Provider shim sources the shared helper so the DRY contract holds.
    const shim = readFileSync(join(projectDir, '.cursor', 'hooks', 'precompact.sh'), 'utf-8');
    expect(shim).toContain('cleo-precompact-core.sh');
    // Cursor's banner references its native event name for the canonical PreCompact.
    expect(shim).toContain('preCompact');
  });

  it('writes a preCompact entry into <projectDir>/.cursor/hooks.json tagged # cleo-hook', async () => {
    const provider = new CursorInstallProvider();
    await provider.install({ projectDir });

    const hooksJsonPath = join(projectDir, '.cursor', 'hooks.json');
    const config = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks?: Record<string, Array<{ command?: string; type?: string }>>;
    };

    const entries = config.hooks?.preCompact ?? [];
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[0];
    expect(entry).toBeDefined();
    expect(entry?.type).toBe('command');
    expect(entry?.command).toContain('precompact.sh');
    expect(entry?.command).toContain('# cleo-hook');
  });

  it('is idempotent — re-running install does not duplicate the preCompact entry', async () => {
    const provider = new CursorInstallProvider();
    await provider.install({ projectDir });
    await provider.install({ projectDir });

    const hooksJsonPath = join(projectDir, '.cursor', 'hooks.json');
    const config = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks?: { preCompact?: unknown[] };
    };
    expect((config.hooks?.preCompact ?? []).length).toBe(1);
  });
});
