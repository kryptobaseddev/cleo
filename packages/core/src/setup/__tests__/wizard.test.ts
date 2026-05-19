/**
 * Tests for the core setup wizard engine (E-CONFIG-AUTH-UNIFY E3 / T9420).
 *
 * Covers:
 *   - WizardRunner section registration + duplicate detection.
 *   - run-all order matches declaration order.
 *   - runSection executes exactly one named section.
 *   - Per-section non-interactive flag wiring (each built-in).
 *   - One happy-path interactive run per built-in section via {@link StubWizardIO}.
 *
 * Filesystem is isolated via temp dirs and env-var pinning so the real
 * developer state never leaks in.
 *
 * @task T9420
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetCredentialPoolSingletonForTests } from '../../llm/credential-pool.js';
import {
  createBrainSection,
  createBuiltinSections,
  createHarnessSection,
  createIdentitySection,
  createLlmSection,
  createProjectConventionsSection,
  createSentientSection,
  StubWizardIO,
  WizardFatalError,
  WizardRunner,
  type WizardSectionRunner,
} from '../index.js';

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

/**
 * Pin every env var the wizard / credential pool / config loader might
 * consult to a fresh tmp dir so writes are sandboxed.
 */
function makeTempRoot(): { root: string; projectRoot: string } {
  const root = join(
    tmpdir(),
    `cleo-setup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
// Engine semantics
// ---------------------------------------------------------------------------

describe('WizardRunner — registration + dispatch', () => {
  it('rejects duplicate section ids in the constructor', () => {
    const dupe: WizardSectionRunner = {
      section: 'llm',
      title: 'dupe',
      optional: false,
      async run() {
        return { changed: false, summary: 'noop' };
      },
    };
    expect(() => new WizardRunner([createLlmSection(), dupe])).toThrow(/duplicate section id/);
  });

  it('list() returns sections in declaration order', () => {
    const sections = createBuiltinSections();
    const runner = new WizardRunner(sections);
    expect(runner.list().map((s) => s.section)).toEqual([
      'llm',
      'identity',
      'sentient',
      'project-conventions',
      'harness',
      'brain',
      'integrations',
      'verification',
    ]);
  });

  it('run() walks every section in declaration order', async () => {
    makeTempRoot();
    const calls: string[] = [];
    const make = (id: 'llm' | 'identity'): WizardSectionRunner => ({
      section: id,
      title: `s-${id}`,
      optional: false,
      async run() {
        calls.push(id);
        return { changed: true, summary: `ran ${id}` };
      },
    });
    const runner = new WizardRunner([make('llm'), make('identity')]);
    const io = new StubWizardIO();
    const result = await runner.run(io);
    expect(calls).toEqual(['llm', 'identity']);
    expect(result.sectionsRun).toEqual(['llm', 'identity']);
    expect(result.summary).toEqual(['llm: ran llm', 'identity: ran identity']);
    // Progress headers use [N/total] format (T9613)
    expect(io.infos[0]).toBe('\n[1/2] s-llm (llm)');
    expect(io.infos[1]).toBe('\n[2/2] s-identity (identity)');
  });

  it('runSection(name) executes exactly one named section', async () => {
    const calls: string[] = [];
    const make = (id: 'llm' | 'identity'): WizardSectionRunner => ({
      section: id,
      title: `s-${id}`,
      optional: false,
      async run() {
        calls.push(id);
        return { changed: true, summary: `ran ${id}` };
      },
    });
    const runner = new WizardRunner([make('llm'), make('identity')]);
    const io = new StubWizardIO();
    const result = await runner.runSection('identity', io);
    expect(calls).toEqual(['identity']);
    expect(result.summary).toBe('ran identity');
  });

  it('runSection throws when name is unknown', async () => {
    const runner = new WizardRunner([createLlmSection()]);
    const io = new StubWizardIO();
    await expect(runner.runSection('sentient', io)).rejects.toThrow(/no section registered/);
  });

  it('run() captures section exceptions as failure summaries', async () => {
    const exploding: WizardSectionRunner = {
      section: 'llm',
      title: 'explode',
      optional: false,
      async run() {
        throw new Error('boom');
      },
    };
    const runner = new WizardRunner([exploding]);
    const io = new StubWizardIO();
    const result = await runner.run(io);
    expect(result.summary[0]).toMatch(/^llm: failed: boom/);
    expect(io.errors[0]).toMatch(/section 'llm' failed: boom/);
  });

  it('run() re-throws WizardFatalError (T9599 — stdin EOF must not be swallowed)', async () => {
    // WizardFatalError subclasses represent conditions (stdin closed, broken pipe)
    // where continuing the wizard is impossible. invokeSection re-throws them.
    class TestFatalError extends WizardFatalError {
      constructor() {
        super('fatal signal');
        this.name = 'TestFatalError';
      }
    }
    const fataler: WizardSectionRunner = {
      section: 'llm',
      title: 'fatal',
      optional: false,
      async run() {
        throw new TestFatalError();
      },
    };
    const runner = new WizardRunner([fataler]);
    const io = new StubWizardIO();
    await expect(runner.run(io)).rejects.toThrow(TestFatalError);
    // io.errors must NOT have been called for this throw (it bypasses the
    // normal "section failed" path).
    expect(io.errors).toHaveLength(0);
  });

  it('runSection() re-throws WizardFatalError', async () => {
    class TestFatalError extends WizardFatalError {
      constructor() {
        super('fatal');
        this.name = 'TestFatalError';
      }
    }
    const fataler: WizardSectionRunner = {
      section: 'identity',
      title: 'fatal',
      optional: false,
      async run() {
        throw new TestFatalError();
      },
    };
    const runner = new WizardRunner([fataler]);
    const io = new StubWizardIO();
    await expect(runner.runSection('identity', io)).rejects.toThrow(TestFatalError);
  });

  // -------------------------------------------------------------------------
  // Skip logic (T9613 / E-CLEO-SETUP-V2 §3.4)
  // -------------------------------------------------------------------------

  it('run() skips section when isConfigured() returns true', async () => {
    makeTempRoot();
    const ran: string[] = [];
    const configured: WizardSectionRunner = {
      section: 'llm',
      title: 'LLM',
      optional: false,
      async isConfigured() {
        return true;
      },
      async run() {
        ran.push('llm');
        return { changed: false, summary: 'should not run' };
      },
    };
    const runner = new WizardRunner([configured]);
    const io = new StubWizardIO();
    const result = await runner.run(io);
    expect(ran).toHaveLength(0);
    expect(result.summary[0]).toBe('llm: skipped (already configured)');
    expect(io.infos.some((m) => m.includes('[skip] LLM — already configured'))).toBe(true);
    expect(io.infos.some((m) => m.includes('--reset to reconfigure'))).toBe(true);
  });

  it('run() does NOT skip section when isConfigured() returns true but reset=true', async () => {
    makeTempRoot();
    const ran: string[] = [];
    const configured: WizardSectionRunner = {
      section: 'llm',
      title: 'LLM',
      optional: false,
      async isConfigured() {
        return true;
      },
      async run() {
        ran.push('llm');
        return { changed: true, summary: 'ran llm' };
      },
    };
    const runner = new WizardRunner([configured]);
    const io = new StubWizardIO();
    const result = await runner.run(io, { reset: true });
    expect(ran).toEqual(['llm']);
    expect(result.summary[0]).toBe('llm: ran llm');
  });

  it('run() always runs sections without isConfigured()', async () => {
    makeTempRoot();
    const ran: string[] = [];
    const noCheck: WizardSectionRunner = {
      section: 'llm',
      title: 'LLM',
      optional: false,
      // No isConfigured method
      async run() {
        ran.push('llm');
        return { changed: true, summary: 'ran llm' };
      },
    };
    const runner = new WizardRunner([noCheck]);
    const io = new StubWizardIO();
    await runner.run(io);
    expect(ran).toEqual(['llm']);
  });

  // -------------------------------------------------------------------------
  // First-run completion (T9613 / E-CLEO-SETUP-V2 §3.4)
  // -------------------------------------------------------------------------

  it('run() returns firstRunComplete=true when all sections succeed', async () => {
    makeTempRoot();
    const section: WizardSectionRunner = {
      section: 'llm',
      title: 'LLM',
      optional: false,
      async run() {
        return { changed: true, summary: 'done' };
      },
    };
    const runner = new WizardRunner([section]);
    const io = new StubWizardIO();
    const result = await runner.run(io);
    expect(result.firstRunComplete).toBe(true);
  });

  it('run() returns firstRunComplete=false when any section fails', async () => {
    makeTempRoot();
    const exploding: WizardSectionRunner = {
      section: 'llm',
      title: 'explode',
      optional: false,
      async run() {
        throw new Error('boom');
      },
    };
    const runner = new WizardRunner([exploding]);
    const io = new StubWizardIO();
    const result = await runner.run(io);
    expect(result.firstRunComplete).toBe(false);
  });

  it('run() returns firstRunComplete=false when a skipped section uses failed: in its own flow', async () => {
    makeTempRoot();
    const passing: WizardSectionRunner = {
      section: 'llm',
      title: 'LLM',
      optional: false,
      async run() {
        return { changed: false, summary: 'ok' };
      },
    };
    const failing: WizardSectionRunner = {
      section: 'identity',
      title: 'Identity',
      optional: false,
      async run() {
        throw new Error('identity exploded');
      },
    };
    const runner = new WizardRunner([passing, failing]);
    const io = new StubWizardIO();
    const result = await runner.run(io);
    expect(result.firstRunComplete).toBe(false);
  });

  it('run() writes setup-completed.json on success', async () => {
    const { root } = makeTempRoot();
    const section: WizardSectionRunner = {
      section: 'llm',
      title: 'LLM',
      optional: false,
      async run() {
        return { changed: true, summary: 'done' };
      },
    };
    const runner = new WizardRunner([section]);
    const io = new StubWizardIO();
    await runner.run(io);
    // setup-completed.json is written to getCleoPlatformPaths().data which
    // resolves to CLEO_HOME (set to join(root, 'cleo-home') by makeTempRoot).
    const markerPath = join(root, 'cleo-home', 'setup-completed.json');
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as { completedAt?: string };
    expect(typeof marker.completedAt).toBe('string');
  });

  it('run() emits progress headers in [N/total] format', async () => {
    makeTempRoot();
    const make = (id: 'llm' | 'identity'): WizardSectionRunner => ({
      section: id,
      title: `Section ${id}`,
      optional: false,
      async run() {
        return { changed: false, summary: 'done' };
      },
    });
    const runner = new WizardRunner([make('llm'), make('identity')]);
    const io = new StubWizardIO();
    await runner.run(io);
    expect(io.infos[0]).toBe('\n[1/2] Section llm (llm)');
    expect(io.infos[1]).toBe('\n[2/2] Section identity (identity)');
  });
});

// ---------------------------------------------------------------------------
// Non-interactive wiring per builtin section
// ---------------------------------------------------------------------------

describe('llm section', () => {
  it('isConfigured(): returns false before any credential, true after write (LLM-7)', async () => {
    makeTempRoot();
    const section = createLlmSection();
    const before = await section.isConfigured!({});
    expect(before).toBe(false);
    const io = new StubWizardIO({
      selects: ['openai', 'api_key'],
      prompts: ['my-label', 'sk-openai-XYZ'],
    });
    await section.run(io, {});
    const after = await section.isConfigured!({});
    expect(after).toBe(true);
  });

  it('non-interactive: writes API key to credential pool', async () => {
    makeTempRoot();
    const runner = new WizardRunner([createLlmSection()]);
    const io = new StubWizardIO();
    const result = await runner.runSection('llm', io, {
      nonInteractive: true,
      provider: 'anthropic',
      apiKey: 'sk-ant-test-AAAA',
      label: 'wizard-test',
    });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('added anthropic:wizard-test');

    // Confirm the pool surfaces the new entry.
    const { getCredentialPool } = await import('../../llm/credential-pool.js');
    const entries = await getCredentialPool().list();
    const match = entries.find((e) => e.provider === 'anthropic' && e.label === 'wizard-test');
    expect(match).toBeDefined();
    expect(match?.accessToken).toBe('sk-ant-test-AAAA');
    expect(match?.source).toBe('cli-input');
  });

  it('non-interactive without flags: short-circuits silently', async () => {
    makeTempRoot();
    const runner = new WizardRunner([createLlmSection()]);
    const io = new StubWizardIO();
    const result = await runner.runSection('llm', io, { nonInteractive: true });
    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/^skipped/);
  });

  it('interactive: select + select + label + key writes to pool', async () => {
    makeTempRoot();
    const runner = new WizardRunner([createLlmSection()]);
    const io = new StubWizardIO({
      selects: ['openai', 'api_key'],
      prompts: ['my-openai-key', 'sk-openai-XYZ'],
    });
    const result = await runner.runSection('llm', io);
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('added openai:my-openai-key');
  });

  it('interactive: pool-seeding consent prompt fires for anthropic (LLM-5)', async () => {
    const { root } = makeTempRoot();
    const runner = new WizardRunner([createLlmSection()]);
    const io = new StubWizardIO({
      selects: ['anthropic', 'api_key'],
      prompts: ['my-ant-key', 'sk-ant-XXXX'],
      confirms: [true], // consent
    });
    const result = await runner.runSection('llm', io);
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('added anthropic:my-ant-key');
    // Consent must be persisted to auth.poolSeedingConsent in global config.
    const cfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
      auth?: { poolSeedingConsent?: boolean };
    };
    expect(cfg.auth?.poolSeedingConsent).toBe(true);
  });

  it('interactive: bracketed paste sequences stripped from API key (LLM-4)', async () => {
    makeTempRoot();
    const runner = new WizardRunner([createLlmSection()]);
    // Simulate pasted key with bracketed paste escape sequences.
    const io = new StubWizardIO({
      selects: ['openai', 'api_key'],
      prompts: ['paste-test', '\x1b[200~sk-openai-PASTED\x1b[201~'],
    });
    await runner.runSection('llm', io);
    const { getCredentialPool } = await import('../../llm/credential-pool.js');
    const entries = await getCredentialPool().list();
    const match = entries.find((e) => e.label === 'paste-test');
    expect(match?.accessToken).toBe('sk-openai-PASTED');
  });

  it('non-interactive: poolSeedingConsent written when provided (LLM-6)', async () => {
    const { root } = makeTempRoot();
    const runner = new WizardRunner([createLlmSection()]);
    const io = new StubWizardIO();
    await runner.runSection('llm', io, {
      nonInteractive: true,
      provider: 'anthropic',
      apiKey: 'sk-ant-test-consent',
      label: 'consent-test',
      poolSeedingConsent: false,
    });
    const cfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
      auth?: { poolSeedingConsent?: boolean };
    };
    expect(cfg.auth?.poolSeedingConsent).toBe(false);
  });
});

describe('identity section', () => {
  it('isConfigured(): returns false before agent name is set, true after write (IDENT-6)', async () => {
    const { projectRoot } = makeTempRoot();
    const section = createIdentitySection();
    const before = await section.isConfigured!({ projectRoot });
    expect(before).toBe(false);
    const io = new StubWizardIO({
      prompts: ['Atlas'],
      confirms: [false, false], // no SOUL.md, no SignalDock
    });
    await section.run(io, { projectRoot });
    const after = await section.isConfigured!({ projectRoot });
    expect(after).toBe(true);
  });

  it('non-interactive: writes agent.name to global config and skips SOUL.md when blank', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIdentitySection()]);
    const io = new StubWizardIO();
    const result = await runner.runSection('identity', io, {
      nonInteractive: true,
      agentName: 'Atlas',
      projectRoot,
    });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set agent.name');

    const globalCfgPath = join(root, 'cleo-home', 'config.json');
    expect(existsSync(globalCfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(globalCfgPath, 'utf-8')) as {
      agent?: { name?: string };
    };
    expect(cfg.agent?.name).toBe('Atlas');
  });

  it('non-interactive: writes SOUL.md when content supplied', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIdentitySection()]);
    const io = new StubWizardIO();
    await runner.runSection('identity', io, {
      nonInteractive: true,
      agentName: 'Atlas',
      soulMdContent: 'I am Atlas.',
      projectRoot,
    });
    const soulPath = join(projectRoot, '.cleo', 'SOUL.md');
    expect(existsSync(soulPath)).toBe(true);
    expect(readFileSync(soulPath, 'utf-8')).toBe('I am Atlas.\n');
  });

  it('non-interactive without --agent-name: skipped', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIdentitySection()]);
    const io = new StubWizardIO();
    const result = await runner.runSection('identity', io, {
      nonInteractive: true,
      projectRoot,
    });
    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/^skipped/);
  });

  it('interactive: SignalDock registration confirm emits note (IDENT-5)', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIdentitySection()]);
    const io = new StubWizardIO({
      prompts: ['Hermes'],
      confirms: [false, true], // no SOUL.md, yes SignalDock
    });
    await runner.runSection('identity', io, { projectRoot });
    expect(io.infos.some((m) => m.includes('cleo signaldock connect'))).toBe(true);
  });

  it('non-interactive: signaldockAutoConnect=true emits note (IDENT-5)', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createIdentitySection()]);
    const io = new StubWizardIO();
    await runner.runSection('identity', io, {
      nonInteractive: true,
      agentName: 'Zeus',
      signaldockAutoConnect: true,
      projectRoot,
    });
    expect(io.infos.some((m) => m.includes('cleo signaldock connect'))).toBe(true);
  });
});

describe('sentient section', () => {
  it('isConfigured(): returns false before state file exists, true after write (SENT-5)', async () => {
    const { projectRoot } = makeTempRoot();
    const section = createSentientSection();
    const before = await section.isConfigured!({ projectRoot });
    expect(before).toBe(false);
    const io = new StubWizardIO({ confirms: [false, false] });
    await section.run(io, { projectRoot });
    const after = await section.isConfigured!({ projectRoot });
    expect(after).toBe(true);
  });

  it('non-interactive: writes killSwitch + tier2 to sentient-state.json', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createSentientSection()]);
    const io = new StubWizardIO();
    const result = await runner.runSection('sentient', io, {
      nonInteractive: true,
      sentientEnabled: true,
      tier2Enabled: true,
      projectRoot,
    });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('daemon enabled');
    expect(result.summary).toContain('tier2 enabled');

    const statePath = join(projectRoot, '.cleo', 'sentient-state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      killSwitch?: boolean;
      tier2Enabled?: boolean;
    };
    expect(state.killSwitch).toBe(false);
    expect(state.tier2Enabled).toBe(true);
  });

  it('non-interactive without flags: emits E_SETUP_MISSING_FLAG error (T9597)', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createSentientSection()]);
    const io = new StubWizardIO();
    // invokeSection catches the thrown error and surfaces it as failed: summary.
    const result = await runner.runSection('sentient', io, {
      nonInteractive: true,
      projectRoot,
    });
    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/E_SETUP_MISSING_FLAG/);
    expect(result.summary).toMatch(/--sentient/);
  });

  it('interactive: confirm prompts drive both toggles', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createSentientSection()]);
    const io = new StubWizardIO({ confirms: [false, true] });
    const result = await runner.runSection('sentient', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('daemon disabled');
    expect(result.summary).toContain('tier2 enabled');
  });
});

describe('project-conventions section', () => {
  it('non-interactive: applies strictness preset to project config', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createProjectConventionsSection()]);
    const io = new StubWizardIO();
    const result = await runner.runSection('project-conventions', io, {
      nonInteractive: true,
      strictness: 'standard',
      projectRoot,
    });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain("applied 'standard' preset");

    const projectCfgPath = join(projectRoot, '.cleo', 'config.json');
    expect(existsSync(projectCfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(projectCfgPath, 'utf-8')) as {
      enforcement?: { acceptance?: { mode?: string } };
      lifecycle?: { mode?: string };
    };
    expect(cfg.enforcement?.acceptance?.mode).toBe('warn');
    expect(cfg.lifecycle?.mode).toBe('advisory');
  });

  it('non-interactive without --strictness: skipped silently', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createProjectConventionsSection()]);
    const io = new StubWizardIO();
    const result = await runner.runSection('project-conventions', io, {
      nonInteractive: true,
      projectRoot,
    });
    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/^skipped/);
  });

  it('isConfigured(): returns false before preset applied, true after write (PROJ-5)', async () => {
    const { projectRoot } = makeTempRoot();
    const section = createProjectConventionsSection();
    const before = await section.isConfigured!({ projectRoot });
    expect(before).toBe(false);
    // Interactive: select preset + keep both overrides as preset-default.
    const io = new StubWizardIO({
      selects: ['standard', 'keep-preset-default', 'keep-preset-default'],
    });
    await section.run(io, { projectRoot });
    const after = await section.isConfigured!({ projectRoot });
    expect(after).toBe(true);
  });

  it('non-interactive: acEnforcementMode and sessionAutoStart overrides applied (PROJ-4)', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createProjectConventionsSection()]);
    const io = new StubWizardIO();
    const result = await runner.runSection('project-conventions', io, {
      nonInteractive: true,
      strictness: 'standard',
      acEnforcementMode: 'block',
      sessionAutoStart: true,
      projectRoot,
    });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set enforcement.acceptance.mode=block');
    expect(result.summary).toContain('set session.autoStart=true');
  });

  it('interactive: AC and session overrides applied when user provides them (PROJ-3)', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createProjectConventionsSection()]);
    const io = new StubWizardIO({
      selects: ['minimal', 'warn', 'no'],
    });
    const result = await runner.runSection('project-conventions', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain("applied 'minimal' preset");
    expect(result.summary).toContain('set enforcement.acceptance.mode=warn');
    expect(result.summary).toContain('set session.autoStart=false');
  });
});

// ---------------------------------------------------------------------------
// T9425 — harness + brain sections
// ---------------------------------------------------------------------------

describe('harness section', () => {
  it('isConfigured(): returns false before harness is set, true after write (HARN-6)', async () => {
    const { projectRoot } = makeTempRoot();
    delete process.env['CLEO_HARNESS'];
    const section = createHarnessSection();
    const before = await section.isConfigured!({ projectRoot });
    expect(before).toBe(false);
    // claude-code selection doesn't prompt for URL
    const io = new StubWizardIO({ selects: ['claude-code'] });
    await section.run(io, { projectRoot });
    const after = await section.isConfigured!({ projectRoot });
    expect(after).toBe(true);
  });

  it('non-interactive: writes harness.active to global config', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createHarnessSection()]);
    const io = new StubWizardIO();
    const result = await runner.runSection('harness', io, {
      nonInteractive: true,
      harness: 'claude-code',
      projectRoot,
    });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set harness.active=claude-code');

    const globalCfgPath = join(root, 'cleo-home', 'config.json');
    expect(existsSync(globalCfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(globalCfgPath, 'utf-8')) as {
      harness?: { active?: string };
    };
    expect(cfg.harness?.active).toBe('claude-code');
  });

  it('non-interactive without --harness: emits E_SETUP_MISSING_FLAG error (T9597)', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createHarnessSection()]);
    const io = new StubWizardIO();
    // invokeSection catches throws and surfaces them as failed: summary lines.
    const result = await runner.runSection('harness', io, {
      nonInteractive: true,
      projectRoot,
    });
    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/E_SETUP_MISSING_FLAG/);
    expect(result.summary).toMatch(/--harness/);
  });

  it('interactive: select prompt drives the harness pick + display reads CLEO_HARNESS', async () => {
    const { root, projectRoot } = makeTempRoot();
    process.env['CLEO_HARNESS'] = 'pi';
    try {
      const runner = new WizardRunner([createHarnessSection()]);
      const io = new StubWizardIO({ selects: ['claude-code'] });
      const result = await runner.runSection('harness', io, { projectRoot });
      expect(result.changed).toBe(true);
      expect(result.summary).toContain('set harness.active=claude-code');
      expect(result.summary).toContain('was pi');
      // Persisted to global config.
      const cfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
        harness?: { active?: string };
      };
      expect(cfg.harness?.active).toBe('claude-code');
    } finally {
      delete process.env['CLEO_HARNESS'];
    }
  });

  it('interactive: missing CLEO_HARNESS env reports "unknown" as current', async () => {
    const { projectRoot } = makeTempRoot();
    delete process.env['CLEO_HARNESS'];
    const runner = new WizardRunner([createHarnessSection()]);
    // Selecting 'pi' now also prompts for Pi URL (HARN-3); provide empty to accept default.
    const io = new StubWizardIO({ selects: ['pi'], prompts: [''] });
    await runner.runSection('harness', io, { projectRoot });
    expect(io.infos.some((m) => m.includes('Current harness: unknown'))).toBe(true);
  });

  it('interactive: Pi URL prompt is persisted to global config when pi is selected (HARN-3)', async () => {
    const { root, projectRoot } = makeTempRoot();
    delete process.env['CLEO_HARNESS'];
    const runner = new WizardRunner([createHarnessSection()]);
    const io = new StubWizardIO({ selects: ['pi'], prompts: ['http://localhost:9999'] });
    const result = await runner.runSection('harness', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set harness.piUrl=http://localhost:9999');
    const cfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
      harness?: { piUrl?: string };
    };
    expect(cfg.harness?.piUrl).toBe('http://localhost:9999');
  });

  it('interactive: invalid Pi URL falls back to default (HARN-3)', async () => {
    const { root, projectRoot } = makeTempRoot();
    delete process.env['CLEO_HARNESS'];
    const runner = new WizardRunner([createHarnessSection()]);
    const io = new StubWizardIO({ selects: ['pi'], prompts: ['not-a-url'] });
    const result = await runner.runSection('harness', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('used default');
    expect(io.warns.some((m) => m.includes('Invalid Pi URL'))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
      harness?: { piUrl?: string };
    };
    expect(cfg.harness?.piUrl).toBe('http://localhost:7800');
  });

  it('interactive: claude-code selection emits harness doctor note (HARN-4)', async () => {
    const { projectRoot } = makeTempRoot();
    delete process.env['CLEO_HARNESS'];
    const runner = new WizardRunner([createHarnessSection()]);
    const io = new StubWizardIO({ selects: ['claude-code'] });
    await runner.runSection('harness', io, { projectRoot });
    expect(io.infos.some((m) => m.includes('cleo harness doctor'))).toBe(true);
  });
});

describe('brain section', () => {
  it('non-interactive: persists "file" mode to global config', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createBrainSection()]);
    const io = new StubWizardIO();
    const result = await runner.runSection('brain', io, {
      nonInteractive: true,
      brainBridgeMode: 'file',
      projectRoot,
    });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set brain.memoryBridge.mode=file');

    const globalCfgPath = join(root, 'cleo-home', 'config.json');
    expect(existsSync(globalCfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(globalCfgPath, 'utf-8')) as {
      brain?: { memoryBridge?: { mode?: string } };
    };
    expect(cfg.brain?.memoryBridge?.mode).toBe('file');
  });

  it('non-interactive: "digest" label round-trips to wire value "cli"', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createBrainSection()]);
    const io = new StubWizardIO();
    const result = await runner.runSection('brain', io, {
      nonInteractive: true,
      brainBridgeMode: 'digest',
      projectRoot,
    });
    expect(result.changed).toBe(true);

    const cfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
      brain?: { memoryBridge?: { mode?: string } };
    };
    expect(cfg.brain?.memoryBridge?.mode).toBe('cli');
  });

  it('non-interactive: "disabled" mode persists verbatim', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createBrainSection()]);
    const io = new StubWizardIO();
    await runner.runSection('brain', io, {
      nonInteractive: true,
      brainBridgeMode: 'disabled',
      projectRoot,
    });
    const cfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
      brain?: { memoryBridge?: { mode?: string } };
    };
    expect(cfg.brain?.memoryBridge?.mode).toBe('disabled');
  });

  it('non-interactive without --brain-bridge-mode: emits E_SETUP_MISSING_FLAG error (T9597)', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createBrainSection()]);
    const io = new StubWizardIO();
    // invokeSection catches the thrown error and surfaces it as failed: summary.
    const result = await runner.runSection('brain', io, {
      nonInteractive: true,
      projectRoot,
    });
    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/E_SETUP_MISSING_FLAG/);
    expect(result.summary).toMatch(/--brain-bridge-mode/);
  });

  it('interactive: select prompt drives the mode pick + reports current mode', async () => {
    const { projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createBrainSection()]);
    // Brain section now also prompts for retention days (prompt) and embedding toggle (confirm).
    const io = new StubWizardIO({
      selects: ['file'],
      prompts: ['0'],
      confirms: [true],
    });
    const result = await runner.runSection('brain', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set brain.memoryBridge.mode=file');
    // Default mode is 'cli' which surfaces as 'digest' to the operator.
    expect(io.infos.some((m) => m.includes('Current BRAIN bridge mode: digest'))).toBe(true);
  });

  it('interactive: retention days are persisted to global config (BRAIN-3)', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createBrainSection()]);
    const io = new StubWizardIO({
      selects: ['digest'],
      prompts: ['30'],
      confirms: [false],
    });
    const result = await runner.runSection('brain', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set brain.retention.days=30');

    const cfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
      brain?: { retention?: { days?: number } };
    };
    expect(cfg.brain?.retention?.days).toBe(30);
  });

  it('interactive: embedding toggle is persisted to global config (BRAIN-4)', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createBrainSection()]);
    const io = new StubWizardIO({
      selects: ['digest'],
      prompts: ['0'],
      confirms: [true],
    });
    const result = await runner.runSection('brain', io, { projectRoot });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set brain.embedding.enabled=true');

    const cfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
      brain?: { embedding?: { enabled?: boolean } };
    };
    expect(cfg.brain?.embedding?.enabled).toBe(true);
  });

  it('non-interactive: brainRetentionDays and brainEmbeddingEnabled from options (BRAIN-5)', async () => {
    const { root, projectRoot } = makeTempRoot();
    const runner = new WizardRunner([createBrainSection()]);
    const io = new StubWizardIO();
    const result = await runner.runSection('brain', io, {
      nonInteractive: true,
      brainBridgeMode: 'digest',
      brainRetentionDays: 7,
      brainEmbeddingEnabled: false,
      projectRoot,
    });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('set brain.retention.days=7');
    expect(result.summary).toContain('set brain.embedding.enabled=false');

    const cfg = JSON.parse(readFileSync(join(root, 'cleo-home', 'config.json'), 'utf-8')) as {
      brain?: { retention?: { days?: number }; embedding?: { enabled?: boolean } };
    };
    expect(cfg.brain?.retention?.days).toBe(7);
    expect(cfg.brain?.embedding?.enabled).toBe(false);
  });

  it('isConfigured(): returns false before any write, true after write (BRAIN-6)', async () => {
    const { projectRoot } = makeTempRoot();
    const section = createBrainSection();
    // Before write: returns false (no global config exists yet).
    const before = await section.isConfigured!({ projectRoot });
    expect(before).toBe(false);
    // After write: returns true.
    const io = new StubWizardIO({
      selects: ['digest'],
      prompts: ['0'],
      confirms: [false],
    });
    await section.run(io, { projectRoot });
    const after = await section.isConfigured!({ projectRoot });
    expect(after).toBe(true);
  });
});
