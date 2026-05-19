/**
 * End-to-end integration tests for the CLEO setup wizard — all 8 sections
 * via {@link StubWizardIO} (E-CLEO-SETUP-V2 / T9614).
 *
 * Covers:
 *   1. Full 8-section run via `WizardRunner.run()` — canonical order confirmed.
 *   2. `createDefaultWizardRunner()` produces a runner with all 8 sections.
 *   3. Per-section happy-path non-interactive run (all sections).
 *   4. Per-section interactive happy-path run (all sections).
 *   5. `isConfigured()` idempotency — sections skip on second run unless --reset.
 *   6. Studio parity: same section runs identically when invoked via
 *      `WizardRunner.runSection()` (the Studio HTTP path).
 *   7. End-to-end: run all 8 sections non-interactively → verify identity,
 *      LLM credential, sentient state, and project conventions are configured.
 *
 * All filesystem access is sandboxed to a per-test temp directory. The real
 * credential pool, global config, and sentient state files are never touched.
 *
 * @task T9614
 * @epic T9591
 * @see docs/plans/E-CLEO-SETUP-V2.md §5.2 T9599
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCredentialPoolSingletonForTests } from '../../llm/credential-pool.js';
import {
  createBuiltinSections,
  createDefaultWizardRunner,
  StubWizardIO,
  WizardRunner,
  type WizardSection,
} from '../index.js';

// ---------------------------------------------------------------------------
// Module-level mocks — keep network and heavy I/O out of integration tests.
// ---------------------------------------------------------------------------

// Mock fetch so the verification section's network probes never make real
// HTTP calls. Individual tests override as needed.
vi.stubGlobal(
  'fetch',
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
  } as Response),
);

// ---------------------------------------------------------------------------
// Env isolation helpers
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'CLEO_HOME',
  'CLEO_DIR',
  'CLEO_CONFIG_HOME',
  'HOME',
  'CLEO_HARNESS',
  'CLAUDECODE',
  'CLEO_PI',
  'CLEO_PI_URL',
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

/**
 * Create a fully isolated temp environment for one test.
 *
 * Returns `projectRoot` (used as the wizard `options.projectRoot`) and
 * `root` (the sandbox home — contains config, data dirs).
 */
function makeTempRoot(): {
  root: string;
  projectRoot: string;
  cleoDir: string;
} {
  const root = join(
    tmpdir(),
    `cleo-integ-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const projectRoot = join(root, 'project');
  const cleoDir = join(projectRoot, '.cleo');

  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'cleo-home'), { recursive: true });
  mkdirSync(cleoDir, { recursive: true });

  process.env['XDG_DATA_HOME'] = join(root, 'data');
  process.env['XDG_CONFIG_HOME'] = join(root, 'config');
  process.env['CLEO_HOME'] = join(root, 'cleo-home');
  process.env['HOME'] = root;
  process.env['CLEO_DIR'] = cleoDir;
  delete process.env['CLEO_CONFIG_HOME'];

  _resetCleoPlatformPathsCache();
  _resetCredentialPoolSingletonForTests();

  return { root, projectRoot, cleoDir };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a JSON config file from the temp sandbox, returning the parsed object
 * or `{}` when the file does not yet exist.
 */
function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

beforeEach(() => {
  saveEnv();
  // Remove env vars that would bleed harness state into verification checks.
  delete process.env['CLEO_HARNESS'];
  delete process.env['CLAUDECODE'];
  delete process.env['CLEO_PI'];
  delete process.env['CLEO_PI_URL'];
});

afterEach(() => {
  _resetCleoPlatformPathsCache();
  _resetCredentialPoolSingletonForTests();
  restoreEnv();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Section registration + canonical order
// ---------------------------------------------------------------------------

describe('createBuiltinSections() — 8-section canonical order', () => {
  it('returns all 8 sections in canonical order', () => {
    const sections = createBuiltinSections();
    expect(sections.map((s) => s.section)).toEqual([
      'llm',
      'identity',
      'sentient',
      'project-conventions',
      'harness',
      'brain',
      'integrations',
      'verification',
    ] satisfies WizardSection[]);
  });

  it('createDefaultWizardRunner() wraps all 8 sections', () => {
    const runner = createDefaultWizardRunner();
    expect(runner.list().map((s) => s.section)).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// 2. llm section — integration
// ---------------------------------------------------------------------------

describe('llm section — integration', () => {
  it('non-interactive: adds credential to pool', async () => {
    makeTempRoot();
    const runner = new WizardRunner([createBuiltinSections().find((s) => s.section === 'llm')!]);
    const io = new StubWizardIO();

    const result = await runner.runSection('llm', io, {
      nonInteractive: true,
      provider: 'anthropic',
      apiKey: 'sk-ant-integ-XXXX',
      label: 'integ-test',
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('added anthropic:integ-test');

    const { getCredentialPool } = await import('../../llm/credential-pool.js');
    const entries = await getCredentialPool().list();
    expect(entries.some((e) => e.provider === 'anthropic' && e.label === 'integ-test')).toBe(true);
  });

  it('interactive: provider select + label prompt + key prompt writes credential', async () => {
    makeTempRoot();
    const runner = new WizardRunner([createBuiltinSections().find((s) => s.section === 'llm')!]);
    const io = new StubWizardIO({
      selects: ['openai', 'api_key'],
      prompts: ['integ-openai', 'sk-openai-integ'],
    });

    const result = await runner.runSection('llm', io);
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('added openai:integ-openai');
  });

  it('isConfigured() returns true once pool has an entry', async () => {
    makeTempRoot();
    const sections = createBuiltinSections();
    const llmSection = sections.find((s) => s.section === 'llm')!;

    // Initially not configured.
    expect(await llmSection.isConfigured?.({})).toBe(false);

    // Add a credential.
    const io = new StubWizardIO();
    await new WizardRunner([llmSection]).runSection('llm', io, {
      nonInteractive: true,
      provider: 'openai',
      apiKey: 'sk-openai-x',
      label: 'test',
    });

    expect(await llmSection.isConfigured?.({})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. identity section — integration
// ---------------------------------------------------------------------------

describe('identity section — integration', () => {
  it('non-interactive: writes agent.name and SOUL.md', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'identity')!,
    ]);
    const io = new StubWizardIO();

    const result = await runner.runSection('identity', io, {
      nonInteractive: true,
      agentName: 'Prometheus',
      soulMdContent: 'I am Prometheus, the fire-giver.',
      projectRoot,
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set agent.name');

    const globalCfg = readJsonFile(join(root, 'cleo-home', 'config.json')) as {
      agent?: { name?: string };
    };
    expect(globalCfg.agent?.name).toBe('Prometheus');

    const soulPath = join(projectRoot, '.cleo', 'SOUL.md');
    expect(existsSync(soulPath)).toBe(true);
    expect(readFileSync(soulPath, 'utf-8')).toContain('Prometheus');
  });

  it('interactive: prompts for name, SOUL.md consent, and SignalDock consent', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'identity')!,
    ]);
    const io = new StubWizardIO({
      prompts: ['Athena', 'I am Athena, goddess of wisdom.'],
      confirms: [true, false], // wants soul + no SignalDock
    });

    const result = await runner.runSection('identity', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set agent.name');
  });

  it('isConfigured() returns false when agent.name is not set', async () => {
    const { projectRoot } = makeTempRoot();
    const section = createBuiltinSections().find((s) => s.section === 'identity')!;
    expect(await section.isConfigured?.({ projectRoot })).toBe(false);
  });

  it('isConfigured() returns true after name is written', async () => {
    const { projectRoot } = makeTempRoot();
    const section = createBuiltinSections().find((s) => s.section === 'identity')!;

    await new WizardRunner([section]).runSection('identity', new StubWizardIO(), {
      nonInteractive: true,
      agentName: 'Hermes',
      projectRoot,
    });

    expect(await section.isConfigured?.({ projectRoot })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. sentient section — integration
// ---------------------------------------------------------------------------

describe('sentient section — integration', () => {
  it('non-interactive: writes sentient-state.json with daemon + tier2', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'sentient')!,
    ]);
    const io = new StubWizardIO();

    const result = await runner.runSection('sentient', io, {
      nonInteractive: true,
      sentientEnabled: true,
      tier2Enabled: false,
      projectRoot,
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('daemon enabled');

    const statePath = join(projectRoot, '.cleo', 'sentient-state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      killSwitch?: boolean;
      tier2Enabled?: boolean;
    };
    expect(state.killSwitch).toBe(false);
    expect(state.tier2Enabled).toBe(false);
  });

  it('interactive: two confirm prompts drive both toggles', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'sentient')!,
    ]);
    const io = new StubWizardIO({ confirms: [true, true] });

    const result = await runner.runSection('sentient', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('daemon enabled');
    expect(result.summary).toContain('tier2 enabled');
  });

  it('isConfigured() returns true once sentient-state.json exists', async () => {
    const { projectRoot } = makeTempRoot();
    const section = createBuiltinSections().find((s) => s.section === 'sentient')!;

    expect(await section.isConfigured?.({ projectRoot })).toBe(false);

    await new WizardRunner([section]).runSection('sentient', new StubWizardIO(), {
      nonInteractive: true,
      sentientEnabled: false,
      tier2Enabled: false,
      projectRoot,
    });

    expect(await section.isConfigured?.({ projectRoot })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. harness section — integration
// ---------------------------------------------------------------------------

describe('harness section — integration', () => {
  it('non-interactive: writes harness.active to global config', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'harness')!,
    ]);
    const io = new StubWizardIO();

    const result = await runner.runSection('harness', io, {
      nonInteractive: true,
      harness: 'claude-code',
      projectRoot,
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set harness.active=claude-code');

    const globalCfg = readJsonFile(join(root, 'cleo-home', 'config.json')) as {
      harness?: { active?: string };
    };
    expect(globalCfg.harness?.active).toBe('claude-code');
  });

  it('interactive: select prompt drives harness pick (claude-code avoids Pi URL prompt)', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'harness')!,
    ]);
    // Use claude-code so no Pi URL prompt is issued.
    const io = new StubWizardIO({ selects: ['claude-code'] });

    const result = await runner.runSection('harness', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set harness.active=claude-code');
  });

  it('interactive: pi harness also prompts for Pi URL', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'harness')!,
    ]);
    // pi selection triggers a Pi URL prompt — supply an empty string to accept the default.
    const io = new StubWizardIO({ selects: ['pi'], prompts: [''] });

    const result = await runner.runSection('harness', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set harness.active=pi');
  });

  it('isConfigured() returns true after harness.active is written', async () => {
    const { root, projectRoot } = makeTempRoot();
    const section = createBuiltinSections().find((s) => s.section === 'harness')!;

    expect(await section.isConfigured?.({ projectRoot })).toBe(false);

    await new WizardRunner([section]).runSection('harness', new StubWizardIO(), {
      nonInteractive: true,
      harness: 'pi',
      projectRoot,
    });

    expect(await section.isConfigured?.({ projectRoot })).toBe(true);

    // Verify the global config was actually written.
    const globalCfg = readJsonFile(join(root, 'cleo-home', 'config.json')) as {
      harness?: { active?: string };
    };
    expect(globalCfg.harness?.active).toBe('pi');
  });
});

// ---------------------------------------------------------------------------
// 6. brain section — integration
// ---------------------------------------------------------------------------

describe('brain section — integration', () => {
  it('non-interactive: persists bridge mode to global config', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createBuiltinSections().find((s) => s.section === 'brain')!]);
    const io = new StubWizardIO();

    const result = await runner.runSection('brain', io, {
      nonInteractive: true,
      brainBridgeMode: 'file',
      projectRoot,
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set brain.memoryBridge.mode=file');

    const globalCfg = readJsonFile(join(root, 'cleo-home', 'config.json')) as {
      brain?: { memoryBridge?: { mode?: string } };
    };
    expect(globalCfg.brain?.memoryBridge?.mode).toBe('file');
  });

  it('non-interactive: digest mode writes "cli" to disk, retention days and embedding toggle', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createBuiltinSections().find((s) => s.section === 'brain')!]);
    const io = new StubWizardIO();

    const result = await runner.runSection('brain', io, {
      nonInteractive: true,
      brainBridgeMode: 'digest',
      brainRetentionDays: 30,
      brainEmbeddingEnabled: true,
      projectRoot,
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('brain.memoryBridge.mode=digest');
    expect(result.summary).toContain('brain.retention.days=30');
    expect(result.summary).toContain('brain.embedding.enabled=true');

    const globalCfg = readJsonFile(join(root, 'cleo-home', 'config.json')) as {
      brain?: {
        memoryBridge?: { mode?: string };
        retention?: { days?: number };
        embedding?: { enabled?: boolean };
      };
    };
    // 'digest' maps to 'cli' on disk.
    expect(globalCfg.brain?.memoryBridge?.mode).toBe('cli');
    expect(globalCfg.brain?.retention?.days).toBe(30);
    expect(globalCfg.brain?.embedding?.enabled).toBe(true);
  });

  it('interactive: select + retention days + embedding confirm', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createBuiltinSections().find((s) => s.section === 'brain')!]);
    const io = new StubWizardIO({
      selects: ['disabled'],
      prompts: ['7'],
      confirms: [false],
    });

    const result = await runner.runSection('brain', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('disabled');
    expect(result.summary).toContain('brain.retention.days=7');
    expect(result.summary).toContain('brain.embedding.enabled=false');
  });

  it('isConfigured() returns true after bridge mode is written', async () => {
    const { projectRoot } = makeTempRoot();
    const section = createBuiltinSections().find((s) => s.section === 'brain')!;

    expect(await section.isConfigured?.({ projectRoot })).toBe(false);

    await new WizardRunner([section]).runSection('brain', new StubWizardIO(), {
      nonInteractive: true,
      brainBridgeMode: 'disabled',
      projectRoot,
    });

    expect(await section.isConfigured?.({ projectRoot })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. project-conventions section — integration
// ---------------------------------------------------------------------------

describe('project-conventions section — integration', () => {
  it('non-interactive: applies standard preset to project config', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'project-conventions')!,
    ]);
    const io = new StubWizardIO();

    const result = await runner.runSection('project-conventions', io, {
      nonInteractive: true,
      strictness: 'standard',
      projectRoot,
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain("applied 'standard' preset");

    const projectCfg = readJsonFile(join(projectRoot, '.cleo', 'config.json')) as {
      enforcement?: { acceptance?: { mode?: string } };
    };
    expect(projectCfg.enforcement?.acceptance?.mode).toBe('warn');
  });

  it('non-interactive: strict preset blocks on missing ACs', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'project-conventions')!,
    ]);
    const io = new StubWizardIO();

    const result = await runner.runSection('project-conventions', io, {
      nonInteractive: true,
      strictness: 'strict',
      projectRoot,
    });

    expect(result.changed).toBe(true);
    const projectCfg = readJsonFile(join(projectRoot, '.cleo', 'config.json')) as {
      enforcement?: { acceptance?: { mode?: string } };
    };
    expect(projectCfg.enforcement?.acceptance?.mode).toBe('block');
  });

  it('interactive: select drives preset + fine-grained overrides', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'project-conventions')!,
    ]);
    // select: preset + 2 override choices
    const io = new StubWizardIO({
      selects: ['minimal', 'off', 'keep-preset-default'],
    });

    const result = await runner.runSection('project-conventions', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain("applied 'minimal' preset");
  });

  it('isConfigured() returns true after strictness preset is written', async () => {
    const { projectRoot } = makeTempRoot();
    const section = createBuiltinSections().find((s) => s.section === 'project-conventions')!;

    expect(await section.isConfigured?.({ projectRoot })).toBe(false);

    await new WizardRunner([section]).runSection('project-conventions', new StubWizardIO(), {
      nonInteractive: true,
      strictness: 'minimal',
      projectRoot,
    });

    expect(await section.isConfigured?.({ projectRoot })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. integrations section — integration
// ---------------------------------------------------------------------------

describe('integrations section — integration', () => {
  it('non-interactive: writes signaldock.enabled + endpoint to global config', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'integrations')!,
    ]);
    const io = new StubWizardIO();

    const result = await runner.runSection('integrations', io, {
      nonInteractive: true,
      signaldockEnabled: true,
      signaldockEndpoint: 'http://localhost:4000',
      studioEnabled: true,
      projectRoot,
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('signaldock.enabled=true');
    expect(result.summary).toContain('signaldock.endpoint=http://localhost:4000');
    expect(result.summary).toContain('studio.enabled=true');

    const globalCfg = readJsonFile(join(root, 'cleo-home', 'config.json')) as {
      signaldock?: { enabled?: boolean; endpoint?: string };
      studio?: { enabled?: boolean };
    };
    expect(globalCfg.signaldock?.enabled).toBe(true);
    expect(globalCfg.signaldock?.endpoint).toBe('http://localhost:4000');
    expect(globalCfg.studio?.enabled).toBe(true);
  });

  it('non-interactive: rejects invalid signaldock endpoint URL', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'integrations')!,
    ]);
    const io = new StubWizardIO();

    const result = await runner.runSection('integrations', io, {
      nonInteractive: true,
      signaldockEnabled: true,
      signaldockEndpoint: 'not-a-url',
      projectRoot,
    });

    // invokeSection catches the thrown error and surfaces it as failed: summary.
    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/E_SETUP_INVALID_VALUE/);
  });

  it('non-interactive: conduitPath must be absolute', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'integrations')!,
    ]);
    const io = new StubWizardIO();

    const result = await runner.runSection('integrations', io, {
      nonInteractive: true,
      conduitPath: 'relative/path/conduit.db',
      projectRoot,
    });

    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/E_SETUP_INVALID_VALUE/);
  });

  it('non-interactive: writes conduit.dbPath to project config', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'integrations')!,
    ]);
    const io = new StubWizardIO();

    const result = await runner.runSection('integrations', io, {
      nonInteractive: true,
      conduitPath: '/tmp/my-conduit.db',
      projectRoot,
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('conduit.dbPath=/tmp/my-conduit.db');
  });

  it('interactive: all three sub-prompts complete without errors', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'integrations')!,
    ]);
    const io = new StubWizardIO({
      confirms: [true, false], // want SignalDock, no Studio
      prompts: ['', ''], // default endpoint, blank conduit path
    });

    const result = await runner.runSection('integrations', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('signaldock.enabled=true');
    expect(result.summary).toContain('signaldock.endpoint=http://localhost:4000');
  });

  it('isConfigured() returns true after signaldock.enabled is set', async () => {
    const { projectRoot } = makeTempRoot();
    const section = createBuiltinSections().find((s) => s.section === 'integrations')!;

    expect(await section.isConfigured?.({ projectRoot })).toBe(false);

    await new WizardRunner([section]).runSection('integrations', new StubWizardIO(), {
      nonInteractive: true,
      signaldockEnabled: false,
      projectRoot,
    });

    // Even false counts as "configured" — the operator explicitly opted out.
    expect(await section.isConfigured?.({ projectRoot })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. verification section — integration
// ---------------------------------------------------------------------------

describe('verification section — integration', () => {
  it('always returns changed: false (read-only contract, VERIF-1)', async () => {
    makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'verification')!,
    ]);
    const io = new StubWizardIO();

    const result = await runner.runSection('verification', io, { nonInteractive: true });
    expect(result.changed).toBe(false);
  });

  it('isConfigured() always returns false (VERIF-6)', async () => {
    const section = createBuiltinSections().find((s) => s.section === 'verification')!;
    expect(await section.isConfigured?.({})).toBe(false);
  });

  it('non-interactive: emits valid JSON array of 6 checks', async () => {
    makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'verification')!,
    ]);
    const io = new StubWizardIO();

    await runner.runSection('verification', io, { nonInteractive: true });

    const jsonMsg = io.infos.find((m) => {
      try {
        return Array.isArray(JSON.parse(m));
      } catch {
        return false;
      }
    });
    expect(jsonMsg).toBeDefined();
    const parsed = JSON.parse(jsonMsg!) as unknown[];
    expect(parsed).toHaveLength(6);
    for (const item of parsed) {
      expect(item).toMatchObject({
        name: expect.any(String),
        status: expect.stringMatching(/^(PASS|FAIL|SKIP)$/),
        message: expect.any(String),
      });
    }
  });

  it('interactive: renders a human-readable table', async () => {
    makeTempRoot();
    const runner = new WizardRunner([
      createBuiltinSections().find((s) => s.section === 'verification')!,
    ]);
    const io = new StubWizardIO();

    await runner.runSection('verification', io, { nonInteractive: false });

    // The table header should be present in io.infos.
    expect(io.infos.some((m) => m.includes('Check') && m.includes('Status'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. End-to-end: run all 8 sections non-interactively
// ---------------------------------------------------------------------------

describe('end-to-end: all 8 sections via WizardRunner.run()', () => {
  it('runs all 8 sections in canonical order and mutates expected state', async () => {
    const { root, projectRoot, cleoDir } = makeTempRoot();

    // Create a dummy brain.db so verification section does not FAIL on it.
    writeFileSync(join(cleoDir, 'brain.db'), 'SQLite format 3\x00');

    const runner = createDefaultWizardRunner();
    const io = new StubWizardIO();

    const result = await runner.run(io, {
      nonInteractive: true,
      // identity
      agentName: 'E2E-Agent',
      projectRoot,
      // llm
      provider: 'anthropic',
      apiKey: 'sk-ant-e2e-AAAA',
      label: 'e2e-test',
      // sentient
      sentientEnabled: false,
      tier2Enabled: false,
      // harness
      harness: 'claude-code',
      // brain
      brainBridgeMode: 'digest',
      // project-conventions
      strictness: 'standard',
      // integrations
      signaldockEnabled: false,
    });

    // All 8 sections ran.
    expect(result.sectionsRun).toHaveLength(8);
    expect(result.sectionsRun).toEqual([
      'llm',
      'identity',
      'sentient',
      'project-conventions',
      'harness',
      'brain',
      'integrations',
      'verification',
    ]);

    // No section should have "failed:" in its summary.
    const failures = result.summary.filter((s) => s.includes('failed:'));
    expect(failures).toEqual([]);

    // Verify identity was written.
    const globalCfg = readJsonFile(join(root, 'cleo-home', 'config.json')) as {
      agent?: { name?: string };
      harness?: { active?: string };
      brain?: { memoryBridge?: { mode?: string } };
    };
    expect(globalCfg.agent?.name).toBe('E2E-Agent');
    expect(globalCfg.harness?.active).toBe('claude-code');
    expect(globalCfg.brain?.memoryBridge?.mode).toBe('cli');

    // Verify LLM credential was written.
    const { getCredentialPool } = await import('../../llm/credential-pool.js');
    const entries = await getCredentialPool().list();
    expect(entries.some((e) => e.provider === 'anthropic' && e.label === 'e2e-test')).toBe(true);

    // Verify sentient-state.json was written.
    const statePath = join(projectRoot, '.cleo', 'sentient-state.json');
    expect(existsSync(statePath)).toBe(true);

    // Verify project conventions were applied.
    const projectCfg = readJsonFile(join(projectRoot, '.cleo', 'config.json')) as {
      enforcement?: { acceptance?: { mode?: string } };
    };
    expect(projectCfg.enforcement?.acceptance?.mode).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// 11. Studio parity: runSection() is the Studio call path
// ---------------------------------------------------------------------------

describe('Studio parity: runSection() for each V2 section', () => {
  it('integrations section runs via runSection() with non-interactive options', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = createDefaultWizardRunner();
    const io = new StubWizardIO();

    const result = await runner.runSection('integrations', io, {
      nonInteractive: true,
      signaldockEnabled: true,
      signaldockEndpoint: 'https://sd.example.com',
      studioEnabled: false,
      projectRoot,
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('signaldock.enabled=true');

    const globalCfg = readJsonFile(join(root, 'cleo-home', 'config.json')) as {
      signaldock?: { enabled?: boolean; endpoint?: string };
    };
    expect(globalCfg.signaldock?.enabled).toBe(true);
    expect(globalCfg.signaldock?.endpoint).toBe('https://sd.example.com');
  });

  it('verification section runs via runSection() — same behavior as run()', async () => {
    makeTempRoot();
    const runner = createDefaultWizardRunner();
    const io = new StubWizardIO();

    const result = await runner.runSection('verification', io, { nonInteractive: true });
    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/verification/);
  });

  it('llm section via runSection() adds credential to pool (Studio credential path)', async () => {
    makeTempRoot();
    const runner = createDefaultWizardRunner();
    const io = new StubWizardIO();

    const result = await runner.runSection('llm', io, {
      nonInteractive: true,
      provider: 'gemini',
      apiKey: 'AIza-studio-key',
      label: 'studio-key',
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('added gemini:studio-key');
  });

  it('identity section via runSection() sets agent.name (Studio identity path)', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = createDefaultWizardRunner();
    const io = new StubWizardIO();

    const result = await runner.runSection('identity', io, {
      nonInteractive: true,
      agentName: 'Studio-Agent',
      projectRoot,
    });

    expect(result.changed).toBe(true);
    const globalCfg = readJsonFile(join(root, 'cleo-home', 'config.json')) as {
      agent?: { name?: string };
    };
    expect(globalCfg.agent?.name).toBe('Studio-Agent');
  });
});
