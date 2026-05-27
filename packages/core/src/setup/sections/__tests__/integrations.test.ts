/**
 * Unit tests for `createIntegrationsSection()` (T9608 / E-CLEO-SETUP-V2).
 *
 * All filesystem I/O is sandboxed to a temp directory via env-var pinning.
 * No network calls are made — the section does not perform any.
 *
 * Test cases:
 *   1. Non-interactive: all four flags applied and persisted correctly.
 *   2. Non-interactive: no flags → short-circuits silently.
 *   3. Non-interactive: invalid SignalDock endpoint URL → throws.
 *   4. Non-interactive: conduitPath not absolute → throws.
 *   5. Interactive: SignalDock enabled + custom endpoint + Studio + no Conduit path.
 *   6. Interactive: SignalDock disabled + Studio disabled + blank Conduit path.
 *   7. `isConfigured()`: returns false when signaldock.enabled not set.
 *   8. `isConfigured()`: returns true when signaldock.enabled is set to false.
 *   9. `isConfigured()`: returns true when signaldock.enabled is set to true.
 *  10. `createBuiltinSections()` includes 'integrations' at position 7.
 *
 * @task T9608
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetCredentialPoolSingletonForTests } from '../../../llm/credential-pool.js';
import {
  createBuiltinSections,
  createIntegrationsSection,
  StubWizardIO,
  WizardRunner,
} from '../../index.js';

const ENV_KEYS = [
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'CLEO_HOME',
  'CLEO_DIR',
  'CLEO_CONFIG_HOME',
  'HOME',
];
const SAVED_ENV: Record<string, string | undefined> = {};

function saveEnv(): void {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

/** Provision a sandboxed temp root for each test. */
function makeTempRoot(): { root: string; projectRoot: string } {
  const root = join(
    tmpdir(),
    `cleo-intg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const projectRoot = join(root, 'project');
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'cleo-home'), { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });

  process.env['XDG_DATA_HOME'] = join(root, 'data');
  process.env['XDG_CONFIG_HOME'] = join(root, 'config');
  process.env['CLEO_HOME'] = join(root, 'cleo-home');
  process.env['HOME'] = root;
  delete process.env['CLEO_DIR'];
  delete process.env['CLEO_CONFIG_HOME'];

  _resetCleoPlatformPathsCache();
  _resetCredentialPoolSingletonForTests();
  return { root, projectRoot };
}

beforeEach(() => {
  saveEnv();
});
afterEach(() => {
  _resetCleoPlatformPathsCache();
  _resetCredentialPoolSingletonForTests();
  restoreEnv();
});

// ---------------------------------------------------------------------------
// Non-interactive path
// ---------------------------------------------------------------------------

describe('integrations section — non-interactive', () => {
  it('applies all four flags and persists to correct config scopes', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIntegrationsSection()]);
    const io = new StubWizardIO();

    const result = await runner.runSection('integrations', io, {
      nonInteractive: true,
      signaldockEnabled: true,
      signaldockEndpoint: 'https://signaldock.example.com',
      studioEnabled: true,
      conduitPath: '/var/cleo/conduit.db',
      projectRoot,
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('signaldock.enabled=true');
    expect(result.summary).toContain('signaldock.endpoint=https://signaldock.example.com');
    expect(result.summary).toContain('studio.enabled=true');
    expect(result.summary).toContain('conduit.dbPath=/var/cleo/conduit.db');

    // Verify global config for SignalDock + Studio.
    const globalCfgPath = join(root, 'cleo-home', 'config.json');
    expect(existsSync(globalCfgPath)).toBe(true);
    const globalCfg = JSON.parse(readFileSync(globalCfgPath, 'utf-8')) as {
      signaldock?: { enabled?: boolean; endpoint?: string };
      studio?: { enabled?: boolean };
    };
    expect(globalCfg.signaldock?.enabled).toBe(true);
    expect(globalCfg.signaldock?.endpoint).toBe('https://signaldock.example.com');
    expect(globalCfg.studio?.enabled).toBe(true);

    // Verify project config for Conduit.
    const projectCfgPath = join(projectRoot, '.cleo', 'config.json');
    expect(existsSync(projectCfgPath)).toBe(true);
    const projectCfg = JSON.parse(readFileSync(projectCfgPath, 'utf-8')) as {
      conduit?: { dbPath?: string };
    };
    expect(projectCfg.conduit?.dbPath).toBe('/var/cleo/conduit.db');
  });

  it('short-circuits silently when no flags are supplied', async () => {
    makeTempRoot();
    const runner = new WizardRunner([createIntegrationsSection()]);
    const io = new StubWizardIO();

    const result = await runner.runSection('integrations', io, {
      nonInteractive: true,
    });

    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/^skipped/);
  });

  it('applies only the flags that are present (partial non-interactive)', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIntegrationsSection()]);
    const io = new StubWizardIO();

    const result = await runner.runSection('integrations', io, {
      nonInteractive: true,
      signaldockEnabled: false,
      projectRoot,
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('signaldock.enabled=false');

    const globalCfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
      signaldock?: { enabled?: boolean };
    };
    expect(globalCfg.signaldock?.enabled).toBe(false);
  });

  it('throws E_SETUP_INVALID_VALUE for an invalid signaldockEndpoint URL', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIntegrationsSection()]);
    const io = new StubWizardIO();

    // invokeSection wraps the throw in a failed: summary.
    const result = await runner.runSection('integrations', io, {
      nonInteractive: true,
      signaldockEndpoint: 'not-a-url',
      projectRoot,
    });

    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/E_SETUP_INVALID_VALUE/);
    expect(result.summary).toMatch(/not-a-url/);
  });

  it('throws E_SETUP_INVALID_VALUE for a relative conduitPath', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIntegrationsSection()]);
    const io = new StubWizardIO();

    const result = await runner.runSection('integrations', io, {
      nonInteractive: true,
      conduitPath: 'relative/path/conduit.db',
      projectRoot,
    });

    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/E_SETUP_INVALID_VALUE/);
    expect(result.summary).toMatch(/absolute path/);
  });

  it('emits Studio start hint when studioEnabled is true', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIntegrationsSection()]);
    const io = new StubWizardIO();

    await runner.runSection('integrations', io, {
      nonInteractive: true,
      studioEnabled: true,
      projectRoot,
    });

    expect(io.infos.some((m) => m.includes('cleo studio start'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Interactive path
// ---------------------------------------------------------------------------

describe('integrations section — interactive', () => {
  it('enables SignalDock with custom endpoint + Studio + no Conduit path', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIntegrationsSection()]);
    // confirms: SignalDock=yes, Studio=yes
    // prompts: endpoint, conduit path (blank → default)
    const io = new StubWizardIO({
      confirms: [true, true],
      prompts: ['https://sd.example.com:8080', ''],
    });

    const result = await runner.runSection('integrations', io, { projectRoot });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('signaldock.enabled=true');
    expect(result.summary).toContain('signaldock.endpoint=https://sd.example.com:8080');
    expect(result.summary).toContain('studio.enabled=true');
    expect(result.summary).toContain('conduit.dbPath=default');

    const globalCfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
      signaldock?: { enabled?: boolean; endpoint?: string };
      studio?: { enabled?: boolean };
    };
    expect(globalCfg.signaldock?.enabled).toBe(true);
    expect(globalCfg.signaldock?.endpoint).toBe('https://sd.example.com:8080');
    expect(globalCfg.studio?.enabled).toBe(true);
  });

  it('disables SignalDock + Studio; blank Conduit path leaves project config untouched', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIntegrationsSection()]);
    // confirms: SignalDock=no, Studio=no
    // prompts: conduit path (blank)
    const io = new StubWizardIO({
      confirms: [false, false],
      prompts: [''],
    });

    const result = await runner.runSection('integrations', io, { projectRoot });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('signaldock.enabled=false');
    expect(result.summary).toContain('studio.enabled=false');

    const globalCfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
      signaldock?: { enabled?: boolean };
      studio?: { enabled?: boolean };
    };
    expect(globalCfg.signaldock?.enabled).toBe(false);
    expect(globalCfg.studio?.enabled).toBe(false);

    // Project config not written (blank conduit path).
    const projectCfgPath = join(projectRoot, '.cleo', 'config.json');
    if (existsSync(projectCfgPath)) {
      const projectCfg = JSON.parse(readFileSync(projectCfgPath, 'utf-8')) as {
        conduit?: { dbPath?: string };
      };
      expect(projectCfg.conduit?.dbPath).toBeUndefined();
    }
  });

  it('uses default endpoint when blank is entered for SignalDock endpoint', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIntegrationsSection()]);
    // confirms: SignalDock=yes, Studio=no
    // prompts: endpoint (blank → default), conduit (blank)
    const io = new StubWizardIO({
      confirms: [true, false],
      prompts: ['', ''],
    });

    await runner.runSection('integrations', io, { projectRoot });

    const globalCfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
      signaldock?: { endpoint?: string };
    };
    expect(globalCfg.signaldock?.endpoint).toBe('http://localhost:4000');
  });

  it('emits Studio start hint when Studio is enabled interactively', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIntegrationsSection()]);
    // confirms: SignalDock=no, Studio=yes
    // prompts: conduit path (blank)
    const io = new StubWizardIO({
      confirms: [false, true],
      prompts: [''],
    });

    await runner.runSection('integrations', io, { projectRoot });

    expect(io.infos.some((m) => m.includes('cleo studio start'))).toBe(true);
  });

  it('emits current state before prompting', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIntegrationsSection()]);
    const io = new StubWizardIO({
      confirms: [false, false],
      prompts: [''],
    });

    await runner.runSection('integrations', io, { projectRoot });

    // First info message must describe current state.
    const stateInfo = io.infos.find((m) => m.includes('Current integrations state'));
    expect(stateInfo).toBeDefined();
    expect(stateInfo).toContain('signaldock.enabled');
    expect(stateInfo).toContain('studio.enabled');
  });
});

// ---------------------------------------------------------------------------
// isConfigured()
// ---------------------------------------------------------------------------

describe('integrations section — isConfigured()', () => {
  it('returns false when signaldock.enabled has never been written', async () => {
    const { projectRoot } = makeTempRoot();
    const section = createIntegrationsSection();
    // isConfigured is optional — guard against missing implementation.
    expect(section.isConfigured).toBeDefined();
    const configured = await section.isConfigured!({ projectRoot });
    expect(configured).toBe(false);
  });

  it('returns true when signaldock.enabled is explicitly set to false', async () => {
    const { projectRoot } = makeTempRoot();
    // Write explicitly via non-interactive run.
    const runner = new WizardRunner([createIntegrationsSection()]);
    const io = new StubWizardIO();
    await runner.runSection('integrations', io, {
      nonInteractive: true,
      signaldockEnabled: false,
      projectRoot,
    });

    // Re-create section for a clean isConfigured check.
    const section = createIntegrationsSection();
    const configured = await section.isConfigured!({ projectRoot });
    expect(configured).toBe(true);
  });

  it('returns true when signaldock.enabled is explicitly set to true', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIntegrationsSection()]);
    const io = new StubWizardIO();
    await runner.runSection('integrations', io, {
      nonInteractive: true,
      signaldockEnabled: true,
      projectRoot,
    });

    const section = createIntegrationsSection();
    const configured = await section.isConfigured!({ projectRoot });
    expect(configured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createBuiltinSections() registration
// ---------------------------------------------------------------------------

describe('createBuiltinSections() — integrations at position 7', () => {
  it('includes integrations as the 7th section (index 6)', () => {
    const sections = createBuiltinSections();
    expect(sections[6]?.section).toBe('integrations');
  });

  it('has 9 built-in sections after T9572 (telemetry added between integrations and verification)', () => {
    const sections = createBuiltinSections();
    expect(sections).toHaveLength(9);
  });

  it('section ids are in the expected canonical order', () => {
    const sections = createBuiltinSections();
    expect(sections.map((s) => s.section)).toEqual([
      'llm',
      'identity',
      'sentient',
      'project-conventions',
      'harness',
      'brain',
      'integrations',
      'telemetry',
      'verification',
    ]);
  });
});
