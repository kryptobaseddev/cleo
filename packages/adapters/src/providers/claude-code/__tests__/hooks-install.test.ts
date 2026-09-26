/**
 * Tests for the Claude Code PreCompact hook-template installer (T1013).
 *
 * Validates that:
 * - Shared `cleo-precompact-core.sh` and provider-specific
 *   `precompact-safestop.sh` are copied into `~/.claude/hooks/`.
 * - `~/.claude/settings.json` gains a `PreCompact` entry pointing at the
 *   installed shim, tagged with the `# cleo-hook` sentinel for clean uninstall.
 * - Repeat invocations are idempotent (no duplicate settings entries).
 * - The source templates contain the universal CLEO CLI invocations so the
 *   bash contract remains DRY across providers.
 *
 * The tests use real filesystem writes under a scoped tmp directory that
 * impersonates `$HOME` via the `HOME` env var, so no user config is touched.
 *
 * @task T1013
 * @epic T1000
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeHookProvider } from '../hooks.js';
import { ClaudeCodeInstallProvider } from '../install.js';

describe('ClaudeCodeInstallProvider — PreCompact hook templates', () => {
  let fakeHome: string;
  let realHome: string | undefined;
  let realUserProfile: string | undefined;
  let realClaudeHome: string | undefined;
  let projectDir: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    realUserProfile = process.env.USERPROFILE;
    realClaudeHome = process.env.CLAUDE_HOME;
    fakeHome = mkdtempSync(join(tmpdir(), 'cleo-claude-install-'));
    projectDir = mkdtempSync(join(tmpdir(), 'cleo-claude-project-'));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.CLAUDE_HOME = join(fakeHome, '.claude');
    mkdirSync(join(fakeHome, '.cleo', 'templates'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.cleo', 'templates', 'CLEO-INJECTION.md'),
      'Fixture protocol: inspect authority and coverage.',
    );
  });

  afterEach(() => {
    if (realHome !== undefined) {
      process.env.HOME = realHome;
    } else {
      delete process.env.HOME;
    }
    if (realUserProfile !== undefined) {
      process.env.USERPROFILE = realUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    if (realClaudeHome !== undefined) {
      process.env.CLAUDE_HOME = realClaudeHome;
    } else {
      delete process.env.CLAUDE_HOME;
    }
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('installs both bash templates into $HOME/.claude/hooks/', async () => {
    const provider = new ClaudeCodeInstallProvider();

    const result = await provider.install({ projectDir });
    expect(result.success).toBe(true);

    const hookTemplates = (result.details?.hookTemplates ?? null) as {
      templates: { installedFiles: string[]; targetDir: string };
      settingsEntryAdded: boolean;
    } | null;

    expect(hookTemplates).not.toBeNull();
    expect(hookTemplates?.templates.targetDir).toBe(join(fakeHome, '.claude', 'hooks'));
    const installed = hookTemplates?.templates.installedFiles ?? [];
    expect(installed.some((p) => p.endsWith('cleo-precompact-core.sh'))).toBe(true);
    expect(installed.some((p) => p.endsWith('precompact-safestop.sh'))).toBe(true);

    // Installed shim sources the shared helper.
    const shim = readFileSync(
      join(fakeHome, '.claude', 'hooks', 'precompact-safestop.sh'),
      'utf-8',
    );
    expect(shim).toContain('cleo-precompact-core.sh');
    // Shared helper invokes the universal CLEO CLI.
    const core = readFileSync(
      join(fakeHome, '.claude', 'hooks', 'cleo-precompact-core.sh'),
      'utf-8',
    );
    expect(core).toContain('cleo memory precompact-flush');
    expect(core).toContain('cleo');
    expect(core).toMatch(/cleo_cmd.*safestop/);
  });

  it('writes a PreCompact entry into $HOME/.claude/settings.json tagged # cleo-hook', async () => {
    const provider = new ClaudeCodeInstallProvider();
    await provider.install({ projectDir });

    const settingsPath = join(fakeHome, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; type?: string }> }>>;
    };

    const preCompact = settings.hooks?.PreCompact ?? [];
    expect(preCompact.length).toBeGreaterThan(0);
    const firstEntry = preCompact[0];
    expect(firstEntry).toBeDefined();
    const firstHook = firstEntry?.hooks?.[0];
    expect(firstHook?.type).toBe('command');
    expect(firstHook?.command).toContain('precompact-safestop.sh');
    expect(firstHook?.command).toContain('# cleo-hook');
  });

  it('is idempotent — re-running install does not duplicate the PreCompact entry', async () => {
    const provider = new ClaudeCodeInstallProvider();
    await provider.install({ projectDir });
    await provider.install({ projectDir });

    const settingsPath = join(fakeHome, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: { PreCompact?: unknown[] };
    };
    expect((settings.hooks?.PreCompact ?? []).length).toBe(1);
  });

  // T12385 — a malformed settings.json used to be replaced with an object
  // holding only CLEO's entries (the parse error was caught and the writer
  // "started fresh"). It must now be reported and left byte-identical.
  describe('T12385 — malformed settings.json is never rewritten', () => {
    const malformed = '{\n  "permissions": { "allow": ["Bash(ls)"] },\n  "model": "opus",\n';

    it('install reports the parse error and leaves the file byte-identical', async () => {
      const settingsPath = join(fakeHome, '.claude', 'settings.json');
      mkdirSync(join(fakeHome, '.claude'), { recursive: true });
      writeFileSync(settingsPath, malformed, 'utf-8');

      const result = await new ClaudeCodeInstallProvider().install({ projectDir });

      expect(readFileSync(settingsPath, 'utf-8')).toBe(malformed);
      expect(result.success).toBe(false);
      const errors = (result.details?.settingsErrors ?? []) as string[];
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/not a valid JSON object/);
      expect(existsSync(`${settingsPath}.lock`)).toBe(false);
    });

    it('hook registration reports the parse error and leaves the file byte-identical', async () => {
      const settingsPath = join(fakeHome, '.claude', 'settings.json');
      mkdirSync(join(fakeHome, '.claude'), { recursive: true });
      writeFileSync(settingsPath, malformed, 'utf-8');
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const hooks = new ClaudeCodeHookProvider();
      await hooks.registerNativeHooks(projectDir);
      await hooks.unregisterNativeHooks();

      stderr.mockRestore();
      expect(readFileSync(settingsPath, 'utf-8')).toBe(malformed);
      expect(hooks.getSettingsError()).toMatch(/not a valid JSON object/);
    });

    it('preserves unrelated user settings when it does write', async () => {
      const settingsPath = join(fakeHome, '.claude', 'settings.json');
      mkdirSync(join(fakeHome, '.claude'), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({ model: 'opus', hooks: { Stop: [{ matcher: 'x', hooks: [] }] } }),
        'utf-8',
      );

      await new ClaudeCodeHookProvider().registerNativeHooks(projectDir);
      await new ClaudeCodeInstallProvider().install({ projectDir });

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        model?: string;
        enabledPlugins?: Record<string, boolean>;
        hooks?: Record<string, unknown[]>;
      };
      expect(settings.model).toBe('opus');
      expect(settings.enabledPlugins?.['cleo@cleocode']).toBe(true);
      expect(settings.hooks?.Stop).toHaveLength(2);
      expect(settings.hooks?.PreCompact).toHaveLength(1);
    });
  });
});
