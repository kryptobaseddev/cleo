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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CursorInstallProvider } from '../install.js';

describe('CursorInstallProvider — PreCompact hook templates', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'cleo-cursor-install-'));
    const fixtureHome = join(projectDir, 'fixture-home');
    vi.stubEnv('HOME', fixtureHome);
    vi.stubEnv('USERPROFILE', fixtureHome);
    vi.stubEnv('CLEO_HOME', join(fixtureHome, '.cleo'));
    mkdirSync(join(fixtureHome, '.cleo', 'templates'), { recursive: true });
    writeFileSync(
      join(fixtureHome, '.cleo', 'templates', 'CLEO-INJECTION.md'),
      'Fixture protocol: inspect authority and coverage.',
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('T12385: reports a malformed hooks.json and leaves it byte-identical', async () => {
    const hooksJsonPath = join(projectDir, '.cursor', 'hooks.json');
    mkdirSync(join(projectDir, '.cursor'), { recursive: true });
    const malformed = '{ "hooks": { "preCompact": [ ';
    writeFileSync(hooksJsonPath, malformed, 'utf-8');

    const result = await new CursorInstallProvider().install({ projectDir });

    expect(readFileSync(hooksJsonPath, 'utf-8')).toBe(malformed);
    expect(result.success).toBe(false);
    expect(String(result.details?.hooksError)).toMatch(/not a valid JSON object/);
  });

  it('T12385: writes rule files through the CAAMP writer (managed block, registry references)', async () => {
    const legacyPath = join(projectDir, '.cursorrules');
    // A pre-CAAMP .cursorrules with the old bare reference lines appended.
    writeFileSync(
      legacyPath,
      '# Project Rules\nUse TypeScript.\n@~/.cleo/templates/CLEO-INJECTION.md\n@.cleo/memory-bridge.md\n',
      'utf-8',
    );

    await new CursorInstallProvider().install({ projectDir });

    const legacy = readFileSync(legacyPath, 'utf-8');
    expect(legacy).toContain('# Project Rules\nUse TypeScript.');
    expect(legacy).toContain('<!-- CAAMP:START -->');
    expect(legacy.match(/CLEO-INJECTION\.md/g)).toHaveLength(1);

    const mdc = readFileSync(join(projectDir, '.cursor', 'rules', 'cleo.mdc'), 'utf-8');
    expect(mdc.startsWith('---\n')).toBe(true);
    expect(mdc).toContain('alwaysApply: true');
    expect(mdc).toContain('<!-- CAAMP:START -->');
    expect(mdc).toContain('@.cleo/memory-bridge.md');
  });
});
